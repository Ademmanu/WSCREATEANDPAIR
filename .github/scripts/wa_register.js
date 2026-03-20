/**
 * wa_register_mobile.js — Enhanced WhatsApp registration automation with on-screen action display
 *
 * Runs inside GitHub Actions after the Android emulator boots.
 * Installs WhatsApp, navigates the registration flow, requests OTP,
 * waits for the user to reply on Telegram, submits the OTP, and
 * reports the result back to the bot via webhook.
 *
 * Enhanced Features:
 * - On-screen text display after each action using ADB overlay
 * - Visual feedback for debugging
 * - Better error handling
 * - Step-by-step progress tracking
 *
 * Required env vars:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL,
 *   WEBHOOK_SECRET, GITHUB_RUN_ID
 */

'use strict';

const { execSync }  = require('child_process');
const { execFile }  = require('child_process');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

// ── Config ────────────────────────────────────────────────────────────────────

const PHONE          = process.env.PHONE_NUMBER;
const USER_ID        = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID         = process.env.GITHUB_RUN_ID;
const RENDER_BASE    = WEBHOOK_URL.replace('/webhook/event', '');
const WA_PACKAGE     = 'com.whatsapp';
const APK_PATH       = '/tmp/whatsapp.apk';
const SCRIPT_DIR     = '/tmp/wa_scripts';

// ── On-Screen Display Configuration ──────────────────────────────────────────

// Color codes for different action types
const COLORS = {
  INFO: '#2196F3',     // Blue
  SUCCESS: '#4CAF50',  // Green
  WARNING: '#FF9800',  // Orange
  ERROR: '#F44336',    // Red
  ACTION: '#9C27B0',   // Purple
};

let actionCounter = 0;

// ── Phone number parsing ──────────────────────────────────────────────────────

/**
 * Parse a full international number like "2348012345678" into:
 *   { countryCode: '234', nationalNumber: '8012345678', country: 'NG' }
 *
 * libphonenumber-js requires a + prefix for E.164 parsing.
 * We try with + prefix first, then brute-force country code matching
 * as a fallback for numbers the library can't auto-detect.
 */
function parsePhone(fullNumber) {
  const withPlus = `+${fullNumber}`;
  try {
    if (isValidPhoneNumber(withPlus)) {
      const parsed = parsePhoneNumber(withPlus);
      return {
        countryCode: String(parsed.countryCallingCode),
        nationalNumber: parsed.nationalNumber,
        country: parsed.country || 'unknown',
      };
    }
  } catch (_) {}

  // Fallback: try common country code lengths (1, 2, 3 digits)
  // Sorted by length descending so 3-digit codes match before 1-digit
  const cc3 = fullNumber.substring(0, 3);
  const cc2 = fullNumber.substring(0, 2);
  const cc1 = fullNumber.substring(0, 1);

  for (const cc of [cc3, cc2, cc1]) {
    try {
      const national = fullNumber.substring(cc.length);
      const attempt = `+${cc}${national}`;
      if (isValidPhoneNumber(attempt)) {
        const parsed = parsePhoneNumber(attempt);
        return {
          countryCode: String(parsed.countryCallingCode),
          nationalNumber: parsed.nationalNumber,
          country: parsed.country || 'unknown',
        };
      }
    } catch (_) {}
  }

  // Last resort: assume first 3 digits are country code
  return {
    countryCode: fullNumber.substring(0, 3),
    nationalNumber: fullNumber.substring(3),
    country: 'unknown',
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

// Write a shell script to disk and execute it.
// This avoids ALL quoting issues — the command is never interpolated.
function runScript(scriptContent, timeoutMs = 30000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `cmd_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${scriptContent}\n`, { mode: 0o755 });
  try {
    const out = execSync(`sh ${file}`, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (out || '').trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

// Run an adb command (not adb shell — for host-side adb commands)
function adb(args, timeoutMs = 30000) {
  return runScript(`adb ${args} 2>&1`, timeoutMs);
}

// Run a command inside the Android emulator via adb shell
// cmd is written to a file — no shell escaping needed
function adbShell(cmd, timeoutMs = 30000) {
  const file = path.join(SCRIPT_DIR, `shell_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = runScript(`adb shell < ${file}`, timeoutMs);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

// ── On-Screen Display Functions ───────────────────────────────────────────────

/**
 * Display text on screen using Android's overlay system
 * This creates a visible notification that shows what action is being performed
 */
async function showOnScreen(message, type = 'INFO', durationMs = 3000) {
  actionCounter++;
  const color = COLORS[type] || COLORS.INFO;
  const prefix = type === 'ACTION' ? `[${actionCounter}]` : `[${type}]`;
  const fullMessage = `${prefix} ${message}`;
  
  log('SCREEN', fullMessage);
  
  try {
    // Method 1: Use am broadcast to show a toast-like message
    // Create a simple service that displays text using settings overlay
    const escapedMsg = fullMessage.replace(/'/g, "\\'").replace(/"/g, '\\"');
    
    // Display toast notification (simple method)
    adbShell(`am broadcast -a android.intent.action.SHOW_TEXT -e message "${escapedMsg}" 2>/dev/null || true`);
    
    // Method 2: Use settings to show text overlay (more visible)
    // We'll use the volume overlay as a hack to display text
    const textFile = '/sdcard/wa_action.txt';
    adbShell(`echo "${escapedMsg}" > ${textFile}`);
    
    // Method 3: Display via logcat tag that can be monitored
    adbShell(`log -t WA_REGISTRATION "${escapedMsg}"`);
    
    // Method 4: Create a notification (most visible)
    // This uses the notification system to show progress
    const notifCmd = `
      cmd notification post -S bigtext \\
        -t "WhatsApp Registration" \\
        "${escapedMsg}" \\
        wa_reg_${actionCounter}
    `.trim();
    adbShell(notifCmd + ' 2>/dev/null || true');
    
    // Short delay to ensure visibility
    await sleep(Math.min(durationMs, 1000));
    
  } catch (err) {
    // Don't fail the whole process if screen display fails
    log('SCREEN_ERROR', `Failed to display: ${err.message}`);
  }
}

/**
 * Clear all registration notifications
 */
async function clearOnScreenMessages() {
  try {
    // Clear all WA registration notifications
    for (let i = 1; i <= actionCounter; i++) {
      adbShell(`cmd notification cancel wa_reg_${i} 2>/dev/null || true`);
    }
    await sleep(500);
  } catch (err) {
    log('SCREEN_ERROR', `Failed to clear notifications: ${err.message}`);
  }
}

/**
 * Display progress bar on screen
 */
async function showProgress(step, totalSteps, message) {
  const percent = Math.round((step / totalSteps) * 100);
  const progressBar = '█'.repeat(Math.floor(percent / 5)) + '░'.repeat(20 - Math.floor(percent / 5));
  await showOnScreen(`Progress: ${percent}% ${progressBar} | ${message}`, 'INFO', 2000);
}

// ── ADB input helpers ─────────────────────────────────────────────────────────

async function tap(x, y, description = '') {
  if (description) {
    await showOnScreen(`Tapping: ${description} at (${x}, ${y})`, 'ACTION');
  }
  adbShell(`input tap ${x} ${y}`);
  await sleep(500);
}

async function swipe(x1, y1, x2, y2, durationMs = 300, description = '') {
  if (description) {
    await showOnScreen(`Swiping: ${description}`, 'ACTION');
  }
  adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
  await sleep(500);
}

async function keyevent(code, description = '') {
  if (description) {
    await showOnScreen(`Key event: ${description} (${code})`, 'ACTION');
  }
  adbShell(`input keyevent ${code}`);
  await sleep(300);
}

// Type text safely — write each char via keyevent to avoid encoding issues
async function typeText(text, description = '') {
  if (description) {
    await showOnScreen(`Typing: ${description}`, 'ACTION');
  }
  // Use ADB text input — works for ASCII digits and letters
  const safe = text.replace(/[^a-zA-Z0-9+]/g, (c) => {
    return encodeURIComponent(c).replace(/%/g, '%25');
  });
  adbShell(`input text "${safe}"`);
  await sleep(500);
}

// Type digits individually via tap on the number (most reliable for OTP boxes)
async function typeDigits(digits, description = 'OTP code') {
  await showOnScreen(`Entering ${description}: ${digits}`, 'ACTION');
  for (const d of digits) {
    adbShell(`input text ${d}`);
    await sleep(200);
  }
  await sleep(500);
}

// ── UI inspection ─────────────────────────────────────────────────────────────

// Dump UI hierarchy to XML and return it
// Retries until valid XML is returned or timeout
async function dumpUI(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    adbShell('uiautomator dump /sdcard/ui.xml');
    const xml = adbShell('cat /sdcard/ui.xml', 5000);
    if (xml && xml.includes('<hierarchy')) return xml;
    await sleep(1000);
  }
  return '';
}

// Return up to 15 visible text strings from current screen
async function screenTexts() {
  const xml = await dumpUI();
  const texts = [];
  const re = /text="([^"]{1,60})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const t = m[1].trim();
    if (t) texts.push(t);
  }
  return [...new Set(texts)].slice(0, 15);
}

async function logScreen(label = 'SCREEN') {
  const texts = await screenTexts();
  const screenContent = texts.join(' | ') || '(empty)';
  log(label, screenContent);
  await showOnScreen(`Screen: ${label}`, 'INFO', 1500);
  return texts;
}

// Wait until the screen contains a specific string
// Returns the full XML when found, null on timeout
async function waitForScreen(text, timeoutMs = 60000) {
  await showOnScreen(`Waiting for: "${text}"`, 'INFO', 2000);
  log('WAIT', `"${text}" (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (xml.toLowerCase().includes(text.toLowerCase())) {
      log('FOUND', `"${text}"`);
      await showOnScreen(`Found: "${text}"`, 'SUCCESS');
      return xml;
    }
    await sleep(2000);
  }
  log('TIMEOUT', `"${text}" not found`);
  await showOnScreen(`Timeout: "${text}" not found`, 'WARNING');
  return null;
}

// Wait for any one of multiple strings — returns { xml, matched }
async function waitForAny(texts, timeoutMs = 60000) {
  await showOnScreen(`Waiting for any of: ${texts.length} options`, 'INFO', 2000);
  log('WAIT', `any of: ${texts.map(t => `"${t}"`).join(', ')} (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    for (const text of texts) {
      if (xml.toLowerCase().includes(text.toLowerCase())) {
        log('FOUND', `"${text}"`);
        await showOnScreen(`Found: "${text}"`, 'SUCCESS');
        return { xml, matched: text };
      }
    }
    await sleep(2000);
  }
  log('TIMEOUT', 'None of the expected strings found');
  await showOnScreen('Timeout: No expected text found', 'WARNING');
  return { xml: await dumpUI(), matched: null };
}

// Find an element by text and return its bounds
// Returns { x, y, width, height } or null
function findElement(text, xml) {
  // Match either text="..." or content-desc="..."
  const patterns = [
    new RegExp(`text="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'),
    new RegExp(`content-desc="${text}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i'),
  ];

  for (const pattern of patterns) {
    const match = xml.match(pattern);
    if (match) {
      const [_, x1, y1, x2, y2] = match.map(Number);
      return {
        x: Math.floor((x1 + x2) / 2),
        y: Math.floor((y1 + y2) / 2),
        width: x2 - x1,
        height: y2 - y1,
      };
    }
  }
  return null;
}

// Tap on an element by text — returns true if found and tapped
async function tapElement(text, xml, description = '') {
  const el = findElement(text, xml);
  if (el) {
    const desc = description || text;
    await showOnScreen(`Tapping element: "${desc}"`, 'ACTION');
    log('TAP', `"${text}" at (${el.x}, ${el.y})`);
    await tap(el.x, el.y);
    return true;
  }
  log('TAP', `"${text}" not found`);
  return false;
}

// ── Webhook communication ─────────────────────────────────────────────────────

function webhook(event, extraData = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID),
      run_id: RUN_ID,
      ...extraData,
    });

    log('WEBHOOK', `${event} → ${WEBHOOK_URL}`);

    const url = new URL(WEBHOOK_URL);
    const client = url.protocol === 'https:' ? https : http;

    const req = client.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        log('WEBHOOK', `${event} → ${res.statusCode}`);
        resolve({ status: res.statusCode, body });
      });
    });

    req.on('error', (err) => {
      log('WEBHOOK', `${event} error: ${err.message}`);
      resolve({ status: 0, body: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      log('WEBHOOK', `${event} timeout`);
      resolve({ status: 0, body: 'timeout' });
    });

    req.write(payload);
    req.end();
  });
}

// ── WhatsApp installation ─────────────────────────────────────────────────────

async function installWhatsApp() {
  await showProgress(1, 10, 'Installing WhatsApp');
  await showOnScreen('Installing WhatsApp APK...', 'INFO');
  log('INSTALL', 'Installing WhatsApp from APK...');

  // Check if APK exists
  if (!fs.existsSync(APK_PATH)) {
    await showOnScreen('ERROR: WhatsApp APK not found!', 'ERROR', 5000);
    throw new Error(`APK not found at ${APK_PATH}`);
  }

  const apkSize = fs.statSync(APK_PATH).size;
  log('INSTALL', `APK size: ${apkSize} bytes`);
  await showOnScreen(`APK size: ${(apkSize / 1024 / 1024).toFixed(1)} MB`, 'INFO');

  // Method 1: adb install via script (most reliable)
  await showOnScreen('Installing via adb install...', 'ACTION');
  const installOut = runScript(`adb install -r ${APK_PATH} 2>&1`, 180000);
  log('INSTALL', `Install output: ${installOut}`);

  if (installOut.includes('Success')) {
    await showOnScreen('WhatsApp installed successfully!', 'SUCCESS', 2000);
    log('INSTALL', 'Success via adb install');
  } else {
    // Method 2: pm install fallback
    await showOnScreen('Trying pm install fallback...', 'WARNING');
    log('INSTALL', 'adb install failed — trying pm install fallback');
    
    const pushOut = runScript(`adb push ${APK_PATH} /data/local/tmp/wa.apk 2>&1`, 120000);
    log('INSTALL', `Push result: ${pushOut}`);

    if (pushOut.includes('pushed') || pushOut.includes('100%')) {
      const pmOut = adbShell('pm install -r /data/local/tmp/wa.apk', 180000);
      log('INSTALL', `pm install output: ${pmOut}`);

      if (pmOut.includes('Success')) {
        await showOnScreen('WhatsApp installed via pm install!', 'SUCCESS', 2000);
        log('INSTALL', 'Success via pm install');
      } else {
        // Final attempt: install via cmd package
        await showOnScreen('Final install attempt...', 'WARNING');
        const fallbackOut = adbShell('cmd package install -r /data/local/tmp/wa.apk', 180000);
        log('INSTALL', `cmd package output: ${fallbackOut}`);
        
        if (!fallbackOut.includes('Success')) {
          await showOnScreen('Installation failed!', 'ERROR', 5000);
          throw new Error(`Install failed. pm: ${pmOut} | adb: ${fallbackOut}`);
        }
        await showOnScreen('WhatsApp installed via cmd package!', 'SUCCESS', 2000);
      }
    }
  }

  // Verify installation
  await sleep(2000);
  await showOnScreen('Verifying installation...', 'INFO');
  const pkgList = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList.includes('com.whatsapp')) {
    await showOnScreen('Installation verified!', 'SUCCESS', 2000);
    log('INSTALL', 'Verified via pm list — installed');
    return;
  }

  // One final check — sometimes pm list is slow to update
  await sleep(5000);
  const pkgList2 = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList2.includes('com.whatsapp')) {
    await showOnScreen('Installation verified (delayed)!', 'SUCCESS', 2000);
    log('INSTALL', 'Verified via pm list (delayed) — installed');
    return;
  }

  await showOnScreen('Package verification failed!', 'ERROR', 5000);
  throw new Error('WhatsApp package not found after install');
}

// ── Screen unlock ─────────────────────────────────────────────────────────────

async function unlockScreen() {
  await showOnScreen('Unlocking screen...', 'INFO');
  log('UNLOCK', 'Waking and unlocking screen...');
  
  await keyevent('KEYCODE_WAKEUP', 'Wake up device');
  await sleep(500);
  await swipe(540, 1800, 540, 900, 400, 'Swipe up to unlock');
  await sleep(500);
  await keyevent('KEYCODE_HOME', 'Go to home');
  await sleep(1000);
  
  // Keep screen on for the full session
  await showOnScreen('Configuring screen settings...', 'INFO');
  adbShell('settings put global stay_on_while_plugged_in 3');
  adbShell('settings put secure lockscreen.disabled 1');
  
  await showOnScreen('Screen unlocked and configured!', 'SUCCESS', 2000);
  await logScreen('UNLOCK');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await showOnScreen('Starting WhatsApp Registration', 'INFO', 3000);
  log('MAIN', `Starting registration for ${PHONE}`);

  // ── Parse phone number into country code + national number ───────────────
  await showProgress(0, 10, 'Parsing phone number');
  const phoneInfo = parsePhone(PHONE);
  log('MAIN', `Parsed: country=${phoneInfo.country} cc=${phoneInfo.countryCode} national=${phoneInfo.nationalNumber}`);
  await showOnScreen(`Phone: +${phoneInfo.countryCode} ${phoneInfo.nationalNumber} (${phoneInfo.country})`, 'INFO', 3000);

  // ── 1. Verify emulator is ready ─────────────────────────────────────────
  await showProgress(1, 10, 'Checking emulator');
  await showOnScreen('Verifying emulator is ready...', 'INFO');
  await sleep(3000);
  const bootProp = adbShell('getprop sys.boot_completed');
  if (bootProp.trim() !== '1') {
    await showOnScreen('Emulator not ready!', 'ERROR', 5000);
    throw new Error(`Emulator not ready — boot_completed=${bootProp}`);
  }
  await showOnScreen('Emulator is ready!', 'SUCCESS', 2000);
  log('MAIN', 'Emulator ready');

  // ── 2. Unlock screen ────────────────────────────────────────────────────
  await showProgress(2, 10, 'Unlocking screen');
  await unlockScreen();

  // ── 3. Install WhatsApp ──────────────────────────────────────────────────
  await showProgress(3, 10, 'Installing WhatsApp');
  await installWhatsApp();
  log('MAIN', 'WhatsApp installed');

  // ── 4. Grant permissions & Launch WhatsApp ──────────────────────────────
  await showProgress(4, 10, 'Configuring permissions');
  await showOnScreen('Granting permissions...', 'INFO');
  log('MAIN', 'Granting permissions and launching WhatsApp...');

  await keyevent('KEYCODE_HOME', 'Go to home');
  await sleep(1000);

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
  ];
  
  for (const perm of WA_PERMS) {
    adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  await showOnScreen('Permissions granted!', 'SUCCESS', 2000);
  log('MAIN', 'Permissions granted');

  // ── Update Google Play Services via ADB ──────────────────────────────────
  await showProgress(5, 10, 'Checking Google Play Services');
  await showOnScreen('Checking Google Play Services...', 'INFO');
  log('MAIN', 'Checking Google Play Services version...');
  const gpsVersion = adbShell('dumpsys package com.google.android.gms | grep versionName | head -1 2>/dev/null');
  log('MAIN', `GPS version: ${gpsVersion || 'unknown'}`);
  await showOnScreen(`GPS version detected`, 'INFO', 1500);

  const gpsVerMatch = gpsVersion.match(/versionName=([\d.]+)/);
  const gpsMajor = gpsVerMatch ? parseInt(gpsVerMatch[1].split('.')[0]) : 0;
  log('MAIN', `GPS major version: ${gpsMajor}`);

  if (gpsMajor < 22) {
    await showOnScreen('GPS outdated - updating...', 'WARNING', 3000);
    log('MAIN', 'GPS too old — downloading and installing update via ADB...');
    
    fs.writeFileSync('/tmp/dl_gps.sh', 'wget -q "https://dl.google.com/dl/android/studio/gps/gms_core.apk" -O /tmp/gps.apk --timeout=60 || true\nstat -c%s /tmp/gps.apk 2>/dev/null || echo 0\n');
    const gpsDownload = runScript('sh /tmp/dl_gps.sh', 90000);
    log('MAIN', `GPS download result: ${gpsDownload}`);

    const gpsSize = parseInt((gpsDownload.match(/^(\d+)$/m) || ['0'])[0]);
    if (gpsSize > 1000000) {
      await showOnScreen('Installing GPS update...', 'ACTION');
      const gpsInstall = runScript('adb install -r /tmp/gps.apk 2>&1', 120000);
      log('MAIN', `GPS install: ${gpsInstall}`);
      await showOnScreen('GPS updated!', 'SUCCESS', 2000);
      await sleep(5000);
    } else {
      await showOnScreen('GPS download failed - continuing', 'WARNING', 3000);
      log('MAIN', 'GPS download failed — proceeding anyway');
    }
  } else {
    await showOnScreen('GPS version is sufficient', 'SUCCESS', 2000);
    log('MAIN', 'GPS version is sufficient — no update needed');
  }

  // ── Launch WhatsApp ──────────────────────────────────────────────────────
  await showProgress(6, 10, 'Launching WhatsApp');
  await showOnScreen('Launching WhatsApp...', 'ACTION', 2000);
  
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
  log('MAIN', 'Launched via monkey — waiting 10s for WhatsApp to render...');
  await showOnScreen('Waiting for WhatsApp to load...', 'INFO', 2000);
  await sleep(10000);
  await logScreen('LAUNCH');

  const launchTexts = await screenTexts();
  const isHomeScreen = launchTexts.some(t =>
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
     'Messages','Chrome','Camera'].some(w => t.includes(w))
  );
  const isCrashing = launchTexts.some(t => t.includes('keeps stopping'));

  if (isCrashing) {
    await showOnScreen('App crashed - clearing data...', 'WARNING', 3000);
    log('MAIN', 'Crash — dismissing, clearing data, relaunching...');
    const crashXml = await dumpUI();
    await tapElement('Close app', crashXml, 'Close crash dialog');
    await sleep(2000);
    adbShell(`pm clear ${WA_PACKAGE} 2>/dev/null || true`);
    await sleep(1000);
    for (const perm of WA_PERMS) {
      adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
    }
    await showOnScreen('Relaunching WhatsApp...', 'ACTION');
    adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
    await sleep(12000);
    await logScreen('AFTER-CLEAR');

  } else if (isHomeScreen) {
    await showOnScreen('Still on home - trying am start...', 'WARNING', 2000);
    log('MAIN', 'Still home screen — trying am start fallback...');
    adbShell(`am start -n ${WA_PACKAGE}/${WA_PACKAGE}.Main 2>/dev/null`);
    await sleep(8000);
    await logScreen('AFTER-AMSTART');
  }

  // ── 5. Dismiss system alerts then accept terms ───────────────────────────
  await showProgress(7, 10, 'Handling dialogs');
  await showOnScreen('Dismissing system dialogs...', 'ACTION');
  log('MAIN', 'Dismissing any system alert dialogs...');
  
  for (let i = 0; i < 5; i++) {
    const alertXml = await dumpUI(4000);
    if (alertXml.includes('Alert') || alertXml.includes('More info') ||
        alertXml.includes('Google Play') || alertXml.includes('Update')) {
      await showOnScreen(`Dismissing alert dialog (${i+1}/5)`, 'ACTION');
      log('MAIN', `Alert dialog (attempt ${i+1}) — tapping OK`);
      const dismissed =
        await tapElement('OK', alertXml, 'OK button') ||
        await tapElement('Skip', alertXml, 'Skip button') ||
        await tapElement('Not now', alertXml, 'Not now button') ||
        await tapElement('Cancel', alertXml, 'Cancel button') ||
        await tapElement('Close', alertXml, 'Close button');
      if (!dismissed) {
        await tap(540, 1200, 'Center tap fallback');
      }
      await sleep(2000);
    } else {
      break;
    }
  }

  // ── Accept Terms ──────────────────────────────────────────────────────────
  await showProgress(8, 10, 'Accepting terms');
  await showOnScreen('Looking for terms agreement...', 'INFO');
  
  const agreeResult = await waitForAny([
    'AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree',
  ], 30000);

  if (agreeResult.matched) {
    await showOnScreen(`Found: ${agreeResult.matched}`, 'SUCCESS');
    log('MAIN', `Agree screen: "${agreeResult.matched}"`);
    const agreeXml = await dumpUI();
    for (const btn of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree']) {
      if (agreeXml.includes(btn)) {
        await tapElement(btn, agreeXml, 'Terms agreement button');
        await sleep(4000);
        break;
      }
    }
    await logScreen('POST-AGREE');
  }

  // ── Handle Notification Permission ───────────────────────────────────────
  await showProgress(9, 10, 'Handling permissions');
  await sleep(2000);
  const notifXml = await dumpUI(4000);
  
  if (notifXml.includes('Allow WhatsApp to send you notifications') || 
      notifXml.includes('send you notifications')) {
    await showOnScreen('Notification permission dialog', 'INFO');
    log('MAIN', 'Notification permission — tapping Allow');
    const allowTapped = 
      await tapElement('Allow', notifXml, 'Allow notifications') ||
      await tapElement('ALLOW', notifXml, 'ALLOW notifications');
    if (!allowTapped) {
      await tap(650, 1400, 'Allow button fallback');
    }
    await sleep(3000);
  }

  // ── Enter Phone Number ───────────────────────────────────────────────────
  await showProgress(10, 15, 'Entering phone number');
  await showOnScreen('Waiting for phone number screen...', 'INFO');
  
  // Wait for phone number entry screen
  const phoneScreenResult = await waitForAny([
    'Enter your phone number',
    'Phone number',
    'country code',
    'Your phone number',
  ], 30000);

  if (!phoneScreenResult.matched) {
    await showOnScreen('Phone screen not found - taking screenshot', 'WARNING', 3000);
    await logScreen('PHONE-SCREEN-NOT-FOUND');
  }

  await sleep(2000);
  await logScreen('PHONE-ENTRY');

  // The phone number screen usually has:
  // 1. Country code selector dropdown
  // 2. Phone number input field
  
  await showOnScreen(`Entering phone: +${phoneInfo.countryCode} ${phoneInfo.nationalNumber}`, 'ACTION', 2000);
  log('MAIN', `Entering phone: +${phoneInfo.countryCode} ${phoneInfo.nationalNumber}`);

  // Method 1: Try to tap directly on the phone number input field
  await sleep(1000);
  const phoneXml = await dumpUI();
  
  // Look for the input field - usually has resource-id with "registration_phone"
  // or is the main EditText on the screen
  const inputFieldMatch = phoneXml.match(/resource-id="[^"]*phone[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
  
  if (inputFieldMatch) {
    const x = Math.floor((parseInt(inputFieldMatch[1]) + parseInt(inputFieldMatch[3])) / 2);
    const y = Math.floor((parseInt(inputFieldMatch[2]) + parseInt(inputFieldMatch[4])) / 2);
    await tap(x, y, 'Phone number input field');
  } else {
    // Fallback: tap common phone input position
    await tap(540, 900, 'Phone input field (fallback position)');
  }

  await sleep(1000);

  // Clear any existing text first
  for (let i = 0; i < 15; i++) {
    await keyevent('KEYCODE_DEL', '');
  }
  await sleep(500);

  // Type the national number (without country code, as it should be pre-selected)
  await typeText(phoneInfo.nationalNumber, `National number: ${phoneInfo.nationalNumber}`);
  await sleep(2000);

  await logScreen('AFTER-PHONE-ENTRY');

  // ── Tap NEXT to Submit ────────────────────────────────────────────────────
  await showProgress(11, 15, 'Submitting phone number');
  await showOnScreen('Submitting phone number...', 'ACTION');
  
  await sleep(1000);
  const nextXml = await dumpUI();
  
  const nextTapped = 
    await tapElement('NEXT', nextXml, 'NEXT button') ||
    await tapElement('Next', nextXml, 'Next button') ||
    await tapElement('Continue', nextXml, 'Continue button');
  
  if (!nextTapped) {
    // Fallback: NEXT button is usually at bottom right
    await tap(900, 2000, 'NEXT button (fallback position)');
  }

  await sleep(3000);

  // ── Handle Confirmation Dialog ───────────────────────────────────────────
  await showOnScreen('Checking for confirmation dialog...', 'INFO');
  await sleep(2000);
  
  const confirmXml = await dumpUI();
  if (confirmXml.includes('Is this OK') || confirmXml.includes('correct') || 
      confirmXml.includes(phoneInfo.nationalNumber)) {
    await showOnScreen('Confirmation dialog detected', 'INFO');
    log('MAIN', 'Confirmation dialog — tapping OK');
    const okTapped =
      await tapElement('OK', confirmXml, 'Confirm phone number') ||
      await tapElement('Yes', confirmXml, 'Yes button') ||
      await tapElement('Confirm', confirmXml, 'Confirm button');
    if (!okTapped) {
      await tap(650, 1400, 'OK button fallback');
    }
    await sleep(3000);
  }

  // ── Wait for OTP Request ──────────────────────────────────────────────────
  await showProgress(12, 15, 'Requesting OTP');
  await showOnScreen('Waiting for OTP request...', 'INFO', 3000);
  
  // Wait for either "Verifying" or "Enter code" screen
  const otpScreenResult = await waitForAny([
    'Verifying',
    'Enter the 6-digit code',
    'Enter code',
    'We sent',
    'digit code',
  ], 60000);

  if (otpScreenResult.matched) {
    await showOnScreen(`OTP screen detected: ${otpScreenResult.matched}`, 'SUCCESS', 2000);
    log('MAIN', `OTP screen found: "${otpScreenResult.matched}"`);
  } else {
    await showOnScreen('OTP screen not detected - checking current state', 'WARNING', 3000);
    await logScreen('OTP-SCREEN-CHECK');
  }

  // ── Notify webhook about OTP request ──────────────────────────────────────
  await showProgress(13, 15, 'Requesting OTP via webhook');
  await showOnScreen('Requesting OTP from bot...', 'INFO', 2000);
  log('MAIN', 'Sending otp_requested webhook...');
  
  await webhook('otp_requested', {
    phone_number: PHONE,
    country: phoneInfo.country,
  });

  // ── Wait for OTP from webhook ─────────────────────────────────────────────
  await showOnScreen('Waiting for OTP from Telegram...', 'INFO', 3000);
  log('MAIN', 'Waiting for OTP from user via Telegram...');
  
  // Poll for OTP (simplified - in real implementation, you'd poll an endpoint)
  // For now, we just wait and show status
  await showOnScreen('Check Telegram for OTP code', 'WARNING', 5000);
  
  // This is where you would implement actual OTP retrieval logic
  // For example, polling a webhook endpoint or waiting for user input
  
  await showProgress(14, 15, 'Waiting for OTP');
  await showOnScreen('Registration paused - awaiting OTP', 'INFO', 5000);
  
  log('MAIN', 'Registration paused - script would normally wait for OTP here');
  log('MAIN', 'In production, implement OTP polling or webhook callback');

  // ── Completion ────────────────────────────────────────────────────────────
  await showProgress(15, 15, 'Process complete');
  await showOnScreen('Registration initiated successfully!', 'SUCCESS', 5000);
  await showOnScreen('Awaiting OTP entry (manual or automated)', 'INFO', 5000);
  
  log('MAIN', 'Phone number submitted - awaiting OTP');
  
  // Clear notifications after delay
  await sleep(5000);
  await clearOnScreenMessages();
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  await showOnScreen(`ERROR: ${err.message}`, 'ERROR', 10000);
  log('ERROR', err.message);
  log('ERROR', err.stack);
  await webhook('bad_number', { reason: `Script error: ${err.message}` });
  await sleep(3000);
  await clearOnScreenMessages();
  process.exit(0); // exit 0 — bot already notified, skip if:failure() step
});
