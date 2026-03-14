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

  await WAIT_MS(3000);

  let installed = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[SETUP] Install attempt ${attempt}/3...`);
      const result = run('adb install -r -t -g /tmp/whatsapp.apk', 300000);
      console.log(`[SETUP] Install output: ${result}`);
      // "Performing Streamed Install" followed by "Success" on next line
      // result.includes covers both same-line and multi-line output
      if (result.toLowerCase().includes('success')) {
        installed = true;
        break;
      }
      // Also accept if no failure indicators present
      if (!result.includes('FAILED') && !result.includes('Exception') &&
          !result.includes('error') && result.length > 5) {
        console.log('[SETUP] No explicit Success but no failure — assuming installed');
        installed = true;
        break;
      }
    } catch (e) {
      console.error(`[SETUP] Install attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) {
        await WAIT_MS(10000);
        run('adb kill-server', 10000);
        await WAIT_MS(2000);
        run('adb start-server', 10000);
        await WAIT_MS(3000);
      }
    }
  }
  if (!installed) throw new Error('WhatsApp APK install failed after 3 attempts');
  console.log('[SETUP] WhatsApp installed successfully');
  await WAIT_MS(2000);
}

// ── Main registration flow ────────────────────────────────────────────────────

async function main() {
  try {
    console.log(`[MAIN] Starting registration for ${PHONE}`);

    // Give emulator a moment after boot-completed signal
    await WAIT_MS(5000);

    // Verify emulator is responsive
    const bootProp = run('adb shell getprop sys.boot_completed', 10000);
    if (bootProp.trim() !== '1') {
      throw new Error(`Emulator not ready, boot_completed=${bootProp}`);
    }
    console.log('[MAIN] Emulator is ready');

    // ── Unlock the screen ─────────────────────────────────────────────────
    // The emulator boots to a lock screen. Must unlock before launching apps.
    console.log('[MAIN] Unlocking screen...');
    run('adb shell input keyevent KEYCODE_WAKEUP', 5000);       // Wake screen
    await WAIT_MS(1000);
    run('adb shell input keyevent KEYCODE_MENU', 5000);          // Trigger unlock
    await WAIT_MS(500);
    run('adb shell input swipe 540 1800 540 200 300', 5000);     // Swipe up to unlock
    await WAIT_MS(1000);
    run('adb shell input keyevent KEYCODE_HOME', 5000);          // Go to home screen
    await WAIT_MS(2000);

    // Disable lock screen permanently for this session
    run('adb shell settings put secure lockscreen.disabled 1', 5000);
    run('adb shell settings put global stay_on_while_plugged_in 3', 5000);

    // Confirm we are on home screen
    const unlockCheck = await dumpUI(5000);
    console.log('[MAIN] Screen after unlock:');
    await getCurrentScreen();

    await installWhatsApp();

    // ── Launch WhatsApp ───────────────────────────────────────────────────
    console.log('[MAIN] Launching WhatsApp...');

    // Clear logcat so we get clean output from WhatsApp launch
    run('adb logcat -c', 5000);

    // Go to home screen first
    run('adb shell input keyevent KEYCODE_HOME', 3000);
    await WAIT_MS(1000);

    // Verify WhatsApp is actually installed before launching
    const pkgCheck = run('adb shell pm list packages | grep whatsapp', 5000);
    console.log(`[MAIN] WhatsApp package check: ${pkgCheck}`);
    if (!pkgCheck.includes('com.whatsapp')) {
      throw new Error('WhatsApp package not found after install — installation may have failed silently');
    }

    // Launch WhatsApp
    const launchOut = run('adb shell am start -n com.whatsapp/com.whatsapp.Main', 10000);
    console.log(`[MAIN] Launch output: ${launchOut}`);
    await WAIT_MS(6000);

    // Capture logcat to see what WhatsApp is doing
    const logcat = run('adb logcat -d -t 50 -s WhatsApp:* AndroidRuntime:E ActivityManager:I', 8000);
    console.log(`[MAIN] Logcat after launch:
${logcat}`);

    await getCurrentScreen();

    // ── Dismiss crash dialog if WhatsApp keeps stopping ───────────────────
    // This happens when the APK architecture doesn't match the emulator.
    // "google_apis" target includes ARM translation so this should not appear,
    // but handle it defensively just in case.
    const crashXml = await dumpUI(3000);
    if (crashXml && crashXml.includes('keeps stopping')) {
      console.error('[MAIN] WhatsApp crash detected — "keeps stopping" dialog');
      console.error('[MAIN] This usually means ARM/x86 architecture mismatch');
      // Try closing and relaunching once
      run('adb shell input keyevent KEYCODE_BACK', 3000);
      await WAIT_MS(1000);
      for (const btn of ['Close app', 'OK', 'Close']) {
        if (crashXml.includes(btn)) {
          await tapText(btn, 5000);
          break;
        }
      }
      await WAIT_MS(3000);
      // Check if still crashing
      const stillCrash = await dumpUI(3000);
      if (stillCrash && stillCrash.includes('keeps stopping')) {
        await sendWebhook('bad_number', { reason: 'WhatsApp crashes on launch — architecture mismatch or corrupted APK' });
        process.exit(0);
      }
    }

    await getCurrentScreen();

    // ── Agree & Continue (first launch) ──────────────────────────────────
    // WhatsApp shows "AGREE AND CONTINUE" on very first launch
    for (const agreeText of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE AND CONTINUE', 'AGREE', 'Accept', 'I agree']) {
      const xml = await dumpUI(3000);
      if (xml && xml.toLowerCase().includes(agreeText.toLowerCase())) {
        console.log(`[MAIN] Found agree button: "${agreeText}"`);
        await tapText(agreeText, 8000);
        await WAIT_MS(4000);
        break;
      }
    }

    await getCurrentScreen();

    // ── Phone number entry ────────────────────────────────────────────────
    // Wait up to 60s total for any variant of the phone number screen
    let phoneScreenXml = null;
    const phoneScreenTexts = [
      'Enter your phone number',
      'Your phone number',
      'phone number',
      'enter your phone',
      'Enter phone',
      'Phone number',
      'country code',
      'Country code',
    ];

    console.log('[MAIN] Waiting for phone number entry screen...');
    const phoneDeadline = Date.now() + 60000;
    while (Date.now() < phoneDeadline && !phoneScreenXml) {
      const xml = await dumpUI(5000);
      for (const t of phoneScreenTexts) {
        if (xml && xml.toLowerCase().includes(t.toLowerCase())) {
          console.log(`[MAIN] Phone screen found via: "${t}"`);
          phoneScreenXml = xml;
          break;
        }
      }
      if (!phoneScreenXml) {
        await getCurrentScreen();
        await WAIT_MS(3000);
      }
    }

    if (!phoneScreenXml) {
      await getCurrentScreen();
      await sendWebhook('bad_number', { reason: 'Phone number entry screen not found after agree' });
      process.exit(0); // exit(0) — bot already notified, skip if:failure() step
    }

    console.log('[MAIN] Phone number screen found');
    await WAIT_MS(1000);

    // The phone number field — clear it and type the number
    // First clear whatever country code is pre-filled
    keyevent('KEYCODE_CTRL_A');
    await WAIT_MS(300);
    keyevent('KEYCODE_DEL');
    await WAIT_MS(300);

    // Type the full number
    typeText(PHONE);
    await WAIT_MS(1000);

    console.log(`[MAIN] Typed phone number: ${PHONE}`);
    await getCurrentScreen();

    // Tap Next / arrow button
    let nextTapped = false;
    for (const nextText of ['Next', 'NEXT', 'next', 'Done', 'Continue']) {
      const xml = await dumpUI(3000);
      if (xml && xml.includes(nextText)) {
        await tapText(nextText, 5000);
        nextTapped = true;
        break;
      }
    }
    if (!nextTapped) {
      // Fallback: tap the next arrow (usually at ~980, 1800 on Pixel 4)
      console.log('[MAIN] Next button not found by text — tapping by coordinate');
      tap(980, 1800);
    }
    await WAIT_MS(4000);

    await getCurrentScreen();

    // ── Check screens after tapping Next ─────────────────────────────────
    const postNextXml = await dumpUI();

    // Rate limited
    if (postNextXml.includes('Try again') || postNextXml.includes('try again') ||
        postNextXml.includes('wait') || postNextXml.includes('Wait')) {
      const secs = parseWaitSeconds(postNextXml);
      console.log(`[MAIN] Rate limited — wait ${secs}s`);
      await sendWebhook('rate_limited', { wait_seconds: secs });
      process.exit(0);
    }

    // Invalid number
    if (postNextXml.includes('not a valid') || postNextXml.includes('Invalid') ||
        postNextXml.includes('invalid') || postNextXml.includes('Enter a valid')) {
      await sendWebhook('bad_number', { reason: 'WhatsApp: invalid phone number' });
      process.exit(0);
    }

    // Already registered
    if (postNextXml.includes('already have an account') || postNextXml.includes('already registered') ||
        postNextXml.includes('Welcome back')) {
      await sendWebhook('already_registered');
      process.exit(0);
    }

    // ── Confirmation dialog — "We will send an SMS" ───────────────────────
    // WhatsApp shows a confirmation popup with the number before sending OTP
    for (const confirmText of ['OK', 'Yes', 'Send SMS', 'SEND SMS', 'Send', 'Confirm']) {
      const xml = await dumpUI(3000);
      if (xml && xml.includes(confirmText)) {
        console.log(`[MAIN] Confirmation dialog — tapping "${confirmText}"`);
        await tapText(confirmText, 5000);
        await WAIT_MS(2000);
        break;
      }
    }

    // ── OTP sending confirmation ──────────────────────────────────────────
    // Wait for the OTP input screen or "Verifying" state
    let otpScreenFound = false;
    for (const otpText of [
      'Enter the 6-digit code', 'Enter code', 'Verifying', 'enter the 6',
      'code sent', 'Didn\'t receive', 'Resend SMS', 'resend',
    ]) {
      const xml = await waitForText(otpText, 30000);
      if (xml) {
        otpScreenFound = true;
        console.log(`[MAIN] OTP screen detected via: "${otpText}"`);
        break;
      }
    }

    if (!otpScreenFound) {
      await getCurrentScreen();
      await sendWebhook('bad_number', { reason: 'OTP screen not reached after phone entry' });
      process.exit(0); // exit(0) — bot already notified, skip if:failure() step
    }

    // ── Notify bot OTP was sent ───────────────────────────────────────────
    await sendWebhook('otp_requested');
    console.log('[MAIN] OTP requested — waiting for user reply on Telegram (13 min)...');

    // ── Poll for OTP ──────────────────────────────────────────────────────
    const otp = await pollForOtp();
    if (!otp) {
      console.log('[MAIN] OTP timed out');
      process.exit(0);
    }

    console.log(`[MAIN] Entering OTP: ${otp}`);

    // Clear any existing digits and enter OTP
    // WhatsApp OTP screen usually has 6 individual boxes or one field
    keyevent('KEYCODE_CTRL_A');
    await WAIT_MS(200);
    keyevent('KEYCODE_DEL');
    await WAIT_MS(200);

    // Type digit by digit with small delay (works for both single field and boxes)
    for (const digit of otp) {
      typeText(digit);
      await WAIT_MS(300);
    }
    await WAIT_MS(4000);

    // ── Check OTP result ──────────────────────────────────────────────────
    const resultXml = await dumpUI();
    console.log('[MAIN] OTP result screen:');
    await getCurrentScreen();

    if (resultXml.includes('Wrong code') || resultXml.includes('wrong code') ||
        resultXml.includes('incorrect') || resultXml.includes('Invalid code')) {
      await sendWebhook('otp_error');
      process.exit(0);
    }

    if (resultXml.includes('two-step') || resultXml.includes('Two-step') ||
        resultXml.includes('passkey') || resultXml.includes('Passkey') ||
        resultXml.includes('fingerprint') || resultXml.includes('2FA')) {
      await sendWebhook('bad_number', { reason: '2FA/passkey required' });
      process.exit(0);
    }

    // ── Skip optional setup screens ───────────────────────────────────────
    for (let i = 0; i < 5; i++) {
      const xml = await dumpUI(3000);
      let skipped = false;
      for (const skipText of ['Skip', 'Not now', 'Continue', 'Allow', 'SKIP', 'Later']) {
        if (xml && xml.includes(skipText)) {
          await tapText(skipText, 5000);
          await WAIT_MS(2000);
          skipped = true;
          break;
        }
      }
      if (!skipped) break;
    }

    // ── Success ───────────────────────────────────────────────────────────
    await sendWebhook('registered');
    console.log(`[MAIN] ${PHONE} registered successfully`);
    process.exit(0);

  } catch (err) {
    console.error('[MAIN] Fatal error:', err.message);
    console.error(err.stack);
    await sendWebhook('bad_number', { reason: `Script error: ${err.message}` });
    process.exit(0); // exit(0) — bot already notified, skip if:failure() step
  }
}

main();
