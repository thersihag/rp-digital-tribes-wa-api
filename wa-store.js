// wa-store.js — chat store + REST/SSE APIs + AI agent for RP Digital Trend gateway
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const { downloadMediaMessage } = require('@whiskeysockets/baileys');

let ctx = null; // { sessions, getOrInitSession, upload, sessionsDir, addLog }

const DEFAULT_AGENT = {
    enabled: false,
    mode: 'draft',            // 'draft' = human approves, 'auto' = sends by itself
    provider: 'anthropic',    // 'anthropic' | 'openai' (any OpenAI-compatible API)
    apiKey: '',
    model: 'claude-sonnet-5-5',
    baseUrl: '',
    systemPrompt: 'You are a helpful, polite support assistant for RP Digital Trend. Answer customer WhatsApp messages briefly and clearly.',
    contextLimit: 20,
    delaySec: 4,
    ignoreGroups: true,
    disabledChats: []
};

const SKIP_TYPES = new Set(['protocolMessage', 'reactionMessage', 'senderKeyDistributionMessage', 'pollUpdateMessage', 'editedMessage', 'messageContextInfo']);
const toNum = v => v == null ? 0 : typeof v === 'number' ? v : (v.toNumber ? v.toNumber() : Number(v));
const isGroup = j => j.endsWith('@g.us');
const numOf = j => j.split('@')[0].split(':')[0];
const cleanName = n => (n || 'default').toString().trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'default';

function normJid(x) {
    x = String(x || '').trim();
    if (x.includes('@')) return x;
    let n = x.replace(/[^0-9]/g, '');
    if (n.length === 10) n = '91' + n;
    return `${n}@s.whatsapp.net`;
}

const isLid = j => !!j && j.endsWith('@lid');
function fmtPhone(j) {
    if (!j || isLid(j) || isGroup(j)) return null;
    const d = numOf(j);
    return d.length === 12 && d.startsWith('91') ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : '+' + d;
}

/* ---------- LID -> real phone number ---------- */
function learnLid(wa, lid, pn) {
    if (!lid || !pn || isLid(pn) || wa.lidMap.get(lid) === pn) return;
    wa.lidMap.set(lid, pn);
    const old = wa.msgs.get(lid);
    if (old) {
        const cur = wa.msgs.get(pn) || [];
        const ids = new Set(cur.map(m => m.id));
        old.forEach(m => { if (!ids.has(m.id)) { m.jid = pn; cur.push(m); } });
        cur.sort((a, b) => a.ts - b.ts);
        wa.msgs.set(pn, cur);
        wa.msgs.delete(lid);
    }
    const oc = wa.chats.get(lid);
    if (oc) {
        const nc = wa.chats.get(pn) || { jid: pn, name: null, unread: 0, ts: 0 };
        nc.name = nc.name || oc.name;
        nc.ts = Math.max(nc.ts || 0, oc.ts || 0);
        nc.unread = (nc.unread || 0) + (oc.unread || 0);
        wa.chats.set(pn, nc);
        wa.chats.delete(lid);
    }
    const nm = wa.names.get(lid);
    if (nm && !wa.names.get(pn)) wa.names.set(pn, nm);
    const lc = wa.counts[lid];
    if (lc) {
        const n = wa.counts[pn] || (wa.counts[pn] = { count: 0, first: lc.first, last: lc.last });
        n.count += lc.count; n.first = Math.min(n.first, lc.first); n.last = Math.max(n.last, lc.last);
        delete wa.counts[lid];
    }
}

// Incoming log: one entry per received message + running count per sender
function logInbound(wa, raw, p, jid) {
    let from = jid;
    if (isGroup(jid)) {
        const k = raw.key;
        from = (k.participantAlt && !isLid(k.participantAlt)) ? k.participantAlt : (k.participant || jid);
        if (isLid(from) && wa.lidMap.get(from)) from = wa.lidMap.get(from);
    }
    if (raw.pushName && !wa.names.get(from)) wa.names.set(from, raw.pushName);
    const c = wa.counts[from] || (wa.counts[from] = { count: 0, first: p.ts, last: p.ts });
    c.count++; c.first = Math.min(c.first, p.ts); c.last = Math.max(c.last, p.ts);
    wa.inbox.push({ id: p.id, from, jid, group: isGroup(jid), kind: p.kind, text: p.text, ts: p.ts });
    if (wa.inbox.length > 3000) wa.inbox.splice(0, wa.inbox.length - 3000);
}
const istDay = ts => new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
function inboxEntry(wa, e) {
    const from = wa.lidMap.get(e.from) || e.from;
    return {
        id: e.id,
        number: isLid(from) ? '' : numOf(from),
        phone: fmtPhone(from),
        name: wa.names.get(from) || wa.names.get(e.from) || '',
        group: e.group,
        chat_jid: e.jid,
        kind: e.kind,
        text: e.text,
        ts: e.ts,
        time: new Date(e.ts * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true })
    };
}
function resolveJid(wa, raw) {
    const k = raw.key, jid = k.remoteJid;
    if (!isLid(jid)) return jid;
    if (k.remoteJidAlt && !isLid(k.remoteJidAlt)) { learnLid(wa, jid, k.remoteJidAlt); return k.remoteJidAlt; }
    return wa.lidMap.get(jid) || jid;
}
async function tryResolveLid(sock, wa, raw) {
    const k = raw.key;
    if (!k || !isLid(k.remoteJid) || k.remoteJidAlt || wa.lidMap.has(k.remoteJid)) return;
    const repo = sock.signalRepository?.lidMapping;
    if (!repo?.getPNForLID) return;
    for (const q of [k.remoteJid, numOf(k.remoteJid)]) {
        try { const pn = await repo.getPNForLID(q); if (pn) { k.remoteJidAlt = pn.includes('@') ? pn : pn + '@s.whatsapp.net'; return; } } catch (e) {}
    }
}

/* ---------- per-session state ---------- */
function init(name, s) {
    if (s.wa) return s.wa;
    const dir = path.join(ctx.sessionsDir, name);
    const wa = {
        dir, chats: new Map(), msgs: new Map(), raw: new Map(), names: new Map(),
        avatars: new Map(), lidMap: new Map(), counts: {}, inbox: [], clients: new Set(), timers: new Map(), groupFetching: new Set(),
        drafts: [], agent: { ...DEFAULT_AGENT }, saveTimer: null
    };
    try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
        (d.chats || []).forEach(c => wa.chats.set(c.jid, c));
        Object.entries(d.msgs || {}).forEach(([j, l]) => wa.msgs.set(j, l));
        Object.entries(d.names || {}).forEach(([j, n]) => wa.names.set(j, n));
        Object.entries(d.lids || {}).forEach(([l, n]) => wa.lidMap.set(l, n));
        wa.counts = d.counts || {};
        wa.inbox = d.inbox || [];
    } catch (e) {}
    try { Object.assign(wa.agent, JSON.parse(fs.readFileSync(path.join(dir, 'agent.json'), 'utf8'))); } catch (e) {}
    s.wa = wa;
    return wa;
}

function scheduleSave(wa) {
    if (wa.saveTimer) return;
    wa.saveTimer = setTimeout(() => {
        wa.saveTimer = null;
        try {
            if (!fs.existsSync(wa.dir)) return;
            fs.writeFileSync(path.join(wa.dir, 'store.json'), JSON.stringify({
                chats: [...wa.chats.values()],
                msgs: Object.fromEntries(wa.msgs),
                names: Object.fromEntries(wa.names),
                lids: Object.fromEntries(wa.lidMap),
                counts: wa.counts,
                inbox: wa.inbox
            }));
        } catch (e) {}
    }, 3000);
}

function saveAgent(wa) {
    try { if (fs.existsSync(wa.dir)) fs.writeFileSync(path.join(wa.dir, 'agent.json'), JSON.stringify(wa.agent, null, 2)); } catch (e) {}
}

function emit(wa, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const r of wa.clients) { try { r.write(payload); } catch (e) {} }
}

/* ---------- message parsing / storing ---------- */
function parse(raw) {
    let m = raw.message;
    if (!m) return null;
    m = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m;
    const type = Object.keys(m).find(k => k !== 'messageContextInfo');
    if (!type || SKIP_TYPES.has(type)) return null;
    const c = m[type] || {};
    let kind = 'other', text = '';
    switch (type) {
        case 'conversation': kind = 'text'; text = c; break;
        case 'extendedTextMessage': kind = 'text'; text = c.text || ''; break;
        case 'imageMessage': kind = 'image'; text = c.caption || ''; break;
        case 'videoMessage': kind = 'video'; text = c.caption || ''; break;
        case 'audioMessage': kind = 'audio'; break;
        case 'stickerMessage': kind = 'sticker'; break;
        case 'documentMessage': kind = 'document'; text = c.caption || ''; break;
        case 'locationMessage': kind = 'location'; text = c.name || c.address || ''; break;
        case 'contactMessage': kind = 'contact'; text = c.displayName || ''; break;
        default: kind = 'other'; text = 'Unsupported message';
    }
    return { id: raw.key.id, kind, text: String(text), mime: c.mimetype || null, fileName: c.fileName || null };
}

function addMessage(name, wa, raw, opts = {}) {
    const { live = false, quiet = false } = opts;
    if (!raw || !raw.key) return null;
    const jid = resolveJid(wa, raw);
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return null;
    const p = parse(raw);
    if (!p) return null;
    const list = wa.msgs.get(jid) || [];
    wa.msgs.set(jid, list);
    if (list.some(x => x.id === p.id)) return null;

    p.jid = jid;
    p.fromMe = !!raw.key.fromMe;
    p.ts = toNum(raw.messageTimestamp) || Math.floor(Date.now() / 1000);
    p.status = raw.status != null ? raw.status : (p.fromMe ? 1 : null);
    p.sender = isGroup(jid) && !p.fromMe ? (raw.pushName || fmtPhone(raw.key.participantAlt || raw.key.participant || '') || 'Member') : null;

    list.push(p);
    list.sort((a, b) => a.ts - b.ts);
    if (list.length > 400) list.splice(0, list.length - 400);

    wa.raw.set(p.id, raw);
    if (wa.raw.size > 600) wa.raw.delete(wa.raw.keys().next().value);

    const c = wa.chats.get(jid) || { jid, name: null, unread: 0, ts: 0 };
    c.ts = Math.max(c.ts || 0, p.ts);
    if (!p.fromMe) {
        if (raw.pushName && !isGroup(jid) && !wa.names.get(jid)) wa.names.set(jid, raw.pushName);
        if (live) c.unread = (c.unread || 0) + 1;
        logInbound(wa, raw, p, jid);
    } else if (wa.drafts.some(d => d.jid === jid)) {
        wa.drafts = wa.drafts.filter(d => d.jid !== jid);
        emit(wa, 'draftRemoved', { jid });
    }
    wa.chats.set(jid, c);

    if (!quiet) emit(wa, 'message', { msg: p, chat: view(name, wa, jid) });
    scheduleSave(wa);
    return p;
}

function view(name, wa, jid) {
    const c = wa.chats.get(jid) || { jid, unread: 0, ts: 0 };
    const l = wa.msgs.get(jid);
    const last = l && l[l.length - 1];
    const g = isGroup(jid);
    const s = ctx.sessions.get(name);

    if (g && !c.name && s?.sock && !wa.groupFetching.has(jid)) {
        wa.groupFetching.add(jid);
        s.sock.groupMetadata(jid).then(meta => {
            c.name = meta.subject;
            wa.chats.set(jid, c);
            emit(wa, 'chat', view(name, wa, jid));
            scheduleSave(wa);
        }).catch(() => {});
    }

    return {
        jid,
        name: wa.names.get(jid) || c.name || (g ? 'Group' : fmtPhone(jid) || 'WhatsApp user'),
        number: isLid(jid) || g ? '' : numOf(jid),
        phone: fmtPhone(jid),
        isGroup: g,
        unread: c.unread || 0,
        ts: c.ts || 0,
        last: last ? { kind: last.kind, text: last.text, fromMe: last.fromMe, status: last.status } : null,
        aiOff: wa.agent.disabledChats.includes(jid)
    };
}

/* ---------- Baileys listeners (called from index.js after makeWASocket) ---------- */
function attach(name, sock, s) {
    const wa = init(name, s);

    const upChat = c => {
        if (isLid(c.id) && c.pnJid) learnLid(wa, c.id, c.pnJid);
        const j = wa.lidMap.get(c.id) || c.id;
        if (!j || j === 'status@broadcast' || j.endsWith('@newsletter')) return;
        const o = wa.chats.get(j) || { jid: j, name: null, unread: 0, ts: 0 };
        if (c.name) o.name = c.name;
        if (c.conversationTimestamp) o.ts = Math.max(o.ts || 0, toNum(c.conversationTimestamp));
        if (c.unreadCount != null) o.unread = Math.max(0, c.unreadCount);
        wa.chats.set(j, o);
    };
    const setName = c => {
        if (c.lid && c.id && !isLid(c.id)) learnLid(wa, c.lid, c.id);
        if (isLid(c.id) && c.phoneNumber) learnLid(wa, c.id, c.phoneNumber.includes('@') ? c.phoneNumber : c.phoneNumber + '@s.whatsapp.net');
        const n = c.name || c.notify || c.verifiedName;
        const id = wa.lidMap.get(c.id) || c.id;
        if (n && id) wa.names.set(id, n);
    };

    sock.ev.on('messaging-history.set', ({ chats = [], contacts = [], messages = [] }) => {
        contacts.forEach(setName);
        chats.forEach(upChat);
        messages.forEach(m => addMessage(name, wa, m, { quiet: true }));
        scheduleSave(wa);
    });
    sock.ev.on('chats.upsert', cs => { cs.forEach(upChat); scheduleSave(wa); });
    sock.ev.on('chats.update', cs => { cs.forEach(upChat); scheduleSave(wa); });
    sock.ev.on('contacts.upsert', cs => cs.forEach(setName));
    sock.ev.on('contacts.update', cs => cs.forEach(setName));

    sock.ev.on('lid-mapping.update', m => { try { learnLid(wa, m.lid, m.pn); scheduleSave(wa); } catch (e) {} });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const raw of messages) {
            try {
                await tryResolveLid(sock, wa, raw);
                const p = addMessage(name, wa, raw, { live: type === 'notify' });
                if (p && type === 'notify' && !p.fromMe) scheduleAgent(name, p.jid);
            } catch (e) { console.error('[wa-store] upsert error:', e.message); }
        }
    });

    sock.ev.on('messages.update', ups => {
        for (const { key, update } of ups) {
            if (update?.status == null) continue;
            const jid = wa.lidMap.get(key.remoteJid) || key.remoteJid;
            const m = wa.msgs.get(jid)?.find(x => x.id === key.id);
            if (m && update.status > (m.status || 0)) {
                m.status = update.status;
                emit(wa, 'status', { jid, id: key.id, status: m.status });
            }
        }
    });
}

/* ---------- AI agent ---------- */
async function callAI(cfg, system, messages) {
    if (cfg.provider === 'openai') {
        const base = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
        const r = await fetch(base + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
            body: JSON.stringify({ model: cfg.model, messages: [{ role: 'system', content: system }, ...messages] })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error?.message || r.statusText);
        return (j.choices?.[0]?.message?.content || '').trim();
    }
    const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: 600, system, messages })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error?.message || r.statusText);
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

// Turns the stored chat into the conversation the AI reads
function agentMessages(wa, jid, limit) {
    const out = [];
    for (const m of (wa.msgs.get(jid) || []).slice(-limit)) {
        const role = m.fromMe ? 'assistant' : 'user';
        let t = m.kind === 'text' ? m.text : `[${m.kind}] ${m.text || ''}`.trim();
        if (m.sender) t = `${m.sender}: ${t}`;
        if (!t) continue;
        const last = out[out.length - 1];
        if (last && last.role === role) last.content += '\n' + t; else out.push({ role, content: t });
    }
    while (out.length && out[0].role !== 'user') out.shift();
    return out;
}

async function generate(name, jid) {
    const wa = ctx.sessions.get(name).wa;
    const cfg = wa.agent;
    if (!cfg.apiKey) throw new Error('AI API key is not set');
    const msgs = agentMessages(wa, jid, cfg.contextLimit);
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return null;
    const v = view(name, wa, jid);
    const system = `${cfg.systemPrompt}\n\nYou are replying on WhatsApp to ${v.name} (${v.phone || 'number hidden'}). Reply in the customer's language, keep it short and natural, and do not use markdown headings. If no reply is needed (for example just "ok" or "thanks"), output exactly [NO_REPLY].`;
    const text = await callAI(cfg, system, msgs);
    return !text || /^\[NO_REPLY\]/i.test(text) ? null : text;
}

async function sendText(name, jid, text) {
    const s = ctx.sessions.get(name);
    if (!s?.sock || s.status !== 'CONNECTED') throw new Error('Session is not connected');
    const sent = await s.sock.sendMessage(jid, { text });
    return addMessage(name, s.wa, sent, {});
}

async function runAgent(name, jid, send) {
    const s = ctx.sessions.get(name);
    if (!s) return null;
    const wa = s.wa;
    const text = await generate(name, jid);
    if (!text) return null;

    if (send) {
        try {
            await s.sock.sendPresenceUpdate('composing', jid);
            await new Promise(r => setTimeout(r, Math.min(6000, 800 + text.length * 40)));
        } catch (e) {}
        await sendText(name, jid, text);
        ctx.addLog(name, `🤖 AI replied to +${numOf(jid)}`, 'success');
        return { sent: true, text };
    }
    const last = [...(wa.msgs.get(jid) || [])].reverse().find(m => !m.fromMe);
    const d = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        jid, name: view(name, wa, jid).name, phone: view(name, wa, jid).phone,
        inbound: last ? (last.text || `[${last.kind}]`) : '',
        text, ts: Math.floor(Date.now() / 1000)
    };
    wa.drafts = wa.drafts.filter(x => x.jid !== jid);
    wa.drafts.push(d);
    emit(wa, 'draft', d);
    ctx.addLog(name, `🤖 AI drafted a reply for +${numOf(jid)} (waiting approval)`, 'info');
    return d;
}

function scheduleAgent(name, jid) {
    const s = ctx.sessions.get(name);
    const wa = s?.wa;
    if (!wa) return;
    const cfg = wa.agent;
    if (!cfg.enabled || !cfg.apiKey || cfg.disabledChats.includes(jid)) return;
    if (isGroup(jid) && cfg.ignoreGroups) return;
    clearTimeout(wa.timers.get(jid));
    wa.timers.set(jid, setTimeout(() => {
        runAgent(name, jid, cfg.mode === 'auto').catch(e => ctx.addLog(name, `🤖 AI agent error: ${e.message}`, 'error'));
    }, Math.max(1, cfg.delaySec) * 1000));
}

/* ---------- routes ---------- */
function routes(app, context) {
    ctx = context;

    const sess = async req => {
        const name = cleanName(req.params.s);
        const s = await ctx.getOrInitSession(name);
        return { name, s, wa: init(name, s) };
    };
    const wrap = fn => async (req, res) => {
        try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); }
    };

    app.get('/api/sessions', (req, res) => {
        res.json([...ctx.sessions.entries()].map(([name, s]) => ({ name, status: s.status, number: s.phoneNumber })));
    });

    app.get('/api/wa/:s/chats', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const list = [...wa.chats.values()]
            .filter(c => c.ts > 0 || wa.msgs.get(c.jid)?.length)
            .sort((a, b) => b.ts - a.ts).slice(0, 300)
            .map(c => view(name, wa, c.jid));
        res.json(list);
    }));

    app.get('/api/wa/:s/messages/:jid', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const limit = Math.min(parseInt(req.query.limit) || 100, 400);
        res.json({ chat: view(name, wa, req.params.jid), messages: (wa.msgs.get(req.params.jid) || []).slice(-limit) });
    }));

    app.get('/api/wa/:s/incoming', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const limit = Math.min(parseInt(req.query.limit) || 60, 200);
        const out = [];
        for (const [jid, list] of wa.msgs) {
            for (const m of list.slice(-8)) if (!m.fromMe) out.push({ ...m, name: view(name, wa, jid).name, phone: view(name, wa, jid).phone, aiOff: wa.agent.disabledChats.includes(jid) });
        }
        out.sort((a, b) => b.ts - a.ts);
        res.json(out.slice(0, limit));
    }));

    app.post('/api/wa/:s/read', wrap(async (req, res) => {
        const { s, wa } = await sess(req);
        const jid = req.body.jid;
        const c = wa.chats.get(jid);
        if (c) { c.unread = 0; scheduleSave(wa); }
        try {
            const last = [...(wa.msgs.get(jid) || [])].reverse().find(m => !m.fromMe);
            const raw = last && wa.raw.get(last.id);
            if (raw && s.sock && s.status === 'CONNECTED') await s.sock.readMessages([raw.key]);
        } catch (e) {}
        res.json({ success: true });
    }));

    app.post('/api/wa/:s/send', ctx.upload.single('file'), wrap(async (req, res) => {
        const { name, s, wa } = await sess(req);
        if (s.status !== 'CONNECTED') return res.status(400).json({ error: 'Session is not connected. Scan the QR first.' });
        const jid = normJid(req.body.jid);
        const text = (req.body.text || '').trim();
        let content;
        if (req.file) {
            const buf = fs.readFileSync(req.file.path);
            fs.unlink(req.file.path, () => {});
            const mt = req.file.mimetype || '';
            if (mt.startsWith('image/')) content = { image: buf, caption: text };
            else if (mt.startsWith('video/')) content = { video: buf, caption: text };
            else if (mt.startsWith('audio/')) content = { audio: buf, mimetype: mt };
            else content = { document: buf, fileName: req.file.originalname, mimetype: mt, caption: text };
        } else {
            if (!text) return res.status(400).json({ error: 'Message is empty.' });
            content = { text };
        }
        const sent = await s.sock.sendMessage(jid, content);
        addMessage(name, wa, sent, {});
        ctx.addLog(name, `Dashboard sent to +${numOf(jid)}`, 'success');
        res.json({ success: true, msg: wa.msgs.get(jid)?.find(x => x.id === sent.key.id) || null });
    }));

    app.get('/api/wa/:s/media/:jid/:id', async (req, res) => {
        try {
            const { s, wa } = await sess(req);
            const raw = wa.raw.get(req.params.id);
            if (!raw) return res.status(404).end();
            const m = wa.msgs.get(req.params.jid)?.find(x => x.id === req.params.id);
            const buf = await downloadMediaMessage(raw, 'buffer', {}, {
                logger: pino({ level: 'silent' }),
                reuploadRequest: s.sock.updateMediaMessage
            });
            res.set('Content-Type', m?.mime || 'application/octet-stream');
            res.set('Cache-Control', 'private, max-age=86400');
            res.send(buf);
        } catch (e) { res.status(404).end(); }
    });

    app.get('/api/wa/:s/avatar/:jid', async (req, res) => {
        try {
            const { s, wa } = await sess(req);
            const jid = req.params.jid;
            let e = wa.avatars.get(jid);
            if (!e || Date.now() - e.ts > 3600e3) {
                let url = null;
                try { if (s.sock && s.status === 'CONNECTED') url = await s.sock.profilePictureUrl(jid, 'image'); } catch (err) {}
                e = { url, ts: Date.now() };
                wa.avatars.set(jid, e);
            }
            if (!e.url) return res.status(404).end();
            res.set('Cache-Control', 'private, max-age=3600');
            res.redirect(e.url);
        } catch (e) { res.status(404).end(); }
    });

    app.get('/api/wa/:s/events', async (req, res) => {
        const { wa } = await sess(req);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        wa.clients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
        req.on('close', () => { clearInterval(ping); wa.clients.delete(res); });
    });

    /* ----- incoming log API ----- */
    const filterInbox = (wa, q) => {
        const want = String(q.number || '').replace(/\D/g, '');
        const w10 = want.length > 10 ? want.slice(-10) : want;
        const text = String(q.q || '').toLowerCase();
        const since = parseInt(q.since) || 0;
        let out = wa.inbox.map(e => inboxEntry(wa, e));
        if (w10) out = out.filter(e => e.number && e.number.endsWith(w10));
        if (q.kind) out = out.filter(e => e.kind === q.kind);
        if (q.group === 'true') out = out.filter(e => e.group);
        if (q.group === 'false') out = out.filter(e => !e.group);
        if (since) out = out.filter(e => e.ts >= since);
        if (text) out = out.filter(e => (e.text || '').toLowerCase().includes(text) || (e.name || '').toLowerCase().includes(text) || (e.number || '').includes(text));
        return out.sort((a, b) => b.ts - a.ts);
    };

    // GET /api/incoming/:session?limit=100&offset=0&number=7015373621&q=text&kind=text&group=false&since=<unix>
    app.get('/api/incoming/:s', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const all = filterInbox(wa, req.query);
        const limit = Math.min(parseInt(req.query.limit) || 100, 1000);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        res.json({ success: true, session: name, total: all.length, count: Math.min(limit, Math.max(all.length - offset, 0)), messages: all.slice(offset, offset + limit) });
    }));

    // GET /api/incoming/:session/summary  -> messages per number
    app.get('/api/incoming/:s/summary', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const lastBy = new Map();
        for (const e of wa.inbox) {
            const k = wa.lidMap.get(e.from) || e.from;
            const o = lastBy.get(k);
            if (!o || e.ts >= o.ts) lastBy.set(k, e);
        }
        const merged = new Map();
        for (const [k0, c] of Object.entries(wa.counts)) {
            const k = wa.lidMap.get(k0) || k0;
            const m = merged.get(k) || { count: 0, first: c.first, last: c.last };
            m.count += c.count; m.first = Math.min(m.first, c.first); m.last = Math.max(m.last, c.last);
            merged.set(k, m);
        }
        const numbers = [...merged.entries()].map(([k, c]) => {
            const le = lastBy.get(k);
            return {
                number: isLid(k) ? '' : numOf(k), phone: fmtPhone(k), name: wa.names.get(k) || '',
                count: c.count, first_ts: c.first, last_ts: c.last,
                last_text: le ? (le.text || `[${le.kind}]`) : ''
            };
        }).sort((a, b) => b.count - a.count || b.last_ts - a.last_ts);
        const today = istDay(Date.now() / 1000);
        res.json({
            success: true, session: name,
            total_messages: numbers.reduce((a, n) => a + n.count, 0),
            total_numbers: numbers.length,
            today_messages: wa.inbox.filter(e => istDay(e.ts) === today).length,
            numbers
        });
    }));

    // GET /api/incoming/:session/export.csv
    app.get('/api/incoming/:s/export.csv', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
        const rows = filterInbox(wa, req.query).map(e => [e.time, e.number, e.name, e.kind, e.group ? 'group' : 'private', e.text].map(q).join(','));
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="incoming-${name}.csv"`);
        res.send('\ufefftime,number,name,type,chat,message\n' + rows.join('\n'));
    }));

    /* ----- agent ----- */
    const publicCfg = cfg => ({ ...cfg, apiKey: cfg.apiKey ? '••••' + cfg.apiKey.slice(-4) : '', hasKey: !!cfg.apiKey });

    app.get('/api/agent/:s/config', wrap(async (req, res) => {
        const { wa } = await sess(req);
        res.json(publicCfg(wa.agent));
    }));

    app.post('/api/agent/:s/config', wrap(async (req, res) => {
        const { wa } = await sess(req);
        const b = req.body, a = wa.agent;
        if (b.toggleChat) {
            const i = a.disabledChats.indexOf(b.toggleChat);
            if (i >= 0) a.disabledChats.splice(i, 1); else a.disabledChats.push(b.toggleChat);
        }
        if (typeof b.enabled === 'boolean') a.enabled = b.enabled;
        if (['draft', 'auto'].includes(b.mode)) a.mode = b.mode;
        if (['anthropic', 'openai'].includes(b.provider)) a.provider = b.provider;
        if (typeof b.model === 'string' && b.model.trim()) a.model = b.model.trim();
        if (typeof b.baseUrl === 'string') a.baseUrl = b.baseUrl.trim();
        if (typeof b.systemPrompt === 'string') a.systemPrompt = b.systemPrompt;
        if (typeof b.apiKey === 'string' && b.apiKey && !b.apiKey.startsWith('••')) a.apiKey = b.apiKey.trim();
        if (b.contextLimit) a.contextLimit = Math.min(60, Math.max(1, parseInt(b.contextLimit) || 20));
        if (b.delaySec != null) a.delaySec = Math.min(120, Math.max(1, parseInt(b.delaySec) || 4));
        if (typeof b.ignoreGroups === 'boolean') a.ignoreGroups = b.ignoreGroups;
        saveAgent(wa);
        res.json(publicCfg(a));
    }));

    app.post('/api/agent/:s/test', wrap(async (req, res) => {
        const { wa } = await sess(req);
        if (!wa.agent.apiKey) return res.status(400).json({ error: 'Save an API key first.' });
        const text = await callAI(wa.agent, 'You are a connectivity test.', [{ role: 'user', content: 'Reply with the single word: OK' }]);
        res.json({ success: true, text });
    }));

    app.get('/api/agent/:s/drafts', wrap(async (req, res) => {
        const { wa } = await sess(req);
        res.json(wa.drafts);
    }));

    app.post('/api/agent/:s/suggest', wrap(async (req, res) => {
        const { name } = await sess(req);
        const jid = req.body.jid;
        if (!jid) return res.status(400).json({ error: 'jid is required' });
        const none = () => res.status(400).json({ error: 'Nothing to reply to (last message is yours, or the AI chose not to answer).' });
        if (req.body.asDraft) {
            const d = await runAgent(name, jid, false);
            return d ? res.json({ text: d.text, draft: d }) : none();
        }
        const text = await generate(name, jid);
        return text ? res.json({ text }) : none();
    }));

    app.post('/api/agent/:s/drafts/:id/approve', wrap(async (req, res) => {
        const { name, wa } = await sess(req);
        const d = wa.drafts.find(x => x.id === req.params.id);
        if (!d) return res.status(404).json({ error: 'Draft not found (already sent or discarded).' });
        const text = (req.body.text || d.text).trim();
        await sendText(name, d.jid, text);
        wa.drafts = wa.drafts.filter(x => x.id !== d.id);
        emit(wa, 'draftRemoved', { jid: d.jid });
        res.json({ success: true });
    }));

    app.delete('/api/agent/:s/drafts/:id', wrap(async (req, res) => {
        const { wa } = await sess(req);
        const d = wa.drafts.find(x => x.id === req.params.id);
        wa.drafts = wa.drafts.filter(x => x.id !== req.params.id);
        if (d) emit(wa, 'draftRemoved', { jid: d.jid });
        res.json({ success: true });
    }));
}

module.exports = { attach, routes };
