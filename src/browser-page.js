/**
 * Browser page loader — load a page in a locally installed Chromium-family
 * browser (Chrome, Chromium, Edge) and return its rendered HTML.
 *
 * Why: some sites put every page behind a Cloudflare *managed challenge* that
 * only a real browser engine can pass (JavaScript proof of work). Neither curl,
 * Node's TLS stack nor cycletls' JA3 impersonation gets through, and the
 * resulting `cf_clearance` cookie is bound to the browser's own network
 * fingerprint, so it cannot be replayed from another client either
 * (LESSONS-LEARNED #31). The media files of such sites are usually served from
 * an unchallenged host, so only the HTML page needs the browser.
 *
 * How: start the browser headless with a throw-away profile, talk to it over
 * the DevTools protocol (Node's built-in WebSocket, no extra dependency), load
 * the page, wait until the challenge is gone and an optional readiness
 * expression is true, read the HTML (plus an optional value), then kill the
 * browser and delete the profile.
 *
 * Browser lookup: VIDEODL_BROWSER (path to the executable) wins; otherwise the
 * usual install locations per platform are tried. The container image ships
 * Fedora's `chromium`.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHALLENGE_TITLE_RE = /^(?:Just a moment|Verifying (?:your|you are)|Attention Required|Checking your browser)/i;

function candidatePaths() {
  const env = process.env;
  const list = [];
  if (process.platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
      list.push(path.join(r, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    list.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
    list.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    list.push('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  } else {
    for (const dir of ['/usr/bin', '/usr/local/bin', '/snap/bin']) {
      for (const name of ['chromium-browser', 'chromium', 'google-chrome-stable', 'google-chrome',
                          'microsoft-edge-stable', 'microsoft-edge', 'brave-browser']) {
        list.push(path.join(dir, name));
      }
    }
    list.push('/usr/lib64/chromium-browser/chromium-browser');
    list.push('/usr/lib/chromium/chromium');
    // Playwright's browser cache (developer machines)
    const pw = path.join(os.homedir(), '.cache', 'ms-playwright');
    try {
      const dirs = fs.readdirSync(pw).filter(d => /^chromium-\d+$/.test(d)).sort().reverse();
      for (const d of dirs) list.push(path.join(pw, d, 'chrome-linux64', 'chrome'));
    } catch { /* no cache */ }
  }
  return list;
}

/** Path of a usable Chromium-family browser, or null. */
export function findBrowser() {
  const forced = process.env.VIDEODL_BROWSER;
  if (forced) return fs.existsSync(forced) ? forced : null;
  for (const p of candidatePaths()) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not there */ }
  }
  return null;
}

function inContainer() {
  return fs.existsSync('/run/.containerenv') || fs.existsSync('/.dockerenv');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForDevToolsPort(profileDir, child, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`browser exited early (code ${child.exitCode})`);
    try {
      const port = parseInt(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0], 10);
      if (port > 0) return port;
    } catch { /* not written yet */ }
    await sleep(100);
  }
  throw new Error('browser did not open its DevTools port');
}

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    };
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`DevTools connection failed: ${e?.message || 'error'}`));
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return undefined;
    return r.result?.value;
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

function baseArgs(profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1366,900',
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
  ];
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (process.platform === 'linux' && (isRoot || inContainer() || process.env.VIDEODL_BROWSER_NO_SANDBOX === '1')) {
    args.push('--no-sandbox');
  }
  return args;
}

async function removeDir(dir) {
  // Give the browser a moment to release the profile (Windows locks files).
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(250); }
  }
}

/** Start the browser; resolves to { child, base, profileDir }. */
async function launch(browser, extraArgs, timeoutMs) {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'videodl-browser-'));
  const child = spawn(browser, [...baseArgs(profileDir), ...extraArgs, 'about:blank'],
    { stdio: 'ignore', windowsHide: true });
  child.on('error', () => { /* reported through exitCode / timeout */ });
  try {
    const port = await waitForDevToolsPort(profileDir, child, timeoutMs);
    return { child, base: `http://127.0.0.1:${port}`, profileDir };
  } catch (e) {
    try { child.kill(); } catch { /* ignore */ }
    await removeDir(profileDir);
    throw e;
  }
}

async function shutdown(inst) {
  if (!inst) return;
  try { inst.child.kill(); } catch { /* ignore */ }
  await removeDir(inst.profileDir);
}

/**
 * The User-Agent the browser would send without the "Headless" marker.
 * The bot check refuses "HeadlessChrome", and a DevTools-level override is not
 * enough (workers and client hints still carry the original), so the browser is
 * started once to read its real version and then started again with the
 * corrected `--user-agent` flag.
 */
async function realUserAgent(browser, timeoutMs) {
  const inst = await launch(browser, [], timeoutMs);
  try {
    const version = await (await fetch(`${inst.base}/json/version`)).json();
    return String(version['User-Agent'] || '').replace(/HeadlessChrome/g, 'Chrome');
  } finally {
    await shutdown(inst);
  }
}

/**
 * Load `url` in a headless Chromium-family browser and return the rendered page.
 *
 * @param {string} url
 * @param {Object} [opts]
 * @param {string} [opts.waitFor]   JS expression; the page counts as ready once it is truthy
 * @param {string} [opts.evaluate]  JS expression evaluated after ready; its JSON value is returned as `value`
 * @param {number} [opts.timeout]   overall timeout in ms (default 60000)
 * @param {Function} [opts.log]     progress logger
 * @returns {Promise<{html: string, title: string, url: string, value: any, userAgent: string, cookies: Array}>}
 */
export async function fetchRenderedPage(url, opts = {}) {
  const { waitFor, evaluate, timeout = 60_000, log = () => {} } = opts;
  const browser = findBrowser();
  if (!browser) {
    throw new Error(
      'This site needs a Chromium-family browser to pass its bot check, and none was found. ' +
      'Install Google Chrome, Chromium or Microsoft Edge, or set VIDEODL_BROWSER to its executable.');
  }
  const deadline = Date.now() + timeout;
  const startTimeout = Math.min(30_000, timeout);

  log(`Starting browser: ${path.basename(browser)}`);
  const userAgent = await realUserAgent(browser, startTimeout);
  const inst = await launch(browser, [`--user-agent=${userAgent}`], startTimeout);
  let cdp = null;
  try {
    let pageTarget = null;
    for (let i = 0; i < 50 && !pageTarget; i++) {
      const targets = await (await fetch(`${inst.base}/json`)).json();
      pageTarget = targets.find(t => t.type === 'page');
      if (!pageTarget) await sleep(100);
    }
    if (!pageTarget) throw new Error('browser opened no page');

    cdp = new Cdp(pageTarget.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    log('Loading page in the browser (bot check)...');
    await cdp.send('Page.navigate', { url });

    let title = '';
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(500);
      title = (await cdp.evaluate('document.title')) || '';
      const state = await cdp.evaluate('document.readyState');
      if (!title || CHALLENGE_TITLE_RE.test(title) || state === 'loading') continue;
      if (!waitFor || await cdp.evaluate(`!!(${waitFor})`)) { ready = true; break; }
    }
    if (!ready) {
      throw new Error(CHALLENGE_TITLE_RE.test(title)
        ? 'the site\'s bot check did not let the browser through (timed out)'
        : `the page did not become ready in time (title: "${title}")`);
    }

    const html = (await cdp.evaluate('document.documentElement.outerHTML')) || '';
    const value = evaluate ? await cdp.evaluate(`JSON.parse(JSON.stringify(${evaluate}))`) : undefined;
    const finalUrl = (await cdp.evaluate('location.href')) || url;
    const cookies = (await cdp.send('Network.getAllCookies')).cookies || [];
    log(`Page loaded: ${title}`);
    return { html, title, url: finalUrl, value, userAgent, cookies };
  } finally {
    if (cdp) cdp.close();
    await shutdown(inst);
  }
}
