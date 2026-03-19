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
const MAX_WAIT_TIME = 15 * 60 * 1000; // 15 minutes

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

// ── Screenshot helper ─────────────────────────────────────────────────────────
async function takeScreenshot(page, name) {
  try {
    const screenshotPath = `/tmp/screenshot_${name}_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log('INFO', `Screenshot saved: ${screenshotPath}`);
    return screenshotPath;
  } catch (e) {
    log('WARN', `Screenshot failed: ${e.message}`);
    return null;
  }
}

// ── ADB Helpers ─────────────────────────────────────────────────────────────────
function execAdb(command) {
  try {
    const result = execSync(`adb ${command}`, { encoding: 'utf8', timeout: 30000 });
    return result.trim();
  } catch (e) {
    log('ERROR', `ADB command failed: ${command}`, { error: e.message });
    throw e;
  }
}

function tap(x, y) {
  execAdb(`shell input tap ${x} ${y}`);
}

function inputText(text) {
  // Escape special characters for shell
  const escaped = text.replace(/ /g, '%s').replace(/'/g, '\\\'').replace(/"/g, '\\"');
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
    const xml = execAdb('shell cat /sdcard/window_dump.xml');
    return xml;
  } catch (e) {
    log('WARN', 'UI dump failed', { error: e.message });
    return '';
  }
}

function findInUi(xml, patterns) {
  for (const pattern of patterns) {
    if (xml.includes(pattern)) return pattern;
  }
  return null;
}

// ── Main Registration Flow ────────────────────────────────────────────────────
async function launchWhatsApp() {
  log('INFO', 'Launching WhatsApp...');
  
  // Launch WhatsApp
  execAdb('shell am start -n com.whatsapp/.Main');
  await sleep(5000);
  
  // Check if WhatsApp is running
  const activity = execAdb('shell dumpsys activity activities | grep mResumedActivity');
  log('INFO', 'Current activity', { activity });
  
  return activity.includes('whatsapp');
}

async function handleWelcomeScreen() {
  log('INFO', 'Checking for welcome screen...');
  const xml = await dumpUi();
  
  // Common welcome screen indicators
  const welcomeIndicators = [
    'Agree and continue',
    'Terms and Privacy Policy',
    'Welcome to WhatsApp',
    'Tap Agree and Continue'
  ];
  
  if (findInUi(xml, welcomeIndicators)) {
    log('INFO', 'Welcome screen detected, tapping Agree...');
    
    // Try to find and tap "Agree and continue" button
    // Coordinates for Pixel 4 (1080x2280)
    tap(540, 1800); // Approximate location of Agree button
    await sleep(2000);
    
    // Check for second confirmation
    await sleep(1000);
    const xml2 = await dumpUi();
    if (findInUi(xml2, ['CONTINUE', 'Continue', 'OK', 'Agree'])) {
      tap(540, 1800);
      await sleep(2000);
    }
    
    return true;
  }
  
  return false;
}

async function enterPhoneNumber() {
  log('INFO', 'Entering phone number...', { phone: PHONE_NUMBER });
  
  const xml = await dumpUi();
  
  // Check if we're on phone number entry screen
  const phoneIndicators = [
    'phone number',
    'Phone number',
    'Enter your phone number',
    'Verify your phone number'
  ];
  
  if (!findInUi(xml, phoneIndicators)) {
    log('WARN', 'Phone number screen not detected, current UI:', { xml: xml.substring(0, 500) });
    // Try to navigate to it if we're stuck
    pressBack();
    await sleep(1000);
  }
  
  // Clear any existing text
  tap(700, 800); // Tap number field
  await sleep(500);
  
  // Select all and delete
  execAdb('shell input keyevent --longpress 29 29 29'); // Ctrl+A equivalent
  await sleep(200);
  execAdb('shell input keyevent 67'); // Delete
  await sleep(200);
  
  // Enter phone number
  inputText(PHONE_NUMBER);
  await sleep(1000);
  
  // Tap Next/Done
  tap(540, 1300); // Next button location
  await sleep(3000);
  
  // Check for confirmation dialog
  const xml2 = await dumpUi();
  if (findInUi(xml2, ['OK', 'YES', 'Yes', 'number is correct'])) {
    tap(700, 1400); // Tap OK/Yes
    await sleep(2000);
  }
  
  return true;
}

async function detectPromptType() {
  const xml = await dumpUi();
  
  // OTP/SMS verification screen
  if (findInUi(xml, ['Enter 6-digit code', 'waiting to automatically detect', 'SMS', 'verification code'])) {
    return 'OTP_REQUESTED';
  }
  
  // Already registered / Active on another device
  if (findInUi(xml, ['Active on another device', 'already registered', 'registered on another phone'])) {
    return 'ALREADY_REGISTERED';
  }
  
  // Rate limited
  if (findInUi(xml, ['try again later', 'too many attempts', 'temporarily banned', 'wait', 'minutes', 'hours'])) {
    const match = xml.match(/(\d+)\s*(minute|hour|second)/i);
    const waitSeconds = match ? 
      (match[2] === 'hour' ? parseInt(match[1]) * 3600 : 
       match[2] === 'minute' ? parseInt(match[1]) * 60 : parseInt(match[1])) : 600;
    return { type: 'RATE_LIMITED', waitSeconds };
  }
  
  // Invalid number
  if (findInUi(xml, ['invalid phone number', 'not a valid', 'check the number', 'incorrect number'])) {
    return 'BAD_NUMBER';
  }
  
  // Network error
  if (findInUi(xml, ['network error', 'no internet', 'connection', 'check your connection'])) {
    return 'NETWORK_ERROR';
  }
  
  // Ban/Restriction
  if (findInUi(xml, ['banned', 'restricted', 'violated', 'terms of service', 'suspended'])) {
    return 'BANNED';
  }
  
  // Call me option (alternative to SMS)
  if (findInUi(xml, ['Call me', 'call me', 'phone call'])) {
    return 'CALL_ME_OPTION';
  }
  
  // Loading/Processing
  if (findInUi(xml, ['Connecting', 'loading', 'please wait', 'Processing', '...'])) {
    return 'LOADING';
  }
  
  // Profile setup (success indicator)
  if (findInUi(xml, ['Your name', 'profile photo', 'About you', 'Display name'])) {
    return 'PROFILE_SETUP';
  }
  
  // Main chats screen (already logged in)
  if (findInUi(xml, ['Chats', 'calls', 'camera', 'status'])) {
    return 'LOGGED_IN';
  }
  
  return 'UNKNOWN';
}

async function handleOtpFlow() {
  log('INFO', 'OTP verification flow started');
  
  // Notify bot that OTP is requested
  await sendWebhook('otp_requested');
  
  // Wait for OTP from user (via Telegram bot)
  const startTime = Date.now();
  let otp = null;
  
  while (Date.now() - startTime < MAX_WAIT_TIME) {
    otp = await pollForOtp();
    
    if (otp) {
      log('INFO', 'OTP received', { otp: otp.replace(/\d/g, '*') });
      break;
    }
    
    // Check for "Call me" option availability (after ~60 seconds)
    const elapsed = Date.now() - startTime;
    if (elapsed > 60000 && elapsed < 65000) {
      const xml = await dumpUi();
      if (findInUi(xml, ['Call me', 'call me'])) {
        log('INFO', 'Call me option is available');
        // We could tap it here if needed, but we'll wait for SMS OTP
      }
    }
    
    process.stdout.write('.');
    await sleep(POLL_INTERVAL);
  }
  
  if (!otp) {
    throw new Error('OTP_TIMEOUT');
  }
  
  // Enter OTP
  log('INFO', 'Entering OTP...');
  
  // Tap on OTP field and enter
  tap(540, 900); // OTP field
  await sleep(500);
  
  inputText(otp);
  await sleep(2000);
  
  // Wait for verification
  await sleep(5000);
  
  // Check result
  const prompt = await detectPromptType();
  
  if (prompt === 'PROFILE_SETUP' || prompt === 'LOGGED_IN') {
    await sendWebhook('registered');
    return true;
  } else if (prompt === 'OTP_REQUESTED') {
    // OTP was wrong
    await sendWebhook('otp_error');
    return false;
  }
  
  return false;
}

async function handleProfileSetup() {
  log('INFO', 'Setting up profile...');
  
  const xml = await dumpUi();
  
  // Skip name entry if present (use default)
  if (findInUi(xml, ['Your name', 'Display name'])) {
    tap(540, 1300); // Next/Continue
    await sleep(2000);
  }
  
  // Skip photo if requested
  if (findInUi(xml, ['Add photo', 'profile photo', 'skip'])) {
    // Look for skip button
    tap(900, 400); // Skip button (top right)
    await sleep(2000);
  }
  
  await sendWebhook('registered');
  return true;
}

async function checkForPinEntry() {
  const xml = await dumpUi();
  
  if (findInUi(xml, ['PIN', 'Two-step verification', 'Enter PIN', 'passcode'])) {
    log('WARN', 'Two-step verification PIN required - cannot proceed');
    await sendWebhook('bad_number', { reason: 'Two-step verification PIN required' });
    return true; // Indicates we should stop
  }
  
  return false;
}

async function handleRegistrationFlow() {
  log('INFO', '=== Starting WhatsApp Registration Flow ===');
  log('INFO', 'Configuration', { 
    phone: PHONE_NUMBER, 
    userId: TELEGRAM_USER_ID,
    webhookUrl: WEBHOOK_URL 
  });
  
  // Wait for emulator to be fully ready
  await sleep(5000);
  
  // Check ADB connection
  try {
    const devices = execAdb('devices');
    log('INFO', 'ADB devices', { devices });
    if (!devices.includes('emulator')) {
      throw new Error('No emulator found');
    }
  } catch (e) {
    throw new Error(`ADB connection failed: ${e.message}`);
  }
  
  // Launch WhatsApp
  await launchWhatsApp();
  await sleep(3000);
  
  // Handle initial screens
  await handleWelcomeScreen();
  await sleep(2000);
  
  // Enter phone number
  await enterPhoneNumber();
  await sleep(5000);
  
  // Main state machine
  let attempts = 0;
  const maxAttempts = 50;
  
  while (attempts < maxAttempts) {
    attempts++;
    log('INFO', `Checking state (attempt ${attempts})...`);
    
    const prompt = await detectPromptType();
    log('INFO', 'Detected prompt', { prompt: typeof prompt === 'object' ? prompt.type : prompt });
    
    if (prompt === 'OTP_REQUESTED') {
      const success = await handleOtpFlow();
      if (success) {
        await handleProfileSetup();
        log('INFO', '=== Registration Complete ===');
        return;
      } else {
        // OTP was wrong, might get another chance or fail
        await sleep(3000);
      }
    } else if (prompt === 'ALREADY_REGISTERED') {
      await sendWebhook('already_registered');
      log('INFO', 'Number already registered on another device');
      return;
    } else if (prompt === 'BAD_NUMBER') {
      await sendWebhook('bad_number', { reason: 'Invalid phone number format' });
      throw new Error('BAD_NUMBER');
    } else if (prompt === 'BANNED') {
      await sendWebhook('banned');
      throw new Error('NUMBER_BANNED');
    } else if (typeof prompt === 'object' && prompt.type === 'RATE_LIMITED') {
      await sendWebhook('rate_limited', { wait_seconds: prompt.waitSeconds });
      throw new Error(`RATE_LIMITED: ${prompt.waitSeconds}s`);
    } else if (prompt === 'NETWORK_ERROR') {
      log('WARN', 'Network error detected, waiting...');
      await sleep(10000);
    } else if (prompt === 'PROFILE_SETUP') {
      await handleProfileSetup();
      return;
    } else if (prompt === 'LOGGED_IN') {
      await sendWebhook('registered');
      return;
    } else if (prompt === 'LOADING') {
      log('INFO', 'Loading...');
      await sleep(3000);
    } else if (prompt === 'CALL_ME_OPTION') {
      log('INFO', 'Call me option available, continuing to wait for SMS');
      await sleep(5000);
    } else if (prompt === 'UNKNOWN') {
      // Check for PIN entry
      if (await checkForPinEntry()) {
        return;
      }
      
      // Try to recover from unknown state
      log('WARN', 'Unknown state, attempting recovery...');
      await takeScreenshot(null, 'unknown_state');
      pressBack();
      await sleep(2000);
    }
    
    // Safety check - if we've been waiting too long
    if (attempts === maxAttempts) {
      throw new Error('MAX_ATTEMPTS_EXCEEDED');
    }
  }
}

// ── Error Handling ─────────────────────────────────────────────────────────────
async function handleError(error) {
  log('ERROR', 'Registration failed', { 
    error: error.message, 
    stack: error.stack 
  });
  
  // Determine error type
  let event = 'bad_number';
  let reason = error.message;
  
  if (error.message.includes('OTP_TIMEOUT')) {
    event = 'bad_number';
    reason = 'OTP entry timeout - no code received within 15 minutes';
  } else if (error.message.includes('RATE_LIMITED')) {
    event = 'rate_limited';
    const match = error.message.match(/(\d+)/);
    if (match) {
      await sendWebhook(event, { wait_seconds: parseInt(match[1]) });
      return;
    }
  } else if (error.message.includes('BANNED')) {
    event = 'banned';
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
