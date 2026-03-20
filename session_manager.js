/**
 * session_manager.js
 * Manages live WhatsApp sessions using whatsapp-web.js.
 * Exposes an internal HTTP API consumed by bot.py.
 * Persists session data back to PostgreSQL via bot.py webhook.
 */

const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

const PORT = parseInt(process.env.NODE_PORT || '3001', 10);
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'changeme';
const WEBHOOK_URL = `http://localhost:${process.env.PORT || 8080}/webhook/event`;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const DATABASE_URL = process.env.DATABASE_URL;

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: DATABASE_URL });

// ── In-memory session registry ────────────────────────────────────────────────
// key: phone_number → { client, user_id, status }
const sessions = new Map();

// Pending OTPs waiting to be submitted: phone → otp string
const pendingOtps = new Map();

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.headers['x-api-key'] !== INTERNAL_API_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Submit OTP for a registration in progress
app.post('/otp', requireApiKey, (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'Missing fields' });
  pendingOtps.set(phone, otp);
  console.log(`[OTP] Queued OTP for ${phone}`);
  res.json({ ok: true });
});

// Submit pairing code
app.post('/pair', requireApiKey, async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Missing fields' });
  const entry = sessions.get(phone);
  if (!entry) return res.status(404).json({ error: 'Session not found' });
  try {
    await entry.client.acceptPairingCode(code);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[PAIR] Error for ${phone}:`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// Restore sessions after bot restart
app.post('/restore', requireApiKey, async (req, res) => {
  const list = req.body; // [{ phone, session }]
  if (!Array.isArray(list)) return res.status(400).json({ error: 'Expected array' });
  for (const item of list) {
    if (item.phone && item.session && !sessions.has(item.phone)) {
      await createSession(item.phone, null, item.session);
    }
  }
  res.json({ ok: true, restored: list.length });
});

// Health
app.get('/health', (req, res) => res.json({ ok: true, sessions: sessions.size }));

app.listen(PORT, () => {
  console.log(`[session_manager] Listening on port ${PORT}`);
});

// ── Webhook caller ────────────────────────────────────────────────────────────
async function callWebhook(event, phone, user_id, extra = {}) {
  try {
    await axios.post(WEBHOOK_URL, {
      event,
      phone_number: phone,
      telegram_user_id: user_id,
      ...extra,
    }, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
      timeout: 8000,
    });
  } catch (e) {
    console.error(`[WEBHOOK] Failed to send ${event} for ${phone}:`, e.message);
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function getRegistration(phone) {
  const res = await pool.query(
    'SELECT * FROM registrations WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 1',
    [phone]
  );
  return res.rows[0] || null;
}

async function saveSessionData(phone, sessionData) {
  const reg = await getRegistration(phone);
  if (!reg) return;
  await pool.query(
    `UPDATE registrations SET session_data = $1, updated_at = NOW()
     WHERE telegram_user_id = $2 AND phone_number = $3`,
    [JSON.stringify(sessionData), reg.telegram_user_id, phone]
  );
}

// ── Create / restore a WhatsApp session ──────────────────────────────────────
async function createSession(phone, user_id, savedSession = null) {
  if (sessions.has(phone)) {
    console.log(`[SESSION] ${phone} already has an active session`);
    return;
  }

  console.log(`[SESSION] Creating session for ${phone}`);

  const clientOptions = {
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    },
    // Use in-memory auth; we persist manually to PG
    authStrategy: new LocalAuth({ clientId: phone }),
  };

  const client = new Client(clientOptions);

  // If we have a saved session, inject it
  if (savedSession) {
    try {
      // whatsapp-web.js LocalAuth reads from filesystem; for DB-backed sessions
      // we write the session file before initialising
      const fs = require('fs');
      const path = require('path');
      const sessionDir = path.join('.wwebjs_auth', `session-${phone}`);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'session.json'),
        typeof savedSession === 'string' ? savedSession : JSON.stringify(savedSession)
      );
    } catch (e) {
      console.error(`[SESSION] Could not restore session file for ${phone}:`, e.message);
    }
  }

  const entry = { client, user_id, status: 'INIT' };
  sessions.set(phone, entry);

  client.on('authenticated', async (session) => {
    console.log(`[AUTH] ${phone} authenticated`);
    entry.status = 'AUTHENTICATED';
    await saveSessionData(phone, session);
  });

  client.on('auth_failure', async (msg) => {
    console.error(`[AUTH FAIL] ${phone}: ${msg}`);
    entry.status = 'AUTH_FAIL';
    const reg = await getRegistration(phone);
    if (reg) {
      await callWebhook('banned', phone, reg.telegram_user_id);
    }
    sessions.delete(phone);
  });

  client.on('ready', async () => {
    console.log(`[READY] ${phone} session is live`);
    entry.status = 'READY';
  });

  client.on('disconnected', async (reason) => {
    console.warn(`[DISCONNECTED] ${phone}: ${reason}`);
    entry.status = 'DISCONNECTED';
    sessions.delete(phone);
    const reg = await getRegistration(phone);
    if (!reg) return;

    if (reason === 'UNPAIRED' || reason === 'UNPAIRED_IDLE') {
      await callWebhook('restricted', phone, reg.telegram_user_id, {
        seconds_remaining: 0,
      });
    } else if (reason === 'CONFLICT' || reason === 'REPLACED') {
      // Another device took over — re-init
      setTimeout(() => createSession(phone, reg.telegram_user_id, null), 10000);
    }
  });

  // Pairing code requested by an external device
  client.on('remote_session_saved', async () => {
    const reg = await getRegistration(phone);
    if (reg) {
      await callWebhook('pairing_requested', phone, reg.telegram_user_id);
    }
  });

  // Save updated session whenever it changes
  client.on('change_state', async (state) => {
    console.log(`[STATE] ${phone} → ${state}`);
    if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
      const reg = await getRegistration(phone);
      if (reg) {
        await callWebhook('restricted', phone, reg.telegram_user_id, {
          seconds_remaining: 3600,
        });
      }
    }
  });

  await client.initialize();
}

// ── Export for GitHub Actions webhook (registration complete) ─────────────────
// When the emulator workflow completes it calls POST /webhook/event on bot.py.
// The session_manager just keeps sessions alive — it doesn't handle registration
// itself. But it does need to boot the WA client once registration succeeds.

// Poll for new REGISTERED numbers every 30 seconds and start sessions
setInterval(async () => {
  try {
    const res = await pool.query(
      `SELECT phone_number, telegram_user_id, session_data
       FROM registrations
       WHERE status IN ('REGISTERED','PAIRED','AWAITING_PAIRING')
       AND phone_number NOT IN (${[...sessions.keys()].map((_, i) => `$${i + 1}`).join(',') || "''"})`
    , [...sessions.keys()]);
    for (const row of res.rows) {
      await createSession(row.phone_number, row.telegram_user_id, row.session_data);
    }
  } catch (e) {
    // ignore if no sessions yet
  }
}, 30000);
