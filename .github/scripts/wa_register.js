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

// ── UIAutomator XML Parsing ───────────────────────────────────────────────────

async function getXML(timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Use --compressed for faster dump and avoid notification shade issues
    shell('uiautomator dump --compressed /sdcard/ui.xml 2>/dev/null');
    const xml = shell('cat /sdcard/ui.xml 2>/dev/null', 5000);
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

function extractTextsFromXML(xml) {
  const texts = [];
  const textRe = /text="([^"]*)"/g;
  const descRe = /content-desc="([^"]*)"/g;
  let m;
  while ((m = textRe.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
  while ((m = descRe.exec(xml)) !== null) if (m[1]) texts.push(m[1]);
  return [...new Set(texts)].filter(t => t.length > 0);
}

async function getVisibleText() {
  const xml = await getXML();
  return extractTextsFromXML(xml);
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
  await sleep(5000);
  
  // POST-ACTION: Check screen without using uiautomator first (use dumpsys instead)
  log('POST-ACTION', 'Checking Chrome window...');
  const windowDump = shell('dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp" 2>/dev/null');
  log('POST-ACTION', `Window state: ${windowDump.substring(0, 100)}`);
  
  // Now get UI text
  let chromeTexts = [];
  try {
    const xml = await getXML();
    chromeTexts = extractTextsFromXML(xml);
    log('POST-ACTION', `Screen shows: ${chromeTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {
    log('POST-ACTION', 'Could not get UI dump, proceeding...');
  }
  
  // Check for welcome screen
  const hasWelcome = chromeTexts.some(t => 
    t.includes('Welcome to Chrome') || 
    t.includes('Use without an account') ||
    t.includes('Add account to device')
  );
  
  if (hasWelcome) {
    log('STEP 4', 'First run setup detected, handling...');
    tap(800, 1700); // "Use without an account"
    await sleep(2000);
    tap(800, 1600); // "Accept & continue"
    await sleep(2000);
    tap(250, 1550); // "No thanks"
    await sleep(3000);
    log('STEP 4', '✓ Setup completed');
    
    // Show screen after setup
    try {
      const afterXml = await getXML();
      const afterTexts = extractTextsFromXML(afterXml);
      log('POST-ACTION', `After setup - Screen shows: ${afterTexts.slice(0, 10).join(' | ')}`);
    } catch (e) {
      log('POST-ACTION', 'Could not get post-setup screen');
    }
  }
  
  // Ensure Chrome is in foreground
  shell('am start -n com.android.chrome/com.google.android.apps.chrome.Main 2>/dev/null');
  await sleep(2000);

  // 5. Navigate to URL
  log('STEP 5', `Navigating to ${TARGET_URL}...`);
  tap(400, 150); // Address bar
  await sleep(1000);
  keyevent('KEYCODE_CTRL_A');
  await sleep(300);
  keyevent('KEYCODE_DEL');
  await sleep(300);
  textInput(TARGET_URL);
  await sleep(800);
  keyevent('KEYCODE_ENTER');
  await sleep(8000); // Longer wait for page load
  
  // POST-ACTION: Verify page loaded
  log('POST-ACTION', 'Verifying page loaded...');
  let pageTexts = [];
  try {
    const pageXml = await getXML();
    pageTexts = extractTextsFromXML(pageXml);
    log('POST-ACTION', `Screen shows: ${pageTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {
    log('POST-ACTION', 'Could not get page screen');
  }
  
  // Check if we need to dismiss any overlay
  const hasOverlay = pageTexts.some(t => 
    t.includes('Allow') || 
    t.includes('permission') ||
    t.includes('Chrome notifications')
  );
  
  if (hasOverlay) {
    log('POST-ACTION', 'Overlay detected, dismissing...');
    keyevent('KEYCODE_BACK'); // Try back button first
    await sleep(1000);
    // Re-check
    try {
      const reCheckXml = await getXML();
      const reCheckTexts = extractTextsFromXML(reCheckXml);
      log('POST-ACTION', `After dismiss - Screen shows: ${reCheckTexts.slice(0, 10).join(' | ')}`);
    } catch (e) {}
  }
  
  const navCheck = await verifyScreen([
    'Please enter your email address',
    'Login/Register',
    'Email',
    'VMOS',
    'Cloud'
  ], 10000);
  log('POST-ACTION', navCheck.success ? `✓ Page loaded: "${navCheck.found}"` : '⚠ Page may not have loaded');

  // 6. Enter Email
  log('STEP 6', 'Entering email...');
  const emailField = await waitFor('Please enter your email address');
  tap(emailField.element.coords.x, emailField.element.coords.y);
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(300);
  keyevent('KEYCODE_DEL');
  await sleep(300);
  textInput(EMAIL);
  await sleep(1000);
  
  // POST-ACTION: Verify after email
  log('POST-ACTION', 'Verifying after email entry...');
  try {
    const emailXml = await getXML();
    const emailTexts = extractTextsFromXML(emailXml);
    log('POST-ACTION', `Screen shows: ${emailTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}

  // 7. Click Login/Register
  log('STEP 7', 'Clicking Login/Register...');
  const loginReg = await waitFor('Login/Register');
  tap(loginReg.element.coords.x, loginReg.element.coords.y);
  await sleep(4000);
  
  // POST-ACTION: Verify after Login/Register
  log('POST-ACTION', 'Verifying after Login/Register click...');
  try {
    const lrXml = await getXML();
    const lrTexts = extractTextsFromXML(lrXml);
    log('POST-ACTION', `Screen shows: ${lrTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  const lrCheck = await verifyScreen(['Please enter your password', 'Password', 'Login'], 5000);
  log('POST-ACTION', lrCheck.success ? `✓ Now on: "${lrCheck.found}"` : '⚠ State unclear');

  // 8. Enter Password
  log('STEP 8', 'Entering password...');
  const passField = await waitFor('Please enter your password');
  tap(passField.element.coords.x, passField.element.coords.y);
  await sleep(800);
  keyevent('KEYCODE_CTRL_A');
  await sleep(300);
  keyevent('KEYCODE_DEL');
  await sleep(300);
  textInput(PASSWORD);
  await sleep(1000);
  
  // POST-ACTION: Verify after password
  log('POST-ACTION', 'Verifying after password entry...');
  try {
    const passXml = await getXML();
    const passTexts = extractTextsFromXML(passXml);
    log('POST-ACTION', `Screen shows: ${passTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}

  // 9. Click Login
  log('STEP 9', 'Clicking Login...');
  const loginBtn = await waitFor('Login');
  tap(loginBtn.element.coords.x, loginBtn.element.coords.y);
  await sleep(6000);
  
  // POST-ACTION: Verify after Login
  log('POST-ACTION', 'Verifying after Login click...');
  try {
    const loginXml = await getXML();
    const loginTexts = extractTextsFromXML(loginXml);
    log('POST-ACTION', `Screen shows: ${loginTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  const loginCheck = await verifyScreen(['US', 'EU', 'Asia', 'Dashboard', 'WhatsApp', 'Region'], 8000);
  log('POST-ACTION', loginCheck.success ? `✓ Logged in, seeing: "${loginCheck.found}"` : '⚠ Login state unclear');

  // 10. Click US
  log('STEP 10', 'Clicking US...');
  const usBtn = await waitFor('US');
  tap(usBtn.element.coords.x, usBtn.element.coords.y);
  await sleep(4000);
  
  // POST-ACTION: Verify after US
  log('POST-ACTION', 'Verifying after US click...');
  try {
    const usXml = await getXML();
    const usTexts = extractTextsFromXML(usXml);
    log('POST-ACTION', `Screen shows: ${usTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  const usCheck = await verifyScreen(['WhatsApp1', 'WhatsApp', 'Instances', 'Available'], 5000);
  log('POST-ACTION', usCheck.success ? `✓ US selected, seeing: "${usCheck.found}"` : '⚠ US state unclear');

  // 11. Click WhatsApp1
  log('STEP 11', 'Clicking WhatsApp1...');
  const waBtn = await waitFor('WhatsApp1');
  tap(waBtn.element.coords.x, waBtn.element.coords.y);
  await sleep(3000);
  
  // POST-ACTION: Verify after WhatsApp1
  log('POST-ACTION', 'Verifying after WhatsApp1 click...');
  try {
    const waXml = await getXML();
    const waTexts = extractTextsFromXML(waXml);
    log('POST-ACTION', `Screen shows: ${waTexts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  const waCheck = await verifyScreen(['Loading', 'Connecting', 'Launch', 'Open', 'WhatsApp', 'Start'], 5000);
  log('POST-ACTION', waCheck.success ? `✓ WhatsApp1 clicked, seeing: "${waCheck.found}"` : '⚠ WhatsApp1 state unclear');

  // Complete
  log('COMPLETE', 'Stopped at WhatsApp1 as requested');
  
  // Final screenshot using screencap (doesn't interfere with UI)
  shell('screencap -p /sdcard/final.png 2>/dev/null');
  adb('pull /sdcard/final.png /tmp/vmos_final.png 2>/dev/null');
  log('DEBUG', 'Screenshot saved');
  
  await webhook('vmos_stopped', { step: 'whatsapp1_selected' });
}

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    shell('screencap -p /sdcard/error.png 2>/dev/null');
    adb('pull /sdcard/error.png /tmp/vmos_error.png 2>/dev/null');
    const xml = await getXML();
    const texts = extractTextsFromXML(xml);
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
