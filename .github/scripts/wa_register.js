/**
 * wa_register.js
 * Drives WhatsApp registration via ADB on a GitHub Actions Android emulator.
 *
 * Key design decisions:
 * - Uses `adb shell` directly via execSync with shell: true to avoid quoting issues
 * - Dumps UI to /sdcard/ui.xml (not /dev/stdout which is unreliable)
 * - Logs every screen state for easy debugging
 * - All waits are generous to account for slow emulator rendering
 */

'use strict';

const { execSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');

const PHONE      = process.env.PHONE_NUMBER;
const USER_ID    = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID     = process.env.GITHUB_RUN_ID;
const RENDER_BASE = WEBHOOK_URL.replace('/webhook/event', '');

const WA_PACKAGE = 'com.whatsapp';
const WAIT_MS = (ms) => new Promise(r => setTimeout(r, ms));

// ── ADB helpers ───────────────────────────────────────────────────────────────

// Run any shell command directly (not wrapped in adb shell "...")
function run(cmd, timeoutMs = 30000) {
  try {
    return execSync(cmd, {
      timeout: timeoutMs,
      encoding: 'utf8',
      shell: '/bin/sh',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    return (e.stdout || '').trim();
  }
}

// Run a command inside the emulator via adb shell
function shell(cmd, timeoutMs = 30000) {
  // Write command to a temp script to avoid quoting hell
  const script = `/tmp/adb_cmd_${Date.now()}.sh`;
  fs.writeFileSync(script, `#!/bin/sh\n${cmd}\n`);
  const result = run(`adb shell < ${script}`, timeoutMs);
  try { fs.unlinkSync(script); } catch (_) {}
  return result;
}

function tap(x, y) {
  run(`adb shell input tap ${x} ${y}`);
}

function typeText(text) {
  // Use adb shell input text — escape special chars
  const safe = text.replace(/([\\$`"&|;<>(){}!#])/g, '\\$1');
  run(`adb shell input text "${safe}"`);
}

function keyevent(code) {
  run(`adb shell input keyevent ${code}`);
}

// ── UI dump and search ────────────────────────────────────────────────────────

async function dumpUI(timeoutMs = 10000) {
  // Dump to sdcard then pull — more reliable than /dev/stdout
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    run('adb shell uiautomator dump /sdcard/ui.xml', 8000);
    const xml = run('adb shell cat /sdcard/ui.xml', 5000);
    if (xml && xml.includes('<hierarchy')) return xml;
    await WAIT_MS(1000);
  }
  return '';
}

async function waitForText(text, timeoutMs = 60000) {
  console.log(`[UI] Waiting for: "${text}" (${timeoutMs/1000}s timeout)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (xml.includes(text)) {
      console.log(`[UI] Found: "${text}"`);
      return xml;
    }
    await WAIT_MS(2000);
  }
  console.log(`[UI] Timeout waiting for: "${text}"`);
  return null;
}

async function tapText(text, timeoutMs = 30000) {
  const xml = await waitForText(text, timeoutMs);
  if (!xml) return false;

  // Extract bounds for the element containing this text
  const regex = new RegExp(
    `text="${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    'i'
  );
  // Also try content-desc
  const regex2 = new RegExp(
    `content-desc="${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`,
    'i'
  );

  let match = xml.match(regex) || xml.match(regex2);
  if (match) {
    const cx = Math.round((parseInt(match[1]) + parseInt(match[3])) / 2);
    const cy = Math.round((parseInt(match[2]) + parseInt(match[4])) / 2);
    console.log(`[UI] Tapping "${text}" at (${cx}, ${cy})`);
    tap(cx, cy);
    await WAIT_MS(1000);
    return true;
  }

  console.log(`[UI] Could not find bounds for "${text}" — tapping center`);
  tap(540, 1140); // Pixel 4 center as fallback
  return false;
}

async function getCurrentScreen() {
  const xml = await dumpUI(5000);
  // Log a summary of what's on screen for debugging
  const texts = [];
  const re = /text="([^"]{2,40})"/g;
  let m;
  while ((m = re.exec(xml)) !== null) texts.push(m[1]);
  console.log(`[SCREEN] Visible text: ${texts.slice(0, 10).join(' | ')}`);
  return xml;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

function sendWebhook(event, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id: RUN_ID,
      ...extra,
    });
    const u = new URL(WEBHOOK_URL);
    const options = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(options, (res) => {
      console.log(`[WEBHOOK] ${event} → ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', (e) => { console.error(`[WEBHOOK] ${event} error:`, e.message); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── OTP polling ───────────────────────────────────────────────────────────────

async function pollForOtp(timeoutMs = 13 * 60 * 1000) {
  const otpUrl = `${RENDER_BASE}/otp/${PHONE}`;
  const deadline = Date.now() + timeoutMs;
  console.log(`[OTP] Polling ${otpUrl} for up to 13 minutes...`);
  while (Date.now() < deadline) {
    await WAIT_MS(5000);
    try {
      const otp = await httpGet(otpUrl, { 'X-Webhook-Secret': WEBHOOK_SECRET });
      if (otp && /^\d{6}$/.test(otp.trim())) {
        console.log(`[OTP] Received: ${otp.trim()}`);
        return otp.trim();
      }
    } catch (_) {}
  }
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => res.statusCode === 200 ? resolve(data.trim()) : resolve(null));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function parseWaitSeconds(text) {
  let total = 0;
  const h = text.match(/(\d+)\s*hour/i);
  const m = text.match(/(\d+)\s*min/i);
  const s = text.match(/(\d+)\s*sec/i);
  if (h) total += parseInt(h[1]) * 3600;
  if (m) total += parseInt(m[1]) * 60;
  if (s) total += parseInt(s[1]);
  return total > 0 ? total : 600;
}

// ── Install WhatsApp ──────────────────────────────────────────────────────────

async function installWhatsApp() {
  const apkPath = '/tmp/whatsapp.apk';
  if (!fs.existsSync(apkPath)) {
    throw new Error('WhatsApp APK not found at /tmp/whatsapp.apk');
  }
  const size = fs.statSync(apkPath).size;
  console.log(`[SETUP] Installing WhatsApp APK (${(size / 1024 / 1024).toFixed(1)} MB)...`);

  // Show APK architecture
  fs.writeFileSync('/tmp/check_apk.sh', 'unzip -l /tmp/whatsapp.apk 2>/dev/null | grep lib/ | cut -d/ -f1-3 | sort -u\n');
  const libFolders = run('sh /tmp/check_apk.sh', 10000);
  console.log(`[SETUP] APK native libs:\n${libFolders || '(none — pure Java APK)'}`);

  await WAIT_MS(3000);

  // Try multiple install strategies
  let installed = false;

  // Strategy 1: Standard install
  console.log('[SETUP] Strategy 1: standard install...');
  let result = run('adb install -r -t -g /tmp/whatsapp.apk 2>&1', 300000);
  console.log(`[SETUP] Output: ${result}`);
  if (result.toLowerCase().includes('success')) {
    installed = true;
  }

  // Strategy 2: Force x86_64 ABI
  if (!installed) {
    console.log('[SETUP] Strategy 2: force x86_64 ABI...');
    result = run('adb install -r -t -g --abi x86_64 /tmp/whatsapp.apk 2>&1', 300000);
    console.log(`[SETUP] Output: ${result}`);
    if (result.toLowerCase().includes('success')) installed = true;
  }

  // Strategy 3: Force x86 ABI
  if (!installed) {
    console.log('[SETUP] Strategy 3: force x86 ABI...');
    result = run('adb install -r -t -g --abi x86 /tmp/whatsapp.apk 2>&1', 300000);
    console.log(`[SETUP] Output: ${result}`);
    if (result.toLowerCase().includes('success')) installed = true;
  }

  // Strategy 4: Repackage — strip ARM libs, keep only x86/x86_64
  if (!installed && result.includes('INSTALL_FAILED_NO_MATCHING_ABIS')) {
    console.log('[SETUP] Strategy 4: repackaging APK to remove ARM libs...');
    try {
      const script = 'set -e\n'
        + 'cd /tmp && rm -rf apk_work && mkdir apk_work && cd apk_work\n'
        + 'unzip -q /tmp/whatsapp.apk -d .\n'
        + 'rm -rf lib/arm64-v8a lib/armeabi-v7a lib/armeabi 2>/dev/null || true\n'
        + 'if [ -d lib/x86_64 ]; then rm -rf lib/x86 2>/dev/null || true; fi\n'
        + 'ls lib/ 2>/dev/null || echo "no lib folder"\n'
        + 'zip -q -r /tmp/whatsapp_x86.apk . -x "META-INF/*"\n'
        + 'cd /tmp && rm -rf apk_work\n';
      fs.writeFileSync('/tmp/repack.sh', script);
      const repackOut = run('sh /tmp/repack.sh 2>&1', 120000);
      console.log(`[SETUP] Repack output: ${repackOut}`);
      if (fs.existsSync('/tmp/whatsapp_x86.apk')) {
        result = run('adb install -r -t -g /tmp/whatsapp_x86.apk 2>&1', 300000);
        console.log(`[SETUP] Repack install output: ${result}`);
        if (result.toLowerCase().includes('success')) installed = true;
      }
    } catch (e) {
      console.error(`[SETUP] Repack failed: ${e.message}`);
    }
  }

  // Final pm list check
  if (!installed) {
    await WAIT_MS(3000);
    const pkgCheck = run('adb shell pm list packages 2>/dev/null', 10000);
    if (pkgCheck.includes('com.whatsapp')) {
      console.log('[SETUP] Package found in pm list — install succeeded');
      installed = true;
    }
  }

  if (!installed) {
    throw new Error(`WhatsApp install failed. Last output: ${result}`);
  }
  console.log('[SETUP] WhatsApp installed successfully');
  await WAIT_MS(2000);
}

