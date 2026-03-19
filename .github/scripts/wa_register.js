#!/usr/bin/env node
/**
 * wa_register.js
 * WhatsApp registration automation for GitHub Actions Android Emulator
 * Uses ADB + UIAutomator XML parsing to drive the WhatsApp UI
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { parseStringPromise } = require('xml2js');

// ── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  phoneNumber: process.env.PHONE_NUMBER || '',
  telegramUserId: process.env.TELEGRAM_USER_ID || '',
  webhookUrl: process.env.WEBHOOK_URL || '',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  githubRunId: process.env.GITHUB_RUN_ID || '',
  apkPath: '/tmp/whatsapp.apk',
  packageName: 'com.whatsapp',
  activityName: 'com.whatsapp/.Main',
  otpPollInterval: 5000,      // 5 seconds
  otpTimeout: 15 * 60 * 1000, // 15 minutes (matches bot.py timeout)
  uiPollInterval: 2000,       // 2 seconds
  maxRetries: 3,
};

// ── Logger ───────────────────────────────────────────────────────────────────
function log(level, ...args) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}]`, ...args);
}

// ── ADB Helpers ──────────────────────────────────────────────────────────────
class ADBHelper {
  constructor() {
    this.deviceId = null;
  }

  async waitForDevice(timeout = 120000) {
    const start = Date.now();
    log('INFO', 'Waiting for Android device...');

    while (Date.now() - start < timeout) {
      try {
        const result = execSync('adb devices', { encoding: 'utf8' });
        const lines = result.trim().split('\n').slice(1);
        const device = lines.find(line => line.includes('device') && !line.includes('List'));

        if (device) {
          this.deviceId = device.split('\t')[0];
          log('INFO', `Device found: ${this.deviceId}`);

          // Wait for boot completion
          execSync('adb wait-for-device');
          let bootCompleted = false;
          while (!bootCompleted) {
            try {
              const boot = execSync('adb shell getprop sys.boot_completed', { encoding: 'utf8' }).trim();
              if (boot === '1') {
                bootCompleted = true;
                log('INFO', 'Device boot completed');
              }
            } catch (e) {
              // ignore
            }
            if (!bootCompleted) await this.sleep(1000);
          }
          return;
        }
      } catch (e) {
        // ignore
      }
      await this.sleep(1000);
    }
    throw new Error('Device not found within timeout');
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  exec(cmd, timeout = 30000) {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      throw new Error(`ADB command failed: ${cmd} - ${e.message}`);
    }
  }

  async shell(cmd, timeout = 30000) {
    return this.exec(`adb shell "${cmd}"`, timeout);
  }

  async dumpUI() {
    const dumpPath = '/sdcard/ui_dump.xml';
    const localPath = '/tmp/ui_dump.xml';

    try {
      // Dump UI hierarchy
      await this.shell(`uiautomator dump ${dumpPath}`, 10000);
      await this.sleep(500);

      // Pull to local
      this.exec(`adb pull ${dumpPath} ${localPath}`, 10000);

      // Read and parse XML
      const xmlContent = fs.readFileSync(localPath, 'utf8');
      const parsed = await parseStringPromise(xmlContent);
      return parsed;
    } catch (e) {
      log('WARN', `UI dump failed: ${e.message}`);
      return null;
    }
  }

  async findElement(parsedXml, options) {
    if (!parsedXml || !parsedXml.hierarchy || !parsedXml.hierarchy.node) {
      return null;
    }

    const nodes = this.flattenNodes(parsedXml.hierarchy.node);

    for (const node of nodes) {
      let match = true;

      if (options.text && node.text && node.text[0].includes(options.text)) {
        // text match
      } else if (options.text) {
        match = false;
      }

      if (options.resourceId && node.resource_id && node.resource_id[0] === options.resourceId) {
        // resource-id match
      } else if (options.resourceId) {
        match = false;
      }

      if (options.contentDesc && node.content_desc && node.content_desc[0].includes(options.contentDesc)) {
        // content-desc match
      } else if (options.contentDesc) {
        match = false;
      }

      if (options.className && node.class && node.class[0].includes(options.className)) {
        // class match
      } else if (options.className) {
        match = false;
      }

      if (match) return node;
    }
    return null;
  }

  flattenNodes(node, result = []) {
    if (Array.isArray(node)) {
      for (const n of node) this.flattenNodes(n, result);
    } else if (node && typeof node === 'object') {
      result.push(node);
      if (node.node) {
        this.flattenNodes(node.node, result);
      }
    }
    return result;
  }

  async getBounds(node) {
    const bounds = node.bounds ? node.bounds[0] : '[0,0][0,0]';
    const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) return { x: 0, y: 0 };
    const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
    const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
    return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
  }

  async clickElement(node) {
    const { x, y } = await this.getBounds(node);
    await this.shell(`input tap ${x} ${y}`);
    log('DEBUG', `Clicked at (${x}, ${y})`);
  }

  async inputText(text) {
    // Escape special characters for adb shell
    const escaped = text.replace(/"/g, '\"');
    await this.shell(`input text "${escaped}"`);
  }

  async clearText() {
    // Select all and delete
    await this.shell('input keyevent 29'); // KEYCODE_A (select all in some contexts)
    await this.shell('input keyevent 123'); // Move to end
    for (let i = 0; i < 20; i++) {
      await this.shell('input keyevent 67'); // KEYCODE_DEL
    }
  }

  async pressBack() {
    await this.shell('input keyevent 4'); // KEYCODE_BACK
  }

  async pressEnter() {
    await this.shell('input keyevent 66'); // KEYCODE_ENTER
  }

  async installApk(apkPath) {
    log('INFO', `Installing APK: ${apkPath}`);
    if (!fs.existsSync(apkPath)) {
      throw new Error(`APK not found: ${apkPath}`);
    }
    this.exec(`adb install -r -d ${apkPath}`, 120000);
    log('INFO', 'APK installed successfully');
  }

  async launchApp(packageName, activityName) {
    log('INFO', `Launching ${packageName}`);
    await this.shell(`am start -n ${activityName}`);
    await this.sleep(3000);
  }

  async forceStop(packageName) {
    log('INFO', `Force stopping ${packageName}`);
    await this.shell(`am force-stop ${packageName}`);
  }

  async grantPermissions(packageName) {
    log('INFO', 'Granting permissions');
    const perms = [
      'android.permission.READ_CONTACTS',
      'android.permission.WRITE_CONTACTS',
      'android.permission.READ_PHONE_STATE',
      'android.permission.READ_SMS',
      'android.permission.RECEIVE_SMS',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ];
    for (const perm of perms) {
      try {
        await this.shell(`pm grant ${packageName} ${perm}`);
      } catch (e) {
        // ignore permission grant failures
      }
    }
  }
}

// ── Webhook Client ───────────────────────────────────────────────────────────
class WebhookClient {
  async send(event, extra = {}) {
    const payload = {
      event,
      phone_number: CONFIG.phoneNumber,
      telegram_user_id: parseInt(CONFIG.telegramUserId),
      run_id: CONFIG.githubRunId,
      ...extra,
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': CONFIG.webhookSecret,
    };

    try {
      log('INFO', `Sending webhook: ${event}`);
      const response = await axios.post(CONFIG.webhookUrl, payload, {
        headers,
        timeout: 10000,
      });
      log('INFO', `Webhook sent: ${response.status}`);
      return true;
    } catch (e) {
      log('ERROR', `Webhook failed: ${e.message}`);
      return false;
    }
  }

  async pollForOtp() {
    const otpUrl = CONFIG.webhookUrl.replace('/webhook/event', `/otp/${CONFIG.phoneNumber}`);
    const headers = { 'X-Webhook-Secret': CONFIG.webhookSecret };
    const startTime = Date.now();

    log('INFO', 'Starting OTP poll...');

    while (Date.now() - startTime < CONFIG.otpTimeout) {
      try {
        const response = await axios.get(otpUrl, { headers, timeout: 5000 });
        if (response.status === 200 && response.data) {
          const otp = response.data.trim();
          if (/^\d{6}$/.test(otp)) {
            log('INFO', `OTP received: ${otp}`);
            return otp;
          }
        }
      } catch (e) {
        if (e.response && e.response.status === 204) {
          // OTP not ready yet, continue polling
        } else {
          log('WARN', `OTP poll error: ${e.message}`);
        }
      }
      await new Promise(r => setTimeout(r, CONFIG.otpPollInterval));
    }

    throw new Error('OTP polling timeout');
  }
}

// ── Registration Flow ────────────────────────────────────────────────────────
class RegistrationFlow {
  constructor(adb, webhook) {
    this.adb = adb;
    this.webhook = webhook;
    this.attempts = 0;
  }

  async run() {
    try {
      // Parse phone number
      const { countryCode, nationalNumber } = this.parsePhoneNumber(CONFIG.phoneNumber);
      log('INFO', `Parsed phone: +${countryCode} ${nationalNumber}`);

      // Install and launch
      await this.adb.installApk(CONFIG.apkPath);
      await this.adb.grantPermissions(CONFIG.packageName);
      await this.adb.launchApp(CONFIG.packageName, CONFIG.activityName);

      // Wait for initial load
      await this.adb.sleep(5000);

      // Registration state machine
      let state = 'START';
      let otp = null;
      let attempts = 0;

      while (attempts < 100) { // Max 100 UI checks (~3-4 minutes)
        attempts++;
        log('INFO', `State: ${state}, Attempt: ${attempts}`);

        const ui = await this.adb.dumpUI();

        if (!ui) {
          await this.adb.sleep(CONFIG.uiPollInterval);
          continue;
        }

        // Detect current screen and act
        const detectedState = await this.detectState(ui);

        if (detectedState) {
          log('INFO', `Detected screen: ${detectedState}`);

          switch (detectedState) {
            case 'WELCOME':
              await this.handleWelcome(ui);
              state = 'PHONE_INPUT';
              break;

            case 'PHONE_INPUT':
              await this.handlePhoneInput(ui, countryCode, nationalNumber);
              state = 'PHONE_CONFIRM';
              break;

            case 'PHONE_CONFIRM':
              await this.handlePhoneConfirm(ui);
              state = 'OTP_WAIT';
              break;

            case 'OTP_INPUT':
              if (state !== 'OTP_WAIT' && state !== 'OTP_INPUT') {
                // First time seeing OTP screen, notify bot
                await this.webhook.send('otp_requested', { run_id: CONFIG.githubRunId });
                state = 'OTP_WAIT';
              }

              if (!otp) {
                try {
                  otp = await this.webhook.pollForOtp();
                } catch (e) {
                  log('ERROR', `OTP wait failed: ${e.message}`);
                  throw new Error('OTP_TIMEOUT');
                }
              }

              if (otp) {
                const success = await this.handleOtpInput(ui, otp);
                if (success) {
                  state = 'VERIFYING';
                  otp = null; // Clear to prevent re-entry
                }
              }
              break;

            case 'ALREADY_REGISTERED':
              await this.webhook.send('already_registered');
              return { success: true, status: 'ALREADY_REGISTERED' };

            case 'RATE_LIMITED':
              const waitSeconds = await this.extractRateLimitTime(ui);
              await this.webhook.send('rate_limited', { wait_seconds: waitSeconds });
              return { success: false, status: 'RATE_LIMITED', waitSeconds };

            case 'BANNED':
              await this.webhook.send('banned');
              return { success: false, status: 'BANNED' };

            case 'INVALID_NUMBER':
              await this.webhook.send('bad_number', { reason: 'Invalid phone number format' });
              return { success: false, status: 'BAD_NUMBER' };

            case 'OTP_ERROR':
              await this.webhook.send('otp_error');
              // Clear OTP and wait for retry
              otp = null;
              state = 'OTP_WAIT';
              await this.adb.sleep(3000);
              break;

            case 'PROFILE_SETUP':
              await this.handleProfileSetup(ui);
              state = 'COMPLETING';
              break;

            case 'MAIN_SCREEN':
            case 'CHATS_LIST':
              await this.webhook.send('registered');
              return { success: true, status: 'REGISTERED' };

            case 'RESTORING':
              log('INFO', 'Restoring chat history...');
              await this.adb.sleep(5000);
              break;

            case 'PERMISSION_REQUEST':
              await this.handlePermissionRequest(ui);
              break;

            default:
              log('WARN', `Unknown state: ${detectedState}`);
          }
        }

        await this.adb.sleep(CONFIG.uiPollInterval);
      }

      throw new Error('Max attempts reached without completion');

    } catch (error) {
      log('ERROR', `Registration failed: ${error.message}`);

      if (error.message === 'OTP_TIMEOUT') {
        await this.webhook.send('bad_number', { reason: 'OTP timeout - user did not respond in 15 minutes' });
      } else {
        await this.webhook.send('bad_number', { reason: error.message });
      }

      return { success: false, status: 'FAILED', error: error.message };
    }
  }

  parsePhoneNumber(fullNumber) {
    // Assume number starts with country code (e.g., 2348012345678)
    // WhatsApp expects country code and national number separately
    const cleaned = fullNumber.replace(/\D/g, '');

    // Common country code lengths
    const countryCodes = ['1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98', '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '379', '380', '381', '382', '383', '385', '386', '387', '389', '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850', '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998'];

    for (const cc of countryCodes) {
      if (cleaned.startsWith(cc)) {
        return {
          countryCode: cc,
          nationalNumber: cleaned.substring(cc.length)
        };
      }
    }

    // Default: assume first 1-3 digits are country code (fallback)
    return {
      countryCode: cleaned.substring(0, 3),
      nationalNumber: cleaned.substring(3)
    };
  }

  async detectState(ui) {
    const xml = JSON.stringify(ui).toLowerCase();
    const textNodes = this.extractAllTexts(ui);
    const allText = textNodes.join(' ').toLowerCase();

    // Check for specific indicators
    if (allText.includes('agree and continue') || allText.includes('welcome to whatsapp')) {
      return 'WELCOME';
    }

    if (allText.includes('verify your phone number') || 
        (allText.includes('phone number') && allText.includes('country'))) {
      if (allText.includes('verify') || allText.includes('next') || allText.includes('ok')) {
        // Check if we're on the first screen or confirmation screen
        if (allText.includes('edit') || allText.includes('number is') || allText.includes('confirm')) {
          return 'PHONE_CONFIRM';
        }
        return 'PHONE_INPUT';
      }
    }

    if (allText.includes('enter code') || allText.includes('verification code') || 
        allText.includes('sms') || allText.includes('6-digit')) {
      if (allText.includes('wrong') || allText.includes('invalid') || allText.includes('incorrect')) {
        return 'OTP_ERROR';
      }
      return 'OTP_INPUT';
    }

    if (allText.includes('already registered') || allText.includes('already verified')) {
      return 'ALREADY_REGISTERED';
    }

    if (allText.includes('banned') || allText.includes('temporarily banned') || 
        allText.includes('suspended') || allText.includes('blocked')) {
      return 'BANNED';
    }

    if (allText.includes('too many') || allText.includes('try again') || 
        allText.includes('rate limit') || allText.includes('wait')) {
      if (allText.includes('minutes') || allText.includes('hours')) {
        return 'RATE_LIMITED';
      }
    }

    if (allText.includes('invalid number') || allText.includes('not valid') ||
        allText.includes('incorrect format')) {
      return 'INVALID_NUMBER';
    }

    if (allText.includes('profile info') || allText.includes('your name') ||
        allText.includes('display name')) {
      return 'PROFILE_SETUP';
    }

    if (allText.includes('chats') && (allText.includes('calls') || allText.includes('status') || allText.includes('camera'))) {
      return 'MAIN_SCREEN';
    }

    if (allText.includes('restoring') || allText.includes('backup')) {
      return 'RESTORING';
    }

    if (allText.includes('allow') && allText.includes('permission')) {
      return 'PERMISSION_REQUEST';
    }

    return null;
  }

  extractAllTexts(node, result = []) {
    if (!node) return result;

    if (typeof node === 'object') {
      if (node.text && node.text[0]) {
        result.push(node.text[0]);
      }
      if (node.node) {
        for (const child of (Array.isArray(node.node) ? node.node : [node.node])) {
          this.extractAllTexts(child, result);
        }
      }
    }
    return result;
  }

  async handleWelcome(ui) {
    log('INFO', 'Handling Welcome screen');
    const agreeBtn = await this.adb.findElement(ui, { text: 'Agree and continue' }) ||
                     await this.adb.findElement(ui, { text: 'AGREE AND CONTINUE' });

    if (agreeBtn) {
      await this.adb.clickElement(agreeBtn);
      await this.adb.sleep(2000);
    } else {
      // Fallback: click bottom center of screen where button usually is
      await this.adb.shell('input tap 540 1800');
    }
  }

  async handlePhoneInput(ui, countryCode, nationalNumber) {
    log('INFO', `Entering phone number: +${countryCode} ${nationalNumber}`);

    // Find country code field
    const ccField = await this.adb.findElement(ui, { text: '+' }) ||
                    await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_cc' });

    if (ccField) {
      await this.adb.clickElement(ccField);
      await this.adb.sleep(500);
      await this.adb.clearText();
      await this.adb.inputText(countryCode);
      await this.adb.sleep(500);
    }

    // Find phone number field
    const phoneField = await this.adb.findElement(ui, { text: 'phone number' }) ||
                       await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_phone' });

    if (phoneField) {
      await this.adb.clickElement(phoneField);
      await this.adb.sleep(500);
      await this.adb.clearText();
      await this.adb.inputText(nationalNumber);
      await this.adb.sleep(500);
    }

    // Click Next
    const nextBtn = await this.adb.findElement(ui, { text: 'Next' }) ||
                    await this.adb.findElement(ui, { text: 'NEXT' }) ||
                    await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_submit' });

    if (nextBtn) {
      await this.adb.clickElement(nextBtn);
    } else {
      // Fallback: press enter
      await this.adb.pressEnter();
    }

    await this.adb.sleep(3000);
  }

  async handlePhoneConfirm(ui) {
    log('INFO', 'Confirming phone number');
    const okBtn = await this.adb.findElement(ui, { text: 'OK' }) ||
                  await this.adb.findElement(ui, { text: 'Ok' }) ||
                  await this.adb.findElement(ui, { text: 'YES' }) ||
                  await this.adb.findElement(ui, { text: 'Yes' });

    if (okBtn) {
      await this.adb.clickElement(okBtn);
      await this.adb.sleep(2000);
    }
  }

  async handleOtpInput(ui, otp) {
    log('INFO', `Entering OTP: ${otp}`);

    // Find OTP input field
    const otpField = await this.adb.findElement(ui, { text: 'code' }) ||
                     await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/verify_sms_code_input' }) ||
                     await this.adb.findElement(ui, { className: 'EditText' });

    if (otpField) {
      await this.adb.clickElement(otpField);
      await this.adb.sleep(500);
      await this.adb.clearText();
      await this.adb.inputText(otp);
      await this.adb.sleep(1000);

      // Check if there's a submit button or if auto-submit happens
      const nextBtn = await this.adb.findElement(ui, { text: 'Next' }) ||
                      await this.adb.findElement(ui, { text: 'Verify' });
      if (nextBtn) {
        await this.adb.clickElement(nextBtn);
      }

      return true;
    }

    return false;
  }

  async extractRateLimitTime(ui) {
    const texts = this.extractAllTexts(ui).join(' ');
    const match = texts.match(/(\d+)\s*(minute|hour|min|hr)s?/i);
    if (match) {
      const num = parseInt(match[1]);
      const unit = match[2].toLowerCase();
      if (unit.includes('hour') || unit.includes('hr')) {
        return num * 3600;
      }
      return num * 60;
    }
    return 600; // default 10 minutes
  }

  async handleProfileSetup(ui) {
    log('INFO', 'Setting up profile');

    // Enter a default name or skip if possible
    const nameField = await this.adb.findElement(ui, { text: 'name' }) ||
                      await this.adb.findElement(ui, { className: 'EditText' });

    if (nameField) {
      await this.adb.clickElement(nameField);
      await this.adb.sleep(500);
      await this.adb.inputText('User');
      await this.adb.sleep(500);
    }

    const nextBtn = await this.adb.findElement(ui, { text: 'Next' }) ||
                    await this.adb.findElement(ui, { text: 'Done' });
    if (nextBtn) {
      await this.adb.clickElement(nextBtn);
    }

    await this.adb.sleep(3000);
  }

  async handlePermissionRequest(ui) {
    log('INFO', 'Handling permission request');
    const allowBtn = await this.adb.findElement(ui, { text: 'Allow' }) ||
                     await this.adb.findElement(ui, { text: 'ALLOW' }) ||
                     await this.adb.findElement(ui, { text: 'While using the app' });

    if (allowBtn) {
      await this.adb.clickElement(allowBtn);
      await this.adb.sleep(1000);
    } else {
      await this.adb.pressBack();
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('INFO', '=== WhatsApp Registration Script Starting ===');
  log('INFO', `Phone: ${CONFIG.phoneNumber}`);
  log('INFO', `User: ${CONFIG.telegramUserId}`);

  const adb = new ADBHelper();
  const webhook = new WebhookClient();

  try {
    await adb.waitForDevice();
    const flow = new RegistrationFlow(adb, webhook);
    const result = await flow.run();

    log('INFO', `Registration completed: ${JSON.stringify(result)}`);
    process.exit(result.success ? 0 : 1);

  } catch (error) {
    log('FATAL', `Unhandled error: ${error.message}`);
    await webhook.send('bad_number', { reason: `Fatal error: ${error.message}` });
    process.exit(1);
  }
}

main();
