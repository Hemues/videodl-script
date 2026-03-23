/**
 * Erome Extractor
 * Extracts video URLs from erome.com album pages.
 *
 * Flow:
 *   1. Fetch album page via standard HTTP.
 *   2. Extract og:title for album title.
 *   3. Find all <source> tags with direct MP4 CDN URLs.
 *   4. Deduplicate and return each unique video as a format entry.
 *
 * URL format: https://www.erome.com/a/{albumId}
 * Albums may contain multiple videos; each is listed as a separate format.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class EromeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Erome';
  }

  static canHandle(url) {
    return /erome\.com\/a\/[\w-]+/i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const cleanUrl = url.replace(/[?#].*$/, '');

    const albumMatch = cleanUrl.match(/\/a\/([\w-]+)/);
    if (!albumMatch) throw new Error('Could not extract album ID from URL');
    const albumId = albumMatch[1];
    console.log(`[${this.name}] Album ID: ${albumId}`);

    const response = await got(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) {
        title = this._decodeHtmlEntities(titleTag[1])
          .replace(/\s*[-|]\s*Erome.*$/i, '')
          .trim();
      }
    }
    if (!title) title = `Erome_${albumId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract all <source> tags with MP4 URLs
    const sourceRegex = /<source\s+src=["']([^"']+\.mp4[^"']*)["'][^>]*>/gi;
    const seen = new Set();
    const videos = [];
    let m;
    while ((m = sourceRegex.exec(html)) !== null) {
      const src = m[0];
      const videoUrl = m[1];
      if (seen.has(videoUrl)) continue;
      seen.add(videoUrl);

      const res = src.match(/res=["'](\d+)["']/)?.[1] || '';
      const height = parseInt(res) || 720;
      videos.push({ url: videoUrl, height });
    }

    if (videos.length === 0) {
      throw new Error('No video sources found on album page');
    }

    // Build format list — each unique video is a format entry
    const formats = videos.map((v, i) => {
      const label = videos.length > 1 ? `clip-${i + 1}` : '';
      const qualityStr = `${v.height}p`;
      return {
        quality: label ? `${label}-${qualityStr}` : qualityStr,
        url: v.url,
        format_id: label ? `${label}-${qualityStr}` : qualityStr,
        ext: 'mp4',
        height: v.height,
        width: v.height > 0 ? Math.round(v.height * 16 / 9) : 0,
        protocol: 'https',
        hasVideo: true,
        hasAudio: true,
        headers: {
          Referer: 'https://www.erome.com/',
          'User-Agent': USER_AGENT,
        },
      };
    });

    console.log(`[${this.name}] Found ${formats.length} video(s)`);

    return {
      id: albumId,
      title,
      formats,
      url: cleanUrl,
      extractor: this.name,
    };
  }
}

export default EromeExtractor;
