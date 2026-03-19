/**
 * wa_register.js
 * WhatsApp Android Registration Automation
 * Runs in GitHub Actions Android Emulator
 * 
 * Environment variables:
 * - PHONE_NUMBER: Phone to register (e.g., 2348012345678)
 * - TELEGRAM_USER_ID: User ID for callbacks
 * - WEBHOOK_URL: Bot webhook endpoint
 * - WEBHOOK_SECRET: Shared secret for auth
 * - GITHUB_RUN_ID: Current run ID
 */

const { exec, execSync } = require('child_process');
const util = require('util');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const xml2js = require('xml2js');

const execAsync = util.promisify(exec);
const xmlParser = new xml2js.Parser({ explicitArray: false });

// Configuration
const CONFIG = {
  phoneNumber: process.env.PHONE_NUMBER || '',
  userId: process.env.TELEGRAM_USER_ID || '',
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  runId: process.env.GITHUB_RUN_ID || '',
  apkPath: '/tmp/whatsapp.apk',
  packageName: 'com.whatsapp',
  deviceId: 'emulator-5554',
  otpTimeout: 15 * 60 * 1000,
  pollInterval: 3000,
};

// Logging Helper
function log(section, message, data = null) {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${section}] ${message}`;
  console.log(logLine);
  if (data) {
    console.log('  -> Data:', JSON.stringify(data, null, 2).split('\n').join('\n    '));
  }
}

// ADB Helpers
async function adb(command, timeout = 30000) {
  const fullCommand = `adb -s ${CONFIG.deviceId} ${command}`;
  log('ADB', `Executing: ${fullCommand}`);
  try {
    const { stdout, stderr } = await execAsync(fullCommand, { timeout });
    if (stderr && !stderr.includes('WARNING')) {
      log('ADB', 'Stderr output:', stderr);
    }
    return stdout.trim();
  } catch (error) {
    log('ADB', `Error executing command: ${error.message}`);
    throw error;
  }
}

async function getUiHierarchy(retries = 3) {
  const remotePath = '/sdcard/window_dump.xml';
  const localPath = '/tmp/ui_dump.xml';

  for (let i = 0; i < retries; i++) {
    try {
      await adb(`shell uiautomator dump ${remotePath}`);
      await adb(`pull ${remotePath} ${localPath}`);
      const xml = fs.readFileSync(localPath, 'utf8');
      const parsed = await xmlParser.parseStringPromise(xml);
      return parsed;
    } catch (error) {
      log('UI', `Failed to get UI hierarchy (attempt ${i + 1}/${retries}): ${error.message}`);
      if (i === retries - 1) throw error;
      await sleep(1000);
    }
  }
}

function findNodeByAttr(node, attr, value, contains = false) {
  if (!node) return null;

  if (node.$) {
    const nodeVal = node.$[attr];
    if (nodeVal) {
      if (contains && nodeVal.toLowerCase().includes(value.toLowerCase())) return node;
      if (!contains && nodeVal === value) return node;
    }
  }

  const children = node.node;
  if (!children) return null;

  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findNodeByAttr(child, attr, value, contains);
      if (found) return found;
    }
  } else {
    return findNodeByAttr(children, attr, value, contains);
  }
  return null;
}

function getBoundsCenter(bounds) {
  const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return { x: 0, y: 0 };
  const x = (parseInt(match[1]) + parseInt(match[3])) / 2;
  const y = (parseInt(match[2]) + parseInt(match[4])) / 2;
  return { x: Math.round(x), y: Math.round(y) };
}

// Interaction Helpers
async function tapText(text, contains = true, timeout = 10000) {
  log('UI', `Looking for text: "${text}"`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const hierarchy = await getUiHierarchy();
    const node = findNodeByAttr(hierarchy.hierarchy, 'text', text, contains) || 
                 findNodeByAttr(hierarchy.hierarchy, 'content-desc', text, contains);

    if (node && node.$) {
      const bounds = node.$.bounds;
      const center = getBoundsCenter(bounds);
      log('UI', `Found "${text}" at bounds ${bounds}, tapping ${center.x},${center.y}`);
      await adb(`shell input tap ${center.x} ${center.y}`);
      return true;
    }
    await sleep(500);
  }
  throw new Error(`Text "${text}" not found within ${timeout}ms`);
}

async function tapResourceId(resourceId, timeout = 10000) {
  log('UI', `Looking for resource-id: "${resourceId}"`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const hierarchy = await getUiHierarchy();
    const node = findNodeByAttr(hierarchy.hierarchy, 'resource-id', resourceId, false);

    if (node && node.$) {
      const bounds = node.$.bounds;
      const center = getBoundsCenter(bounds);
      log('UI', `Found resource-id "${resourceId}" at ${center.x},${center.y}`);
      await adb(`shell input tap ${center.x} ${center.y}`);
      return true;
    }
    await sleep(500);
  }
  return false;
}

async function inputText(text) {
  log('UI', `Inputting text: "${text}"`);
  await adb('shell input keyevent KEYCODE_TAB');
  await sleep(200);
  const safeText = text.replace(/ /g, '%s');
  await adb(`shell input text "${safeText}"`);
}

async function inputPhoneNumber(phone) {
  log('UI', `Inputting phone number: ${phone}`);
  const phoneField = await findResourceId('com.whatsapp:id/registration_phone', 5000);

  if (phoneField) {
    const center = getBoundsCenter(phoneField.$.bounds);
    await adb(`shell input tap ${center.x} ${center.y}`);
    await sleep(300);
    await adb('shell input keyevent --longpress 67 67 67 67 67 67 67 67 67 67');
    await sleep(200);
    await inputText(phone);
  } else {
    await inputText(phone);
  }
}

async function findResourceId(id, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const hierarchy = await getUiHierarchy();
    const node = findNodeByAttr(hierarchy.hierarchy, 'resource-id', id);
    if (node) return node;
    await sleep(500);
  }
  return null;
}

async function waitForText(text, timeout = 30000, contains = true) {
  log('WAIT', `Waiting for text: "${text}" (timeout: ${timeout}ms)`);
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    const hierarchy = await getUiHierarchy();
    const node = findNodeByAttr(hierarchy.hierarchy, 'text', text, contains) ||
                 findNodeByAttr(hierarchy.hierarchy, 'content-desc', text, contains);
    if (node) {
      log('WAIT', `Found text: "${text}"`);
      return node;
    }
    await sleep(1000);
  }
  return null;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Webhook Helpers
async function sendWebhook(event, extraData = {}) {
  const payload = {
    event,
    phone_number: CONFIG.phoneNumber,
    telegram_user_id: CONFIG.userId,
    run_id: CONFIG.runId,
    ...extraData
  };

  log('WEBHOOK', `Sending event: ${event}`, payload);

  try {
    const response = await axios.post(CONFIG.webhookUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': CONFIG.webhookSecret
      },
      timeout: 10000
    });
    log('WEBHOOK', `Success: ${response.status}`);
    return true;
  } catch (error) {
    log('WEBHOOK', `Failed: ${error.message}`);
    if (error.response) {
      log('WEBHOOK', `Response: ${error.response.status} ${error.response.data}`);
    }
    return false;
  }
}

async function pollForOtp() {
  const otpUrl = CONFIG.webhookUrl.replace('/webhook/event', `/otp/${CONFIG.phoneNumber}`);
  log('OTP', `Starting OTP poll from: ${otpUrl}`);

  const startTime = Date.now();
  while (Date.now() - startTime < CONFIG.otpTimeout) {
    try {
      const response = await axios.get(otpUrl, {
        headers: {
          'X-Webhook-Secret': CONFIG.webhookSecret
        },
        timeout: 5000,
        validateStatus: (status) => status === 200 || status === 204
      });

      if (response.status === 200 && response.data) {
        const otp = response.data.toString().trim();
        log('OTP', `Received OTP: ${otp}`);
        return otp;
      }
    } catch (error) {
      log('OTP', `Poll error: ${error.message}`);
    }

    process.stdout.write('.');
    await sleep(CONFIG.pollInterval);
  }

  throw new Error('OTP polling timeout - 15 minutes elapsed');
}

// WhatsApp Flow
async function installWhatsApp() {
  log('SETUP', 'Installing WhatsApp APK...');
  if (!fs.existsSync(CONFIG.apkPath)) {
    throw new Error(`APK not found at ${CONFIG.apkPath}`);
  }

  await adb(`install -r ${CONFIG.apkPath}`);
  log('SETUP', 'WhatsApp installed successfully');
}

async function launchWhatsApp() {
  log('APP', 'Launching WhatsApp...');
  await adb(`shell am start -n ${CONFIG.packageName}/com.whatsapp.Main`);
  await sleep(3000);
}

async function clearWhatsAppData() {
  log('APP', 'Clearing WhatsApp data...');
  await adb(`shell pm clear ${CONFIG.packageName}`).catch(() => {});
}

async function handleRegistrationFlow() {
  log('FLOW', '=== Starting WhatsApp Registration Flow ===');
  log('FLOW', `Phone: ${CONFIG.phoneNumber}, User: ${CONFIG.userId}`);

  await clearWhatsAppData();
  await launchWhatsApp();
  await sleep(5000);

  // Step 1: Handle Welcome Screen
  log('STEP', '1: Looking for Welcome screen...');
  try {
    await tapText('Agree and continue', true, 15000);
    log('STEP', '1: Clicked Agree and continue');
    await sleep(2000);
  } catch (e) {
    log('STEP', '1: No welcome screen or already past it');
  }

  // Step 2: Phone Number Entry
  log('STEP', '2: Entering phone number...');

  const phoneScreen = await waitForText('phone number', 20000);
  if (!phoneScreen) {
    throw new Error('Phone number entry screen not found');
  }

  if (CONFIG.phoneNumber.startsWith('234')) {
    log('STEP', '2: Detected Nigerian number');
    try {
      await tapText('Nigeria', true, 3000);
    } catch (e) {}
  }

  let phoneToInput = CONFIG.phoneNumber;
  if (CONFIG.phoneNumber.startsWith('234')) {
    phoneToInput = CONFIG.phoneNumber.substring(3);
  }

  await inputPhoneNumber(phoneToInput);
  log('STEP', '2: Phone number entered');
  await sleep(1000);

  try {
    await tapText('Next', false, 5000);
  } catch (e) {
    await tapResourceId('com.whatsapp:id/registration_next', 5000);
  }
  log('STEP', '2: Clicked Next');
  await sleep(3000);

  // Step 3: Confirm Number Dialog
  log('STEP', '3: Handling confirmation dialog...');
  try {
    await tapText('OK', false, 5000);
    log('STEP', '3: Confirmed number');
  } catch (e) {
    log('STEP', '3: No confirmation dialog');
  }
  await sleep(2000);

  // Step 4: Check for immediate errors
  log('STEP', '4: Checking for immediate validation errors...');

  const errorChecks = [
    { text: 'Invalid', event: 'bad_number', reason: 'Invalid phone number format' },
    { text: 'incorrect', event: 'bad_number', reason: 'Incorrect phone number' },
    { text: 'already registered', event: 'already_registered', reason: 'Number already has WhatsApp account' },
    { text: 'banned', event: 'bad_number', reason: 'Number banned from WhatsApp' },
    { text: 'temporarily', event: 'rate_limited', reason: 'Rate limited by WhatsApp' },
    { text: 'Too many attempts', event: 'rate_limited', reason: 'Too many attempts' }
  ];

  const hierarchy = await getUiHierarchy();
  for (const check of errorChecks) {
    const errorNode = findNodeByAttr(hierarchy.hierarchy, 'text', check.text, true);
    if (errorNode) {
      log('ERROR', `Detected error: ${check.text}`);
      if (check.event === 'rate_limited') {
        const fullText = errorNode.$.text || '';
        const minutesMatch = fullText.match(/(\d+)\s*minute/i);
        const secondsMatch = fullText.match(/(\d+)\s*second/i);
        let waitSeconds = 600;
        if (minutesMatch) waitSeconds = parseInt(minutesMatch[1]) * 60;
        else if (secondsMatch) waitSeconds = parseInt(secondsMatch[1]);

        await sendWebhook(check.event, { wait_seconds: waitSeconds, reason: check.reason });
      } else {
        await sendWebhook(check.event, { reason: check.reason });
      }
      return { status: 'failed', reason: check.reason };
    }
  }

  log('STEP', '4: No immediate errors detected');

  // Step 5: Wait for OTP Verification Screen
  log('STEP', '5: Waiting for OTP verification screen...');
  const verifyScreen = await waitForText('Verify', 30000) || 
                       await waitForText('verification', 10000) ||
                       await waitForText('6-digit', 10000);

  if (!verifyScreen) {
    const chatScreen = await waitForText('Chats', 5000, true) || 
                       await waitForText('calls', 5000, true);
    if (chatScreen) {
      log('STEP', '5: Already registered (chat screen visible)');
      await sendWebhook('already_registered', { reason: 'Number already registered, chat screen visible' });
      return { status: 'already_registered' };
    }
    throw new Error('Could not determine verification screen state');
  }

  log('STEP', '5: OTP verification screen detected');
  await sendWebhook('otp_requested', { run_id: CONFIG.runId });
  log('STEP', '5: Sent otp_requested webhook');

  // Step 6: Poll for OTP
  log('STEP', '6: Waiting for user to provide OTP via Telegram...');
  let otp;
  try {
    otp = await pollForOtp();
  } catch (error) {
    log('ERROR', `Failed to get OTP: ${error.message}`);
    await sendWebhook('bad_number', { reason: 'OTP timeout - user did not provide code within 15 minutes' });
    return { status: 'timeout', reason: 'OTP not received' };
  }

  // Step 7: Enter OTP
  log('STEP', '7: Entering OTP...');
  await enterOtp(otp);
  await sleep(3000);

  // Step 8: Check OTP result
  log('STEP', '8: Checking OTP result...');
  const otpResult = await checkOtpResult();

  if (otpResult === 'success') {
    log('STEP', '8: OTP accepted!');
    await sendWebhook('registered');
    await completeProfileSetup();
    return { status: 'registered' };
  } else if (otpResult === 'error') {
    log('ERROR', 'OTP rejected');
    await sendWebhook('otp_error', { reason: 'Invalid OTP entered' });
    return { status: 'otp_error' };
  } else if (otpResult === 'rate_limited') {
    return { status: 'rate_limited' };
  }

  return { status: 'unknown' };
}

async function enterOtp(otp) {
  log('OTP', `Entering OTP digits: ${otp}`);

  const otpField = await findResourceId('com.whatsapp:id/verify_sms_code_input', 5000);

  if (otpField) {
    const center = getBoundsCenter(otpField.$.bounds);
    await adb(`shell input tap ${center.x} ${center.y}`);
    await sleep(200);
    await inputText(otp);
  } else {
    for (let i = 0; i < otp.length; i++) {
      await adb(`shell input text "${otp[i]}"`);
      await sleep(300);
    }
  }

  log('OTP', 'OTP entry complete');
}

async function checkOtpResult() {
  await sleep(5000);

  const checks = [
    { pattern: 'incorrect', result: 'error' },
    { pattern: 'Wrong', result: 'error' },
    { pattern: 'Invalid', result: 'error' },
    { pattern: 'try again', result: 'error' },
    { pattern: 'Profile', result: 'success' },
    { pattern: 'Display name', result: 'success' },
    { pattern: 'Your name', result: 'success' },
    { pattern: 'Chats', result: 'success' },
    { pattern: 'Too many', result: 'rate_limited' },
    { pattern: 'wait', result: 'rate_limited' }
  ];

  for (let i = 0; i < 10; i++) {
    const hierarchy = await getUiHierarchy();

    for (const check of checks) {
      const node = findNodeByAttr(hierarchy.hierarchy, 'text', check.pattern, true);
      if (node) {
        log('CHECK', `Found text "${check.pattern}" -> ${check.result}`);
        return check.result;
      }
    }

    await sleep(2000);
  }

  return 'unknown';
}

async function completeProfileSetup() {
  log('PROFILE', 'Completing profile setup...');

  try {
    const nameField = await waitForText('Your name', 10000) || 
                      await waitForText('Display name', 10000);

    if (nameField) {
      await tapText('Next', true, 5000);
      log('PROFILE', 'Skipped name entry');
    }

    try {
      await tapText('Not now', true, 3000);
    } catch (e) {}

    try {
      await tapText('Skip', true, 3000);
    } catch (e) {}

    for (let i = 0; i < 3; i++) {
      try {
        await tapText('Allow', true, 2000);
      } catch (e) {
        break;
      }
    }

    log('PROFILE', 'Profile setup complete');
  } catch (error) {
    log('PROFILE', `Setup handling error (non-fatal): ${error.message}`);
  }
}

// Main Execution
async function main() {
  log('MAIN', '=== WhatsApp Registration Script Started ===');
  log('MAIN', 'Configuration:', {
    phone: CONFIG.phoneNumber,
    userId: CONFIG.userId,
    webhookUrl: CONFIG.webhookUrl,
    runId: CONFIG.runId
  });

  try {
    await installWhatsApp();
    const result = await handleRegistrationFlow();

    log('MAIN', `Registration completed: ${result.status}`);

    if (result.status === 'registered') {
      log('MAIN', 'SUCCESS: Registration complete');
      process.exit(0);
    } else {
      log('MAIN', `FAILED: ${result.reason || result.status}`);
      process.exit(1);
    }

  } catch (error) {
    log('FATAL', `Unhandled error: ${error.message}`);
    console.error(error.stack);

    try {
      await sendWebhook('bad_number', { 
        reason: `Script error: ${error.message}` 
      });
    } catch (e) {}

    process.exit(1);
  }
}

process.on('SIGINT', () => {
  log('SIGNAL', 'Received SIGINT, exiting...');
  process.exit(130);
});

process.on('SIGTERM', () => {
  log('SIGNAL', 'Received SIGTERM, exiting...');
  process.exit(143);
});

main();
