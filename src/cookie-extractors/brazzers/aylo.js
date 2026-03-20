/**
 * Aylo (formerly MindGeek) Login Handler
 *
 * Automates browser-based login for Aylo network sites:
 *   Brazzers, RealityKings, Mofos, Babes, Twistys,
 *   Digital Playground, FakeHub, Sean Cody, Men.com, etc.
 *
 * Authentication strategy (in order of preference):
 *   1. API-based token refresh — uses refresh_token_ma via Keycloak endpoint
 *      (fastest; no browser needed)
 *   2. Browser-based login with puppeteer-extra + stealth plugin
 *      (falls back here when refresh token is expired)
 *
 * Requires: Edge or Chrome installed on the system (for strategy 2).
 */

import puppeteerCore from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import RecaptchaPlugin from 'puppeteer-extra-plugin-recaptcha';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { solveRecaptchaFreeAudio } from '../../captcha-solver.js';
import fs from 'node:fs';
import path from 'node:path';
import got from 'got';

/* ─── Puppeteer launcher + plugins ───────────────────────────────── */

let stealthActive = false;
try {
  puppeteerExtra.use(StealthPlugin());
  stealthActive = true;
} catch {
  // Stealth plugin not available (e.g. in a Node SEA binary) — continue without it.
}

let recaptchaActive = false;
let recaptchaConfigSignature = null;

function normalizeCaptchaProviderId(id) {
  const v = String(id || '').trim();
  return v || '2captcha';
}

function buildRecaptchaSignature(providerId, token) {
  return `${providerId}::${String(token || '').slice(0, 6)}::${String(token || '').length}`;
}

/**
 * Check whether the provider id refers to the free audio solver (wit.ai).
 * Accepted values: 'wit', 'wit.ai', 'free-audio', 'free'
 */
function isFreeAudioProvider(id) {
  const v = String(id || '').toLowerCase().trim();
  return v === 'wit' || v === 'wit.ai' || v === 'free-audio' || v === 'free';
}

function ensureRecaptchaPluginConfigured({ providerId, token, headless, verbose }) {
  if (!token) return;

  const normalizedProviderId = normalizeCaptchaProviderId(providerId);
  const sig = buildRecaptchaSignature(normalizedProviderId, token);
  if (recaptchaActive && recaptchaConfigSignature === sig) return;

  try {
    puppeteerExtra.use(
      RecaptchaPlugin({
        provider: { id: normalizedProviderId, token },
        visualFeedback: !headless,
        throwOnError: false,
      })
    );
    recaptchaActive = true;
    recaptchaConfigSignature = sig;
    if (verbose) console.log(`[Aylo] CAPTCHA solver enabled (provider=${normalizedProviderId})`);
  } catch (e) {
    recaptchaActive = false;
    recaptchaConfigSignature = null;
    if (verbose) console.log(`[Aylo] CAPTCHA solver init failed: ${e.message}`);
  }
}

/* ─── Browser detection ──────────────────────────────────────────── */

const BROWSER_PATHS = {
  win32: [
    process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
};

/**
 * Find the first available Chrome or Edge executable.
 * @returns {string|null}
 */
function findBrowser() {
  const platform = process.platform;
  const candidates = BROWSER_PATHS[platform] || [];

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }

  return null;
}

/* ─── Aylo Login Handler ─────────────────────────────────────────── */

/** Auth-service proxy endpoint (preferred — not WAF-blocked) */
const AUTH_SERVICE_RENEW_URL = 'https://auth-service.project1service.com/v1/authenticate/renew';

/** Direct Keycloak token endpoint (fallback — may be WAF-blocked) */
const KEYCLOAK_TOKEN_URL =
  'https://prod-keycloak-p1.geekadm.net/realms/P1INTERNAL/protocol/openid-connect/token';
const KEYCLOAK_CLIENT_ID = 'P1CLI';

export class AyloLoginHandler {
  constructor() {
    this.name = 'Aylo';
  }

  /* ─── Strategy 1: API-based token refresh ────────────────────── */

  /**
   * Try to refresh the access_token_ma using the refresh_token_ma
   * cookie via the Keycloak token endpoint.  This is much faster
   * and more reliable than a full browser login because it doesn't
   * need to fight reCAPTCHA.
   *
   * @param {string} loginUrl         - The login page URL (for domain matching)
   * @param {Array<Object>} existing  - Existing cookies from the cookie file
   * @param {object} [opts]           - { verbose }
   * @returns {Promise<Array<Object>|null>} Updated cookie array, or null if refresh not possible
   */
  async tryTokenRefresh(loginUrl, existing, opts = {}) {
    const verbose = !!opts.verbose;
    const hostname = new URL(loginUrl).hostname;

    // Find the refresh_token_ma cookie
    const refreshCookie = existing.find(c => {
      if (c.name !== 'refresh_token_ma') return false;
      const domain = (c.domain || '').replace(/^\./, '');
      return hostname.includes(domain) || domain.includes(hostname.split('.').slice(-2).join('.'));
    });

    if (!refreshCookie || !refreshCookie.value) {
      if (verbose) console.log('[Aylo] No refresh_token_ma cookie found — cannot use API refresh');
      return null;
    }

    // Check if refresh token itself is expired
    const now = Math.floor(Date.now() / 1000);
    if (refreshCookie.expiry && refreshCookie.expiry > 0 && refreshCookie.expiry <= now) {
      const ago = now - refreshCookie.expiry;
      const agoStr = ago < 3600 ? `${Math.round(ago / 60)} minutes ago` : `${Math.round(ago / 3600)} hours ago`;
      if (verbose) console.log(`[Aylo] refresh_token_ma expired ${agoStr} — cannot use API refresh`);
      return null;
    }

    console.log('[Aylo] Attempting API-based token refresh (no browser needed)...');

    // Also find instance_token for the proxy endpoint
    const instanceCookie = existing.find(c => c.name === 'instance_token');
    const instanceToken = instanceCookie?.value || '';

    // ── Try auth-service proxy first (not WAF-blocked) ──
    let data = null;
    try {
      if (verbose) console.log('[Aylo] Trying auth-service proxy endpoint...');
      const proxyResp = await got.post(AUTH_SERVICE_RENEW_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: `https://${hostname}`,
          Referer: loginUrl,
          ...(instanceToken ? { Instance: instanceToken } : {}),
        },
        body: JSON.stringify({ refreshToken: refreshCookie.value }),
        timeout: { request: 15000 },
        throwHttpErrors: false,
      });

      if (proxyResp.statusCode === 200 || proxyResp.statusCode === 201) {
        data = JSON.parse(proxyResp.body);
        if (data.access_token) {
          if (verbose) console.log('[Aylo] Auth-service proxy refresh succeeded.');
        } else {
          if (verbose) console.log('[Aylo] Auth-service proxy returned 200 but no access_token');
          data = null;
        }
      } else {
        if (verbose) console.log(`[Aylo] Auth-service proxy failed (HTTP ${proxyResp.statusCode})`);
      }
    } catch (proxyErr) {
      if (verbose) console.log(`[Aylo] Auth-service proxy error: ${proxyErr.message}`);
    }

    // ── Fallback: direct Keycloak endpoint ──
    if (!data) {
      try {
        if (verbose) console.log('[Aylo] Trying direct Keycloak endpoint...');
        const resp = await got.post(KEYCLOAK_TOKEN_URL, {
          form: {
            grant_type: 'refresh_token',
            client_id: KEYCLOAK_CLIENT_ID,
            refresh_token: refreshCookie.value,
          },
          timeout: { request: 15000 },
          throwHttpErrors: false,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
          },
        });

        if (resp.statusCode === 200) {
          data = JSON.parse(resp.body);
          if (!data.access_token) data = null;
        } else {
          if (verbose) console.log(`[Aylo] Keycloak endpoint failed (HTTP ${resp.statusCode})`);
        }
      } catch (kcErr) {
        if (verbose) console.log(`[Aylo] Keycloak endpoint error: ${kcErr.message}`);
      }
    }

    if (!data || !data.access_token) {
      if (verbose) console.log('[Aylo] All token refresh methods failed');
      return null;
    }

    console.log('[Aylo] Token refresh successful!');

    // Decode JWT to get expiry
    const jwtPayload = JSON.parse(
      Buffer.from(data.access_token.split('.')[1], 'base64').toString()
    );

    // Build updated cookies
    const updatedCookies = [];

    // access_token_ma
    updatedCookies.push({
      domain: '.' + hostname,
      includeSubdomains: true,
      path: '/',
      secure: true,
      expiry: jwtPayload.exp || (now + (data.expires_in || 3600)),
      name: 'access_token_ma',
      value: data.access_token,
    });

    // New refresh token (if provided)
    if (data.refresh_token) {
      const refreshExpiry = now + (data.refresh_expires_in || 1800);
      updatedCookies.push({
        domain: '.' + hostname,
        includeSubdomains: true,
        path: '/',
        secure: true,
        expiry: refreshExpiry,
        name: 'refresh_token_ma',
        value: data.refresh_token,
      });
    }

    return updatedCookies;
  }

  /* ─── Strategy 2: Browser-based login ────────────────────────── */

  /**
   * Log in to an Aylo-network site and return the captured cookies.
   *
   * @param {string} loginUrl  - Full login page URL (e.g. https://site-ma.brazzers.com/login)
   * @param {string} username  - Account username/email
   * @param {string} password  - Account password
   * @param {object} [opts]    - Options: { headless, verbose }
   * @returns {Promise<Array<Object>>} Array of cookie objects (Netscape format)
   */
  async login(loginUrl, username, password, opts = {}) {
    const headless = opts.headless !== false;
    const verbose = !!opts.verbose;

    const captchaProvider = opts.captchaProvider || process.env.VIDEODL_CAPTCHA_PROVIDER || process.env.CAPTCHA_PROVIDER || 'wit';
    const captchaKey = opts.captchaKey || process.env.VIDEODL_CAPTCHA_API_KEY || process.env.CAPTCHA_API_KEY || '';
    const captchaEnabled = !!captchaKey;
    const freeAudioMode = captchaEnabled && isFreeAudioProvider(captchaProvider);

    // Store captcha config for _maybeSolveCaptchas
    this._captchaConfig = { provider: captchaProvider, key: captchaKey, enabled: captchaEnabled, freeAudio: freeAudioMode };

    if (captchaEnabled && !freeAudioMode) {
      ensureRecaptchaPluginConfigured({ providerId: captchaProvider, token: captchaKey, headless, verbose });
    }

    const browserPath = findBrowser();
    if (!browserPath) {
      throw new Error(
        'No Chrome or Edge browser found on this system.\n' +
        'puppeteer-core requires an existing Chromium-based browser.\n' +
        'Install Chrome or Edge and try again.'
      );
    }

    if (verbose) console.log(`[Aylo] Using browser: ${browserPath}`);
    const captchaSolverLabel = freeAudioMode ? 'free-audio(wit.ai)' : (captchaEnabled && recaptchaActive ? captchaProvider : false);
    console.log(
      `[Aylo] Launching browser (headless=${headless ? 'new' : 'false'}, stealth=${stealthActive}, captchaSolver=${captchaSolverLabel})...`
    );

    const launchOpts = {
      executablePath: browserPath,
      headless: headless ? 'new' : false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1280,900',
        '--start-maximized',
        '--disable-infobars',
        '--disable-extensions',
        '--disable-dev-shm-usage',
        '--lang=en-US,en',
      ],
      defaultViewport: { width: 1280, height: 900 },
      ignoreDefaultArgs: ['--enable-automation'],
    };

    const preferredLauncher = (stealthActive || (captchaEnabled && recaptchaActive)) ? puppeteerExtra : puppeteerCore;

    let browser;
    try {
      browser = await preferredLauncher.launch(launchOpts);
    } catch (launchErr) {
      if (preferredLauncher === puppeteerExtra) {
        console.log('[Aylo] puppeteer-extra launch failed, falling back to plain puppeteer-core');
        stealthActive = false;
        browser = await puppeteerCore.launch(launchOpts);
      } else {
        throw launchErr;
      }
    }

    try {
      const page = await browser.newPage();

      // The stealth plugin handles most evasions automatically, but
      // reinforce a few things for extra safety:
      await page.evaluateOnNewDocument(() => {
        // Override webdriver (stealth plugin does this too, but belt-and-braces)
        Object.defineProperty(navigator, 'webdriver', { get: () => false });

        // Make sure Notification permission behaves like real Chrome
        const originalQuery = window.Notification
          && window.Notification.permission;
        if (originalQuery === 'denied') {
          Object.defineProperty(Notification, 'permission', { get: () => 'default' });
        }
      });

      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36 Edg/133.0.0.0'
      );

      // Navigate to login page
      console.log(`[Aylo] Navigating to ${loginUrl}...`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Wait for the React SPA to render (the page is JS-heavy)
      if (verbose) console.log('[Aylo] Waiting for SPA to render...');

      // Simulate realistic page-load behaviour — scroll, mouse movements, wait
      await this._simulateHumanPageLoad(page, verbose);

      // The login page may have a JS challenge (htjschal). Wait for real
      // content to load by checking for the login form or React root.
      console.log('[Aylo] Waiting for login form...');
      await this._waitForLoginForm(page, verbose);

      if (captchaEnabled) {
        await this._maybeSolveCaptchas(page, verbose, 15000);
      }

      // Small pause before interacting with the form
      await new Promise(r => setTimeout(r, 800 + Math.random() * 1200));

      // Fill credentials with human-like behaviour
      console.log('[Aylo] Entering credentials...');
      await this._fillCredentials(page, username, password, verbose);

      if (captchaEnabled) {
        await this._maybeSolveCaptchas(page, verbose, 15000);
      }

      // Submit
      console.log('[Aylo] Submitting login form...');
      await this._submitLogin(page, verbose);

      if (captchaEnabled) {
        await this._maybeSolveCaptchas(page, verbose, 180000);
      }

      // Wait for authentication to complete
      console.log('[Aylo] Waiting for authentication...');
      const success = await this._waitForAuth(page, loginUrl, verbose);

      if (!success) {
        // Take a screenshot for debugging
        const ssPath = path.resolve('debug-login-screenshot.png');
        try { await page.screenshot({ path: ssPath, fullPage: true }); } catch {}
        throw new Error(
          'Login timed out — authentication cookies not received. ' +
          'Check your credentials or see debug-login-screenshot.png'
        );
      }

      // Capture all cookies
      console.log('[Aylo] Capturing cookies...');
      const cookies = await this._captureCookies(page, loginUrl);

      console.log(`[Aylo] Login successful! Captured ${cookies.length} cookies.`);
      return cookies;

    } finally {
      // Close browser with a timeout to prevent hanging
      try {
        await Promise.race([
          browser.close(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('browser.close() timed out')), 10000)
          ),
        ]);
      } catch {
        // Force-kill the browser process if close hangs
        try { browser.process()?.kill('SIGKILL'); } catch {}
      }
    }
  }

  /* ─── Internal helpers ─────────────────────────────────────────── */

  /**
   * Simulate human-like page behaviour during initial page load.
   * This includes random mouse movements, scrolling, and pausing —
   * all of which improve the reCAPTCHA v3 behavioural score.
   */
  async _simulateHumanPageLoad(page, verbose) {
    // Initial wait for the page to become interactive
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));

    // Random mouse movements across the page
    const viewport = page.viewport() || { width: 1280, height: 900 };
    const movements = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < movements; i++) {
      const x = 100 + Math.floor(Math.random() * (viewport.width - 200));
      const y = 100 + Math.floor(Math.random() * (viewport.height - 200));
      await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) });
      await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
    }

    // Small scroll action
    await page.evaluate(() => {
      window.scrollBy(0, 50 + Math.floor(Math.random() * 100));
    });
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
    await page.evaluate(() => {
      window.scrollBy(0, -(30 + Math.floor(Math.random() * 50)));
    });

    // Wait for reCAPTCHA v3 background scoring to observe our behaviour
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
    if (verbose) console.log('[Aylo] Page-load simulation complete.');
  }

  /**
   * Wait for the login form to render (the Aylo SPA may take time to
   * load past the JS challenge + React hydration).
   */
  async _waitForLoginForm(page, verbose) {
    // Aylo uses input#username and input#password in a styled-components form
    const selectorString = 'input#username, input[name="username"], input[name="email"]';

    try {
      await page.waitForSelector(selectorString, { timeout: 30000 });
      if (verbose) console.log('[Aylo] Login form detected.');
    } catch {
      // Might be behind a JS challenge that needs more time
      if (verbose) console.log('[Aylo] Form not found yet — waiting for page to settle...');
      await new Promise(r => setTimeout(r, 10000));

      // Try again
      try {
        await page.waitForSelector(selectorString, { timeout: 30000 });
      } catch {
        throw new Error(
          'Login form not found. The page may be blocked by a bot challenge ' +
          'or the login UI has changed.'
        );
      }
    }
  }

  /**
   * Find and fill the username + password fields.
   */
  async _fillCredentials(page, username, password, verbose) {
    // Aylo uses input#username and input#password selectors
    const usernameInput = await page.$('input#username') || await page.$('input[name="username"]');
    if (!usernameInput) {
      throw new Error('Could not find the username/email input field.');
    }

    const passwordInput = await page.$('input#password') || await page.$('input[name="password"]') || await page.$('input[type="password"]');
    if (!passwordInput) {
      throw new Error('Could not find the password input field.');
    }

    // Move mouse to the username field, then click and type
    const uBox = await usernameInput.boundingBox();
    if (uBox) {
      await page.mouse.move(
        uBox.x + uBox.width / 2 + (Math.random() - 0.5) * 20,
        uBox.y + uBox.height / 2 + (Math.random() - 0.5) * 6,
        { steps: 8 + Math.floor(Math.random() * 6) }
      );
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }
    await usernameInput.click({ clickCount: 3 }); // select all
    await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
    await usernameInput.type(username, { delay: 40 + Math.random() * 60 });
    if (verbose) console.log('[Aylo] Username entered.');

    // Pause between fields (like a real user tabbing/clicking)
    await new Promise(r => setTimeout(r, 400 + Math.random() * 600));

    // Move mouse to the password field, then click and type
    const pBox = await passwordInput.boundingBox();
    if (pBox) {
      await page.mouse.move(
        pBox.x + pBox.width / 2 + (Math.random() - 0.5) * 20,
        pBox.y + pBox.height / 2 + (Math.random() - 0.5) * 6,
        { steps: 8 + Math.floor(Math.random() * 6) }
      );
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }
    await passwordInput.click({ clickCount: 3 });
    await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
    await passwordInput.type(password, { delay: 40 + Math.random() * 60 });
    if (verbose) console.log('[Aylo] Password entered.');

    // Wait for reCAPTCHA v3 to score (invisible, runs in background)
    if (verbose) console.log('[Aylo] Waiting for reCAPTCHA to settle...');
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
  }

  /**
   * Click the login/submit button.
   */
  async _submitLogin(page, verbose) {
    // Common submit button selectors
    const buttonSelectors = [
      'button[type="submit"]',
      'button[data-testid="submit"]',
      'button[data-test="submit"]',
      'button[data-testid="login-submit"]',
      'input[type="submit"]',
      'button.login-btn',
      'button.submit-btn',
    ];

    let button = null;
    for (const sel of buttonSelectors) {
      button = await page.$(sel);
      if (button) break;
    }

    // Fallback: look for a button containing "Log In" / "Sign In" text
    if (!button) {
      button = await page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll('button')];
        return buttons.find(b =>
          /log\s*in|sign\s*in|submit/i.test(b.textContent)
        ) || null;
      });
      // evaluateHandle returns JSHandle; check if it's truthy
      const isNull = await button.evaluate(el => el === null).catch(() => true);
      if (isNull) button = null;
    }

    if (!button) {
      // Last resort: press Enter in the password field
      if (verbose) console.log('[Aylo] No submit button found — pressing Enter.');
      await page.keyboard.press('Enter');
    } else {
      // Move mouse to button before clicking (human-like)
      const btnBox = await button.boundingBox();
      if (btnBox) {
        await page.mouse.move(
          btnBox.x + btnBox.width / 2 + (Math.random() - 0.5) * 10,
          btnBox.y + btnBox.height / 2 + (Math.random() - 0.5) * 4,
          { steps: 6 + Math.floor(Math.random() * 8) }
        );
        await new Promise(r => setTimeout(r, 100 + Math.random() * 300));
      }
      await button.click();
      if (verbose) console.log('[Aylo] Submit button clicked.');
    }
  }

  /**
   * Wait for authentication to complete by watching for the
   * access_token_ma cookie to appear.
   */
  async _waitForAuth(page, loginUrl, verbose) {
    const maxWait = 60000; // 60 seconds
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      // Use CDP to get ALL cookies from all domains (not just current page)
      const client = await page.createCDPSession();
      const { cookies } = await client.send('Network.getAllCookies');
      await client.detach();

      const authCookie = cookies.find(c =>
        c.name === 'access_token_ma'
      );

      if (authCookie && authCookie.value) {
        // Verify the cookie is actually fresh (not leftover from a prior session)
        const now = Math.floor(Date.now() / 1000);
        if (authCookie.expires && authCookie.expires > 0 && authCookie.expires <= now) {
          // Cookie exists but is already expired — delete it and keep waiting
          if (verbose) console.log('[Aylo] Found expired access_token_ma — deleting and waiting for fresh one...');
          try {
            const delClient = await page.createCDPSession();
            await delClient.send('Network.deleteCookies', {
              name: 'access_token_ma',
              domain: authCookie.domain,
            });
            await delClient.detach();
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, pollInterval));
          continue;
        }
        if (verbose) console.log('[Aylo] access_token_ma cookie detected!');
        return true;
      }

      // Check if we got redirected to a "bad login" page
      const currentUrl = page.url();
      if (currentUrl.includes('/badlogin') || currentUrl.includes('/bad-login')) {
        // Decode the ATS parameter for error info
        try {
          const atsParam = new URL(currentUrl).searchParams.get('ats');
          if (atsParam) {
            const atsData = JSON.parse(Buffer.from(atsParam, 'base64').toString());
            if (verbose) console.log('[Aylo] Login error data:', JSON.stringify(atsData));
          }
        } catch { /* ignore decode errors */ }

        throw new Error(
          'Login failed — redirected to /badlogin. Possible causes:\n' +
          '  • Invalid username or password\n' +
          '  • Account locked or suspended\n' +
          '  • reCAPTCHA challenge failed (try again, or use --no-headless to watch)\n' +
          '  • Too many login attempts (wait a few minutes and try again)'
        );
      }

      // Check for error messages on the page
      try {
        const errorText = await page.evaluate(() => {
          const errorEl = document.querySelector(
            '[class*="error"], [class*="Error"], [data-testid*="error"], .alert-danger'
          );
          return errorEl ? errorEl.textContent.trim() : null;
        });
        if (errorText) {
          console.log(`[Aylo] Page error: ${errorText}`);
        }
      } catch { /* ignore */ }

      // Log redirect status periodically
      if (verbose && !currentUrl.includes('/login') && !currentUrl.includes('/signin')) {
        if ((Date.now() - start) % 10000 < 1100) {
          console.log(`[Aylo] Current URL: ${currentUrl} (${Math.round((Date.now() - start) / 1000)}s)`);
        }
      }

      await new Promise(r => setTimeout(r, pollInterval));
    }

    return false;
  }

  /**
   * Capture all browser cookies from all relevant domains and convert
   * them to Netscape cookie-file format objects.
   */
  async _captureCookies(page, loginUrl) {
    // Get cookies from the browser (all domains the page interacted with)
    const browserCookies = await page.cookies();

    // Also get cookies from the CDP session for broader coverage
    const client = await page.createCDPSession();
    const { cookies: cdpCookies } = await client.send('Network.getAllCookies');
    await client.detach();

    // Merge both sources (CDP usually has the broader set)
    const allCookies = new Map();
    const addCookie = (c) => {
      const key = `${c.domain}|${c.name}|${c.path}`;
      allCookies.set(key, c);
    };

    browserCookies.forEach(addCookie);
    cdpCookies.forEach(addCookie);

    // Filter to relevant domains (the site + Aylo service domains)
    const loginHostname = new URL(loginUrl).hostname;
    const baseDomain = loginHostname.split('.').slice(-2).join('.');

    const relevantDomains = [
      baseDomain,
      'project1service.com',
      'project1content.com',
    ];

    const filtered = [...allCookies.values()].filter(c => {
      const domain = (c.domain || '').replace(/^\./, '');
      return relevantDomains.some(rd =>
        domain === rd || domain.endsWith('.' + rd)
      );
    });

    // Convert to Netscape format
    return filtered.map(c => ({
      domain: c.domain.startsWith('.') ? c.domain : '.' + c.domain,
      includeSubdomains: true,
      path: c.path || '/',
      secure: !!c.secure,
      expiry: c.expires && c.expires > 0 ? Math.floor(c.expires) : 0,
      name: c.name,
      value: c.value,
    }));
  }

  async _maybeSolveCaptchas(page, verbose, timeoutMs = 180000) {
    const cfg = this._captchaConfig;
    if (!cfg || !cfg.enabled) return;

    // ── Free audio solver (wit.ai) ──────────────────────────────────
    if (cfg.freeAudio) {
      try {
        if (verbose) console.log('[Aylo] Checking for captchas (free-audio solver via wit.ai)...');
        const result = await Promise.race([
          solveRecaptchaFreeAudio(page, cfg.key, {
            verbose,
            waitTimeout: Math.min(timeoutMs, 15000),
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('free-audio solver timeout')), timeoutMs)
          ),
        ]);
        if (verbose) {
          console.log(
            `[Aylo] Free solver: found=${result.found}, solved=${result.solved}` +
            (result.error ? `, error=${result.error}` : '')
          );
        }
      } catch (e) {
        if (verbose) console.log(`[Aylo] Free audio solver error: ${e.message}`);
      }
      return;
    }

    // ── Paid solver (2captcha etc. via puppeteer-extra-plugin-recaptcha) ──
    if (typeof page.solveRecaptchas !== 'function') {
      if (verbose) console.log('[Aylo] CAPTCHA solver not active on this page (solveRecaptchas not available)');
      return;
    }

    try {
      if (verbose) console.log('[Aylo] Checking for captchas...');
      const result = await Promise.race([
        page.solveRecaptchas(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('solveRecaptchas timeout')), timeoutMs)),
      ]);

      if (!result) return;
      const { captchas, solved, error } = result;
      if (verbose) {
        const foundCount = Array.isArray(captchas) ? captchas.length : 0;
        const solvedCount = Array.isArray(solved) ? solved.length : 0;
        console.log(`[Aylo] Captchas found: ${foundCount}, solved: ${solvedCount}${error ? `, error: ${String(error)}` : ''}`);
      }
    } catch (e) {
      if (verbose) console.log(`[Aylo] CAPTCHA solver error: ${e.message}`);
    }
  }
}
