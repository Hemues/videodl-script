/**
 * YouTube Cookie Extractor
 *
 * Provides auth cookie name for expiry checking.
 * YouTube login cannot be automated (Google's anti-bot protection);
 * cookies must be exported manually from a browser session.
 */

export const URL_PATTERN = /(?:youtube\.com|youtu\.be)/i;
export const AUTH_COOKIE_NAME = '__Secure-1PSID';

export class YouTubeCookieExtractor {
  async login(/* loginUrl, username, password, opts */) {
    throw new Error(
      'YouTube login cannot be automated. ' +
      'Export cookies manually from your browser while logged in to your YouTube Premium account. ' +
      'Use a browser extension like "Get cookies.txt LOCALLY" to export in Netscape format.'
    );
  }
}
