/**
 * wa_register.js
 * Runs INSIDE GitHub Actions after the Android emulator is booted.
 * Uses ADB + UIAutomator2 to drive WhatsApp through the registration flow.
 *
 * Environment variables injected by the workflow:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL, WEBHOOK_SECRET,
 *   GITHUB_RUN_ID, NODE_PORT
 *
 * Flow:
 *  1. Download + install WhatsApp APK
 *  2. Launch WhatsApp
 *  3. Navigate to phone number entry screen
 *  4. Enter phone number → tap Next
 *  5. Wait for "Send SMS" / "Call me" dialog → tap Send SMS
 *  6. Callback → otp_requested
 *  7. Poll for OTP from bot.py internal endpoint (bot writes it after user replies)
 *  8. Enter OTP → tap Next
 *  9. Callback → registered / otp_error / bad_number
 */

'use strict';

const { execSync, exec } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PHONE = process.env.PHONE_NUMBER;
const USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID = process.env.GITHUB_RUN_ID;

// WhatsApp APK is downloaded by the workflow before the emulator boots.
// See .github/workflows/register.yml — "Download WhatsApp APK" step.
const WA_PACKAGE = 'com.whatsapp';

const WAIT_MS = (ms) => new Promise(r => setTimeout(r, ms));

// ── ADB helpers ───────────────────────────────────────────────────────────────

function adb(cmd, timeout = 30000) {
  return execSync(`adb ${cmd}`, { timeout, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
}

function adbShell(cmd, timeout = 30000) {
  return adb(`shell "${cmd.replace(/"/g, '\\"')}"`, timeout);
}

// Tap by coordinates
function tap(x, y) { adbShell(`input tap ${x} ${y}`); }

// Type text (URL-encode spaces)
function typeText(text) {
  const escaped = text.replace(/ /g, '%s').replace(/&/g, '\\&');
  adbShell(`input text '${escaped}'`);
}

// Wait for a UI element containing text (using uiautomator)
async function waitForText(text, timeoutMs = 60000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const dump = adbShell('uiautomator dump /dev/stdout 2>/dev/null', 5000);
      if (dump.includes(text)) return true;
    } catch (_) {}
    await WAIT_MS(intervalMs);
  }
  return false;
}

// Find element by text and tap it
async function tapText(text, timeoutMs = 30000) {
  const found = await waitForText(text, timeoutMs);
  if (!found) throw new Error(`Element "${text}" not found`);
  // Use am broadcast trick via uiautomator2 for reliable taps
  adbShell(
    `am broadcast -a com.example.CLICK --es text "${text}" 2>/dev/null || true`
  );
  // Fallback: use the coordinates from UI dump
  const dump = adbShell('uiautomator dump /sdcard/dump.xml && cat /sdcard/dump.xml', 8000);
  const match = dump.match(new RegExp(
    `text="${text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`
  ));
  if (match) {
    const cx = Math.round((parseInt(match[1]) + parseInt(match[3])) / 2);
    const cy = Math.round((parseInt(match[2]) + parseInt(match[4])) / 2);
    tap(cx, cy);
    return true;
  }
  return false;
}

// ── Webhook caller ────────────────────────────────────────────────────────────

function sendWebhook(event, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id: RUN_ID,
      ...extra,
    });
    const url = new URL(WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      console.log(`[WEBHOOK] ${event} → ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', (e) => {
      console.error(`[WEBHOOK] ${event} error:`, e.message);
      resolve(0);
    });
    req.write(body);
    req.end();
  });
}

// ── Poll for OTP from bot (bot stores it after user Telegram reply) ───────────

async function pollForOtp(timeoutMs = 13 * 60 * 1000) {
  // Bot writes OTP to its internal /otp endpoint which the session_manager
  // stores in pendingOtps map. We poll the GitHub Actions artifact store
  // via a simple HTTP server we spin up, but since the emulator is isolated
  // we instead use a shared artifact file approach.
  //
  // Approach: bot.py writes OTP to a GitHub Actions variable via REST API.
  // Here we poll the GitHub API for an environment variable update.
  // Simpler: bot.py writes to a known URL we host on our Render service.
  //
  // Implementation: We poll GET {RENDER_URL}/otp/{phone} every 5s.
  // bot.py exposes this endpoint and returns the OTP once the user replies.

  const renderBase = WEBHOOK_URL.replace('/webhook/event', '');
  const otpUrl = `${renderBase}/otp/${PHONE}`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await WAIT_MS(5000);
    try {
      const otp = await httpGet(otpUrl, { 'X-Webhook-Secret': WEBHOOK_SECRET });
      if (otp && /^\d{6}$/.test(otp.trim())) {
        return otp.trim();
      }
    } catch (_) {}
  }
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data.trim());
        else resolve(null);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Parse wait time from WhatsApp error screens ───────────────────────────────

function parseWaitSeconds(text) {
  // "Try again in X hours Y minutes" / "in X minutes" / "in X seconds"
  let total = 0;
  const h = text.match(/(\d+)\s*hour/i);
  const m = text.match(/(\d+)\s*min/i);
  const s = text.match(/(\d+)\s*sec/i);
  if (h) total += parseInt(h[1]) * 3600;
  if (m) total += parseInt(m[1]) * 60;
  if (s) total += parseInt(s[1]);
  return total > 0 ? total : 600;
}

// ── Main registration flow ────────────────────────────────────────────────────

async function installWhatsApp() {
  // APK was already downloaded by the workflow step before the emulator booted.
  // It lives at /tmp/whatsapp.apk — just install it directly.
  const apkPath = '/tmp/whatsapp.apk';

  const { existsSync, statSync } = require('fs');
  if (!existsSync(apkPath)) {
    throw new Error('WhatsApp APK not found at /tmp/whatsapp.apk — download step may have failed');
  }

  const size = statSync(apkPath).size;
  console.log(`[SETUP] Installing WhatsApp APK (${(size / 1024 / 1024).toFixed(1)} MB)...`);
  adb('install -r /tmp/whatsapp.apk', 120000);
  console.log('[SETUP] WhatsApp installed successfully');
}

async function launchWhatsApp() {
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1`);
  await WAIT_MS(4000);
}

async function main() {
  try {
    console.log(`[MAIN] Starting registration for ${PHONE}`);

    // Boot check
    let booted = false;
    for (let i = 0; i < 30; i++) {
      try {
        const prop = adbShell('getprop sys.boot_completed', 5000);
        if (prop.trim() === '1') { booted = true; break; }
      } catch (_) {}
      await WAIT_MS(5000);
    }
    if (!booted) throw new Error('Emulator did not boot in time');

    await installWhatsApp();
    await launchWhatsApp();

    // ── Agree to Terms ────────────────────────────────────────────────────
    const agreedFound = await waitForText('AGREE AND CONTINUE', 30000);
    if (agreedFound) await tapText('AGREE AND CONTINUE');
    await WAIT_MS(2000);

    // ── Phone number entry screen ─────────────────────────────────────────
    const phoneScreenFound = await waitForText('Enter your phone number', 30000);
    if (!phoneScreenFound) {
      await sendWebhook('bad_number', { reason: 'Phone entry screen not found' });
      process.exit(1);
    }

    // Clear country code field and select correct country
    // Country code is derived from phone number prefix
    // For now tap the phone number field and type full number
    const fieldFound = await waitForText('Phone number', 10000);
    if (!fieldFound) {
      await sendWebhook('bad_number', { reason: 'Phone number field not found' });
      process.exit(1);
    }

    // Tap phone number field
    await tapText('Phone number');
    await WAIT_MS(500);

    // Clear existing and type number (without country code if field is separate)
    adbShell('input keyevent KEYCODE_CTRL_A');
    adbShell('input keyevent KEYCODE_DEL');
    typeText(PHONE);
    await WAIT_MS(500);

    // Tap Next
    await tapText('Next');
    await WAIT_MS(3000);

    // ── Check for rate limit / error screens ──────────────────────────────
    const dumpAfterNext = adbShell('uiautomator dump /sdcard/d.xml && cat /sdcard/d.xml', 8000);

    if (dumpAfterNext.includes('Try again') || dumpAfterNext.includes('wait')) {
      const secs = parseWaitSeconds(dumpAfterNext);
      await sendWebhook('rate_limited', { wait_seconds: secs });
      process.exit(0);
    }

    if (dumpAfterNext.includes('not a valid phone number') ||
        dumpAfterNext.includes('Invalid phone number')) {
      await sendWebhook('bad_number', { reason: 'WhatsApp: invalid phone number' });
      process.exit(0);
    }

    // ── Already registered check ──────────────────────────────────────────
    if (dumpAfterNext.includes('already have an account') ||
        dumpAfterNext.includes('registered')) {
      await sendWebhook('already_registered');
      process.exit(0);
    }

    // ── SMS / Call dialog ─────────────────────────────────────────────────
    const smsDialogFound = await waitForText('Send SMS', 30000);
    if (!smsDialogFound) {
      await sendWebhook('bad_number', { reason: 'SMS dialog not found' });
      process.exit(1);
    }

    await tapText('Send SMS');
    await WAIT_MS(2000);

    // ── Notify bot OTP was triggered ──────────────────────────────────────
    await sendWebhook('otp_requested');
    console.log('[MAIN] OTP requested, waiting for user to reply on Telegram...');

    // ── Wait for OTP from Telegram user ───────────────────────────────────
    const otp = await pollForOtp();
    if (!otp) {
      // User did not reply — bot already handled the 15-min timeout message
      console.log('[MAIN] OTP timeout — exiting');
      process.exit(0);
    }

    console.log(`[MAIN] Got OTP: ${otp}`);

    // ── Enter OTP into WhatsApp ───────────────────────────────────────────
    // WhatsApp's OTP screen auto-fills from SMS; we manually enter it
    const otpScreenFound = await waitForText('Verifying', 10000) ||
                            await waitForText('Enter the 6-digit code', 10000);

    // WhatsApp may have 6 individual boxes or one field
    const dumpOtp = adbShell('uiautomator dump /sdcard/otp.xml && cat /sdcard/otp.xml', 8000);

    if (dumpOtp.includes('EditText')) {
      // Type digit by digit
      for (const digit of otp) {
        typeText(digit);
        await WAIT_MS(200);
      }
    } else {
      typeText(otp);
    }

    await WAIT_MS(3000);

    // ── Check result ──────────────────────────────────────────────────────
    const dumpResult = adbShell('uiautomator dump /sdcard/result.xml && cat /sdcard/result.xml', 8000);

    if (dumpResult.includes('Wrong code') || dumpResult.includes('incorrect')) {
      await sendWebhook('otp_error');
      // Keep waiting for a corrected OTP — the bot will notify the user
      // For simplicity in the CI flow, we exit and let the user restart
      process.exit(0);
    }

    if (dumpResult.includes('two-step verification') ||
        dumpResult.includes('passkey') ||
        dumpResult.includes('2FA') ||
        dumpResult.includes('fingerprint')) {
      await sendWebhook('bad_number', { reason: '2FA/passkey required' });
      process.exit(0);
    }

    // ── Skip optional profile/backup screens ─────────────────────────────
    for (const skipText of ['Skip', 'Not now', 'Continue', 'Allow']) {
      const found = await waitForText(skipText, 5000);
      if (found) {
        await tapText(skipText);
        await WAIT_MS(1000);
      }
    }

    // ── Success ───────────────────────────────────────────────────────────
    await sendWebhook('registered');
    console.log(`[MAIN] ${PHONE} registered successfully`);
    process.exit(0);

  } catch (err) {
    console.error('[MAIN] Fatal error:', err.message);
    await sendWebhook('bad_number', { reason: `Script error: ${err.message}` });
    process.exit(1);
  }
}

main();
