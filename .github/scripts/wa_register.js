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

  // 2. Grant WhatsApp permissions BEFORE launching
  log('STEP 2', 'Granting WhatsApp permissions...');
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
  log('STEP 2', '✓ Permissions granted');

  // 2a. Check and update Google Play services
  log('STEP 2a', 'Checking Google Play services...');
  await sleep(1000);
  
  // Get Google Play services version
  const gmsVersion = shell('dumpsys package com.google.android.gms | grep versionName');
  log('STEP 2a', `Google Play services version: ${gmsVersion}`);
  
  // Open Play Store to check for updates
  log('STEP 2a', 'Opening Play Store to check for Google Play services updates...');
  shell('am start -a android.intent.action.VIEW -d "market://details?id=com.google.android.gms"');
  await sleep(5000);
  
  // Check if update button exists
  const playStoreXml = await getXML();
  const updateBtn = findElement(playStoreXml, 'Update') || findElement(playStoreXml, 'Install');
  
  if (updateBtn) {
    log('STEP 2a', 'Google Play services update available, clicking Update...');
    tap(updateBtn.coords.x, updateBtn.coords.y);
    await sleep(3000);
    
    // Wait for update to complete (check for "Open" button or timeout after 60s)
    log('STEP 2a', 'Waiting for Google Play services update to complete...');
    const updateTimeout = 60000; // 60 seconds
    const startTime = Date.now();
    
    while (Date.now() - startTime < updateTimeout) {
      await sleep(3000);
      const checkXml = await getXML();
      const openBtn = findElement(checkXml, 'Open') || findElement(checkXml, 'Play');
      
      if (openBtn) {
        log('STEP 2a', '✓ Google Play services update completed');
        break;
      }
      
      // Check if still updating
      const updatingText = findElement(checkXml, 'Installing') || 
                          findElement(checkXml, 'Downloading') ||
                          findElement(checkXml, 'Pending');
      if (updatingText) {
        log('STEP 2a', 'Update in progress...');
      }
    }
  } else {
    log('STEP 2a', '✓ Google Play services is up to date');
  }
  
  // Go back to home screen
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  log('STEP 2a', '✓ Google Play services check completed');

  // 3. Launch WhatsApp
  log('STEP 3', 'Launching WhatsApp...');
  shell(`am start -n ${WHATSAPP_PACKAGE}/${WHATSAPP_ACTIVITY}`);
  await sleep(5000);
  
  // POST-ACTION: Show screen
  log('POST-ACTION', 'Verifying WhatsApp launched...');
  const whatsappTexts = await getVisibleText();
  log('POST-ACTION', `Screen shows: ${whatsappTexts.slice(0, 10).join(' | ')}`);
  
  // 3a. Verify WhatsApp is on welcome/terms screen
  log('STEP 3a', 'Waiting for welcome screen...');
  await sleep(1000);
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
    // Try to capture what's on screen for debugging
    const currentTexts = await getVisibleText();
    log('ERROR', `Welcome screen not found. Current screen shows: ${currentTexts.slice(0, 15).join(' | ')}`);
    throw new Error('WhatsApp did not reach welcome/terms screen');
  }
  log('POST-ACTION', `✓ WhatsApp ready: "${welcomeCheck.found}"`);
  takeScreenshot('02_welcome_screen');

  // 4. Click "Agree and continue"
  log('STEP 4', 'Clicking Agree and continue...');
  const agreeBtn = await waitFor('Agree and continue');
  tap(agreeBtn.element.coords.x, agreeBtn.element.coords.y);
  await sleep(2000);
  
  // POST-ACTION: Screenshot and verify
  takeScreenshot('03_agree_clicked');
  const afterAgreeTexts = await getVisibleText();
  log('POST-ACTION', `After Agree - Screen shows: ${afterAgreeTexts.slice(0, 10).join(' | ')}`);
  
  // 5. Handle potential permission dialogs
  log('STEP 5', 'Checking for permission dialogs...');
  await sleep(1000);
  
  // Check for SMS permission dialog
  const smsPermCheck = await verifyScreen(['Allow WhatsApp to send and view SMS messages', 'Allow'], 3000);
  if (smsPermCheck.success) {
    log('STEP 5', 'Found SMS permission dialog, clicking Allow...');
    const allowBtn = findElement(smsPermCheck.xml, 'Allow');
    if (allowBtn) {
      tap(allowBtn.coords.x, allowBtn.coords.y);
      await sleep(1500);
      takeScreenshot('04_sms_permission_allowed');
      log('POST-ACTION', '✓ SMS permission granted');
    }
  } else {
    log('STEP 5', 'No SMS permission dialog found, continuing...');
  }
  
  // 6. Dump UI to detect phone number screen
  log('STEP 6', 'Dumping UI to detect phone number screen...');
  await sleep(1000);
  const phoneScreenXml = await getXML();
  const phoneScreenTexts = await getVisibleText();
  log('POST-ACTION', `Phone screen shows: ${phoneScreenTexts.slice(0, 10).join(' | ')}`);
  takeScreenshot('05_phone_number_screen');
  
  // Verify we're on phone number entry screen
  const phoneNumberCheck = await verifyScreen([
    'Enter your phone number',
    'Phone number',
    'Continue',
    'Next'
  ], 8000);
  
  if (!phoneNumberCheck.success) {
    throw new Error('Could not detect phone number entry screen');
  }
  log('POST-ACTION', `✓ On phone number screen: "${phoneNumberCheck.found}"`);
  
  // 7. Parse phone number (country code + national number)
  log('STEP 7', 'Parsing phone number...');
  let countryCode = '';
  let nationalNumber = '';
  
  const phoneClean = PHONE.replace(/[^0-9+]/g, '');
  const withoutPlus = phoneClean.startsWith('+') ? phoneClean.substring(1) : phoneClean;
  
  const countryCodeLengths = {
    '1': 11, '7': 11, '20': 12, '27': 11, '30': 12, '31': 11, '32': 11, '33': 11, '34': 11,
    '36': 11, '39': 12, '40': 11, '41': 11, '43': 12, '44': 12, '45': 10, '46': 11, '47': 10,
    '48': 11, '49': 12, '51': 11, '52': 12, '53': 10, '54': 12, '55': 13, '56': 11, '57': 12,
    '58': 12, '60': 11, '61': 11, '62': 12, '63': 12, '64': 11, '65': 10, '66': 11, '81': 12,
    '82': 12, '84': 11, '86': 13, '90': 12, '91': 12, '92': 12, '93': 11, '94': 11, '95': 11,
    '98': 12, '212': 12, '213': 12, '216': 10, '218': 12, '220': 9, '221': 11, '222': 10,
    '223': 10, '224': 11, '225': 12, '226': 10, '227': 10, '228': 10, '229': 10, '230': 10,
    '231': 11, '232': 10, '233': 12, '234': 13, '235': 10, '236': 10, '237': 11, '238': 9,
    '239': 9, '240': 11, '241': 9, '242': 11, '243': 11, '244': 11, '245': 9, '246': 9,
    '248': 9, '249': 11, '250': 11, '251': 11, '252': 10, '253': 10, '254': 12, '255': 12,
    '256': 12, '257': 10, '258': 12, '260': 12, '261': 12, '262': 12, '263': 12, '264': 12,
    '265': 11, '266': 10, '267': 10, '268': 10, '269': 9, '350': 10, '351': 11, '352': 11,
    '353': 11, '354': 9, '355': 11, '356': 10, '357': 10, '358': 11, '359': 11, '370': 10,
    '371': 10, '372': 9, '373': 10, '374': 10, '375': 11, '376': 8, '377': 10, '378': 12,
    '380': 12, '381': 11, '382': 10, '383': 10, '385': 11, '386': 10, '387': 10, '389': 10,
    '420': 11, '421': 11, '423': 9, '500': 7, '501': 9, '502': 10, '503': 10, '504': 10,
    '505': 10, '506': 10, '507': 10, '509': 10, '590': 11, '591': 10, '592': 9, '593': 11,
    '594': 11, '595': 11, '596': 11, '597': 9, '598': 10, '599': 9, '670': 10, '672': 8,
    '673': 9, '674': 9, '675': 10, '676': 7, '677': 9, '678': 9, '679': 9, '680': 9,
    '681': 8, '682': 7, '683': 6, '685': 9, '686': 10, '687': 8, '688': 8, '689': 10,
    '690': 6, '691': 9, '692': 9, '850': 13, '852': 10, '853': 10, '855': 11, '856': 11,
    '880': 12, '886': 11, '960': 9, '961': 10, '962': 11, '963': 11, '964': 12, '965': 10,
    '966': 12, '967': 11, '968': 10, '970': 11, '971': 11, '972': 11, '973': 10, '974': 10,
    '975': 10, '976': 10, '977': 12, '992': 11, '993': 10, '994': 11, '995': 11, '996': 11,
    '998': 11
  };
  
  let matched = false;
  
  for (let codeLen = 3; codeLen >= 1; codeLen--) {
    if (withoutPlus.length > codeLen) {
      const testCode = withoutPlus.substring(0, codeLen);
      const expectedLength = countryCodeLengths[testCode];
      
      if (expectedLength && withoutPlus.length === expectedLength) {
        countryCode = testCode;
        nationalNumber = withoutPlus.substring(codeLen);
        matched = true;
        break;
      }
    }
  }
  
  if (!matched) {
    for (let codeLen = 3; codeLen >= 1; codeLen--) {
      if (withoutPlus.length > codeLen) {
        const testCode = withoutPlus.substring(0, codeLen);
        if (countryCodeLengths[testCode]) {
          countryCode = testCode;
          nationalNumber = withoutPlus.substring(codeLen);
          matched = true;
          break;
        }
      }
    }
  }
  
  if (!matched) {
    if (withoutPlus.length >= 10) {
      countryCode = withoutPlus.substring(0, 1);
      nationalNumber = withoutPlus.substring(1);
    } else {
      throw new Error(`Could not parse phone number: ${PHONE}`);
    }
  }
  
  if (!countryCode || !nationalNumber) {
    throw new Error(`Could not parse phone number: ${PHONE}`);
  }
  
  log('STEP 7', `Parsed: Country Code = ${countryCode}, National Number = ${nationalNumber}`);
  
  // 8. Edit country code
  log('STEP 8', 'Editing country code...');
  await sleep(500);
  
  // Click country selector at fixed coordinate
  log('STEP 8', 'Clicking country selector at (540, 635)');
  tap(540, 635);
  await sleep(2000);
  takeScreenshot('06_country_selector_opened');
  
  // Click search icon at fixed coordinate
  log('STEP 8', 'Clicking search icon at (1025, 200)');
  tap(1025, 200);
  await sleep(1000);
  
  // Click search input field and enter country code
  log('STEP 8', `Clicking search field at (690, 200) and entering country code: ${countryCode}`);
  tap(690, 200);
  await sleep(500);
  textInput(countryCode);
  await sleep(1500);
  takeScreenshot('07_country_code_typed');
  
  // Click top search result (country name)
  log('STEP 8', 'Clicking top search result at (800, 315)');
  tap(800, 315);
  await sleep(1500);
  takeScreenshot('08_country_selected');
  log('POST-ACTION', `✓ Country code ${countryCode} selected`);
  
  // 9. Enter national number
  log('STEP 9', 'Entering national phone number...');
  await sleep(1000);
  
  // Click phone number input field at fixed coordinate
  log('STEP 9', 'Clicking phone input field at (540, 750)');
  tap(540, 750);
  await sleep(1000);
  
  // Enter the national number
  log('STEP 9', `Entering national number: ${nationalNumber}`);
  textInput(nationalNumber);
  await sleep(1500);
  takeScreenshot('09_phone_number_entered');
  log('POST-ACTION', `✓ Phone number entered: ${nationalNumber}`);
  
  // 10. Tap NEXT button
  log('STEP 10', 'Tapping NEXT button...');
  await sleep(500);
  
  // Click Next button
  log('STEP 10', 'Clicking NEXT at (540, 2232)');
  tap(540, 2232);
  await sleep(2000);
  takeScreenshot('10_next_clicked');
  
  // POST-ACTION: Verify what screen we're on after clicking NEXT
  const afterNextTexts = await getVisibleText();
  log('POST-ACTION', `After NEXT - Screen shows: ${afterNextTexts.slice(0, 10).join(' | ')}`);
  
  // Check if we're on verification code screen
  const verifyCheck = await verifyScreen([
    'Enter your verification code',
    'Verify',
    'Code',
    'We sent an SMS',
    'SMS',
    'Didn\'t get',
    'Call me',
    '6-digit code'
  ], 5000);
  
  if (verifyCheck.success) {
    log('POST-ACTION', `✓ Now on verification screen: "${verifyCheck.found}"`);
    takeScreenshot('12_verification_screen');
  }
  
  // STOP HERE as requested - after NEXT is clicked
  log('COMPLETE', 'Stopped after phone number entry and NEXT click as requested');
  
  // Final screenshot
  await sleep(1000);
  takeScreenshot('99_final_stopped_at_verification');
  
  // Send webhook indicating we're waiting for OTP
  await webhook('awaiting_otp', { 
    phone_number: PHONE,
    step: 'verification_screen',
    message: 'Phone number entered, waiting for verification code'
  });
  
  log('COMPLETE', 'WhatsApp is ready for OTP verification');
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
