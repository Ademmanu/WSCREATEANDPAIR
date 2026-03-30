/**
 * wa_install.js — Download and install WhatsApp APK on the emulator.
 * Run this once before registration. The emulator snapshot will have
 * WhatsApp pre-installed so registration can launch it directly.
 */

'use strict';

const { execSync } = require('child_process');
const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

const GITHUB_REPO  = process.env.GITHUB_REPOSITORY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const APK_LOCAL    = '/tmp/whatsapp.apk';
const WA_PACKAGE   = 'com.whatsapp';
const SCRIPT_DIR   = '/tmp/wa_scripts';

function log(step, message) {
  const ts = new Date().toISOString().substr(11, 8);
  console.log(`[${ts}] [${step}] ${message}`);
}

function exec(cmd, timeoutMs = 120000) {
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

function adb(args, timeout = 120000) { return exec(`adb ${args}`, timeout); }
function shell(cmd, timeout = 30000) {
  const file = path.join(SCRIPT_DIR, `adb_${Date.now()}.sh`);
  fs.mkdirSync(SCRIPT_DIR, { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${cmd}\n`, { mode: 0o755 });
  const out = exec(`adb shell < ${file}`, timeout);
  try { fs.unlinkSync(file); } catch (_) {}
  return out;
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'wa-install/1.0', ...headers },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function downloadFile(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    log('DOWNLOAD', `${url} → ${dest}`);
    const u   = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    lib.get({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'User-Agent': 'wa-install/1.0', ...headers },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest, headers).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => { out.close(); resolve(dest); });
      out.on('error', reject);
    }).on('error', reject);
  });
}

const WA_PERMISSIONS = [
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_PHONE_STATE',
  'android.permission.CALL_PHONE',
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
];

async function main() {
  // 1. Emulator ready
  log('STEP 1', 'Checking emulator…');
  const boot = shell('getprop sys.boot_completed');
  if (boot !== '1') throw new Error(`Emulator not ready: ${boot}`);
  log('STEP 1', '✓ Emulator ready');

  // 2. Fetch whatsapp.apk from latest GitHub release
  log('STEP 2', `Fetching whatsapp.apk from github.com/${GITHUB_REPO}`);
  if (!GITHUB_REPO) throw new Error('GITHUB_REPOSITORY is not set');

  const authHeaders = {
    Accept: 'application/vnd.github+json',
    ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
  };

  const resp = await httpGet(
    `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
    authHeaders
  );
  if (resp.status !== 200) throw new Error(`GitHub API ${resp.status}: ${resp.body}`);

  const release = JSON.parse(resp.body);
  log('STEP 2', `Latest release: ${release.tag_name} — ${release.assets.length} asset(s)`);

  const asset = release.assets.find(a => a.name === 'whatsapp.apk');
  if (!asset) throw new Error(`whatsapp.apk not found in release ${release.tag_name}`);

  log('STEP 2', `Downloading whatsapp.apk (${Math.round(asset.size / 1024 / 1024)} MB)…`);
  await downloadFile(asset.browser_download_url, APK_LOCAL, authHeaders);
  log('STEP 2', '✓ Download complete');

  // 3. Install
  log('STEP 3', 'Installing WhatsApp…');
  shell(`pm uninstall ${WA_PACKAGE} 2>/dev/null || true`);
  const installOut = adb(`install -r -g "${APK_LOCAL}"`, 180000);
  log('STEP 3', `adb install: ${installOut}`);
  if (!installOut.toLowerCase().includes('success')) {
    throw new Error(`APK install failed: ${installOut}`);
  }
  log('STEP 3', '✓ WhatsApp installed');

  // 4. Grant all permissions upfront
  log('STEP 4', 'Granting permissions…');
  for (const perm of WA_PERMISSIONS) {
    shell(`pm grant ${WA_PACKAGE} ${perm} 2>/dev/null || true`);
  }
  log('STEP 4', '✓ Permissions granted');

  // 5. Verify installed
  const pkgCheck = shell(`pm list packages | grep ${WA_PACKAGE}`);
  if (!pkgCheck.includes(WA_PACKAGE)) throw new Error('WhatsApp package not found after install');
  log('STEP 5', `✓ Verified: ${pkgCheck.trim()}`);

  log('COMPLETE', 'WhatsApp is installed and ready for registration');
}

main().catch(err => {
  log('FATAL', err.message);
  process.exit(1);
});
