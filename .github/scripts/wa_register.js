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
  
  // 4a. Check for initial OK/Continue dialogs (permissions, info screens, etc.)
  log('STEP 4a', 'Checking for initial dialogs (OK, Continue, Allow, etc.)...');
  await sleep(1000);
  
  const initialDialogCheck = await verifyScreen(['OK', 'Continue', 'Allow', 'Got it'], 3000);
  if (initialDialogCheck.success) {
    log('STEP 4a', `Found dialog button: "${initialDialogCheck.found}"`);
    const dialogBtn = findElement(initialDialogCheck.xml, initialDialogCheck.found);
    if (dialogBtn) {
      log('STEP 4a', `Clicking "${initialDialogCheck.found}" at (${dialogBtn.coords.x}, ${dialogBtn.coords.y})`);
      tap(dialogBtn.coords.x, dialogBtn.coords.y);
      await sleep(2000);
      takeScreenshot('04a_initial_dialog_clicked');
      log('POST-ACTION', `✓ Clicked "${initialDialogCheck.found}"`);
    }
  } else {
    log('STEP 4a', 'No initial dialog found, continuing...');
  }
  
  // 4b. Verify WhatsApp is on welcome/terms screen
  log('STEP 4b', 'Waiting for welcome screen...');
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
  takeScreenshot('04b_welcome_screen');

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

  // 6. Handle potential permission dialogs
  log('STEP 6', 'Checking for permission dialogs...');
  await sleep(1000);
  
  // Check for SMS permission dialog
  const smsPermCheck = await verifyScreen(['Allow WhatsApp to send and view SMS messages', 'Allow'], 3000);
  if (smsPermCheck.success) {
    log('STEP 6', 'Found SMS permission dialog, clicking Allow...');
    const allowBtn = findElement(smsPermCheck.xml, 'Allow');
    if (allowBtn) {
      tap(allowBtn.coords.x, allowBtn.coords.y);
      await sleep(1500);
      takeScreenshot('06_sms_permission_allowed');
      log('POST-ACTION', '✓ SMS permission granted');
    }
  } else {
    log('STEP 6', 'No SMS permission dialog found, continuing...');
  }
  
  // 7. Dump UI to detect phone number screen
  log('STEP 7', 'Dumping UI to detect phone number screen...');
  await sleep(1000);
  const phoneScreenXml = await getXML();
  const phoneScreenTexts = await getVisibleText();
  log('POST-ACTION', `Phone screen shows: ${phoneScreenTexts.slice(0, 10).join(' | ')}`);
  takeScreenshot('07_phone_number_screen');
  
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
  
  // 8. Parse phone number (country code + national number)
  log('STEP 8', 'Parsing phone number...');
  let countryCode = '';
  let nationalNumber = '';
  
  // Parse phone number - expecting format like +1234567890 or 1234567890
  const phoneClean = PHONE.replace(/[^0-9+]/g, '');
  if (phoneClean.startsWith('+')) {
    // International format: +1 234567890
    const withoutPlus = phoneClean.substring(1);
    // Common country codes: +1 (US/CA), +44 (UK), +91 (India), +86 (China), +7 (Russia), +234 (Nigeria), etc.
    // We'll try to detect based on length - this is a simple heuristic
    if (withoutPlus.startsWith('1') && withoutPlus.length === 11) {
      countryCode = '1';
      nationalNumber = withoutPlus.substring(1);
    } else if (withoutPlus.startsWith('44') && withoutPlus.length >= 11) {
      countryCode = '44';
      nationalNumber = withoutPlus.substring(2);
    } else if (withoutPlus.startsWith('91') && withoutPlus.length === 12) {
      countryCode = '91';
      nationalNumber = withoutPlus.substring(2);
    } else if (withoutPlus.startsWith('86') && withoutPlus.length === 13) {
      countryCode = '86';
      nationalNumber = withoutPlus.substring(2);
    } else if (withoutPlus.startsWith('234') && withoutPlus.length === 13) {
      countryCode = '234';
      nationalNumber = withoutPlus.substring(3);
    } else {
      // Fallback: assume first 1-3 digits are country code
      const match = withoutPlus.match(/^(\d{1,3})(\d+)$/);
      if (match) {
        countryCode = match[1];
        nationalNumber = match[2];
      } else {
        throw new Error(`Could not parse phone number: ${PHONE}`);
      }
    }
  } else {
    // Assume it's just national number without country code (default to US +1)
    countryCode = '1';
    nationalNumber = phoneClean;
  }
  
  log('STEP 8', `Parsed: Country Code = ${countryCode}, National Number = ${nationalNumber}`);
  
  // 9. Edit country code
  log('STEP 9', 'Editing country code...');
  await sleep(500);
  
  // Find country code selector (usually shows something like "United States +1" or just the flag/code)
  const countrySelector = findElement(phoneScreenXml, countryCode) || 
                          findElement(phoneScreenXml, 'Country') ||
                          findElement(phoneScreenXml, 'Select');
  
  if (countrySelector) {
    log('STEP 9', `Found country selector, tapping...`);
    tap(countrySelector.coords.x, countrySelector.coords.y);
    await sleep(2000);
    takeScreenshot('08_country_selector_opened');
    
    // Try to find the search box or type country code directly
    const searchCheck = await verifyScreen(['Search', 'Type to search'], 3000);
    if (searchCheck.success) {
      const searchBox = findElement(searchCheck.xml, 'Search') || findElement(searchCheck.xml, 'Type');
      if (searchBox) {
        tap(searchBox.coords.x, searchBox.coords.y);
        await sleep(500);
        textInput(countryCode);
        await sleep(1000);
        takeScreenshot('09_country_code_typed');
        
        // Select first result
        keyevent('KEYCODE_DPAD_DOWN');
        await sleep(300);
        keyevent('KEYCODE_ENTER');
        await sleep(1000);
        takeScreenshot('10_country_selected');
        log('POST-ACTION', `✓ Country code ${countryCode} selected`);
      }
    }
  } else {
    log('STEP 9', 'Country code field not found or already set correctly');
  }
  
  // 10. Enter national number
  log('STEP 10', 'Entering national phone number...');
  await sleep(1000);
  
  // Dump UI again to find phone number input field
  const phoneInputXml = await getXML();
  
  // Find the phone number input field (usually has hint like "Phone number" or is an EditText)
  // Look for EditText elements or input fields
  const inputFieldRe = /<node[^>]*class="android\.widget\.EditText"[^>]*bounds="([^"]+)"[^>]*>/g;
  let inputMatch;
  const inputFields = [];
  
  while ((inputMatch = inputFieldRe.exec(phoneInputXml)) !== null) {
    const bounds = inputMatch[1];
    const coords = parseBounds(bounds);
    if (coords) inputFields.push(coords);
  }
  
  if (inputFields.length > 0) {
    // Usually the phone number field is the main/largest EditText on screen
    // Tap on the first or largest one
    const phoneField = inputFields[0];
    log('STEP 10', `Found phone input field at (${phoneField.x}, ${phoneField.y})`);
    tap(phoneField.x, phoneField.y);
    await sleep(1000);
    
    // Enter the national number
    textInput(nationalNumber);
    await sleep(1500);
    takeScreenshot('11_phone_number_entered');
    log('POST-ACTION', `✓ Phone number entered: ${nationalNumber}`);
  } else {
    throw new Error('Could not find phone number input field');
  }
  
  // 11. Tap NEXT button
  log('STEP 11', 'Tapping NEXT button...');
  await sleep(500);
  
  const nextBtnXml = await getXML();
  const nextBtn = findElement(nextBtnXml, 'Next') || findElement(nextBtnXml, 'Continue');
  
  if (!nextBtn) {
    throw new Error('Could not find NEXT/Continue button');
  }
  
  log('STEP 11', `Found NEXT button at (${nextBtn.coords.x}, ${nextBtn.coords.y})`);
  tap(nextBtn.coords.x, nextBtn.coords.y);
  await sleep(2000);
  takeScreenshot('12_next_clicked');
  
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
    takeScreenshot('13_verification_screen');
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
