/**
 * wa_register.js — WhatsApp Registration Automation Script
 * 
 * This script runs inside GitHub Actions with an Android emulator.
 * It automates the WhatsApp registration flow including:
 * - Phone number verification
 * - OTP (6-digit code) handling
 * - Pairing code linking
 * - Rate limit detection
 * - Account status detection (banned, restricted, already registered)
 * 
 * Communicates with the Telegram bot via webhooks.
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Configuration from Environment ───────────────────────────────────────────
const PHONE_NUMBER = process.env.PHONE_NUMBER;           // e.g., "2348012345678"
const TELEGRAM_USER_ID = process.env.TELEGRAM_USER_ID;   // Telegram user ID
const WEBHOOK_URL = process.env.WEBHOOK_URL;             // Bot webhook endpoint
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;       // Shared secret
const GITHUB_RUN_ID = process.env.GITHUB_RUN_ID;         // GitHub Actions run ID
const POLL_INTERVAL = 3000;                              // OTP poll interval (ms)
const MAX_WAIT_TIME = 15 * 60 * 1000;                    // 15 minutes max wait

// ── State Management ─────────────────────────────────────────────────────────
let client = null;
let registrationState = 'INIT';  // INIT → PHONE_SUBMITTED → OTP_REQUESTED → OTP_SUBMITTED → COMPLETE/FAILED
let otpResolved = false;
let pairingResolved = false;
let startTime = Date.now();

// ── Webhook Helper ────────────────────────────────────────────────────────────
async function sendWebhook(event, extraData = {}) {
  try {
    const payload = {
      event,
      phone_number: PHONE_NUMBER,
      telegram_user_id: TELEGRAM_USER_ID,
      run_id: GITHUB_RUN_ID,
      ...extraData
    };

    console.log(`[WEBHOOK] Sending event: ${event}`, JSON.stringify(payload, null, 2));

    const response = await axios.post(WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': WEBHOOK_SECRET
      },
      timeout: 10000
    });

    console.log(`[WEBHOOK] Success: ${response.status}`);
    return true;
  } catch (error) {
    console.error(`[WEBHOOK] Failed: ${error.message}`);
    if (error.response) {
      console.error(`[WEBHOOK] Response: ${error.response.status} - ${error.response.data}`);
    }
    return false;
  }
}

// ── OTP Polling ───────────────────────────────────────────────────────────────
async function pollForOtp() {
  const otpUrl = `${WEBHOOK_URL.replace('/webhook/event', '')}/otp/${PHONE_NUMBER}`;

  console.log(`[OTP] Starting poll from: ${otpUrl}`);

  while (!otpResolved && (Date.now() - startTime) < MAX_WAIT_TIME) {
    try {
      const response = await axios.get(otpUrl, {
        headers: { 'X-Webhook-Secret': WEBHOOK_SECRET },
        timeout: 5000
      });

      if (response.status === 200 && response.data) {
        const otp = response.data.toString().trim();
        console.log(`[OTP] Received OTP: ${otp}`);

        if (/^\d{6}$/.test(otp)) {
          await submitOtp(otp);
          otpResolved = true;
          return otp;
        } else {
          console.log(`[OTP] Invalid format, expected 6 digits`);
        }
      }
    } catch (error) {
      if (error.response && error.response.status === 204) {
        // No OTP yet, continue polling
      } else {
        console.error(`[OTP] Poll error: ${error.message}`);
      }
    }

    await sleep(POLL_INTERVAL);
  }

  if (!otpResolved) {
    throw new Error('OTP timeout - no valid OTP received within 15 minutes');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── OTP Submission ────────────────────────────────────────────────────────────
async function submitOtp(otp) {
  console.log(`[OTP] Submitting code: ${otp}`);

  try {
    // Notify bot that OTP was submitted
    await sendWebhook('otp_submitted', { otp: otp.replace(/\d(?=\d{2})/g, '*') });

    // The actual OTP submission happens through the WhatsApp Web UI
    // This is handled by the whatsapp-web.js library internally
    // We just need to wait for the authentication result
  } catch (error) {
    console.error(`[OTP] Submit error: ${error.message}`);
    throw error;
  }
}

// ── WhatsApp Client Setup ────────────────────────────────────────────────────
async function createWhatsAppClient() {
  console.log(`[CLIENT] Creating WhatsApp client for ${PHONE_NUMBER}`);

  const clientOptions = {
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'
    },
    authStrategy: new LocalAuth({ 
      clientId: `reg_${PHONE_NUMBER}`,
      dataPath: './.wwebjs_auth'
    }),
    // Important: Use the specific phone number for registration
    takeoverOnConflict: false,
    takeoverTimeoutMs: 0
  };

  client = new Client(clientOptions);

  // ── Event Handlers ─────────────────────────────────────────────────────────

  // QR Code generated (for pairing)
  client.on('qr', async (qr) => {
    console.log(`[QR] QR code generated (length: ${qr.length})`);
    // For registration flow, we don't use QR - we use phone number + OTP
    // But we capture this in case WhatsApp offers it as alternative
  });

  // Authentication successful
  client.on('authenticated', async (session) => {
    console.log(`[AUTH] Authentication successful for ${PHONE_NUMBER}`);
    registrationState = 'AUTHENTICATED';

    await sendWebhook('registered', { 
      session_data: session,
      timestamp: new Date().toISOString()
    });
  });

  // Authentication failure
  client.on('auth_failure', async (msg) => {
    console.error(`[AUTH_FAIL] Authentication failed: ${msg}`);

    // Determine failure type based on message
    const lowerMsg = msg.toLowerCase();

    if (lowerMsg.includes('banned') || lowerMsg.includes('blocked') || lowerMsg.includes('suspended')) {
      await sendWebhook('banned', { reason: msg });
    } else if (lowerMsg.includes('invalid') && lowerMsg.includes('code')) {
      await sendWebhook('otp_error', { reason: msg });
    } else {
      await sendWebhook('bad_number', { reason: msg });
    }

    registrationState = 'FAILED';
  });

  // Client ready
  client.on('ready', async () => {
    console.log(`[READY] Client ready for ${PHONE_NUMBER}`);
    registrationState = 'READY';

    // Get session info
    const info = client.info;
    await sendWebhook('registered', {
      wid: info.wid,
      platform: info.platform,
      connected_at: new Date().toISOString()
    });

    // Save session data
    await saveSessionData();
  });

  // Disconnected
  client.on('disconnected', async (reason) => {
    console.warn(`[DISCONNECTED] Reason: ${reason}`);

    const lowerReason = reason.toLowerCase();

    if (lowerReason.includes('unpaired') || lowerReason.includes('logout')) {
      await sendWebhook('restricted', { 
        reason,
        seconds_remaining: 0 
      });
    } else if (lowerReason.includes('conflict') || lowerReason.includes('replaced')) {
      // Multi-device conflict
      await sendWebhook('restricted', { 
        reason,
        seconds_remaining: 3600 
      });
    }

    registrationState = 'DISCONNECTED';
  });

  // State changes
  client.on('change_state', async (state) => {
    console.log(`[STATE] Changed to: ${state}`);

    if (state === 'CONFLICT' || state === 'UNLAUNCHED') {
      await sendWebhook('restricted', { 
        state,
        seconds_remaining: 3600 
      });
    }
  });

  // Loading screen (shows progress)
  client.on('loading_screen', (percent, message) => {
    console.log(`[LOADING] ${percent}% - ${message}`);
  });

  // Remote session saved (pairing code flow)
  client.on('remote_session_saved', async () => {
    console.log(`[SESSION] Remote session saved - pairing requested`);
    await sendWebhook('pairing_requested');
  });

  return client;
}

// ── Session Data Management ──────────────────────────────────────────────────
async function saveSessionData() {
  try {
    const sessionPath = path.join('.wwebjs_auth', `session-reg_${PHONE_NUMBER}`);
    const sessionFile = path.join(sessionPath, 'session.json');

    if (fs.existsSync(sessionFile)) {
      const data = fs.readFileSync(sessionFile, 'utf8');
      await sendWebhook('session_update', { session_data: data });
      console.log(`[SESSION] Saved session data (${data.length} bytes)`);
    }
  } catch (error) {
    console.error(`[SESSION] Save error: ${error.message}`);
  }
}

// ── Page Interaction Helpers ─────────────────────────────────────────────────
async function detectWhatsAppPrompts(page) {
  const prompts = {
    // Phone number input screen
    phoneInput: {
      selector: 'input[type="tel"], input[name="phone"], [data-testid="phone-number-input"]',
      check: async () => {
        return await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          return el && el.offsetParent !== null;
        }, 'input[type="tel"], input[name="phone"], [placeholder*="phone" i]');
      }
    },

    // OTP/Code input screen
    otpInput: {
      selector: 'input[type="text"][maxlength="6"], input[autocomplete="one-time-code"], [data-testid="otp-input"]',
      check: async () => {
        return await page.evaluate(() => {
          // Look for 6-digit input or "code" text
          const inputs = document.querySelectorAll('input[type="text"]');
          for (const input of inputs) {
            if (input.maxLength === 6 || input.placeholder.toLowerCase().includes('code')) {
              return true;
            }
          }
          // Check for "Enter code" text
          const bodyText = document.body.innerText.toLowerCase();
          return bodyText.includes('enter code') || bodyText.includes('verification code') || bodyText.includes('6-digit');
        });
      }
    },

    // Rate limit / Too many attempts
    rateLimit: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('too many attempts') || 
                 text.includes('try again') || 
                 text.includes('wait') ||
                 text.includes('rate limited') ||
                 text.includes('temporarily banned') ||
                 /\d+\s*(minutes?|hours?|seconds?)/.test(text);
        });
      }
    },

    // Already registered / Active session exists
    alreadyRegistered: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('already registered') || 
                 text.includes('active on another device') ||
                 text.includes('phone number already in use') ||
                 text.includes('already linked');
        });
      }
    },

    // Banned / Suspended account
    banned: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('banned') || 
                 text.includes('suspended') ||
                 text.includes('blocked') ||
                 text.includes('violated') ||
                 text.includes('terms of service') ||
                 text.includes('account disabled');
        });
      }
    },

    // Pairing code screen (8-digit code)
    pairingCode: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('linking') || 
                 text.includes('pairing') ||
                 text.includes('link device') ||
                 text.includes('8-digit') ||
                 text.includes('enter this code');
        });
      }
    },

    // Registration successful / Main chat screen
    registered: {
      selector: '[data-testid="chat-list"], [data-testid="menu"], .app-wrapper-web',
      check: async () => {
        return await page.evaluate(() => {
          // Check for main WhatsApp Web interface elements
          return !!document.querySelector('[data-testid="chat-list"]') ||
                 !!document.querySelector('[data-testid="search-input"]') ||
                 !!document.querySelector('[data-icon="menu"]') ||
                 document.body.innerText.includes('Chats') ||
                 document.body.innerText.includes('Conversations');
        });
      }
    },

    // Error / Invalid phone
    invalidPhone: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('invalid phone') || 
                 text.includes('invalid number') ||
                 text.includes('phone number format') ||
                 text.includes('check your phone number') ||
                 text.includes('not a valid');
        });
      }
    },

    // SMS vs Call option selection
    smsOrCall: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('send sms') || 
                 text.includes('call me') ||
                 text.includes('didn't receive') ||
                 text.includes('resend');
        });
      }
    },

    // Captcha / Verification challenge
    captcha: {
      selector: null,
      check: async () => {
        return await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('captcha') || 
                 text.includes('verify you are human') ||
                 text.includes('security check') ||
                 text.includes('i'm not a robot') ||
                 !!document.querySelector('iframe[src*="recaptcha"]');
        });
      }
    }
  };

  const detected = {};
  for (const [name, prompt] of Object.entries(prompts)) {
    try {
      detected[name] = await prompt.check();
    } catch (e) {
      detected[name] = false;
    }
  }

  return detected;
}

// ── Main Registration Flow ───────────────────────────────────────────────────
async function runRegistration() {
  console.log('='.repeat(60));
  console.log('WhatsApp Registration Automation');
  console.log(`Phone: ${PHONE_NUMBER}`);
  console.log(`User: ${TELEGRAM_USER_ID}`);
  console.log(`Run ID: ${GITHUB_RUN_ID}`);
  console.log('='.repeat(60));

  // Validate inputs
  if (!PHONE_NUMBER || !TELEGRAM_USER_ID || !WEBHOOK_URL) {
    console.error('[ERROR] Missing required environment variables');
    process.exit(1);
  }

  try {
    // Create client
    await createWhatsAppClient();

    // Initialize client (this starts the browser)
    console.log('[INIT] Initializing WhatsApp client...');
    await client.initialize();

    // Get the underlying page for direct manipulation
    const page = await client.pupPage;

    if (!page) {
      throw new Error('Failed to get Puppeteer page');
    }

    // Wait for WhatsApp Web to load
    console.log('[WAIT] Waiting for WhatsApp Web to load...');
    await sleep(5000);

    // ── Registration Flow ─────────────────────────────────────────────────────

    // Step 1: Detect initial state
    console.log('[DETECT] Checking initial state...');
    let state = await detectWhatsAppPrompts(page);
    console.log('[DETECT] Initial state:', JSON.stringify(state, null, 2));

    // Handle various initial states
    if (state.alreadyRegistered) {
      console.log('[STATUS] Number already registered');
      await sendWebhook('already_registered');
      return;
    }

    if (state.banned) {
      console.log('[STATUS] Account banned');
      const reason = await page.evaluate(() => document.body.innerText);
      await sendWebhook('banned', { reason: reason.substring(0, 500) });
      return;
    }

    if (state.invalidPhone) {
      console.log('[STATUS] Invalid phone number format');
      await sendWebhook('bad_number', { reason: 'Invalid phone number format' });
      return;
    }

    // Step 2: Enter phone number if prompted
    if (state.phoneInput) {
      console.log('[INPUT] Entering phone number...');

      // Format phone number (remove + if present)
      const cleanPhone = PHONE_NUMBER.replace(/^\+/, '');

      // Find and fill phone input
      await page.evaluate((phone) => {
        const inputs = document.querySelectorAll('input[type="tel"], input[type="text"]');
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            input.value = phone;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      }, cleanPhone);

      // Click next/submit button
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"]');
        for (const btn of buttons) {
          const text = btn.innerText.toLowerCase();
          if (text.includes('next') || text.includes('continue') || text.includes('submit')) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      await sleep(3000);
      registrationState = 'PHONE_SUBMITTED';
    }

    // Step 3: Wait for and handle OTP prompt
    console.log('[OTP] Waiting for OTP screen...');
    let otpWaitTime = 0;
    const maxOtpWait = 60000; // 60 seconds for OTP screen to appear

    while (otpWaitTime < maxOtpWait) {
      state = await detectWhatsAppPrompts(page);

      if (state.otpInput) {
        console.log('[OTP] OTP input screen detected');
        break;
      }

      if (state.rateLimit) {
        console.log('[RATE_LIMIT] Rate limit detected');
        // Extract wait time from page text
        const pageText = await page.evaluate(() => document.body.innerText);
        const match = pageText.match(/(\d+)\s*(minutes?|hours?|seconds?)/i);
        const waitSeconds = match ? parseInt(match[1]) * (match[2].startsWith('hour') ? 3600 : match[2].startsWith('minute') ? 60 : 1) : 600;

        await sendWebhook('rate_limited', { wait_seconds: waitSeconds });
        return;
      }

      if (state.banned) {
        console.log('[BANNED] Account banned during registration');
        await sendWebhook('banned');
        return;
      }

      if (state.alreadyRegistered) {
        console.log('[ALREADY] Already registered detected');
        await sendWebhook('already_registered');
        return;
      }

      await sleep(2000);
      otpWaitTime += 2000;
    }

    // Step 4: Request OTP from user via webhook
    if (state.otpInput) {
      registrationState = 'OTP_REQUESTED';
      console.log('[OTP] Requesting OTP from user via Telegram...');
      await sendWebhook('otp_requested');

      // Poll for OTP from bot
      console.log('[OTP] Polling for OTP...');
      const otp = await pollForOtp();

      // Enter OTP
      console.log(`[OTP] Entering OTP: ${otp.replace(/\d(?=\d{2})/g, '*')}`);
      await page.evaluate((code) => {
        const inputs = document.querySelectorAll('input[type="text"]');
        for (const input of inputs) {
          if (input.maxLength === 6 || input.offsetParent !== null) {
            input.value = code;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));

            // Trigger submit
            const event = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' });
            input.dispatchEvent(event);
            return true;
          }
        }
        return false;
      }, otp);

      await sleep(3000);
      registrationState = 'OTP_SUBMITTED';

      // Wait for result
      console.log('[WAIT] Waiting for OTP validation...');
      await sleep(5000);

      // Check result
      state = await detectWhatsAppPrompts(page);

      if (state.registered) {
        console.log('[SUCCESS] Registration successful!');
        await sendWebhook('registered');
        return;
      }

      if (state.otpInput || state.invalidPhone) {
        // OTP was wrong
        console.log('[ERROR] OTP validation failed');
        await sendWebhook('otp_error');
        return;
      }
    }

    // Step 5: Handle pairing code flow (if applicable)
    if (state.pairingCode) {
      console.log('[PAIRING] Pairing code screen detected');
      await sendWebhook('pairing_requested');

      // Wait for pairing code from user
      // This would be handled via the /pair endpoint
      // For now, we wait for a longer period
      console.log('[PAIRING] Waiting for pairing code...');
      await sleep(30000);
    }

    // Final state check
    state = await detectWhatsAppPrompts(page);

    if (state.registered) {
      console.log('[SUCCESS] Final check: Registration confirmed');
      await sendWebhook('registered');
    } else if (state.banned) {
      console.log('[BANNED] Final check: Account banned');
      await sendWebhook('banned');
    } else {
      console.log('[UNKNOWN] Final state unclear, checking page content...');
      const pageContent = await page.evaluate(() => document.body.innerText);
      console.log('[CONTENT]', pageContent.substring(0, 1000));

      // Try to determine from content
      if (pageContent.includes('Chats') || pageContent.includes('Conversations')) {
        await sendWebhook('registered');
      } else {
        await sendWebhook('bad_number', { reason: 'Unknown final state', content: pageContent.substring(0, 500) });
      }
    }

  } catch (error) {
    console.error(`[FATAL] Registration failed: ${error.message}`);
    console.error(error.stack);

    // Send failure notification
    await sendWebhook('bad_number', { 
      reason: error.message,
      stack: error.stack 
    });

    process.exit(1);
  } finally {
    // Cleanup
    if (client) {
      console.log('[CLEANUP] Destroying client...');
      try {
        await client.destroy();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

// ── Execute ───────────────────────────────────────────────────────────────────
runRegistration().then(() => {
  console.log('[DONE] Registration script completed');
  process.exit(0);
}).catch((error) => {
  console.error('[FATAL] Unhandled error:', error);
  process.exit(1);
});
