/**
 * TnaFlux Extractor
 * Extracts video URLs from tnaflix.com and empflix.com
 *
 * These sites use standard HTML5 <source> tags with direct CDN URLs.
 * The `size` attribute contains the quality height (144, 240, 360, 480, 720, 1080).
 * URLs are signed with expiration timestamps.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class TnaFluxExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'TnaFlux';
  }

  /* ---- URL matching ------------------------------------------------ */

  static canHandle(url) {
    return /(?:tnaflix|empflix)\.com\/.*video\d+/i.test(url);
  }

  /* ---- Helpers ----------------------------------------------------- */

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/&#(\d+);/g, (_, d) =>
        String.fromCharCode(parseInt(d, 10)),
      );
  }

  /* ---- Main extraction --------------------------------------------- */

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Extract video ID from URL
    const idMatch = url.match(/video(\d+)/i);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Determine site
    const site = url.includes('empflix') ? 'empflix.com' : 'tnaflix.com';

    // Fetch the page
    const response = await got(url, {
      headers: { ...HEADERS, Referer: `https://www.${site}/` },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title from <title> tag
    let title = null;
    const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    if (titleMatch) {
      title = this._decodeHtmlEntities(titleMatch[1])
        .replace(/\s*[-|]\s*(?:Tnaflix|Empflix)\.com\s*$/i, '')
        .trim();
    }
    if (!title) title = `TnaFlux_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract all <source> tags with video URLs
    const sourceRegex = /<source\s+src="([^"]+)"\s+type="video\/mp4"\s+size="(\d+)"/gi;
    const formats = [];
    let match;

    while ((match = sourceRegex.exec(html)) !== null) {
      const videoUrl = match[1].replace(/&amp;/g, '&');
      const height = parseInt(match[2]);

      formats.push({
        quality: `${height}p`,
        url: videoUrl,
        format_id: `mp4-${height}p`,
        ext: 'mp4',
        height,
        width: Math.round(height * 16 / 9),
        hasVideo: true,
        hasAudio: true,
        headers: {
          Referer: `https://www.${site}/`,
          'User-Agent': HEADERS['User-Agent'],
        },
      });
    }

    if (formats.length === 0) {
      throw new Error('No video sources found in page');
    }

    // Sort by quality (highest first)
    formats.sort((a, b) => b.height - a.height);
    console.log(`[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`);

    // Extract thumbnail
    let thumbnail = null;
    const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    if (thumbMatch) thumbnail = thumbMatch[1];

    return {
      id: videoId,
      title,
      formats,
      extractor: this.name,
      url,
      thumbnail,
    };
  }
}
