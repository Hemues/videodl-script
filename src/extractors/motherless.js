/**
 * Motherless Extractor
 * Extracts video URLs from motherless.com
 *
 * The video page contains a JS variable `__fileurl` with a signed CDN URL
 * (time-limited, rate-limited).  Only one quality is served (usually 360p).
 * Title is taken from the <title> tag.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class MotherlessExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Motherless';
  }

  static canHandle(url) {
    return /motherless\.com\/[A-Za-z0-9]+/i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Extract video ID (alphanumeric code after motherless.com/)
    const idMatch = url.match(/motherless\.com\/([A-Za-z0-9]+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Fetch the page
    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://motherless.com/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Check if this is actually a video page (not an image or gallery)
    const mediaTypeMatch = html.match(/__mediatype\s*=\s*'(\w+)'/);
    if (mediaTypeMatch && mediaTypeMatch[1] !== 'video') {
      throw new Error(`Not a video page (media type: ${mediaTypeMatch[1]})`);
    }

    // Extract title from <title> tag
    let title = null;
    const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    if (titleMatch) {
      title = this._decodeHtmlEntities(titleMatch[1])
        .replace(/\s*\|\s*MOTHERLESS\.COM\s*™?\s*$/i, '')
        .trim();
    }
    if (!title) title = `Motherless_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract video URL from __fileurl variable
    let fileUrlMatch = html.match(/__fileurl\s*=\s*'([^']+)'/);
    if (!fileUrlMatch) {
      // Fallback: try <source src="..."> inside the video element
      const sourceMatch = html.match(/<source\s+src="([^"]+)"\s+type="video\/mp4"/i);
      if (!sourceMatch) {
        throw new Error('Could not find video URL in page');
      }
      fileUrlMatch = [null, sourceMatch[1]];
    }
    let videoUrl = fileUrlMatch[1].replace(/&amp;/g, '&');

    // Extract quality from data-quality attribute (e.g., "360p")
    const qualityMatch = html.match(/data-quality="(\d+)p?"/);
    const height = qualityMatch ? parseInt(qualityMatch[1]) : 360;

    console.log(`[${this.name}] Quality: ${height}p`);
    console.log(`[${this.name}] Found 1 format(s)`);

    const formats = [{
      quality: `${height}p`,
      url: videoUrl,
      format_id: `mp4-${height}p`,
      ext: 'mp4',
      height,
      width: Math.round(height * 16 / 9),
      hasVideo: true,
      hasAudio: true,
      headers: {
        'Referer': url,
        'User-Agent': HEADERS['User-Agent'],
      },
    }];

    return {
      id: videoId,
      title,
      formats,
      extractor: this.name,
      url,
      thumbnail: `https://cdn5-thumbs.motherlessmedia.com/thumbs/${videoId}.jpg`,
    };
  }
}

export default MotherlessExtractor;
