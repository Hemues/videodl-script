/**
 * Cookie Extractor Registry
 *
 * Maps URL patterns to site-specific cookie extractors (login handlers).
 * Mirrors the structure of src/extractors/ for video extraction.
 *
 * Each cookie extractor module must export:
 *   - A class with a login(loginUrl, username, password, opts) method
 *   - URL_PATTERN  — RegExp matching supported login-page URLs
 *   - AUTH_COOKIE_NAME — The primary auth cookie to check for expiry
 */

import {
  BrazzersCookieExtractor,
  URL_PATTERN as BRAZZERS_PATTERN,
  AUTH_COOKIE_NAME as BRAZZERS_AUTH_COOKIE,
} from './brazzers/index.js';

import {
  YouTubeCookieExtractor,
  URL_PATTERN as YOUTUBE_PATTERN,
  AUTH_COOKIE_NAME as YOUTUBE_AUTH_COOKIE,
} from './youtube.js';

/**
 * Registry of cookie extractors.
 * Each entry: { pattern, handler, authCookieName, name }
 */
const COOKIE_EXTRACTORS = [
  {
    name: 'Brazzers (Aylo)',
    pattern: BRAZZERS_PATTERN,
    handler: new BrazzersCookieExtractor(),
    authCookieName: BRAZZERS_AUTH_COOKIE,
  },
  {
    name: 'YouTube',
    pattern: YOUTUBE_PATTERN,
    handler: new YouTubeCookieExtractor(),
    authCookieName: YOUTUBE_AUTH_COOKIE,
  },
];

/**
 * Find the appropriate cookie extractor for a given URL.
 * @param {string} url - The login page URL or site URL
 * @returns {Object|null} The matching entry { name, handler, authCookieName }, or null
 */
export function getCookieExtractor(url) {
  for (const entry of COOKIE_EXTRACTORS) {
    if (entry.pattern.test(url)) {
      return entry;
    }
  }
  return null;
}

/**
 * Get all cookie extractor names and their auth cookie names.
 * This is used by the cookie expiry checker to know which auth cookies
 * to look for in the cookie file.
 * @returns {Array<{name: string, pattern: RegExp, authCookieName: string}>}
 */
export function listCookieExtractors() {
  return COOKIE_EXTRACTORS.map(e => ({
    name: e.name,
    pattern: e.pattern,
    authCookieName: e.authCookieName,
  }));
}
