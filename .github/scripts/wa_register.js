/**
 * wa_register.js — VMOS Cloud automation with Chrome welcome screen handling
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const PHONE = process.env.PHONE_NUMBER;
const USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID = process.env.GITHUB_RUN_ID;

const TARGET_URL = 'https://cloud.vmoscloud.com/';
const EMAIL = 'emmanueladeloye2023@gmail.com';
const PASSWORD = 'Emma2007';
const SCRIPT_DIR = '/tmp/wa_scripts';

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(step, message) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${step}] ${message}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function exec(cmd, timeoutMs = 30000) {
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

function adb(args, timeout = 30000) {
  return exec(`adb ${args}`, timeout);
}

function shell(cmd, timeout = 30000) {
  const file = path.join(SCRIPT_DIR, `adb_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = exec(`adb shell < ${file}`, timeout);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

function tap(x, y) { shell(`input tap ${x} ${y}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }
function textInput(str) {
  const safe = str.replace(/ /g, '%s');
  shell(`input text "${safe}"`);
}
function swipe(x1, y1, x2, y2, d = 300) {
  shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`);
}

// ── UIAutomator ───────────────────────────────────────────────────────────────

async function getXML(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    shell('uiautomator dump /sdcard/ui.xml 2>/dev/null');
    const xml = shell('cat /sdcard/ui.xml 2>/dev/null', 5000);
    if (xml && xml.includes('<hierarchy')) return xml;
    await sleep(1000);
  }
  throw new Error('Failed to get UI XML');
}

function getAllText(xml) {
  const texts = [];
  const textRe = /text="([^"]*)"/g;
  const descRe = /content-desc="([^"]*)"/g;
  let m;
  while ((m = textRe.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
  while ((m = descRe.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
  return [...new Set(texts)];
}

function parseBounds(boundsStr) {
  const m = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!m) return null;
  return {
    x: Math.round((+m[1] + +m[3]) / 2),
    y: Math.round((+m[2] + +m[4]) / 2)
  };
}

function findElement(xml, text) {
  const lower = text.toLowerCase();
  const pattern = new RegExp(`(?:text|content-desc)="([^"]*${text}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi');
  const matches = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const [, txt, bounds] = match;
    const coords = parseBounds(bounds);
    if (coords) matches.push({ text: txt, coords, exact: txt.toLowerCase() === lower });
  }
  if (matches.length === 0) return null;
  return matches.find(m => m.exact) || matches[0];
}

// ── Verification ──────────────────────────────────────────────────────────────

async function verifyScreen(expectedTexts, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const expectedArray = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  
  while (Date.now() < deadline) {
    const xml = await getXML();
    const allTexts = getAllText(xml);
    const pageText = allTexts.join(' | ').substring(0, 200);
    
    for (const expected of expectedArray) {
      if (xml.toLowerCase().includes(expected.toLowerCase())) {
        log('VERIFY', `✓ Found "${expected}"`);
        log('SCREEN', `${pageText}...`);
        return { success: true, found: expected, allTexts, xml };
      }
    }
    await sleep(1000);
  }
  
  const xml = await getXML();
  const allTexts = getAllText(xml);
  log('VERIFY', `✗ Expected [${expectedArray.join(', ')}] NOT found`);
  log('SCREEN', `Visible: ${allTexts.join(' | ').substring(0, 200)}...`);
  return { success: false, found: null, allTexts, xml };
}

async function waitFor(text, timeoutMs = 30000) {
  log('WAIT', `"${text}"...`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) throw new Error(`Timeout: "${text}"`);
  const el = findElement(result.xml, text);
  return { ...result, element: el };
}

async function tapAny(options, description, timeout = 10000) {
  log('TAP', `Looking for: ${description}...`);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const xml = await getXML();
    for (const opt of options) {
      const el = findElement(xml, opt);
      if (el) {
        log('TAP', `"${opt}" → (${el.coords.x},${el.coords.y})`);
        tap(el.coords.x, el.coords.y);
        await sleep(1000);
        return { success: true, tapped: opt, xml };
      }
    }
    await sleep(500);
  }
  return { success: false };
}

async function tapVerified(text, expectedAfter, timeout = 30000) {
  log('ACTION', `Tap "${text}" → expect "${expectedAfter}"...`);
  const before = await waitFor(text, timeout);
  tap(before.element.coords.x, before.element.coords.y);
  await sleep(1500);
  
  const after = await verifyScreen(expectedAfter, 10000);
  if (!after.success) {
    throw new Error(`Tap "${text}" failed. Expected "${expectedAfter}", got: ${after.allTexts.join(' | ')}`);
  }
  log('ACTION', `✓ Success: now at "${after.found}"`);
  return after;
}

async function typeVerified(fieldText, value, expectedAfter) {
  log('ACTION', `Type into "${fieldText}" → expect "${expectedAfter}"...`);
  const field = await waitFor(fieldText);
  tap(field.element.coords.x, field.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(value);
  await sleep(800);
  
  const after = await verifyScreen(expectedAfter, 8000);
  if (!after.success && !after.allTexts.join(' ').includes(value.substring(0, 8))) {
    throw new Error(`Type failed. Expected "${expectedAfter}", got: ${after.allTexts.join(' | ')}`);
  }
  log('ACTION', `✓ Success: "${value.substring(0, 5)}..." entered`);
  return after;
}

// ── Chrome Setup ──────────────────────────────────────────────────────────────

async function setupChrome() {
  /**
   * Handle Chrome first-run screens:
   * 1. "Welcome to Chrome" → "Use without an account"
   * 2. "Turn on sync?" → "No thanks" or dismiss
   * 3. Terms acceptance → "Accept & continue"
   */
  log('CHROME_SETUP', 'Checking for first-run screens...');
  
  // Check if we're on welcome screen
  let check = await verifyScreen(['Welcome to Chrome', 'Use without an account', 'Add account'], 5000);
  
  if (check.success) {
    log('CHROME_SETUP', 'Detected welcome screen, dismissing...');
    
    // Tap "Use without an account"
    const res = await tapAny(['Use without an account', 'Use without an account'], 'skip account');
    await sleep(2000);
    
    // Handle "Turn on sync?" or "No thanks"
    const syncCheck = await verifyScreen(['Turn on sync', 'No thanks', 'Accept', 'Continue'], 5000);
    if (syncCheck.found === 'Turn on sync' || syncCheck.found === 'No thanks') {
      await tapAny(['No thanks', 'Not now'], 'decline sync');
      await sleep(2000);
    }
    
    // Handle Terms/Accept screen
    const termsCheck = await verifyScreen(['Accept', 'Continue', 'Terms of Service', 'By continuing'], 5000);
    if (termsCheck.success) {
      await tapAny(['Accept & continue', 'Continue', 'Accept'], 'accept terms');
      await sleep(2000);
    }
    
    // Wait for browser to be ready
    await sleep(3000);
  }
  
  // Verify we have address bar now
  const finalCheck = await verifyScreen(['Search or type URL', 'Address bar', 'New tab', 'Chrome'], 10000);
  if (!finalCheck.success) {
    // Try pressing back to dismiss any remaining dialogs
    keyevent('KEYCODE_BACK');
    await sleep(1000);
    const retry = await verifyScreen(['Search', 'Address', 'URL', 'Chrome'], 5000);
    if (!retry.success) throw new Error('Cannot get Chrome to main browser view');
  }
  log('CHROME_SETUP', '✓ Chrome ready for navigation');
}

// ── Webhook ───────────────────────────────────────────────────────────────────

async function webhook(event, extra = {}) {
  if (!WEBHOOK_URL) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event, phone_number: PHONE, telegram_user_id: parseInt(USER_ID, 10), run_id: RUN_ID, ...extra
    });
    const u = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const options = {
      hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      log('WEBHOOK', `${event} → ${res.statusCode}`);
      resolve();
    });
    req.on('error', () => resolve());
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting automation for ${PHONE}`);

  // 1. Boot check
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error('Emulator not ready');
  await verifyScreen(['Google', 'Chrome', 'Home']);
  log('STEP 1', '✓ Emulator ready');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  await verifyScreen(['Google', 'Chrome', 'Apps']);
  log('STEP 2', '✓ Device awake');

  // 3. Launch Chrome + handle welcome screens
  log('STEP 3', 'Launching Chrome...');
  shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
  await sleep(4000);
  
  // Handle Chrome first-run/setup screens
  await setupChrome();
  log('STEP 3', '✓ Chrome initialized');

  // 4. Navigate to URL
  log('STEP 4', `Navigating to ${TARGET_URL}...`);
  tap(400, 150); // Address bar
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(TARGET_URL);
  await sleep(500);
  keyevent('KEYCODE_ENTER');
  
  // Verify page loaded - look for VMOS login elements
  const navCheck = await verifyScreen([
    'Please enter your email address',
    'Login/Register',
    'Email',
    'VMOS',
    'Cloud'
  ], 15000);
  log('STEP 4', `✓ Page loaded: "${navCheck.found}"`);

  // 5. Enter Email
  log('STEP 5', 'Entering email...');
  await typeVerified(
    'Please enter your email address',
    EMAIL,
    ['Please enter your password', 'Password', 'Login']
  );
  log('STEP 5', '✓ Email entered');

  // 6. Click Login/Register
  log('STEP 6', 'Clicking Login/Register...');
  await tapVerified('Login/Register', ['Please enter your password', 'Password', 'Login']);
  log('STEP 6', '✓ Login/Register clicked');

  // 7. Enter Password
  log('STEP 7', 'Entering password...');
  await typeVerified(
    'Please enter your password',
    PASSWORD,
    ['Login', 'Log in', 'Sign in', 'Submit']
  );
  log('STEP 7', '✓ Password entered');

  // 8. Click Login
  log('STEP 8', 'Clicking Login...');
  await tapVerified('Login', ['US', 'EU', 'Region', 'Dashboard', 'WhatsApp', 'Instances']);
  log('STEP 8', '✓ Logged in');

  // 9. Click US
  log('STEP 9', 'Selecting US region...');
  await tapVerified('US', ['WhatsApp1', 'WhatsApp', 'Available', 'Running']);
  log('STEP 9', '✓ US region selected');

  // 10. Click WhatsApp1
  log('STEP 10', 'Clicking WhatsApp1...');
  await tapVerified('WhatsApp1', ['Loading', 'Connecting', 'Launch', 'Open', 'Start']);
  log('STEP 10', '✓ WhatsApp1 clicked');

  // Complete
  log('COMPLETE', 'Stopped at WhatsApp1 as requested');
  shell('screencap -p /sdcard/final.png');
  adb('pull /sdcard/final.png /tmp/vmos_final.png');
  await webhook('vmos_complete', { stopped_at: 'whatsapp1' });
}

// ── Error Handler ─────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    shell('screencap -p /sdcard/error.png');
    adb('pull /sdcard/error.png /tmp/vmos_error.png');
    const xml = await getXML();
    const texts = getAllText(xml);
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
