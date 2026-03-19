/**
 * wa_register.js — WhatsApp registration automation via ADB + UIAutomator XML
 *
 * Runs inside GitHub Actions after the Android emulator boots.
 * Uses pure ADB commands and XML parsing to automate WhatsApp registration.
 * No Appium or WebDriver dependencies required.
 *
 * Required env vars:
 *   PHONE_NUMBER, TELEGRAM_USER_ID, WEBHOOK_URL,
 *   WEBHOOK_SECRET, GITHUB_RUN_ID
 */

'use strict';

const { execSync }  = require('child_process');
const fs            = require('fs');
const path          = require('path');
const https         = require('https');
const http          = require('http');
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

// ── Phone number parsing ──────────────────────────────────────────────────────

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

  // Fallback: try common country code lengths (1, 2, 3 digits)
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
  log('TYPE', text);
  const safe = text.replace(/[^a-zA-Z0-9+]/g, (c) => {
    return encodeURIComponent(c).replace(/%/g, '%25');
  });
  adbShell(`input text "${safe}"`);
}

// ── UIAutomator XML Parsing ───────────────────────────────────────────────────

/**
 * Dump UI hierarchy to XML using UIAutomator
 * Returns XML string or empty string on failure
 */
async function dumpUI(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    adbShell(`uiautomator dump ${UI_XML_PATH}`);
    await sleep(500);
    const pullResult = adb(`pull ${UI_XML_PATH} /tmp/ui_dump.xml`);
    
    if (fs.existsSync('/tmp/ui_dump.xml')) {
      try {
        const xml = fs.readFileSync('/tmp/ui_dump.xml', 'utf8');
        if (xml && xml.includes('<hierarchy')) {
          return xml;
        }
      } catch (e) {
        log('XML', `Read error: ${e.message}`);
      }
    }
    await sleep(1000);
  }
  return '';
}

/**
 * Parse bounds string "[x1,y1][x2,y2]" and return center coordinates
 */
function parseBounds(boundsStr) {
  const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  if (!match) return null;
  
  const x1 = parseInt(match[1]);
  const y1 = parseInt(match[2]);
  const x2 = parseInt(match[3]);
  const y2 = parseInt(match[4]);
  
  return {
    x1, y1, x2, y2,
    centerX: Math.floor((x1 + x2) / 2),
    centerY: Math.floor((y1 + y2) / 2),
    width: x2 - x1,
    height: y2 - y1,
  };
}

/**
 * Extract element attributes from XML node string
 */
function parseElement(nodeStr) {
  const attrs = {};
  
  // Extract key attributes
  const attrPatterns = {
    text: /text="([^"]*)"/,
    resourceId: /resource-id="([^"]*)"/,
    class: /class="([^"]*)"/,
    clickable: /clickable="([^"]*)"/,
    editable: /content-desc="([^"]*)"/,
    enabled: /enabled="([^"]*)"/,
    focusable: /focusable="([^"]*)"/,
    scrollable: /scrollable="([^"]*)"/,
    bounds: /bounds="([^"]*)"/,
    contentDesc: /content-desc="([^"]*)"/,
    checkable: /checkable="([^"]*)"/,
    checked: /checked="([^"]*)"/,
  };
  
  for (const [key, pattern] of Object.entries(attrPatterns)) {
    const match = nodeStr.match(pattern);
    if (match) {
      attrs[key] = match[1];
    }
  }
  
  // Parse bounds into coordinates
  if (attrs.bounds) {
    const coords = parseBounds(attrs.bounds);
    if (coords) {
      attrs.coords = coords;
    }
  }
  
  // Convert boolean strings
  attrs.isClickable = attrs.clickable === 'true';
  attrs.isEnabled = attrs.enabled === 'true';
  attrs.isFocusable = attrs.focusable === 'true';
  attrs.isScrollable = attrs.scrollable === 'true';
  attrs.isCheckable = attrs.checkable === 'true';
  attrs.isChecked = attrs.checked === 'true';
  
  // Determine if editable based on class
  attrs.isEditable = (attrs.class || '').includes('EditText');
  
  return attrs;
}

/**
 * Find all UI elements in XML and parse their attributes
 */
function parseAllElements(xml) {
  if (!xml) return [];
  
  const elements = [];
  const nodeRegex = /<node[^>]+>/g;
  let match;
  
  while ((match = nodeRegex.exec(xml)) !== null) {
    const nodeStr = match[0];
    const elem = parseElement(nodeStr);
    elements.push(elem);
  }
  
  return elements;
}

/**
 * Find elements by text (case-insensitive partial match)
 */
function findElementsByText(xml, searchText) {
  const elements = parseAllElements(xml);
  const search = searchText.toLowerCase();
  
  return elements.filter(elem => {
    const text = (elem.text || '').toLowerCase();
    const desc = (elem.contentDesc || '').toLowerCase();
    return text.includes(search) || desc.includes(search);
  });
}

/**
 * Find elements by resource ID
 */
function findElementsByResourceId(xml, resourceId) {
  const elements = parseAllElements(xml);
  return elements.filter(elem => 
    (elem.resourceId || '').includes(resourceId)
  );
}

/**
 * Find elements by class
 */
function findElementsByClass(xml, className) {
  const elements = parseAllElements(xml);
  return elements.filter(elem => 
    (elem.class || '').includes(className)
  );
}

/**
 * Get all clickable elements
 */
function getClickableElements(xml) {
  const elements = parseAllElements(xml);
  return elements.filter(elem => elem.isClickable && elem.isEnabled);
}

/**
 * Get all editable fields
 */
function getEditableFields(xml) {
  const elements = parseAllElements(xml);
  return elements.filter(elem => elem.isEditable && elem.isEnabled);
}

/**
 * Get all scrollable elements
 */
function getScrollableElements(xml) {
  const elements = parseAllElements(xml);
  return elements.filter(elem => elem.isScrollable);
}

/**
 * Print element information in structured format
 */
function logElement(elem, index) {
  log('ELEMENT', `#${index}`);
  if (elem.text) log('  Text', elem.text);
  if (elem.contentDesc) log('  Desc', elem.contentDesc);
  if (elem.resourceId) log('  ID', elem.resourceId);
  log('  Class', elem.class || 'unknown');
  log('  Clickable', elem.isClickable ? 'YES' : 'NO');
  log('  Editable', elem.isEditable ? 'YES' : 'NO');
  if (elem.coords) {
    log('  Bounds', `[${elem.coords.x1},${elem.coords.y1}][${elem.coords.x2},${elem.coords.y2}]`);
    log('  Center', `(${elem.coords.centerX}, ${elem.coords.centerY})`);
  }
  console.log('');
}

/**
 * Log all clickable and editable elements on current screen
 */
function logInteractiveElements(xml) {
  log('INTERACTIVE', '=== Clickable Elements ===');
  const clickable = getClickableElements(xml);
  clickable.forEach((elem, i) => logElement(elem, i + 1));
  
  log('INTERACTIVE', '=== Editable Fields ===');
  const editable = getEditableFields(xml);
  editable.forEach((elem, i) => logElement(elem, i + 1));
}

/**
 * Tap element by text (finds element and taps its center)
 */
async function tapElementByText(xml, searchText, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const elements = findElementsByText(xml, searchText);
    
    if (elements.length === 0) {
      log('TAP', `"${searchText}" not found (attempt ${attempt}/${retries})`);
      if (attempt < retries) {
        await sleep(2000);
        xml = await dumpUI();
        continue;
      }
      return false;
    }
    
    // Find the best match (prefer exact match, then enabled + clickable)
    let best = elements[0];
    for (const elem of elements) {
      if ((elem.text || '').toLowerCase() === searchText.toLowerCase()) {
        best = elem;
        break;
      }
      if (elem.isClickable && elem.isEnabled) {
        best = elem;
      }
    }
    
    if (!best.coords) {
      log('TAP', `"${searchText}" found but no bounds`);
      return false;
    }
    
    log('TAP', `"${searchText}" found → tapping (${best.coords.centerX}, ${best.coords.centerY})`);
    tap(best.coords.centerX, best.coords.centerY);
    await sleep(1000);
    return true;
  }
  
  return false;
}

/**
 * Tap element by resource ID
 */
async function tapElementByResourceId(xml, resourceId) {
  const elements = findElementsByResourceId(xml, resourceId);
  
  if (elements.length === 0) {
    log('TAP', `Resource ID "${resourceId}" not found`);
    return false;
  }
  
  const elem = elements[0];
  if (!elem.coords) {
    log('TAP', `Resource ID "${resourceId}" found but no bounds`);
    return false;
  }
  
  log('TAP', `Resource ID "${resourceId}" → tapping (${elem.coords.centerX}, ${elem.coords.centerY})`);
  tap(elem.coords.centerX, elem.coords.centerY);
  await sleep(1000);
  return true;
}

/**
 * Input text into editable field by resource ID
 */
async function inputTextByResourceId(xml, resourceId, text) {
  const elements = findElementsByResourceId(xml, resourceId);
  
  if (elements.length === 0) {
    log('INPUT', `Resource ID "${resourceId}" not found`);
    return false;
  }
  
  const elem = elements[0];
  if (!elem.isEditable) {
    log('INPUT', `Resource ID "${resourceId}" is not editable`);
    return false;
  }
  
  if (!elem.coords) {
    log('INPUT', `Resource ID "${resourceId}" found but no bounds`);
    return false;
  }
  
  // Tap to focus the field
  log('INPUT', `Focusing field "${resourceId}"`);
  tap(elem.coords.centerX, elem.coords.centerY);
  await sleep(500);
  
  // Clear any existing text
  adbShell('input keyevent KEYCODE_MOVE_END');
  for (let i = 0; i < 50; i++) {
    adbShell('input keyevent KEYCODE_DEL');
  }
  await sleep(300);
  
  // Type the new text
  typeText(text);
  await sleep(500);
  return true;
}

/**
 * Wait for screen containing specific text
 */
async function waitForScreen(searchText, timeoutMs = 60000) {
  log('WAIT', `Screen with "${searchText}" (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    if (xml.toLowerCase().includes(searchText.toLowerCase())) {
      log('FOUND', `"${searchText}"`);
      return xml;
    }
    await sleep(2000);
  }
  
  log('TIMEOUT', `"${searchText}" not found`);
  return null;
}

/**
 * Wait for any of multiple texts
 */
async function waitForAny(texts, timeoutMs = 60000) {
  log('WAIT', `Any of: ${texts.map(t => `"${t}"`).join(', ')} (${timeoutMs / 1000}s)`);
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    const xml = await dumpUI();
    for (const text of texts) {
      if (xml.toLowerCase().includes(text.toLowerCase())) {
        log('FOUND', `"${text}"`);
        return { xml, matched: text };
      }
    }
    await sleep(2000);
  }
  
  log('TIMEOUT', 'None of the texts found');
  return { xml: null, matched: null };
}

/**
 * Get visible text from current screen
 */
async function screenTexts() {
  const xml = await dumpUI();
  const elements = parseAllElements(xml);
  const texts = [];
  
  for (const elem of elements) {
    if (elem.text && elem.text.trim()) {
      texts.push(elem.text.trim());
    }
  }
  
  return [...new Set(texts)].slice(0, 20);
}

async function logScreen(label = 'SCREEN') {
  const texts = await screenTexts();
  log(label, texts.join(' | ') || '(empty)');
  return texts;
}

// ── Webhook notification ──────────────────────────────────────────────────────

async function webhook(event, data = {}) {
  const payload = {
    event,
    phone_number: PHONE,
    telegram_user_id: parseInt(USER_ID),
    run_id: RUN_ID,
    ...data,
  };
  
  log('WEBHOOK', `${event} → ${WEBHOOK_URL}`);
  
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const url = new URL(WEBHOOK_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Webhook-Secret': WEBHOOK_SECRET,
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        log('WEBHOOK', `Response ${res.statusCode}: ${data}`);
        resolve(true);
      });
    });
    
    req.on('error', (e) => {
      log('WEBHOOK', `Error: ${e.message}`);
      resolve(false);
    });
    
    req.write(body);
    req.end();
  });
}

// ── OTP polling ───────────────────────────────────────────────────────────────

async function pollForOTP(timeoutMs = 900000) {
  log('OTP', `Polling for OTP (${timeoutMs / 1000}s timeout)`);
  const deadline = Date.now() + timeoutMs;
  
  while (Date.now() < deadline) {
    try {
      const url = `${RENDER_BASE}/otp/${encodeURIComponent(PHONE)}`;
      const response = await fetch(url, {
        headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
      });
      
      if (response.status === 200) {
        const otp = await response.text();
        log('OTP', `Received: ${otp}`);
        return otp;
      }
    } catch (e) {
      log('OTP', `Poll error: ${e.message}`);
    }
    
    await sleep(3000);
  }
  
  log('OTP', 'Timeout waiting for OTP');
  return null;
}

// Polyfill fetch for Node.js < 18
if (typeof fetch === 'undefined') {
  global.fetch = async function(url, options = {}) {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const isHttps = urlObj.protocol === 'https:';
      const lib = isHttps ? https : http;
      
      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: 10000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            text: async () => data,
            json: async () => JSON.parse(data),
          });
        });
      });
      
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  };
}

// ── WhatsApp Installation ─────────────────────────────────────────────────────

async function installWhatsApp() {
  log('INSTALL', `Installing ${APK_PATH}...`);
  
  if (!fs.existsSync(APK_PATH)) {
    throw new Error(`APK not found at ${APK_PATH}`);
  }
  
  const apkSize = fs.statSync(APK_PATH).size;
  log('INSTALL', `APK size: ${(apkSize / 1024 / 1024).toFixed(2)} MB`);
  
  // Try install with -g flag (grant all permissions)
  let installOut = runScript(`adb install -r -g ${APK_PATH} 2>&1`, 180000);
  log('INSTALL', installOut);
  
  if (!installOut.includes('Success')) {
    log('INSTALL', 'Retrying without -g flag...');
    installOut = runScript(`adb install -r ${APK_PATH} 2>&1`, 180000);
    log('INSTALL', installOut);
    
    if (!installOut.includes('Success')) {
      // Try pm install as fallback
      log('INSTALL', 'Trying pm install fallback...');
      adb(`push ${APK_PATH} /data/local/tmp/wa.apk`, 180000);
      const pmOut = adbShell('pm install -r -g /data/local/tmp/wa.apk', 180000);
      log('INSTALL', `pm install: ${pmOut}`);
      
      if (!pmOut.includes('Success')) {
        throw new Error(`Install failed: ${installOut} | ${pmOut}`);
      }
    }
  }
  
  await sleep(3000);
  
  // Verify installation
  const pkgList = adbShell('pm list packages', 10000);
  if (!pkgList.includes('com.whatsapp')) {
    throw new Error('WhatsApp package not found after install');
  }
  
  log('INSTALL', 'WhatsApp installed successfully');
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

// ── WhatsApp Registration Flow ───────────────────────────────────────────────

async function registerWhatsApp(phoneInfo) {
  const { countryCode, nationalNumber, country } = phoneInfo;
  
  log('REGISTER', `Starting WhatsApp registration`);
  log('REGISTER', `Country: ${country} | CC: ${countryCode} | National: ${nationalNumber}`);
  
  // ── Step 1: Wait for "AGREE AND CONTINUE" screen (10s) ──────────────────
  log('STEP', '1. Waiting for AGREE AND CONTINUE screen');
  const agreeResult = await waitForAny([
    'AGREE AND CONTINUE',
    'Agree and continue',
    'AGREE',
  ], 10000);
  
  if (!agreeResult.xml) {
    throw new Error('AGREE AND CONTINUE screen not found');
  }
  
  await logScreen('AGREE-SCREEN');
  logInteractiveElements(agreeResult.xml);
  
  // ── Step 2: Tap "AGREE AND CONTINUE" ────────────────────────────────────
  log('STEP', '2. Tapping AGREE AND CONTINUE');
  const agreeTapped = await tapElementByText(agreeResult.xml, agreeResult.matched);
  
  if (!agreeTapped) {
    throw new Error('Failed to tap AGREE AND CONTINUE');
  }
  
  await sleep(3000);
  
  // ── Step 3: Wait for "Enter your phone number" screen (5s) ──────────────
  log('STEP', '3. Waiting for Enter your phone number screen');
  const phoneScreenXml = await waitForAny([
    'Enter your phone number',
    'Phone number',
    'Verify your phone number',
  ], 5000);
  
  if (!phoneScreenXml.xml) {
    throw new Error('Phone number screen not found');
  }
  
  await logScreen('PHONE-SCREEN');
  logInteractiveElements(phoneScreenXml.xml);
  
  // ── Step 4: Tap country selector (e.g., "United States") ────────────────
  log('STEP', '4. Tapping country selector');
  
  // Find the country selector - it's usually the first clickable element with country name
  // or has a specific resource ID
  const countryElements = findElementsByResourceId(phoneScreenXml.xml, 'country');
  let countryTapped = false;
  
  if (countryElements.length > 0) {
    const elem = countryElements[0];
    if (elem.coords) {
      tap(elem.coords.centerX, elem.coords.centerY);
      countryTapped = true;
    }
  }
  
  // Fallback: try tapping by common country names
  if (!countryTapped) {
    const commonCountries = ['United States', 'India', 'United Kingdom', 'Nigeria', 'Country'];
    for (const countryName of commonCountries) {
      if (await tapElementByText(phoneScreenXml.xml, countryName)) {
        countryTapped = true;
        break;
      }
    }
  }
  
  // Last resort: tap the top portion of screen where country selector usually is
  if (!countryTapped) {
    log('STEP', '4. Using fallback tap for country selector');
    tap(540, 600);
  }
  
  await sleep(2000);
  
  // ── Step 5: Wait for "Choose a country" screen (5s) ─────────────────────
  log('STEP', '5. Waiting for Choose a country screen');
  const countryListXml = await waitForAny([
    'Choose a country',
    'Select country',
    'Country',
  ], 5000);
  
  if (!countryListXml.xml) {
    throw new Error('Country selection screen not found');
  }
  
  await logScreen('COUNTRY-LIST');
  logInteractiveElements(countryListXml.xml);
  
  // ── Step 6: Tap search icon ─────────────────────────────────────────────
  log('STEP', '6. Tapping search icon');
  
  // Try to find search icon by resource ID or content description
  const searchElements = findElementsByResourceId(countryListXml.xml, 'search');
  let searchTapped = false;
  
  if (searchElements.length > 0) {
    const elem = searchElements[0];
    if (elem.coords) {
      tap(elem.coords.centerX, elem.coords.centerY);
      searchTapped = true;
    }
  }
  
  // Try finding by text/description
  if (!searchTapped) {
    searchTapped = await tapElementByText(countryListXml.xml, 'Search');
  }
  
  // Fallback: tap top-right corner where search icon usually is
  if (!searchTapped) {
    log('STEP', '6. Using fallback tap for search icon');
    tap(980, 150);
  }
  
  await sleep(2000);
  
  // ── Step 7: Wait for "Search countries" screen (5s) ─────────────────────
  log('STEP', '7. Waiting for Search countries screen');
  const searchScreenXml = await waitForAny([
    'Search countries',
    'Search',
  ], 5000);
  
  if (!searchScreenXml.xml) {
    throw new Error('Search screen not found');
  }
  
  await logScreen('SEARCH-SCREEN');
  logInteractiveElements(searchScreenXml.xml);
  
  // ── Step 8: Input country code to search field ──────────────────────────
  log('STEP', `8. Entering country code: ${countryCode}`);
  
  // Find search field
  const searchFields = getEditableFields(searchScreenXml.xml);
  
  if (searchFields.length === 0) {
    throw new Error('Search field not found');
  }
  
  const searchField = searchFields[0];
  if (searchField.coords) {
    tap(searchField.coords.centerX, searchField.coords.centerY);
    await sleep(500);
    typeText(countryCode);
    await sleep(1000);
  }
  
  // ── Step 9: Wait for country to appear (10s) ────────────────────────────
  log('STEP', '9. Waiting for country to appear in results');
  await sleep(3000);
  const countryResultXml = await dumpUI();
  
  await logScreen('COUNTRY-RESULT');
  logInteractiveElements(countryResultXml);
  
  // ── Step 10: Tap the country that appeared ──────────────────────────────
  log('STEP', '10. Tapping country from results');
  
  // The country should be in the results - find clickable elements
  const clickableResults = getClickableElements(countryResultXml);
  
  // Find the element that contains the country code in its text
  let countryResultTapped = false;
  for (const elem of clickableResults) {
    if ((elem.text || '').includes(countryCode) || (elem.text || '').includes(`+${countryCode}`)) {
      if (elem.coords) {
        tap(elem.coords.centerX, elem.coords.centerY);
        countryResultTapped = true;
        break;
      }
    }
  }
  
  // Fallback: tap the first clickable item in the list
  if (!countryResultTapped && clickableResults.length > 0) {
    const elem = clickableResults[0];
    if (elem.coords) {
      tap(elem.coords.centerX, elem.coords.centerY);
      countryResultTapped = true;
    }
  }
  
  if (!countryResultTapped) {
    throw new Error('Failed to tap country from search results');
  }
  
  await sleep(3000);
  
  // ── Step 11: Wait for phone number entry screen (10s) ───────────────────
  log('STEP', '11. Waiting for phone number entry screen');
  const phoneEntryXml = await waitForAny([
    'Enter your phone number',
    'Phone number',
  ], 10000);
  
  if (!phoneEntryXml.xml) {
    throw new Error('Phone number entry screen not found');
  }
  
  await logScreen('PHONE-ENTRY');
  logInteractiveElements(phoneEntryXml.xml);
  
  // ── Step 12: Input national number ──────────────────────────────────────
  log('STEP', `12. Entering national number: ${nationalNumber}`);
  
  // Find the phone number input field
  const phoneFields = getEditableFields(phoneEntryXml.xml);
  
  if (phoneFields.length === 0) {
    throw new Error('Phone number input field not found');
  }
  
  // Find the field that's most likely the phone number (not country code)
  let phoneField = phoneFields[phoneFields.length - 1]; // Usually the last field
  
  if (phoneField.coords) {
    tap(phoneField.coords.centerX, phoneField.coords.centerY);
    await sleep(500);
    
    // Clear any existing text
    adbShell('input keyevent KEYCODE_MOVE_END');
    for (let i = 0; i < 50; i++) {
      adbShell('input keyevent KEYCODE_DEL');
    }
    await sleep(300);
    
    typeText(nationalNumber);
    await sleep(1000);
  }
  
  // ── Step 13: Tap NEXT button ────────────────────────────────────────────
  log('STEP', '13. Tapping NEXT button');
  
  const nextXml = await dumpUI();
  const nextTapped = await tapElementByText(nextXml, 'NEXT');
  
  if (!nextTapped) {
    // Try alternative text
    const altTapped = await tapElementByText(nextXml, 'Next') ||
                      await tapElementByText(nextXml, 'Continue');
    
    if (!altTapped) {
      throw new Error('NEXT button not found');
    }
  }
  
  await sleep(3000);
  
  // ── Step 14: Wait for OTP screen or error (60s) ─────────────────────────
  log('STEP', '14. Waiting for OTP screen or error');
  
  const resultScreen = await waitForAny([
    'Enter the 6-digit code',
    'Verify',
    'Code',
    'rate limit',
    'too many',
    'try again',
    'invalid',
    'wrong number',
    'banned',
    'already registered',
  ], 60000);
  
  if (!resultScreen.xml) {
    throw new Error('No response after tapping NEXT');
  }
  
  await logScreen('RESULT-SCREEN');
  logInteractiveElements(resultScreen.xml);
  
  const screenText = resultScreen.xml.toLowerCase();
  
  // Check for various outcomes
  if (screenText.includes('enter the 6-digit') || screenText.includes('verify') || screenText.includes('code sent')) {
    log('SUCCESS', 'OTP screen reached - registration initiated');
    await webhook('otp_requested', {});
    
    // Now wait for OTP from Telegram user
    const otp = await pollForOTP();
    
    if (!otp) {
      throw new Error('OTP timeout - user did not provide code');
    }
    
    // Enter the OTP
    log('OTP', 'Entering OTP code');
    const otpXml = await dumpUI();
    const otpFields = getEditableFields(otpXml);
    
    if (otpFields.length > 0) {
      const otpField = otpFields[0];
      if (otpField.coords) {
        tap(otpField.coords.centerX, otpField.coords.centerY);
        await sleep(500);
        typeText(otp);
        await sleep(3000);
      }
    }
    
    // Check final result
    const finalXml = await dumpUI();
    await logScreen('FINAL-SCREEN');
    
    if (finalXml.toLowerCase().includes('invalid') || finalXml.toLowerCase().includes('incorrect')) {
      await webhook('bad_number', { reason: 'Invalid OTP code' });
      throw new Error('Invalid OTP code');
    } else {
      await webhook('registered', {});
      log('SUCCESS', 'Registration completed successfully');
    }
    
  } else if (screenText.includes('rate limit') || screenText.includes('too many')) {
    await webhook('rate_limited', { wait_seconds: 600 });
    throw new Error('Rate limited by WhatsApp');
  } else if (screenText.includes('banned')) {
    await webhook('banned', {});
    throw new Error('Number is banned');
  } else if (screenText.includes('already registered')) {
    await webhook('already_registered', {});
    throw new Error('Number already registered');
  } else {
    await webhook('bad_number', { reason: 'Unknown response from WhatsApp' });
    throw new Error('Unknown response from WhatsApp');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('MAIN', `Starting registration for ${PHONE}`);
  
  // Parse phone number
  const phoneInfo = parsePhone(PHONE);
  log('MAIN', `Parsed: country=${phoneInfo.country} cc=${phoneInfo.countryCode} national=${phoneInfo.nationalNumber}`);
  
  // Check emulator ready
  await sleep(3000);
  const bootProp = adbShell('getprop sys.boot_completed');
  if (bootProp.trim() !== '1') {
    throw new Error(`Emulator not ready — boot_completed=${bootProp}`);
  }
  log('MAIN', 'Emulator ready');
  
  // Unlock screen
  await unlockScreen();
  
  // Install WhatsApp
  await installWhatsApp();
  
  // Grant permissions
  log('MAIN', 'Granting permissions...');
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
  
  // Launch WhatsApp
  log('MAIN', 'Launching WhatsApp...');
  keyevent('KEYCODE_HOME');
  await sleep(1000);
  adbShell(`monkey -p ${WA_PACKAGE} -c android.intent.category.LAUNCHER 1 2>/dev/null`);
  await sleep(10000);
  
  await logScreen('LAUNCH');
  
  // Handle any system dialogs
  log('MAIN', 'Dismissing any system dialogs...');
  for (let i = 0; i < 3; i++) {
    const dialogXml = await dumpUI(4000);
    if (dialogXml.includes('Alert') || dialogXml.includes('Update') || dialogXml.includes('Google Play')) {
      await tapElementByText(dialogXml, 'OK') ||
      await tapElementByText(dialogXml, 'Skip') ||
      await tapElementByText(dialogXml, 'Not now') ||
      await tapElementByText(dialogXml, 'Cancel');
      await sleep(2000);
    } else {
      break;
    }
  }
  
  // Handle language selection if present
  const langXml = await dumpUI(4000);
  if (langXml.includes('Choose your language') || langXml.includes('Welcome to WhatsApp')) {
    log('MAIN', 'Language screen detected - tapping continue');
    await tapElementByText(langXml, 'Continue') ||
    await tapElementByText(langXml, 'Next') ||
    await tapElementByText(langXml, 'OK');
    await sleep(3000);
  }
  
  // Start registration flow
  await registerWhatsApp(phoneInfo);
  
  log('MAIN', 'Registration flow completed');
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('ERROR', err.message);
  log('ERROR', err.stack);
  
  // Only send webhook if not already sent
  if (!err.message.includes('Rate limited') && 
      !err.message.includes('banned') && 
      !err.message.includes('already registered')) {
    await webhook('bad_number', { reason: `Script error: ${err.message}` });
  }
  
  process.exit(0);
});
