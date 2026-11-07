
// RP Digital Tribe - WhatsApp AI Assistant (Node.js)
// Polls incoming messages every 3 seconds, replies via Groq.
// Requires Node 18+ (built-in fetch). No npm dependencies.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CONFIG (env variables) ----------
const SESSION = process.env.SESSION || 'rp-01';
const WA_BASE = process.env.WA_BASE || 'https://rp-digital-tribes-wa-api.onrender.com';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const MODEL_PRIMARY = process.env.GROQ_MODEL_PRIMARY || 'openai/gpt-oss-20b';
const MODEL_FALLBACK = process.env.GROQ_MODEL_FALLBACK || 'qwen/qwen3-32b';
const POLL_MS = Number(process.env.POLL_MS || 3000);
const PORT = Number(process.env.PORT || 3000);
const ONLY_PRIVATE = true;
const MAX_REPLY_LENGTH = 800;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'bot.log');

if (!GROQ_API_KEY) {
  console.error('GROQ_API_KEY missing! Set it in environment variables.');
  process.exit(1);
}

const SYSTEM_PROMPT = `You are an active, real human core team member at RP Digital Tribe's official WhatsApp helpdesk in Hansi, Haryana.
You NEVER sound like an AI, machine, or scripted bot. You sound like a friendly, sharp, professional human team member replying from your phone or web WhatsApp.

=== CRITICAL LANGUAGE MIRRORING RULE (VERY IMPORTANT) ===
- If the user messages in ENGLISH: Reply purely in natural, crisp, professional conversational English.
- If the user messages in HINDI / HINGLISH: Reply in warm, natural conversational Hinglish (Indian casual professional style).
- If the user mixes both: Match their exact tone and language blend.
- Keep replies SHORT & DIRECT (1 to 3 lines maximum). No bulky paragraphs!

=== AGENCY IDENTITY & CREDENTIALS ===
- Agency: RP Digital Tribe (Official web: [www.rpdigitaltribe.site](https://www.rpdigitaltribe.site) / [www.rptribe.site](https://www.rptribe.site))
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

// ---------- HELPERS ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = `${new Date().toISOString()} | ${msg}`;
  console.log(line);
  try {
    // keep log file small
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch {}
}

async function request(url, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  try {
    const res = await fetch(url, {
      method,
      body,
      headers,
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    return { code: res.status, text, err: '' };
  } catch (e) {
    return { code: 0, text: '', err: e.message };
  }
}

async function sendTypingPresence(cleanNumber) {
  const jid = cleanNumber + '@s.whatsapp.net';
  const urls = [
    `${WA_BASE}/api/presence?session=${SESSION}&number=${encodeURIComponent(cleanNumber)}&state=composing`,
    `${WA_BASE}/api/presence/${SESSION}?jid=${encodeURIComponent(jid)}&state=composing`,
  ];
  await Promise.all(urls.map((u) => request(u, { timeout: 2000 })));
}

async function sendWhatsApp(number, text) {
  let clean = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  clean = clean.replace(/^["'\s]+|["'\s]+$/g, '');
  if (!clean || /RP Digital Trend Message/i.test(clean)) return false;
  clean = clean.slice(0, MAX_REPLY_LENGTH);

  const cleanNumber = String(number).replace(/\D/g, '');
  if (cleanNumber.length < 10) return false;
  const jid = cleanNumber + '@s.whatsapp.net';

  await sendTypingPresence(cleanNumber);
  await sleep(400);

  // Method 1: JSON POST
  const post = await request(`${WA_BASE}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      session: SESSION,
      number: cleanNumber,
      to: jid,
      jid,
      text: clean,
      message: clean,
      body: clean,
    }),
    timeout: 6000,
  });
  if (post.code === 200) return true;

  // Method 2: GET fallback
  const qs = new URLSearchParams({
    session: SESSION,
    number: cleanNumber,
    to: cleanNumber,
    text: clean,
    message: clean,
    body: clean,
  }).toString();
  const get = await request(`${WA_BASE}/api/send?${qs}`, { timeout: 6000 });
  if (get.code !== 200) {
    log(`WA Send Error (POST ${post.code} / GET ${get.code}) -> ${cleanNumber}: ${get.err || get.text.slice(0, 100)}`);
    return false;
  }
  return true;
}

async function askAI(userMessage, history = []) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history) {
    if (h && h.role && h.content) messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: 'user', content: userMessage });

  for (const model of [MODEL_PRIMARY, MODEL_FALLBACK]) {
    const payload = {
      model,
      messages,
      temperature: 0.6,
      max_tokens: 400,
      top_p: 0.9,
    };
    if (model.includes('gpt-oss')) payload.reasoning_effort = 'low';

    const r = await request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      timeout: 8000,
    });

    if (r.code === 200 && r.text) {
      try {
        const data = JSON.parse(r.text);
        let reply = (data?.choices?.[0]?.message?.content || '').trim();
        reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        reply = reply.replace(/^["'\s]+|["'\s]+$/g, '');
        if (reply && !/RP Digital Trend Message/i.test(reply)) return reply;
      } catch {}
    } else {
      log(`Groq failed (${model} | HTTP ${r.code}): ${r.err || r.text.slice(0, 150)}`);
    }
  }
  return null;
}

// ---------- STATE ----------
let state = { last_ts: 0, processed: [], history: {} };
try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...state, ...loaded };
  }
} catch (e) {
  log('State load failed, starting fresh: ' + e.message);
}
const processed = new Set(state.processed);

function saveState() {
  let arr = [...processed];
  if (arr.length > 250) arr = arr.slice(-250);
  state.processed = arr;
  const keys = Object.keys(state.history);
  if (keys.length > 50) {
    for (const k of keys.slice(0, keys.length - 50)) delete state.history[k];
  }
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) {
    log('State save failed: ' + e.message);
  }
}

// ---------- MAIN TICK ----------
async function tick() {
  const r = await request(`${WA_BASE}/api/incoming/${SESSION}?limit=15`, { timeout: 8000 });
  if (r.code !== 200 || !r.text) {
    log(`Incoming fetch failed: HTTP ${r.code} | ${r.err}`);
    return;
  }

  let data;
  try {
    data = JSON.parse(r.text);
  } catch {
    return;
  }
  const msgs = (data.messages || []).slice().reverse(); // oldest first
  let changed = false;

  for (const msg of msgs) {
    const id = msg.id || '';
    let ts = Number(msg.ts || 0);
    if (ts > 1e12) ts = Math.floor(ts / 1000); // ms -> sec
    const text = String(msg.text ?? msg.message ?? '').trim();
    const number = String(msg.number ?? msg.from ?? '').trim();
    const cleanNo = number.replace(/\D/g, '');
    const isGroup = !!msg.group || number.includes('@g.us');
    const fromMe = !!msg.fromMe || !!msg.self;
    const kind = msg.kind || 'text';

    if (!id || processed.has(id)) continue;

    const skip = () => {
      processed.add(id);
      changed = true;
    };

    if (fromMe || /RP Digital Trend Message/i.test(text)) { skip(); continue; }
    if (ONLY_PRIVATE && isGroup) { skip(); continue; }
    if (kind !== 'text' || !text || !cleanNo) { skip(); continue; }
    if (ts > 0 && Date.now() / 1000 - ts > 1200) { skip(); continue; } // older than 20 min

    log(`New from ${cleanNo}: ${text.slice(0, 60)}`);

    // mark first so a slow reply never causes a duplicate on the next tick
    processed.add(id);
    changed = true;

    const history = state.history[cleanNo] || [];
    const reply = await askAI(text, history);

    if (reply && reply.length >= 2) {
      if (await sendWhatsApp(cleanNo, reply)) {
        log(`Replied to ${cleanNo}: ${reply.slice(0, 60)}`);
        state.history[cleanNo] = [
          ...history,
          { role: 'user', content: text },
          { role: 'assistant', content: reply },
        ].slice(-4);
      } else {
        log(`Failed to send to ${cleanNo}`);
      }
    } else {
      log(`AI returned no response for ${cleanNo}`);
    }

    if (ts > state.last_ts) state.last_ts = ts;
  }

  if (changed) saveState();
}

// ---------- RUN FOREVER (no overlap: next tick starts 3s AFTER previous ends) ----------
async function loop() {
  log(`Bot started. Polling every ${POLL_MS}ms`);
  while (true) {
    try {
      await tick();
    } catch (e) {
      log('Tick error: ' + e.message);
    }
    await sleep(POLL_MS);
  }
}

// Tiny HTTP server: health check + keeps free hosts (Render) awake via uptime pinger
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('RP Digital Tribe bot is running');
  })
  .listen(PORT, () => log(`Health server on port ${PORT}`));

process.on('unhandledRejection', (e) => log('unhandledRejection: ' + e));
process.on('uncaughtException', (e) => log('uncaughtException: ' + e));

loop();
