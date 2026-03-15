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


  // ── 5. Handle language picker + accept terms ────────────────────────────
  // Newer WhatsApp versions show a language selection screen first.
  // We wait for ANY of these screens and handle each appropriately.
  log('MAIN', 'Handling language/agree screens...');

  // Loop to handle multiple screens in sequence (language → agree → phone)
  let onPhoneScreen = false;
  const screenDeadline = Date.now() + 90000;

  while (Date.now() < screenDeadline && !onPhoneScreen) {
    const xml = await dumpUI();
    const lower = xml.toLowerCase();

    // ── Language selection screen ────────────────────────────────────────
    if (xml.includes('Choose your language') || xml.includes('Welcome to WhatsApp')) {
      log('MAIN', 'Language screen — tapping English');
      // Tap "English" or "(device's language)" — whichever appears first
      const tapped = await tapElement('English', xml) ||
                     await tapElement("(device's language)", xml);
      if (!tapped) {
        // Fallback: tap center of screen (English is usually near top of list)
        tap(540, 600);
      }
      await sleep(2000);
      // Look for a "Continue" or checkmark button after selecting language
      const afterLang = await dumpUI();
      for (const btn of ['Continue', 'CONTINUE', 'Next', 'OK', 'Done']) {
        if (afterLang.includes(btn)) {
          await tapElement(btn, afterLang);
          await sleep(2000);
          break;
        }
      }
      continue;
    }

    // ── Terms / agree screen ─────────────────────────────────────────────
    if (lower.includes('agree') || lower.includes('terms') || lower.includes('privacy')) {
      log('MAIN', 'Agree screen — accepting terms');
      for (const btn of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree']) {
        if (xml.includes(btn)) {
          await tapElement(btn, xml);
          await sleep(4000);
          break;
        }
      }
      continue;
    }

    // ── Google Play / system dialogs ─────────────────────────────────────
    if (xml.includes('Update') || xml.includes('Google Play')) {
      log('MAIN', 'Google Play dialog — dismissing');
      await tapElement('Skip', xml) || await tapElement('Not now', xml) ||
      await tapElement('Cancel', xml) || await tapElement('No thanks', xml);
      await sleep(2000);
      continue;
    }

    // ── Phone number screen reached ──────────────────────────────────────
    if (lower.includes('phone number') || lower.includes('country') ||
        lower.includes('enter your phone') || lower.includes('your phone')) {
      log('MAIN', 'Phone number screen reached');
      onPhoneScreen = true;
      break;
    }

    // ── Crash dialog ─────────────────────────────────────────────────────
    if (xml.includes('keeps stopping')) {
      log('MAIN', 'Crash dialog — dismissing');
      await tapElement('Close app', xml);
      await sleep(2000);
      adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
      await sleep(8000);
      continue;
    }

    const visible = await screenTexts();
    log('MAIN', `Waiting for agree/phone screen... visible: ${visible.slice(0,5).join(' | ')}`);
    await sleep(3000);
  }

  if (!onPhoneScreen) {
    await logScreen('ERROR');
    await webhook('bad_number', { reason: 'Phone entry screen not reached after language/agree flow' });
    process.exit(0);
  }

  // ── 6. Phone number entry ────────────────────────────────────────────────
  log('MAIN', 'Waiting for phone number screen...');


  log('MAIN', 'Waiting for phone number screen...');

  // Poll for up to 90 seconds — WhatsApp can be slow on first launch
  let phoneResult = { matched: null, xml: '' };
  const phoneDeadline = Date.now() + 90000;
  while (Date.now() < phoneDeadline && !phoneResult.matched) {
    const xml = await dumpUI();
    const xmlLower = xml.toLowerCase();
    for (const text of [
      'Enter your phone number', 'Your phone number', 'Phone number',
      'phone number', 'Country', 'country code', 'enter phone',
    ]) {
      if (xmlLower.includes(text.toLowerCase())) {
        phoneResult = { matched: text, xml };
        break;
      }
    }
    if (!phoneResult.matched) {
      const visible = await screenTexts();
      log('MAIN', `Still waiting for phone screen... visible: ${visible.slice(0, 5).join(' | ')}`);

      // Dismiss crash dialog if it reappears
      if (xml.includes('keeps stopping')) {
        log('MAIN', 'Crash dialog reappeared — dismissing...');
        await tapElement('Close app', xml);
        await sleep(2000);
        adbShell(`pm clear ${WA_PACKAGE} 2>/dev/null || true`);
        await sleep(1000);
        adbShell(`am start -W -n ${WA_PACKAGE}/${WA_PACKAGE}.Main`);
        await sleep(8000);
        continue;
      }

      // Tap agree in case it re-appeared
      if (xml.includes('AGREE') || xml.includes('Agree')) {
        await tapElement('AGREE AND CONTINUE', xml) || await tapElement('Agree and continue', xml);
        await sleep(3000);
        continue;
      }

      await sleep(3000);
    }
  }

  if (!phoneResult.matched) {
    await logScreen('ERROR');
    await webhook('bad_number', { reason: 'Phone entry screen not found after 90s' });
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
