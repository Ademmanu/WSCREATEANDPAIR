/**
 * wa_register.js — WhatsApp registration automation via ADB + UIAutomator XML parsing
 * 
 * Enhanced with comprehensive UI element analysis:
 * - Identifies clickable, editable, scrollable elements
 * - Structured element logging with properties
 * - Helper functions for element filtering
 * - Improved debugging and reliability
 *
 * Runs inside GitHub Actions after the Android emulator boots.
 * Installs WhatsApp, navigates the registration flow, requests OTP,
 * waits for the user to reply on Telegram, submits the OTP, and
 * reports the result back to the bot via webhook.
 *
 * Required env vars:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL,
 *   WEBHOOK_SECRET, GITHUB_RUN_ID
 */

'use strict';

const { execSync }  = require('child_process');
const https         = require('https');
const http          = require('http');
const fs            = require('fs');
const path          = require('path');
const { parsePhoneNumber, isValidPhoneNumber } = require('libphonenumber-js');

// ── Config ────────────────────────────────────────────────────────────────────

const PHONE          = process.env.PHONE_NUMBER;
const USER_ID        = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID         = process.env.GITHUB_RUN_ID;
const RENDER_BASE    = WEBHOOK_URL.replace('/webhook/event', '');
const WA_PACKAGE     = 'com.whatsapp';
const APK_PATH       = '/tmp/whatsapp.apk';
const SCRIPT_DIR     = '/tmp/wa_scripts';
const UI_XML_PATH    = '/sdcard/view.xml';

// Enable detailed UI element logging
const DEBUG_UI_ELEMENTS = process.env.DEBUG_UI_ELEMENTS === 'true' || true;

// ── Phone number parsing ──────────────────────────────────────────────────────

/**
 * Parse a full international number like "2348012345678" into:
 *   { countryCode: '234', nationalNumber: '8012345678', country: 'NG' }
 */
function parsePhone(fullNumber) {
  const withPlus = `+${fullNumber}`;
  try {
    if (isValidPhoneNumber(withPlus)) {
      const parsed = parsePhoneNumber(withPlus);
      return {
        countryCode: String(parsed.countryCallingCode),
        nationalNumber: parsed.nationalNumber,
        country: parsed.country || 'unknown',
      };
    }
  } catch (_) {}

  // Fallback: try common country code lengths
  const cc3 = fullNumber.substring(0, 3);
  const cc2 = fullNumber.substring(0, 2);
  const cc1 = fullNumber.substring(0, 1);

  for (const cc of [cc3, cc2, cc1]) {
    try {
      const national = fullNumber.substring(cc.length);
      const attempt = `+${cc}${national}`;
      if (isValidPhoneNumber(attempt)) {
        const parsed = parsePhoneNumber(attempt);
        return {
          countryCode: String(parsed.countryCallingCode),
          nationalNumber: parsed.nationalNumber,
          country: parsed.country || 'unknown',
        };
      }
    } catch (_) {}
  }

  // Last resort
  return {
    countryCode: fullNumber.substring(0, 3),
    nationalNumber: fullNumber.substring(3),
    country: 'unknown',
  };
}

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function log(tag, msg) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function runScript(scriptContent, timeoutMs = 30000) {
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  const file = path.join(SCRIPT_DIR, `cmd_${Date.now()}.sh`);
  fs.writeFileSync(file, `#!/bin/sh\n${scriptContent}\n`, { mode: 0o755 });
  try {
    const out = execSync(`sh ${file}`, {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (out || '').trim();
  } catch (e) {
    return ((e.stdout || '') + (e.stderr || '')).trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

function adb(args, timeoutMs = 30000) {
  return runScript(`adb ${args} 2>&1`, timeoutMs);
}

function adbShell(cmd, timeoutMs = 30000) {
  const file = path.join(SCRIPT_DIR, `shell_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = runScript(`adb shell < ${file}`, timeoutMs);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

// ── ADB input helpers ─────────────────────────────────────────────────────────

function tap(x, y) {
  log('TAP', `(${x}, ${y})`);
  adbShell(`input tap ${x} ${y}`);
}

function swipe(x1, y1, x2, y2, durationMs = 300) {
  adbShell(`input swipe ${x1} ${y1} ${x2} ${y2} ${durationMs}`);
}

function keyevent(code) {
  adbShell(`input keyevent ${code}`);
}

function typeText(text) {
  const safe = text.replace(/[^a-zA-Z0-9+]/g, (c) => {
    return encodeURIComponent(c).replace(/%/g, '%25');
  });
  adbShell(`input text "${safe}"`);
}

function typeDigits(digits) {
  for (const d of digits) {
    adbShell(`input text ${d}`);
    runScript('sleep 0.15');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// UI Element Analysis System
// ══════════════════════════════════════════════════════════════════════════════

/**
 * UIElement - Represents a parsed UI element from UIAutomator XML
 */
class UIElement {
  constructor(attributes) {
    this.text = attributes.text || '';
    this.resourceId = attributes['resource-id'] || '';
    this.className = attributes.class || '';
    this.contentDesc = attributes['content-desc'] || '';
    this.package = attributes.package || '';
    
    // Boolean properties
    this.clickable = attributes.clickable === 'true';
    this.editable = this.className.includes('EditText');
    this.checkable = attributes.checkable === 'true';
    this.checked = attributes.checked === 'true';
    this.enabled = attributes.enabled === 'true';
    this.focusable = attributes.focusable === 'true';
    this.focused = attributes.focused === 'true';
    this.scrollable = attributes.scrollable === 'true';
    this.longClickable = attributes['long-clickable'] === 'true';
    this.password = attributes.password === 'true';
    this.selected = attributes.selected === 'true';
    
    // Bounds parsing: bounds="[x1,y1][x2,y2]"
    this.bounds = this._parseBounds(attributes.bounds);
    this.center = this._calculateCenter();
    
    // Index in hierarchy
    this.index = attributes.index ? parseInt(attributes.index) : -1;
  }
  
  _parseBounds(boundsStr) {
    if (!boundsStr) return null;
    const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (match) {
      return {
        x1: parseInt(match[1]),
        y1: parseInt(match[2]),
        x2: parseInt(match[3]),
        y2: parseInt(match[4])
      };
    }
    return null;
  }
  
  _calculateCenter() {
    if (!this.bounds) return null;
    return {
      x: Math.round((this.bounds.x1 + this.bounds.x2) / 2),
      y: Math.round((this.bounds.y1 + this.bounds.y2) / 2)
    };
  }
  
  /**
   * Get a display label for this element (for logging)
   */
  getLabel() {
    if (this.text) return this.text;
    if (this.contentDesc) return this.contentDesc;
    if (this.resourceId) {
      const parts = this.resourceId.split('/');
      return parts[parts.length - 1] || this.resourceId;
    }
    return this.className.split('.').pop() || 'Unknown';
  }
  
  /**
   * Check if this element matches a search string
   */
  matches(searchText) {
    const search = searchText.toLowerCase();
    return (
      this.text.toLowerCase().includes(search) ||
      this.contentDesc.toLowerCase().includes(search) ||
      this.resourceId.toLowerCase().includes(search)
    );
  }
  
  /**
   * Format element as a structured string for logging
   */
  toString() {
    const lines = [];
    lines.push(`Element: ${this.getLabel()}`);
    lines.push(`  Class: ${this.className}`);
    if (this.resourceId) lines.push(`  Resource ID: ${this.resourceId}`);
    if (this.contentDesc) lines.push(`  Content Desc: ${this.contentDesc}`);
    lines.push(`  Clickable: ${this.clickable}`);
    lines.push(`  Editable: ${this.editable}`);
    lines.push(`  Enabled: ${this.enabled}`);
    if (this.scrollable) lines.push(`  Scrollable: ${this.scrollable}`);
    if (this.focusable) lines.push(`  Focusable: ${this.focusable}`);
    if (this.bounds) {
      lines.push(`  Bounds: [${this.bounds.x1},${this.bounds.y1}][${this.bounds.x2},${this.bounds.y2}]`);
      if (this.center) {
        lines.push(`  Center: (${this.center.x}, ${this.center.y})`);
      }
    }
    return lines.join('\n');
  }
}

/**
 * UIScreen - Represents the current screen state with all elements
 */
class UIScreen {
  constructor(xml) {
    this.xml = xml;
    this.elements = [];
    this._parseElements();
  }
  
  _parseElements() {
    // Match all <node> elements with their attributes
    const nodeRegex = /<node([^>]*)\/?>|<node([^>]*)>[\s\S]*?<\/node>/g;
    let match;
    
    while ((match = nodeRegex.exec(this.xml)) !== null) {
      const attributesStr = match[1] || match[2];
      if (!attributesStr) continue;
      
      const attributes = this._parseAttributes(attributesStr);
      const element = new UIElement(attributes);
      
      // Only add elements with bounds (visible elements)
      if (element.bounds) {
        this.elements.push(element);
      }
    }
  }
  
  _parseAttributes(attrStr) {
    const attributes = {};
    // Match attribute="value" pairs
    const attrRegex = /(\S+)="([^"]*)"/g;
    let match;
    
    while ((match = attrRegex.exec(attrStr)) !== null) {
      attributes[match[1]] = match[2];
    }
    
    return attributes;
  }
  
  /**
   * Get all clickable elements
   */
  getClickableElements() {
    return this.elements.filter(el => el.clickable && el.enabled);
  }
  
  /**
   * Get all editable fields (EditText elements)
   */
  getEditableFields() {
    return this.elements.filter(el => el.editable && el.enabled);
  }
  
  /**
   * Get all scrollable elements
   */
  getScrollableElements() {
    return this.elements.filter(el => el.scrollable);
  }
  
  /**
   * Get all buttons
   */
  getButtons() {
    return this.elements.filter(el => 
      el.className.includes('Button') && el.enabled
    );
  }
  
  /**
   * Get all text views
   */
  getTextViews() {
    return this.elements.filter(el => 
      el.className.includes('TextView') && el.text.length > 0
    );
  }
  
  /**
   * Find element by text (case-insensitive partial match)
   */
  findByText(text) {
    return this.elements.filter(el => el.matches(text));
  }
  
  /**
   * Find element by resource ID
   */
  findByResourceId(resourceId) {
    return this.elements.filter(el => el.resourceId.includes(resourceId));
  }
  
  /**
   * Find element by class name
   */
  findByClass(className) {
    return this.elements.filter(el => el.className.includes(className));
  }
  
  /**
   * Get all visible text on screen
   */
  getAllText() {
    return this.elements
      .filter(el => el.text.length > 0)
      .map(el => el.text);
  }
  
  /**
   * Log summary of screen elements
   */
  logSummary(label = 'SCREEN SUMMARY') {
    log(label, `Total elements: ${this.elements.length}`);
    log(label, `Clickable: ${this.getClickableElements().length}`);
    log(label, `Editable: ${this.getEditableFields().length}`);
    log(label, `Buttons: ${this.getButtons().length}`);
    log(label, `Scrollable: ${this.getScrollableElements().length}`);
  }
  
  /**
   * Log all clickable elements with details
   */
  logClickableElements() {
    const clickable = this.getClickableElements();
    log('UI_ANALYSIS', `Found ${clickable.length} clickable elements:`);
    clickable.forEach((el, idx) => {
      console.log(`\n[${idx + 1}/${clickable.length}]`);
      console.log(el.toString());
    });
  }
  
  /**
   * Log all editable fields with details
   */
  logEditableFields() {
    const editable = this.getEditableFields();
    log('UI_ANALYSIS', `Found ${editable.length} editable fields:`);
    editable.forEach((el, idx) => {
      console.log(`\n[${idx + 1}/${editable.length}]`);
      console.log(el.toString());
    });
  }
  
  /**
   * Log all elements (verbose debug mode)
   */
  logAllElements() {
    log('UI_ANALYSIS', `All ${this.elements.length} elements:`);
    this.elements.forEach((el, idx) => {
      console.log(`\n[${idx + 1}/${this.elements.length}]`);
      console.log(el.toString());
    });
  }
}

// ── UI inspection via UIAutomator XML parsing ─────────────────────────────────

/**
 * Dump UI hierarchy to XML using UIAutomator and return UIScreen object
 */
async function dumpUI(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    adbShell(`uiautomator dump ${UI_XML_PATH}`);
    await sleep(500);
    
    const pullResult = adb(`pull ${UI_XML_PATH} /tmp/ui_current.xml`);
    
    if (fs.existsSync('/tmp/ui_current.xml')) {
      const xml = fs.readFileSync('/tmp/ui_current.xml', 'utf8');
      if (xml && xml.includes('<hierarchy')) {
        return new UIScreen(xml);
      }
    }
    
    await sleep(1000);
  }
  log('WARN', 'Failed to dump valid UI XML');
  return null;
}

/**
 * Get visible text strings from current screen
 */
async function screenTexts() {
  const screen = await dumpUI();
  if (!screen) return [];
  return screen.getAllText().slice(0, 20);
}

/**
 * Log the current screen texts for debugging
 */
async function logScreen(label = 'SCREEN') {
  const texts = await screenTexts();
  log(label, texts.join(' | ') || '(empty)');
  return texts;
}

/**
 * Wait until the screen contains a specific string
 */
async function waitForScreen(text, timeoutMs = 60000) {
  log('WAIT', `Waiting for "${text}" (${timeoutMs / 1000}s timeout)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await dumpUI();
    if (screen) {
      const matches = screen.findByText(text);
      if (matches.length > 0) {
        log('FOUND', `"${text}"`);
        return screen;
      }
    }
    await sleep(2000);
  }
  log('TIMEOUT', `"${text}" not found`);
  return null;
}

/**
 * Wait for any one of multiple strings to appear on screen
 */
async function waitForAny(texts, timeoutMs = 60000) {
  log('WAIT', `Waiting for any of: ${texts.map(t => `"${t}"`).join(', ')} (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = await dumpUI();
    if (screen) {
      for (const text of texts) {
        const matches = screen.findByText(text);
        if (matches.length > 0) {
          log('FOUND', `"${text}"`);
          return { screen, matched: text };
        }
      }
    }
    await sleep(2000);
  }
  log('TIMEOUT', `None of [${texts.join(', ')}] found`);
  return { screen: null, matched: null };
}

/**
 * Find element by text and tap it using center coordinates
 */
async function tapElement(text, screen = null, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    if (!screen || attempt > 1) {
      screen = await dumpUI();
    }
    
    if (!screen) {
      log('TAP_ELEMENT', `Failed to dump UI for "${text}"`);
      continue;
    }
    
    const matches = screen.findByText(text);
    if (matches.length > 0) {
      const element = matches[0];
      if (element.center) {
        log('TAP_ELEMENT', `"${text}" → (${element.center.x}, ${element.center.y})`);
        tap(element.center.x, element.center.y);
        await sleep(800);
        
        // Log screen after tap
        await logScreen(`AFTER_TAP_${text.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`);
        
        return true;
      }
    }
    
    if (attempt < retries) {
      log('RETRY', `Element "${text}" not found, retry ${attempt}/${retries}`);
      await sleep(1500);
    }
  }
  
  log('TAP_ELEMENT', `"${text}" not found after ${retries} retries`);
  return false;
}

/**
 * Find an input field and fill it with value
 */
async function fillInputField(labelText, value, screen = null) {
  if (!screen) screen = await dumpUI();
  if (!screen) return false;
  
  const editFields = screen.getEditableFields();
  
  if (editFields.length > 0) {
    const field = editFields[0];
    if (field.center) {
      log('FILL_INPUT', `Tapping EditText at (${field.center.x}, ${field.center.y})`);
      tap(field.center.x, field.center.y);
      await sleep(500);
      
      // Clear the field
      for (let i = 0; i < 20; i++) {
        keyevent('KEYCODE_DEL');
      }
      await sleep(300);
      
      log('FILL_INPUT', `Entering: ${value}`);
      typeDigits(value);
      await sleep(500);
      
      // Log screen after filling
      await logScreen('AFTER_FILL_INPUT');
      
      return true;
    }
  }
  
  return false;
}

/**
 * Analyze and log screen elements in detail
 * This is called at key points for debugging
 */
async function analyzeScreen(label = 'UI_ANALYSIS') {
  log(label, 'Analyzing current screen...');
  const screen = await dumpUI();
  
  if (!screen) {
    log(label, 'Failed to dump UI');
    return null;
  }
  
  screen.logSummary(label);
  
  if (DEBUG_UI_ELEMENTS) {
    console.log('\n' + '='.repeat(80));
    console.log('CLICKABLE ELEMENTS');
    console.log('='.repeat(80));
    screen.logClickableElements();
    
    console.log('\n' + '='.repeat(80));
    console.log('EDITABLE FIELDS');
    console.log('='.repeat(80));
    screen.logEditableFields();
    
    console.log('\n' + '='.repeat(80));
  }
  
  return screen;
}

// ── Webhook ───────────────────────────────────────────────────────────────────

function webhook(event, extra = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      event,
      phone_number: PHONE,
      telegram_user_id: parseInt(USER_ID, 10),
      run_id: RUN_ID,
      ...extra,
    });
    const u = new URL(WEBHOOK_URL);
    const isHttps = u.protocol === 'https:';
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
    };
    const lib = isHttps ? https : http;
    const req = lib.request(options, (res) => {
      log('WEBHOOK', `${event} → HTTP ${res.statusCode}`);
      resolve(res.statusCode);
    });
    req.on('error', (e) => {
      log('WEBHOOK', `${event} ERROR: ${e.message}`);
      resolve(0);
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── OTP polling ───────────────────────────────────────────────────────────────

async function pollForOtp(timeoutMs = 13 * 60 * 1000) {
  const otpUrl = `${RENDER_BASE}/otp/${encodeURIComponent(PHONE)}`;
  const deadline = Date.now() + timeoutMs;
  log('OTP', `Polling ${otpUrl} for up to ${timeoutMs / 60000} min...`);
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const otp = await httpGet(otpUrl, { 'X-Webhook-Secret': WEBHOOK_SECRET });
      if (otp && /^\d{6}$/.test(otp)) {
        log('OTP', `Received: ${otp}`);
        return otp;
      }
    } catch (_) {}
  }
  log('OTP', 'Timed out waiting for user reply');
  return null;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const req = (isHttps ? https : http).request({
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve(res.statusCode === 200 ? data.trim() : null));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Parse WhatsApp wait time strings ─────────────────────────────────────────

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

// ── APK install ───────────────────────────────────────────────────────────────

async function installWhatsApp() {
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`APK not found at ${APK_PATH}`);
  }
  const sizeMB = (fs.statSync(APK_PATH).size / 1024 / 1024).toFixed(1);
  log('INSTALL', `APK size: ${sizeMB} MB`);

  const libScript = `unzip -l ${APK_PATH} | grep -E "^[[:space:]]+[0-9]" | awk '{print $4}' | grep "^lib/" | cut -d/ -f1-2 | sort -u`;
  fs.writeFileSync('/tmp/libcheck.sh', libScript);
  const libs = runScript('sh /tmp/libcheck.sh 2>/dev/null', 15000);
  log('INSTALL', `APK lib folders:\n${libs || '  (none — pure Java APK)'}`);

  await sleep(2000);

  log('INSTALL', 'Pushing APK to device...');
  const pushOut = runScript(`adb push ${APK_PATH} /data/local/tmp/whatsapp.apk 2>&1`, 600000);
  log('INSTALL', `Push output: ${pushOut}`);

  if (pushOut.toLowerCase().includes('error') && !pushOut.includes('pushed')) {
    log('INSTALL', 'Push failed — falling back to adb install...');
    const directOut = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
    log('INSTALL', `Direct install output: ${directOut}`);
    if (!directOut.toLowerCase().includes('success') && !directOut.includes('pushed')) {
      throw new Error(`Install failed: ${directOut}`);
    }
  } else {
    log('INSTALL', 'Installing from on-device copy...');
    const pmOut = runScript('adb shell pm install -r -t -g /data/local/tmp/whatsapp.apk 2>&1', 120000);
    log('INSTALL', `pm install output: ${pmOut}`);

    if (!pmOut.toLowerCase().includes('success')) {
      log('INSTALL', 'pm install failed — trying adb install directly...');
      const fallbackOut = runScript(`adb install -r -t -g ${APK_PATH} 2>&1`, 600000);
      log('INSTALL', `Fallback output: ${fallbackOut}`);
      if (!fallbackOut.toLowerCase().includes('success')) {
        await sleep(3000);
        const pkgList = runScript('adb shell pm list packages 2>/dev/null', 10000);
        if (!pkgList.includes('com.whatsapp')) {
          throw new Error(`Install failed. pm: ${pmOut} | adb: ${fallbackOut}`);
        }
      }
    }
  }

  await sleep(2000);
  const pkgList = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList.includes('com.whatsapp')) {
    log('INSTALL', 'Verified via pm list — installed');
    return;
  }

  await sleep(5000);
  const pkgList2 = runScript('adb shell pm list packages 2>/dev/null', 10000);
  if (pkgList2.includes('com.whatsapp')) {
    log('INSTALL', 'Verified via pm list (delayed) — installed');
    return;
  }

  throw new Error('WhatsApp package not found after install');
}

// ── Screen unlock ─────────────────────────────────────────────────────────────

async function unlockScreen() {
  log('UNLOCK', 'Waking and unlocking screen...');
  keyevent('KEYCODE_WAKEUP');
  await sleep(500);
  swipe(540, 1800, 540, 900, 400);
  await sleep(500);
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  adbShell('settings put global stay_on_while_plugged_in 3');
  adbShell('settings put secure lockscreen.disabled 1');
  await logScreen('UNLOCK');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('MAIN', `Starting WhatsApp registration for ${PHONE}`);

  const phoneInfo = parsePhone(PHONE);
  log('MAIN', `Parsed: country=${phoneInfo.country} cc=${phoneInfo.countryCode} national=${phoneInfo.nationalNumber}`);

  // ── 1. Verify emulator is ready ─────────────────────────────────────────
  await sleep(3000);
  const bootProp = adbShell('getprop sys.boot_completed');
  if (bootProp.trim() !== '1') {
    throw new Error(`Emulator not ready — boot_completed=${bootProp}`);
  }
  log('MAIN', 'Emulator ready');

  // ── 2. Unlock screen ────────────────────────────────────────────────────
  await unlockScreen();

  // ── 3. Install WhatsApp ──────────────────────────────────────────────────
  await installWhatsApp();
  log('MAIN', 'WhatsApp installed');

  // ── 4. Grant permissions & Launch WhatsApp ──────────────────────────────
  log('MAIN', 'Granting permissions and launching WhatsApp...');

  keyevent('KEYCODE_HOME');
  await sleep(1000);

  const WA_PERMS = [
    'android.permission.READ_CONTACTS',
    'android.permission.WRITE_CONTACTS',
    'android.permission.READ_PHONE_STATE',
    'android.permission.CALL_PHONE',
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.WRITE_EXTERNAL_STORAGE',
    'android.permission.RECEIVE_SMS',
    'android.permission.READ_SMS',
    'android.permission.SEND_SMS',
    'android.permission.GET_ACCOUNTS',
  ];
  for (const perm of WA_PERMS) {
    adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  log('MAIN', 'Permissions granted');

  log('MAIN', 'Checking Google Play Services version...');
  const gpsVersion = adbShell('dumpsys package com.google.android.gms | grep versionName | head -1 2>/dev/null');
  log('MAIN', `GPS version: ${gpsVersion || 'unknown'}`);

  const gpsVerMatch = gpsVersion.match(/versionName=([\d.]+)/);
  const gpsMajor = gpsVerMatch ? parseInt(gpsVerMatch[1].split('.')[0]) : 0;
  log('MAIN', `GPS major version: ${gpsMajor}`);

  if (gpsMajor < 22) {
    log('MAIN', 'GPS too old — note: update may be needed but continuing anyway');
  } else {
    log('MAIN', 'GPS version is sufficient');
  }

  // ── Launch WhatsApp ──────────────────────────────────────────────────────
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
  log('MAIN', 'Launched via monkey — waiting 10s for WhatsApp to render...');
  await sleep(10000);
  await logScreen('LAUNCH');

  const launchTexts = await screenTexts();
  const isHomeScreen = launchTexts.some(t =>
    ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday',
     'Messages','Chrome','Camera'].some(w => t.includes(w))
  );
  const isCrashing = launchTexts.some(t => t.includes('keeps stopping'));

  if (isCrashing) {
    log('MAIN', 'Crash detected — dismissing, clearing data, relaunching...');
    const screen = await dumpUI();
    await tapElement('Close app', screen);
    await sleep(2000);
    adbShell(`pm clear ${WA_PACKAGE} 2>/dev/null || true`);
    await sleep(1000);
    for (const perm of WA_PERMS) {
      adbShell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
    }
    adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
    await sleep(12000);
    await logScreen('AFTER-CLEAR');

  } else if (isHomeScreen) {
    log('MAIN', 'Still on home screen — trying am start fallback...');
    adbShell(`am start -n ${WA_PACKAGE}/${WA_PACKAGE}.Main 2>/dev/null`);
    await sleep(8000);
    await logScreen('AFTER-AMSTART');
  }

  // ── 5. Dismiss system alerts ─────────────────────────────────────────────
  log('MAIN', 'Dismissing any system alert dialogs...');
  for (let i = 0; i < 5; i++) {
    const screen = await dumpUI(4000);
    if (screen) {
      const alertTexts = screen.getAllText();
      if (alertTexts.some(t => t.includes('Alert') || t.includes('More info') ||
          t.includes('Google Play') || t.includes('Update'))) {
        log('MAIN', `Alert dialog (attempt ${i+1}) — tapping OK`);
        const dismissed =
          await tapElement('OK', screen) ||
          await tapElement('Skip', screen) ||
          await tapElement('Not now', screen) ||
          await tapElement('Cancel', screen) ||
          await tapElement('Close', screen);
        if (!dismissed) {
          log('MAIN', 'Fallback center tap for alert dialog');
          tap(540, 1200);
          await sleep(500);
          await logScreen('AFTER_ALERT_FALLBACK_TAP');
        }
        await sleep(2000);
      } else {
        break;
      }
    }
  }

  // ── 6. Language screen is auto-handled (AGREE button is visible at launch)
  // No need for separate language screen detection

  // ── 7. Accept terms and conditions ───────────────────────────────────────
  log('MAIN', 'Waiting for terms screen...');
  const agreeResult = await waitForAny([
    'AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree',
  ], 10000);

  if (agreeResult.matched) {
    log('MAIN', `Terms screen found: "${agreeResult.matched}"`);
    const agreeScreen = await dumpUI();
    for (const btn of ['AGREE AND CONTINUE', 'Agree and continue', 'AGREE', 'Accept', 'I agree']) {
      const matches = agreeScreen.findByText(btn);
      if (matches.length > 0) {
        await tapElement(btn, agreeScreen);
        await sleep(4000);
        break;
      }
    }
    await logScreen('POST-AGREE');
  } else {
    throw new Error('Terms screen not found - unexpected WhatsApp version or UI');
  }

  // ── 8. Wait for phone number entry screen ────────────────────────────────
  log('MAIN', 'Waiting for phone number screen (5s)...');
  const phoneScreenResult = await waitForAny([
    'Enter your phone number',
    'Phone number',
    'What\'s your number',
    'Enter phone number',
    'Your phone number',
  ], 5000);

  if (!phoneScreenResult.matched) {
    const currentTexts = await screenTexts();
    if (currentTexts.some(t => t.toLowerCase().includes('wait') || t.toLowerCase().includes('try again'))) {
      const waitText = currentTexts.find(t => t.toLowerCase().includes('wait') || t.toLowerCase().includes('try'));
      const waitSecs = parseWaitSeconds(waitText || '');
      log('MAIN', `Rate limited — wait ${waitSecs}s`);
      await webhook('rate_limited', { wait_seconds: waitSecs });
      return;
    }
    throw new Error('Phone number screen not found');
  }

  log('MAIN', `Phone number screen found: "${phoneScreenResult.matched}"`);
  await sleep(2000);
  
  // ═══════════════════════════════════════════════════════════════════════════
  // ANALYZE PHONE NUMBER SCREEN - Show all clickable and editable elements
  // ═══════════════════════════════════════════════════════════════════════════
  log('MAIN', 'Analyzing phone number screen elements...');
  const phoneScreen = await analyzeScreen('PHONE_SCREEN_ANALYSIS');
  
  if (!phoneScreen) {
    throw new Error('Failed to analyze phone screen');
  }

  // ── 9. Select country ────────────────────────────────────────────────────
  log('MAIN', 'Tapping country selector (United States)...');
  
  // Tap the country name to open picker
  const countryTapped = await tapElement('United States', phoneScreen);
  
  if (countryTapped) {
    // Wait for "Choose a country" screen (5s)
    log('MAIN', 'Waiting for country picker screen...');
    const pickerScreen = await waitForScreen('Choose a country', 5000);
    
    if (pickerScreen) {
      log('MAIN', 'Country picker opened');
      
      // Tap search icon to open search field
      log('MAIN', 'Tapping search icon...');
      const searchTapped = await tapElement('Search', pickerScreen, 1);
      
      if (searchTapped) {
        // Wait for "Search countries" screen (5s)
        log('MAIN', 'Waiting for search countries screen...');
        await sleep(2000);
        
        // Type country code in search field
        log('MAIN', `Typing country code: ${phoneInfo.countryCode}`);
        typeDigits(phoneInfo.countryCode);
        await sleep(2000);
        
        // Wait for country result to appear (10s)
        log('MAIN', `Waiting for country result with code +${phoneInfo.countryCode}...`);
        const countryResultScreen = await waitForScreen(`+${phoneInfo.countryCode}`, 10000);
        
        if (countryResultScreen) {
          // Tap the country result
          log('MAIN', `Tapping country result: +${phoneInfo.countryCode}`);
          await tapElement(`+${phoneInfo.countryCode}`, countryResultScreen, 1);
          
          // Wait to return to phone number screen (10s)
          log('MAIN', 'Waiting for phone number screen to return...');
          await waitForScreen('Phone number', 10000);
        } else {
          log('MAIN', 'Country result not found - using fallback');
          keyevent('KEYCODE_DPAD_DOWN');
          await sleep(300);
          keyevent('KEYCODE_ENTER');
          await sleep(2000);
        }
      }
    }
  }

  // ── 10. Enter national phone number ──────────────────────────────────────
  log('MAIN', 'Entering national phone number...');
  
  // Get fresh screen state
  let numberEntryScreen = await dumpUI();
  
  if (numberEntryScreen) {
    const editFields = numberEntryScreen.getEditableFields();
    
    // We need the SECOND EditText field (phone number), not the first (country code)
    if (editFields.length >= 2) {
      const phoneField = editFields[1]; // Second field is phone number
      log('MAIN', `Phone number field found at (${phoneField.center.x}, ${phoneField.center.y})`);
      
      // Tap phone number field
      tap(phoneField.center.x, phoneField.center.y);
      await sleep(500);
      
      // Clear any existing text
      for (let i = 0; i < 20; i++) {
        keyevent('KEYCODE_DEL');
      }
      await sleep(300);
      
      // Enter national number
      log('MAIN', `Typing national number: ${phoneInfo.nationalNumber}`);
      typeDigits(phoneInfo.nationalNumber);
      await sleep(1000);
      await logScreen('AFTER_PHONE_NUMBER_ENTRY');
    } else {
      throw new Error('Could not find phone number input field');
    }
  }

  await logScreen('AFTER_NUMBER_ENTRY');

  // ── 11. Tap NEXT button ──────────────────────────────────────────────────
  log('MAIN', 'Looking for NEXT button...');
  let nextScreen = await dumpUI();
  
  const nextTapped = 
    await tapElement('NEXT', nextScreen) ||
    await tapElement('Next', nextScreen) ||
    await tapElement('Continue', nextScreen) ||
    await tapElement('OK', nextScreen);

  if (!nextTapped) {
    throw new Error('Could not find NEXT button');
  }

  await sleep(3000);
  await logScreen('AFTER_NEXT');

  // ── 12. Handle confirmation dialog ───────────────────────────────────────
  log('MAIN', 'Checking for confirmation dialog...');
  const confirmScreen = await dumpUI(5000);
  
  if (confirmScreen) {
    const confirmTexts = confirmScreen.getAllText();
    if (confirmTexts.some(t => t.includes('Is this OK') || t.includes('Is the number') || 
        t.includes(phoneInfo.nationalNumber))) {
      log('MAIN', 'Confirmation dialog found — confirming number');
      const confirmTapped = 
        await tapElement('OK', confirmScreen) ||
        await tapElement('YES', confirmScreen) ||
        await tapElement('Yes', confirmScreen) ||
        await tapElement('Confirm', confirmScreen);
      
      if (confirmTapped) {
        await sleep(3000);
      }
    }
  }

  // ── 13. Wait for OTP screen or handle errors ─────────────────────────────
  log('MAIN', 'Waiting for OTP screen or error messages (60s)...');
  
  const otpOrErrorResult = await waitForAny([
    'Verifying',
    'Enter the 6-digit code',
    'Enter code',
    'verification code we',
    '6-digit code',
    'We sent',
    'Didn\'t get the code',
    'number is not allowed',
    'Too many attempts',
    'This phone number is already registered',
    'temporarily blocked',
    'try again later',
    'wait',
  ], 60000);

  if (!otpOrErrorResult.matched) {
    await logScreen('UNKNOWN_SCREEN');
    throw new Error('Unknown screen after submitting phone number');
  }

  const matchedLower = otpOrErrorResult.matched.toLowerCase();
  
  if (matchedLower.includes('not allowed') || matchedLower.includes('already registered')) {
    log('MAIN', 'Number already registered or not allowed');
    await webhook('already_registered', {});
    return;
  }

  if (matchedLower.includes('blocked') || matchedLower.includes('too many')) {
    const screenText = await screenTexts();
    const waitText = screenText.find(t => t.toLowerCase().includes('wait') || t.toLowerCase().includes('try'));
    const waitSecs = parseWaitSeconds(waitText || '');
    log('MAIN', `Rate limited or blocked — wait ${waitSecs}s`);
    await webhook('rate_limited', { wait_seconds: waitSecs });
    return;
  }

  // Check for OTP screen - must have "code" or "sent" and NOT "verify your phone number"
  const isOtpScreen = (
    (matchedLower.includes('code') || matchedLower.includes('sent') || 
     matchedLower.includes('verifying') || matchedLower.includes('didn\'t get')) &&
    !matchedLower.includes('verify your phone number')
  );

  if (isOtpScreen) {
    log('MAIN', 'OTP screen detected');
    await logScreen('OTP_SCREEN');
    
    // Analyze OTP screen
    await analyzeScreen('OTP_SCREEN_ANALYSIS');

    await webhook('otp_requested', {});

    const otp = await pollForOtp();

    if (!otp) {
      log('MAIN', 'OTP timeout — user did not reply');
      await webhook('bad_number', { reason: 'OTP timeout — user did not reply on Telegram' });
      return;
    }

    // ── 14. Enter OTP ────────────────────────────────────────────────────
    log('MAIN', `Entering OTP: ${otp}`);
    let otpScreen = await dumpUI();
    
    const otpFilled = await fillInputField('code', otp, otpScreen);
    
    if (!otpFilled) {
      log('MAIN', 'Using fallback OTP entry method');
      tap(540, 1000);
      await sleep(500);
      await logScreen('AFTER_OTP_FALLBACK_TAP');
      typeDigits(otp);
      await sleep(1000);
    }

    await logScreen('AFTER_OTP_ENTRY');

    otpScreen = await dumpUI(3000);
    if (otpScreen) {
      const otpTexts = otpScreen.getAllText();
      if (otpTexts.some(t => t === 'NEXT' || t === 'Next' || t === 'Continue')) {
        log('MAIN', 'Tapping NEXT after OTP entry');
        await tapElement('NEXT', otpScreen) ||
        await tapElement('Next', otpScreen) ||
        await tapElement('Continue', otpScreen);
        await sleep(3000);
      }
    }

    // ── 15. Wait for success or error ────────────────────────────────────
    log('MAIN', 'Waiting for registration result...');
    
    const resultWait = await waitForAny([
      'Restoring',
      'Restore',
      'Set up your profile',
      'Your name',
      'Enter your name',
      'What\'s your name',
      'Profile',
      'Invalid code',
      'Wrong code',
      'Incorrect',
      'Try again',
    ], 10000);

    if (!resultWait.matched) {
      await logScreen('POST_OTP_UNKNOWN');
      throw new Error('Unknown screen after OTP entry');
    }

    const resultLower = resultWait.matched.toLowerCase();

    if (resultLower.includes('invalid') || resultLower.includes('wrong') || 
        resultLower.includes('incorrect')) {
      log('MAIN', 'Invalid OTP code');
      await webhook('error_code', { reason: 'Invalid OTP code' });
      return;
    }

    if (resultLower.includes('restore') || resultLower.includes('profile') || 
        resultLower.includes('name')) {
      log('MAIN', 'Registration successful! Reached profile setup screen');
      await logScreen('SUCCESS');
      await webhook('success', {});
      return;
    }

    await logScreen('FINAL_UNKNOWN');
    throw new Error('Unknown final state after OTP submission');

  } else {
    await logScreen('UNEXPECTED');
    throw new Error(`Unexpected screen: ${otpOrErrorResult.matched}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('ERROR', err.message);
  log('ERROR', err.stack);
  await webhook('bad_number', { reason: `Script error: ${err.message}` });
  process.exit(0);
});
