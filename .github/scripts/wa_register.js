/**
 * wa_register.js — VMOS Cloud automation via ADB + UIAutomator
 * Controls Chrome inside Android emulator to navigate cloud.vmoscloud.com
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

// Execute shell command with timeout
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

// ADB wrappers
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

// Input commands
function tap(x, y) { shell(`input tap ${x} ${y}`); }
function swipe(x1, y1, x2, y2, d = 300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }
function textInput(str) {
  // Replace spaces with %s for adb shell input
  const safe = str.replace(/ /g, '%s');
  shell(`input text "${safe}"`);
}

// ── UIAutomator XML Parsing ───────────────────────────────────────────────────

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

// Parse bounds="[left,top][right,bottom]" and calculate center
function parseBounds(boundsStr) {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    x: Math.round((left + right) / 2),
    y: Math.round((top + bottom) / 2)
  };
}

// Find element by text or content-desc (partial match supported)
function findElement(xml, searchText) {
  const lowerSearch = searchText.toLowerCase();
  
  // Try exact match first
  const exactRe = new RegExp(`(?:text|content-desc)="([^"]*${searchText}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi');
  let match;
  const matches = [];
  
  while ((match = exactRe.exec(xml)) !== null) {
    const [, text, bounds] = match;
    const coords = parseBounds(bounds);
    if (coords) matches.push({ text, bounds, coords, exact: text.toLowerCase() === lowerSearch });
  }
  
  if (matches.length === 0) return null;
  
  // Prefer exact match, otherwise first partial
  const best = matches.find(m => m.exact) || matches[0];
  return best;
}

// Wait for element to appear on screen
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

// Tap element by text
async function tapByText(text, xml = null) {
  if (!xml) xml = await getXML();
  const el = findElement(xml, text);
  if (!el) {
    log('TAP', `WARNING: "${text}" not found, skipping`);
    return false;
  }
  log('TAP', `"${text}" → (${el.coords.x},${el.coords.y})`);
  tap(el.coords.x, el.coords.y);
  await sleep(1000);
  return true;
}

// ── Webhook Helper ────────────────────────────────────────────────────────────

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
    req.on('error', (e) => { log('WEBHOOK', `Error: ${e.message}`); resolve(); });
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ── Main Automation Flow ──────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting VMOS Cloud automation for phone: ${PHONE}`);
  
  // 1. Check emulator ready
  log('DEVICE', 'Checking emulator status...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  log('DEVICE', '✓ Emulator ready');

  // 2. Wake up
  log('DEVICE', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  log('DEVICE', '✓ Device awake');

  // 3. Launch Chrome
  log('CHROME', 'Launching Chrome...');
  shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
  await sleep(4000);
  
  // Handle crash dialogs
  const crashXml = await getXML();
  if (crashXml.includes('Close app')) {
    await tapByText('Close app', crashXml);
    await sleep(1000);
    shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
    await sleep(3000);
  }
  log('CHROME', '✓ Chrome launched');

  // 4. Navigate to URL
  log('NAVIGATE', `Opening ${TARGET_URL}`);
  tap(400, 150); // Address bar (approximate top center)
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(TARGET_URL);
  await sleep(500);
  keyevent('KEYCODE_ENTER');
  await sleep(6000); // Wait for page load
  log('NAVIGATE', '✓ Page loaded');

  // 5. Enter Email
  log('FORM', 'Step: Enter email address');
  const emailField = await waitFor('Please enter your email address');
  tap(emailField.element.coords.x, emailField.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(EMAIL);
  log('FORM', `✓ Email entered: ${EMAIL}`);
  await sleep(800);

  // 6. Click Login/Register
  log('FORM', 'Step: Click Login/Register');
  const loginReg = await waitFor('Login/Register');
  tap(loginReg.element.coords.x, loginReg.element.coords.y);
  log('FORM', '✓ Login/Register clicked');
  await sleep(3000);

  // 7. Enter Password
  log('FORM', 'Step: Enter password');
  const passField = await waitFor('Please enter your password');
  tap(passField.element.coords.x, passField.element.coords.y);
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(PASSWORD);
  log('FORM', '✓ Password entered');
  await sleep(800);

  // 8. Click Login
  log('FORM', 'Step: Click Login');
  const loginBtn = await waitFor('Login');
  tap(loginBtn.element.coords.x, loginBtn.element.coords.y);
  log('FORM', '✓ Login clicked');
  await sleep(5000); // Wait for auth

  // 9. Click US
  log('NAVIGATE', 'Step: Select US region');
  const usBtn = await waitFor('US', 15000);
  tap(usBtn.element.coords.x, usBtn.element.coords.y);
  log('NAVIGATE', '✓ US selected');
  await sleep(3000);

  // 10. Click WhatsApp1
  log('NAVIGATE', 'Step: Select WhatsApp1');
  const waBtn = await waitFor('WhatsApp1', 15000);
  tap(waBtn.element.coords.x, waBtn.element.coords.y);
  log('NAVIGATE', '✓ WhatsApp1 selected');
  await sleep(2000);

  // Stop here
  log('COMPLETE', 'Automation stopped at WhatsApp1 as requested');
  
  // Screenshot for verification
  shell('screencap -p /sdcard/final.png');
  adb('pull /sdcard/final.png /tmp/vmos_final.png');
  log('DEBUG', 'Screenshot: /tmp/vmos_final.png');
  
  await webhook('vmos_stopped', { step: 'whatsapp1_selected' });
}

// ── Entry Point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    shell('screencap -p /sdcard/error.png');
    adb('pull /sdcard/error.png /tmp/vmos_error.png');
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
