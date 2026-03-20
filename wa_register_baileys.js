'use strict';

/**
 * wa_register_baileys.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Registers a new WhatsApp account via Baileys mobile protocol.
 * No emulator. No ADB. No GitHub Actions. Pure Node.js.
 *
 * Called by session_manager.js POST /register.
 *
 * Flow:
 *   1. Create Baileys mobile socket for the phone number
 *   2. Request SMS verification code from WhatsApp
 *   3. Fire `otp_requested` webhook → user replies OTP on Telegram
 *   4. Poll bot.py GET /otp/{phone} until code arrives (up to 14 min)
 *   5. Submit OTP to WhatsApp via sock.register(otp)
 *   6. On success: fire `registered` webhook + return serialised creds
 *   7. On any failure: fire appropriate webhook + throw
 *
 * Webhook events fired (identical surface to old GitHub Actions flow):
 *   otp_requested  — WA accepted the number, SMS sent
 *   registered     — OTP accepted, account live
 *   otp_error      — Wrong OTP entered
 *   bad_number     — WA rejected the number
 *   rate_limited   — Too many attempts  { wait_seconds }
 *   banned         — Number permanently banned
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs    = require('fs');
const https = require('https');
const http  = require('http');

// ── Timing constants ─────────────────────────────────────────────────────────
const OTP_POLL_INTERVAL = 5_000;          // 5 s between polls
const OTP_TIMEOUT       = 14 * 60_000;   // 14 min total (bot timer is 15)
const CONNECT_TIMEOUT   = 30_000;        // initial WA connection

// ══════════════════════════════════════════════════════════════════════════════
// Main export
// ══════════════════════════════════════════════════════════════════════════════

/**
 * registerWithBaileys({ phone, webhookUrl, webhookSecret, telegramUserId, runId })
 *
 * @returns {{ success: true, sessionData: object }}  on success
 * @throws  Error (webhook already fired before throw)
 */
async function registerWithBaileys({
  phone,           // international digits, no +  e.g. "221764322805"
  webhookUrl,      // full URL  e.g. "https://mybot.onrender.com/webhook/event"
  webhookSecret,
  telegramUserId,  // number or string
  runId = '',
}) {
  // ── Lazy-load Baileys (optional peer dep until this function is called) ───
  let Baileys;
  try {
    Baileys = require('@whiskeysockets/baileys');
  } catch (e) {
    throw new Error(
      'Baileys not installed. Run: npm install @whiskeysockets/baileys'
    );
  }

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
  const sessionDir = `/tmp/wa-reg-${phone}`;

  log(`Starting Baileys registration for +${phone}`);

  // Clean slate — remove any leftover tmp state from a previous attempt
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version }          = await fetchLatestBaileysVersion();
  log(`Using WA version ${version.join('.')}`);

  // ── Create mobile socket ─────────────────────────────────────────────────
  const sock = makeWASocket({
    version,
    logger,
    mobile: true,   // ← enables the phone-number registration protocol
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    // Reduce noise on Render logs
    printQRInTerminal: false,
    syncFullHistory:   false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── Wait for initial connection ───────────────────────────────────────────
  await waitForOpen(sock, CONNECT_TIMEOUT);

  // ── Already registered? ───────────────────────────────────────────────────
  if (sock.authState.creds.registered) {
    log(`+${phone} already registered — firing webhook`);
    const sessionData = await captureSession(sessionDir, saveCreds);
    await webhook('registered', phone, telegramUserId, runId, webhookUrl, webhookSecret,
                  { session_data: sessionData });
    await cleanupSocket(sock, sessionDir);
    return { success: true, sessionData };
  }

  // ── Request SMS OTP ───────────────────────────────────────────────────────
  log(`Requesting SMS OTP for +${phone}`);
  try {
    await sock.requestRegistrationCode({
      phoneNumber: `+${phone}`,
      method:      'sms',
    });
  } catch (err) {
    await cleanupSocket(sock, sessionDir);
    return handleRequestError(err, phone, telegramUserId, runId, webhookUrl, webhookSecret);
  }

  // Notify bot — user now needs to reply with the OTP on Telegram
  await webhook('otp_requested', phone, telegramUserId, runId, webhookUrl, webhookSecret);
  log(`OTP requested — polling ${webhookUrl.replace(/\/webhook.*/, '')}/otp/${phone}`);

  // ── Poll for OTP from the Telegram user ──────────────────────────────────
  const otpBase = webhookUrl.replace(/\/webhook\/event.*$/, '');
  const otpUrl  = `${otpBase}/otp/${phone}`;
  const otp     = await pollForOTP(otpUrl, webhookSecret);

  if (!otp) {
    await cleanupSocket(sock, sessionDir);
    // No webhook here — bot.py's 15-min timer already updated the message
    throw new Error(`OTP timeout for +${phone} — user did not reply within 14 minutes`);
  }

  log(`OTP received: ${otp} — submitting to WhatsApp`);

  // ── Submit OTP ────────────────────────────────────────────────────────────
  try {
    await sock.register(otp.trim());
  } catch (err) {
    await cleanupSocket(sock, sessionDir);
    return handleRegisterError(err, phone, telegramUserId, runId, webhookUrl, webhookSecret);
  }

  log(`✓ Registration successful for +${phone}`);

  // ── Persist credentials ───────────────────────────────────────────────────
  const sessionData = await captureSession(sessionDir, saveCreds);

  await webhook('registered', phone, telegramUserId, runId, webhookUrl, webhookSecret,
                { session_data: sessionData });

  await cleanupSocket(sock, sessionDir);
  return { success: true, sessionData };
}

// ══════════════════════════════════════════════════════════════════════════════
// Error classifiers
// ══════════════════════════════════════════════════════════════════════════════

async function handleRequestError(err, phone, userId, runId, wUrl, wSecret) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.output?.statusCode || err?.status || 0;

  if (status === 429 || msg.includes('too many') || msg.includes('rate')) {
    const secs = parseWaitSeconds(err.message) || 600;
    await webhook('rate_limited', phone, userId, runId, wUrl, wSecret, { wait_seconds: secs });
    throw Object.assign(err, { handled: true });
  }
  if (status === 400 || msg.includes('invalid') || msg.includes('bad number') ||
      msg.includes('not valid') || msg.includes('unknown number')) {
    await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                  { reason: `WA rejected number: ${err.message}` });
    throw Object.assign(err, { handled: true });
  }
  if (status === 403 || msg.includes('banned') || msg.includes('block')) {
    await webhook('banned', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  // Generic fallback
  await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                { reason: `OTP request failed: ${err.message}` });
  throw Object.assign(err, { handled: true });
}

async function handleRegisterError(err, phone, userId, runId, wUrl, wSecret) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.output?.statusCode || err?.status || 0;

  if (status === 401 || msg.includes('wrong') || msg.includes('incorrect') ||
      msg.includes('invalid code') || msg.includes('bad code')) {
    await webhook('otp_error', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  if (status === 403 || msg.includes('banned')) {
    await webhook('banned', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  if (msg.includes('too many') || status === 429) {
    const secs = parseWaitSeconds(err.message) || 600;
    await webhook('rate_limited', phone, userId, runId, wUrl, wSecret, { wait_seconds: secs });
    throw Object.assign(err, { handled: true });
  }
  await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                { reason: `OTP submission failed: ${err.message}` });
  throw Object.assign(err, { handled: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

/** Wait for the Baileys socket to reach 'open' state. */
function waitForOpen(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Baileys socket did not open within timeout')),
      timeoutMs
    );

    // Already open
    if (sock.ws?.readyState === 1 /* OPEN */) {
      clearTimeout(timer);
      return resolve();
    }

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        clearTimeout(timer);
        resolve();
      } else if (connection === 'close') {
        clearTimeout(timer);
        const reason = lastDisconnect?.error?.message || 'unknown';
        reject(new Error(`Connection closed before open: ${reason}`));
      }
    });
  });
}

/** Save credentials and read back the full session directory as a JSON blob. */
async function captureSession(sessionDir, saveCreds) {
  await saveCreds();
  const data = {};
  try {
    for (const file of fs.readdirSync(sessionDir)) {
      const raw = fs.readFileSync(`${sessionDir}/${file}`, 'utf8');
      try { data[file] = JSON.parse(raw); }
      catch (_) { data[file] = raw; }
    }
  } catch (_) {}
  return data;
}

/** Close socket and remove tmp session directory. */
async function cleanupSocket(sock, sessionDir) {
  try { sock.ws?.close(); } catch (_) {}
  try { sock.end?.(); } catch (_) {}
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
}

/** Poll GET /otp/{phone} until a 6-digit code arrives or timeout. */
async function pollForOTP(url, secret) {
  const deadline = Date.now() + OTP_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(OTP_POLL_INTERVAL);
    try {
      const code = await httpGet(url, secret);
      if (code && /^\d{6}$/.test(code.trim())) {
        return code.trim();
      }
    } catch (_) {}
    const rem = Math.round((deadline - Date.now()) / 1000);
    log(`OTP not ready — ${rem}s remaining`);
  }
  return null;
}

/** Parse "try again in X minutes/hours/seconds" from an error message. */
function parseWaitSeconds(msg = '') {
  const m = msg.match(/(\d+)\s*(second|minute|hour)/i);
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u.startsWith('hour'))   return v * 3600;
  if (u.startsWith('minute')) return v * 60;
  return v;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function log(msg) {
  console.log(`[BAILEYS][${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function httpGet(urlStr, secret) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib    = isHttps ? https : http;
    const req    = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname,
        method:   'GET',
        headers:  { 'X-Webhook-Secret': secret },
      },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => res.statusCode === 200 ? resolve(data.trim()) : resolve(null));
      }
    );
    req.on('error', reject);
    req.setTimeout(12_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function webhook(event, phone, userId, runId, url, secret, extra = {}) {
  const body = JSON.stringify({
    event,
    phone_number:      phone,
    telegram_user_id:  parseInt(userId, 10) || 0,
    run_id:            runId,
    ...extra,
  });
  log(`→ webhook: ${event}`);
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch (_) { return resolve(0); }
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const req     = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (isHttps ? 443 : 80),
        path:     parsed.pathname,
        method:   'POST',
        headers: {
          'Content-Type':     'application/json',
          'Content-Length':   Buffer.byteLength(body),
          'X-Webhook-Secret': secret,
        },
      },
      (res) => { res.resume(); log(`← webhook ${event}: HTTP ${res.statusCode}`); resolve(res.statusCode); }
    );
    req.on('error', (e) => { log(`webhook error: ${e.message}`); resolve(0); });
    req.setTimeout(20_000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

module.exports = { registerWithBaileys };
