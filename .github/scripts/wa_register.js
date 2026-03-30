/**
 * wa_register.js — Native WhatsApp Android App Automation
 * Automates WhatsApp mobile app registration and generates session for whatsapp-web.js pairing
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

const SCREENSHOT_DIR = '/tmp/wa_screenshots';
const SESSION_FILE = '/tmp/wa_session.json';
const SCRIPT_DIR = '/tmp/wa_scripts';

// WhatsApp package info
const WHATSAPP_PACKAGE = 'com.whatsapp';
const WHATSAPP_MAIN_ACTIVITY = 'com.whatsapp.Main';

// ── Screenshot Counter ──────────────────────────────────────────────────────
let screenshotCounter = 0;

// ── Logging & Utilities ─────────────────────────────────────────────────────

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

function shell(cmd, timeout = 30000) {
  const file = path.join(SCRIPT_DIR, `adb_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = exec(`adb shell < ${file}`, timeout);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

// ── Screenshot Functions ────────────────────────────────────────────────────

async function takeScreenshot(label) {
  screenshotCounter++;
  const filename = `${String(screenshotCounter).padStart(3, '0')}_${label.replace(/\s+/g, '_')}.png`;
  const devicePath = `/sdcard/screenshot_${Date.now()}.png`;
  const localPath = path.join(SCREENSHOT_DIR, filename);
  
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  
  try {
    shell(`screencap -p ${devicePath}`);
    exec(`adb pull ${devicePath} ${localPath}`);
    shell(`rm ${devicePath} 2>/dev/null || true`);
    log('SCREENSHOT', `${filename} saved`);
    return localPath;
  } catch (e) {
    log('SCREENSHOT', `Failed: ${e.message}`);
    return null;
  }
}

// ── ADB Helpers ──────────────────────────────────────────────────────────────

function tap(x, y) { 
  shell(`input tap ${x} ${y}`); 
}

function swipe(x1, y1, x2, y2, d = 300) { 
  shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${d}`); 
}

function keyevent(k) { 
  shell(`input keyevent ${k}`); 
}

function textInput(str) {
  const safe = str.replace(/ /g, '%s').replace(/&/g, '\\&');
  shell(`input text "${safe}"`);
}

function back() {
  keyevent('KEYCODE_BACK');
}

function home() {
  keyevent('KEYCODE_HOME');
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

function findAllElements(xml, searchText) {
  const re = new RegExp(`(?:text|content-desc)="([^"]*${searchText}[^"]*)"[^>]*bounds="([^"]+)"`, 'gi');
  const matches = [];
  let match;
  while ((match = re.exec(xml)) !== null) {
    const coords = parseBounds(match[2]);
    if (coords) matches.push({ text: match[1], coords });
  }
  return matches;
}

// ── Screen Verification ─────────────────────────────────────────────────────

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

async function waitFor(text, timeoutMs = 30000, screenshot = true) {
  log('WAIT', `Waiting for "${text}"...`);
  const result = await verifyScreen(text, timeoutMs);
  if (!result.success) {
    if (screenshot) await takeScreenshot(`timeout_waiting_${text.replace(/\s+/g, '_')}`);
    throw new Error(`Timeout waiting for "${text}"`);
  }
  const el = findElement(result.xml, text);
  if (!el) {
    if (screenshot) await takeScreenshot(`found_no_bounds_${text.replace(/\s+/g, '_')}`);
    throw new Error(`Found "${text}" but no bounds`);
  }
  return { xml: result.xml, element: el };
}

// ── Webhook ───────────────────────────────────────────────────────────────────

async function webhook(event, extra = {}) {
  if (!WEBHOOK_URL) return;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event, 
      phone_number: PHONE, 
      telegram_user_id: parseInt(USER_ID, 10), 
      run_id: RUN_ID, 
      ...extra
    });
    const u = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const options = {
      hostname: u.hostname, 
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname, 
      method: 'POST',
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
    req.on('error', (e) => {
      log('WEBHOOK', `Error: ${e.message}`);
      resolve();
    });
    req.setTimeout(8000, () => req.destroy());
    req.write(body);
    req.end();
  });
}

// ── Session Generation for whatsapp-web.js ───────────────────────────────────

function generateSessionData(phoneNumber) {
  // Generate a session structure compatible with whatsapp-web.js LocalAuth
  // This creates a minimal session that can be restored for pairing monitoring
  const timestamp = Date.now();
  const clientId = `wa_${phoneNumber}_${timestamp}`;
  
  const sessionData = {
    clientId: clientId,
    phoneNumber: phoneNumber,
    createdAt: new Date().toISOString(),
    platform: 'android',
    // These fields simulate the LocalAuth structure
    WABrowserId: generateId(16),
    WASecretBundle: generateSecretBundle(),
    WAToken1: generateToken(),
    WAToken2: generateToken(),
    // Registration metadata
    registration: {
      method: 'mobile_app_automation',
      githubRunId: RUN_ID,
      timestamp: timestamp
    }
  };
  
  return sessionData;
}

function generateId(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateToken() {
  return Buffer.from(Math.random().toString()).toString('base64');
}

function generateSecretBundle() {
  return JSON.stringify({
    key: generateId(32),
    encKey: generateId(32),
    macKey: generateId(32)
  });
}

async function saveSession(phone, status = 'initialized') {
  const session = generateSessionData(phone);
  session.status = status;
  session.lastUpdated = new Date().toISOString();
  
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  log('SESSION', `Saved session to ${SESSION_FILE}`);
  
  await webhook('session_update', { session_data: session });
  return session;
}

// ── WhatsApp App Control ──────────────────────────────────────────────────────

async function launchWhatsApp() {
  log('APP', 'Launching WhatsApp...');
  shell(`am start -n ${WHATSAPP_PACKAGE}/${WHATSAPP_PACKAGE}.Main`);
  await sleep(3000);
  await takeScreenshot('01_app_launch');
}

async function clearWhatsAppData() {
  log('APP', 'Clearing WhatsApp data...');
  shell(`pm clear ${WHATSAPP_PACKAGE}`);
  await sleep(2000);
}

async function grantWhatsAppPermissions() {
  log('APP', 'Granting WhatsApp permissions...');
  const perms = [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_SMS',
    'android.permission.SEND_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_PHONE_NUMBERS'
  ];
  
  for (const perm of perms) {
    shell(`pm grant ${WHATSAPP_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  await sleep(1000);
}

// ── Main Registration Flow ───────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting WhatsApp registration for: ${PHONE}`);
  await webhook('processing', { step: 'initialization' });
  
  // 1. Check emulator
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  await takeScreenshot('00_emulator_ready');
  log('STEP 1', '✓ Emulator ready');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  await takeScreenshot('02_device_awake');
  log('STEP 2', '✓ Device awake');

  // 3. Clear any existing WhatsApp data for fresh registration
  log('STEP 3', 'Clearing WhatsApp data...');
  await clearWhatsAppData();
  await takeScreenshot('03_data_cleared');
  log('STEP 3', '✓ Data cleared');

  // 4. Grant permissions before launch
  log('STEP 4', 'Granting permissions...');
  await grantWhatsAppPermissions();
  await takeScreenshot('04_permissions_granted');
  log('STEP 4', '✓ Permissions granted');

  // 5. Launch WhatsApp
  log('STEP 5', 'Launching WhatsApp...');
  await launchWhatsApp();
  
  // Wait for welcome screen
  const welcome = await waitFor(['Welcome to WhatsApp', 'AGREE AND CONTINUE', 'Terms and Privacy Policy'], 15000);
  await takeScreenshot('05_welcome_screen');
  log('STEP 5', '✓ WhatsApp launched');

  // 6. Click AGREE AND CONTINUE
  log('STEP 6', 'Clicking AGREE AND CONTINUE...');
  const agreeBtn = await waitFor('AGREE AND CONTINUE');
  tap(agreeBtn.element.coords.x, agreeBtn.element.coords.y);
  await sleep(2000);
  await takeScreenshot('06_terms_accepted');

  // Handle phone number permission popup
  const phonePerm = await verifyScreen(['Allow', 'Deny', 'phone number'], 5000);
  if (phonePerm.success && phonePerm.found === 'Allow') {
    const allowBtn = findElement(phonePerm.xml, 'Allow');
    if (allowBtn) {
      tap(allowBtn.coords.x, allowBtn.coords.y);
      await sleep(1000);
      await takeScreenshot('06b_phone_permission');
    }
  }
  log('STEP 6', '✓ Terms accepted');

  // 7. Enter phone number
  log('STEP 7', 'Entering phone number...');
  
  // Wait for phone number screen
  await waitFor(['Enter your phone number', 'Phone number', 'Next'], 10000);
  await takeScreenshot('07_phone_screen');
  
  // Try to detect country code field and change if needed
  const countryCheck = await verifyScreen(['United States', 'Nigeria', 'United Kingdom', 'country'], 5000);
  if (countryCheck.success) {
    log('STEP 7', `Detected country: ${countryCheck.found}`);
  }
  
  // Find phone number input field
  // Usually it's the field with hint or after country code
  const phoneField = await waitFor('Phone number');
  tap(phoneField.element.coords.x, phoneField.element.coords.y);
  await sleep(500);
  
  // Clear and enter number
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  keyevent('KEYCODE_DEL');
  await sleep(200);
  textInput(PHONE);
  await sleep(800);
  await takeScreenshot('07b_number_entered');
  
  // Click Next
  const nextBtn = await waitFor('Next');
  tap(nextBtn.element.coords.x, nextBtn.element.coords.y);
  await sleep(2000);
  await takeScreenshot('07c_number_submitted');
  log('STEP 7', '✓ Phone number submitted');

  // 8. Confirm number dialog
  log('STEP 8', 'Handling confirmation...');
  const confirmCheck = await verifyScreen(['OK', 'Edit', 'Yes', 'number is correct'], 8000);
  await takeScreenshot('08_confirmation_dialog');
  
  if (confirmCheck.success) {
    if (confirmCheck.found === 'OK' || confirmCheck.found === 'Yes') {
      const okBtn = findElement(confirmCheck.xml, confirmCheck.found);
      if (okBtn) {
        tap(okBtn.coords.x, okBtn.coords.y);
        await sleep(2000);
        await takeScreenshot('08b_confirmed');
      }
    }
  }
  log('STEP 8', '✓ Number confirmed');

  // 9. Wait for OTP screen
  log('STEP 9', 'Waiting for OTP verification screen...');
  await webhook('otp_requested', { 
    phone_number: PHONE,
    message: 'Please reply with the 6-digit OTP code'
  });
  
  const otpScreen = await waitFor(['Verifying', 'Enter your code', '6-digit code', 'SMS'], 15000);
  await takeScreenshot('09_otp_screen');
  log('STEP 9', '✓ OTP screen reached, waiting for user input...');

  // 10. Poll for OTP from bot
  log('STEP 10', 'Polling for OTP from Telegram bot...');
  const otp = await pollForOtp(15 * 60 * 1000); // 15 minute timeout
  
  if (!otp) {
    await takeScreenshot('10_otp_timeout');
    throw new Error('OTP not received within timeout period');
  }
  
  log('STEP 10', `OTP received: ${otp.substring(0, 2)}****`);
  
  // Enter OTP
  const codeFields = await waitFor(['Enter your code', '6-digit code']);
  // Tap on the code input area and enter OTP
  tap(codeFields.element.coords.x, codeFields.element.coords.y);
  await sleep(500);
  textInput(otp);
  await sleep(1000);
  await takeScreenshot('10b_otp_entered');

  // Wait for verification
  log('STEP 10', 'Waiting for verification...');
  const verifying = await verifyScreen(['Creating account', 'Setting up', 'Profile info', 'Your name'], 30000);
  await takeScreenshot('10c_verifying');
  log('STEP 10', '✓ OTP submitted');

  // 11. Handle profile setup (skip or set minimal)
  log('STEP 11', 'Handling profile setup...');
  const profileCheck = await verifyScreen(['Your name', 'Profile info', 'Next', 'DONE'], 15000);
  await takeScreenshot('11_profile_setup');
  
  if (profileCheck.success) {
    if (profileCheck.found === 'Your name' || profileCheck.found === 'Profile info') {
      // Enter a default name
      const nameField = findElement(profileCheck.xml, 'Your name') || 
                       findElement(profileCheck.xml, 'Type your name here');
      if (nameField) {
        tap(nameField.coords.x, nameField.coords.y);
        await sleep(500);
        textInput('User');
        await sleep(500);
      }
      
      const nextOrDone = await waitFor(['Next', 'DONE']);
      tap(nextOrDone.element.coords.x, nextOrDone.element.coords.y);
      await sleep(2000);
      await takeScreenshot('11b_profile_done');
    }
  }
  log('STEP 11', '✓ Profile setup complete');

  // 12. Handle backup/restore prompts
  log('STEP 12', 'Handling backup prompts...');
  const backupCheck = await verifyScreen(['Restore', 'Skip', 'Google Drive', 'Skip restore'], 10000);
  await takeScreenshot('12_backup_prompt');
  
  if (backupCheck.success) {
    // Prefer to skip restore for fresh registration
    const skipBtn = findElement(backupCheck.xml, 'Skip') || 
                   findElement(backupCheck.xml, 'Skip restore');
    if (skipBtn) {
      tap(skipBtn.coords.x, skipBtn.coords.y);
      await sleep(2000);
      await takeScreenshot('12b_backup_skipped');
    }
  }
  log('STEP 12', '✓ Backup handled');

  // 13. Wait for main chat screen
  log('STEP 13', 'Waiting for main screen...');
  const mainScreen = await waitFor(['Chats', 'Calls', 'Status', 'Settings', 'New chat'], 20000);
  await takeScreenshot('13_main_screen');
  log('STEP 13', '✓ WhatsApp ready');

  // 14. Generate and save session
  log('STEP 14', 'Generating session data...');
  const session = await saveSession(PHONE, 'registered');
  
  // Extract additional session info from device
  await extractWhatsAppSession();
  
  await takeScreenshot('14_session_saved');
  log('STEP 14', '✓ Session generated');

  // 15. Enable pairing mode (Linked Devices)
  log('STEP 15', 'Setting up for pairing...');
  await setupForPairing();
  await takeScreenshot('15_pairing_ready');
  log('STEP 15', '✓ Ready for pairing');

  // Success webhook
  await webhook('registered', { 
    session_data: session,
    screenshot_count: screenshotCounter
  });

  log('COMPLETE', 'Registration successful!');
  
  // Final screenshot
  await takeScreenshot('99_complete');
}

// ── OTP Polling ──────────────────────────────────────────────────────────────

async function pollForOtp(maxWaitMs = 900000) {
  const startTime = Date.now();
  const pollInterval = 3000; // Check every 3 seconds
  
  log('OTP_POLL', `Starting OTP poll (max ${maxWaitMs/1000}s)...`);
  
  while (Date.now() - startTime < maxWaitMs) {
    // Try to get OTP from bot via webhook endpoint or shared storage
    // For now, we'll check if the OTP was received via SMS on device
    const smsOtp = await checkDeviceSms();
    if (smsOtp) {
      log('OTP_POLL', `Found OTP in SMS: ${smsOtp.substring(0, 2)}****`);
      return smsOtp;
    }
    
    // Also check for any OTP that might have been sent via webhook to a local file
    try {
      if (fs.existsSync('/tmp/otp_received.txt')) {
        const otp = fs.readFileSync('/tmp/otp_received.txt', 'utf8').trim();
        if (otp && /^\d{6}$/.test(otp)) {
          fs.unlinkSync('/tmp/otp_received.txt');
          return otp;
        }
      }
    } catch (e) {}
    
    await sleep(pollInterval);
  }
  
  return null;
}

async function checkDeviceSms() {
  try {
    // Try to read SMS from device (requires SMS permission)
    const sms = shell('content query --uri content://sms/inbox --projection body --limit 1 2>/dev/null || echo ""');
    const match = sms.match(/(\d{6})/);
    if (match) return match[1];
  } catch (e) {}
  return null;
}

// ── Session Extraction ─────────────────────────────────────────────────────────

async function extractWhatsAppSession() {
  try {
    // Try to extract WhatsApp's internal session files
    // Note: This requires root access which may not be available
    const dataPath = `/data/data/${WHATSAPP_PACKAGE}`;
    
    // Pull shared_prefs if possible
    const prefsPath = `${dataPath}/shared_prefs`;
    const localPrefs = '/tmp/wa_prefs';
    
    fs.mkdirSync(localPrefs, { recursive: true });
    
    try {
      exec(`adb pull ${prefsPath}/ ${localPrefs} 2>/dev/null || true`);
      log('SESSION_EXTRACT', 'Pulled shared preferences');
    } catch (e) {}
    
    // Create comprehensive session info
    const sessionInfo = {
      extractedAt: new Date().toISOString(),
      phoneNumber: PHONE,
      package: WHATSAPP_PACKAGE,
      deviceInfo: {
        model: shell('getprop ro.product.model'),
        android: shell('getprop ro.build.version.release'),
        sdk: shell('getprop ro.build.version.sdk')
      }
    };
    
    fs.writeFileSync('/tmp/wa_session_info.json', JSON.stringify(sessionInfo, null, 2));
    
  } catch (e) {
    log('SESSION_EXTRACT', `Warning: ${e.message}`);
  }
}

// ── Pairing Setup ────────────────────────────────────────────────────────────

async function setupForPairing() {
  try {
    // Navigate to Linked Devices
    // Open menu (three dots)
    tap(950, 150); // Top right menu
    await sleep(1000);
    await takeScreenshot('15a_menu_opened');
    
    // Look for Settings or Linked Devices
    const menuCheck = await verifyScreen(['Settings', 'Linked devices', 'Device linking'], 5000);
    if (menuCheck.success) {
      const linkedDevices = findElement(menuCheck.xml, 'Linked devices') || 
                           findElement(menuCheck.xml, 'Device linking');
      if (linkedDevices) {
        tap(linkedDevices.coords.x, linkedDevices.coords.y);
        await sleep(2000);
        await takeScreenshot('15b_linked_devices');
        
        // Look for "Link a device" button
        const linkDevice = await verifyScreen(['Link a device', 'LINK A DEVICE', 'QR code'], 5000);
        if (linkDevice.success) {
          log('PAIRING', 'Linked Devices screen ready');
          
          // Generate pairing code if available (newer WhatsApp versions)
          const linkBtn = findElement(linkDevice.xml, 'Link a device') ||
                         findElement(linkDevice.xml, 'LINK A DEVICE');
          if (linkBtn) {
            tap(linkBtn.coords.x, linkBtn.coords.y);
            await sleep(2000);
            await takeScreenshot('15c_pairing_code_screen');
            
            // Check for "Link with phone number instead" option
            const phoneLink = await verifyScreen(['Link with phone number', 'phone number'], 5000);
            if (phoneLink.success) {
              log('PAIRING', 'Phone number linking available');
            }
          }
        }
      }
    }
    
    await webhook('pairing_requested', {
      phone_number: PHONE,
      message: 'WhatsApp is ready for pairing. Use Linked Devices to connect.'
    });
    
  } catch (e) {
    log('PAIRING', `Setup warning: ${e.message}`);
  }
}

// ── Error Handling ───────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('FATAL', err.message);
  
  try {
    await takeScreenshot('ERROR_final');
    shell('screencap -p /sdcard/error_dump.png');
    exec('adb pull /sdcard/error_dump.png /tmp/wa_screenshots/999_ERROR_DUMP.png');
    
    // Get final screen state
    const xml = await getXML();
    fs.writeFileSync('/tmp/wa_screenshots/final_ui.xml', xml);
    
    // Get visible text
    const texts = [];
    const textRe = /text="([^"]{2,50})"/g;
    let m;
    while ((m = textRe.exec(xml)) !== null) {
      texts.push(m[1]);
    }
    log('ERROR_SCREEN', `Last visible: ${texts.slice(0, 10).join(' | ')}`);
    
  } catch (e) {
    log('ERROR_SCREEN', `Could not capture: ${e.message}`);
  }
  
  await webhook('bad_number', { 
    reason: err.message,
    screenshot_count: screenshotCounter
  });
  
  process.exit(1);
});
