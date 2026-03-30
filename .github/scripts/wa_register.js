/**
 * wa_register.js — Direct WhatsApp automation via ADB + UIAutomator
 *
 * Flow:
 *   1. Download WhatsApp APK from GitHub release
 *   2. Install APK on emulator
 *   3. Grant permissions
 *   4. Launch WhatsApp → agree → enter phone → receive OTP → done
 *   5. Upload screenshots at every key step
 */

'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

// ── Configuration ─────────────────────────────────────────────────────────────

const PHONE          = process.env.PHONE_NUMBER;
const USER_ID        = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID         = process.env.GITHUB_RUN_ID;

// Uses the same repo this workflow runs in (github.repository = "owner/repo").
// Upload whatsapp.apk as a release asset and the script will find it.
const GITHUB_REPO  = process.env.GITHUB_REPOSITORY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const APK_LOCAL      = '/tmp/whatsapp.apk';
const WA_PACKAGE     = 'com.whatsapp';
const SCRIPT_DIR     = '/tmp/wa_scripts';
const SCREENSHOT_DIR = '/tmp';

// ── Logging & Utilities ───────────────────────────────────────────────────────

function log(step, message) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${step}] ${message}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function exec(cmd, timeoutMs = 60000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `sh_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  try {
    return execSync(`sh ${file}`, { timeout: timeoutMs, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function adb(args, timeout = 60000)  { return exec(`adb ${args}`, timeout); }

function shell(cmd, timeout = 30000) {
  const file = path.join(SCRIPT_DIR, `adb_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = exec(`adb shell < ${file}`, timeout);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

function tap(x, y)                     { shell(`input tap ${x} ${y}`); }
function swipe(x1, y1, x2, y2, d=300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`); }
function keyevent(k)                   { shell(`input keyevent ${k}`); }
function textInput(str) {
  const safe = str.replace(/ /g, '%s').replace(/&/g, '\\&');
  shell(`input text "${safe}"`);
}

// ── Screenshot helper ─────────────────────────────────────────────────────────

let screenshotIndex = 0;
async function screenshot(label) {
  screenshotIndex++;
  const name   = `vmos_${String(screenshotIndex).padStart(2, '0')}_${label}.png`;
  const device = `/sdcard/${name}`;
  const local  = path.join(SCREENSHOT_DIR, name);
  shell(`screencap -p ${device}`);
  adb(`pull ${device} ${local}`);
  shell(`rm -f ${device}`);
  log('SCREENSHOT', `Saved: ${local}`);
  return local;
}

// ── UIAutomator helpers ───────────────────────────────────────────────────────

async function getXML(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    shell('uiautomator dump /sdcard/ui.xml');
    const xml = shell('cat /sdcard/ui.xml', 5000);
    if (xml && xml.includes('<hierarchy')) return xml;
    await sleep(1000);
  }
  throw new Error('Could not dump UI hierarchy');
}

function parseBounds(boundsStr) {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function findElement(xml, searchText) {
  const lower = searchText.toLowerCase();
  const escaped = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:text|content-desc)="([^"]*${escaped}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi'
  );
  let match;
  const matches = [];
  while ((match = re.exec(xml)) !== null) {
    const [, text, bounds] = match;
    const coords = parseBounds(bounds);
    if (coords) matches.push({ text, coords, exact: text.toLowerCase() === lower });
  }
  if (!matches.length) return null;
  return matches.find(m => m.exact) || matches[0];
}

async function verifyScreen(expectedTexts, timeoutMs = 12000) {
  const deadline   = Date.now() + timeoutMs;
  const candidates = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  while (Date.now() < deadline) {
    const xml = await getXML();
    const low = xml.toLowerCase();
    for (const t of candidates) {
      if (low.includes(t.toLowerCase())) return { success: true, found: t, xml };
    }
    await sleep(800);
  }
  const xml = await getXML();
  return { success: false, found: null, xml };
}

async function waitFor(text, timeoutMs = 45000) {
  log('WAIT', `Waiting for "${text}"…`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) throw new Error(`Timeout waiting for "${text}"`);
  const el = findElement(result.xml, text);
  if (!el) throw new Error(`Found "${text}" in XML but no bounds`);
  return { xml: result.xml, element: el };
}

async function getVisibleText() {
  const xml = await getXML();
  const texts = [];
  for (const re of [/text="([^"]*)"/g, /content-desc="([^"]*)"/g]) {
    let m;
    while ((m = re.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
  }
  return [...new Set(texts)].filter(t => t.length >= 2 && t.length <= 120);
}

// ── Webhook ───────────────────────────────────────────────────────────────────

async function webhook(event, extra = {}) {
  if (!WEBHOOK_URL) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id: RUN_ID,
      ...extra,
    });
    const u    = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const opts = {
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
    const req = (isHttps ? https : http).request(opts, res => {
      log('WEBHOOK', `${event} → ${res.statusCode}`);
      resolve();
    });
    req.on('error', () => resolve());
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ── HTTP GET (follows redirects) ──────────────────────────────────────────────

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'wa-register/1.0', ...headers },
    };
    lib.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

// ── Download file to disk (follows redirects) ─────────────────────────────────

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    log('DOWNLOAD', `${url} → ${dest}`);
    const u   = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'wa-register/1.0', ...headers },
    };
    lib.get(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(dest); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

// ── APK fetch: direct URL or GitHub releases API ──────────────────────────────

async function fetchApk() {
  if (!GITHUB_REPO) throw new Error('GITHUB_REPOSITORY is not set');

  const authHeaders = GITHUB_TOKEN
    ? { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    : { Accept: 'application/vnd.github+json' };

  log('APK', `Fetching latest release from github.com/${GITHUB_REPO}`);
  const apiUrl = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
  const resp = await httpGet(apiUrl, authHeaders);
  if (resp.status !== 200) throw new Error(`GitHub API ${resp.status}: ${resp.body}`);

  const release = JSON.parse(resp.body);
  log('APK', `Latest release: ${release.tag_name} — ${release.assets.length} asset(s)`);

  // Look specifically for whatsapp.apk
  const asset = release.assets.find(a => a.name === 'whatsapp.apk');
  if (!asset) throw new Error(`No whatsapp.apk found in release ${release.tag_name}`);

  log('APK', `Downloading whatsapp.apk (${Math.round(asset.size / 1024 / 1024)} MB)`);
  await downloadFile(asset.browser_download_url, APK_LOCAL, authHeaders);
}

// ── WhatsApp permissions ──────────────────────────────────────────────────────

const WA_PERMISSIONS = [
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.CALL_PHONE',
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
];

// ── OTP polling ───────────────────────────────────────────────────────────────
// bot.py should write the OTP to /tmp/wa_otp_<phone>.txt when it arrives.

async function waitForOtp(timeoutMs = 180000) {
  const otpFile = `/tmp/wa_otp_${PHONE}.txt`;
  log('OTP', `Polling for OTP (${timeoutMs / 1000}s max)…`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(otpFile)) {
      const otp = fs.readFileSync(otpFile, 'utf8').trim();
      fs.unlinkSync(otpFile);
      log('OTP', `✓ Received OTP: ${otp}`);
      return otp;
    }
    await sleep(3000);
  }
  throw new Error('Timeout: no OTP received within 3 minutes');
}

// ── Main flow ─────────────────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting direct WhatsApp automation for: ${PHONE}`);

  // STEP 1 — Emulator check
  log('STEP 1', 'Checking emulator…');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  log('STEP 1', '✓ Emulator ready');

  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  // Disable animations for faster UI
  shell('settings put global window_animation_scale 0');
  shell('settings put global transition_animation_scale 0');
  shell('settings put global animator_duration_scale 0');

  // STEP 2 — Download APK
  log('STEP 2', 'Downloading WhatsApp APK from GitHub release…');
  await fetchApk();
  const apkSize = fs.statSync(APK_LOCAL).size;
  log('STEP 2', `✓ APK ready (${Math.round(apkSize / 1024 / 1024)} MB)`);

  // STEP 3 — Install APK
  log('STEP 3', 'Installing WhatsApp…');
  shell(`pm uninstall ${WA_PACKAGE} 2>/dev/null || true`);
  await sleep(1000);
  const installOut = adb(`install -r -g "${APK_LOCAL}"`, 120000);
  log('STEP 3', `Install: ${installOut}`);
  if (!installOut.toLowerCase().includes('success')) {
    throw new Error(`APK install failed: ${installOut}`);
  }
  log('STEP 3', '✓ WhatsApp installed');

  // STEP 4 — Grant permissions upfront
  log('STEP 4', 'Granting permissions…');
  for (const perm of WA_PERMISSIONS) {
    shell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  log('STEP 4', '✓ Permissions granted');

  // STEP 5 — Launch WhatsApp
  log('STEP 5', 'Launching WhatsApp…');
  shell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1`);
  await sleep(5000);
  await screenshot('launch');

  const launchCheck = await verifyScreen(
    ['Agree and continue', 'AGREE AND CONTINUE', 'Continue', 'WhatsApp'],
    20000
  );
  log('STEP 5', launchCheck.success
    ? `✓ WhatsApp up, found: "${launchCheck.found}"`
    : '⚠ Still loading…'
  );

  // STEP 6 — Agree & continue
  log('STEP 6', 'Agreeing to terms…');
  for (const label of ['AGREE AND CONTINUE', 'Agree and continue', 'Continue']) {
    const check = await verifyScreen(label, 3000);
    if (check.success) {
      const btn = findElement(check.xml, label);
      if (btn) { tap(btn.coords.x, btn.coords.y); break; }
    }
  }
  await sleep(2000);
  await screenshot('after_agree');

  // Dismiss any permission dialogs WhatsApp shows (Allow / Don't allow)
  for (let i = 0; i < 6; i++) {
    const dlg = await verifyScreen(['Allow', 'ALLOW'], 2000);
    if (!dlg.success) break;
    const btn = findElement(dlg.xml, dlg.found);
    tap(btn ? btn.coords.x : 700, btn ? btn.coords.y : 1400);
    await sleep(1000);
  }

  // STEP 7 — Enter phone number
  log('STEP 7', 'Entering phone number…');
  const phoneScreen = await verifyScreen(
    ['Phone number', 'Enter your phone number', 'phone number'],
    15000
  );
  if (!phoneScreen.success) {
    await screenshot('phone_screen_missing');
    throw new Error('Phone number screen not reached');
  }
  await screenshot('phone_screen');

  // Tap the phone number field
  const phoneField = await waitFor('Phone number');
  tap(phoneField.element.coords.x, phoneField.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  // Type digits only (WhatsApp parses country code from the flag picker)
  const digitsOnly = PHONE.replace(/\D/g, '');
  textInput(digitsOnly);
  await sleep(500);
  await screenshot('phone_entered');

  // Tap Next / arrow
  try {
    const nextBtn = await waitFor('Next');
    tap(nextBtn.element.coords.x, nextBtn.element.coords.y);
  } catch {
    tap(900, 1800); // FAB arrow fallback
  }
  await sleep(2000);

  // "Is this your number?" confirmation
  const confirmDlg = await verifyScreen(['OK', 'Yes', 'Confirm'], 5000);
  if (confirmDlg.success) {
    const btn = findElement(confirmDlg.xml, confirmDlg.found);
    tap(btn ? btn.coords.x : 700, btn ? btn.coords.y : 1000);
    await sleep(2000);
  }
  await screenshot('after_phone_submit');

  // STEP 8 — Wait for OTP screen
  log('STEP 8', 'Waiting for OTP screen…');
  const otpScreen = await verifyScreen(
    ['Enter the 6-digit code', 'Verification code', 'Enter code', 'digit code'],
    30000
  );
  if (!otpScreen.success) {
    await screenshot('otp_screen_error');
    throw new Error('OTP screen did not appear');
  }
  await screenshot('otp_screen');
  log('STEP 8', '✓ OTP screen reached');
  await webhook('otp_requested', { step: 'awaiting_otp' });

  // STEP 9 — Enter OTP
  log('STEP 9', 'Waiting for OTP from bot…');
  const otp = await waitForOtp(180000);
  log('STEP 9', `Entering OTP: ${otp}`);

  try {
    const codeField = await waitFor('Enter the 6-digit code');
    tap(codeField.element.coords.x, codeField.element.coords.y + 80);
  } catch {
    tap(540, 900);
  }
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  keyevent('KEYCODE_DEL');
  textInput(otp);
  await sleep(2000);
  await screenshot('otp_entered');

  // WhatsApp auto-submits; if not, press Next
  const autoSubmit = await verifyScreen(
    ['Chats', 'Start chatting', 'New chat', 'CHATS', 'Your profile'],
    10000
  );
  if (!autoSubmit.success) {
    try {
      const nextBtn2 = await waitFor('Next');
      tap(nextBtn2.element.coords.x, nextBtn2.element.coords.y);
    } catch {
      tap(900, 1800);
    }
    await sleep(3000);
  }

  // STEP 10 — Post-registration screens
  log('STEP 10', 'Handling post-registration screens…');

  // Notification permission
  const notifDlg = await verifyScreen(['Allow', 'Not now'], 4000);
  if (notifDlg.success) {
    const btn = findElement(notifDlg.xml, 'Allow');
    tap(btn ? btn.coords.x : 700, btn ? btn.coords.y : 1400);
    await sleep(1000);
  }

  // Profile name (new number)
  const profileScreen = await verifyScreen(
    ['Your name', 'Profile info', 'Enter your name'],
    5000
  );
  if (profileScreen.success) {
    log('STEP 10', 'Profile screen — entering name');
    try {
      const nameField = await waitFor('Your name');
      tap(nameField.element.coords.x, nameField.element.coords.y + 50);
    } catch { tap(540, 900); }
    await sleep(400);
    textInput('User');
    await sleep(400);
    try {
      const nxt = await waitFor('Next');
      tap(nxt.element.coords.x, nxt.element.coords.y);
    } catch { tap(900, 1800); }
    await sleep(2000);
  }

  // Backup / restore prompt
  const backupScreen = await verifyScreen(['Back up', 'Skip', 'Not now', 'Later'], 4000);
  if (backupScreen.success) {
    const skipLabel = backupScreen.found === 'Back up' ? 'Skip' : backupScreen.found;
    const btn = findElement(backupScreen.xml, skipLabel);
    tap(btn ? btn.coords.x : 540, btn ? btn.coords.y : 1700);
    await sleep(1000);
  }

  // STEP 11 — Confirm ready
  log('STEP 11', 'Verifying WhatsApp is ready…');
  const ready = await verifyScreen(
    ['Chats', 'New chat', 'CHATS', 'Start chatting'],
    20000
  );
  await screenshot('whatsapp_ready');

  if (!ready.success) {
    log('STEP 11', '⚠ Could not confirm Chats screen');
    await webhook('bad_number', { reason: 'Registration did not complete successfully' });
    process.exit(1);
  }

  log('STEP 11', '✓ WhatsApp ready — Chats screen visible');

  // STEP 12 — Notify success
  await webhook('registered', { step: 'complete', screen: 'WhatsApp Chats' });
  log('COMPLETE', `✓ Registration complete for ${PHONE}`);
}

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    await screenshot('fatal_error');
    const texts = await getVisibleText();
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
  } catch (_) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
