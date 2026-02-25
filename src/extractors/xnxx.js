/**
 * XNXX Extractor
 * Extracts video URLs from xnxx.com
 *
 * XNXX is a sister site to XVideos and uses the same HTML5Player.
 * The video URL patterns are identical:
 *   - setVideoUrlLow('url')  → SD quality
 *   - setVideoUrlHigh('url') → HD quality
 *   - setVideoHLS('url')     → HLS stream
 *
 * This extractor extends XVideosExtractor and overrides only the
 * name, URL matching, and referer header.
 */

import { XVideosExtractor } from './xvideos.js';

export class XNXXExtractor extends XVideosExtractor {
  constructor() {
    super();
    this.name = 'XNXX';
  }

  static canHandle(url) {
    return /xnxx\.com/i.test(url);
  }

  async extract(url, options = {}) {
    // Call parent extraction with XNXX-specific referer
    console.log(`[${this.name}] Extracting from: ${url}`);

    // The parent XVideosExtractor handles the actual extraction
    // We just need to ensure the referer is correct
    const result = await super.extract(url, {
      ...options,
      _referer: 'https://www.xnxx.com/'
    });

    // Override extractor name
    result.extractor = this.name;

    // Fix headers in formats to use XNXX referer
    for (const format of result.formats) {
      if (format.headers) {
        format.headers.Referer = 'https://www.xnxx.com/';
      }
    }

    return result;
  }
}
