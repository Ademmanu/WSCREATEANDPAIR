/**
 * wa_register.js — WhatsApp registration automation via ADB + UIAutomator XML
 *
 * Runs inside GitHub Actions after the Android emulator boots.
 * Controls the emulator 100% via ADB commands — no Appium, no WebDriver.
 *
 * UI inspection pipeline:
 *   1. adb shell uiautomator dump /sdcard/view.xml   → capture hierarchy on device
 *   2. adb pull /sdcard/view.xml /tmp/view.xml        → transfer XML to host
 *   3. fs.readFileSync('/tmp/view.xml')               → parse XML in Node.js
 *   4. Extract bounds="[x1,y1][x2,y2]" → centre → adb shell input tap cx cy
 *
 * Registration flow:
 *   boot-ready → install APK → launch WhatsApp → dismiss system dialogs →
 *   agree terms → phone number screen (edit country code, enter national
 *   number, tap NEXT) → confirm dialog → OTP → enter OTP → complete
 *
 * Required env vars:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL, WEBHOOK_SECRET, GITHUB_RUN_ID
 */

'use strict';

const { execSync } = require('child_process');
const https        = require('https');
const http         = require('http');
const fs           = require('fs');
const path         = require('path');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PHONE          = process.env.PHONE_NUMBER;
const USER_ID        = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID         = process.env.GITHUB_RUN_ID;
const RENDER_BASE    = WEBHOOK_URL.replace('/webhook/event', '');

const WA_PACKAGE = 'com.whatsapp';
const APK_PATH   = '/tmp/whatsapp.apk';
const SCRIPT_DIR = '/tmp/wa_scripts';

// UIAutomator XML paths
const DEVICE_XML = '/sdcard/view.xml';   // path on the Android device
const HOST_XML   = '/tmp/view.xml';      // path on the CI runner (host)

// ─────────────────────────────────────────────────────────────────────────────
// Phone number parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a bare international number like "2348012345678" into:
 *   { countryCode: '234', nationalNumber: '8012345678', country: 'NG' }
 */
function parsePhone(fullNumber) {
  const withPlus = `+${fullNumber}`;
  try {
    if (isValidPhoneNumber(withPlus)) {
      const p = parsePhoneNumber(withPlus);
      return {
        countryCode:    String(p.countryCallingCode),
        nationalNumber: p.nationalNumber,
        country:        p.country || 'unknown',
      };
    }
  } catch (_) {}

  // Fallback: try 3-digit, 2-digit, 1-digit prefix as country code
  for (const len of [3, 2, 1]) {
    const cc  = fullNumber.substring(0, len);
    const nat = fullNumber.substring(len);
    try {
      if (isValidPhoneNumber(`+${cc}${nat}`)) {
        const p = parsePhoneNumber(`+${cc}${nat}`);
        return {
          countryCode:    String(p.countryCallingCode),
          nationalNumber: p.nationalNumber,
          country:        p.country || 'unknown',
        };
      }
    } catch (_) {}
  }

  return {
    countryCode:    fullNumber.substring(0, 3),
    nationalNumber: fullNumber.substring(3),
    country:        'unknown',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

/**
 * Write a shell script to disk and execute it via `sh`.
 * Avoids all shell quoting / variable interpolation issues.
 */
function runScript(scriptContent, timeoutMs = 30000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `cmd_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${scriptContent}\n`, { mode: 0o755 });
  try {
    const out = execSync(`sh ${file}`, {
      timeout:  timeoutMs,
      encoding: 'utf8',
      stdio:    ['pipe', 'pipe', 'pipe'],
    });
    return (out || '').trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

/** Run an ADB host-side command (e.g. `adb pull`, `adb install`). */
function adb(args, timeoutMs = 30000) {
  return runScript(`adb ${args} 2>&1`, timeoutMs);
}

/** Execute a command inside the emulator via `adb shell`. */
function adbShell(cmd, timeoutMs = 30000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `shell_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = runScript(`adb shell < ${file}`, timeoutMs);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADB input helpers
// ─────────────────────────────────────────────────────────────────────────────

function tap(x, y) {
  log('ADB', `input tap ${x} ${y}`);
  adbShell(`input tap ${x} ${y}`);
}

function swipe(x1, y1, x2, y2, durationMs = 300) {
  adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
}

function keyevent(code) {
  adbShell(`input keyevent ${code}`);
}

/**
 * Type text via `adb shell input text`.
 * Safe for digits and plain ASCII — non-alphanumeric chars are percent-encoded.
 */
function typeText(text) {
  const safe = String(text).replace(/[^a-zA-Z0-9]/g, (c) => {
    const enc = encodeURIComponent(c);
    return enc.startsWith('%') ? enc : c;
  });
  adbShell(`input text "${safe}"`);
}

/**
 * Type digits one at a time with a small pause between each.
 * More reliable than typeText() for individual OTP input boxes.
 */
function typeDigits(digits) {
  for (const d of String(digits)) {
    adbShell(`input text ${d}`);
    runScript('sleep 0.25');
  }
}

/** Triple-tap a field to select all, delete, then type replacement text. */
function clearFieldAndType(x, y, text) {
  tap(x, y);
  runScript('sleep 0.3');
  adbShell(`input tap ${x} ${y}`);
  adbShell(`input tap ${x} ${y}`);
  adbShell(`input tap ${x} ${y}`);
  runScript('sleep 0.2');
  keyevent('KEYCODE_CTRL_A');
  runScript('sleep 0.1');
  keyevent('KEYCODE_DEL');
  runScript('sleep 0.2');
  typeText(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// UIAutomator XML pipeline
//
//   Step 1 — adb shell uiautomator dump /sdcard/view.xml
//             Captures the live UI hierarchy and writes it to the device SD card.
//
//   Step 2 — adb pull /sdcard/view.xml /tmp/view.xml
//             Transfers the XML file from the device to the host filesystem.
//
//   Step 3 — fs.readFileSync('/tmp/view.xml', 'utf8')
//             Reads the XML into a Node.js string for parsing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capture the current UI hierarchy and return it as an XML string.
 *
 * Retries until valid XML is returned or timeoutMs is exhausted.
 * Returns '' if the UI could not be captured.
 *
 * @param {number} timeoutMs   Max total wait time (default 8 s)
 * @param {number} retryDelay  Pause between retries (default 1 s)
 * @returns {Promise<string>}
 */
async function dumpUI(timeoutMs = 8000, retryDelay = 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      // ── Step 1: dump hierarchy to device SD card ────────────────────────
      adbShell(`uiautomator dump ${DEVICE_XML} 2>/dev/null`);

      // ── Step 2: pull the XML file to the host ───────────────────────────
      const pullResult = adb(`pull ${DEVICE_XML} ${HOST_XML}`, 10000);
      if (pullResult.toLowerCase().includes('error') && !pullResult.includes('pulled')) {
        log('XML', `pull failed (${pullResult.substring(0, 80)}) — retrying`);
        await sleep(retryDelay);
        continue;
      }

      // ── Step 3: read and validate the XML ───────────────────────────────
      if (!fs.existsSync(HOST_XML)) {
        log('XML', 'host file not found — retrying');
        await sleep(retryDelay);
        continue;
      }

      const xml = fs.readFileSync(HOST_XML, 'utf8');
      if (xml && xml.includes('<hierarchy')) {
        return xml; // valid UI hierarchy
      }

      log('XML', 'invalid XML content — retrying');
    } catch (err) {
      log('XML', `dumpUI error: ${err.message}`);
    }

    await sleep(retryDelay);
  }

  log('XML', 'dumpUI timed out');
  return '';
}

/** Collect up to `limit` unique visible text strings from the current screen. */
async function screenTexts(limit = 20) {
  const xml = await dumpUI();
  const seen = new Set();
  const re   = /text="([^"]{1,80})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t) seen.add(t);
  }
  return [...seen].slice(0, limit);
}

async function logScreen(label = 'SCREEN') {
  const texts = await screenTexts();
  log(label, texts.join(' | ') || '(empty)');
  return texts;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML element detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a UIAutomator bounds string like "[x1,y1][x2,y2]".
 * Returns { x1, y1, x2, y2, cx, cy } where cx/cy are the centre coordinates.
 */
function parseBounds(boundsStr) {
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  const x1 = parseInt(m[1], 10);
  const y1 = parseInt(m[2], 10);
  const x2 = parseInt(m[3], 10);
  const y2 = parseInt(m[4], 10);
  return { x1, y1, x2, y2, cx: Math.round((x1 + x2) / 2), cy: Math.round((y1 + y2) / 2) };
}

/**
 * Find a UI node whose `text` or `content-desc` attribute matches `needle`.
 *
 * Each node in UIAutomator XML is a self-closing tag:
 *   <node … text="AGREE AND CONTINUE" … bounds="[x1,y1][x2,y2]" … />
 *
 * We iterate over every <node … /> block, test the needle, and extract bounds
 * from the SAME node — so we never mix up coordinates from different elements.
 *
 * @param {string}  xml    Raw UIAutomator XML
 * @param {string}  needle Text or content-desc to match
 * @param {boolean} exact  If true, require exact (case-insensitive) equality
 * @returns {{ x1,y1,x2,y2,cx,cy }|null}
 */
function findElement(xml, needle, exact = false) {
  if (!xml) return null;
  const low    = needle.toLowerCase();
  const nodeRe = /<node[^>]+\/>/gs;
  let match;

  while ((match = nodeRe.exec(xml)) !== null) {
    const node = match[0];
    const textM = node.match(/\btext="([^"]*)"/);
    const descM = node.match(/\bcontent-desc="([^"]*)"/);
    const tv    = textM ? textM[1] : '';
    const dv    = descM ? descM[1] : '';

    const hit = exact
      ? (tv.toLowerCase() === low || dv.toLowerCase() === low)
      : (tv.toLowerCase().includes(low) || dv.toLowerCase().includes(low));

    if (hit) {
      const bm = node.match(/\bbounds="(\[[^\]]+\]\[[^\]]+\])"/);
      if (bm) {
        const coords = parseBounds(bm[1]);
        if (coords) return coords;
      }
    }
  }
  return null;
}

/**
 * Find a node by resource-id substring (e.g. "registration_phone").
 */
function findElementById(xml, resourceId) {
  if (!xml) return null;
  const nodeRe = /<node[^>]+\/>/gs;
  let match;
  while ((match = nodeRe.exec(xml)) !== null) {
    const node = match[0];
    const idM = node.match(/\bresource-id="([^"]*)"/);
    if (idM && idM[1].includes(resourceId)) {
      const bm = node.match(/\bbounds="(\[[^\]]+\]\[[^\]]+\])"/);
      if (bm) return parseBounds(bm[1]);
    }
  }
  return null;
}

/**
 * Find a node by class name (e.g. "EditText") with an optional hint string.
 */
function findElementByClass(xml, className, hintText = null) {
  if (!xml) return null;
  const nodeRe = /<node[^>]+\/>/gs;
  let match;
  while ((match = nodeRe.exec(xml)) !== null) {
    const node = match[0];
    const clsM = node.match(/\bclass="([^"]*)"/);
    if (!clsM || !clsM[1].includes(className)) continue;
    if (hintText) {
      const tv = (node.match(/\btext="([^"]*)"/)?.[1] || '');
      const hv = (node.match(/\bhint="([^"]*)"/)?.[1] || '');
      if (!`${tv}${hv}`.toLowerCase().includes(hintText.toLowerCase())) continue;
    }
    const bm = node.match(/\bbounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (bm) return parseBounds(bm[1]);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tap helpers with retry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find an element by text/content-desc and tap it.
 * Re-dumps the UI on every retry attempt.
 *
 * @param {string}      needle      Text to search for
 * @param {string|null} xml         Pre-captured XML (null = dump fresh)
 * @param {number}      retries     Max attempts (default 3)
 * @param {number}      retryDelay  Pause between attempts in ms (default 2000)
 * @returns {Promise<boolean>}      true if element was found and tapped
 */
async function tapElement(needle, xml = null, retries = 3, retryDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const currentXml = xml || (await dumpUI());
    const coords     = findElement(currentXml, needle);

    if (coords) {
      log('TAP', `"${needle}" → (${coords.cx},${coords.cy}) [attempt ${attempt}]`);
      tap(coords.cx, coords.cy);
      await sleep(800);
      return true;
    }

    log('TAP', `"${needle}" not found (attempt ${attempt}/${retries})`);
    if (attempt < retries) {
      await sleep(retryDelay);
      xml = null; // force fresh dump on next attempt
    }
  }
  log('TAP', `"${needle}" — giving up`);
  return false;
}

/** Tap an element located by resource-id, with retry. */
async function tapElementById(resourceId, xml = null, retries = 3, retryDelay = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const currentXml = xml || (await dumpUI());
    const coords     = findElementById(currentXml, resourceId);

    if (coords) {
      log('TAP_ID', `"${resourceId}" → (${coords.cx},${coords.cy}) [attempt ${attempt}]`);
      tap(coords.cx, coords.cy);
      await sleep(800);
      return true;
    }

    log('TAP_ID', `"${resourceId}" not found (attempt ${attempt}/${retries})`);
    if (attempt < retries) {
      await sleep(retryDelay);
      xml = null;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Screen wait helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Poll the UI until the XML contains `text` (case-insensitive).
 * Returns the XML when found, or null on timeout.
 */
async function waitForScreen(text, timeoutMs = 60000, pollMs = 2500) {
  log('WAIT', `"${text}" (up to ${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (xml.toLowerCase().includes(text.toLowerCase())) {
      log('FOUND', `"${text}"`);
      return xml;
    }
    await sleep(pollMs);
  }
  log('TIMEOUT', `"${text}" not found`);
  return null;
}

/**
 * Wait for any one of multiple text strings.
 * Returns { xml, matched } — matched is the string that triggered.
 */
async function waitForAny(texts, timeoutMs = 60000, pollMs = 2500) {
  log('WAIT', `any of [${texts.map(t => `"${t}"`).join(', ')}] (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    for (const text of texts) {
      if (xml.toLowerCase().includes(text.toLowerCase())) {
        log('FOUND', `"${text}"`);
        return { xml, matched: text };
      }
    }
    await sleep(pollMs);
  }
  log('TIMEOUT', `none of [${texts.join(', ')}] found`);
  return { xml: '', matched: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────────────────────

function webhook(event, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number:     PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id:           RUN_ID,
      ...extra,
    });
    const u       = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const options = {
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname,
      method:   'POST',
      headers: {
        'Content-Type':     'application/json',
        'Content-Length':   Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      log('WEBHOOK', `${event} → HTTP ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', (e) => { log('WEBHOOK', `${event} error: ${e.message}`); resolve(0); });
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// OTP polling
// ─────────────────────────────────────────────────────────────────────────────

async function pollForOtp(timeoutMs = 13 * 60 * 1000) {
  const otpUrl  = `${RENDER_BASE}/otp/${encodeURIComponent(PHONE)}`;
  const deadline = Date.now() + timeoutMs;
  log('OTP', `Polling ${otpUrl} for up to ${timeoutMs / 60000} min`);
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
  log('OTP', 'Timed out waiting for OTP');
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'GET',
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

// ─────────────────────────────────────────────────────────────────────────────
// Wait-time string parsing  ("Try again in 2 hours 30 minutes")
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Registration steps
// ─────────────────────────────────────────────────────────────────────────────

// ── Step A: APK install ───────────────────────────────────────────────────────

async function installWhatsApp() {
  if (!fs.existsSync(APK_PATH)) throw new Error(`APK not found at ${APK_PATH}`);
  const sizeMB = (fs.statSync(APK_PATH).size / 1024 / 1024).toFixed(1);
  log('INSTALL', `APK size: ${sizeMB} MB`);

  await sleep(2000); // allow ADB to settle after emulator boot

  // Strategy 1: push to device then install via `pm` (fastest for large APKs)
  log('INSTALL', 'Pushing APK to /data/local/tmp/...');
  const pushOut = runScript(`adb push ${APK_PATH} /data/local/tmp/whatsapp.apk 2>&1`, 600000);
  log('INSTALL', `Push: ${pushOut.substring(0, 120)}`);

  if (pushOut.toLowerCase().includes('error') && !pushOut.includes('pushed')) {
    // Strategy 2: direct adb install
    log('INSTALL', 'Push failed — falling back to direct adb install');
    const out = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
    log('INSTALL', `adb install: ${out.substring(0, 120)}`);
    if (!out.toLowerCase().includes('success')) throw new Error(`Install failed: ${out}`);
  } else {
    log('INSTALL', 'Installing from on-device copy via pm...');
    const pmOut = runScript(
      'adb shell pm install -r -t -g /data/local/tmp/whatsapp.apk 2>&1', 120000
    );
    log('INSTALL', `pm: ${pmOut.substring(0, 120)}`);

    if (!pmOut.toLowerCase().includes('success')) {
      // Strategy 3: adb install fallback
      log('INSTALL', 'pm failed — trying adb install directly');
      const fbOut = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
      log('INSTALL', `fallback: ${fbOut.substring(0, 120)}`);
      if (!fbOut.toLowerCase().includes('success')) {
        await sleep(3000);
        const pkg = runScript('adb shell pm list packages 2>/dev/null', 10000);
        if (!pkg.includes(WA_PACKAGE)) throw new Error(`Install verification failed`);
      }
    }
  }

  // Verify via pm list (retry up to 3 times — pm list can be slow)
  for (let i = 1; i <= 3; i++) {
    await sleep(2000);
    const pkg = runScript('adb shell pm list packages 2>/dev/null', 10000);
    if (pkg.includes(WA_PACKAGE)) {
      log('INSTALL', `Verified (attempt ${i})`);
      return;
    }
  }
  throw new Error('WhatsApp package not found after install');
}

// ── Step B: Screen unlock ────────────────────────────────────────────────────

async function unlockScreen() {
  log('UNLOCK', 'Waking and unlocking screen');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  adbShell('settings put global stay_on_while_plugged_in 3');
  adbShell('settings put secure lockscreen.disabled 1');
  await logScreen('UNLOCK');
}

// ── Step C: Grant permissions ────────────────────────────────────────────────

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
  'android.permission.POST_NOTIFICATIONS',
];

async function grantPermissions() {
  log('PERMS', 'Granting permissions...');
  for (const p of WA_PERMS) adbShell(`pm grant ${WA_PACKAGE} ${p} 2>/dev/null || true`);
  log('PERMS', 'Done');
}

// ── Step D: Launch WhatsApp ──────────────────────────────────────────────────

async function launchWhatsApp() {
  log('LAUNCH', 'Launching via monkey...');
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
  log('LAUNCH', 'Waiting 12s for first render...');
  await sleep(12000);

  const texts = await logScreen('LAUNCH');
  const isCrash = texts.some(t => t.includes('keeps stopping'));
  const isHome  = texts.some(t =>
    ['Messages', 'Chrome', 'Camera', 'Sunday', 'Monday', 'Tuesday'].some(w => t.includes(w))
  );

  if (isCrash) {
    log('LAUNCH', 'App crashed — clearing data and retrying');
    await tapElement('Close app', null, 1);
    await sleep(2000);
    adbShell(`pm clear ${WA_PACKAGE} 2>/dev/null || true`);
    await sleep(1000);
    await grantPermissions();
    adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
    await sleep(14000);
    await logScreen('AFTER-CLEAR');
  } else if (isHome) {
    log('LAUNCH', 'Still home — trying am start');
    adbShell(`am start -n ${WA_PACKAGE}/${WA_PACKAGE}.Main 2>/dev/null`);
    await sleep(10000);
    await logScreen('AFTER-AMSTART');
  }
}

// ── Step E: Dismiss system dialogs ──────────────────────────────────────────

async function dismissSystemDialogs() {
  log('DIALOG', 'Clearing any system alert dialogs...');
  for (let i = 0; i < 6; i++) {
    const xml = await dumpUI(4000);
    const hasAlert =
      xml.includes('Alert') || xml.includes('More info') ||
      xml.includes('Google Play') || xml.includes('Update') ||
      xml.includes('keeps stopping');
    if (!hasAlert) break;

    log('DIALOG', `Alert detected (pass ${i + 1})`);
    const dismissed =
      await tapElement('OK',       xml, 1) ||
      await tapElement('Skip',     xml, 1) ||
      await tapElement('Not now',  xml, 1) ||
      await tapElement('Cancel',   xml, 1) ||
      await tapElement('Close app',xml, 1) ||
      await tapElement('Close',    xml, 1);

    if (!dismissed) tap(540, 1200); // blind centre tap
    await sleep(2000);
  }
}

// ── Step F: Accept terms (AGREE AND CONTINUE) ────────────────────────────────

async function acceptTerms() {
  // Some versions show a language-picker first
  const langXml = await dumpUI(4000);
  if (langXml.includes('Choose your language') || langXml.includes('Welcome to WhatsApp')) {
    log('TERMS', 'Language screen — advancing');
    const ok =
      await tapElement('Continue', langXml, 1) ||
      await tapElement('Next',     langXml, 1) ||
      await tapElement('next',     langXml, 1);
    if (!ok) tap(540, 2100);
    await sleep(3000);
  }

  log('TERMS', 'Waiting for Agree and Continue...');
  const result = await waitForAny(
    ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree'],
    45000
  );
  if (!result.matched) {
    await logScreen('MISSING-AGREE');
    throw new Error('Agree and Continue button not found');
  }

  log('TERMS', `Found: "${result.matched}"`);

  // Fresh dump for accurate coordinates
  const xml = await dumpUI();
  for (const btn of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree']) {
    if (xml.includes(btn) && await tapElement(btn, xml, 3)) break;
  }

  await sleep(4000);
  await logScreen('POST-AGREE');
}

// ── Step G: Phone number screen ───────────────────────────────────────────────
//
//   G1. Dump UI XML                         (adb shell uiautomator dump + adb pull)
//   G2. Detect country code field           (findElementById / findElement)
//   G3. Edit country code                   (clearFieldAndType)
//   G4. Detect national number field        (findElementById / findElementByClass)
//   G5. Enter national number               (typeDigits)
//   G6. Tap NEXT                            (tapElement / tapElementById)

/**
 * Set the country code field.
 * Tries three strategies in order: country picker row → cc_et field → "+" field.
 */
async function setCountryCode(xml, countryCode) {
  log('CC', `Setting country code to +${countryCode}`);

  // Strategy 1 — open country picker and search
  const ccRow =
    findElementById(xml, 'registration_country') ||
    findElementById(xml, 'country_picker') ||
    findElementById(xml, 'selected_country') ||
    findElement(xml, 'country', false);

  if (ccRow) {
    log('CC', `Opening country picker at (${ccRow.cx},${ccRow.cy})`);
    tap(ccRow.cx, ccRow.cy);
    await sleep(2000);

    const pickerXml = await dumpUI();
    const searchField =
      findElementById(pickerXml, 'search') ||
      findElementByClass(pickerXml, 'EditText');

    if (searchField) {
      tap(searchField.cx, searchField.cy);
      await sleep(500);
      typeText(countryCode);
      await sleep(1500);

      const resultsXml = await dumpUI();
      const firstResult =
        findElementById(resultsXml, 'flagView') ||
        findElementByClass(resultsXml, 'TextView');
      if (firstResult) {
        tap(firstResult.cx, firstResult.cy);
        await sleep(1500);
        log('CC', 'Selected from picker');
        return true;
      }
    }
    keyevent('KEYCODE_BACK');
    await sleep(1000);
  }

  // Strategy 2 — direct cc_et EditText
  const ccField =
    findElementById(xml, 'cc_et') ||
    findElementById(xml, 'registration_cc');
  if (ccField) {
    log('CC', `cc_et field at (${ccField.cx},${ccField.cy}) — overwriting`);
    clearFieldAndType(ccField.cx, ccField.cy, countryCode);
    await sleep(800);
    return true;
  }

  // Strategy 3 — field whose text starts with "+"
  const plusField = findElement(xml, '+', false);
  if (plusField) {
    log('CC', `"+" field at (${plusField.cx},${plusField.cy}) — overwriting`);
    clearFieldAndType(plusField.cx, plusField.cy, countryCode);
    await sleep(800);
    return true;
  }

  log('CC', 'WARNING: country code field not found');
  return false;
}

/**
 * Enter the national phone number.
 * Prefers resource-id detection; falls back to second EditText on screen.
 */
async function enterNationalNumber(xml, nationalNumber) {
  log('PHONE', `Entering national number: ${nationalNumber}`);

  const field =
    findElementById(xml, 'registration_phone') ||
    findElementById(xml, 'phone_number')        ||
    findElementById(xml, 'pn_et')               ||
    findElementByClass(xml, 'EditText', 'phone') ||
    findElementByClass(xml, 'EditText', 'number');

  if (field) {
    log('PHONE', `Phone field at (${field.cx},${field.cy})`);
    tap(field.cx, field.cy);
    await sleep(500);
    keyevent('KEYCODE_CTRL_A');
    await sleep(100);
    keyevent('KEYCODE_DEL');
    await sleep(200);
    typeDigits(nationalNumber);
    await sleep(600);
    return true;
  }

  // Fallback: collect all EditText nodes; national number is usually the second
  log('PHONE', 'No phone field by id — collecting all EditText nodes');
  const editFields = [];
  const nodeRe = /<node[^>]+\/>/gs;
  let m;
  const src = xml || await dumpUI();
  while ((m = nodeRe.exec(src)) !== null) {
    const node = m[0];
    if (!node.includes('EditText') && !node.includes('edit')) continue;
    const bm = node.match(/\bbounds="(\[[^\]]+\]\[[^\]]+\])"/);
    if (bm) {
      const c = parseBounds(bm[1]);
      if (c) editFields.push(c);
    }
  }

  if (editFields.length >= 2) {
    const f = editFields[1];
    log('PHONE', `Using second EditText at (${f.cx},${f.cy})`);
    tap(f.cx, f.cy);
    await sleep(500);
    keyevent('KEYCODE_CTRL_A');
    keyevent('KEYCODE_DEL');
    await sleep(200);
    typeDigits(nationalNumber);
    await sleep(600);
    return true;
  }

  log('PHONE', 'WARNING: national number field not found');
  return false;
}

/**
 * Full phone-number screen handler.
 */
async function handlePhoneNumberScreen(countryCode, nationalNumber) {
  log('PHONE_SCREEN', 'Waiting for phone number entry screen...');

  // Wait for any indicator that we're on the phone-number screen
  const result = await waitForAny([
    'Enter your phone number',
    'phone number',
    "What's your phone number",
    'enter your number',
    'registration_phone',
    'cc_et',
  ], 60000);

  if (!result.matched) {
    await logScreen('MISSING-PHONE-SCREEN');
    throw new Error('Phone number screen did not appear');
  }

  log('PHONE_SCREEN', `Screen found: "${result.matched}"`);

  // G1 — dump fresh XML for coordinates
  const xml = await dumpUI();

  // G2 + G3 — detect and edit country code field
  await setCountryCode(xml, countryCode);
  await sleep(500);

  // G4 + G5 — detect and enter national number (re-dump after CC change)
  const xml2 = await dumpUI();
  await enterNationalNumber(xml2, nationalNumber);
  await sleep(500);

  // G6 — tap NEXT
  log('PHONE_SCREEN', 'Tapping NEXT...');
  const nextXml = await dumpUI();
  const nextTapped =
    await tapElement('NEXT',       nextXml, 3) ||
    await tapElement('Next',       nextXml, 3) ||
    await tapElement('Done',       nextXml, 3) ||
    await tapElement('Continue',   nextXml, 3) ||
    await tapElementById('next_btn',            nextXml, 3) ||
    await tapElementById('registration_submit', nextXml, 3);

  if (!nextTapped) {
    // Hide keyboard and retry
    keyevent('KEYCODE_BACK');
    await sleep(800);
    const retryXml = await dumpUI();
    await tapElement('NEXT', retryXml, 3) || await tapElement('Next', retryXml, 3);
  }

  await sleep(3000);
  await logScreen('POST-NEXT');
}

// ── Step H: Confirm phone number dialog ──────────────────────────────────────

async function confirmPhoneDialog() {
  log('CONFIRM', 'Checking for confirmation dialog...');
  const result = await waitForAny(
    ['Is this your number', 'is this your number', 'Confirm', 'CONTINUE'],
    20000
  );
  if (!result.matched) {
    log('CONFIRM', 'No confirmation dialog — proceeding');
    return;
  }
  log('CONFIRM', `Dialog: "${result.matched}"`);
  const xml = await dumpUI();
  await tapElement('CONTINUE', xml, 2) ||
  await tapElement('Continue', xml, 2) ||
  await tapElement('OK',       xml, 2) ||
  await tapElement('Yes',      xml, 2);
  await sleep(3000);
  await logScreen('POST-CONFIRM');
}

// ── Step I: Rate-limit check ─────────────────────────────────────────────────

async function checkRateLimit() {
  const xml = await dumpUI(5000);
  if (!['wait before', 'try again', 'hours', 'minutes'].some(p =>
    xml.toLowerCase().includes(p)
  )) return false;

  const re = /text="([^"]{5,80})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1];
    if (/wait|hour|minute|sec/i.test(t)) {
      const secs = parseWaitSeconds(t);
      log('RATE_LIMIT', `Rate limited: "${t}" — ${secs}s`);
      await webhook('rate_limited', { wait_seconds: secs, message: t });
      return true;
    }
  }
  return false;
}

// ── Step J: Enter OTP ────────────────────────────────────────────────────────

async function enterOtp(otp) {
  log('OTP_ENTRY', `Entering OTP: ${otp}`);

  // Wait for OTP input screen
  const result = await waitForAny(
    ['Enter the 6-digit', 'verification code', 'enter the code', 'sms code', 'Verifying'],
    90000
  );
  if (!result.matched) {
    log('OTP_ENTRY', 'OTP screen not detected — attempting blind entry');
  }

  const xml = await dumpUI();
  const otpField =
    findElementById(xml, 'entry_code_text') ||
    findElementById(xml, 'otp_input')       ||
    findElementById(xml, 'sms_code')        ||
    findElementByClass(xml, 'EditText');

  if (otpField) {
    log('OTP_ENTRY', `OTP field at (${otpField.cx},${otpField.cy})`);
    tap(otpField.cx, otpField.cy);
    await sleep(500);
    keyevent('KEYCODE_CTRL_A');
    keyevent('KEYCODE_DEL');
    await sleep(200);
  } else {
    log('OTP_ENTRY', 'No OTP field found — typing directly');
  }

  typeDigits(otp);
  await sleep(2000);

  // Tap confirm if shown
  const afterXml = await dumpUI();
  await tapElement('NEXT',   afterXml, 2) ||
  await tapElement('Next',   afterXml, 2) ||
  await tapElement('Verify', afterXml, 2) ||
  await tapElement('Submit', afterXml, 2);

  await sleep(4000);
  await logScreen('POST-OTP');
}

// ── Step K: Skip post-registration setup screens ─────────────────────────────

async function skipSetupScreens() {
  const skip = ['Skip', 'Not now', 'SKIP', 'Maybe later', 'Allow', 'OK', 'Continue', 'Done'];

  for (let i = 0; i < 10; i++) {
    const xml = await dumpUI(5000);

    // Registration complete?
    if (
      xml.includes('Chats')           ||
      xml.includes('NEW CHAT')        ||
      xml.includes('Start messaging') ||
      xml.includes('No new chats')
    ) {
      log('SETUP', 'Chat list visible — registration complete');
      return true;
    }

    // Tap skip/allow buttons
    let skipped = false;
    for (const target of skip) {
      if (xml.includes(target)) {
        if (await tapElement(target, xml, 1)) { skipped = true; break; }
      }
    }

    // Android 13+ notification permission dialog
    if (!skipped) {
      const pXml = await dumpUI(3000);
      if (pXml.includes('Allow') || pXml.includes('Deny')) {
        await tapElement('Allow', pXml, 1);
      }
    }

    await sleep(2500);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — full registration flow
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log('MAIN', `WhatsApp registration starting for ${PHONE}`);

  if (!PHONE || !USER_ID || !WEBHOOK_URL || !WEBHOOK_SECRET) {
    throw new Error(
      'Missing env vars: PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL, WEBHOOK_SECRET'
    );
  }

  const phoneInfo = parsePhone(PHONE);
  log('MAIN', `Phone parsed — country: ${phoneInfo.country}, cc: +${phoneInfo.countryCode}, national: ${phoneInfo.nationalNumber}`);

  // ── 1. Wait for emulator to finish booting ───────────────────────────────
  log('MAIN', 'Waiting for emulator boot...');
  await sleep(5000);
  for (let i = 1; i <= 10; i++) {
    const prop = adbShell('getprop sys.boot_completed').trim();
    log('BOOT', `sys.boot_completed = "${prop}" (attempt ${i}/10)`);
    if (prop === '1') break;
    if (i === 10) throw new Error('Emulator boot timed out');
    await sleep(6000);
  }
  log('BOOT', 'Emulator ready');

  // ── 2. Unlock screen ─────────────────────────────────────────────────────
  await unlockScreen();

  // ── 3. Install WhatsApp APK ──────────────────────────────────────────────
  await installWhatsApp();

  // ── 4. Grant permissions ─────────────────────────────────────────────────
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  await grantPermissions();

  // ── 5. Launch WhatsApp ───────────────────────────────────────────────────
  await launchWhatsApp();

  // ── 6. Dismiss system dialogs ────────────────────────────────────────────
  await dismissSystemDialogs();

  // ── 7. Accept terms ──────────────────────────────────────────────────────
  //   • Dump UI XML
  //   • Find "AGREE AND CONTINUE" in the XML
  //   • Extract bounds → calculate centre coordinates
  //   • adb shell input tap cx cy
  await acceptTerms();

  // ── 8. Phone number screen ───────────────────────────────────────────────
  //   • Dump UI XML  (adb shell uiautomator dump /sdcard/view.xml)
  //   • adb pull /sdcard/view.xml /tmp/view.xml
  //   • Parse XML → find country code field → edit country code
  //   • Parse XML → find phone number field → type national number
  //   • Parse XML → find NEXT button → tap
  await handlePhoneNumberScreen(phoneInfo.countryCode, phoneInfo.nationalNumber);

  // ── 9. Confirm phone number dialog ───────────────────────────────────────
  await confirmPhoneDialog();

  // ── 10. Check for rate limit ─────────────────────────────────────────────
  if (await checkRateLimit()) {
    log('MAIN', 'Rate limited — exiting');
    process.exit(0);
  }

  // ── 11. Notify bot: OTP has been requested ───────────────────────────────
  await webhook('otp_requested');
  log('MAIN', 'OTP requested — waiting for user reply on Telegram');

  // ── 12. Poll bot for OTP ─────────────────────────────────────────────────
  const otp = await pollForOtp();
  if (!otp) {
    log('MAIN', 'OTP not received in time');
    await webhook('bad_number', { reason: 'OTP timeout — user did not reply' });
    process.exit(0);
  }

  // ── 13. Enter OTP ────────────────────────────────────────────────────────
  await enterOtp(otp);

  // ── 14. Skip setup screens → confirm chat list ───────────────────────────
  const complete = await skipSetupScreens();

  if (complete) {
    log('MAIN', 'Registration complete!');
    await webhook('registration_complete');
  } else {
    const finalXml = await dumpUI();
    if (finalXml.includes('Chats') || finalXml.includes('NEW CHAT')) {
      log('MAIN', 'Chat list visible — registration complete');
      await webhook('registration_complete');
    } else if (finalXml.includes('invalid') || finalXml.includes('incorrect')) {
      log('MAIN', 'OTP rejected');
      await webhook('bad_number', { reason: 'Invalid OTP entered' });
    } else {
      const finalTexts = await logScreen('FINAL');
      log('MAIN', `Uncertain final state: ${finalTexts.join(' | ')}`);
      await webhook('registration_complete', { note: 'Uncertain final state' });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('ERROR', err.message);
  log('ERROR', err.stack || '(no stack)');
  try { await webhook('bad_number', { reason: `Script error: ${err.message}` }); } catch (_) {}
  process.exit(0);
});
