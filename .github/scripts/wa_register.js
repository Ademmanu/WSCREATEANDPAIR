/**
 * wa_register.js — WhatsApp registration automation via ADB
 *
 * Runs inside GitHub Actions after the Android emulator boots.
 * Installs WhatsApp, navigates the registration flow, requests OTP,
 * waits for the user to reply on Telegram, submits the OTP, and
 * reports the result back to the bot via webhook.
 *
 * Required env vars:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL,
 *   WEBHOOK_SECRET, GITHUB_RUN_ID
 */

'use strict';

const { execSync }  = require('child_process');
const { execFile }  = require('child_process');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');

// ── Config ────────────────────────────────────────────────────────────────────

const PHONE          = process.env.PHONE_NUMBER;
const USER_ID        = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID         = process.env.GITHUB_RUN_ID;
const RENDER_BASE    = WEBHOOK_URL.replace('/webhook/event', '');
const WA_PACKAGE     = 'com.whatsapp';
const APK_PATH       = '/tmp/whatsapp.apk';
const SCRIPT_DIR     = '/tmp/wa_scripts';

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// Write a shell script to disk and execute it.
// This avoids ALL quoting issues — the command is never interpolated.
function runScript(scriptContent, timeoutMs = 30000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `cmd_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${scriptContent}\n`, { mode: 0o755 });
  try {
    const out = execSync(`sh ${file}`, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (out || '').trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// Run an adb command (not adb shell — for host-side adb commands)
function adb(args, timeoutMs = 30000) {
  return runScript(`adb ${args} 2>&1`, timeoutMs);
}

// Run a command inside the Android emulator via adb shell
// cmd is written to a file — no shell escaping needed
function adbShell(cmd, timeoutMs = 30000) {
  const file = path.join(SCRIPT_DIR, `shell_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = runScript(`adb shell < ${file}`, timeoutMs);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

// ── ADB input helpers ─────────────────────────────────────────────────────────

function tap(x, y) {
  adbShell(`input tap ${x} ${y}`);
}

function swipe(x1, y1, x2, y2, durationMs = 300) {
  adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
}

function keyevent(code) {
  adbShell(`input keyevent ${code}`);
}

// Type text safely — write each char via keyevent to avoid encoding issues
function typeText(text) {
  // Use ADB text input — works for ASCII digits and letters
  // Write to a script so special chars don't get shell-interpreted
  const safe = text.replace(/[^a-zA-Z0-9+]/g, (c) => {
    // Encode non-alphanumeric chars for adb input text
    return encodeURIComponent(c).replace(/%/g, '%25');
  });
  adbShell(`input text "${safe}"`);
}

// Type digits individually via tap on the number (most reliable for OTP boxes)
function typeDigits(digits) {
  for (const d of digits) {
    adbShell(`input text ${d}`);
    runScript('sleep 0.2');
  }
}

// ── UI inspection ─────────────────────────────────────────────────────────────

// Dump UI hierarchy to XML and return it
// Retries until valid XML is returned or timeout
async function dumpUI(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    adbShell('uiautomator dump /sdcard/ui.xml');
    const xml = adbShell('cat /sdcard/ui.xml', 5000);
    if (xml && xml.includes('<hierarchy')) return xml;
    await sleep(1000);
  }
  return '';
}

// Return up to 15 visible text strings from current screen
async function screenTexts() {
  const xml = await dumpUI();
  const texts = [];
  const re = /text="([^"]{1,60})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t) texts.push(t);
  }
  return [...new Set(texts)].slice(0, 15);
}

async function logScreen(label = 'SCREEN') {
  const texts = await screenTexts();
  log(label, texts.join(' | ') || '(empty)');
  return texts;
}

// Wait until the screen contains a specific string
// Returns the full XML when found, null on timeout
async function waitForScreen(text, timeoutMs = 60000) {
  log('WAIT', `"${text}" (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (xml.toLowerCase().includes(text.toLowerCase())) {
      log('FOUND', `"${text}"`);
      return xml;
    }
    await sleep(2000);
  }
  log('TIMEOUT', `"${text}" not found`);
  return null;
}

// Wait for any one of multiple strings — returns { xml, matched }
async function waitForAny(texts, timeoutMs = 60000) {
  log('WAIT', `any of: ${texts.map(t => `"${t}"`).join(', ')} (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    for (const text of texts) {
      if (xml.toLowerCase().includes(text.toLowerCase())) {
        log('FOUND', `"${text}"`);
        return { xml, matched: text };
      }
    }
    await sleep(2000);
  }
  log('TIMEOUT', `none of [${texts.join(', ')}] found`);
  return { xml: '', matched: null };
}

// Find element bounds by text and tap it
async function tapElement(text, xml = null) {
  if (!xml) xml = await dumpUI();
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'),
    new RegExp(`content-desc="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) {
      const cx = Math.round((+m[1] + +m[3]) / 2);
      const cy = Math.round((+m[2] + +m[4]) / 2);
      log('TAP', `"${text}" → (${cx},${cy})`);
      tap(cx, cy);
      await sleep(800);
      return true;
    }
  }
  log('TAP', `"${text}" bounds not found — skipping`);
  return false;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

function webhook(event, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id: RUN_ID,
      ...extra,
    });
    const u = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      log('WEBHOOK', `${event} → HTTP ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', (e) => {
      log('WEBHOOK', `${event} ERROR: ${e.message}`);
      resolve(0);
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── OTP polling ───────────────────────────────────────────────────────────────

// Poll the bot's /otp/{phone} endpoint until the user replies on Telegram
async function pollForOtp(timeoutMs = 13 * 60 * 1000) {
  const otpUrl = `${RENDER_BASE}/otp/${encodeURIComponent(PHONE)}`;
  const deadline = Date.now() + timeoutMs;
  log('OTP', `Polling ${otpUrl} for up to ${timeoutMs / 60000} min...`);
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const otp = await httpGet(otpUrl, { 'X-Webhook-Secret': WEBHOOK_SECRET });
      if (otp && /^\d{6}$/.test(otp)) {
        log('OTP', `Received: ${otp}`);
        return otp;
      }
    } catch (_) {}
  }
  log('OTP', 'Timed out waiting for user reply');
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve(res.statusCode === 200 ? data.trim() : null));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Parse WhatsApp wait time strings ─────────────────────────────────────────

function parseWaitSeconds(text) {
  let total = 0;
  const h = text.match(/(\d+)\s*hour/i);
  const m = text.match(/(\d+)\s*min/i);
  const s = text.match(/(\d+)\s*sec/i);
  if (h) total += parseInt(h[1]) * 3600;
  if (m) total += parseInt(m[1]) * 60;
  if (s) total += parseInt(s[1]);
  return total > 0 ? total : 600;
}

// ── APK install ───────────────────────────────────────────────────────────────

async function installWhatsApp() {
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`APK not found at ${APK_PATH}`);
  }
  const sizeMB = (fs.statSync(APK_PATH).size / 1024 / 1024).toFixed(1);
  log('INSTALL', `APK size: ${sizeMB} MB`);

  // Show which native lib folders the APK contains
  const libScript = `unzip -l ${APK_PATH} | grep -E "^[[:space:]]+[0-9]" | awk '{print $4}' | grep "^lib/" | cut -d/ -f1-2 | sort -u`;
  fs.writeFileSync('/tmp/libcheck.sh', libScript);
  const libs = runScript('sh /tmp/libcheck.sh 2>/dev/null', 15000);
  log('INSTALL', `APK lib folders:\n${libs || '  (none — pure Java APK)'}`);

  // ADB needs a moment after boot
  await sleep(2000);

  const strategies = [
    `adb install -r -t -g ${APK_PATH}`,
    `adb install -r -t -g --abi x86_64 ${APK_PATH}`,
    `adb install -r -t -g --abi x86 ${APK_PATH}`,
  ];

  for (const [i, cmd] of strategies.entries()) {
    log('INSTALL', `Attempt ${i + 1}: ${cmd}`);
    const out = runScript(`${cmd} 2>&1`, 300000);
    log('INSTALL', `Output: ${out}`);

    if (out.toLowerCase().includes('success')) {
      log('INSTALL', 'Success');
      return;
    }

    if (out.includes('INSTALL_FAILED_NO_MATCHING_ABIS') && i === strategies.length - 1) {
      throw new Error('APK has no compatible native libs for this emulator. Upload the x86 or universal variant.');
    }

    if (out.includes('INSTALL_FAILED') && !out.includes('INSTALL_FAILED_NO_MATCHING_ABIS')) {
      throw new Error(`Install failed: ${out}`);
    }
  }

  // Final fallback — check pm list in case install succeeded without printing "Success"
  await sleep(3000);
  const installed = runScript('adb shell pm list packages 2>/dev/null | grep com.whatsapp', 10000);
  if (installed.includes('com.whatsapp')) {
    log('INSTALL', 'Verified via pm list');
    return;
  }

  throw new Error('WhatsApp failed to install after all attempts');
}

// ── Screen unlock ─────────────────────────────────────────────────────────────

async function unlockScreen() {
  log('UNLOCK', 'Waking and unlocking screen...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);  // Swipe up to unlock
  await sleep(500);
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  // Keep screen on for the full session
  adbShell('settings put global stay_on_while_plugged_in 3');
  adbShell('settings put secure lockscreen.disabled 1');
  await logScreen('UNLOCK');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('MAIN', `Starting registration for ${PHONE}`);

  // ── 1. Verify emulator is ready ─────────────────────────────────────────
  await sleep(3000);
  const bootProp = adbShell('getprop sys.boot_completed');
  if (bootProp.trim() !== '1') {
    throw new Error(`Emulator not ready — boot_completed=${bootProp}`);
  }
  log('MAIN', 'Emulator ready');

  // ── 2. Unlock screen ────────────────────────────────────────────────────
  await unlockScreen();

  // ── 3. Install WhatsApp ──────────────────────────────────────────────────
  await installWhatsApp();
  log('MAIN', 'WhatsApp installed');

  // ── 4. Launch WhatsApp ───────────────────────────────────────────────────
  log('MAIN', 'Launching WhatsApp...');
  keyevent('KEYCODE_HOME');
  await sleep(500);
  adbShell(`am start -n ${WA_PACKAGE}/${WA_PACKAGE}.Main`);
  await sleep(5000);
  await logScreen('LAUNCH');

  // ── 5. Accept terms ──────────────────────────────────────────────────────
  const agreeResult = await waitForAny(
    ['AGREE AND CONTINUE', 'Agree and continue', 'Accept', 'I agree', 'AGREE'],
    20000
  );
  if (agreeResult.matched) {
    await tapElement(agreeResult.matched, agreeResult.xml);
    await sleep(3000);
    await logScreen('POST-AGREE');
  }

  // ── 6. Phone number entry ────────────────────────────────────────────────
  log('MAIN', 'Waiting for phone number screen...');
  const phoneResult = await waitForAny([
    'Enter your phone number',
    'Your phone number',
    'Phone number',
    'phone number',
    'Country',
    'country code',
  ], 60000);

  if (!phoneResult.matched) {
    await logScreen('ERROR');
    await webhook('bad_number', { reason: 'Phone entry screen not found' });
    process.exit(0);
  }

  log('MAIN', `Phone screen found: "${phoneResult.matched}"`);
  await sleep(1000);

  // Clear any pre-filled field and enter the number
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  typeText(PHONE);
  await sleep(1000);
  await logScreen('AFTER-TYPE');

  // Tap Next
  const nextResult = await waitForAny(['Next', 'NEXT', 'Done', 'Continue'], 10000);
  if (nextResult.matched) {
    await tapElement(nextResult.matched, nextResult.xml);
  } else {
    // Fallback — tap top-right corner where Next usually is on Pixel 4
    log('MAIN', 'Next button not found — tapping coordinate fallback');
    tap(978, 184);
  }
  await sleep(4000);
  await logScreen('AFTER-NEXT');

  // ── 7. Check post-Next screen ────────────────────────────────────────────
  const postNext = await dumpUI();
  const postNextLower = postNext.toLowerCase();

  if (postNextLower.includes('try again') || postNextLower.includes('wait')) {
    const secs = parseWaitSeconds(postNext);
    log('MAIN', `Rate limited — ${secs}s`);
    await webhook('rate_limited', { wait_seconds: secs });
    process.exit(0);
  }

  if (postNextLower.includes('not a valid') || postNextLower.includes('invalid') ||
      postNextLower.includes('enter a valid')) {
    await webhook('bad_number', { reason: 'WhatsApp: invalid phone number' });
    process.exit(0);
  }

  if (postNextLower.includes('already have an account') ||
      postNextLower.includes('welcome back')) {
    await webhook('already_registered');
    process.exit(0);
  }

  // ── 8. Confirm SMS send ──────────────────────────────────────────────────
  // WhatsApp shows a dialog confirming the number before sending OTP
  const confirmResult = await waitForAny(['OK', 'Send SMS', 'SEND SMS', 'Yes', 'Confirm'], 15000);
  if (confirmResult.matched) {
    log('MAIN', `Confirming: "${confirmResult.matched}"`);
    await tapElement(confirmResult.matched, confirmResult.xml);
    await sleep(3000);
  }

  // ── 9. Wait for OTP screen ───────────────────────────────────────────────
  log('MAIN', 'Waiting for OTP screen...');
  const otpScreenResult = await waitForAny([
    'Enter the 6-digit code',
    'Enter code',
    'Verifying',
    'Didn\'t receive',
    'Resend SMS',
    'resend',
    'code sent',
  ], 45000);

  if (!otpScreenResult.matched) {
    await logScreen('ERROR');
    await webhook('bad_number', { reason: 'OTP screen not reached' });
    process.exit(0);
  }

  log('MAIN', `OTP screen: "${otpScreenResult.matched}"`);

  // ── 10. Notify bot OTP was sent ──────────────────────────────────────────
  await webhook('otp_requested');
  log('MAIN', 'Notified bot — waiting for OTP from Telegram user...');

  // ── 11. Poll for OTP ─────────────────────────────────────────────────────
  const otp = await pollForOtp();
  if (!otp) {
    log('MAIN', 'OTP wait timed out');
    process.exit(0);
  }

  log('MAIN', `Submitting OTP: ${otp}`);

  // Clear any partial entry then type digit by digit
  keyevent('KEYCODE_CTRL_A');
  await sleep(300);
  keyevent('KEYCODE_DEL');
  await sleep(300);
  typeDigits(otp);
  await sleep(5000);

  // ── 12. Check OTP result ─────────────────────────────────────────────────
  const resultXml = await dumpUI();
  const resultLower = resultXml.toLowerCase();
  await logScreen('OTP-RESULT');

  if (resultLower.includes('wrong code') || resultLower.includes('incorrect') ||
      resultLower.includes('invalid code')) {
    await webhook('otp_error');
    process.exit(0);
  }

  if (resultLower.includes('two-step') || resultLower.includes('passkey') ||
      resultLower.includes('fingerprint') || resultLower.includes('2fa')) {
    await webhook('bad_number', { reason: '2FA or passkey required' });
    process.exit(0);
  }

  // ── 13. Skip optional post-registration screens ──────────────────────────
  for (let i = 0; i < 6; i++) {
    const skipResult = await waitForAny(
      ['Skip', 'SKIP', 'Not now', 'Continue', 'Allow', 'Later', 'OK'],
      5000
    );
    if (!skipResult.matched) break;
    await tapElement(skipResult.matched, skipResult.xml);
    await sleep(1500);
  }

  // ── 14. Done ─────────────────────────────────────────────────────────────
  await webhook('registered');
  log('MAIN', `${PHONE} registered successfully`);
  process.exit(0);
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('ERROR', err.message);
  log('ERROR', err.stack);
  await webhook('bad_number', { reason: `Script error: ${err.message}` });
  process.exit(0); // exit 0 — bot already notified, skip if:failure() step
});
