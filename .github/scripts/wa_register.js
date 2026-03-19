/**
 * wa_register.js — WhatsApp Mobile Registration Automation
 * Runs inside GitHub Actions Android Emulator
 * Communicates with bot.py via webhooks and OTP polling endpoint
 */

const puppeteer = require('puppeteer');
const axios = require('axios');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── Configuration from environment ───────────────────────────────────────────
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;
const NODE_PORT = process.env.NODE_PORT || '3001';
const POLL_INTERVAL = 3000; // 3 seconds
const MAX_TOTAL_TIME = 15 * 60 * 1000; // 15 minutes total for all OTP attempts
const MAX_OTP_ATTEMPTS = 3;

// ── State ─────────────────────────────────────────────────────────────────────
let otpAttempts = 0;
let startTime = Date.now();

// ── Logging ───────────────────────────────────────────────────────────────────
function log(level, message, data = {}) {
  const timestamp = new Date().toISOString();
  const entry = { timestamp, level, message, ...data };
  console.log(`[${timestamp}] [${level}] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
  return entry;
}

// ── Webhook helpers ───────────────────────────────────────────────────────────
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

// ── OTP Polling ───────────────────────────────────────────────────────────────
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
      return null; // Not ready yet
    }
    log('WARN', 'OTP poll error', { error: error.message });
  }
  return null;
}

// ── ADB Helpers ─────────────────────────────────────────────────────────────────
function execAdb(command, timeout = 30000) {
  try {
    const result = execSync(`adb ${command}`, { encoding: 'utf8', timeout });
    return result.trim();
  } catch (e) {
    log('WARN', `ADB command failed (non-fatal): ${command}`, { error: e.message });
    return '';
  }
}

function execAdbStrict(command, timeout = 30000) {
  try {
    const result = execSync(`adb ${command}`, { encoding: 'utf8', timeout });
    return result.trim();
  } catch (e) {
    throw new Error(`ADB command failed: ${command} - ${e.message}`);
  }
}

function tap(x, y) {
  execAdb(`shell input tap ${x} ${y}`);
}

function inputText(text) {
  // Use base64 encoding to handle special characters properly
  const base64 = Buffer.from(text).toString('base64');
  execAdb(`shell am broadcast -a ADB_INPUT_B64 --es msg '${base64}'`);
  // Fallback to regular input if broadcast not available
  const escaped = text.replace(/ /g, '%s').replace(/'/g, "\'").replace(/"/g, '\"');
  execAdb(`shell input text "${escaped}"`);
}

function swipe(x1, y1, x2, y2, duration = 300) {
  execAdb(`shell input swipe ${x1} ${y1} ${x2} ${y2} ${duration}`);
}

function pressBack() {
  execAdb('shell input keyevent 4');
}

function pressEnter() {
  execAdb('shell input keyevent 66');
}

function pressDelete() {
  execAdb('shell input keyevent 67');
}

function clearInput() {
  // Select all and delete
  execAdb('shell input keyevent --longpress 29 29 29');
  sleep(200);
  pressDelete();
}

// ── Wait helpers ────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(conditionFn, timeoutMs = 30000, intervalMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await conditionFn()) return true;
    await sleep(intervalMs);
  }
  return false;
}

// ── UI Detection via ADB UI Automator ─────────────────────────────────────────
async function dumpUi() {
  try {
    execAdb('shell uiautomator dump /sdcard/window_dump.xml');
    await sleep(500);
    const xml = execAdb('shell cat /sdcard/window_dump.xml');
    return xml;
  } catch (e) {
    log('WARN', 'UI dump failed', { error: e.message });
    return '';
  }
}

function findInUi(xml, patterns) {
  if (!xml) return null;
  const lowerXml = xml.toLowerCase();
  for (const pattern of patterns) {
    if (lowerXml.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

function extractTimeFromText(text) {
  // Extract time like "2 hours", "30 minutes", "45 seconds"
  const hourMatch = text.match(/(\d+)\s*hour/i);
  const minMatch = text.match(/(\d+)\s*minute/i);
  const secMatch = text.match(/(\d+)\s*second/i);

  let seconds = 0;
  if (hourMatch) seconds += parseInt(hourMatch[1]) * 3600;
  if (minMatch) seconds += parseInt(minMatch[1]) * 60;
  if (secMatch) seconds += parseInt(secMatch[1]);

  return seconds > 0 ? seconds : 600; // Default 10 min if parsing fails
}

// ── WhatsApp Installation & Launch ────────────────────────────────────────────
async function installWhatsApp() {
  log('INFO', 'Installing WhatsApp APK...');
  try {
    const apkPath = '/tmp/whatsapp.apk';
    if (!fs.existsSync(apkPath)) {
      throw new Error('WhatsApp APK not found at /tmp/whatsapp.apk');
    }

    // Check if already installed
    const packages = execAdb('shell pm list packages');
    if (packages.includes('com.whatsapp')) {
      log('INFO', 'WhatsApp already installed, clearing data...');
      execAdb('shell pm clear com.whatsapp');
      await sleep(2000);
    } else {
      log('INFO', 'Installing APK...');
      execAdbStrict(`install -r ${apkPath}`);
      await sleep(5000);
    }

    return true;
  } catch (e) {
    log('ERROR', 'Failed to install WhatsApp', { error: e.message });
    throw e;
  }
}

async function launchWhatsApp() {
  log('INFO', 'Launching WhatsApp...');

  // Try multiple activity names
  const activities = [
    'com.whatsapp/.Main',
    'com.whatsapp/com.whatsapp.Main',
    'com.whatsapp/.HomeActivity',
    'com.whatsapp/com.whatsapp.HomeActivity',
    'com.whatsapp/.RegistrationActivity',
    'com.whatsapp/com.whatsapp.registration.EULA'
  ];

  for (const activity of activities) {
    try {
      log('INFO', `Trying activity: ${activity}`);
      execAdb(`shell am start -n ${activity}`);
      await sleep(3000);

      // Check if app is running
      const activityDump = execAdb('shell dumpsys activity activities');
      if (activityDump.includes('whatsapp') || activityDump.includes('WhatsApp')) {
        log('INFO', 'WhatsApp launched successfully');
        return true;
      }
    } catch (e) {
      log('WARN', `Activity ${activity} failed`, { error: e.message });
    }
  }

  // Fallback: just open the app package
  try {
    execAdb('shell monkey -p com.whatsapp -c android.intent.category.LAUNCHER 1');
    await sleep(3000);

    const check = execAdb('shell dumpsys activity activities');
    if (check.includes('whatsapp') || check.includes('WhatsApp')) {
      log('INFO', 'WhatsApp launched via monkey');
      return true;
    }
  } catch (e) {
    log('ERROR', 'Failed to launch WhatsApp', { error: e.message });
  }

  throw new Error('Could not launch WhatsApp - activity not found');
}

async function grantPermissions() {
  log('INFO', 'Granting permissions...');
  const permissions = [
    'android.permission.READ_SMS',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE'
  ];

  for (const perm of permissions) {
    try {
      execAdb(`shell pm grant com.whatsapp ${perm}`);
    } catch (e) {
      // Ignore permission grant failures
    }
  }
  await sleep(1000);
}

// ── Screen Handlers ────────────────────────────────────────────────────────────
async function handleWelcomeScreen() {
  log('INFO', 'Checking for welcome/EULA screen...');
  await sleep(2000);

  const xml = await dumpUi();

  // Welcome screen indicators
  const welcomeIndicators = [
    'agree and continue',
    'terms and privacy policy',
    'welcome to whatsapp',
    'tap agree',
    'eula',
    'accept',
    'continue'
  ];

  if (findInUi(xml, welcomeIndicators)) {
    log('INFO', 'Welcome screen detected');

    // Try to find Agree and Continue button by text
    // Coordinates for Pixel 4 (1080x2280) - bottom center
    tap(540, 2000);
    await sleep(2000);

    // Check for second confirmation (Age/Country confirmation)
    const xml2 = await dumpUi();
    if (findInUi(xml2, ['continue', 'ok', 'yes', 'confirm', 'next'])) {
      tap(540, 2000);
      await sleep(2000);
    }

    return true;
  }

  return false;
}

async function enterPhoneNumber() {
  log('INFO', 'Entering phone number...', { phone: PHONE_NUMBER });

  await sleep(2000);
  const xml = await dumpUi();

  // Check if we're on phone number entry screen
  const phoneIndicators = [
    'phone number',
    'verify your phone number',
    'enter your phone number',
    'country code',
    'mobile number'
  ];

  if (!findInUi(xml, phoneIndicators)) {
    log('WARN', 'Phone number screen not detected, attempting navigation...');
    // Try to proceed anyway
  }

  // Clear country code field and enter phone
  // Tap on phone number field (usually center screen)
  tap(700, 1000);
  await sleep(500);

  // Clear existing text
  clearInput();
  await sleep(500);

  // Enter phone number
  inputText(PHONE_NUMBER);
  await sleep(1000);

  // Tap Next/Continue button (bottom right)
  tap(900, 2000);
  await sleep(3000);

  // Handle confirmation dialog
  const xml2 = await dumpUi();
  if (findInUi(xml2, ['ok', 'yes', 'number is correct', 'confirm', 'edit'])) {
    // Tap OK/Yes to confirm
    tap(700, 1400);
    await sleep(3000);
  }

  return true;
}

async function detectPromptType() {
  const xml = await dumpUi();
  if (!xml) return 'UNKNOWN';

  const lowerXml = xml.toLowerCase();

  // OTP/SMS verification screen
  if (findInUi(xml, [
    'enter 6-digit code',
    'waiting to automatically detect',
    'sms',
    'verification code',
    'verify',
    '6-digit',
    'enter code',
    'we sent',
    'otp'
  ])) {
    return 'OTP_REQUESTED';
  }

  // Already registered / Active on another device
  if (findInUi(xml, [
    'active on another device',
    'already registered',
    'registered on another phone',
    'link a device',
    'use this phone',
    'already in use'
  ])) {
    return 'ALREADY_REGISTERED';
  }

  // Rate limited
  if (findInUi(xml, [
    'try again later',
    'too many attempts',
    'temporarily banned',
    'wait',
    'minutes remaining',
    'hours remaining',
    'retry after'
  ])) {
    const waitSeconds = extractTimeFromText(lowerXml);
    return { type: 'RATE_LIMITED', waitSeconds };
  }

  // Invalid number
  if (findInUi(xml, [
    'invalid phone number',
    'not a valid',
    'check the number',
    'incorrect number',
    'invalid number',
    'wrong number'
  ])) {
    return 'BAD_NUMBER';
  }

  // Network error
  if (findInUi(xml, [
    'network error',
    'no internet',
    'connection',
    'check your connection',
    'unable to connect',
    'failed to connect'
  ])) {
    return 'NETWORK_ERROR';
  }

  // Ban/Restriction
  if (findInUi(xml, [
    'banned',
    'restricted',
    'violated',
    'terms of service',
    'suspended',
    'blocked',
    'account disabled'
  ])) {
    return 'BANNED';
  }

  // Two-step verification
  if (findInUi(xml, [
    'two-step verification',
    'enter pin',
    '2-step',
    'passcode',
    'security code'
  ])) {
    return 'TWO_STEP_REQUIRED';
  }

  // Loading/Processing
  if (findInUi(xml, [
    'connecting',
    'loading',
    'please wait',
    'processing',
    '...',
    'initializing',
    'starting'
  ])) {
    return 'LOADING';
  }

  // Profile setup (success indicator)
  if (findInUi(xml, [
    'your name',
    'profile photo',
    'about you',
    'display name',
    'set up profile',
    'profile info'
  ])) {
    return 'PROFILE_SETUP';
  }

  // Main chats screen (already logged in)
  if (findInUi(xml, [
    'chats',
    'calls',
    'camera',
    'status',
    'conversations',
    'new chat'
  ])) {
    return 'LOGGED_IN';
  }

  // Call me option (but we ignore it per requirements)
  if (findInUi(xml, ['call me', 'phone call'])) {
    return 'CALL_ME_OPTION';
  }

  return 'UNKNOWN';
}

async function handleOtpFlow() {
  log('INFO', 'Starting OTP verification flow');

  // Check if we have time left
  const elapsed = Date.now() - startTime;
  const remainingTime = MAX_TOTAL_TIME - elapsed;

  if (remainingTime <= 0) {
    throw new Error('OTP_TIMEOUT');
  }

  if (otpAttempts >= MAX_OTP_ATTEMPTS) {
    log('ERROR', 'Max OTP attempts reached');
    await sendWebhook('otp_error', { reason: 'Maximum 3 OTP attempts exceeded' });
    return false;
  }

  otpAttempts++;
  log('INFO', `OTP attempt ${otpAttempts}/${MAX_OTP_ATTEMPTS}`);

  // Notify bot that OTP is requested
  if (otpAttempts === 1) {
    await sendWebhook('otp_requested');
  }

  // Wait for OTP from user
  const otpStartTime = Date.now();
  let otp = null;

  while (Date.now() - otpStartTime < remainingTime) {
    otp = await pollForOp();

    if (otp) {
      log('INFO', 'OTP received from user');
      break;
    }

    // Check global timeout
    if (Date.now() - startTime >= MAX_TOTAL_TIME) {
      throw new Error('OTP_TIMEOUT');
    }

    process.stdout.write('.');
    await sleep(POLL_INTERVAL);
  }

  if (!otp) {
    throw new Error('OTP_TIMEOUT');
  }

  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    log('WARN', 'Invalid OTP format received');
    await sendWebhook('otp_error', { reason: 'Invalid OTP format (must be 6 digits)' });
    return false;
  }

  // Enter OTP
  log('INFO', 'Entering OTP...');

  // Tap on OTP field
  tap(540, 1000);
  await sleep(500);

  // Clear any existing
  clearInput();
  await sleep(300);

  // Enter OTP
  inputText(otp);
  await sleep(3000);

  // Wait for verification result
  await sleep(5000);

  // Check result
  const prompt = await detectPromptType();
  log('INFO', 'Post-OTP detection', { prompt: typeof prompt === 'object' ? prompt.type : prompt });

  if (prompt === 'PROFILE_SETUP' || prompt === 'LOGGED_IN') {
    log('INFO', 'OTP accepted, registration successful');
    await sendWebhook('registered');
    return true;
  } else if (prompt === 'OTP_REQUESTED') {
    // OTP was wrong
    log('WARN', 'OTP rejected by WhatsApp');
    await sendWebhook('otp_error', { attempt: otpAttempts, remaining: MAX_OTP_ATTEMPTS - otpAttempts });

    // Clear the OTP field for retry
    clearInput();
    await sleep(1000);

    // If we have attempts left, retry
    if (otpAttempts < MAX_OTP_ATTEMPTS) {
      log('INFO', 'Will retry with new OTP...');
      return await handleOtpFlow(); // Recursive retry
    } else {
      log('ERROR', 'All OTP attempts exhausted');
      return false;
    }
  } else if (typeof prompt === 'object' && prompt.type === 'RATE_LIMITED') {
    await sendWebhook('rate_limited', { wait_seconds: prompt.waitSeconds });
    throw new Error(`RATE_LIMITED: ${prompt.waitSeconds}s`);
  } else if (prompt === 'BAD_NUMBER') {
    await sendWebhook('bad_number', { reason: 'Invalid number during verification' });
    throw new Error('BAD_NUMBER');
  } else if (prompt === 'BANNED') {
    await sendWebhook('banned');
    throw new Error('NUMBER_BANNED');
  }

  // Unexpected state
  log('WARN', 'Unexpected state after OTP entry', { prompt });
  return false;
}

async function handleTakeover() {
  log('INFO', 'Attempting takeover - looking for SMS option...');

  const xml = await dumpUi();

  // Look for "Use this phone" or "Link a device" options
  if (findInUi(xml, ['use this phone', 'link a device', 'verify by sms', 'verify by phone'])) {
    // Tap on SMS verification option
    log('INFO', 'Found SMS verification option, tapping...');
    tap(540, 1400); // Approximate position
    await sleep(3000);

    // Check if we got to OTP screen
    const prompt = await detectPromptType();
    if (prompt === 'OTP_REQUESTED') {
      log('INFO', 'Takeover via SMS is possible');
      return true;
    }
  }

  // Check if we see QR code pairing (no SMS option)
  if (findInUi(xml, ['scan qr code', 'qr code', 'pair with phone', 'link with qr'])) {
    log('INFO', 'Only QR pairing available, SMS takeover not possible');
    return false;
  }

  // Try to find any SMS-related button
  const buttons = [
    'verify by sms',
    'send sms',
    'sms verification',
    'text message',
    'use sms'
  ];

  for (const btn of buttons) {
    if (xml.toLowerCase().includes(btn)) {
      log('INFO', `Found button: ${btn}`);
      // Try tapping in different positions
      tap(540, 1400);
      await sleep(2000);

      const check = await detectPromptType();
      if (check === 'OTP_REQUESTED') return true;
    }
  }

  return false;
}

async function handleProfileSetup() {
  log('INFO', 'Setting up profile with name: WSCREATE');

  await sleep(2000);
  const xml = await dumpUi();

  // Handle name entry
  if (findInUi(xml, ['your name', 'display name', 'profile name', 'name'])) {
    log('INFO', 'Entering profile name...');

    // Tap name field
    tap(540, 900);
    await sleep(500);

    // Clear and enter name
    clearInput();
    await sleep(300);
    inputText('WSCREATE');
    await sleep(1000);

    // Tap Next/Continue
    tap(900, 2000);
    await sleep(3000);
  }

  // Handle photo screen - skip it
  await sleep(2000);
  const xml2 = await dumpUi();

  if (findInUi(xml2, ['add photo', 'profile photo', 'set photo', 'camera', 'gallery'])) {
    log('INFO', 'Skipping photo setup...');

    // Look for skip button (usually top right or bottom)
    tap(1000, 150); // Top right skip
    await sleep(1000);

    // Or try back button
    if (findInUi(await dumpUi(), ['add photo', 'profile photo'])) {
      pressBack();
      await sleep(1000);
    }
  }

  // Handle about/status - skip if present
  const xml3 = await dumpUi();
  if (findInUi(xml3, ['about', 'status', 'bio'])) {
    tap(900, 2000); // Next
    await sleep(2000);
  }

  log('INFO', 'Profile setup complete');
  await sendWebhook('registered');
  return true;
}

// ── Main Registration Flow ────────────────────────────────────────────────────
async function handleRegistrationFlow() {
  log('INFO', '=== Starting WhatsApp Registration Flow ===');
  log('INFO', 'Configuration', { 
    phone: PHONE_NUMBER, 
    userId: TELEGRAM_USER_ID,
    maxOtpAttempts: MAX_OTP_ATTEMPTS,
    totalTimeout: `${MAX_TOTAL_TIME/60000}min`
  });

  startTime = Date.now();

  // Wait for emulator
  await sleep(3000);

  // Check ADB
  const devices = execAdb('devices');
  log('INFO', 'ADB devices', { devices: devices.substring(0, 200) });

  if (!devices.includes('emulator')) {
    throw new Error('No emulator found in ADB devices');
  }

  // Install and launch WhatsApp
  await installWhatsApp();
  await grantPermissions();
  await launchWhatsApp();

  // Handle initial flow
  await handleWelcomeScreen();
  await enterPhoneNumber();

  // Main state machine
  let attempts = 0;
  const maxStateAttempts = 60; // 60 * 3s = 3 minutes of state checking

  while (attempts < maxStateAttempts) {
    attempts++;

    // Check global timeout
    if (Date.now() - startTime >= MAX_TOTAL_TIME) {
      throw new Error('OTP_TIMEOUT');
    }

    log('INFO', `State check ${attempts}/${maxStateAttempts}`);
    const prompt = await detectPromptType();
    const promptType = typeof prompt === 'object' ? prompt.type : prompt;
    log('INFO', 'Current state', { state: promptType });

    switch (promptType) {
      case 'OTP_REQUESTED':
        const success = await handleOtpFlow();
        if (success) {
          await handleProfileSetup();
          log('INFO', '=== Registration Complete ===');
          return;
        }
        // If OTP flow returned false but didn't throw, we exhausted attempts
        throw new Error('OTP_EXHAUSTED');

      case 'ALREADY_REGISTERED':
        log('INFO', 'Number already registered, attempting takeover...');
        const canTakeover = await handleTakeover();
        if (!canTakeover) {
          log('INFO', 'Takeover not possible (no SMS option)');
          await sendWebhook('already_registered');
          return;
        }
        // If takeover possible, loop will catch OTP_REQUESTED next iteration
        break;

      case 'RATE_LIMITED':
        await sendWebhook('rate_limited', { wait_seconds: prompt.waitSeconds });
        throw new Error(`RATE_LIMITED: ${prompt.waitSeconds}s`);

      case 'BAD_NUMBER':
        await sendWebhook('bad_number', { reason: 'Invalid phone number' });
        throw new Error('BAD_NUMBER');

      case 'BANNED':
        await sendWebhook('banned');
        throw new Error('NUMBER_BANNED');

      case 'TWO_STEP_REQUIRED':
        await sendWebhook('bad_number', { reason: 'Two-step verification PIN required' });
        throw new Error('TWO_STEP_REQUIRED');

      case 'NETWORK_ERROR':
        log('WARN', 'Network error, waiting...');
        await sleep(10000);
        break;

      case 'PROFILE_SETUP':
        await handleProfileSetup();
        return;

      case 'LOGGED_IN':
        log('INFO', 'Already logged in');
        await sendWebhook('registered');
        return;

      case 'LOADING':
      case 'CALL_ME_OPTION':
        log('INFO', 'Waiting...');
        await sleep(3000);
        break;

      case 'UNKNOWN':
      default:
        log('WARN', 'Unknown state, attempting recovery...');
        if (attempts % 5 === 0) {
          pressBack();
        }
        await sleep(3000);
    }
  }

  throw new Error('MAX_ATTEMPTS_EXCEEDED');
}

// ── Error Handling ─────────────────────────────────────────────────────────────
async function handleError(error) {
  log('ERROR', 'Registration failed', { 
    error: error.message,
    otpAttempts,
    elapsed: `${(Date.now() - startTime)/1000}s`
  });

  let event = 'bad_number';
  let reason = error.message;

  if (error.message.includes('OTP_TIMEOUT')) {
    event = 'bad_number';
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
    reason = 'Number banned by WhatsApp';
  } else if (error.message.includes('TWO_STEP_REQUIRED')) {
    event = 'bad_number';
    reason = 'Two-step verification required';
  } else if (error.message.includes('BAD_NUMBER')) {
    event = 'bad_number';
    reason = 'Invalid phone number';
  }

  await sendWebhook(event, { reason });
}

// ── Main Entry ─────────────────────────────────────────────────────────────────
(async () => {
  try {
    await handleRegistrationFlow();
    process.exit(0);
  } catch (error) {
    await handleError(error);
    process.exit(1);
  }
})();
