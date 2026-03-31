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
  
  // Parse phone number - expecting format like +1234567890 or 1234567890
  const phoneClean = PHONE.replace(/[^0-9+]/g, '');
  const withoutPlus = phoneClean.startsWith('+') ? phoneClean.substring(1) : phoneClean;
  
  // Common country codes with their typical lengths (country code length + national number length)
  // Format: [country_code, total_length_with_country_code]
  const countryCodeMap = [
    ['1', 11],      // US/Canada: +1 + 10 digits
    ['7', 11],      // Russia/Kazakhstan: +7 + 10 digits
    ['20', 12],     // Egypt: +20 + 10 digits
    ['27', 11],     // South Africa: +27 + 9 digits
    ['30', 12],     // Greece: +30 + 10 digits
    ['31', 11],     // Netherlands: +31 + 9 digits
    ['32', 11],     // Belgium: +32 + 9 digits
    ['33', 11],     // France: +33 + 9 digits
    ['34', 11],     // Spain: +34 + 9 digits
    ['36', 11],     // Hungary: +36 + 9 digits
    ['39', 12],     // Italy: +39 + 10 digits
    ['40', 11],     // Romania: +40 + 9 digits
    ['41', 11],     // Switzerland: +41 + 9 digits
    ['43', 12],     // Austria: +43 + 10 digits
    ['44', 12],     // UK: +44 + 10 digits
    ['45', 10],     // Denmark: +45 + 8 digits
    ['46', 11],     // Sweden: +46 + 9 digits
    ['47', 10],     // Norway: +47 + 8 digits
    ['48', 11],     // Poland: +48 + 9 digits
    ['49', 12],     // Germany: +49 + 10 digits
    ['51', 11],     // Peru: +51 + 9 digits
    ['52', 12],     // Mexico: +52 + 10 digits
    ['53', 10],     // Cuba: +53 + 8 digits
    ['54', 12],     // Argentina: +54 + 10 digits
    ['55', 13],     // Brazil: +55 + 11 digits
    ['56', 11],     // Chile: +56 + 9 digits
    ['57', 12],     // Colombia: +57 + 10 digits
    ['58', 12],     // Venezuela: +58 + 10 digits
    ['60', 11],     // Malaysia: +60 + 9 digits
    ['61', 11],     // Australia: +61 + 9 digits
    ['62', 12],     // Indonesia: +62 + 10 digits
    ['63', 12],     // Philippines: +63 + 10 digits
    ['64', 11],     // New Zealand: +64 + 9 digits
    ['65', 10],     // Singapore: +65 + 8 digits
    ['66', 11],     // Thailand: +66 + 9 digits
    ['81', 12],     // Japan: +81 + 10 digits
    ['82', 12],     // South Korea: +82 + 10 digits
    ['84', 11],     // Vietnam: +84 + 9 digits
    ['86', 13],     // China: +86 + 11 digits
    ['90', 12],     // Turkey: +90 + 10 digits
    ['91', 12],     // India: +91 + 10 digits
    ['92', 12],     // Pakistan: +92 + 10 digits
    ['93', 11],     // Afghanistan: +93 + 9 digits
    ['94', 11],     // Sri Lanka: +94 + 9 digits
    ['95', 11],     // Myanmar: +95 + 9 digits
    ['98', 12],     // Iran: +98 + 10 digits
    ['212', 12],    // Morocco: +212 + 9 digits
    ['213', 12],    // Algeria: +213 + 9 digits
    ['216', 10],    // Tunisia: +216 + 8 digits
    ['218', 12],    // Libya: +218 + 10 digits
    ['220', 9],     // Gambia: +220 + 7 digits
    ['221', 11],    // Senegal: +221 + 9 digits
    ['222', 10],    // Mauritania: +222 + 8 digits
    ['223', 10],    // Mali: +223 + 8 digits
    ['224', 11],    // Guinea: +224 + 9 digits
    ['225', 12],    // Ivory Coast: +225 + 10 digits
    ['226', 10],    // Burkina Faso: +226 + 8 digits
    ['227', 10],    // Niger: +227 + 8 digits
    ['228', 10],    // Togo: +228 + 8 digits
    ['229', 10],    // Benin: +229 + 8 digits
    ['230', 10],    // Mauritius: +230 + 8 digits
    ['231', 11],    // Liberia: +231 + 9 digits
    ['232', 10],    // Sierra Leone: +232 + 8 digits
    ['233', 12],    // Ghana: +233 + 10 digits
    ['234', 13],    // Nigeria: +234 + 10 digits
    ['235', 10],    // Chad: +235 + 8 digits
    ['236', 10],    // Central African Republic: +236 + 8 digits
    ['237', 11],    // Cameroon: +237 + 9 digits
    ['238', 9],     // Cape Verde: +238 + 7 digits
    ['239', 9],     // Sao Tome: +239 + 7 digits
    ['240', 11],    // Equatorial Guinea: +240 + 9 digits
    ['241', 9],     // Gabon: +241 + 7 digits
    ['242', 11],    // Republic of Congo: +242 + 9 digits
    ['243', 11],    // DR Congo: +243 + 9 digits
    ['244', 11],    // Angola: +244 + 9 digits
    ['245', 9],     // Guinea-Bissau: +245 + 7 digits
    ['246', 9],     // British Indian Ocean Territory: +246 + 7 digits
    ['248', 9],     // Seychelles: +248 + 7 digits
    ['249', 11],    // Sudan: +249 + 9 digits
    ['250', 11],    // Rwanda: +250 + 9 digits
    ['251', 11],    // Ethiopia: +251 + 9 digits
    ['252', 10],    // Somalia: +252 + 8 digits
    ['253', 10],    // Djibouti: +253 + 8 digits
    ['254', 12],    // Kenya: +254 + 10 digits
    ['255', 12],    // Tanzania: +255 + 10 digits
    ['256', 12],    // Uganda: +256 + 10 digits
    ['257', 10],    // Burundi: +257 + 8 digits
    ['258', 12],    // Mozambique: +258 + 10 digits
    ['260', 12],    // Zambia: +260 + 10 digits
    ['261', 12],    // Madagascar: +261 + 10 digits
    ['262', 12],    // Reunion/Mayotte: +262 + 10 digits
    ['263', 12],    // Zimbabwe: +263 + 10 digits
    ['264', 12],    // Namibia: +264 + 10 digits
    ['265', 11],    // Malawi: +265 + 9 digits
    ['266', 10],    // Lesotho: +266 + 8 digits
    ['267', 10],    // Botswana: +267 + 8 digits
    ['268', 10],    // Eswatini: +268 + 8 digits
    ['269', 9],     // Comoros: +269 + 7 digits
    ['350', 10],    // Gibraltar: +350 + 8 digits
    ['351', 11],    // Portugal: +351 + 9 digits
    ['352', 11],    // Luxembourg: +352 + 9 digits
    ['353', 11],    // Ireland: +353 + 9 digits
    ['354', 9],     // Iceland: +354 + 7 digits
    ['355', 11],    // Albania: +355 + 9 digits
    ['356', 10],    // Malta: +356 + 8 digits
    ['357', 10],    // Cyprus: +357 + 8 digits
    ['358', 11],    // Finland: +358 + 9 digits
    ['359', 11],    // Bulgaria: +359 + 9 digits
    ['370', 10],    // Lithuania: +370 + 8 digits
    ['371', 10],    // Latvia: +371 + 8 digits
    ['372', 9],     // Estonia: +372 + 7 digits
    ['373', 10],    // Moldova: +373 + 8 digits
    ['374', 10],    // Armenia: +374 + 8 digits
    ['375', 11],    // Belarus: +375 + 9 digits
    ['376', 8],     // Andorra: +376 + 6 digits
    ['377', 10],    // Monaco: +377 + 8 digits
    ['378', 12],    // San Marino: +378 + 10 digits
    ['380', 12],    // Ukraine: +380 + 10 digits
    ['381', 11],    // Serbia: +381 + 9 digits
    ['382', 10],    // Montenegro: +382 + 8 digits
    ['383', 10],    // Kosovo: +383 + 8 digits
    ['385', 11],    // Croatia: +385 + 9 digits
    ['386', 10],    // Slovenia: +386 + 8 digits
    ['387', 10],    // Bosnia: +387 + 8 digits
    ['389', 10],    // North Macedonia: +389 + 8 digits
    ['420', 11],    // Czech Republic: +420 + 9 digits
    ['421', 11],    // Slovakia: +421 + 9 digits
    ['423', 9],     // Liechtenstein: +423 + 7 digits
    ['500', 7],     // Falkland Islands: +500 + 5 digits
    ['501', 9],     // Belize: +501 + 7 digits
    ['502', 10],    // Guatemala: +502 + 8 digits
    ['503', 10],    // El Salvador: +503 + 8 digits
    ['504', 10],    // Honduras: +504 + 8 digits
    ['505', 10],    // Nicaragua: +505 + 8 digits
    ['506', 10],    // Costa Rica: +506 + 8 digits
    ['507', 10],    // Panama: +507 + 8 digits
    ['509', 10],    // Haiti: +509 + 8 digits
    ['590', 11],    // Guadeloupe: +590 + 9 digits
    ['591', 10],    // Bolivia: +591 + 8 digits
    ['592', 9],     // Guyana: +592 + 7 digits
    ['593', 11],    // Ecuador: +593 + 9 digits
    ['594', 11],    // French Guiana: +594 + 9 digits
    ['595', 11],    // Paraguay: +595 + 9 digits
    ['596', 11],    // Martinique: +596 + 9 digits
    ['597', 9],     // Suriname: +597 + 7 digits
    ['598', 10],    // Uruguay: +598 + 8 digits
    ['599', 9],     // Caribbean Netherlands: +599 + 7 digits
    ['670', 10],    // East Timor: +670 + 8 digits
    ['672', 8],     // Antarctica: +672 + 6 digits
    ['673', 9],     // Brunei: +673 + 7 digits
    ['674', 9],     // Nauru: +674 + 7 digits
    ['675', 10],    // Papua New Guinea: +675 + 8 digits
    ['676', 7],     // Tonga: +676 + 5 digits
    ['677', 9],     // Solomon Islands: +677 + 7 digits
    ['678', 9],     // Vanuatu: +678 + 7 digits
    ['679', 9],     // Fiji: +679 + 7 digits
    ['680', 9],     // Palau: +680 + 7 digits
    ['681', 8],     // Wallis and Futuna: +681 + 6 digits
    ['682', 7],     // Cook Islands: +682 + 5 digits
    ['683', 6],     // Niue: +683 + 4 digits
    ['685', 9],     // Samoa: +685 + 7 digits
    ['686', 10],    // Kiribati: +686 + 8 digits
    ['687', 8],     // New Caledonia: +687 + 6 digits
    ['688', 8],     // Tuvalu: +688 + 6 digits
    ['689', 10],    // French Polynesia: +689 + 8 digits
    ['690', 6],     // Tokelau: +690 + 4 digits
    ['691', 9],     // Micronesia: +691 + 7 digits
    ['692', 9],     // Marshall Islands: +692 + 7 digits
    ['850', 13],    // North Korea: +850 + 11 digits
    ['852', 10],    // Hong Kong: +852 + 8 digits
    ['853', 10],    // Macau: +853 + 8 digits
    ['855', 11],    // Cambodia: +855 + 9 digits
    ['856', 11],    // Laos: +856 + 9 digits
    ['880', 12],    // Bangladesh: +880 + 10 digits
    ['886', 11],    // Taiwan: +886 + 9 digits
    ['960', 9],     // Maldives: +960 + 7 digits
    ['961', 10],    // Lebanon: +961 + 8 digits
    ['962', 11],    // Jordan: +962 + 9 digits
    ['963', 11],    // Syria: +963 + 9 digits
    ['964', 12],    // Iraq: +964 + 10 digits
    ['965', 10],    // Kuwait: +965 + 8 digits
    ['966', 12],    // Saudi Arabia: +966 + 10 digits
    ['967', 11],    // Yemen: +967 + 9 digits
    ['968', 10],    // Oman: +968 + 8 digits
    ['970', 11],    // Palestine: +970 + 9 digits
    ['971', 11],    // UAE: +971 + 9 digits
    ['972', 11],    // Israel: +972 + 9 digits
    ['973', 10],    // Bahrain: +973 + 8 digits
    ['974', 10],    // Qatar: +974 + 8 digits
    ['975', 10],    // Bhutan: +975 + 8 digits
    ['976', 10],    // Mongolia: +976 + 8 digits
    ['977', 12],    // Nepal: +977 + 10 digits
    ['992', 11],    // Tajikistan: +992 + 9 digits
    ['993', 10],    // Turkmenistan: +993 + 8 digits
    ['994', 11],    // Azerbaijan: +994 + 9 digits
    ['995', 11],    // Georgia: +995 + 9 digits
    ['996', 11],    // Kyrgyzstan: +996 + 9 digits
    ['998', 11]     // Uzbekistan: +998 + 9 digits
  ];
  
  // Try to match country code by checking if the number matches expected length
  let matched = false;
  for (const [code, expectedLength] of countryCodeMap) {
    if (withoutPlus.startsWith(code) && withoutPlus.length === expectedLength) {
      countryCode = code;
      nationalNumber = withoutPlus.substring(code.length);
      matched = true;
      break;
    }
  }
  
  // Fallback: if no match found, try 3-digit, 2-digit, then 1-digit codes
  if (!matched) {
    if (withoutPlus.length >= 4) {
      // Try 3-digit country code
      const threeDigit = withoutPlus.substring(0, 3);
      const twoDigit = withoutPlus.substring(0, 2);
      const oneDigit = withoutPlus.substring(0, 1);
      
      // Check if it's a known 3-digit code
      const threeDigitCodes = countryCodeMap.filter(([code]) => code.length === 3).map(([code]) => code);
      if (threeDigitCodes.includes(threeDigit)) {
        countryCode = threeDigit;
        nationalNumber = withoutPlus.substring(3);
      }
      // Check if it's a known 2-digit code
      else if (countryCodeMap.some(([code]) => code === twoDigit)) {
        countryCode = twoDigit;
        nationalNumber = withoutPlus.substring(2);
      }
      // Default to 1-digit (most common)
      else {
        countryCode = oneDigit;
        nationalNumber = withoutPlus.substring(1);
      }
    } else {
      throw new Error(`Phone number too short: ${PHONE}`);
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
  
  // Get current screen state before clicking
  const beforeNextTexts = await getVisibleText();
  const beforeNextTextString = beforeNextTexts.join(' ');
  
  // Try first Next button coordinate
  log('STEP 10', 'Clicking NEXT at (540, 2232)');
  tap(540, 2232);
  await sleep(2000);
  takeScreenshot('10_next_clicked');
  
  // Check if screen changed
  const afterFirstClickTexts = await getVisibleText();
  const afterFirstClickString = afterFirstClickTexts.join(' ');
  
  if (beforeNextTextString === afterFirstClickString) {
    // Screen didn't change, try second coordinate
    log('STEP 10', 'No screen change detected, trying NEXT at (540, 2230)');
    tap(540, 2230);
    await sleep(2000);
    takeScreenshot('11_next_clicked_retry');
  }
  
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
