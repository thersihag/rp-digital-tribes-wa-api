const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Silent logger required for Baileys internal signal store caching
const logger = pino({ level: 'silent' });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure folders exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const sessionsDir = process.env.SESSIONS_DIR || path.join(__dirname, 'sessions');
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });

const upload = multer({ dest: 'uploads/' });

// Global sessions map
// Structure: [sessionName] -> { sock, status, qr, rawQr, logs: [], isSending: false, isConnecting: false, phoneNumber: null, reconnectTimer: null }
const sessions = new Map();

function addLog(sessionName, message, type = 'info') {
    const session = sessions.get(sessionName);
    if (!session) return;
    
    const time = new Date().toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    
    session.logs.push({ time, message, type });
    
    if (session.logs.length > 100) {
        session.logs.shift();
    }
}

function formatNumber(num) {
    let n = num.toString().replace(/[^0-9]/g, '');
    if (n.length === 10) n = '91' + n;
    return `${n}@s.whatsapp.net`;
}

async function getOrInitSession(sessionName = 'default') {
    sessionName = sessionName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!sessionName) sessionName = 'default';
    
    if (sessions.has(sessionName)) {
        return sessions.get(sessionName);
    }

    const sessionData = {
        sock: null,
        status: 'INITIALIZING',
        qr: null,
        rawQr: null,
        logs: [],
        isSending: false,
        isConnecting: false,
        phoneNumber: null,
        reconnectTimer: null
    };
    sessions.set(sessionName, sessionData);

    addLog(sessionName, `RP Digital Trend Engine initializing for instance: [${sessionName}]`, 'info');
    startBaileys(sessionName).catch(err => {
        addLog(sessionName, `Fatal Connection Error: ${err.message}`, 'error');
        sessionData.status = 'ERROR';
        sessionData.isConnecting = false;
    });

    return sessionData;
}

// Safe check for credentials - Prevents 4-5 hour auto-logout bug
function verifyCredentialsSafe(sessionPath) {
    try {
        if (!fs.existsSync(sessionPath)) {
            fs.mkdirSync(sessionPath, { recursive: true });
            return;
        }
        const credsPath = path.join(sessionPath, 'creds.json');
        if (fs.existsSync(credsPath)) {
            const content = fs.readFileSync(credsPath, 'utf8');
            if (!content || content.trim() === '') {
                fs.unlinkSync(credsPath);
            } else {
                JSON.parse(content);
            }
        }
    } catch (e) {
        console.error(`[Auth Warning] Minor issue reading creds.json in ${sessionPath}:`, e.message);
    }
}

async function startBaileys(sessionName) {
    const sessionData = sessions.get(sessionName);
    if (!sessionData) return;

    if (sessionData.isConnecting) return;
    sessionData.isConnecting = true;

    if (sessionData.reconnectTimer) {
        clearTimeout(sessionData.reconnectTimer);
        sessionData.reconnectTimer = null;
    }

    if (sessionData.sock) {
        try {
            sessionData.sock.ev.removeAllListeners('connection.update');
            sessionData.sock.ev.removeAllListeners('creds.update');
            sessionData.sock.ev.removeAllListeners('messages.upsert');
            sessionData.sock.ws.close();
        } catch (err) {}
    }

    const sessionPath = path.join(sessionsDir, sessionName);
    verifyCredentialsSafe(sessionPath);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    
    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestBaileysVersion();
        version = latest.version;
    } catch (e) {
        addLog(sessionName, `Using fallback WA version: ${version.join('.')}`, 'info');
    }

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        printQRInTerminal: false,
        logger,
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 25000,
        retryRequestDelayMs: 2000,
        getMessage: async () => ({ conversation: 'RP Digital Trend Message' })
    });

    sessionData.sock = sock;

    sock.ev.on('creds.update', async () => {
        try {
            await saveCreds();
        } catch (err) {
            addLog(sessionName, `Warning saving credentials: ${err.message}`, 'warning');
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sessionData.status = 'DISCONNECTED';
            sessionData.isConnecting = false;
            sessionData.rawQr = qr;
            try {
                sessionData.qr = await QRCode.toDataURL(qr);
                addLog(sessionName, "New QR Code generated. Ready for scan.", 'warning');
            } catch (e) {
                addLog(sessionName, "Failed to render QR Code.", 'error');
            }
        }

        if (connection === 'open') {
            sessionData.status = 'CONNECTED';
            sessionData.isConnecting = false;
            sessionData.qr = null;
            sessionData.rawQr = null;
            const userNum = sock.user.id.split(':')[0];
            sessionData.phoneNumber = userNum;
            addLog(sessionName, `Logged In! Permanent Session Active as +${userNum}`, 'success');
        }

        if (connection === 'close') {
            sessionData.isConnecting = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const errorReason = lastDisconnect?.error?.message || 'Connection reset';
            
            sessionData.status = 'DISCONNECTED';
            addLog(sessionName, `Connection dropped: "${errorReason}" (Code: ${statusCode || 'Network'})`, 'warning');

            if (statusCode === DisconnectReason.loggedOut) {
                addLog(sessionName, "User logged out from phone (401). Clearing session.", 'error');
                sessionData.phoneNumber = null;
                sessionData.qr = null;
                sessions.delete(sessionName);
                try {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                } catch (e) {}
            } else if (statusCode === DisconnectReason.connectionReplaced) {
                addLog(sessionName, "Session conflict detected. Waiting 15s before reclaiming...", 'warning');
                sessionData.reconnectTimer = setTimeout(() => startBaileys(sessionName), 15000);
            } else {
                const reconnectDelay = statusCode === DisconnectReason.restartRequired ? 1000 : 5000;
                addLog(sessionName, `Auto-reconnecting permanent session in ${reconnectDelay / 1000}s...`, 'info');
                sessionData.reconnectTimer = setTimeout(() => startBaileys(sessionName), reconnectDelay);
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        try {
            const msg = m.messages[0];
            if (!msg.key.fromMe && m.type === 'notify') {
                const sender = msg.key.remoteJid.split('@')[0];
                const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "[Media/Other]";
                addLog(sessionName, `Incoming from +${sender}: "${text.substring(0, 30)}"`, 'info');
            }
        } catch (err) {}
    });
}

function restoreExistingSessions() {
    try {
        const folders = fs.readdirSync(sessionsDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        if (folders.length === 0) {
            getOrInitSession('default');
        } else {
            folders.forEach(sessionName => {
                console.log(`[RP Digital Trend] Restoring session: ${sessionName}`);
                getOrInitSession(sessionName);
            });
        }
    } catch (e) {
        getOrInitSession('default');
    }
}

restoreExistingSessions();

// 1. Main Dashboard
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// 2. APIs Sandbox (Supports /apis, /apis.html, /api)
app.get(['/apis', '/apis.html', '/api'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'apis.html')));

// 3. QR Generator & External Panel Embedder (Supports /apis-qr, /apis-qr.html)
app.get(['/apis-qr', '/apis-qr.html'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'apis-qr.html')));

// Get JSON status & base64 QR of a session
app.get('/api/status/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    res.json({
        brand: 'RP Digital Trend',
        session: sessionName.toLowerCase(),
        status: session.status,
        qr: session.qr,
        number: session.phoneNumber || 'N/A'
    });
});

// Direct PNG Image endpoint for embedding QR into other external panels via <img src="...">
app.get('/api/qr-image/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    
    if (session.status === 'CONNECTED') {
        return res.status(200).send(`
            <html><body style="background:#020617;color:#10b981;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;">
                <div><h2>✅ Connected (+${session.phoneNumber})</h2><p style="color:#94a3b8;font-size:12px;">Session [${sessionName}] is active on RP Digital Trend</p></div>
            </body></html>
        `);
    }

    if (!session.rawQr) {
        return res.status(202).send(`
            <html><head><meta http-equiv="refresh" content="3"></head>
            <body style="background:#020617;color:#f59e0b;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;">
                <div><h4>⏳ Generating QR for [${sessionName}]...</h4><p style="color:#94a3b8;font-size:12px;">Auto-refreshing in 3 seconds...</p></div>
            </body></html>
        `);
    }

    try {
        const imgBuffer = await QRCode.toBuffer(session.rawQr, { type: 'png', width: 320, margin: 2 });
        res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': imgBuffer.length,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
        });
        res.end(imgBuffer);
    } catch (e) {
        res.status(500).json({ error: 'Failed to generate QR image buffer' });
    }
});

// Logout / Reset a specific session manually
app.post('/api/logout/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const cleanName = sessionName.trim().toLowerCase();
    const sessionData = sessions.get(cleanName);
    const sessionPath = path.join(sessionsDir, cleanName);

    if (sessionData && sessionData.sock) {
        try {
            await sessionData.sock.logout();
        } catch (e) {}
    }
    sessions.delete(cleanName);
    try {
        fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (e) {}

    // Re-init fresh session for new QR
    await getOrInitSession(cleanName);
    res.json({ success: true, message: `Session [${cleanName}] reset. Generating fresh QR...` });
});

// Get logs for specific session
app.get('/api/logs/:sessionName', async (req, res) => {
    const { sessionName } = req.params;
    const session = await getOrInitSession(sessionName);
    res.json({
        logs: session.logs,
        isSending: session.isSending
    });
});

app.get('/api/send', async (req, res) => {
    let { session = 'default', number, text, media } = req.query;

    if (!number || !text) {
        return res.status(400).json({ error: "Missing 'number' or 'text' query parameters." });
    }

    try {
        const sessionData = await getOrInitSession(session);
        if (sessionData.status !== 'CONNECTED') {
            return res.status(400).json({ error: `Session [${session}] is not logged in. Scan QR Code first.` });
        }

        const jid = formatNumber(number);
        if (media) {
            await sessionData.sock.sendMessage(jid, { image: { url: media }, caption: text });
            addLog(session, `API Sent to +${number} with Media.`, 'success');
        } else {
            await sessionData.sock.sendMessage(jid, { text });
            addLog(session, `API Sent to +${number}.`, 'success');
        }

        res.json({ success: true, brand: "RP Digital Trend", message: "Message dispatched successfully." });
    } catch (err) {
        addLog(session, `Failed API Message to +${number}: ${err.message}`, 'error');
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/send-bulk', upload.single('media'), async (req, res) => {
    const { session = 'default', numbers, message } = req.body;

    if (!numbers || !message) {
        return res.status(400).json({ error: "Numbers and message content are required." });
    }

    const sessionData = await getOrInitSession(session);
    if (sessionData.status !== 'CONNECTED') {
        return res.status(400).json({ error: `Selected Session [${session}] is not connected.` });
    }

    if (sessionData.isSending) {
        return res.status(429).json({ error: "Another bulk campaign is already running on this session." });
    }

    const list = numbers.split(/[,\n]+/).map(n => n.trim()).filter(n => n.length > 5);
    if (list.length === 0) {
        return res.status(400).json({ error: "No valid destination phone numbers found." });
    }

    let mediaPath = null;
    if (req.file) {
        mediaPath = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    }

    runBulkWorker(session.trim().toLowerCase(), list, message, mediaPath);
    res.json({ success: true, message: `Bulk Campaign started for ${list.length} contacts.` });
});

async function runBulkWorker(sessionName, list, text, mediaUrl) {
    const sessionData = sessions.get(sessionName);
    if (!sessionData) return;

    sessionData.isSending = true;
    addLog(sessionName, `🚀 Starting bulk campaign targeting ${list.length} contacts.`, 'info');

    for (let i = 0; i < list.length; i++) {
        let waitRetries = 0;
        while (sessionData.status !== 'CONNECTED' && waitRetries < 6) {
            addLog(sessionName, `⏳ Waiting for session auto-reconnect...`, 'warning');
            await new Promise(resolve => setTimeout(resolve, 5000));
            waitRetries++;
        }

        if (sessionData.status !== 'CONNECTED') {
            addLog(sessionName, `⚠️ Campaign stopped: Session disconnected.`, 'error');
            break;
        }

        const number = list[i];
        const jid = formatNumber(number);

        try {
            if (mediaUrl) {
                await sessionData.sock.sendMessage(jid, { image: { url: mediaUrl }, caption: text });
            } else {
                await sessionData.sock.sendMessage(jid, { text });
            }
            addLog(sessionName, `[${i + 1}/${list.length}] Sent to +${number}`, 'success');
        } catch (err) {
            addLog(sessionName, `[${i + 1}/${list.length}] Failed +${number}: ${err.message}`, 'error');
        }

        if (i < list.length - 1) {
            const delay = Math.floor(Math.random() * 60000) + 60000;
            addLog(sessionName, `Waiting ${(delay / 1000).toFixed(0)}s before next message...`, 'info');
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    sessionData.isSending = false;
    addLog(sessionName, `🏁 Bulk campaign completed.`, 'success');
}

process.on('uncaughtException', (err) => console.error('[Protection] Uncaught Exception:', err.message));
process.on('unhandledRejection', (reason) => console.error('[Protection] Unhandled Rejection:', reason));

app.listen(port, () => {
    console.log(`=============================================`);
    console.log(` 🚀 RP Digital Trend - Multi WhatsApp Gateway`);
    console.log(` 🌐 URL: http://localhost:${port}`);
    console.log(`=============================================`);
});
