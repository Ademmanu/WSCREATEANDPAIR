/**
 * wa_register.js — VMOS Cloud automation via Puppeteer
 * Opens Chrome, logs into cloud.vmoscloud.com, and navigates to WhatsApp1
 */

'use strict';

const puppeteer = require('puppeteer');
const https = require('https');
const http = require('http');

// ── Config ────────────────────────────────────────────────────────────────────

const PHONE = process.env.PHONE_NUMBER;
const USER_ID = process.env.TELEGRAM_USER_ID;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const RUN_ID = process.env.GITHUB_RUN_ID;

const TARGET_URL = 'https://cloud.vmoscloud.com/';
const EMAIL = 'emmanueladeloye2023@gmail.com';
const PASSWORD = 'Emma2007';

// ── Utilities ─────────────────────────────────────────────────────────────────

function log(step, message) {
  const timestamp = new Date().toISOString().substr(11, 8);
  console.log(`[${timestamp}] [${step}] ${message}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Webhook notifier (kept for consistency with existing bot architecture)
async function webhook(event, extra = {}) {
  if (!WEBHOOK_URL) return;
  
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

// ── Main Automation ───────────────────────────────────────────────────────────

async function main() {
  log('INIT', `Starting VMOS Cloud automation for ${PHONE}`);
  log('INIT', 'Launching Chrome browser...');

  // Launch browser with GitHub Actions compatibility
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu'
    ]
  });

  log('BROWSER', 'Chrome launched successfully');
  const page = await browser.newPage();
  
  // Set viewport for consistent rendering
  await page.setViewport({ width: 1366, height: 768 });
  log('BROWSER', 'Viewport set to 1366x768');

  try {
    // Step 1: Navigate to target URL
    log('NAVIGATE', `Opening ${TARGET_URL}`);
    await page.goto(TARGET_URL, { 
      waitUntil: 'networkidle2',
      timeout: 60000 
    });
    log('NAVIGATE', '✓ Page loaded successfully');
    await sleep(2000);

    // Step 2: Enter Email
    log('FORM', 'Looking for email input field...');
    await page.waitForSelector('input[placeholder="Please enter your email address"]', { 
      visible: true,
      timeout: 15000 
    });
    await page.type('input[placeholder="Please enter your email address"]', EMAIL);
    log('FORM', `✓ Email entered: ${EMAIL}`);
    await sleep(1000);

    // Step 3: Click Login/Register button
    log('FORM', 'Clicking Login/Register button...');
    await page.waitForXPath('//button[contains(text(), "Login/Register")]', { timeout: 10000 });
    const [loginRegisterBtn] = await page.$x('//button[contains(text(), "Login/Register")]');
    if (loginRegisterBtn) {
      await loginRegisterBtn.click();
      log('FORM', '✓ Login/Register button clicked');
    } else {
      throw new Error('Login/Register button not found');
    }
    await sleep(2000);

    // Step 4: Enter Password
    log('FORM', 'Looking for password input field...');
    await page.waitForSelector('input[placeholder="Please enter your password"]', { 
      visible: true,
      timeout: 15000 
    });
    await page.type('input[placeholder="Please enter your password"]', PASSWORD);
    log('FORM', '✓ Password entered: [REDACTED]');
    await sleep(1000);

    // Step 5: Click Login button
    log('FORM', 'Clicking Login button...');
    await page.waitForXPath('//button[contains(text(), "Login")]', { timeout: 10000 });
    const [loginBtn] = await page.$x('//button[contains(text(), "Login")]');
    if (loginBtn) {
      await loginBtn.click();
      log('FORM', '✓ Login button clicked');
    } else {
      throw new Error('Login button not found');
    }
    await sleep(3000);

    // Step 6: Click "US" text/element
    log('NAVIGATE', 'Looking for US region selector...');
    await page.waitForXPath('//*[contains(text(), "US")]', { timeout: 15000 });
    const [usElement] = await page.$x('//*[contains(text(), "US")]');
    if (usElement) {
      await usElement.click();
      log('NAVIGATE', '✓ US region selected');
    } else {
      throw new Error('US element not found');
    }
    await sleep(2000);

    // Step 7: Click "WhatsApp1"
    log('NAVIGATE', 'Looking for WhatsApp1 option...');
    await page.waitForXPath('//*[contains(text(), "WhatsApp1")]', { timeout: 15000 });
    const [waElement] = await page.$x('//*[contains(text(), "WhatsApp1")]');
    if (waElement) {
      await waElement.click();
      log('NAVIGATE', '✓ WhatsApp1 clicked');
    } else {
      throw new Error('WhatsApp1 element not found');
    }
    await sleep(2000);

    // Final stop point as requested
    log('COMPLETE', 'Successfully navigated to WhatsApp1');
    log('COMPLETE', 'Stopping here as per instructions');
    
    // Take final screenshot for verification
    const screenshotPath = '/tmp/vmos_final.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log('COMPLETE', `Screenshot saved to ${screenshotPath}`);

    // Notify bot of progress (optional, for integration)
    await webhook('vmos_logged_in', { 
      status: 'stopped_at_whatsapp1',
      email: EMAIL,
      region: 'US',
      service: 'WhatsApp1'
    });

  } catch (error) {
    log('ERROR', `Automation failed: ${error.message}`);
    
    // Take error screenshot
    try {
      await page.screenshot({ path: '/tmp/vmos_error.png', fullPage: true });
      log('DEBUG', 'Error screenshot saved to /tmp/vmos_error.png');
    } catch (e) {
      log('DEBUG', 'Could not capture error screenshot');
    }
    
    await webhook('bad_number', { 
      reason: `VMOS automation error: ${error.message}` 
    });
    
    await browser.close();
    process.exit(1);
  }

  // Keep browser open for now (as per "stop here" instruction)
  log('PAUSE', 'Browser session active. Stopping execution.');
  await browser.close();
  log('EXIT', 'Browser closed. Exiting successfully.');
}

// ── Entry point ───────────────────────────────────────────────────────────────

main().catch(async (err) => {
  log('FATAL', err.message);
  log('FATAL', err.stack);
  await webhook('bad_number', { 
    reason: `Script crash: ${err.message}` 
  });
  process.exit(1);
});
