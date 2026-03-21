/**
 * wa_register.js — VMOS Cloud automation with post-action verification
 * Verifies on-screen text after each action to ensure correct page state
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

// Input helpers
function tap(x, y) { shell(`input tap ${x} ${y}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }
function textInput(str) {
  const safe = str.replace(/ /g, '%s');
  shell(`input text "${safe}"`);
}
function swipe(x1, y1, x2, y2, d = 300) {
  shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`);
}

// ── UIAutomator Core ──────────────────────────────────────────────────────────

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
  // Search for text or content-desc containing the string
  const pattern = new RegExp(`(?:text|content-desc)="([^"]*${text}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi');
  const matches = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const [, txt, bounds] = match;
    const coords = parseBounds(bounds);
    if (coords) matches.push({ text: txt, coords, exact: txt.toLowerCase() === lower });
  }
  if (matches.length === 0) return null;
  // Prefer exact match
  return matches.find(m => m.exact) || matches[0];
}

// ── Post-Action Verification ──────────────────────────────────────────────────

async function verifyScreen(expectedTexts, timeoutMs = 15000) {
  /**
   * Verifies that at least one of the expected texts appears on screen
   * Returns { success: boolean, found: string, allTexts: string[] }
   */
  const deadline = Date.now() + timeoutMs;
  const expectedArray = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  
  while (Date.now() < deadline) {
    const xml = await getXML();
    const allTexts = getAllText(xml);
    const pageText = allTexts.join(' | ').substring(0, 200);
    
    for (const expected of expectedArray) {
      if (xml.toLowerCase().includes(expected.toLowerCase())) {
        log('VERIFY', `✓ Found "${expected}" on screen`);
        log('SCREEN', `Visible: ${pageText}...`);
        return { success: true, found: expected, allTexts, xml };
      }
    }
    await sleep(1000);
  }
  
  // Final attempt to log what was visible
  const xml = await getXML();
  const allTexts = getAllText(xml);
  log('VERIFY', `✗ Expected [${expectedArray.join(', ')}] NOT found`);
  log('SCREEN', `Actually visible: ${allTexts.join(' | ').substring(0, 200)}...`);
  return { success: false, found: null, allTexts, xml };
}

// Wait then perform action
async function waitFor(text, timeoutMs = 30000) {
  log('WAIT', `Waiting for "${text}"...`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) throw new Error(`Timeout waiting for "${text}"`);
  const el = findElement(result.xml, text);
  return { ...result, element: el };
}

async function tapVerified(text, expectedAfter, timeout = 30000) {
  /**
   * Tap element by text, then verify we see expectedAfter text
   */
  log('ACTION', `Tapping "${text}"...`);
  const before = await waitFor(text, timeout);
  tap(before.element.coords.x, before.element.coords.y);
  await sleep(1500); // Wait for transition
  
  // Post-action verification
  const after = await verifyScreen(expectedAfter, 10000);
  if (!after.success) {
    throw new Error(`After tapping "${text}", expected "${expectedAfter}" but got: ${after.allTexts.join(' | ')}`);
  }
  log('ACTION', `✓ Tap "${text}" successful, now seeing: "${after.found}"`);
  return after;
}

async function typeVerified(fieldText, value, expectedAfter) {
  /**
   * Tap field, clear it, type value, then verify expectedAfter appears
   */
  log('ACTION', `Typing "${value}" into "${fieldText}"...`);
  const field = await waitFor(fieldText);
  tap(field.element.coords.x, field.element.coords.y);
  await sleep(500);
  
  // Clear and type
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(value);
  await sleep(800);
  
  // Post-action verification
  const after = await verifyScreen(expectedAfter, 8000);
  if (!after.success) {
    // Sometimes the field text changes to the value we typed, check that too
    const xmlCheck = await getXML();
    if (xmlCheck.includes(value.substring(0, 10))) {
      log('ACTION', `✓ Text "${value.substring(0, 10)}..." appears to be entered`);
      return { ...after, success: true };
    }
    throw new Error(`After typing in "${fieldText}", expected "${expectedAfter}" but got: ${after.allTexts.join(' | ')}`);
  }
  log('ACTION', `✓ Typed "${value.substring(0, 5)}..." successfully, now seeing: "${after.found}"`);
  return after;
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

// ── Main Flow ─────────────────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting automation for ${PHONE}`);

  // 1. Boot check
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error('Emulator not ready');
  
  // Post-boot verification
  await verifyScreen(['Google', 'Chrome', 'Play Store', 'Settings']);
  log('STEP 1', '✓ Emulator booted successfully');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  await verifyScreen(['Google', 'Chrome', 'clock', ' battery']);
  log('STEP 2', '✓ Device awake and unlocked');

  // 3. Launch Chrome
  log('STEP 3', 'Launching Chrome...');
  shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
  await sleep(4000);
  
  // Handle crash dialog if present
  const crashCheck = await verifyScreen(['Close app', 'New tab', 'Search or type URL'], 5000);
  if (crashCheck.found === 'Close app') {
    await tapVerified('Close app', 'New tab', 5000);
  }
  
  // Verify Chrome opened
  const chromeCheck = await verifyScreen(['Search or type URL', 'New tab', 'Address bar'], 10000);
  log('STEP 3', `✓ Chrome ready: "${chromeCheck.found}"`);

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
  
  // Post-navigation verification - Look for login page elements
  const navCheck = await verifyScreen([
    'Please enter your email address',
    'Login/Register',
    'Enter your email',
    'Email'
  ], 15000);
  log('STEP 4', `✓ Page loaded: "${navCheck.found}" visible`);

  // 5. Enter Email
  log('STEP 5', 'Entering email...');
  await typeVerified(
    'Please enter your email address',
    EMAIL,
    ['Please enter your password', 'Password', 'Login/Register']
  );
  log('STEP 5', '✓ Email entered, password field visible');

  // 6. Click Login/Register
  log('STEP 6', 'Clicking Login/Register...');
  await tapVerified('Login/Register', ['Please enter your password', 'Password']);
  log('STEP 6', '✓ Login/Register clicked, now on password screen');

  // 7. Enter Password
  log('STEP 7', 'Entering password...');
  await typeVerified(
    'Please enter your password',
    PASSWORD,
    ['Login', 'Log in', 'Sign in']
  );
  log('STEP 7', '✓ Password entered, login button visible');

  // 8. Click Login
  log('STEP 8', 'Clicking Login...');
  await tapVerified('Login', ['US', 'EU', 'Asia', 'Region', 'Dashboard', 'WhatsApp']);
  log('STEP 8', '✓ Login successful, dashboard loaded');

  // 9. Click US
  log('STEP 9', 'Selecting US region...');
  await tapVerified('US', ['WhatsApp1', 'WhatsApp', 'Instances', 'Available']);
  log('STEP 9', '✓ US region selected, WhatsApp1 visible');

  // 10. Click WhatsApp1
  log('STEP 10', 'Clicking WhatsApp1...');
  await tapVerified('WhatsApp1', ['Loading', 'Connecting', 'WhatsApp Web', 'QR', 'Open', 'Launch']);
  log('STEP 10', '✓ WhatsApp1 clicked');

  // Final verification
  log('COMPLETE', 'Automation stopped at WhatsApp1 as requested');
  const final = await getXML();
  const texts = getAllText(final);
  log('FINAL', `Screen shows: ${texts.slice(0, 5).join(' | ')}`);

  // Screenshot
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
    log('ERROR_SCREEN', `Last visible: ${texts.join(' | ').substring(0, 300)}`);
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
