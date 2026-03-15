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
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

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

// ── Phone number parsing ──────────────────────────────────────────────────────

/**
 * Parse a full international number like "2348012345678" into:
 *   { countryCode: '234', nationalNumber: '8012345678', country: 'NG' }
 *
 * libphonenumber-js requires a + prefix for E.164 parsing.
 * We try with + prefix first, then brute-force country code matching
 * as a fallback for numbers the library can't auto-detect.
 */
function parsePhone(fullNumber) {
  const withPlus = `+${fullNumber}`;
  try {
    if (isValidPhoneNumber(withPlus)) {
      const parsed = parsePhoneNumber(withPlus);
      return {
        countryCode: String(parsed.countryCallingCode),
        nationalNumber: parsed.nationalNumber,
        country: parsed.country || 'unknown',
      };
    }
  } catch (_) {}

  // Fallback: try common country code lengths (1, 2, 3 digits)
  // Sorted by length descending so 3-digit codes match before 1-digit
  const cc3 = fullNumber.substring(0, 3);
  const cc2 = fullNumber.substring(0, 2);
  const cc1 = fullNumber.substring(0, 1);

  for (const cc of [cc3, cc2, cc1]) {
    try {
      const national = fullNumber.substring(cc.length);
      const attempt = `+${cc}${national}`;
      if (isValidPhoneNumber(attempt)) {
        const parsed = parsePhoneNumber(attempt);
        return {
          countryCode: String(parsed.countryCallingCode),
          nationalNumber: parsed.nationalNumber,
          country: parsed.country || 'unknown',
        };
      }
    } catch (_) {}
  }

  // Last resort: assume first 3 digits are country code
  return {
    countryCode: fullNumber.substring(0, 3),
    nationalNumber: fullNumber.substring(3),
    country: 'unknown',
  };
}

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

  // Strategy 1: push to device then install via pm — faster than adb install for large APKs
  // adb push streams at full speed, pm install is local on-device (no ADB overhead)
  log('INSTALL', 'Pushing APK to device...');
  const pushOut = runScript(`adb push ${APK_PATH} /data/local/tmp/whatsapp.apk 2>&1`, 600000);
  log('INSTALL', `Push output: ${pushOut}`);

  if (pushOut.toLowerCase().includes('error') && !pushOut.includes('pushed')) {
    log('INSTALL', 'Push failed — falling back to adb install...');
    const directOut = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
    log('INSTALL', `Direct install output: ${directOut}`);
    if (!directOut.toLowerCase().includes('success') && !directOut.includes('pushed')) {
      throw new Error(`Install failed: ${directOut}`);
    }
  } else {
    // Install from the on-device copy
    log('INSTALL', 'Installing from on-device copy...');
    const pmOut = runScript('adb shell pm install -r -t -g /data/local/tmp/whatsapp.apk 2>&1', 120000);
    log('INSTALL', `pm install output: ${pmOut}`);

    if (!pmOut.toLowerCase().includes('success')) {
      // Fallback: try adb install directly
      log('INSTALL', 'pm install failed — trying adb install directly...');
      const fallbackOut = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
      log('INSTALL', `Fallback output: ${fallbackOut}`);
      if (!fallbackOut.toLowerCase().includes('success')) {
        // Last check via pm list
        await sleep(3000);
        const pkgList = runScript('adb shell pm list packages 2>/dev/null', 10000);
        if (!pkgList.includes('com.whatsapp')) {
          throw new Error(`Install failed. pm: ${pmOut} | adb: ${fallbackOut}`);
        }
      }
    }
  }

  // Verify installation
  await sleep(2000);
  const pkgList = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList.includes('com.whatsapp')) {
    log('INSTALL', 'Verified via pm list — installed');
    return;
  }

  // One final check — sometimes pm list is slow to update
  await sleep(5000);
  const pkgList2 = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList2.includes('com.whatsapp')) {
    log('INSTALL', 'Verified via pm list (delayed) — installed');
    return;
  }

  throw new Error('WhatsApp package not found after install');
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

  // ── Parse phone number into country code + national number ───────────────
  const phoneInfo = parsePhone(PHONE);
  log('MAIN', `Parsed: country=${phoneInfo.country} cc=${phoneInfo.countryCode} national=${phoneInfo.nationalNumber}`);

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

  // ── 4. Grant permissions & Launch WhatsApp ──────────────────────────────
  log('MAIN', 'Granting permissions and launching WhatsApp...');

  keyevent('KEYCODE_HOME');
  await sleep(1000);

  const WA_PERMS = [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.CALL_PHONE',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_SMS',
    'android.permission.SEND_SMS',
    'android.permission.GET_ACCOUNTS',
  ];
  for (const perm of WA_PERMS) {
    adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  log('MAIN', 'Permissions granted');

  // ── Update Google Play Services via ADB ──────────────────────────────────
  // WhatsApp 2024+ requires GPS 22.x minimum. API 33 google_apis_playstore
  // ships with 22.x but we verify and attempt an update if needed.
  log('MAIN', 'Checking Google Play Services version...');
  const gpsVersion = adbShell('dumpsys package com.google.android.gms | grep versionName | head -1 2>/dev/null');
  log('MAIN', `GPS version: ${gpsVersion || 'unknown'}`);

  // Extract version number and check if update needed
  const gpsVerMatch = gpsVersion.match(/versionName=([\d.]+)/);
  const gpsMajor = gpsVerMatch ? parseInt(gpsVerMatch[1].split('.')[0]) : 0;
  log('MAIN', `GPS major version: ${gpsMajor}`);

  if (gpsMajor < 22) {
    log('MAIN', 'GPS too old — downloading and installing update via ADB...');
    // Download GPS APK from a reliable source
    // We use a specific version known to work with WhatsApp
    fs.writeFileSync('/tmp/dl_gps.sh', 'wget -q "https://dl.google.com/dl/android/studio/gps/gms_core.apk" -O /tmp/gps.apk --timeout=60 || true\\nstat -c%s /tmp/gps.apk 2>/dev/null || echo 0\\n');
    const gpsDownload = runScript('sh /tmp/dl_gps.sh', 90000);
    log('MAIN', `GPS download result: ${gpsDownload}`);

    const gpsSize = parseInt((gpsDownload.match(/^(\d+)$/m) || ['0'])[0]);
    if (gpsSize > 1000000) {
      const gpsInstall = runScript('adb install -r /tmp/gps.apk 2>&1', 120000);
      log('MAIN', `GPS install: ${gpsInstall}`);
      await sleep(5000);
    } else {
      log('MAIN', 'GPS download failed — proceeding anyway');
    }
  } else {
    log('MAIN', 'GPS version is sufficient — no update needed');
  }

  // monkey sends INTENT_ACTION_MAIN + CATEGORY_LAUNCHER — identical to tapping the icon
  // This is the most reliable foreground launch method on Android emulators
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
  log('MAIN', 'Launched via monkey — waiting 10s for WhatsApp to render...');
  await sleep(10000);
  await logScreen('LAUNCH');

  const launchTexts = await screenTexts();
  const isHomeScreen = launchTexts.some(t =>
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
     'Messages','Chrome','Camera'].some(w => t.includes(w))
  );
  const isCrashing = launchTexts.some(t => t.includes('keeps stopping'));

  if (isCrashing) {
    log('MAIN', 'Crash — dismissing, clearing data, relaunching...');
    const crashXml = await dumpUI();
    await tapElement('Close app', crashXml);
    await sleep(2000);
    adbShell(`pm clear ${WA_PACKAGE} 2>/dev/null || true`);
    await sleep(1000);
    for (const perm of WA_PERMS) {
      adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
    }
    adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
    await sleep(12000);
    await logScreen('AFTER-CLEAR');

  } else if (isHomeScreen) {
    log('MAIN', 'Still home screen — trying am start fallback...');
    adbShell(`am start -n ${WA_PACKAGE}/${WA_PACKAGE}.Main 2>/dev/null`);
    await sleep(8000);
    await logScreen('AFTER-AMSTART');
  }


  // ── 5. Dismiss system alerts then accept terms ───────────────────────────
  // google_apis emulators show "Alert / OK / More info" (Google Play Services
  // outdated) before WhatsApp renders. Tap OK up to 5 times to clear it.
  log('MAIN', 'Dismissing any system alert dialogs...');
  for (let i = 0; i < 5; i++) {
    const alertXml = await dumpUI(4000);
    if (alertXml.includes('Alert') || alertXml.includes('More info') ||
        alertXml.includes('Google Play') || alertXml.includes('Update')) {
      log('MAIN', `Alert dialog (attempt ${i+1}) — tapping OK`);
      const dismissed =
        await tapElement('OK', alertXml) ||
        await tapElement('Skip', alertXml) ||
        await tapElement('Not now', alertXml) ||
        await tapElement('Cancel', alertXml) ||
        await tapElement('Close', alertXml);
      if (!dismissed) tap(540, 1200); // fallback center tap
      await sleep(2000);
    } else {
      break;
    }
  }

  // Language screen arrow (newer WhatsApp versions)
  const langXml2 = await dumpUI(4000);
  if (langXml2.includes('Choose your language') || langXml2.includes('Welcome to WhatsApp')) {
    log('MAIN', 'Language screen — tapping arrow');
    const arrowTapped =
      await tapElement('next', langXml2) ||
      await tapElement('Next', langXml2) ||
      await tapElement('Continue', langXml2);
    if (!arrowTapped) tap(108, 2100);
    await sleep(3000);
  }

  const agreeResult = await waitForAny([
    'AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree',
  ], 30000);

  if (agreeResult.matched) {
    log('MAIN', `Agree screen: "${agreeResult.matched}"`);
    const agreeXml = await dumpUI();
    for (const btn of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree']) {
      if (agreeXml.includes(btn)) {
        await tapElement(btn, agreeXml);
        await sleep(4000);
        break;
      }
    }
    await logScreen('POST-AGREE');
  }


  // ── 6. Enter phone number ─────────────────────────────────────────────
  await logScreen('AFTER-AGREE-DONE');
  await sleep(2000);

  // Find and tap phone number input field
  let phoneInputXml = await dumpUI();
  const phoneFieldTapped = 
    await tapElement('Phone number', phoneInputXml) ||
    await tapElement(`+${phoneInfo.countryCode}`, phoneInputXml) ||
    await tapElement('Enter your phone number', phoneInputXml);

  if (!phoneFieldTapped) {
    log('MAIN', 'Phone field not found by text — using fallback tap');
    tap(650, 1200);
  }
  await sleep(1000);

  // Type the national number (without country code)
  log('MAIN', `Entering phone number: ${phoneInfo.nationalNumber}`);
  typeText(phoneInfo.nationalNumber);
  await sleep(2000);
  await logScreen('AFTER-NUMBER-ENTRY');

  // ── 7. Tap NEXT to request OTP ─────────────────────────────────────────
  const nextXml = await dumpUI();
  const nextTapped = 
    await tapElement('NEXT', nextXml) ||
    await tapElement('Next', nextXml);

  if (!nextTapped) {
    log('MAIN', 'NEXT button not found — trying fallback tap');
    tap(540, 1950);
  }
  await sleep(3000);

  // Handle "Is this OK?" confirmation
  const confirmXml = await dumpUI();
  const confirmTexts = await screenTexts();
  if (confirmTexts.some(t => t.includes('Is this OK?') || t.includes('correct'))) {
    log('MAIN', 'Confirming phone number');
    await tapElement('OK', confirmXml) || 
    await tapElement('Yes', confirmXml) ||
    tap(540, 1450);
    await sleep(3000);
  }

  // ── 8. Wait for OTP request screen ─────────────────────────────────────
  const otpScreenResult = await waitForAny([
    'Verifying',
    'Enter 6-digit code',
    'waiting to automatically detect',
    'Didn\'t get the code?',
    'Call me',
  ], 60000);

  if (!otpScreenResult.matched) {
    const errorTexts = await screenTexts();
    if (errorTexts.some(t => t.includes('already registered') || t.includes('already in use'))) {
      await webhook('bad_number', { reason: 'Phone number already registered' });
      throw new Error('Number already registered');
    }
    if (errorTexts.some(t => t.includes('Too many') || t.includes('try again later'))) {
      await webhook('rate_limited', { reason: 'Rate limited by WhatsApp' });
      throw new Error('Rate limited');
    }
    if (errorTexts.some(t => t.includes('invalid') || t.includes('not valid'))) {
      await webhook('bad_number', { reason: 'Invalid phone number' });
      throw new Error('Invalid number');
    }
    throw new Error('OTP screen did not appear after 60s');
  }

  log('MAIN', `OTP screen detected: "${otpScreenResult.matched}"`);
  await logScreen('OTP-SCREEN');

  await webhook('awaiting_otp', {
    message: `OTP requested for ${PHONE}`,
  });

  // ── 9. Poll for OTP from bot ───────────────────────────────────────────
  log('MAIN', 'Polling for OTP from bot...');

  const OTP_TIMEOUT = 15 * 60 * 1000;
  const otpDeadline = Date.now() + OTP_TIMEOUT;
  let otp = null;

  while (Date.now() < otpDeadline && !otp) {
    try {
      const url = `${RENDER_BASE}/internal/get-otp/${encodeURIComponent(PHONE)}`;
      
      await new Promise((resolve) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, {
          headers: { 
            'X-API-Key': WEBHOOK_SECRET,
            'Content-Type': 'application/json',
          },
          timeout: 5000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              if (parsed.otp) {
                otp = parsed.otp;
                log('MAIN', `Received OTP: ${otp}`);
              }
            } catch (e) {}
            resolve();
          });
        });
        req.on('error', () => resolve());
        req.on('timeout', () => { req.destroy(); resolve(); });
      });
    } catch (e) {
      log('POLL', `OTP check failed: ${e.message}`);
    }

    if (!otp) await sleep(3000);
  }

  if (!otp) {
    await webhook('timeout', { reason: 'OTP timeout' });
    throw new Error('OTP timeout');
  }

  // ── 10. Submit OTP ─────────────────────────────────────────────────────
  log('MAIN', `Submitting OTP: ${otp}`);

  const otpInputXml = await dumpUI();
  const singleFieldTapped = await tapElement('Enter 6-digit code', otpInputXml) ||
                            await tapElement('6-digit code', otpInputXml);
  
  if (singleFieldTapped) {
    await sleep(500);
    typeDigits(otp);
  } else {
    log('MAIN', 'Using multi-box OTP input');
    tap(200, 1200);
    await sleep(500);
    typeDigits(otp);
  }

  await sleep(8000);

  // ── 11. Check for errors ───────────────────────────────────────────────
  const afterOtpTexts = await screenTexts();
  
  if (afterOtpTexts.some(t => t.includes('wrong') || t.includes('incorrect') || t.includes('Invalid'))) {
    log('MAIN', 'OTP verification failed');
    await webhook('error_code', { reason: 'Wrong OTP code' });
    throw new Error('OTP verification failed');
  }

  // ── 12. Wait for success screen ────────────────────────────────────────
  const profileResult = await waitForAny([
    'Profile info',
    'Enter your name',
    'SKIP',
    'Chats',
    'Restore',
  ], 90000);

  if (!profileResult.matched) {
    const currentTexts = await screenTexts();
    if (currentTexts.some(t => t.includes('Chats') || t.includes('Status'))) {
      log('MAIN', 'Already on main screen');
    } else {
      throw new Error('Profile screen did not appear');
    }
  } else {
    log('MAIN', `Success screen: "${profileResult.matched}"`);
  }

  // Skip profile setup
  const skipXml = await dumpUI();
  if (skipXml.includes('SKIP') || skipXml.includes('Skip')) {
    log('MAIN', 'Skipping profile setup');
    await tapElement('SKIP', skipXml) || await tapElement('Skip', skipXml);
    await sleep(3000);
  }

  // Skip backup restore
  const restoreXml = await dumpUI();
  if (restoreXml.includes('Restore')) {
    log('MAIN', 'Skipping backup restore');
    await tapElement('SKIP', restoreXml) || tap(540, 1950);
    await sleep(3000);
  }

  await logScreen('FINAL-SCREEN');

  // ── 13. Extract session data ───────────────────────────────────────────
  log('MAIN', 'Extracting session data...');

  const sessionData = {
    phone_number: PHONE,
    registered_at: new Date().toISOString(),
  };

  try {
    const keyFile = adbShell('cat /data/data/com.whatsapp/files/key 2>/dev/null');
    if (keyFile && keyFile.length > 0) {
      sessionData.encryption_key = Buffer.from(keyFile).toString('base64');
      log('SESSION', 'Encryption key extracted');
    }
  } catch (e) {
    log('SESSION', `Could not read key: ${e.message}`);
  }

  try {
    const prefs = adbShell('cat /data/data/com.whatsapp/shared_prefs/com.whatsapp_preferences.xml 2>/dev/null');
    if (prefs && prefs.includes('<?xml')) {
      sessionData.preferences = prefs;
      log('SESSION', 'Preferences extracted');
    }
  } catch (e) {
    log('SESSION', `Could not read prefs: ${e.message}`);
  }

  try {
    adb('pull /data/data/com.whatsapp/databases/msgstore.db.crypt14 /tmp/msgstore.db 2>&1');
    if (fs.existsSync('/tmp/msgstore.db')) {
      const dbContent = fs.readFileSync('/tmp/msgstore.db');
      sessionData.database = dbContent.toString('base64');
      log('SESSION', 'Database extracted');
    }
  } catch (e) {
    log('SESSION', `Could not pull database: ${e.message}`);
  }

  log('MAIN', `Session extracted: ${Object.keys(sessionData).join(', ')}`);

  // ── 14. Send success webhook ───────────────────────────────────────────
  await webhook('success', {
    session: sessionData,
    phone_number: PHONE,
    registered_at: sessionData.registered_at,
  });

  log('MAIN', `✅ Registration completed for ${PHONE}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('ERROR', err.message);
  log('ERROR', err.stack);
  await webhook('bad_number', { reason: `Script error: ${err.message}` });
  process.exit(0); // exit 0 — bot already notified, skip if:failure() step
});
