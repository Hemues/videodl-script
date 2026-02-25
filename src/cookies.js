/**
 * Netscape/Mozilla Cookie File Parser
 * 
 * Parses cookie files in the same format as yt-dlp, curl, wget, etc.
 * Format: domain\tinclude_subdomains\tpath\tsecure\texpiry\tname\tvalue
 * Lines starting with # are comments; blank lines are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse a Netscape-format cookie file into structured cookie objects.
 * @param {string} filePath - Path to the cookie file
 * @returns {Array<Object>} Array of cookie objects
 */
export function parseCookieFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cookie file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, 'utf-8');
  const cookies = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip comments and blank lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split('\t');
    if (parts.length < 7) continue;

    const [domain, includeSubdomains, cookiePath, secure, expiry, name, ...valueParts] = parts;
    const value = valueParts.join('\t'); // value may contain tabs

    cookies.push({
      domain: domain.startsWith('.') ? domain : domain,
      includeSubdomains: includeSubdomains.toUpperCase() === 'TRUE',
      path: cookiePath,
      secure: secure.toUpperCase() === 'TRUE',
      expiry: parseInt(expiry) || 0,
      name,
      value
    });
  }

  return cookies;
}

/**
 * Filter cookies matching a specific URL/domain.
 * @param {Array<Object>} cookies - Parsed cookies
 * @param {string} url - URL to match against
 * @returns {Array<Object>} Matching cookies
 */
export function getCookiesForUrl(cookies, url) {
  let hostname;
  let urlPath;
  let isSecure;
  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
    urlPath = parsed.pathname;
    isSecure = parsed.protocol === 'https:';
  } catch {
    return [];
  }

  return cookies.filter(cookie => {
    // Domain matching
    const cookieDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
    const domainMatch = hostname === cookieDomain ||
      (cookie.includeSubdomains && hostname.endsWith('.' + cookieDomain));
    if (!domainMatch) return false;

    // Path matching
    if (!urlPath.startsWith(cookie.path)) return false;

    // Secure matching
    if (cookie.secure && !isSecure) return false;

    // Expiry check (0 = session cookie, always valid)
    if (cookie.expiry > 0 && cookie.expiry < Date.now() / 1000) return false;

    return true;
  });
}

/**
 * Build a Cookie header string for a specific URL from parsed cookies.
 * @param {Array<Object>} cookies - Parsed cookies
 * @param {string} url - URL to build cookie header for
 * @returns {string} Cookie header value (e.g. "name1=val1; name2=val2")
 */
export function buildCookieHeader(cookies, url) {
  const matching = getCookiesForUrl(cookies, url);
  if (matching.length === 0) return '';
  // Deduplicate by name — last cookie (= most recently added) wins
  const deduped = new Map();
  for (const c of matching) {
    deduped.set(c.name, c);
  }
  return [...deduped.values()].map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * Build an ffmpeg -cookies string from parsed cookies (for HLS downloads).
 * ffmpeg expects cookies in HTTP Set-Cookie format, one per line,
 * separated by newlines, ending with a newline.
 * @param {Array<Object>} cookies - Parsed cookies
 * @param {string} url - URL to filter cookies for
 * @returns {string} ffmpeg-compatible cookie string
 */
export function buildFfmpegCookieString(cookies, url) {
  const matching = getCookiesForUrl(cookies, url);
  if (matching.length === 0) return '';

  return matching.map(c => {
    let str = `${c.name}=${c.value}; path=${c.path}; domain=${c.domain}`;
    if (c.secure) str += '; secure';
    return str;
  }).join('\n') + '\n';
}
