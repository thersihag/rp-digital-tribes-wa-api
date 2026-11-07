// RP Digital Tribe - Multi-Account WhatsApp AI Assistant (Node.js)
// - Many WhatsApp sessions (rp-01, rp-02, rahul-01 ...) each with its own prompt/settings/history
// - Human-like typing indicator while the AI thinks + while "typing" the reply
// - /setup page (setup.html) to add / edit / test accounts without touching code
// Requires Node 18+ (built-in fetch). No npm dependencies.
//
// ENV VARIABLES
//   GROQ_API_KEY     shared Groq key (each account can also have its own key)
//   SETUP_PASSWORD   REQUIRED to use /setup (the page stays locked without it)
//   WA_BASE          WhatsApp API base url
//   DATA_DIR         folder for accounts.json / state / logs (use a persistent disk on Render!)
//   POLL_MS, PORT    optional

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- GLOBAL CONFIG ----------
const WA_BASE = (process.env.WA_BASE || 'https://rp-digital-tribes-wa-api.onrender.com').replace(/\/+$/, '');
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const SETUP_PASSWORD = process.env.SETUP_PASSWORD || '';
const POLL_MS = Number(process.env.POLL_MS || 3000);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');
const SETUP_HTML = path.join(__dirname, 'setup.html');
const LOOP_GUARD = /RP Digital Trend Message/i;

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// ---------- PROMPTS ----------
const RP_PROMPT = `You are an active, real human core team member at RP Digital Tribe's official WhatsApp helpdesk in Hansi, Haryana.
You NEVER sound like an AI, machine, or scripted bot. You sound like a friendly, sharp, professional human team member replying from your phone or web WhatsApp.

=== CRITICAL LANGUAGE MIRRORING RULE (VERY IMPORTANT) ===
- If the user messages in ENGLISH: Reply purely in natural, crisp, professional conversational English.
- If the user messages in HINDI / HINGLISH: Reply in warm, natural conversational Hinglish (Indian casual professional style).
- If the user mixes both: Match their exact tone and language blend.
- Keep replies SHORT & DIRECT (1 to 3 lines maximum). No bulky paragraphs!

=== AGENCY IDENTITY & CREDENTIALS ===
- Agency: RP Digital Tribe (Official web: www.rpdigitaltribe.site / www.rptribe.site)
- Address: Building No. 223/23, Hisar Chungi, Arya Nagar, Hansi – 125033, Haryana, India.
- Recognition: MSME / Udyam Registered, Startup India (AICET) Registered, Startup Haryana Registered. Awarded "Best Agency in Hansi (2024)".
- Founder & Director: Rahul Sihag
  * AI Researcher, Data Analyst & Tech Entrepreneur.
  * M.Sc. in Computer Science (Artificial Intelligence & Data Science) at GJUST (Guru Jambheshwar University of Science & Technology, Hisar).
  * Direct Desk / WhatsApp: +91 70153 73621 | Alternate: +91 80598 87394, +91 83072 38926
  * Personal Portfolio: rpdigitaltribe.site/rahul-sihag/
- Regional Base: Hansi, Hisar, Sirsa, Jind, Agroha, Panipat, across Haryana & pan-India.

=== OUR SERVICES & PRICING (2026) ===
1. Website Development:
   - Single-Page Website: ₹3,999 (Landing page, responsive design, enquiry button, basic SEO).
   - Personal Portfolio: ₹5,999 (Showcase, CV download, projects, contact form).
   - 5-Page Business Website: ₹7,999 (Most popular - About, Services, Contact, WhatsApp & Maps integration).
   - Corporate & Industry Platforms: From ₹15,999 (Hospitals, Hotels, Real Estate, Gyms).
   - Advanced & E-Commerce Platforms: From ₹25,999 (Online stores, payment gateway, College/University systems).
2. School Management Software & Apps: Attendance, fee collection, student database, parent app, exams.
3. Custom AI & Automation: Tailored business AI, task workflows, Law AI (custom legal AI).
4. Digital Marketing, PR & SEO: Google Knowledge Panel setup, press release/media coverage, search ranking.
5. Graphic Design & Branding: Brand identity, logos, festival posters, UI/UX.
6. Student Internships: Hansi office + remote live-project internships at rpdigitaltribe.site/internship_registration.php

=== REAL HUMAN REPLY STYLE GUIDELINES ===
- If someone asks for Rahul / "Rahul how are you":
  * English: "Hey! Doing great, hope you're doing well too! Rahul sir is in a project meeting right now. I'm handling the RP Digital Tribe desk—tell me what you need, I can pass the message or set up a quick callback!"
  * Hindi/Hinglish: "Hello ji! Ekdum badhiya, aap suniye kaise hain? Rahul sir abhi meeting mein hain. Main desk se hoon—bataiye kya kaam tha, main sir ko inform kar doon ya call connect karwaun?"
- If someone says "Hi" / "Hello":
  * English: "Hello! Welcome to RP Digital Tribe. How can I help you today with website development, software, or digital marketing?"
  * Hinglish: "Namaste! RP Digital Tribe mein swagat hai. Bataiye, aaj website, software ya digital marketing mein kis cheez ki requirement hai?"
- If someone asks for price/cost:
  * Give the starting baseline (₹3,999 for single page / ₹7,999 for 5-page business site) and ask what kind of business/website they are planning.
- NEVER use markdown headings (#), asterisk overload, or robotic disclaimers. Reply like a quick, helpful human typing on WhatsApp.`;

const TEMPLATE_PROMPT = `You are a friendly human team member replying on WhatsApp for [BUSINESS NAME].
Never sound like an AI or a bot. Reply in the same language the customer uses (English, Hindi or Hinglish).
Keep replies short: 1 to 3 lines. No markdown headings.

About the business:
- [What you do]
- [Address / city]
- [Contact number]

Services and prices:
- [Service 1: price]
- [Service 2: price]

If you don't know something, say you'll check and get back soon.`;

// ---------- ACCOUNT MODEL ----------
const ACCOUNT_DEFAULTS = {
  id: '',
  name: '',
  enabled: true,
  systemPrompt: TEMPLATE_PROMPT,
  groqKey: '',
  modelPrimary: 'openai/gpt-oss-20b',
  modelFallback: 'qwen/qwen3-32b',
  temperature: 0.6,
  maxTokens: 400,
  maxReplyLength: 800,
  historySize: 4,
  staleMinutes: 20,
  onlyPrivate: true,
  ignoreNumbers: '',
  typing: true,
  typingCharMs: 45,
  typingMaxMs: 9000,
};

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

function sanitizeAccount(input = {}, existing = {}) {
  const a = { ...ACCOUNT_DEFAULTS, ...existing };
  const str = (v, d) => (typeof v === 'string' ? v.trim() : d);
  const bool = (v, d) => (typeof v === 'boolean' ? v : d);
  const num = (v, d, min, max) => {
    if (v === '' || v === null || v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
  };

  if (!existing.id) a.id = str(input.id, '').toLowerCase();
  a.name = str(input.name, a.name).slice(0, 60);
  a.enabled = bool(input.enabled, a.enabled);
  a.systemPrompt = str(input.systemPrompt, a.systemPrompt).slice(0, 20000);
  a.modelPrimary = str(input.modelPrimary, a.modelPrimary) || ACCOUNT_DEFAULTS.modelPrimary;
  a.modelFallback = str(input.modelFallback, a.modelFallback);
  a.temperature = num(input.temperature, a.temperature, 0, 2);
  a.maxTokens = Math.round(num(input.maxTokens, a.maxTokens, 50, 4000));
  a.maxReplyLength = Math.round(num(input.maxReplyLength, a.maxReplyLength, 50, 4000));
  a.historySize = Math.round(num(input.historySize, a.historySize, 0, 20));
  a.staleMinutes = Math.round(num(input.staleMinutes, a.staleMinutes, 1, 1440));
  a.onlyPrivate = bool(input.onlyPrivate, a.onlyPrivate);
  a.ignoreNumbers = str(input.ignoreNumbers, a.ignoreNumbers).slice(0, 2000);
  a.typing = bool(input.typing, a.typing);
  a.typingCharMs = Math.round(num(input.typingCharMs, a.typingCharMs, 0, 300));
  a.typingMaxMs = Math.round(num(input.typingMaxMs, a.typingMaxMs, 0, 30000));

  if (typeof input.groqKey === 'string' && input.groqKey.trim()) a.groqKey = input.groqKey.trim();
  if (input.clearKey === true) a.groqKey = '';
  if (!a.name) a.name = a.id;
  return a;
}

let accounts = [];

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
      accounts = (raw.accounts || []).map((a) => sanitizeAccount(a, { id: a.id }));
      return;
    }
  } catch (e) {
    console.error('accounts.json load failed:', e.message);
  }
  // first run: create one default account (same behaviour as the old single-session bot)
  const id = (process.env.SESSION || 'rp-01').toLowerCase();
  accounts = [sanitizeAccount({ name: 'RP Digital Tribe', systemPrompt: RP_PROMPT }, { id })];
  // migrate old single-file state if present
  try {
    const old = path.join(DATA_DIR, 'state.json');
    if (fs.existsSync(old)) fs.copyFileSync(old, stateFile(id));
  } catch {}
  saveAccounts();
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE + '.tmp', JSON.stringify({ accounts }, null, 2));
    fs.renameSync(ACCOUNTS_FILE + '.tmp', ACCOUNTS_FILE);
  } catch (e) {
    console.error('accounts.json save failed:', e.message);
  }
}

const getAccount = (id) => accounts.find((a) => a.id === id);
const stateFile = (id) => path.join(DATA_DIR, `state-${id}.json`);

// ---------- LOGGING ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg, id = '-') {
  const line = `${new Date().toISOString()} | ${id} | ${msg}`;
  console.log(line);
  const rt = runtimes.get(id);
  if (rt) {
    rt.logs.push(line);
    if (rt.logs.length > 200) rt.logs.shift();
  }
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, '');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

// ---------- HTTP HELPERS ----------
async function request(url, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  try {
    const res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    return { code: res.status, text, err: '' };
  } catch (e) {
    return { code: 0, text: '', err: e.message };
  }
}

// ---------- WHATSAPP: typing + send ----------
async function sendPresence(session, cleanNumber, state) {
  const jid = cleanNumber + '@s.whatsapp.net';
  const urls = [
    `${WA_BASE}/api/presence?session=${encodeURIComponent(session)}&number=${encodeURIComponent(cleanNumber)}&state=${state}`,
    `${WA_BASE}/api/presence/${encodeURIComponent(session)}?jid=${encodeURIComponent(jid)}&state=${state}`,
  ];
  await Promise.all(urls.map((u) => request(u, { timeout: 2500 })));
}

// WhatsApp's "typing..." fades after a few seconds, so we refresh it until we stop.
function startTyping(session, cleanNumber) {
  let active = true;
  const ping = () => { if (active) sendPresence(session, cleanNumber, 'composing'); };
  ping();
  const timer = setInterval(ping, 2500);
  return (sendPaused = false) => {
    active = false;
    clearInterval(timer);
    if (sendPaused) sendPresence(session, cleanNumber, 'paused');
  };
}

async function sendWhatsApp(acc, number, text) {
  let clean = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  clean = clean.replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean || LOOP_GUARD.test(clean)) return false;
  clean = clean.slice(0, acc.maxReplyLength);

  const cleanNumber = String(number).replace(/\D/g, '');
  if (cleanNumber.length < 10) return false;
  const jid = cleanNumber + '@s.whatsapp.net';

  // Method 1: JSON POST
  const post = await request(`${WA_BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      session: acc.id, number: cleanNumber, to: jid, jid,
      text: clean, message: clean, body: clean,
    }),
    timeout: 6000,
  });
  if (post.code === 200) return true;

  // Method 2: GET fallback
  const qs = new URLSearchParams({
    session: acc.id, number: cleanNumber, to: cleanNumber,
    text: clean, message: clean, body: clean,
  }).toString();
  const get = await request(`${WA_BASE}/api/send?${qs}`, { timeout: 6000 });
  if (get.code !== 200) {
    log(`WA send error (POST ${post.code} / GET ${get.code}) -> ${cleanNumber}: ${get.err || get.text.slice(0, 100)}`, acc.id);
    return false;
  }
  return true;
}

// ---------- AI ----------
async function askAI(acc, userMessage, history = []) {
  const key = acc.groqKey || GROQ_API_KEY;
  if (!key) return { reply: null, error: 'No Groq API key (set GROQ_API_KEY or add one for this account)' };

  const messages = [{ role: 'system', content: acc.systemPrompt }];
  for (const h of history) if (h && h.role && h.content) messages.push({ role: h.role, content: h.content });
  messages.push({ role: 'user', content: userMessage });

  let lastError = '';
  const models = [acc.modelPrimary, acc.modelFallback].filter(Boolean);
  for (const model of models) {
    const payload = {
      model, messages,
      temperature: acc.temperature,
      max_tokens: acc.maxTokens,
      top_p: 0.9,
    };
    if (model.includes('gpt-oss')) payload.reasoning_effort = 'low';

    const r = await request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 10000,
    });

    if (r.code === 200 && r.text) {
      try {
        const data = JSON.parse(r.text);
        let reply = (data?.choices?.[0]?.message?.content || '').trim();
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        reply = reply.replace(/^["'\s]+|["'\s]+$/g, '');
        if (reply && !LOOP_GUARD.test(reply)) return { reply, error: '' };
      } catch {}
    } else {
      lastError = `Groq failed (${model} | HTTP ${r.code}): ${r.err || r.text.slice(0, 150)}`;
      log(lastError, acc.id);
    }
  }
  return { reply: null, error: lastError || 'AI returned an empty reply' };
}

// ---------- PER-ACCOUNT RUNTIME ----------
const runtimes = new Map();

function getRuntime(id) {
  let rt = runtimes.get(id);
  if (rt) return rt;
  let state = { last_ts: 0, processed: [], history: {} };
  try {
    if (fs.existsSync(stateFile(id))) state = { ...state, ...JSON.parse(fs.readFileSync(stateFile(id), 'utf8')) };
  } catch (e) {
    console.error(`state load failed for ${id}:`, e.message);
  }
  rt = {
    id, state, processed: new Set(state.processed),
    stop: false, running: false, logs: [],
    stats: { received: 0, replied: 0, failed: 0, lastPoll: 0, lastReplyAt: 0, lastError: '' },
  };
  runtimes.set(id, rt);
  return rt;
}

function saveState(rt) {
  let arr = [...rt.processed];
  if (arr.length > 250) arr = arr.slice(-250);
  rt.state.processed = arr;
  const keys = Object.keys(rt.state.history);
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete rt.state.history[k];
  try {
    fs.writeFileSync(stateFile(rt.id) + '.tmp', JSON.stringify(rt.state, null, 2));
    fs.renameSync(stateFile(rt.id) + '.tmp', stateFile(rt.id));
  } catch (e) {
    log('State save failed: ' + e.message, rt.id);
  }
}

async function tick(rt) {
  const acc = getAccount(rt.id);
  if (!acc) return;

  const r = await request(`${WA_BASE}/api/incoming/${encodeURIComponent(acc.id)}?limit=15`, { timeout: 8000 });
  rt.stats.lastPoll = Date.now();
  if (r.code !== 200 || !r.text) {
    rt.stats.lastError = `Incoming fetch failed: HTTP ${r.code} ${r.err}`;
    log(rt.stats.lastError, acc.id);
    return;
  }

  let data;
  try { data = JSON.parse(r.text); } catch { return; }
  rt.stats.lastError = '';

  const ignored = acc.ignoreNumbers.split(/[,\s]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 7);
  const msgs = (data.messages || []).slice().reverse(); // oldest first
  let changed = false;

  for (const msg of msgs) {
    const id = msg.id || '';
    let ts = Number(msg.ts || 0);
    if (ts > 1e12) ts = Math.floor(ts / 1000);
    const text = String(msg.text ?? msg.message ?? '').trim();
    const number = String(msg.number ?? msg.from ?? '').trim();
    const cleanNo = number.replace(/\D/g, '');
    const isGroup = !!msg.group || number.includes('@g.us');
    const fromMe = !!msg.fromMe || !!msg.self;
    const kind = msg.kind || 'text';

    if (!id || rt.processed.has(id)) continue;
    const skip = () => { rt.processed.add(id); changed = true; };

    if (fromMe || LOOP_GUARD.test(text)) { skip(); continue; }
    if (acc.onlyPrivate && isGroup) { skip(); continue; }
    if (kind !== 'text' || !text || !cleanNo) { skip(); continue; }
    if (ignored.some((n) => cleanNo.endsWith(n))) { skip(); continue; }
    if (ts > 0 && Date.now() / 1000 - ts > acc.staleMinutes * 60) { skip(); continue; }

    log(`New from ${cleanNo}: ${text.slice(0, 60)}`, acc.id);
    rt.stats.received++;

    // mark first so a slow reply never causes a duplicate on the next tick
    rt.processed.add(id);
    changed = true;

    const hist = rt.state.history[cleanNo] || [];
    const used = acc.historySize > 0 ? hist.slice(-acc.historySize) : [];

    // show "typing..." from the moment we start thinking
    const stopTyping = acc.typing ? startTyping(acc.id, cleanNo) : null;
    let result = { reply: null };
    try {
      const t0 = Date.now();
      result = await askAI(acc, text, used);
      // then keep typing for a believable time based on reply length
      if (result.reply && acc.typing) {
        const want = Math.min(acc.typingMaxMs, Math.max(1200, result.reply.length * acc.typingCharMs));
        const left = want - (Date.now() - t0);
        if (left > 0) await sleep(left);
      }
    } finally {
      if (stopTyping) stopTyping(!result.reply);
    }

    const reply = result.reply;
    if (reply && reply.length >= 2) {
      if (await sendWhatsApp(acc, cleanNo, reply)) {
        log(`Replied to ${cleanNo}: ${reply.slice(0, 60)}`, acc.id);
        rt.stats.replied++;
        rt.stats.lastReplyAt = Date.now();
        rt.state.history[cleanNo] = [
          ...hist,
          { role: 'user', content: text },
          { role: 'assistant', content: reply },
        ].slice(-Math.max(acc.historySize, 2) * 2);
      } else {
        rt.stats.failed++;
        rt.stats.lastError = `Failed to send to ${cleanNo}`;
        log(rt.stats.lastError, acc.id);
      }
    } else {
      rt.stats.failed++;
      rt.stats.lastError = result.error || 'AI returned no response';
      log(`AI returned no response for ${cleanNo}: ${rt.stats.lastError}`, acc.id);
    }

    if (ts > rt.state.last_ts) rt.state.last_ts = ts;
  }

  if (changed) saveState(rt);
}

async function runLoop(rt) {
  rt.running = true;
  log(`Bot started. Polling every ${POLL_MS}ms`, rt.id);
  while (!rt.stop) {
    try { await tick(rt); } catch (e) { log('Tick error: ' + e.message, rt.id); }
    await sleep(POLL_MS);
  }
  rt.running = false;
  log('Bot stopped', rt.id);
  if (!getAccount(rt.id) && runtimes.get(rt.id) === rt) runtimes.delete(rt.id);
}

// start / stop loops so they match accounts.json
function reconcile() {
  for (const acc of accounts) {
    const rt = getRuntime(acc.id);
    if (acc.enabled) {
      rt.stop = false;
      if (!rt.running) runLoop(rt);
    } else {
      rt.stop = true;
    }
  }
  for (const [id, rt] of runtimes) if (!getAccount(id)) rt.stop = true;
}

// ---------- SETUP API ----------
const failedLogins = new Map();

function checkAuth(req) {
  if (!SETUP_PASSWORD) return 'disabled';
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const f = failedLogins.get(ip);
  const recent = f && Date.now() - f.t < 600000;
  if (recent && f.count >= 10) return 'limited';
  const a = Buffer.from(String(req.headers['x-setup-key'] || ''));
  const b = Buffer.from(SETUP_PASSWORD);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    failedLogins.delete(ip);
    return 'ok';
  }
  failedLogins.set(ip, { count: (recent ? f.count : 0) + 1, t: Date.now() });
  return 'bad';
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function publicAccount(acc) {
  const { groqKey, ...rest } = acc;
  const rt = runtimes.get(acc.id);
  return {
    ...rest,
    hasKey: !!groqKey,
    stats: rt ? { ...rt.stats, running: rt.running, chats: Object.keys(rt.state.history).length } : null,
  };
}

async function handleApi(req, res, url) {
  const auth = checkAuth(req);
  if (auth === 'disabled') return sendJson(res, 503, { error: 'Setup is locked. Set the SETUP_PASSWORD environment variable and restart.' });
  if (auth === 'limited') return sendJson(res, 429, { error: 'Too many wrong attempts. Try again in 10 minutes.' });
  if (auth !== 'ok') return sendJson(res, 401, { error: 'Wrong password' });

  const p = url.pathname.replace(/\/+$/, '');
  const m = p.match(/^\/setup\/api\/accounts(?:\/([a-z0-9_-]+))?(?:\/(test|logs|reset))?$/i);

  try {
    if (p === '/setup/api/export' && req.method === 'GET') {
      return sendJson(res, 200, { accounts: accounts.map((a) => { const { groqKey, ...rest } = a; return rest; }) });
    }

    if (p === '/setup/api/import' && req.method === 'POST') {
      const body = await readJson(req);
      let count = 0;
      for (const item of Array.isArray(body.accounts) ? body.accounts : []) {
        const id = String(item?.id || '').toLowerCase();
        if (!ID_RE.test(id)) continue;
        const idx = accounts.findIndex((a) => a.id === id);
        if (idx >= 0) accounts[idx] = sanitizeAccount(item, accounts[idx]);
        else accounts.push(sanitizeAccount(item, {}));
        count++;
      }
      saveAccounts();
      reconcile();
      return sendJson(res, 200, { ok: true, imported: count });
    }

    if (!m) return sendJson(res, 404, { error: 'Not found' });
    const [, id, action] = m;

    // list + create
    if (!id) {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          accounts: accounts.map(publicAccount),
          waBase: WA_BASE,
          hasGlobalKey: !!GROQ_API_KEY,
          defaults: { ...ACCOUNT_DEFAULTS, groqKey: undefined },
        });
      }
      if (req.method === 'POST') {
        const body = await readJson(req);
        const newId = String(body.id || '').trim().toLowerCase();
        if (!ID_RE.test(newId)) return sendJson(res, 400, { error: 'Session ID: 2-32 chars, only a-z, 0-9, - and _ (e.g. rp-02)' });
        if (getAccount(newId)) return sendJson(res, 409, { error: 'This session ID already exists' });
        const acc = sanitizeAccount({ ...body, id: newId }, {});
        accounts.push(acc);
        saveAccounts();
        reconcile();
        return sendJson(res, 200, { account: publicAccount(acc) });
      }
    }

    const acc = getAccount(String(id || '').toLowerCase());
    if (!acc) return sendJson(res, 404, { error: 'Account not found' });

    if (!action && req.method === 'PUT') {
      const body = await readJson(req);
      const idx = accounts.indexOf(acc);
      accounts[idx] = sanitizeAccount(body, acc);
      saveAccounts();
      reconcile();
      return sendJson(res, 200, { account: publicAccount(accounts[idx]) });
    }

    if (!action && req.method === 'DELETE') {
      accounts = accounts.filter((a) => a.id !== acc.id);
      saveAccounts();
      reconcile();
      try { fs.unlinkSync(stateFile(acc.id)); } catch {}
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'logs' && req.method === 'GET') {
      const rt = runtimes.get(acc.id);
      return sendJson(res, 200, { logs: rt ? rt.logs.slice(-120) : [] });
    }

    if (action === 'reset' && req.method === 'POST') {
      const rt = getRuntime(acc.id);
      rt.state.history = {};
      saveState(rt);
      return sendJson(res, 200, { ok: true });
    }

    if (action === 'test' && req.method === 'POST') {
      const body = await readJson(req);
      const message = String(body.message || '').trim();
      if (!message) return sendJson(res, 400, { error: 'Message is empty' });
      // test with the unsaved form values, so you can tune the prompt before saving
      const draft = sanitizeAccount(body.account || {}, acc);
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-12);
      const out = await askAI(draft, message, history);
      return sendJson(res, 200, out);
    }

    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
}

// ---------- HTTP SERVER ----------
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/+$/, '') || '/';

    if (p.startsWith('/setup/api/')) return handleApi(req, res, url);

    if (p === '/setup') {
      try {
        const html = fs.readFileSync(SETUP_HTML);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      } catch {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('setup.html not found next to index.js');
      }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`RP Digital Tribe bot is running (${accounts.filter((a) => a.enabled).length} active accounts)`);
  })
  .listen(PORT, () => log(`Server on port ${PORT}. Setup page: /setup ${SETUP_PASSWORD ? '' : '(LOCKED: set SETUP_PASSWORD)'}`));

process.on('unhandledRejection', (e) => log('unhandledRejection: ' + e));
process.on('uncaughtException', (e) => log('uncaughtException: ' + e));

if (!GROQ_API_KEY) console.warn('Note: GROQ_API_KEY not set. Each account must have its own Groq key.');
loadAccounts();
reconcile();
