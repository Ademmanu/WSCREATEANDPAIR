'use strict';

/**
 * session_manager.js  (Baileys edition)
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages WhatsApp sessions using @whiskeysockets/baileys.
 * Drops the whatsapp-web.js / Puppeteer / Chrome dependency entirely.
 *
 * Internal HTTP API (consumed by bot.py — same surface as before):
 *   POST /register          — start Baileys registration for a new number
 *   POST /restore           — reload saved sessions from bot.py on startup
 *   POST /pair              — (reserved — not used in Baileys mobile flow)
 *   GET  /health            — liveness check
 *
 * Webhook events fired back to bot.py (unchanged):
 *   otp_requested / registered / otp_error / bad_number /
 *   rate_limited / banned / restricted / session_update
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const axios   = require('axios');
const { Pool }= require('pg');
const { registerWithBaileys } = require('./wa_register_baileys');

// ── Env ───────────────────────────────────────────────────────────────────────
const PORT             = parseInt(process.env.NODE_PORT || '3001', 10);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'changeme';
const WEBHOOK_BASE     = `http://localhost:${process.env.PORT || 8080}`;
const WEBHOOK_URL      = `${WEBHOOK_BASE}/webhook/event`;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || '';
const DATABASE_URL     = process.env.DATABASE_URL;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL });

// ── In-memory session registry ────────────────────────────────────────────────
// phone → { sock, userId, status, reconnectTimer }
const sessions = new Map();

// Track in-flight registrations to prevent duplicates
// phone → Promise
const registrationInFlight = new Map();

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// ══════════════════════════════════════════════════════════════════════════════
// POST /register  — start a new registration
// ══════════════════════════════════════════════════════════════════════════════
app.post('/register', requireApiKey, async (req, res) => {
  const { phone, telegram_user_id, run_id = '' } = req.body;

  if (!phone || !telegram_user_id) {
    return res.status(400).json({ error: 'Missing phone or telegram_user_id' });
  }

  // Prevent double-registration
  if (registrationInFlight.has(phone)) {
    return res.status(409).json({ error: 'Registration already in progress for this number' });
  }

  console.log(`[REGISTER] Starting Baileys registration for +${phone}`);

  // Acknowledge immediately — registration is async
  res.json({ ok: true, message: 'Registration started' });

  // Run registration in the background
  const job = registerWithBaileys({
    phone,
    webhookUrl:     WEBHOOK_URL,
    webhookSecret:  WEBHOOK_SECRET,
    telegramUserId: telegram_user_id,
    runId:          run_id,
  })
  .then(({ sessionData }) => {
    console.log(`[REGISTER] ✓ +${phone} registered — booting session`);
    // Boot the live session with the fresh credentials
    return bootSession(phone, telegram_user_id, sessionData);
  })
  .catch((err) => {
    if (!err.handled) {
      // Unhandled error — fire bad_number as fallback
      console.error(`[REGISTER] Unhandled error for +${phone}:`, err.message);
      callWebhook('bad_number', phone, telegram_user_id, {
        reason: `Unexpected registration error: ${err.message}`,
      }).catch(() => {});
    }
  })
  .finally(() => {
    registrationInFlight.delete(phone);
  });

  registrationInFlight.set(phone, job);
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /restore  — reload sessions after bot restart
// ══════════════════════════════════════════════════════════════════════════════
app.post('/restore', requireApiKey, async (req, res) => {
  const list = req.body; // [{ phone, user_id, session }]
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected array' });

  let restored = 0;
  for (const item of list) {
    if (item.phone && item.session && !sessions.has(item.phone)) {
      try {
        await bootSession(item.phone, item.user_id, item.session);
        restored++;
      } catch (e) {
        console.error(`[RESTORE] Failed to restore +${item.phone}:`, e.message);
      }
    }
  }
  console.log(`[RESTORE] Restored ${restored}/${list.length} sessions`);
  res.json({ ok: true, restored });
});

// ══════════════════════════════════════════════════════════════════════════════
// POST /pair  — reserved for compatibility (not needed in Baileys mobile flow)
// ══════════════════════════════════════════════════════════════════════════════
app.post('/pair', requireApiKey, (req, res) => {
  // In the Baileys mobile flow, pairing codes are not used for new registrations.
  // This endpoint is kept for API compatibility with bot.py.
  res.json({ ok: true, note: 'Pairing not applicable for Baileys mobile sessions' });
});

// ══════════════════════════════════════════════════════════════════════════════
// GET /health
// ══════════════════════════════════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    ok:       true,
    sessions: sessions.size,
    inFlight: registrationInFlight.size,
    phones:   [...sessions.keys()],
  });
});

app.listen(PORT, () => {
  console.log(`[session_manager] Baileys edition — listening on port ${PORT}`);
});

// ══════════════════════════════════════════════════════════════════════════════
// bootSession — create a live Baileys socket from saved credentials
// ══════════════════════════════════════════════════════════════════════════════
async function bootSession(phone, userId, savedSessionData) {
  if (sessions.has(phone)) {
    console.log(`[SESSION] +${phone} already active`);
    return;
  }

  let Baileys;
  try { Baileys = require('@whiskeysockets/baileys'); }
  catch (_) { throw new Error('Baileys not installed'); }

  let pino;
  try { pino = require('pino'); }
  catch (_) { pino = () => ({ level: 'silent', child: () => ({}) }); }

  const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DisconnectReason,
  } = Baileys;

  const logger     = pino({ level: 'silent' });
  const sessionDir = `/tmp/wa-session-${phone}`;

  // Write saved credentials to the tmp directory so useMultiFileAuthState can read them
  await writeSessionToDisk(sessionDir, savedSessionData);

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();

  console.log(`[SESSION] Booting session for +${phone}`);

  const sock = makeWASocket({
    version,
    logger,
    mobile: true,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal:  false,
    syncFullHistory:    false,
    markOnlineOnConnect: true,
  });

  const entry = { sock, userId, status: 'CONNECTING', reconnectTimer: null };
  sessions.set(phone, entry);

  // ── Persist credential updates ────────────────────────────────────────────
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    const updated = await captureSessionFromDisk(sessionDir);
    await callWebhook('session_update', phone, userId, { session_data: updated });
  });

  // ── Connection state machine ──────────────────────────────────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (connection === 'open') {
      console.log(`[SESSION] ✓ +${phone} connected`);
      entry.status = 'READY';
      clearTimeout(entry.reconnectTimer);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const reason     = lastDisconnect?.error?.message || 'unknown';
      console.warn(`[SESSION] +${phone} disconnected: ${reason} (${statusCode})`);
      entry.status = 'DISCONNECTED';
      sessions.delete(phone);

      if (statusCode === DisconnectReason.loggedOut ||
          statusCode === 401) {
        console.error(`[SESSION] +${phone} logged out / banned`);
        await callWebhook('banned', phone, userId);
        return; // don't reconnect
      }

      if (statusCode === 440 /* account restricted */ ) {
        await callWebhook('restricted', phone, userId, { seconds_remaining: 3600 });
        return;
      }

      // Transient disconnect — reconnect with back-off
      const delay = 10_000 + Math.random() * 10_000;
      console.log(`[SESSION] +${phone} reconnecting in ${Math.round(delay / 1000)}s`);
      entry.reconnectTimer = setTimeout(async () => {
        try {
          const refreshed = await captureSessionFromDisk(sessionDir);
          await bootSession(phone, userId, refreshed);
        } catch (e) {
          console.error(`[SESSION] Reconnect failed for +${phone}:`, e.message);
        }
      }, delay);
    }
  });

  // ── Message events (extend as needed) ────────────────────────────────────
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.key.fromMe) {
        console.log(`[MSG] +${phone} received message from ${msg.key.remoteJid}`);
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// DB helpers
// ══════════════════════════════════════════════════════════════════════════════

async function getRegistration(phone) {
  const res = await pool.query(
    'SELECT * FROM registrations WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1',
    [phone]
  );
  return res.rows[0] || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// Webhook helper
// ══════════════════════════════════════════════════════════════════════════════

async function callWebhook(event, phone, userId, extra = {}) {
  try {
    await axios.post(WEBHOOK_URL, {
      event,
      phone_number:     phone,
      telegram_user_id: userId,
      ...extra,
    }, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
      timeout: 8_000,
    });
  } catch (e) {
    console.error(`[WEBHOOK] Failed to fire ${event} for +${phone}: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Session serialisation helpers
// ══════════════════════════════════════════════════════════════════════════════

/** Write a saved session blob (object of filename → content) to disk. */
async function writeSessionToDisk(dir, data) {
  if (!data || typeof data !== 'object') return;
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(data)) {
    const filePath = path.join(dir, filename);
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    fs.writeFileSync(filePath, raw, 'utf8');
  }
}

/** Read a session directory back into an object of filename → parsed content. */
async function captureSessionFromDisk(dir) {
  const data = {};
  try {
    for (const file of fs.readdirSync(dir)) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      try { data[file] = JSON.parse(raw); }
      catch (_) { data[file] = raw; }
    }
  } catch (_) {}
  return data;
}

// ══════════════════════════════════════════════════════════════════════════════
// Poll DB on startup — boot sessions for numbers that are already registered
// ══════════════════════════════════════════════════════════════════════════════
async function bootExistingSessions() {
  try {
    const res = await pool.query(
      `SELECT phone_number, telegram_user_id, session_data
       FROM registrations
       WHERE status IN ('REGISTERED','PAIRED','AWAITING_PAIRING','RESTRICTED')
         AND session_data IS NOT NULL`
    );
    console.log(`[STARTUP] Found ${res.rows.length} sessions to restore from DB`);
    for (const row of res.rows) {
      if (!sessions.has(row.phone_number)) {
        try {
          await bootSession(row.phone_number, row.telegram_user_id, row.session_data);
        } catch (e) {
          console.error(`[STARTUP] Failed to boot +${row.phone_number}: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.error('[STARTUP] DB query failed:', e.message);
  }
}

// Wait for DB + 5 s before restoring (give bot.py time to start its server)
setTimeout(bootExistingSessions, 5_000);
