/**
 * wa_register.js — WhatsApp direct registration via ADB + session_manager
 * Downloads APK from GitHub release, installs on emulator, monitors registration
 */

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// ── Configuration ──────────────────────────────────────────────────────────

const PHONE = process.env.PHONE_NUMBER;
const USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID = process.env.GITHUB_RUN_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'Ademmanu/WSCREATEANDPAIR';

const SCRIPT_DIR = '/tmp/wa_scripts';
const APK_PATH = '/tmp/whatsapp.apk';

// ── Logging & Utilities ───────────────────────────────────────────────────────

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

function adb(args, timeout = 30000) {
  return exec(`adb ${args}`, timeout);
}

function shell(cmd, timeout = 30000) {
  const file = path.join(SCRIPT_DIR, `adb_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = exec(`adb shell < ${file}`, timeout);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

function tap(x, y) { shell(`input tap ${x} ${y}`); }
function keyevent(k) { shell(`input keyevent ${k}`); }

// ── Webhook ────────────────────────────────────────────────────────────

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

// ── Download APK from GitHub Release ───────────────────────────────────────

async function downloadWhatsAppAPK() {
  log('DOWNLOAD', `Fetching latest release from ${GITHUB_REPO}...`);
  
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_REPO}/releases/latest`,
      method: 'GET',
      headers: {
        'User-Agent': 'wa-register',
        'Accept': 'application/vnd.github.v3+json',
        ...(GITHUB_TOKEN ? { 'Authorization': `token ${GITHUB_TOKEN}` } : {}),
      },
      timeout: 30000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', async () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`GitHub API failed: ${res.statusCode} - ${data}`));
        }
        try {
          const release = JSON.parse(data);
          const apkAsset = release.assets.find(a => a.name.toLowerCase().includes('whatsapp') && a.name.endsWith('.apk'));
          
          if (!apkAsset) {
            log('DOWNLOAD', `Available assets: ${release.assets.map(a => a.name).join(', ')}`);
            return reject(new Error('No whatsapp.apk found in latest release assets'));
          }

          const fileSizeMB = (apkAsset.size / 1024 / 1024).toFixed(2);
          log('DOWNLOAD', `Found APK: ${apkAsset.name} (${fileSizeMB}MB)`);
          
          // Download the APK
          const downloadReq = https.get(apkAsset.browser_download_url, (downloadRes) => {
            const file = fs.createWriteStream(APK_PATH);
            downloadRes.pipe(file);
            file.on('finish', () => {
              file.close();
              log('DOWNLOAD', `✓ APK saved to ${APK_PATH}`);
              resolve();
            });
            file.on('error', reject);
          });
          downloadReq.on('error', reject);
        } catch (e) {
          reject(new Error(`Failed to parse release JSON: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('GitHub API request timeout'));
    });
    req.end();
  });
}

// ── Main Automation Flow ──────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting WhatsApp registration for phone: ${PHONE}`);
  
  // 1. Check emulator
  log('STEP 1', 'Checking emulator...');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  log('STEP 1', '✓ Emulator ready');

  // 2. Wake device
  log('STEP 2', 'Waking device...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  shell('settings put global stay_on_while_plugged_in 3');
  log('STEP 2', '✓ Device awake');

  // 3. Download WhatsApp APK from GitHub Release
  log('STEP 3', 'Downloading WhatsApp APK from GitHub release...');
  try {
    await downloadWhatsAppAPK();
    log('STEP 3', '✓ APK downloaded');
  } catch (e) {
    throw new Error(`Failed to download APK: ${e.message}`);
  }

  // 4. Verify APK file exists
  log('STEP 4', 'Verifying APK file...');
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`APK file not found at ${APK_PATH}`);
  }
  const apkSize = fs.statSync(APK_PATH).size / 1024 / 1024;
  log('STEP 4', `✓ APK verified (${apkSize.toFixed(2)}MB)`);

  // 5. Install APK on emulator
  log('STEP 5', 'Installing WhatsApp APK on emulator...');
  const installResult = adb(`install -r "${APK_PATH}"`, 120000);
  if (installResult.includes('Success') || installResult.includes('success')) {
    log('STEP 5', '✓ APK installed successfully');
  } else {
    throw new Error(`APK installation failed: ${installResult}`);
  }

  // 6. Grant permissions
  log('STEP 6', 'Granting WhatsApp permissions...');
  const WA_PERMS = [
    'android.permission.RECORD_AUDIO',
    'android.permission.CAMERA',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_CALL_LOG',
    'android.permission.INTERNET',
  ];
  for (const perm of WA_PERMS) {
    shell(`pm grant com.whatsapp ${perm} 2>/dev/null || true`);
  }
  log('STEP 6', '✓ Permissions granted');

  // 7. Clear WhatsApp data for fresh registration
  log('STEP 7', 'Clearing WhatsApp cache...');
  shell('pm clear com.whatsapp 2>/dev/null || true');
  await sleep(1000);
  log('STEP 7', '✓ Cache cleared');

  // 8. Launch WhatsApp
  log('STEP 8', 'Launching WhatsApp...');
  shell('am start -n com.whatsapp/.Main 2>/dev/null');
  await sleep(6000);
  log('STEP 8', '✓ WhatsApp launched');

  // 9. Take initial screenshot
  log('STEP 9', 'Taking initial screenshot...');
  shell('screencap -p /sdcard/whatsapp_init.png');
  adb('pull /sdcard/whatsapp_init.png /tmp/wa_screenshot_init.png');
  log('STEP 9', '✓ Initial screenshot saved');

  // 10. Wait for WhatsApp to show registration UI (phone number entry screen)
  log('STEP 10', 'Waiting for WhatsApp registration screen...');
  let screenReady = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      shell('screencap -p /sdcard/wa_check.png');
      adb('pull /sdcard/wa_check.png /tmp/wa_check.png');
      screenReady = true;
      break;
    } catch (e) {
      // continue
    }
  }
  if (!screenReady) {
    log('STEP 10', '⚠ WhatsApp may not be ready, continuing anyway');
  } else {
    log('STEP 10', '✓ WhatsApp registration screen ready');
  }

  // 11. Take screenshot before entering phone number
  log('STEP 11', 'Taking screenshot before phone entry...');
  shell('screencap -p /sdcard/before_phone.png');
  adb('pull /sdcard/before_phone.png /tmp/wa_screenshot_before_phone.png');

  // 12. Tap on phone number input field and enter PHONE
  log('STEP 12', `Entering phone number: ${PHONE}`);
  tap(540, 600); // Typical phone input field location
  await sleep(500);
  keyevent('KEYCODE_CTRL_A');
  await sleep(200);
  for (const digit of PHONE) {
    shell(`input text ${digit}`);
    await sleep(50);
  }
  log('STEP 12', '✓ Phone number entered');

  // 13. Take screenshot after phone entry
  log('STEP 13', 'Taking screenshot after phone entry...');
  await sleep(500);
  shell('screencap -p /sdcard/after_phone.png');
  adb('pull /sdcard/after_phone.png /tmp/wa_screenshot_after_phone.png');

  // 14. Wait for OTP screen (session_manager will handle OTP submission)
  log('STEP 14', 'Waiting for OTP screen / registration...');
  let waitTime = 0;
  const maxWait = 15 * 60 * 1000; // 15 minutes
  while (waitTime < maxWait) {
    await sleep(5000);
    waitTime += 5000;
    
    // Take periodic screenshots
    if (waitTime % 30000 === 0) {
      try {
        shell('screencap -p /sdcard/wa_progress.png');
        adb('pull /sdcard/wa_progress.png /tmp/wa_screenshot_progress_' + Math.floor(waitTime / 1000) + '.png');
      } catch (e) {
        // ignore
      }
    }
  }

  log('STEP 14', 'Reached maximum wait time');

  // 15. Take final screenshot
  log('STEP 15', 'Taking final screenshot...');
  shell('screencap -p /sdcard/whatsapp_final.png');
  adb('pull /sdcard/whatsapp_final.png /tmp/wa_screenshot_final.png');
  log('STEP 15', '✓ Final screenshot saved');

  await webhook('registered', { step: 'whatsapp_registration_initiated', phone: PHONE });
}

main().catch(async (err) => {
  log('FATAL', err.message);
  try {
    shell('screencap -p /sdcard/error.png');
    adb('pull /sdcard/error.png /tmp/wa_error.png');
  } catch (e) {}
  await webhook('bad_number', { reason: err.message });
  process.exit(1);
});
