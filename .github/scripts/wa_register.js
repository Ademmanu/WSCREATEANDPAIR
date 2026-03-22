/**
 * wa_register.js — VMOS Cloud automation via ADB + UIAutomator
 * Coordinate-based approach to avoid focus loss from XML dumps
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Configuration ─────────────────────────────────────────────────────────────

const PHONE = process.env.PHONE_NUMBER;
const USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID = process.env.GITHUB_RUN_ID;

const TARGET_URL = 'https://cloud.vmoscloud.com/';
const EMAIL = 'emmanueladeloye2023@gmail.com';
const PASSWORD = 'Emma2007';
const SCRIPT_DIR = '/tmp/wa_scripts';

// ── Logging & Utilities ───────────────────────────────────────────────────────

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
function swipe(x1, y1, x2, y2, d = 300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }
function textInput(str) {
  const safe = str.replace(/ /g, '%s');
  shell(`input text "${safe}"`);
}

// ── UIAutomator (used only for finding elements, not post-action checks) ────────

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
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  };
}

function findElement(xml, searchText) {
  const lowerSearch = searchText.toLowerCase();
  const exactRe = new RegExp(`(?:text|content-desc)="([^"]*${searchText}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi');
  let match;
  const matches = [];
  
  while ((match = exactRe.exec(xml)) !== null) {
    const [, text, bounds] = match;
    const coords = parseBounds(bounds);
    if (coords) matches.push({ text, bounds, coords, exact: text.toLowerCase() === lowerSearch });
  }
  
  if (matches.length === 0) return null;
  return matches.find(m => m.exact) || matches[0];
}

async function waitFor(text, timeoutMs = 30000) {
  log('WAIT', `Waiting for "${text}"...`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await getXML();
    const el = findElement(xml, text);
    if (el) {
      log('FOUND', `"${text}" at (${el.coords.x},${el.coords.y})`);
      return { xml, element: el };
    }
    await sleep(1500);
  }
  throw new Error(`Timeout waiting for "${text}"`);
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

// ── Main Automation Flow ──────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting automation for phone: ${PHONE}`);
  
  // 1. Check emulator
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  log('STEP 1', '✓ Emulator ready');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  log('STEP 2', '✓ Device awake');

  // 3. Grant Chrome permissions BEFORE launching
  log('STEP 3', 'Granting Chrome permissions...');
  const CHROME_PERMS = [
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS'
  ];
  for (const perm of CHROME_PERMS) {
    shell(`pm grant com.android.chrome ${perm} 2>/dev/null || true`);
  }
  log('STEP 3', '✓ Permissions granted');

  // 4. Launch Chrome
  log('STEP 4', 'Launching Chrome...');
  shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
  await sleep(4000);
  
  // Handle welcome screen with fixed coordinates (no XML check after launch)
  // Just tap the common positions for welcome screen buttons
  log('STEP 4', 'Handling potential welcome screen...');
  tap(800, 1700); // "Use without an account" - bottom right
  await sleep(2000);
  tap(800, 1600); // "Accept & continue" or "Next"
  await sleep(2000);
  tap(250, 1550); // "No thanks" for sync (left side)
  await sleep(2000);
  log('STEP 4', '✓ Chrome ready');

  // 5. Navigate to URL
  log('STEP 5', `Navigating to ${TARGET_URL}...`);
  tap(400, 150); // Address bar
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(TARGET_URL);
  await sleep(500);
  keyevent('KEYCODE_ENTER');
  await sleep(6000);
  log('STEP 5', '✓ Page loaded');

  // 6. Enter Email
  log('STEP 6', 'Entering email...');
  const emailField = await waitFor('Please enter your email address');
  tap(emailField.element.coords.x, emailField.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(EMAIL);
  await sleep(800);
  log('STEP 6', '✓ Email entered');

  // 7. Click Login/Register
  log('STEP 7', 'Clicking Login/Register...');
  const loginReg = await waitFor('Login/Register');
  tap(loginReg.element.coords.x, loginReg.element.coords.y);
  await sleep(3000);
  log('STEP 7', '✓ Login/Register clicked');

  // 8. Enter Password
  log('STEP 8', 'Entering password...');
  const passField = await waitFor('Please enter your password');
  tap(passField.element.coords.x, passField.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(PASSWORD);
  await sleep(800);
  log('STEP 8', '✓ Password entered');

  // 9. Click Login
  log('STEP 9', 'Clicking Login...');
  const loginBtn = await waitFor('Login');
  tap(loginBtn.element.coords.x, loginBtn.element.coords.y);
  await sleep(5000);
  log('STEP 9', '✓ Login clicked');

  // 10. Click US
  log('STEP 10', 'Clicking US...');
  const usBtn = await waitFor('US');
  tap(usBtn.element.coords.x, usBtn.element.coords.y);
  await sleep(3000);
  log('STEP 10', '✓ US selected');

  // 11. Click WhatsApp1
  log('STEP 11', 'Clicking WhatsApp1...');
  const waBtn = await waitFor('WhatsApp1');
  tap(waBtn.element.coords.x, waBtn.element.coords.y);
  await sleep(2000);
  log('STEP 11', '✓ WhatsApp1 clicked');

  // Complete
  log('COMPLETE', 'Stopped at WhatsApp1 as requested');
  
  shell('screencap -p /sdcard/final.png');
  adb('pull /sdcard/final.png /tmp/vmos_final.png');
  log('DEBUG', 'Screenshot saved');
  
  await webhook('vmos_stopped', { step: 'whatsapp1_selected' });
}

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    shell('screencap -p /sdcard/error.png');
    adb('pull /sdcard/error.png /tmp/vmos_error.png');
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});

