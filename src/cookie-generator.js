/**
 * Cookie Generator
 *
 * Automates browser-based login to sites that require authentication,
 * capturing the resulting cookies and writing them in Netscape cookie
 * format (the same format as yt-dlp / curl / wget).
 *
 * Key features:
 *   - Only re-generates cookies when the authentication cookie has expired
 *   - Reads login credentials from a logins.txt file
 *   - Merges new cookies into the existing cookie file (preserving others)
 *
 * Login-details file format (one entry per line):
 *   loginPageUrl::username::password
 *
 * Example:
 *   https://site-ma.brazzers.com/login::myuser::mypass123
 *
 * Default paths (relative to the executable / project directory):
 *   Login file:  logins/logins.txt
 *   Cookie file: cookies/cookies.txt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCookieExtractor } from './cookie-extractors/index.js';

/* --- Base directory (executable / project root) ---------------------- */

let BASE_DIR;
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  BASE_DIR = path.resolve(__dirname, '..');
} catch {
  // In compiled SEA binary, import.meta.url is empty.
  // Use the current working directory so cookies/logins paths resolve
  // relative to where the user invokes the binary.
  BASE_DIR = process.cwd();
}

/** Default cookie file path */
export const DEFAULT_COOKIE_FILE = path.join(BASE_DIR, 'cookies', 'cookies.txt');

/** Default login file path */
export const DEFAULT_LOGIN_FILE = path.join(BASE_DIR, 'logins', 'logins.txt');

/* ─── Login-details file parser ──────────────────────────────────── */

/**
 * Parse a login-details text file.
 * Format per line: loginPageUrl::username::password
 * Lines starting with # are comments; blank lines are skipped.
 *
 * @param {string} filePath - Path to the login-details file
 * @returns {Array<{loginUrl: string, username: string, password: string}>}
 */
export function parseLoginFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Login-details file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const entries = [];

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('::');
    if (parts.length < 3) {
      console.warn(`[cookie-gen] Skipping malformed line (expected loginUrl::user::pass): ${line}`);
      continue;
    }

    const [loginUrl, username, ...passwordParts] = parts;
    const password = passwordParts.join('::'); // password may contain ::

    if (!loginUrl || !username || !password) {
      console.warn(`[cookie-gen] Skipping incomplete entry: ${line}`);
      continue;
    }

    entries.push({
      loginUrl: loginUrl.trim(),
      username: username.trim(),
      password: password.trim(),
    });
  }

  return entries;
}

/* ─── Cookie expiry checking ─────────────────────────────────────── */

/**
 * Read an existing Netscape cookie file and return its cookies as objects.
 * Returns an empty array if the file doesn't exist.
 * @param {string} filePath
 * @returns {Array<Object>}
 */
function readExistingCookies(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return [];

  const content = fs.readFileSync(resolved, 'utf-8');
  const cookies = [];

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [domain, includeSubdomains, cookiePath, secure, expiry, name, ...valueParts] = parts;
    cookies.push({
      domain,
      includeSubdomains: includeSubdomains.toUpperCase() === 'TRUE',
      path: cookiePath,
      secure: secure.toUpperCase() === 'TRUE',
      expiry: parseInt(expiry) || 0,
      name,
      value: valueParts.join('\t'),
    });
  }

  return cookies;
}

/**
 * Check whether the auth cookie for a given site URL has expired
 * (or does not exist) in the cookie file.
 *
 * @param {string} siteUrl     - The site login URL (used to find the right extractor)
 * @param {string} cookieFile  - Path to the Netscape cookie file
 * @returns {{ expired: boolean, reason: string, cookieName: string|null }}
 */
export function checkCookieExpiry(siteUrl, cookieFile) {
  const extractor = getCookieExtractor(siteUrl);
  if (!extractor) {
    return { expired: true, reason: 'no cookie extractor registered for this site', cookieName: null };
  }

  const cookieName = extractor.authCookieName;
  const resolved = path.resolve(cookieFile);

  // Cookie file doesn't exist at all
  if (!fs.existsSync(resolved)) {
    return { expired: true, reason: 'cookie file does not exist', cookieName };
  }

  const cookies = readExistingCookies(resolved);

  // Find auth cookies matching the name
  const authCookies = cookies.filter(c => c.name === cookieName);
  if (authCookies.length === 0) {
    return { expired: true, reason: `no ${cookieName} cookie found in the cookie file`, cookieName };
  }

  // Check expiry — any non-expired auth cookie means we're good
  const now = Math.floor(Date.now() / 1000);
  const validCookie = authCookies.find(c => c.expiry === 0 || c.expiry > now);

  if (validCookie) {
    const remaining = validCookie.expiry > 0
      ? `expires in ${Math.round((validCookie.expiry - now) / 60)} minutes`
      : 'session cookie (no expiry)';
    return { expired: false, reason: remaining, cookieName };
  }

  // All auth cookies are expired
  const mostRecent = authCookies.reduce((a, b) => a.expiry > b.expiry ? a : b);
  const expiredAgo = now - mostRecent.expiry;
  const agoStr = expiredAgo < 3600
    ? `${Math.round(expiredAgo / 60)} minutes ago`
    : `${Math.round(expiredAgo / 3600)} hours ago`;

  return { expired: true, reason: `${cookieName} expired ${agoStr}`, cookieName };
}

/**
 * Check all login entries for expired auth cookies.
 * Returns entries that are expired and need refreshing.
 *
 * @param {string} cookieFile - Path to the cookie file
 * @param {Array<{loginUrl: string}>} loginEntries - Parsed login file entries
 * @returns {Array<{loginUrl: string, reason: string}>}
 */
export function findExpiredCookies(cookieFile, loginEntries) {
  const expired = [];
  for (const entry of loginEntries) {
    const result = checkCookieExpiry(entry.loginUrl, cookieFile);
    if (result.expired) {
      expired.push({ loginUrl: entry.loginUrl, reason: result.reason });
    }
  }
  return expired;
}

/* ─── Cookie-file writer (Netscape format) ───────────────────────── */

/**
 * Convert an array of cookie objects to Netscape cookie-file text.
 * @param {Array<Object>} cookies
 * @returns {string}
 */
function cookiesToNetscapeString(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by videodl cookie-generator', ''];

  for (const c of cookies) {
    const domain = c.domain || '';
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const cookiePath = c.path || '/';
    const secure = c.secure ? 'TRUE' : 'FALSE';
    const expiry = c.expiry || c.expires || 0;
    const expiryInt = typeof expiry === 'number' ? Math.floor(expiry) : 0;
    const name = c.name || '';
    const value = c.value || '';

    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiryInt}\t${name}\t${value}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * Merge new cookies into an existing cookie array.
 * For each new cookie, if there is already one with the same domain+name+path,
 * it is replaced; otherwise it is appended.
 * @param {Array<Object>} existing
 * @param {Array<Object>} incoming
 * @returns {Array<Object>}
 */
function mergeCookies(existing, incoming) {
  const merged = [...existing];
  const normDomain = d => (d || '').replace(/^\./, '').toLowerCase();

  for (const nc of incoming) {
    const key = `${normDomain(nc.domain)}|${nc.name}|${nc.path || '/'}`;
    const idx = merged.findIndex(
      c => `${normDomain(c.domain)}|${c.name}|${c.path || '/'}` === key,
    );
    if (idx >= 0) {
      merged[idx] = nc;
    } else {
      merged.push(nc);
    }
  }

  return merged;
}

/* ─── Main orchestrator ──────────────────────────────────────────── */

/**
 * Generate / refresh cookies by logging in with the credentials in
 * the login-details file and writing results to the cookie file.
 *
 * When onlyIfExpired is true (the default), only sites whose auth
 * cookies have expired will be re-logged-in. Sites with valid cookies
 * are skipped.
 *
 * @param {string} loginFilePath  - Path to the login-details file
 * @param {string} cookieFilePath - Path to the output Netscape cookie file
 * @param {object} [options]      - Extra options
 * @param {boolean} [options.onlyIfExpired=true] - Only regenerate expired cookies
 * @param {boolean} [options.verbose]  - Show detailed progress
 * @param {boolean} [options.headless] - Run browser headless (default true)
 * @param {string}  [options.captchaProvider] - CAPTCHA solver provider: 'wit' (free, wit.ai) or '2captcha' (paid); default: wit
 * @param {string}  [options.captchaKey]      - CAPTCHA solver API key / token (wit.ai server token or 2captcha key; or set env CAPTCHA_API_KEY)
 * @returns {Promise<{succeeded: number, failed: number, skipped: number, total: number}>}
 */
export async function generateCookies(loginFilePath, cookieFilePath, options = {}) {
  const entries = parseLoginFile(loginFilePath);
  if (entries.length === 0) {
    throw new Error('No valid login entries found in the file.');
  }

  const onlyIfExpired = options.onlyIfExpired !== false; // default: true

  const captchaProvider = options.captchaProvider || process.env.VIDEODL_CAPTCHA_PROVIDER || process.env.CAPTCHA_PROVIDER || 'wit';
  const captchaKey = options.captchaKey || process.env.VIDEODL_CAPTCHA_API_KEY || process.env.CAPTCHA_API_KEY || '';

  // Read existing cookies (will merge into them)
  let allCookies = readExistingCookies(cookieFilePath);

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const entry of entries) {
    const { loginUrl, username, password } = entry;

    // ── Check cookie expiry before logging in ──
    if (onlyIfExpired) {
      const expiryResult = checkCookieExpiry(loginUrl, cookieFilePath);
      if (!expiryResult.expired) {
        console.log(`[cookie-gen] ✓ Cookies still valid for ${loginUrl} (${expiryResult.reason}) — skipping`);
        skipped++;
        continue;
      }
      console.log(`[cookie-gen] Cookies expired for ${loginUrl}: ${expiryResult.reason}`);
    }

    console.log(`\n[cookie-gen] Processing: ${loginUrl} (user: ${username})`);

    const extractor = getCookieExtractor(loginUrl);
    if (!extractor) {
      console.error(`[cookie-gen] No cookie extractor found for: ${loginUrl}`);
      failed++;
      continue;
    }

    try {
      // ── Strategy 1: Try API-based token refresh first ──
      // This is much faster and doesn't need a browser, but only works when
      // the refresh_token_ma is still valid.
      if (extractor.handler.tryTokenRefresh) {
        const refreshedCookies = await extractor.handler.tryTokenRefresh(
          loginUrl, allCookies, { verbose: !!options.verbose }
        );
        if (refreshedCookies && refreshedCookies.length > 0) {
          console.log(`[cookie-gen] Got ${refreshedCookies.length} cookies via token refresh`);
          allCookies = mergeCookies(allCookies, refreshedCookies);
          succeeded++;
          continue;
        }
        console.log('[cookie-gen] Token refresh unavailable — falling back to browser login...');
      }

      // ── Strategy 2: Full browser-based login ──
      const newCookies = await extractor.handler.login(loginUrl, username, password, {
        headless: options.headless !== false,
        verbose: !!options.verbose,
        captchaProvider,
        captchaKey,
      });

      if (!newCookies || newCookies.length === 0) {
        console.error(`[cookie-gen] Login returned no cookies for: ${loginUrl}`);
        failed++;
        continue;
      }

      console.log(`[cookie-gen] Got ${newCookies.length} cookies from ${loginUrl}`);

      // Merge
      allCookies = mergeCookies(allCookies, newCookies);
      succeeded++;
    } catch (err) {
      console.error(`[cookie-gen] Login failed for ${loginUrl}: ${err.message}`);
      if (options.verbose) console.error(err.stack);
      failed++;
    }
  }

  // Write merged cookies to file (even if nothing changed, to create the file)
  const outDir = path.dirname(path.resolve(cookieFilePath));
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  fs.writeFileSync(path.resolve(cookieFilePath), cookiesToNetscapeString(allCookies), 'utf-8');
  console.log(`\n[cookie-gen] Wrote ${allCookies.length} cookies to ${cookieFilePath}`);

  return { succeeded, failed, skipped, total: entries.length };
}
