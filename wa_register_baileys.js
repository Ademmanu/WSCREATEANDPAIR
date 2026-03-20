'use strict';

/**
 * wa_register_baileys.js
 * Registers a WhatsApp account via Baileys mobile protocol.
 * No emulator. No ADB. No GitHub Actions. Pure Node.js.
 */

const fs    = require('fs');
const https = require('https');
const http  = require('http');

const OTP_POLL_INTERVAL = 5_000;
const OTP_TIMEOUT       = 14 * 60_000;
const CONNECT_TIMEOUT   = 30_000;

// ══════════════════════════════════════════════════════════════════════════════
// Logging  — every line is prefixed so you can grep "BAILEYS" in Render logs
// ══════════════════════════════════════════════════════════════════════════════

function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  process.stdout.write(`[BAILEYS ${t}] ${msg}\n`);
}

function step(n, total, msg) {
  process.stdout.write(`[BAILEYS STEP ${n}/${total}] ▶  ${msg}\n`);
}

function ok(msg) {
  process.stdout.write(`[BAILEYS ✓] ${msg}\n`);
}

function fail(msg) {
  process.stdout.write(`[BAILEYS ✗] ${msg}\n`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Main export
// ══════════════════════════════════════════════════════════════════════════════

async function registerWithBaileys({
  phone,
  webhookUrl,
  webhookSecret,
  telegramUserId,
  runId = '',
}) {
  let Baileys;
  try {
    Baileys = require('@whiskeysockets/baileys');
  } catch (e) {
    throw new Error('Baileys not installed. Run: npm install @whiskeysockets/baileys');
  }

  let pino;
  try { pino = require('pino'); }
  catch (_) { pino = () => ({ level: 'silent', child: () => ({}) }); }

  const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
  } = Baileys;

  log('════════════════════════════════════════════════');
  log(`  NEW REGISTRATION REQUEST`);
  log(`  Phone   : +${phone}`);
  log(`  Webhook : ${webhookUrl}`);
  log('════════════════════════════════════════════════');

  const logger     = pino({ level: 'silent' });
  const sessionDir = `/tmp/wa-reg-${phone}`;

  // Clean slate
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(sessionDir, { recursive: true });

  // ── Step 1: Fetch latest WA version ──────────────────────────────────────
  step(1, 5, 'Fetching latest WhatsApp version from WA servers...');
  const { version } = await fetchLatestBaileysVersion();
  ok(`WhatsApp version: ${version.join('.')}`);

  // ── Step 2: Create auth state + open socket ───────────────────────────────
  step(2, 5, 'Opening Baileys mobile socket...');
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    version,
    logger,
    mobile: true,
    auth: {
      creds: state.creds,
      keys:  makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal:   false,
    syncFullHistory:     false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  await waitForOpen(sock, CONNECT_TIMEOUT);
  ok('Socket connected to WhatsApp servers');

  // Already registered?
  if (sock.authState.creds.registered) {
    ok(`+${phone} is already registered — notifying bot`);
    const sessionData = await captureSession(sessionDir, saveCreds);
    await webhook('registered', phone, telegramUserId, runId, webhookUrl, webhookSecret,
                  { session_data: sessionData });
    await cleanupSocket(sock, sessionDir);
    return { success: true, sessionData };
  }

  // ── Step 3: Request SMS OTP ───────────────────────────────────────────────
  step(3, 5, `Requesting SMS verification code for +${phone}...`);
  try {
    await sock.requestRegistrationCode({
      phoneNumber: `+${phone}`,
      method:      'sms',
    });
  } catch (err) {
    fail(`WA rejected OTP request: ${err.message}`);
    await cleanupSocket(sock, sessionDir);
    return handleRequestError(err, phone, telegramUserId, runId, webhookUrl, webhookSecret);
  }
  ok(`SMS code requested — WhatsApp accepted +${phone} as valid`);

  // Notify Telegram bot so user knows to check their SMS
  await webhook('otp_requested', phone, telegramUserId, runId, webhookUrl, webhookSecret);
  log(`Bot notified — waiting for user to reply with SMS code on Telegram`);

  // ── Step 4: Poll for OTP ──────────────────────────────────────────────────
  step(4, 5, 'Polling for OTP from Telegram user (up to 14 min)...');
  const otpBase = webhookUrl.replace(/\/webhook\/event.*$/, '');
  const otpUrl  = `${otpBase}/otp/${phone}`;
  log(`Polling: ${otpUrl}`);

  const otp = await pollForOTP(otpUrl, webhookSecret, phone);

  if (!otp) {
    fail(`OTP timeout — user did not reply within 14 minutes for +${phone}`);
    await cleanupSocket(sock, sessionDir);
    throw new Error(`OTP timeout for +${phone}`);
  }
  ok(`OTP received from Telegram: ${otp}`);

  // ── Step 5: Submit OTP to WhatsApp ────────────────────────────────────────
  step(5, 5, `Submitting OTP ${otp} to WhatsApp for +${phone}...`);
  try {
    await sock.register(otp.trim());
  } catch (err) {
    fail(`OTP submission failed: ${err.message}`);
    await cleanupSocket(sock, sessionDir);
    return handleRegisterError(err, phone, telegramUserId, runId, webhookUrl, webhookSecret);
  }

  ok(`════════════════════════════════════════════════`);
  ok(`  REGISTRATION COMPLETE for +${phone}`);
  ok(`════════════════════════════════════════════════`);

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
  const msg    = (err?.message || '').toLowerCase();
  const status = err?.output?.statusCode || err?.status || 0;

  if (status === 429 || msg.includes('too many') || msg.includes('rate')) {
    const secs = parseWaitSeconds(err.message) || 600;
    log(`Rate limited for +${phone} — wait ${secs}s`);
    await webhook('rate_limited', phone, userId, runId, wUrl, wSecret, { wait_seconds: secs });
    throw Object.assign(err, { handled: true });
  }
  if (status === 400 || msg.includes('invalid') || msg.includes('bad number') ||
      msg.includes('not valid') || msg.includes('unknown number')) {
    log(`Bad number: +${phone} — ${err.message}`);
    await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                  { reason: `WA rejected number: ${err.message}` });
    throw Object.assign(err, { handled: true });
  }
  if (status === 403 || msg.includes('banned') || msg.includes('block')) {
    log(`Banned: +${phone}`);
    await webhook('banned', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  log(`Unknown OTP request error for +${phone}: ${err.message}`);
  await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                { reason: `OTP request failed: ${err.message}` });
  throw Object.assign(err, { handled: true });
}

async function handleRegisterError(err, phone, userId, runId, wUrl, wSecret) {
  const msg    = (err?.message || '').toLowerCase();
  const status = err?.output?.statusCode || err?.status || 0;

  if (status === 401 || msg.includes('wrong') || msg.includes('incorrect') ||
      msg.includes('invalid code') || msg.includes('bad code')) {
    log(`Wrong OTP for +${phone}`);
    await webhook('otp_error', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  if (status === 403 || msg.includes('banned')) {
    log(`Banned after OTP: +${phone}`);
    await webhook('banned', phone, userId, runId, wUrl, wSecret);
    throw Object.assign(err, { handled: true });
  }
  if (msg.includes('too many') || status === 429) {
    const secs = parseWaitSeconds(err.message) || 600;
    await webhook('rate_limited', phone, userId, runId, wUrl, wSecret, { wait_seconds: secs });
    throw Object.assign(err, { handled: true });
  }
  log(`Unknown OTP submission error for +${phone}: ${err.message}`);
  await webhook('bad_number', phone, userId, runId, wUrl, wSecret,
                { reason: `OTP submission failed: ${err.message}` });
  throw Object.assign(err, { handled: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════════════

function waitForOpen(sock, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Baileys socket did not open within timeout')),
      timeoutMs
    );
    if (sock.ws?.readyState === 1) { clearTimeout(timer); return resolve(); }
    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') { clearTimeout(timer); resolve(); }
      else if (connection === 'close') {
        clearTimeout(timer);
        reject(new Error(`Connection closed: ${lastDisconnect?.error?.message || 'unknown'}`));
      }
    });
  });
}

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

async function cleanupSocket(sock, sessionDir) {
  try { sock.ws?.close(); } catch (_) {}
  try { sock.end?.(); } catch (_) {}
  try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
}

async function pollForOTP(url, secret, phone) {
  const deadline = Date.now() + OTP_TIMEOUT;
  let attempt = 0;
  while (Date.now() < deadline) {
    await sleep(OTP_POLL_INTERVAL);
    attempt++;
    try {
      const code = await httpGet(url, secret);
      if (code && /^\d{6}$/.test(code.trim())) {
        return code.trim();
      }
    } catch (_) {}
    const rem = Math.round((deadline - Date.now()) / 1000);
    if (attempt % 6 === 0) { // log every 30 seconds
      log(`[+${phone}] Still waiting for OTP — ${rem}s left (attempt ${attempt})`);
    }
  }
  return null;
}

function parseWaitSeconds(msg = '') {
  const m = msg.match(/(\d+)\s*(second|minute|hour)/i);
  if (!m) return 0;
  const v = parseInt(m[1], 10);
  const u = m[2].toLowerCase();
  if (u.startsWith('hour'))   return v * 3600;
  if (u.startsWith('minute')) return v * 60;
  return v;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(urlStr, secret) {
  return new Promise((resolve, reject) => {
    const url     = new URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const req     = lib.request(
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
    phone_number:     phone,
    telegram_user_id: parseInt(userId, 10) || 0,
    run_id:           runId,
    ...extra,
  });
  log(`→ webhook [${event}] for +${phone}`);
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
      (res) => {
        res.resume();
        log(`← webhook [${event}] response: HTTP ${res.statusCode}`);
        resolve(res.statusCode);
      }
    );
    req.on('error', (e) => { fail(`webhook [${event}] error: ${e.message}`); resolve(0); });
    req.setTimeout(20_000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

module.exports = { registerWithBaileys };
