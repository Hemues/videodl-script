/**
 * TubeSafari Extractor
 * Extracts video URLs from tubesafari.com
 *
 * TubeSafari embeds videos from other sites (primarily XHamster) via iframes.
 * This extractor detects the embedded source and delegates to the appropriate
 * extractor (usually XHamster).
 *
 * Iframe pattern: https://xh.partners/p/{videoId}
 * Canonical XHamster URL: https://xhamster.com/videos/{slug}-{videoId}
 */

import { BaseExtractor } from './base.js';
import { XHamsterExtractor } from './xhamster.js';
import got from 'got';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class TubeSafariExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'TubeSafari';
  }

  /* ---- URL matching ------------------------------------------------ */

  static canHandle(url) {
    return /tubesafari\.com\/video/i.test(url);
  }

  /* ---- Main extraction --------------------------------------------- */

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Fetch the page to find the embedded iframe
    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://tubesafari.com/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Look for xh.partners iframe (XHamster embed)
    const xhMatch = html.match(/src="https:\/\/xh\.partners\/p\/([^"]+)"/i);
    if (xhMatch) {
      const videoId = xhMatch[1];
      console.log(`[${this.name}] Found XHamster embed: ${videoId}`);

      // Fetch the embed page to get the canonical XHamster URL
      const embedUrl = `https://xh.partners/p/${videoId}`;
      const embedResp = await got(embedUrl, {
        headers: { ...HEADERS, Referer: url },
        timeout: { request: 30000 },
        followRedirect: true,
      });

      // Extract canonical URL
      const canonicalMatch = embedResp.body.match(/rel="canonical"\s+href="([^"]+)"/i);
      let xhamsterUrl;
      if (canonicalMatch) {
        xhamsterUrl = canonicalMatch[1];
      } else {
        // Fallback: construct URL directly
        xhamsterUrl = `https://xhamster.com/videos/${videoId}`;
      }

      console.log(`[${this.name}] Delegating to XHamster: ${xhamsterUrl}`);

      // Delegate to XHamster extractor
      const xhExtractor = new XHamsterExtractor();
      const result = await xhExtractor.extract(xhamsterUrl, options);

      // Override extractor name to indicate source
      result.extractor = `${this.name} (via XHamster)`;
      result.originalUrl = url;

      return result;
    }

    // Look for other embed patterns (add more as needed)
    // For now, throw if no known embed found
    throw new Error('No supported video embed found on page');
  }
}
