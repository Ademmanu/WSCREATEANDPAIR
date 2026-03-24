/**
 * wa_register.js — VMOS Cloud automation via ADB + UIAutomator
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

const TARGET_URL = 'https://cloud.vmoscloud.com/login';
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

// ── Post-Action Verification ──────────────────────────────────────────────────

async function getVisibleText() {
  const xml = await getXML();
  const texts = [];
  const textRe = /text="([^"]*)"/g;
  const descRe = /content-desc="([^"]*)"/g;
  let m;
  
  while ((m = textRe.exec(xml)) !== null) {
    if (m[1]) texts.push(m[1]);
  }
  while ((m = descRe.exec(xml)) !== null) {
    if (m[1]) texts.push(m[1]);
  }
  
  // Filter out garbage: base64, long random strings, and image data
  return [...new Set(texts)].filter(t => {
    // Must be reasonable length (not too short, not too long)
    if (t.length < 2 || t.length > 100) return false;
    // Must not be base64-like (long strings with base64 chars only)
    if (/^[A-Za-z0-9+/=]{20,}$/.test(t)) return false;
    // Must contain at least one space or be a recognizable word
    // Or be a common UI label
    const commonLabels = ['Login', 'Register', 'Email', 'Password', 'Submit', 'Continue', 'Next', 'Back', 'Home', 'Search', 'VMOS', 'Cloud', 'WhatsApp', 'US', 'EU', 'Asia'];
    const hasCommonWord = commonLabels.some(label => t.toLowerCase().includes(label.toLowerCase()));
    const hasSpace = t.includes(' ');
    const isReasonable = /^[A-Za-z0-9\s\-_./@&]+$/.test(t);
    return (hasSpace || hasCommonWord) && isReasonable;
  });
}

async function verifyScreen(expectedTexts, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const expectedArray = Array.isArray(expectedTexts) ? expectedTexts : [expectedTexts];
  
  while (Date.now() < deadline) {
    const xml = await getXML();
    const lowerXml = xml.toLowerCase();
    
    for (const expected of expectedArray) {
      if (lowerXml.includes(expected.toLowerCase())) {
        return { success: true, found: expected, xml };
      }
    }
    await sleep(800);
  }
  
  const finalXml = await getXML();
  return { success: false, found: null, xml: finalXml };
}

async function waitFor(text, timeoutMs = 30000) {
  log('WAIT', `Waiting for "${text}"...`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) throw new Error(`Timeout waiting for "${text}"`);
  const el = findElement(result.xml, text);
  if (!el) throw new Error(`Found "${text}" but no bounds`);
  return { xml: result.xml, element: el };
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

  // 3. Grant Chrome permissions BEFORE launching (prevents dialogs)
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
  
  // POST-ACTION: Show screen FIRST before handling anything
  log('POST-ACTION', 'Verifying Chrome launched...');
  const chromeTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${chromeTexts.slice(0, 10).join(' | ')}`);
  
  // Handle welcome screen (precise detection)
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
    log('STEP 4', 'Welcome screen detected, skipping setup...');
    
    // Click "Use without an account"
    const noAccount = findElement(welcomeCheck.xml, 'Use without an account');
    if (noAccount) {
      tap(noAccount.coords.x, noAccount.coords.y);
    } else {
      tap(800, 1700); // Coordinate fallback (bottom right)
    }
    log('STEP 4', '✓ Clicked "Use without an account"');
    await sleep(2000);
    
    // Look for Accept & continue
    const acceptCheck = await verifyScreen(['Accept & continue', 'Next', 'Continue'], 5000);
    if (acceptCheck.success) {
      const btn = findElement(acceptCheck.xml, acceptCheck.found);
      if (btn) tap(btn.coords.x, btn.coords.y);
      else tap(800, 1600); // Fallback
      log('STEP 4', `✓ Clicked "${acceptCheck.found}"`);
      await sleep(2000);
    }
    
    // Handle "No thanks" for sync
    const syncCheck = await verifyScreen(['No thanks', 'Not now'], 3000);
    if (syncCheck.success) {
      const skipBtn = findElement(syncCheck.xml, syncCheck.found);
      if (skipBtn) tap(skipBtn.coords.x, skipBtn.coords.y);
      else tap(250, 1550); // "No thanks" usually on left
      log('STEP 4', `✓ Clicked "${syncCheck.found}"`);
      await sleep(2000);
    }
    
    // Show screen after setup
    const afterSetupTexts = await getVisibleText();
    log('POST-ACTION', `After setup - Screen shows: ${afterSetupTexts.slice(0, 10).join(' | ')}`);
  }
  
  // Final Chrome ready check
  const chromeReady = await verifyScreen([
    'Search or type URL',
    'Search or type web address',
    'New tab',
    'Address bar',
    'Discover'
  ], 5000);
  log('POST-ACTION', chromeReady.success ? `✓ Chrome ready: "${chromeReady.found}"` : '⚠ Chrome state unclear');

  // 5. Navigate to URL - Use UIAutomator to find address bar properly
  log('STEP 5', `Navigating to ${TARGET_URL}...`);
  
  // Find and tap address bar by text (avoids microphone icon)
  try {
    const addressBar = await waitFor('Search or type web address');
    tap(addressBar.element.coords.x, addressBar.element.coords.y);
    log('STEP 5', '✓ Tapped address bar');
  } catch (e) {
    // Fallback: try 'Search or type URL' variant
    try {
      const addressBar2 = await waitFor('Search or type URL');
      tap(addressBar2.element.coords.x, addressBar2.element.coords.y);
      log('STEP 5', '✓ Tapped address bar (URL variant)');
    } catch (e2) {
      // Last resort: coordinate tap on left side
      log('STEP 5', '⚠ Could not find address bar, using coordinate fallback');
      tap(150, 150);
    }
  }
  
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(TARGET_URL);
  await sleep(500);
  keyevent('KEYCODE_ENTER');
  await sleep(6000);
  
  // POST-ACTION: Verify page loaded
  log('POST-ACTION', 'Verifying page loaded...');
  const pageTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${pageTexts.slice(0, 10).join(' | ')}`);
  const navCheck = await verifyScreen([
    'Please enter your email address',
    'Login/Register',
    'Email',
    'VMOS',
    'Cloud',
    'Password',
    'Login'
  ], 10000);
  log('POST-ACTION', navCheck.success ? `✓ Page loaded: "${navCheck.found}"` : '⚠ Page may not have loaded');

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
  
  // POST-ACTION: Verify after email
  log('POST-ACTION', 'Verifying after email entry...');
  const emailTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${emailTexts.slice(0, 10).join(' | ')}`);

  // 7. Click Login/Register
  log('STEP 7', 'Clicking Login/Register...');
  const loginReg = await waitFor('Login/Register');
  tap(loginReg.element.coords.x, loginReg.element.coords.y);
  await sleep(3000);
  
  // POST-ACTION: Verify after Login/Register
  log('POST-ACTION', 'Verifying after Login/Register click...');
  const lrTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${lrTexts.slice(0, 10).join(' | ')}`);
  const lrCheck = await verifyScreen(['Please enter your password', 'Password', 'Login'], 5000);
  log('POST-ACTION', lrCheck.success ? `✓ Now on: "${lrCheck.found}"` : '⚠ State unclear');

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
  
  // POST-ACTION: Verify after password
  log('POST-ACTION', 'Verifying after password entry...');
  const passTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${passTexts.slice(0, 10).join(' | ')}`);

  // 9. Click Login
  log('STEP 9', 'Clicking Login...');
  const loginBtn = await waitFor('Login');
  tap(loginBtn.element.coords.x, loginBtn.element.coords.y);
  await sleep(5000);
  
  // POST-ACTION: Verify after Login
  log('POST-ACTION', 'Verifying after Login click...');
  const loginTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${loginTexts.slice(0, 10).join(' | ')}`);
  const loginCheck = await verifyScreen(['US', 'EU', 'Asia', 'Dashboard', 'WhatsApp', 'Region'], 8000);
  log('POST-ACTION', loginCheck.success ? `✓ Logged in, seeing: "${loginCheck.found}"` : '⚠ Login state unclear');

  // 10. Click US
  log('STEP 10', 'Clicking US...');
  const usBtn = await waitFor('US');
  tap(usBtn.element.coords.x, usBtn.element.coords.y);
  await sleep(3000);
  
  // POST-ACTION: Verify after US
  log('POST-ACTION', 'Verifying after US click...');
  const usTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${usTexts.slice(0, 10).join(' | ')}`);
  const usCheck = await verifyScreen(['WhatsApp1', 'WhatsApp', 'Instances', 'Available'], 5000);
  log('POST-ACTION', usCheck.success ? `✓ US selected, seeing: "${usCheck.found}"` : '⚠ US state unclear');

  // 11. Click WhatsApp1
  log('STEP 11', 'Clicking WhatsApp1...');
  const waBtn = await waitFor('WhatsApp1');
  tap(waBtn.element.coords.x, waBtn.element.coords.y);
  await sleep(2000);
  
  // POST-ACTION: Verify after WhatsApp1
  log('POST-ACTION', 'Verifying after WhatsApp1 click...');
  const waTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${waTexts.slice(0, 10).join(' | ')}`);
  const waCheck = await verifyScreen(['Loading', 'Connecting', 'Launch', 'Open', 'WhatsApp', 'Start'], 5000);
  log('POST-ACTION', waCheck.success ? `✓ WhatsApp1 clicked, seeing: "${waCheck.found}"` : '⚠ WhatsApp1 state unclear');

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
    const texts = await getVisibleText();
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
