/**
 * wa_register.js — WhatsApp Mobile Registration Automation
 * Uses ONLY ADB + UIAutomator XML parsing
 * No Puppeteer - pure ADB automation
 */

const axios = require('axios');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const xml2js = require('xml2js');

// ── Configuration ────────────────────────────────────────────────────────────
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;
const NODE_PORT = process.env.NODE_PORT || '3001';

const POLL_INTERVAL = 3000;
const MAX_TOTAL_TIME = 15 * 60 * 1000; // 15 minutes total
const MAX_OTP_ATTEMPTS = 3;
const ADB_TIMEOUT = 120000; // 2 minutes for ADB commands

// ── State ─────────────────────────────────────────────────────────────────────
let otpAttempts = 0;
let startTime = Date.now();
let currentXml = '';

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, message, data) {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ' | Data: ' + JSON.stringify(data) : '';
  console.log(`[${timestamp}] [${level}] ${message}${dataStr}`);
}

function postAction(action, details) {
  log('POST', `[${action}] ${details}`);
}

// ── Webhook ──────────────────────────────────────────────────────────────────
async function sendWebhook(event, extra = {}) {
  try {
    const payload = {
      event,
      phone_number: PHONE_NUMBER,
      telegram_user_id: parseInt(TELEGRAM_USER_ID),
      run_id: GITHUB_RUN_ID,
      ...extra
    };

    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET
      },
      timeout: 10000
    });

    log('INFO', `Webhook sent: ${event}`, { status: response.status });
    return true;
  } catch (error) {
    log('ERROR', `Webhook failed: ${event}`, { error: error.message });
    return false;
  }
}

// ── OTP Polling ──────────────────────────────────────────────────────────────
async function pollForOtp() {
  const url = `http://localhost:${NODE_PORT}/otp/${PHONE_NUMBER}`;

  try {
    const response = await axios.get(url, {
      headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
      timeout: 5000
    });

    if (response.status === 200 && response.data) {
      return response.data.trim();
    }
  } catch (error) {
    if (error.response && error.response.status === 204) {
      return null;
    }
    log('WARN', 'OTP poll error', { error: error.message });
  }
  return null;
}

// ── ADB Commands ─────────────────────────────────────────────────────────────
function execAdb(command, timeout = ADB_TIMEOUT) {
  try {
    log('ADB', `Executing: ${command.substring(0, 100)}...`);
    const result = execSync(`adb ${command}`, { 
      encoding: 'utf8', 
      timeout: timeout,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return result.trim();
  } catch (e) {
    log('ERROR', `ADB command failed: ${command.substring(0, 100)}`, { 
      error: e.message,
      stderr: e.stderr?.toString(),
      stdout: e.stdout?.toString()
    });
    throw e;
  }
}

function execAdbBackground(command) {
  const parts = command.split(' ');
  const proc = spawn('adb', parts, { detached: true, stdio: 'ignore' });
  proc.unref();
  return proc;
}

// ── UI Actions ─────────────────────────────────────────────────────────────────
async function dumpUi() {
  try {
    execAdb('shell uiautomator dump /sdcard/window_dump.xml', 10000);
    await sleep(500);
    const xml = execAdb('shell cat /sdcard/window_dump.xml', 10000);
    currentXml = xml;
    return xml;
  } catch (e) {
    log('WARN', 'UI dump failed', { error: e.message });
    return '';
  }
}

function parseXmlBounds(boundsStr) {
  // Parse [x1,y1][x2,y2] to center point
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  const x1 = parseInt(match[1]);
  const y1 = parseInt(match[2]);
  const x2 = parseInt(match[3]);
  const y2 = parseInt(match[4]);
  return {
    x: Math.floor((x1 + x2) / 2),
    y: Math.floor((y1 + y2) / 2),
    x1, y1, x2, y2
  };
}

async function findElementByText(text, partial = true) {
  const xml = await dumpUi();
  if (!xml) return null;

  const parser = new xml2js.Parser({ explicitArray: false });

  try {
    const result = await parser.parseStringPromise(xml);
    const nodes = [];

    function traverse(node) {
      if (!node) return;

      if (node.$ && (node.$.text || node.$.contentDescription)) {
        const nodeText = (node.$.text || node.$.contentDescription || '').toLowerCase();
        const searchText = text.toLowerCase();

        if (partial ? nodeText.includes(searchText) : nodeText === searchText) {
          const coords = parseXmlBounds(node.$.bounds);
          if (coords) {
            nodes.push({
              text: node.$.text || node.$.contentDescription,
              class: node.$.class,
              clickable: node.$.clickable === 'true',
              enabled: node.$.enabled !== 'false',
              ...coords
            });
          }
        }
      }

      // Traverse children
      Object.keys(node).forEach(key => {
        if (key !== '$' && node[key]) {
          if (Array.isArray(node[key])) {
            node[key].forEach(child => traverse(child));
          } else {
            traverse(node[key]);
          }
        }
      });
    }

    traverse(result.hierarchy);
    return nodes.length > 0 ? nodes[0] : null;
  } catch (e) {
    log('WARN', 'XML parse error', { error: e.message });
    return null;
  }
}

async function findElementByClass(className) {
  const xml = await dumpUi();
  if (!xml) return null;

  const parser = new xml2js.Parser({ explicitArray: false });

  try {
    const result = await parser.parseStringPromise(xml);
    const nodes = [];

    function traverse(node) {
      if (!node) return;

      if (node.$ && node.$.class && node.$.class.includes(className)) {
        const coords = parseXmlBounds(node.$.bounds);
        if (coords && node.$.clickable === 'true') {
          nodes.push({
            class: node.$.class,
            text: node.$.text || node.$.contentDescription || '',
            clickable: true,
            enabled: node.$.enabled !== 'false',
            ...coords
          });
        }
      }

      Object.keys(node).forEach(key => {
        if (key !== '$' && node[key]) {
          if (Array.isArray(node[key])) {
            node[key].forEach(child => traverse(child));
          } else {
            traverse(node[key]);
          }
        }
      });
    }

    traverse(result.hierarchy);
    return nodes.length > 0 ? nodes[0] : null;
  } catch (e) {
    log('WARN', 'XML parse error', { error: e.message });
    return null;
  }
}

async function findInputField() {
  const xml = await dumpUi();
  if (!xml) return null;

  const parser = new xml2js.Parser({ explicitArray: false });

  try {
    const result = await parser.parseStringPromise(xml);
    const nodes = [];

    function traverse(node) {
      if (!node) return;

      const isEditText = node.$ && node.$.class && (
        node.$.class.includes('EditText') || 
        node.$.class.includes('TextInput') ||
        node.$.class.includes('AutoCompleteTextView')
      );

      if (isEditText && node.$.focusable === 'true') {
        const coords = parseXmlBounds(node.$.bounds);
        if (coords) {
          nodes.push({
            class: node.$.class,
            text: node.$.text || '',
            hint: node.$.hint || '',
            ...coords
          });
        }
      }

      Object.keys(node).forEach(key => {
        if (key !== '$' && node[key]) {
          if (Array.isArray(node[key])) {
            node[key].forEach(child => traverse(child));
          } else {
            traverse(node[key]);
          }
        }
      });
    }

    traverse(result.hierarchy);
    return nodes.length > 0 ? nodes[0] : null;
  } catch (e) {
    log('WARN', 'XML parse error', { error: e.message });
    return null;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function tapElement(element, description) {
  if (!element) {
    log('WARN', `Cannot tap: element not found (${description})`);
    return false;
  }

  const { x, y } = element;
  postAction('TAP', `${description} at (${x}, ${y}) - Text: "${element.text || 'N/A'}"`);

  try {
    execAdb(`shell input tap ${x} ${y}`, 10000);
    await sleep(500);
    return true;
  } catch (e) {
    log('ERROR', `Tap failed for ${description}`, { error: e.message });
    return false;
  }
}

async function tapByText(text, description, partial = true) {
  const element = await findElementByText(text, partial);
  if (element) {
    return await tapElement(element, description || text);
  }
  log('WARN', `Text not found: "${text}"`);
  return false;
}

async function inputText(text, description) {
  postAction('INPUT', `${description}: "${text}"`);

  // Use input text command
  const escaped = text.replace(/ /g, '\s').replace(/'/g, "\'").replace(/"/g, '\"');

  try {
    execAdb(`shell input text "${escaped}"`, 10000);
    await sleep(300);
    return true;
  } catch (e) {
    log('ERROR', `Input failed: ${description}`, { error: e.message });
    return false;
  }
}

async function clearInputField(element) {
  if (!element) return false;

  postAction('CLEAR', `Input field at (${element.x}, ${element.y})`);

  // Tap to focus
  await tapElement(element, 'input field');
  await sleep(200);

  // Select all and delete
  execAdb('shell input keyevent --longpress 29 29 29', 5000); // Ctrl+A
  await sleep(200);
  execAdb('shell input keyevent 67', 5000); // Delete
  await sleep(200);

  return true;
}

async function pressKey(keycode, description) {
  postAction('KEY', `${description} (keycode ${keycode})`);
  try {
    execAdb(`shell input keyevent ${keycode}`, 5000);
    await sleep(300);
    return true;
  } catch (e) {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── WhatsApp Installation ─────────────────────────────────────────────────────
async function installWhatsApp() {
  log('INFO', '=== Installing WhatsApp ===');

  const apkPath = '/tmp/whatsapp.apk';
  if (!fs.existsSync(apkPath)) {
    throw new Error(`WhatsApp APK not found at ${apkPath}`);
  }

  // Check if already installed
  try {
    const packages = execAdb('shell pm list packages com.whatsapp', 10000);
    if (packages.includes('com.whatsapp')) {
      log('INFO', 'WhatsApp already installed, clearing data for fresh start');
      execAdb('shell pm clear com.whatsapp', 30000);
      await sleep(3000);
      return;
    }
  } catch (e) {
    // Not installed, continue
  }

  // Install with long timeout
  log('INFO', 'Installing APK (this may take a minute)...');
  try {
    // Use install-multiple for better handling of large APKs
    execAdb(`install -r -d ${apkPath}`, 300000); // 5 minute timeout
    log('INFO', 'APK installed successfully');
    await sleep(5000);
  } catch (e) {
    log('ERROR', 'APK installation failed', { error: e.message });
    throw e;
  }
}

async function grantPermissions() {
  log('INFO', 'Granting permissions');
  const perms = [
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_CONTACTS',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE'
  ];

  for (const perm of perms) {
    try {
      execAdb(`shell pm grant com.whatsapp ${perm}`, 5000);
    } catch (e) {
      // Ignore individual permission failures
    }
  }
  await sleep(1000);
}

async function launchWhatsApp() {
  log('INFO', '=== Launching WhatsApp ===');

  // Try different launch methods
  const attempts = [
    'shell am start -n com.whatsapp/.Main',
    'shell am start -n com.whatsapp/com.whatsapp.Main',
    'shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n com.whatsapp/.Main',
    'shell monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1'
  ];

  for (const cmd of attempts) {
    try {
      log('INFO', `Trying launch: ${cmd}`);
      execAdb(cmd, 15000);
      await sleep(4000);

      // Check if running
      const activities = execAdb('shell dumpsys activity activities | grep -i whatsapp', 10000);
      if (activities && activities.length > 10) {
        log('INFO', 'WhatsApp launched successfully');
        return true;
      }
    } catch (e) {
      log('WARN', `Launch attempt failed: ${e.message}`);
    }
  }

  throw new Error('Failed to launch WhatsApp after all attempts');
}

// ── Screen Detection ──────────────────────────────────────────────────────────
async function detectScreen() {
  const xml = await dumpUi();
  if (!xml) return 'UNKNOWN';

  const lowerXml = xml.toLowerCase();

  // Check for specific screens
  if (lowerXml.includes('agree') && lowerXml.includes('continue')) return 'WELCOME';
  if (lowerXml.includes('phone number') || lowerXml.includes('verify your phone')) return 'PHONE_ENTRY';
  if (lowerXml.includes('6-digit') || lowerXml.includes('verification code') || lowerXml.includes('enter code')) return 'OTP';
  if (lowerXml.includes('already registered') || lowerXml.includes('active on another device')) return 'ALREADY_REGISTERED';
  if (lowerXml.includes('try again later') || lowerXml.includes('too many attempts')) return 'RATE_LIMITED';
  if (lowerXml.includes('invalid phone number') || lowerXml.includes('not a valid')) return 'BAD_NUMBER';
  if (lowerXml.includes('banned') || lowerXml.includes('suspended')) return 'BANNED';
  if (lowerXml.includes('two-step') || lowerXml.includes('enter pin')) return 'TWO_STEP';
  if (lowerXml.includes('your name') || lowerXml.includes('profile info')) return 'PROFILE_SETUP';
  if (lowerXml.includes('chats') && lowerXml.includes('calls')) return 'LOGGED_IN';
  if (lowerXml.includes('connecting') || lowerXml.includes('loading')) return 'LOADING';

  return 'UNKNOWN';
}

function extractWaitTime(xml) {
  const lowerXml = xml.toLowerCase();
  const hourMatch = lowerXml.match(/(\d+)\s*hour/);
  const minMatch = lowerXml.match(/(\d+)\s*minute/);
  const secMatch = lowerXml.match(/(\d+)\s*second/);

  let seconds = 600; // Default 10 minutes
  if (hourMatch) seconds = parseInt(hourMatch[1]) * 3600;
  else if (minMatch) seconds = parseInt(minMatch[1]) * 60;
  else if (secMatch) seconds = parseInt(secMatch[1]);

  return seconds;
}

// ── Flow Handlers ──────────────────────────────────────────────────────────────
async function handleWelcomeScreen() {
  log('INFO', '=== Handling Welcome Screen ===');

  // Wait for screen to appear
  let attempts = 0;
  while (attempts < 10) {
    const screen = await detectScreen();
    if (screen === 'WELCOME') break;
    if (screen === 'PHONE_ENTRY') return true; // Already past welcome
    await sleep(1000);
    attempts++;
  }

  // Tap Agree and Continue
  const tapped = await tapByText('Agree and continue', 'Agree and Continue button');
  if (!tapped) {
    // Try coordinates fallback
    postAction('TAP', 'Agree button fallback at (540, 2000)');
    execAdb('shell input tap 540 2000', 5000);
  }

  await sleep(3000);

  // Handle any confirmation dialogs
  await tapByText('Continue', 'Continue button', true);
  await tapByText('OK', 'OK button', true);

  return true;
}

async function handlePhoneEntry() {
  log('INFO', '=== Handling Phone Number Entry ===');

  // Wait for phone entry screen
  let attempts = 0;
  while (attempts < 15) {
    const screen = await detectScreen();
    if (screen === 'PHONE_ENTRY') break;
    await sleep(1000);
    attempts++;
  }

  // Find and tap phone number field
  const inputField = await findInputField();
  if (inputField) {
    await clearInputField(inputField);
    await inputText(PHONE_NUMBER, 'Phone number');
  } else {
    // Fallback: tap center screen and type
    postAction('TAP', 'Phone field fallback at (700, 1000)');
    execAdb('shell input tap 700 1000', 5000);
    await sleep(500);
    await inputText(PHONE_NUMBER, 'Phone number');
  }

  await sleep(1000);

  // Tap Next/Continue
  const nextBtn = await findElementByText('Next', false) || 
                  await findElementByText('Continue', false) ||
                  await findElementByClass('Button');

  if (nextBtn) {
    await tapElement(nextBtn, 'Next/Continue button');
  } else {
    postAction('TAP', 'Next button fallback at (900, 2000)');
    execAdb('shell input tap 900 2000', 5000);
  }

  await sleep(3000);

  // Handle confirmation dialog
  await tapByText('OK', 'OK confirmation', true);
  await tapByText('Yes', 'Yes confirmation', true);

  return true;
}

async function handleOtpFlow() {
  log('INFO', '=== Handling OTP Verification ===');

  // Check time remaining
  const elapsed = Date.now() - startTime;
  const remaining = MAX_TOTAL_TIME - elapsed;

  if (remaining <= 0) {
    throw new Error('OTP_TIMEOUT');
  }

  if (otpAttempts >= MAX_OTP_ATTEMPTS) {
    throw new Error('OTP_EXHAUSTED');
  }

  otpAttempts++;
  log('INFO', `OTP attempt ${otpAttempts}/${MAX_OTP_ATTEMPTS}`);

  if (otpAttempts === 1) {
    await sendWebhook('otp_requested');
  }

  // Poll for OTP
  const otpStart = Date.now();
  let otp = null;

  while (Date.now() - otpStart < remaining && Date.now() - startTime < MAX_TOTAL_TIME) {
    otp = await pollForOtp();
    if (otp) break;
    process.stdout.write('.');
    await sleep(POLL_INTERVAL);
  }

  if (!otp) {
    throw new Error('OTP_TIMEOUT');
  }

  log('INFO', 'OTP received from user');

  // Validate
  if (!/^\d{6}$/.test(otp)) {
    await sendWebhook('otp_error', { reason: 'Invalid OTP format' });
    return false;
  }

  // Find OTP field and enter
  const otpField = await findInputField();
  if (otpField) {
    await tapElement(otpField, 'OTP input field');
    await clearInputField(otpField);
    await inputText(otp, 'OTP code');
  } else {
    // Fallback
    postAction('TAP', 'OTP field fallback at (540, 1000)');
    execAdb('shell input tap 540 1000', 5000);
    await inputText(otp, 'OTP code');
  }

  await sleep(5000);

  // Check result
  const screen = await detectScreen();

  if (screen === 'PROFILE_SETUP' || screen === 'LOGGED_IN') {
    log('INFO', 'OTP accepted');
    await sendWebhook('registered');
    return true;
  } else if (screen === 'OTP') {
    // Wrong OTP
    log('WARN', 'OTP rejected');
    await sendWebhook('otp_error', { 
      attempt: otpAttempts, 
      remaining: MAX_OTP_ATTEMPTS - otpAttempts 
    });

    if (otpAttempts < MAX_OTP_ATTEMPTS) {
      // Clear field and retry
      const field = await findInputField();
      if (field) await clearInputField(field);
      return await handleOtpFlow(); // Retry
    }
    return false;
  }

  return false;
}

async function handleTakeover() {
  log('INFO', '=== Handling Already Registered - Attempting Takeover ===');

  // Look for SMS verification option
  const smsOption = await findElementByText('Verify by SMS', true) ||
                    await findElementByText('Send SMS', true) ||
                    await findElementByText('Text message', true);

  if (smsOption) {
    log('INFO', 'Found SMS verification option');
    await tapElement(smsOption, 'SMS verification option');
    await sleep(3000);

    const screen = await detectScreen();
    if (screen === 'OTP') {
      return true; // Can proceed with SMS
    }
  }

  // Check for QR code (no SMS option)
  const hasQr = currentXml.toLowerCase().includes('qr code') ||
                currentXml.toLowerCase().includes('scan');

  if (hasQr) {
    log('INFO', 'Only QR pairing available, SMS takeover not possible');
    return false;
  }

  // Try tapping "Use this phone" if present
  const useThisPhone = await findElementByText('Use this phone', true);
  if (useThisPhone) {
    await tapElement(useThisPhone, 'Use this phone option');
    await sleep(3000);

    const screen = await detectScreen();
    return screen === 'OTP';
  }

  return false;
}

async function handleProfileSetup() {
  log('INFO', '=== Handling Profile Setup ===');

  await sleep(2000);

  // Enter name
  const nameField = await findInputField();
  if (nameField) {
    await tapElement(nameField, 'Name input field');
    await clearInputField(nameField);
    await inputText('WSCREATE', 'Profile name');
    await sleep(500);
  }

  // Tap Next
  const nextBtn = await findElementByText('Next', false) ||
                  await findElementByClass('Button');
  if (nextBtn) {
    await tapElement(nextBtn, 'Next button');
  }

  await sleep(2000);

  // Skip photo if prompted
  const skipBtn = await findElementByText('Skip', true);
  if (skipBtn) {
    await tapElement(skipBtn, 'Skip photo button');
  }

  await sleep(2000);

  // Handle any additional screens
  await tapByText('Next', 'Next button', true);
  await tapByText('Continue', 'Continue button', true);

  log('INFO', 'Profile setup complete');
  await sendWebhook('registered');
  return true;
}

// ── Main Flow ─────────────────────────────────────────────────────────────────
async function main() {
  log('INFO', '=== WhatsApp Registration Automation Started ===');
  log('INFO', 'Configuration', {
    phone: PHONE_NUMBER,
    userId: TELEGRAM_USER_ID,
    maxOtpAttempts: MAX_OTP_ATTEMPTS,
    timeoutMinutes: MAX_TOTAL_TIME / 60000
  });

  startTime = Date.now();

  // Wait for emulator
  await sleep(5000);

  // Install and launch
  await installWhatsApp();
  await grantPermissions();
  await launchWhatsApp();

  // Registration flow
  await handleWelcomeScreen();
  await handlePhoneEntry();

  // State machine
  let checks = 0;
  const maxChecks = 60;

  while (checks < maxChecks) {
    checks++;

    if (Date.now() - startTime >= MAX_TOTAL_TIME) {
      throw new Error('OTP_TIMEOUT');
    }

    const screen = await detectScreen();
    log('INFO', `Current screen: ${screen}`);

    switch (screen) {
      case 'OTP':
        const success = await handleOtpFlow();
        if (success) {
          await handleProfileSetup();
          log('INFO', '=== Registration Complete ===');
          return;
        }
        break;

      case 'ALREADY_REGISTERED':
        const canTakeover = await handleTakeover();
        if (!canTakeover) {
          await sendWebhook('already_registered');
          log('INFO', 'Takeover not possible, reporting already registered');
          return;
        }
        break;

      case 'RATE_LIMITED':
        const waitSeconds = extractWaitTime(currentXml);
        await sendWebhook('rate_limited', { wait_seconds: waitSeconds });
        throw new Error(`RATE_LIMITED: ${waitSeconds}s`);

      case 'BAD_NUMBER':
        await sendWebhook('bad_number', { reason: 'Invalid phone number' });
        throw new Error('BAD_NUMBER');

      case 'BANNED':
        await sendWebhook('banned');
        throw new Error('NUMBER_BANNED');

      case 'TWO_STEP':
        await sendWebhook('bad_number', { reason: 'Two-step verification required' });
        throw new Error('TWO_STEP_REQUIRED');

      case 'PROFILE_SETUP':
        await handleProfileSetup();
        return;

      case 'LOGGED_IN':
        await sendWebhook('registered');
        return;

      case 'LOADING':
      case 'WELCOME':
      case 'PHONE_ENTRY':
        log('INFO', 'Waiting for transition...');
        await sleep(3000);
        break;

      case 'UNKNOWN':
      default:
        log('WARN', 'Unknown screen, waiting...');
        await sleep(3000);
    }
  }

  throw new Error('MAX_CHECKS_EXCEEDED');
}

// ── Error Handling ────────────────────────────────────────────────────────────
async function handleError(error) {
  log('ERROR', 'Registration failed', { 
    error: error.message,
    otpAttempts,
    elapsedMs: Date.now() - startTime
  });

  let event = 'bad_number';
  let reason = error.message;

  if (error.message.includes('OTP_TIMEOUT')) {
    reason = 'OTP timeout - no code received within 15 minutes';
  } else if (error.message.includes('OTP_EXHAUSTED')) {
    event = 'otp_error';
    reason = 'All 3 OTP attempts failed';
  } else if (error.message.includes('RATE_LIMITED')) {
    event = 'rate_limited';
    const match = error.message.match(/(\d+)/);
    if (match) {
      await sendWebhook(event, { wait_seconds: parseInt(match[1]) });
      return;
    }
  } else if (error.message.includes('BANNED')) {
    event = 'banned';
  } else if (error.message.includes('TWO_STEP')) {
    reason = 'Two-step verification PIN required';
  }

  await sendWebhook(event, { reason });
}

// ── Entry Point ───────────────────────────────────────────────────────────────
(async () => {
  try {
    await main();
    process.exit(0);
  } catch (error) {
    await handleError(error);
    process.exit(1);
  }
})();
