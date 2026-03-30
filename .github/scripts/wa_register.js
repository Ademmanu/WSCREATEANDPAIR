/**
 * wa_register.js — WhatsApp Mobile Registration Automation
 * Uses Android emulator with WhatsApp APK to generate session for monitoring/pairing
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
const SCREENSHOT_DIR = '/tmp/screenshots';

const WHATSAPP_PACKAGE = 'com.whatsapp';
const WHATSAPP_ACTIVITY = 'com.whatsapp.Main';

// ── Logging & Utilities ───────────────────────────────────────────────────────

function log(step, message) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${step}] ${message}`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function exec(cmd, timeoutMs = 30000) {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  }
}

function adb(args, timeout = 30000) {
  return exec(`adb ${args}`, timeout);
}

function shell(cmd, timeout = 30000) {
  return exec(`adb shell ${cmd}`, timeout);
}

function tap(x, y) { shell(`input tap ${x} ${y}`); }
function swipe(x1, y1, x2, y2, d = 300) { shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }
function textInput(str) {
  const safe = str.replace(/ /g, '%s');
  shell(`input text "${safe}"`);
}

// ── Screenshot System ─────────────────────────────────────────────────────────

let screenshotCounter = 0;

function takeScreenshot(name) {
  screenshotCounter++;
  const filename = `${String(screenshotCounter).padStart(3, '0')}_${name}.png`;
  const devicePath = `/sdcard/screenshot_${Date.now()}.png`;
  const localPath = path.join(SCREENSHOT_DIR, filename);
  
  try {
    shell(`screencap -p ${devicePath}`);
    adb(`pull ${devicePath} ${localPath}`);
    shell(`rm ${devicePath}`);
    log('SCREENSHOT', `Saved: ${filename}`);
    return localPath;
  } catch (e) {
    log('SCREENSHOT', `Failed to take screenshot: ${e.message}`);
    return null;
  }
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

// ── Post-Action Verification ─────────────────────────────────────────────────

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
  
  return [...new Set(texts)].filter(t => {
    if (t.length < 2 || t.length > 100) return false;
    if (/^[A-Za-z0-9+/=]{20,}$/.test(t)) return false;
    const commonLabels = ['Welcome', 'Agree', 'Continue', 'Next', 'Phone', 'number', 'Verify', 'SMS', 'Call', 'Code', 'WhatsApp', 'Terms', 'Privacy', 'Policy', 'Continue', 'OK', 'Allow', 'Deny', 'Skip', 'Done'];
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
  log('INIT', `Starting WhatsApp registration for phone: ${PHONE}`);
  
  // Ensure screenshot directory exists
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  
  // 1. Check emulator
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  takeScreenshot('01_emulator_ready');
  log('STEP 1', '✓ Emulator ready');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  takeScreenshot('02_device_awake');
  log('STEP 2', '✓ Device awake');

  // 3. Grant WhatsApp permissions BEFORE launching
  log('STEP 3', 'Granting WhatsApp permissions...');
  const WHATSAPP_PERMS = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.RECEIVE_SMS',
    'android.permission.SEND_SMS',
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.VIBRATE',
    'android.permission.WAKE_LOCK',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.POST_NOTIFICATIONS'
  ];
  for (const perm of WHATSAPP_PERMS) {
    shell(`pm grant ${WHATSAPP_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  takeScreenshot('03_permissions_granted');
  log('STEP 3', '✓ Permissions granted');

  // 4. Launch WhatsApp
  log('STEP 4', 'Launching WhatsApp...');
  shell(`am start -n ${WHATSAPP_PACKAGE}/${WHATSAPP_ACTIVITY}`);
  await sleep(5000);
  
  // POST-ACTION: Show screen
  log('POST-ACTION', 'Verifying WhatsApp launched...');
  const whatsappTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${whatsappTexts.slice(0, 10).join(' | ')}`);
  takeScreenshot('04_whatsapp_launched');
  
  // Verify WhatsApp is on welcome/terms screen
  const welcomeCheck = await verifyScreen([
    'Welcome to WhatsApp',
    'Terms of Service',
    'Privacy Policy',
    'Agree and continue',
    'Read more',
    'from Meta',
    'Welcome'
  ], 10000);
  
  if (!welcomeCheck.success) {
    throw new Error('WhatsApp did not launch properly or unexpected screen');
  }
  log('POST-ACTION', `✓ WhatsApp ready: "${welcomeCheck.found}"`);

  // 5. Click "Agree and continue"
  log('STEP 5', 'Clicking Agree and continue...');
  const agreeBtn = await waitFor('Agree and continue');
  tap(agreeBtn.element.coords.x, agreeBtn.element.coords.y);
  await sleep(2000);
  
  // POST-ACTION: Screenshot and verify
  takeScreenshot('05_agree_clicked');
  const afterAgreeTexts = await getVisibleText();
  log('POST-ACTION', `After Agree - Screen shows: ${afterAgreeTexts.slice(0, 10).join(' | ')}`);
  
  // Verify we're on phone number entry screen or permissions dialog
  const phoneCheck = await verifyScreen([
    'Phone number',
    'Enter your phone number',
    'Continue',
    'Allow WhatsApp to send and view SMS messages',
    'Allow',
    'Deny'
  ], 8000);
  
  if (!phoneCheck.success) {
    log('POST-ACTION', '⚠ Phone number screen not detected, checking current state...');
  } else {
    log('POST-ACTION', `✓ Now on: "${phoneCheck.found}"`);
  }

  // STOP HERE as requested - after Agree and continue
  log('COMPLETE', 'Stopped after "Agree and continue" as requested');
  
  // Final screenshot
  await sleep(1000);
  takeScreenshot('99_final_stopped');
  
  // Send webhook indicating we're ready for phone number entry
  await webhook('whatsapp_ready', { 
    step: 'after_agree_continue',
    screen: 'Phone number entry ready',
    message: 'WhatsApp launched and terms accepted. Ready for phone number entry.'
  });
  
  log('COMPLETE', 'WhatsApp is ready for phone number registration');
}

main().catch(async (err) => {
  log('FATAL', err.message);
  takeScreenshot('error_fatal');
  try {
    const texts = await getVisibleText();
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
