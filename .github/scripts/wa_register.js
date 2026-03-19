#!/usr/bin/env node
/**
 * wa_register.js (FIXED VERSION)
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
  otpTimeout: 15 * 60 * 1000, // 15 minutes
  uiPollInterval: 2000,       // 2 seconds
  maxRetries: 3,
  debug: true,                // Enable debug logging
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
      // Remove old dump if exists
      await this.shell(`rm -f ${dumpPath}`, 5000).catch(() => {});

      // Dump UI hierarchy
      await this.shell(`uiautomator dump ${dumpPath}`, 10000);
      await this.sleep(500);

      // Check if file was created
      const checkFile = await this.shell(`ls -la ${dumpPath}`, 5000).catch(() => '');
      if (!checkFile.includes('ui_dump.xml')) {
        log('WARN', 'UI dump file not created');
        return null;
      }

      // Pull to local
      this.exec(`adb pull ${dumpPath} ${localPath}`, 10000);

      // Check local file
      if (!fs.existsSync(localPath)) {
        log('WARN', 'Pulled UI dump file not found locally');
        return null;
      }

      // Read and parse XML
      const xmlContent = fs.readFileSync(localPath, 'utf8');
      if (xmlContent.length < 100) {
        log('WARN', 'UI dump content too short, might be empty');
        return null;
      }

      const parsed = await parseStringPromise(xmlContent);
      return parsed;
    } catch (e) {
      log('WARN', `UI dump failed: ${e.message}`);
      return null;
    }
  }

  async findElement(parsedXml, options) {
    if (!parsedXml || !parsedXml.hierarchy) {
      return null;
    }

    const nodes = this.flattenNodes(parsedXml.hierarchy.node);

    for (const node of nodes) {
      let match = true;

      // Check text (case insensitive partial match)
      if (options.text) {
        const nodeText = (node.text && node.text[0]) ? node.text[0].toLowerCase() : '';
        if (!nodeText.includes(options.text.toLowerCase())) {
          match = false;
        }
      }

      // Check resource-id
      if (options.resourceId && match) {
        const resId = (node.resource_id && node.resource_id[0]) || '';
        if (!resId.includes(options.resourceId)) {
          match = false;
        }
      }

      // Check content-desc
      if (options.contentDesc && match) {
        const contentDesc = (node.content_desc && node.content_desc[0]) || '';
        if (!contentDesc.toLowerCase().includes(options.contentDesc.toLowerCase())) {
          match = false;
        }
      }

      // Check class
      if (options.className && match) {
        const className = (node.class && node.class[0]) || '';
        if (!className.includes(options.className)) {
          match = false;
        }
      }

      if (match) return node;
    }
    return null;
  }

  flattenNodes(node, result = []) {
    if (!node) return result;

    if (Array.isArray(node)) {
      for (const n of node) this.flattenNodes(n, result);
    } else if (typeof node === 'object') {
      result.push(node);
      // Handle both 'node' and 'children' type structures
      const children = node.node || node.children;
      if (children) {
        this.flattenNodes(children, result);
      }
    }
    return result;
  }

  async getBounds(node) {
    const bounds = node.bounds ? node.bounds[0] : '[0,0][0,0]';
    const match = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) return { x: 540, y: 960 }; // Center of screen fallback
    const x1 = parseInt(match[1]), y1 = parseInt(match[2]);
    const x2 = parseInt(match[3]), y2 = parseInt(match[4]);
    return { x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2) };
  }

  async clickElement(node) {
    const { x, y } = await this.getBounds(node);
    await this.shell(`input tap ${x} ${y}`);
    log('DEBUG', `Clicked at (${x}, ${y})`);
  }

  async clickXY(x, y) {
    await this.shell(`input tap ${x} ${y}`);
    log('DEBUG', `Clicked coordinates (${x}, ${y})`);
  }

  async inputText(text) {
    // Use base64 encoding to avoid shell escaping issues
    const base64Text = Buffer.from(text).toString('base64');
    await this.shell(`echo ${base64Text} | base64 -d | xargs input text`, 10000);
  }

  async clearTextField() {
    // Triple click to select all, then type to replace
    await this.shell('input keyevent 123'); // MOVE_END
    await this.sleep(200);
    await this.shell('input keyevent 29'); // Ctrl+A (select all on some keyboards)
    await this.sleep(200);
    // Delete selected text
    for (let i = 0; i < 15; i++) {
      await this.shell('input keyevent 67'); // DEL
      await this.sleep(50);
    }
  }

  async pressBack() {
    await this.shell('input keyevent 4');
  }

  async pressEnter() {
    await this.shell('input keyevent 66');
  }

  async pressHome() {
    await this.shell('input keyevent 3');
  }

  async isAppRunning(packageName) {
    try {
      const result = await this.shell(`ps | grep ${packageName}`);
      return result.includes(packageName);
    } catch (e) {
      return false;
    }
  }

  async getForegroundActivity() {
    try {
      const result = await this.shell('dumpsys window windows | grep -E "mCurrentFocus|mFocusedApp"');
      return result;
    } catch (e) {
      return '';
    }
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
    this.stuckCounter = 0;
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

      // LONGER initial wait for first launch (WhatsApp initialization can take 10-15 seconds)
      log('INFO', 'Waiting 15 seconds for WhatsApp initial load...');
      await this.adb.sleep(15000);

      // Check if app is actually running
      const isRunning = await this.adb.isAppRunning(CONFIG.packageName);
      log('INFO', `WhatsApp running: ${isRunning}`);

      if (!isRunning) {
        log('WARN', 'WhatsApp not running, attempting to launch again...');
        await this.adb.launchApp(CONFIG.packageName, CONFIG.activityName);
        await this.adb.sleep(5000);
      }

      // Registration state machine
      let state = 'START';
      let otp = null;
      let lastDetectedState = null;
      let stateRepeatCount = 0;

      while (this.attempts < 150) { // Increased max attempts
        this.attempts++;

        if (CONFIG.debug && this.attempts % 5 === 0) {
          const activity = await this.adb.getForegroundActivity();
          log('DEBUG', `Foreground activity: ${activity.trim()}`);
        }

        const ui = await this.adb.dumpUI();

        if (!ui) {
          log('WARN', `Attempt ${this.attempts}: UI dump returned null`);
          this.stuckCounter++;
          if (this.stuckCounter > 5) {
            log('WARN', 'Stuck with null UI dumps, pressing back to recover...');
            await this.adb.pressBack();
            this.stuckCounter = 0;
          }
          await this.adb.sleep(CONFIG.uiPollInterval);
          continue;
        }

        this.stuckCounter = 0;

        // Debug: Log all text on screen periodically
        if (CONFIG.debug && this.attempts % 3 === 0) {
          const allTexts = this.extractAllTexts(ui);
          const summary = allTexts.slice(0, 10).join(' | ');
          log('DEBUG', `UI Text [${allTexts.length} items]: ${summary}...`);
        }

        // Detect current screen and act
        const detectedState = await this.detectState(ui);

        if (detectedState) {
          if (detectedState === lastDetectedState) {
            stateRepeatCount++;
            if (stateRepeatCount > 10) {
              log('WARN', `Stuck on ${detectedState} for too long, trying to recover...`);
              await this.adb.pressBack();
              stateRepeatCount = 0;
            }
          } else {
            stateRepeatCount = 0;
            lastDetectedState = detectedState;
            log('INFO', `Detected screen: ${detectedState} (attempt ${this.attempts})`);
          }

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
                  otp = null;
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

            case 'LOADING':
            case 'RESTORING':
              log('INFO', 'Waiting for loading/restoring to complete...');
              await this.adb.sleep(3000);
              break;

            case 'PERMISSION_REQUEST':
              await this.handlePermissionRequest(ui);
              break;

            case 'UNKNOWN':
              // Try to click away any dialog
              if (this.attempts % 5 === 0) {
                await this.adb.pressBack();
              }
              break;
          }
        } else {
          log('DEBUG', `Attempt ${this.attempts}: No state detected`);
          // Try to dismiss any blocking UI
          if (this.attempts % 10 === 0) {
            log('WARN', 'No state detected for a while, pressing back...');
            await this.adb.pressBack();
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
    const cleaned = fullNumber.replace(/\D/g, '');

    // Try common country codes (1-4 digits)
    const countryCodes = ['1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98', '211', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '247', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299', '350', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '379', '380', '381', '382', '383', '385', '386', '387', '389', '420', '421', '423', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850', '852', '853', '855', '856', '880', '886', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998'];

    for (const cc of countryCodes) {
      if (cleaned.startsWith(cc)) {
        return {
          countryCode: cc,
          nationalNumber: cleaned.substring(cc.length)
        };
      }
    }

    // Fallback: assume first 3 digits are country code
    return {
      countryCode: cleaned.substring(0, 3),
      nationalNumber: cleaned.substring(3)
    };
  }

  async detectState(ui) {
    const textNodes = this.extractAllTexts(ui);
    const allText = textNodes.join(' ').toLowerCase();

    if (CONFIG.debug) {
      log('DEBUG', `Detecting state from text: "${allText.substring(0, 100)}..."`);
    }

    // Priority order matters - check most specific first

    // Loading states (check first as they appear during transitions)
    if (allText.includes('loading') || allText.includes('please wait') || 
        allText.includes('connecting') || allText.includes('initializing')) {
      return 'LOADING';
    }

    if (allText.includes('restoring') || allText.includes('backup') || 
        allText.includes('restoring chat')) {
      return 'RESTORING';
    }

    // Welcome
    if (allText.includes('agree') && allText.includes('continue')) {
      return 'WELCOME';
    }

    // Already registered
    if (allText.includes('already registered') || 
        (allText.includes('already') && allText.includes('verified'))) {
      return 'ALREADY_REGISTERED';
    }

    // Banned
    if (allText.includes('banned') || allText.includes('suspended') || 
        allText.includes('blocked') || allText.includes('temporarily banned')) {
      return 'BANNED';
    }

    // Rate limited
    if ((allText.includes('too many') || allText.includes('try again')) && 
        (allText.includes('minute') || allText.includes('hour') || allText.includes('wait'))) {
      return 'RATE_LIMITED';
    }

    // Invalid number
    if (allText.includes('invalid number') || allText.includes('not valid') ||
        allText.includes('incorrect format') || allText.includes('invalid phone')) {
      return 'INVALID_NUMBER';
    }

    // OTP Error
    if ((allText.includes('wrong') || allText.includes('invalid') || 
         allText.includes('incorrect')) && 
        (allText.includes('code') || allText.includes('otp'))) {
      return 'OTP_ERROR';
    }

    // OTP Input
    if ((allText.includes('enter code') || allText.includes('verification code') || 
         allText.includes('6-digit') || allText.includes('sms') || 
         allText.includes('verify') || allText.includes('otp')) &&
        (allText.includes('code') || allText.includes('digit'))) {
      return 'OTP_INPUT';
    }

    // Phone Confirmation
    if ((allText.includes('confirm') || allText.includes('edit') || 
         allText.includes('is this correct') || allText.includes('number is')) &&
        allText.includes('phone')) {
      return 'PHONE_CONFIRM';
    }

    // Phone Input
    if ((allText.includes('phone number') || allText.includes('verify your phone')) &&
        (allText.includes('country') || allText.includes('+'))) {
      return 'PHONE_INPUT';
    }

    // Profile Setup
    if ((allText.includes('profile info') || allText.includes('your name') ||
         allText.includes('display name') || allText.includes('set up profile')) &&
        !allText.includes('privacy')) {
      return 'PROFILE_SETUP';
    }

    // Main Screen / Chats List
    if ((allText.includes('chats') || allText.includes('chat')) &&
        (allText.includes('calls') || allText.includes('status') || 
         allText.includes('camera') || allText.includes('communities'))) {
      return 'MAIN_SCREEN';
    }

    // Permission requests
    if (allText.includes('allow') && 
        (allText.includes('permission') || allText.includes('access') || 
         allText.includes('contacts') || allText.includes('photos'))) {
      return 'PERMISSION_REQUEST';
    }

    return null;
  }

  extractAllTexts(node, result = []) {
    if (!node) return result;

    if (Array.isArray(node)) {
      for (const n of node) this.extractAllTexts(n, result);
    } else if (typeof node === 'object') {
      // Try different property names that might contain text
      const text = node.text || node['@_text'] || node.value;
      if (text && typeof text === 'string' && text.trim()) {
        result.push(text.trim());
      }
      // Also check array form
      if (node.text && Array.isArray(node.text) && node.text[0]) {
        result.push(node.text[0].trim());
      }

      // Recurse into children
      const children = node.node || node.children || node['$'];
      if (children) {
        this.extractAllTexts(children, result);
      }
    }
    return result;
  }

  async handleWelcome(ui) {
    log('INFO', 'Handling Welcome screen');

    // Try to find agree button by various text patterns
    const patterns = [
      'agree and continue',
      'agree',
      'continue',
      'accept'
    ];

    for (const pattern of patterns) {
      const btn = await this.adb.findElement(ui, { text: pattern });
      if (btn) {
        log('INFO', `Found button with text: ${pattern}`);
        await this.adb.clickElement(btn);
        await this.adb.sleep(2000);
        return;
      }
    }

    // Fallback: click bottom center
    log('WARN', 'Welcome button not found, using fallback coordinates');
    await this.adb.clickXY(540, 1800);
    await this.adb.sleep(2000);
  }

  async handlePhoneInput(ui, countryCode, nationalNumber) {
    log('INFO', `Entering phone number: +${countryCode} ${nationalNumber}`);

    // Find and fill country code
    const ccField = await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_cc' }) ||
                    await this.adb.findElement(ui, { text: '+' });

    if (ccField) {
      log('INFO', 'Found country code field');
      await this.adb.clickElement(ccField);
      await this.adb.sleep(500);
      await this.adb.clearTextField();
      await this.adb.sleep(200);
      await this.adb.inputText(countryCode);
      await this.adb.sleep(500);
    } else {
      log('WARN', 'Country code field not found');
    }

    // Find and fill phone number
    const phoneField = await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_phone' }) ||
                       await this.adb.findElement(ui, { text: 'phone' });

    if (phoneField) {
      log('INFO', 'Found phone number field');
      await this.adb.clickElement(phoneField);
      await this.adb.sleep(500);
      await this.adb.clearTextField();
      await this.adb.sleep(200);
      await this.adb.inputText(nationalNumber);
      await this.adb.sleep(500);
    } else {
      log('WARN', 'Phone number field not found');
    }

    // Click Next/OK
    const nextBtn = await this.adb.findElement(ui, { text: 'next' }) ||
                    await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/registration_submit' }) ||
                    await this.adb.findElement(ui, { text: 'ok' });

    if (nextBtn) {
      log('INFO', 'Found next/submit button');
      await this.adb.clickElement(nextBtn);
    } else {
      log('WARN', 'Next button not found, pressing Enter');
      await this.adb.pressEnter();
    }

    await this.adb.sleep(3000);
  }

  async handlePhoneConfirm(ui) {
    log('INFO', 'Confirming phone number');

    const okBtn = await this.adb.findElement(ui, { text: 'ok' }) ||
                  await this.adb.findElement(ui, { text: 'yes' }) ||
                  await this.adb.findElement(ui, { text: 'confirm' });

    if (okBtn) {
      await this.adb.clickElement(okBtn);
    } else {
      // Fallback: click center-right where OK usually is
      await this.adb.clickXY(800, 1100);
    }

    await this.adb.sleep(3000);
  }

  async handleOtpInput(ui, otp) {
    log('INFO', `Entering OTP`);

    const otpField = await this.adb.findElement(ui, { resourceId: 'com.whatsapp:id/verify_sms_code_input' }) ||
                     await this.adb.findElement(ui, { className: 'EditText' }) ||
                     await this.adb.findElement(ui, { text: 'code' });

    if (otpField) {
      await this.adb.clickElement(otpField);
      await this.adb.sleep(500);
      await this.adb.clearTextField();
      await this.adb.sleep(200);
      await this.adb.inputText(otp);
      await this.adb.sleep(1000);

      // Try to find verify button
      const verifyBtn = await this.adb.findElement(ui, { text: 'verify' }) ||
                        await this.adb.findElement(ui, { text: 'next' });
      if (verifyBtn) {
        await this.adb.clickElement(verifyBtn);
      } else {
        await this.adb.pressEnter();
      }

      return true;
    }

    log('WARN', 'OTP field not found');
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

    const nameField = await this.adb.findElement(ui, { text: 'name' }) ||
                      await this.adb.findElement(ui, { className: 'EditText' });

    if (nameField) {
      await this.adb.clickElement(nameField);
      await this.adb.sleep(500);
      await this.adb.clearTextField();
      await this.adb.inputText('User');
      await this.adb.sleep(500);
    }

    const nextBtn = await this.adb.findElement(ui, { text: 'next' }) ||
                    await this.adb.findElement(ui, { text: 'done' });
    if (nextBtn) {
      await this.adb.clickElement(nextBtn);
    }

    await this.adb.sleep(3000);
  }

  async handlePermissionRequest(ui) {
    log('INFO', 'Handling permission request');

    const allowBtn = await this.adb.findElement(ui, { text: 'allow' }) ||
                     await this.adb.findElement(ui, { text: 'while using' });

    if (allowBtn) {
      await this.adb.clickElement(allowBtn);
    } else {
      // Try to click where Allow usually is
      await this.adb.clickXY(800, 1100);
    }

    await this.adb.sleep(1000);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log('INFO', '=== WhatsApp Registration Script Starting (FIXED) ===');
  log('INFO', `Phone: ${CONFIG.phoneNumber}`);
  log('INFO', `User: ${CONFIG.telegramUserId}`);
  log('INFO', `Debug mode: ${CONFIG.debug}`);

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
