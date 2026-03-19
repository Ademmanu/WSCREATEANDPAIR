#!/usr/bin/env node
'use strict';

/**
 * wa_register.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp Mobile Registration Automation
 * Uses ADB + UIAutomator XML parsing inside a GitHub Actions Android emulator.
 *
 * Environment variables (injected by register.yml):
 *   PHONE_NUMBER       — full international number without + (e.g. "447911123456")
 *   WEBHOOK_URL        — bot webhook URL  (e.g. "https://mybot.render.com/webhook/event")
 *   WEBHOOK_SECRET     — shared secret for X-Webhook-Secret header
 *   TELEGRAM_USER_ID   — Telegram user ID for callbacks
 *   GITHUB_RUN_ID      — GitHub Actions run ID
 *
 * Webhook events emitted → bot.py /webhook/event:
 *   otp_requested      — WhatsApp asked for a verification code
 *   registered         — Registration flow completed successfully
 *   otp_error          — Wrong OTP was entered
 *   already_registered — Number already has a WA account
 *   bad_number         — Number rejected / script fatal error
 *   rate_limited       — Too many attempts  { wait_seconds }
 *   restricted         — Account temporarily restricted { seconds_remaining }
 *   banned             — Account permanently banned
 *
 * OTP retrieval:
 *   GET  {WEBHOOK_URL/../otp/{phone}}  (X-Webhook-Secret header)
 *   Returns 200 + 6-digit string when user replied on Telegram, else 204.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { execSync } = require('child_process');
const fs           = require('fs');
const https        = require('https');
const http         = require('http');

// ══════════════════════════════════════════════════════════════════════════════
// Configuration
// ══════════════════════════════════════════════════════════════════════════════

const PHONE_NUMBER     = (process.env.PHONE_NUMBER     || '').trim();
const WEBHOOK_URL      = (process.env.WEBHOOK_URL      || '').trim();
const WEBHOOK_SECRET   = (process.env.WEBHOOK_SECRET   || '').trim();
const TELEGRAM_USER_ID = (process.env.TELEGRAM_USER_ID || '').trim();
const RUN_ID           = (process.env.GITHUB_RUN_ID    || '').trim();

const WA_PKG           = 'com.whatsapp';
const APK_PATH         = '/tmp/whatsapp.apk';
const UI_XML_DEVICE    = '/sdcard/ui.xml';
const UI_XML_LOCAL     = '/tmp/wa_ui.xml';

// Timeouts (ms)
const BOOT_TIMEOUT         = 180_000;   // 3 min
const INSTALL_TIMEOUT      = 120_000;   // 2 min
const UI_WAIT_TIMEOUT      = 45_000;    // per-screen wait
const OTP_POLL_TIMEOUT     = 14 * 60_000; // 14 min (bot timer is 15)
const OTP_POLL_INTERVAL    = 5_000;
const STEP_DELAY           = 1_800;
const POST_TAP_DELAY       = 1_200;
const POST_TYPE_DELAY      = 600;

// ══════════════════════════════════════════════════════════════════════════════
// Logging & on-screen overlay
// ══════════════════════════════════════════════════════════════════════════════

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

/**
 * Print to stdout AND post a visible Android notification on the emulator.
 * This makes every registration step visible both in CI logs and on-screen.
 */
function screen(label, detail = '') {
  const full = detail ? `${label}: ${detail}` : label;
  log(`📱  ${full}`);
  // Android notification (API 33 supports cmd notification post)
  try {
    const safe = full
      .replace(/['"\\]/g, '')   // strip shell-unsafe chars
      .slice(0, 120);
    adb(
      `cmd notification post -t "WA-Register" -S bigtext wa_reg 1 "${safe}"`,
      { silent: true, timeout: 5_000 }
    );
  } catch (_) { /* non-fatal — CI stdout is the primary log */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADB helpers
// ══════════════════════════════════════════════════════════════════════════════

function adb(cmd, opts = {}) {
  const { timeout = 30_000, silent = false } = opts;
  try {
    const out = execSync(`adb shell ${cmd}`, {
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', silent ? 'pipe' : 'inherit'],
    });
    return (out || '').trim();
  } catch (e) {
    if (!silent) log(`[ADB WARN] ${cmd.slice(0, 80)}: ${e.message}`);
    return '';
  }
}

function adbHost(cmd, opts = {}) {
  const { timeout = 60_000, silent = false } = opts;
  try {
    const out = execSync(`adb ${cmd}`, {
      timeout,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', silent ? 'pipe' : 'inherit'],
    });
    return (out || '').trim();
  } catch (e) {
    if (!silent) log(`[ADB HOST WARN] ${cmd.slice(0, 80)}: ${e.message}`);
    return '';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ══════════════════════════════════════════════════════════════════════════════
// UIAutomator XML dump & parsing
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Dump the current UI to XML and return its text.
 * Returns empty string on failure rather than throwing.
 */
function dumpUI() {
  try {
    adb(`uiautomator dump ${UI_XML_DEVICE}`, { silent: true, timeout: 15_000 });
    execSync(`adb pull ${UI_XML_DEVICE} ${UI_XML_LOCAL} 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return fs.readFileSync(UI_XML_LOCAL, 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * Parse every <node> element from a UIAutomator XML dump.
 * Returns an array of plain objects for easy filtering.
 */
function parseNodes(xml) {
  const nodes = [];
  const RE_NODE = /<node\s([^>]+?)\s*\/?>/g;
  let m;
  while ((m = RE_NODE.exec(xml)) !== null) {
    const attrs = m[1];
    const attr = (key) => {
      const inner = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
      return inner ? inner[1] : '';
    };
    nodes.push({
      text:        attr('text'),
      resourceId:  attr('resource-id'),
      contentDesc: attr('content-desc'),
      cls:         attr('class'),
      bounds:      attr('bounds'),
      enabled:     attr('enabled') === 'true',
      clickable:   attr('clickable') === 'true',
      focusable:   attr('focusable') === 'true',
    });
  }
  return nodes;
}

/**
 * Get the centre coordinates from a bounds string "[l,t][r,b]".
 */
function centre(bounds) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds || '');
  if (!m) return null;
  return {
    x: Math.floor((+m[1] + +m[3]) / 2),
    y: Math.floor((+m[2] + +m[4]) / 2),
  };
}

/**
 * Find the first node whose properties satisfy ALL supplied criteria.
 *
 *   text       — node.text contains this string (case-insensitive)
 *   textExact  — node.text === this string (case-sensitive)
 *   resId      — node.resourceId ends with this string
 *   desc       — node.contentDesc contains this string (case-insensitive)
 *   cls        — node.cls contains this string
 */
function find(nodes, crit) {
  return nodes.find(n => matchCrit(n, crit)) || null;
}

function findAll(nodes, crit) {
  return nodes.filter(n => matchCrit(n, crit));
}

function matchCrit(n, crit) {
  if (crit.text      !== undefined && !n.text.toLowerCase().includes(crit.text.toLowerCase())) return false;
  if (crit.textExact !== undefined && n.text !== crit.textExact) return false;
  if (crit.resId     !== undefined && !n.resourceId.endsWith(crit.resId)) return false;
  if (crit.desc      !== undefined && !n.contentDesc.toLowerCase().includes(crit.desc.toLowerCase())) return false;
  if (crit.cls       !== undefined && !n.cls.includes(crit.cls)) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════════════════════
// Touch / input actions
// ══════════════════════════════════════════════════════════════════════════════

function tap(node) {
  if (!node) return false;
  const c = centre(node.bounds);
  if (!c) { log(`[TAP] Bad bounds: ${node.bounds}`); return false; }
  adb(`input tap ${c.x} ${c.y}`);
  return true;
}

function tapXY(x, y) {
  adb(`input tap ${x} ${y}`);
}

/**
 * Type text safely for ADB input text.
 * Spaces → %s, ampersands escaped.
 */
function type(text) {
  // input text treats spaces as argument separators — replace with %s
  const safe = String(text)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/ /g, '%s')
    .replace(/&/g, '\\&');
  adb(`input text '${safe}'`);
}

/**
 * Focus a field then select-all → delete, ready for fresh input.
 */
function clearAndFocus(node) {
  tap(node);
  adb('input keyevent KEYCODE_CTRL_A');
  adb('input keyevent KEYCODE_DEL');
}

function pressBack() {
  adb('input keyevent KEYCODE_BACK');
}

function pressEnter() {
  adb('input keyevent KEYCODE_ENTER');
}

// ══════════════════════════════════════════════════════════════════════════════
// Webhook helpers
// ══════════════════════════════════════════════════════════════════════════════

async function sendWebhook(event, extra = {}) {
  const body = JSON.stringify({
    event,
    phone_number: PHONE_NUMBER,
    telegram_user_id: parseInt(TELEGRAM_USER_ID, 10) || 0,
    run_id: RUN_ID,
    ...extra,
  });

  log(`[WEBHOOK →] ${event}  ${JSON.stringify(extra)}`);

  return new Promise((resolve) => {
    let url;
    try { url = new URL(WEBHOOK_URL); } catch (_) {
      log('[WEBHOOK] Bad WEBHOOK_URL, skipping');
      return resolve(0);
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + (url.search || ''),
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Webhook-Secret': WEBHOOK_SECRET,
        },
      },
      (res) => {
        res.resume();
        log(`[WEBHOOK ←] HTTP ${res.statusCode}`);
        resolve(res.statusCode);
      }
    );
    req.on('error', (e) => { log(`[WEBHOOK ERR] ${e.message}`); resolve(0); });
    req.setTimeout(20_000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// OTP polling  (GET /otp/{phone})
// ══════════════════════════════════════════════════════════════════════════════

async function pollForOTP() {
  // Derive OTP endpoint from WEBHOOK_URL by replacing the path tail
  const otpUrl = WEBHOOK_URL.replace(/\/webhook\/event.*$/, '') + `/otp/${PHONE_NUMBER}`;
  log(`[OTP] Polling: ${otpUrl}`);
  screen('Waiting for OTP from Telegram');

  const deadline = Date.now() + OTP_POLL_TIMEOUT;

  while (Date.now() < deadline) {
    await sleep(OTP_POLL_INTERVAL);
    try {
      const otp = await httpGet(otpUrl);
      if (otp && /^\d{6}$/.test(otp.trim())) {
        log(`[OTP] Received: ${otp.trim()}`);
        return otp.trim();
      }
    } catch (_) {}

    const remaining = Math.round((deadline - Date.now()) / 1000);
    log(`[OTP] Not ready — ${remaining}s remaining`);
  }

  log('[OTP] Timed out — no code received from Telegram');
  return null;
}

function httpGet(urlStr) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); } catch (e) { return reject(e); }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (isHttps ? 443 : 80),
        path:     url.pathname + (url.search || ''),
        method:   'GET',
        headers:  { 'X-Webhook-Secret': WEBHOOK_SECRET },
      },
      (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => (res.statusCode === 200 ? resolve(data.trim()) : resolve(null)));
      }
    );
    req.on('error', reject);
    req.setTimeout(12_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Phone number → country-code + national-number splitter
// ══════════════════════════════════════════════════════════════════════════════

// Ordered most-specific first (longer prefixes before shorter)
const CC_PREFIXES = [
  // Caribbean / NANP special codes (must come before single-digit "1")
  '1242','1246','1264','1268','1284','1340','1345','1441','1473',
  '1649','1664','1670','1671','1684','1721','1758','1767','1784',
  '1787','1809','1829','1849','1868','1869','1876','1939',
  // Africa
  '20','27','212','213','216','218','220','221','222','223','224',
  '225','226','227','228','229','230','231','232','233','234','235',
  '236','237','238','239','240','241','242','243','244','245','246',
  '247','248','249','250','251','252','253','254','255','256','257',
  '258','260','261','262','263','264','265','266','267','268','269',
  '290','291',
  // Europe
  '30','31','32','33','34','350','351','352','353','354','355','356',
  '357','358','359','36','370','371','372','373','374','375','376',
  '377','378','380','381','382','383','385','386','387','389','39',
  '40','41','420','421','423','43','44','45','46','47','48','49',
  // Asia-Pacific
  '51','52','53','54','55','56','57','58',
  '60','61','62','63','64','65','66',
  '81','82','84','855','856','86','880','886',
  '90','91','92','93','94','95','960','961','962','963','964','965',
  '966','967','968','970','971','972','973','974','975','976','977',
  '98','992','993','994','995','996','998',
  // Americas
  '1',   // US/CA — must come after 4-digit NANP above
  '500','501','502','503','504','505','506','507','508','509',
  '590','591','592','593','594','595','596','597','598','599',
  // Russia / CIS
  '7',
];

function splitPhoneNumber(raw) {
  for (const prefix of CC_PREFIXES) {
    if (raw.startsWith(prefix)) {
      return { cc: prefix, national: raw.slice(prefix.length) };
    }
  }
  // Fallback: assume 1-digit CC
  log(`[PHONE] WARNING: unrecognised CC in "${raw}" — treating first digit as CC`);
  return { cc: raw[0], national: raw.slice(1) };
}

// ══════════════════════════════════════════════════════════════════════════════
// Emulator setup helpers
// ══════════════════════════════════════════════════════════════════════════════

async function waitForBoot() {
  log('[BOOT] Waiting for emulator to fully boot...');
  screen('Waiting for emulator boot');
  const deadline = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < deadline) {
    const v = adb('getprop sys.boot_completed', { silent: true });
    if (v === '1') { log('[BOOT] ✓ Boot complete'); return; }
    await sleep(3_000);
  }
  throw new Error('Emulator did not boot within timeout');
}

function setupDevice() {
  log('[SETUP] Configuring device...');
  screen('Configuring emulator');

  // Wake + dismiss lock screen
  adb('input keyevent KEYCODE_WAKEUP');
  adb('wm dismiss-keyguard');
  adb('input keyevent KEYCODE_MENU');

  // Disable animations for speed
  adb('settings put global window_animation_scale 0.0');
  adb('settings put global transition_animation_scale 0.0');
  adb('settings put global animator_duration_scale 0.0');

  // Keep screen on
  adb('settings put global stay_on_while_plugged_in 3');

  // Disable auto-update
  adb('settings put global auto_time 0');
  adb('settings put global auto_time_zone 0');

  // Silence unnecessary system notifications
  adb('cmd notification post -t "Setup" wa_setup 99 "Emulator ready"', { silent: true });

  log('[SETUP] ✓ Device configured');
}

async function installWA() {
  log('[APK] Installing WhatsApp...');
  screen('Installing WhatsApp APK');

  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`APK not found at ${APK_PATH}`);
  }

  const result = execSync(`adb install -r -t "${APK_PATH}"`, {
    timeout:  INSTALL_TIMEOUT,
    encoding: 'utf8',
    stdio:    ['pipe', 'pipe', 'pipe'],
  });
  log(`[APK] ${result.trim()}`);

  if (!result.includes('Success')) {
    throw new Error(`APK install failed: ${result.trim()}`);
  }
  log('[APK] ✓ WhatsApp installed');
}

/**
 * Grant every dangerous permission upfront so WA never shows a system popup
 * mid-flow.  Individual failures are silently swallowed.
 */
function grantPermissions() {
  const PERMS = [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.READ_PHONE_NUMBERS',
    'android.permission.CALL_PHONE',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_SMS',
    'android.permission.SEND_SMS',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_MMS',
  ];
  for (const p of PERMS) {
    adb(`pm grant ${WA_PKG} ${p}`, { silent: true });
  }
  log('[PERMS] ✓ Permissions granted');
}

function launchWA() {
  log('[LAUNCH] Starting WhatsApp...');
  screen('Launching WhatsApp');
  adb(`monkey -p ${WA_PKG} -c android.intent.category.LAUNCHER 1`, { silent: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// Screen detection
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Map the current UIAutomator XML snapshot to a named screen state.
 * Checks are ordered from most to least specific.
 */
function detectScreen(nodes) {
  const ids   = nodes.map(n => n.resourceId);
  const texts = nodes.map(n => n.text.toLowerCase());
  const descs = nodes.map(n => n.contentDesc.toLowerCase());

  const hasId   = (s) => ids.some(id => id.includes(s));
  const hasText = (s) => texts.some(t => t.includes(s));
  const hasDesc = (s) => descs.some(d => d.includes(s));

  // ── Terminal / fatal screens ──────────────────────────────────────────────
  if (hasText('your account has been banned') ||
      hasText('your phone number is banned') ||
      hasText('account banned') ||
      hasDesc('account banned'))                         return 'BANNED';

  if (hasText('temporarily banned') ||
      (hasText('banned') && hasText('temporary')))       return 'RESTRICTED_BANNED';

  if (hasText('invalid phone number') ||
      hasText('enter a valid phone number') ||
      hasText('phone number is not valid') ||
      hasText('this phone number format is not recognized')) return 'BAD_NUMBER';

  if (hasText('too many attempts') ||
      hasText('you have guessed the code wrong too many') ||
      (hasText('try again') && (hasText('minute') || hasText('hour') || hasText('second')))) return 'RATE_LIMITED';

  // ── Success / logged-in screens ───────────────────────────────────────────
  if (hasId('home_tab_layout') || hasId('conversations_row') ||
      hasId('conversations_fragment') || hasId('fab_icon') ||
      (hasText('chats') && hasText('calls')) ||
      (hasText('chats') && hasText('status')))           return 'MAIN_SCREEN';

  if (hasId('profile_info_ok_btn') || hasId('profile_info_edit_text') ||
      hasText('profile info') || hasText('add your name') ||
      (hasText('your name') && !hasText('phone number'))) return 'PROFILE_SETUP';

  // ── Registration flow ─────────────────────────────────────────────────────
  if (hasId('agree_btn') ||
      hasText('agree and continue') ||
      hasText('terms of service'))                       return 'WELCOME';

  if (hasId('registration_phone') || hasId('registration_cc') ||
      hasText('enter your phone number') ||
      hasText('enter your phone') ||
      (hasText('phone number') && !hasText('wrong') && !hasText('banned') && !hasText('already')))
                                                         return 'PHONE_ENTRY';

  // ── Already registered ────────────────────────────────────────────────────
  if (hasText('already registered') ||
      hasText('already have an account') ||
      hasText('phone number is already registered') ||
      hasText('this number is registered'))              return 'ALREADY_REGISTERED';

  // ── SMS confirm dialog ────────────────────────────────────────────────────
  if ((hasText('we will send') || hasText('we\'ll send')) &&
      (hasText('sms') || hasText('text') || hasText('code'))) return 'SMS_CONFIRM';
  if (hasText('is this the right phone number'))         return 'SMS_CONFIRM';
  if (hasText('is this ok?'))                            return 'SMS_CONFIRM';

  // ── OTP / verification ────────────────────────────────────────────────────
  if (hasId('verify_sms_edittext') || hasId('verify_codeEditText') ||
      hasId('otp_input') || hasId('enter_code_input'))   return 'OTP_ENTRY';
  if (hasText('waiting for sms') ||
      hasText('enter the 6-digit') || hasText('enter the 6 digit') ||
      hasText('sent an sms') || hasText('enter code') ||
      hasText('verification code'))                      return 'OTP_ENTRY';

  // ── OTP errors ────────────────────────────────────────────────────────────
  if (hasText('wrong code') || hasText('incorrect code') ||
      hasText('code is incorrect') || hasText('code was incorrect') ||
      hasText('the code you entered is wrong'))          return 'OTP_ERROR';

  // ── Resend options ────────────────────────────────────────────────────────
  if (hasText("didn't receive") || hasText('resend sms') ||
      hasText('call me') || hasText('send sms again'))   return 'RESEND_OPTIONS';

  // ── Restriction (not full ban) ────────────────────────────────────────────
  if (hasText('restricted') || hasText('restriction'))   return 'RESTRICTED';

  // ── Post-registration skippable screens ───────────────────────────────────
  if (hasText('back up your chats') || hasText('back up to google drive'))
                                                         return 'BACKUP_SCREEN';
  if (hasText('stay notified') || hasText('turn on notifications') ||
      hasText('allow whatsapp to send'))                 return 'NOTIFICATIONS_PROMPT';
  if (hasText('allow') && (hasText('contacts') || hasText('storage') ||
      hasText('phone') || hasText('media')))             return 'PERMISSION_DIALOG';

  // ── Android system permission dialogs ─────────────────────────────────────
  if (hasId('com.android.permissioncontroller') ||
      (hasText('allow') && hasDesc('allow')))            return 'SYS_PERMISSION';

  return 'UNKNOWN';
}

// ══════════════════════════════════════════════════════════════════════════════
// Wait for a specific screen state (with timeout)
// ══════════════════════════════════════════════════════════════════════════════

async function waitForScreen(want, timeoutMs = UI_WAIT_TIMEOUT) {
  if (typeof want === 'string') want = [want];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const xml   = dumpUI();
    const nodes = parseNodes(xml);
    const s     = detectScreen(nodes);
    if (want.includes(s)) {
      log(`[WAIT] ✓ Screen: ${s}`);
      return { screen: s, nodes, xml };
    }
    log(`[WAIT] Current: ${s}  |  Expecting: ${want.join(' | ')}`);
    await sleep(2_000);
  }
  throw new Error(`Timeout (${timeoutMs}ms) waiting for screen: ${want.join(' | ')}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// Parse rate-limit / restriction durations from on-screen text
// ══════════════════════════════════════════════════════════════════════════════

function parseSeconds(nodes) {
  for (const n of nodes) {
    const t = n.text.toLowerCase();

    // "Try again in 10 minutes" / "in 2 hours" / "in 30 seconds"
    const m1 = t.match(/in\s+(\d+)\s*(second|minute|hour|day)/);
    if (m1) {
      const v = parseInt(m1[1], 10);
      const u = m1[2];
      if (u.startsWith('day'))    return v * 86_400;
      if (u.startsWith('hour'))   return v * 3_600;
      if (u.startsWith('minute')) return v * 60;
      return v;
    }
    // "Try again after MM:SS"
    const m2 = t.match(/after\s+(\d{1,2}):(\d{2})/);
    if (m2) return parseInt(m2[1], 10) * 60 + parseInt(m2[2], 10);

    // "Try again after HH:MM:SS"
    const m3 = t.match(/after\s+(\d{1,2}):(\d{2}):(\d{2})/);
    if (m3) return parseInt(m3[1], 10) * 3600 + parseInt(m3[2], 10) * 60 + parseInt(m3[3], 10);
  }
  return 600; // default 10 min
}

// ══════════════════════════════════════════════════════════════════════════════
// Generic dialog dismisser
// ══════════════════════════════════════════════════════════════════════════════

function dismissDialog(nodes) {
  const ALLOW_TEXTS = ['allow', 'while using the app', 'only this time', 'ok', 'got it', 'continue'];
  for (const t of ALLOW_TEXTS) {
    const btn = find(nodes, { text: t, clickable: true })
             || find(nodes, { cls: 'android.widget.Button' });
    if (btn) {
      log(`[DIALOG] Tapping "${btn.text || t}"`);
      tap(btn);
      return true;
    }
  }
  // System dialog: android:id/button1 = positive button
  const sysBtn = find(nodes, { resId: 'android:id/button1' });
  if (sysBtn) { tap(sysBtn); return true; }
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// Phone number entry helpers
// ══════════════════════════════════════════════════════════════════════════════

async function enterPhoneNumber(nodes, cc, national) {
  screen('Entering phone number', `+${cc} ${national}`);

  // ── Country code field ──────────────────────────────────────────────────
  const ccField = find(nodes, { resId: 'registration_cc' });
  if (ccField) {
    log(`[PHONE] Setting CC field to: ${cc}`);
    clearAndFocus(ccField);
    await sleep(400);
    type(cc);
    await sleep(POST_TYPE_DELAY);
    // Close any suggestion keyboard
    adb('input keyevent KEYCODE_BACK', { silent: true });
    await sleep(300);
  }

  // ── National number field ───────────────────────────────────────────────
  // Re-dump after CC entry so bounds are fresh
  const xml2   = dumpUI();
  const nodes2 = parseNodes(xml2);

  const phoneField = find(nodes2, { resId: 'registration_phone' })
                  || find(nodes2, { resId: 'phone_number' });

  if (phoneField) {
    log(`[PHONE] Entering national number: ${national}`);
    clearAndFocus(phoneField);
    await sleep(400);
    type(national);
    await sleep(POST_TYPE_DELAY);
  } else if (!ccField) {
    // Fallback: no resource-id match — use first EditText on screen
    log('[PHONE] Fallback: using first EditText');
    const et = find(nodes2, { cls: 'android.widget.EditText' });
    if (et) {
      clearAndFocus(et);
      await sleep(400);
      type(PHONE_NUMBER);  // Full number as last resort
      await sleep(POST_TYPE_DELAY);
    } else {
      log('[PHONE] WARNING: no input field found on phone entry screen!');
    }
  }

  // ── Tap Next ────────────────────────────────────────────────────────────
  await sleep(600);
  const xml3   = dumpUI();
  const nodes3 = parseNodes(xml3);

  const nextBtn = find(nodes3, { resId: 'registration_submit' })
               || find(nodes3, { textExact: 'Next' })
               || find(nodes3, { text: 'next', cls: 'android.widget.Button' })
               || find(nodes3, { desc: 'next' });

  if (nextBtn) {
    log('[PHONE] Tapping Next');
    screen('Tapping: Next');
    tap(nextBtn);
  } else {
    log('[PHONE] Next button not found — pressing Enter');
    pressEnter();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Main registration state machine
// ══════════════════════════════════════════════════════════════════════════════

async function run() {
  log('═══════════════════════════════════════════════════════════════════');
  log(`  wa_register.js  —  WhatsApp Registration`);
  log(`  Phone   : ${PHONE_NUMBER}`);
  log(`  Run ID  : ${RUN_ID}`);
  log(`  Webhook : ${WEBHOOK_URL}`);
  log('═══════════════════════════════════════════════════════════════════');

  if (!PHONE_NUMBER)     throw new Error('PHONE_NUMBER env var is required');
  if (!WEBHOOK_URL)      throw new Error('WEBHOOK_URL env var is required');
  if (!WEBHOOK_SECRET)   throw new Error('WEBHOOK_SECRET env var is required');
  if (!TELEGRAM_USER_ID) throw new Error('TELEGRAM_USER_ID env var is required');

  const { cc, national } = splitPhoneNumber(PHONE_NUMBER);
  log(`[PHONE] CC=+${cc}  National=${national}`);

  // ── Phase 1: Device setup ─────────────────────────────────────────────────
  await waitForBoot();
  await sleep(3_000);
  setupDevice();
  await sleep(2_000);

  // ── Phase 2: Install WhatsApp ─────────────────────────────────────────────
  await installWA();
  await sleep(2_000);
  grantPermissions();
  await sleep(1_000);

  // ── Phase 3: Launch ───────────────────────────────────────────────────────
  launchWA();
  await sleep(4_000);  // let splash finish

  // ── Phase 4: Registration state machine ───────────────────────────────────
  let otpRequested  = false;
  let otpAttempts   = 0;
  const MAX_STEPS   = 80;
  const MAX_OTP_TRY = 3;

  for (let step = 0; step < MAX_STEPS; step++) {
    await sleep(STEP_DELAY);

    // Dump UI
    const xml   = dumpUI();
    const nodes = parseNodes(xml);
    const screen_state = detectScreen(nodes);

    log(`[STEP ${step.toString().padStart(2)}] ▶  ${screen_state}`);
    screen(`Step ${step}`, screen_state);

    // ── WELCOME ─────────────────────────────────────────────────────────────
    if (screen_state === 'WELCOME') {
      const agreeBtn = find(nodes, { resId: 'agree_btn' })
                    || find(nodes, { text: 'agree and continue' })
                    || find(nodes, { text: 'accept and continue' })
                    || find(nodes, { text: 'agree' });
      if (agreeBtn) {
        log('[WELCOME] Tapping Agree and continue');
        screen('Tapping: Agree and continue');
        tap(agreeBtn);
        await sleep(2_500);
      } else {
        log('[WELCOME] Agree button not found — pressing Enter');
        pressEnter();
        await sleep(2_000);
      }
      continue;
    }

    // ── PHONE_ENTRY ──────────────────────────────────────────────────────────
    if (screen_state === 'PHONE_ENTRY') {
      await enterPhoneNumber(nodes, cc, national);
      await sleep(3_000);
      continue;
    }

    // ── SMS_CONFIRM ──────────────────────────────────────────────────────────
    if (screen_state === 'SMS_CONFIRM') {
      log('[SMS_CONFIRM] Confirming number for SMS OTP');
      screen('Confirming SMS send', `+${PHONE_NUMBER}`);

      // The positive button is usually the rightmost / last Button on screen
      const okBtn = find(nodes, { textExact: 'OK' })
                 || find(nodes, { textExact: 'Yes' })
                 || find(nodes, { text: 'ok', cls: 'android.widget.Button' })
                 || find(nodes, { text: 'yes', cls: 'android.widget.Button' })
                 || find(nodes, { text: 'send sms' })
                 || find(nodes, { text: 'confirm' })
                 || find(nodes, { resId: 'ok_btn' })
                 || find(nodes, { resId: 'android:id/button1' });

      if (okBtn) {
        tap(okBtn);
      } else {
        // Last resort: tap rightmost clickable button
        const btns = findAll(nodes, { cls: 'android.widget.Button', clickable: true });
        if (btns.length) tap(btns[btns.length - 1]);
        else pressEnter();
      }
      await sleep(3_000);
      continue;
    }

    // ── OTP_ENTRY ────────────────────────────────────────────────────────────
    if (screen_state === 'OTP_ENTRY') {
      if (otpAttempts >= MAX_OTP_TRY) {
        log('[OTP] Max OTP attempts reached — aborting');
        screen('Max OTP attempts — aborting');
        await sendWebhook('bad_number', { reason: `Maximum OTP attempts (${MAX_OTP_TRY}) exceeded` });
        process.exit(1);
      }

      // Notify bot on first OTP screen visit
      if (!otpRequested) {
        otpRequested = true;
        log('[OTP] Notifying bot: otp_requested');
        screen('Notifying bot: OTP requested');
        await sendWebhook('otp_requested');
      }

      // Poll for the OTP code from Telegram
      const otp = await pollForOTP();
      if (!otp) {
        log('[OTP] No OTP received in time — aborting');
        screen('OTP timeout — aborting');
        await sendWebhook('bad_number', { reason: 'OTP timeout — user did not supply code within 14 minutes' });
        process.exit(1);
      }

      otpAttempts++;
      log(`[OTP] Entering code (attempt ${otpAttempts}): ${otp}`);
      screen(`Entering OTP (attempt ${otpAttempts})`, otp);

      // Find the OTP input field
      const otpField = find(nodes, { resId: 'verify_sms_edittext' })
                    || find(nodes, { resId: 'verify_codeEditText' })
                    || find(nodes, { resId: 'otp_input' })
                    || find(nodes, { resId: 'enter_code_input' })
                    || find(nodes, { cls: 'android.widget.EditText' });

      if (otpField) {
        clearAndFocus(otpField);
        await sleep(400);
        type(otp);
      } else {
        // WA sometimes auto-focuses the OTP field — try typing blindly
        log('[OTP] No OTP field found — typing directly');
        type(otp);
      }

      await sleep(2_000);

      // Tap Next / Done if visible after typing
      const xml2   = dumpUI();
      const nodes2 = parseNodes(xml2);
      const nxtBtn = find(nodes2, { textExact: 'Next' })
                  || find(nodes2, { textExact: 'Done' })
                  || find(nodes2, { resId: 'next_btn' });
      if (nxtBtn) {
        tap(nxtBtn);
        await sleep(3_000);
      }
      continue;
    }

    // ── OTP_ERROR ────────────────────────────────────────────────────────────
    if (screen_state === 'OTP_ERROR') {
      log('[OTP_ERROR] Wrong OTP — notifying bot');
      screen('Wrong OTP — notifying bot');
      await sendWebhook('otp_error');
      // Reset so the next loop iteration re-polls for a fresh OTP
      otpRequested = false;
      await sleep(2_000);

      const retryBtn = find(nodes, { text: 'try again' })
                    || find(nodes, { text: 'retry' })
                    || find(nodes, { textExact: 'OK' });
      if (retryBtn) tap(retryBtn);
      await sleep(2_000);
      continue;
    }

    // ── RESEND_OPTIONS ────────────────────────────────────────────────────────
    if (screen_state === 'RESEND_OPTIONS') {
      // Don't immediately request resend — the user might still have the code.
      // Just wait and let the next OTP_ENTRY iteration handle it.
      log('[RESEND] Resend options visible — continuing to wait for OTP');
      screen('Resend options visible — awaiting user OTP');
      await sleep(5_000);
      continue;
    }

    // ── RATE_LIMITED ──────────────────────────────────────────────────────────
    if (screen_state === 'RATE_LIMITED') {
      const waitSec = parseSeconds(nodes);
      log(`[RATE_LIMIT] Wait ${waitSec}s`);
      screen('Rate limited', `retry in ${waitSec}s`);
      await sendWebhook('rate_limited', { wait_seconds: waitSec });
      process.exit(0);
    }

    // ── BAD_NUMBER ────────────────────────────────────────────────────────────
    if (screen_state === 'BAD_NUMBER') {
      log('[BAD_NUMBER] WhatsApp rejected the number');
      screen('Bad number detected');
      await sendWebhook('bad_number', { reason: 'WhatsApp rejected the phone number as invalid' });
      process.exit(0);
    }

    // ── ALREADY_REGISTERED ────────────────────────────────────────────────────
    if (screen_state === 'ALREADY_REGISTERED') {
      log('[ALREADY_REGISTERED] Number already has a WhatsApp account');
      screen('Already registered');
      await sendWebhook('already_registered');
      process.exit(0);
    }

    // ── BANNED ────────────────────────────────────────────────────────────────
    if (screen_state === 'BANNED') {
      log('[BANNED] Account permanently banned');
      screen('Account banned');
      await sendWebhook('banned');
      process.exit(0);
    }

    // ── RESTRICTED / RESTRICTED_BANNED ───────────────────────────────────────
    if (screen_state === 'RESTRICTED' || screen_state === 'RESTRICTED_BANNED') {
      const sec = parseSeconds(nodes);
      log(`[RESTRICTED] ${sec}s remaining`);
      screen('Account restricted', `${sec}s remaining`);
      await sendWebhook('restricted', { seconds_remaining: sec });
      process.exit(0);
    }

    // ── PROFILE_SETUP ─────────────────────────────────────────────────────────
    // Reaching here means OTP was accepted — registration succeeded!
    if (screen_state === 'PROFILE_SETUP') {
      log('[PROFILE] Registration succeeded — filling profile');
      screen('Registration complete!', 'Filling profile name');

      const nameField = find(nodes, { resId: 'profile_info_edit_text' })
                     || find(nodes, { cls: 'android.widget.EditText' });
      if (nameField) {
        clearAndFocus(nameField);
        await sleep(400);
        type('User');
        await sleep(POST_TYPE_DELAY);
      }

      const doneBtn = find(nodes, { resId: 'profile_info_ok_btn' })
                   || find(nodes, { textExact: 'Next' })
                   || find(nodes, { textExact: 'Done' })
                   || find(nodes, { text: 'next', cls: 'android.widget.Button' });
      if (doneBtn) {
        tap(doneBtn);
        await sleep(2_500);
      }

      await sendWebhook('registered');
      log('[END] ✓ Registration flow complete');
      screen('✓ Registration complete!');
      process.exit(0);
    }

    // ── MAIN_SCREEN ───────────────────────────────────────────────────────────
    if (screen_state === 'MAIN_SCREEN') {
      log('[MAIN] Already on main chat screen — registration complete');
      screen('✓ Already logged in — complete');
      await sendWebhook('registered');
      process.exit(0);
    }

    // ── BACKUP_SCREEN ─────────────────────────────────────────────────────────
    if (screen_state === 'BACKUP_SCREEN') {
      log('[BACKUP] Skipping backup screen');
      screen('Skipping: Backup screen');
      const skipBtn = find(nodes, { text: 'not now' })
                   || find(nodes, { text: 'skip' })
                   || find(nodes, { text: 'later' })
                   || find(nodes, { text: 'maybe later' });
      if (skipBtn) tap(skipBtn);
      else pressBack();
      await sleep(2_000);
      continue;
    }

    // ── NOTIFICATIONS_PROMPT ──────────────────────────────────────────────────
    if (screen_state === 'NOTIFICATIONS_PROMPT') {
      log('[NOTIF] Dismissing notifications prompt');
      screen('Dismissing: Notifications prompt');
      const btn = find(nodes, { text: 'continue' })
               || find(nodes, { text: 'turn on' })
               || find(nodes, { textExact: 'OK' })
               || find(nodes, { text: 'not now' });
      if (btn) tap(btn);
      await sleep(2_000);
      continue;
    }

    // ── PERMISSION_DIALOG / SYS_PERMISSION ────────────────────────────────────
    if (screen_state === 'PERMISSION_DIALOG' || screen_state === 'SYS_PERMISSION') {
      log(`[PERM] Granting permission dialog`);
      screen('Granting permission dialog');
      const allowed = dismissDialog(nodes);
      if (!allowed) pressBack();
      await sleep(1_500);
      continue;
    }

    // ── UNKNOWN ───────────────────────────────────────────────────────────────
    {
      log(`[UNKNOWN] Step ${step} — probing screen`);

      // First try to dismiss any lingering dialog
      const dismissed = dismissDialog(nodes);
      if (dismissed) { await sleep(1_500); continue; }

      // Check if WhatsApp is still in the foreground
      const focus = adb('dumpsys window windows | grep -E "mCurrentFocus|mFocusedWindow" | head -1', { silent: true });
      const waInFront = focus.includes(WA_PKG);
      log(`[UNKNOWN] Focus: ${focus.trim()}`);

      if (!waInFront) {
        log('[UNKNOWN] WA left foreground — relaunching');
        launchWA();
        await sleep(4_000);
        continue;
      }

      // If stuck on the same unknown screen, press back every 4 unknown steps
      if (step % 4 === 0 && step > 0) {
        log('[UNKNOWN] Pressing BACK to try to recover');
        pressBack();
        await sleep(1_500);
      }
    }
  }

  // Reached max steps without a terminal event
  log('[END] Max steps reached without completion — treating as bad number');
  screen('Max steps reached — aborting');
  await sendWebhook('bad_number', { reason: 'Registration flow did not complete within max steps' });
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════════
// Entry point
// ══════════════════════════════════════════════════════════════════════════════

run().catch(async (err) => {
  log(`[FATAL] ${err.stack || err.message}`);
  screen('FATAL error — aborting');
  try {
    await sendWebhook('bad_number', { reason: `Script fatal error: ${err.message}` });
  } catch (_) {}
  process.exit(1);
});
