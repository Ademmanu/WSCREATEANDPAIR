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

// ── Post-Action Verification ──────────────────────────────────────────────────

async function verifyScreen(expectedTexts, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const expectedArray = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  
  while (Date.now() < deadline) {
    const xml = await getXML();
    const lowerXml = xml.toLowerCase();
    
    for (const expected of expectedArray) {
      if (lowerXml.includes(expected.toLowerCase())) {
        log('VERIFY', `✓ Found "${expected}" on screen`);
        return { success: true, found: expected, xml };
      }
    }
    await sleep(800);
  }
  
  const finalXml = await getXML();
  log('VERIFY', `✗ Expected [${expectedArray.join(', ')}] NOT found`);
  return { success: false, found: null, xml: finalXml };
}

// Wait for element to appear on screen
async function waitFor(text, timeoutMs = 30000) {
  log('WAIT', `Waiting for "${text}"...`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) throw new Error(`Timeout waiting for "${text}"`);
  const el = findElement(result.xml, text);
  if (!el) throw new Error(`Found "${text}" in XML but could not parse bounds`);
  return { xml: result.xml, element: el };
}

// Tap element by text with post-action verification
async function tapAndVerify(text, expectedAfter, timeout = 30000) {
  log('ACTION', `Tapping "${text}"...`);
  const before = await waitFor(text, timeout);
  tap(before.element.coords.x, before.element.coords.y);
  await sleep(1500);
  
  const after = await verifyScreen(expectedAfter, 8000);
  if (!after.success) {
    log('ACTION', `⚠ After tapping "${text}", expected [${Array.isArray(expectedAfter) ? expectedAfter.join(', ') : expectedAfter}]`);
    // Don't throw, just log warning and continue
  } else {
    log('ACTION', `✓ Tap successful, now seeing: "${after.found}"`);
  }
  return after;
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
  
  // Handle Chrome welcome/setup screen (first run)
  const welcomeCheck = await verifyScreen([
    'Welcome to Chrome',
    'Use without an account',
    'Add account to device',
    'Accept & continue',
    'Terms of Service',
    'Search or type URL'
  ], 8000);
  
  if (welcomeCheck.found === 'Welcome to Chrome' || 
      welcomeCheck.found === 'Use without an account' ||
      welcomeCheck.found === 'Add account to device') {
    log('CHROME', 'Welcome screen detected, skipping setup...');
    
    // Click "Use without an account"
    const noAccount = findElement(welcomeCheck.xml, 'Use without an account');
    if (noAccount) {
      tap(noAccount.coords.x, noAccount.coords.y);
    } else {
      tap(800, 1700); // Coordinate fallback (bottom right)
    }
    log('CHROME', '✓ Clicked "Use without an account"');
    await sleep(2000);
    
    // Look for Accept & continue
    const acceptCheck = await verifyScreen(['Accept & continue', 'Next', 'Continue'], 5000);
    if (acceptCheck.success) {
      const btn = findElement(acceptCheck.xml, acceptCheck.found);
      if (btn) tap(btn.coords.x, btn.coords.y);
      else tap(800, 1600);
      log('CHROME', `✓ Clicked "${acceptCheck.found}"`);
      await sleep(2000);
    }
    
    // Handle "No thanks" for sync
    const syncCheck = await verifyScreen(['No thanks', 'Not now'], 3000);
    if (syncCheck.success) {
      const skipBtn = findElement(syncCheck.xml, syncCheck.found);
      if (skipBtn) tap(skipBtn.coords.x, skipBtn.coords.y);
      else tap(250, 1550);
      log('CHROME', `✓ Clicked "${syncCheck.found}"`);
      await sleep(2000);
    }
  }
  
  // Handle crash dialog if present
  const crashCheck = await verifyScreen(['Close app', 'Search or type URL'], 3000);
  if (crashCheck.found === 'Close app') {
    const closeBtn = findElement(crashCheck.xml, 'Close app');
    if (closeBtn) tap(closeBtn.coords.x, closeBtn.coords.y);
    await sleep(1000);
    shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
    await sleep(3000);
  }
  
  // Post-action: Verify Chrome is ready
  const chromeReady = await verifyScreen(['Search or type URL', 'New tab', 'Address bar'], 8000);
  if (chromeReady.success) {
    log('CHROME', `✓ Chrome ready: "${chromeReady.found}"`);
  } else {
    log('CHROME', '⚠ Chrome may not be fully ready, proceeding anyway');
  }

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
  
  // Post-action: Verify page loaded
  const navCheck = await verifyScreen([
    'Please enter your email address',
    'Login/Register',
    'Email',
    'VMOS',
    'Cloud'
  ], 15000);
  if (navCheck.success) {
    log('NAVIGATE', `✓ Page loaded: "${navCheck.found}"`);
  } else {
    log('NAVIGATE', '⚠ Page may not have loaded correctly');
  }

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
  
  // Post-action: Verify email entered (field may show typed text or stay with hint)
  const emailCheck = await verifyScreen([
    'Please enter your password',
    'Login/Register',
    'emmanueladeloye',
    EMAIL.substring(0, 10)
  ], 5000);
  log('FORM', emailCheck.success ? `✓ Email entered` : '⚠ Email field state unclear');

  // 6. Click Login/Register
  log('FORM', 'Step: Click Login/Register');
  await tapAndVerify('Login/Register', ['Please enter your password', 'Password', 'Login']);

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
  
  // Post-action: Verify password field state
  const passCheck = await verifyScreen(['Login', 'Log in', 'Sign in', 'Emma2007'], 5000);
  log('FORM', passCheck.success ? `✓ Password entered` : '⚠ Password field state unclear');

  // 8. Click Login
  log('FORM', 'Step: Click Login');
  await tapAndVerify('Login', ['US', 'EU', 'Asia', 'Region', 'Dashboard', 'WhatsApp', 'Welcome']);

  // 9. Click US
  log('NAVIGATE', 'Step: Select US region');
  await tapAndVerify('US', ['WhatsApp1', 'WhatsApp', 'Instances', 'Available', 'Select']);

  // 10. Click WhatsApp1
  log('NAVIGATE', 'Step: Select WhatsApp1');
  await tapAndVerify('WhatsApp1', ['Loading', 'Connecting', 'Launch', 'Open', 'Start', 'WhatsApp']);

  // Stop here
  log('COMPLETE', 'Automation stopped at WhatsApp1 as requested');
  
  // Final verification
  const finalCheck = await verifyScreen(['Loading', 'Connecting', 'WhatsApp', 'VMOS', 'Cloud'], 5000);
  log('COMPLETE', finalCheck.success ? `✓ Final state: "${finalCheck.found}"` : '⚠ Final state unclear');
  
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
