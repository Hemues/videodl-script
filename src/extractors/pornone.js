/**
 * PornOne Extractor
 * Extracts video URLs from pornone.com
 *
 * Uses standard HTML5 <source> tags with direct CDN URLs.
 * The `res` attribute contains the quality height (480, 720, 1080, etc.).
 * The `label` attribute contains the quality label (e.g., "480p", "720p").
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

export class PornOneExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'PornOne';
  }

  /* ---- URL matching ------------------------------------------------ */

  static canHandle(url) {
    return /pornone\.com\/[^\/]+\/[^\/]+\/\d+/i.test(url);
  }

  /* ---- Helpers ----------------------------------------------------- */

  _decodeHtmlEntities(text) {
    return text
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/&#(\d+);/g, (_, d) =>
        String.fromCharCode(parseInt(d, 10)),
      );
  }

  _cleanTitle(title) {
    if (!title) return null;
    return this._decodeHtmlEntities(title)
      .replace(/\s*[—–\-|]\s*(?:PornOne|ex\s*vPorn|Free\s*Porn|HD\s*Porn).*$/i, '')
      .trim();
  }

  /* ---- Main extraction --------------------------------------------- */

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Extract video ID from URL (last path segment)
    const idMatch = url.match(/\/(\d+)\/?(?:\?|$)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Fetch the page
    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://pornone.com/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title from JSON-LD schema or <title> tag
    let title = null;
    const jsonLdMatch = html.match(/<script\s+type="application\/ld\+json">\s*(\{[^<]*"@type"\s*:\s*"VideoObject"[^<]*\})\s*<\/script>/i);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        title = this._cleanTitle(jsonLd.name);
      } catch (e) {
        // Fall back to title tag
      }
    }
    if (!title) {
      const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleMatch) {
        title = this._cleanTitle(titleMatch[1]);
      }
    }
    if (!title) title = `PornOne_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract all <source> tags with video URLs
    // Pattern: <source src="URL" type="video/mp4" label="480p" default res="480"/>
    const sourceRegex = /<source\s+src="([^"]+)"\s+type="video\/mp4"\s+label="([^"]+)"[^>]*res="(\d+)"[^>]*\/?>/gi;
    const formats = [];
    let match;

    while ((match = sourceRegex.exec(html)) !== null) {
      const videoUrl = match[1].replace(/&amp;/g, '&');
      const label = match[2];
      const height = parseInt(match[3]);

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
          Referer: 'https://pornone.com/',
          'User-Agent': HEADERS['User-Agent'],
        },
      });
    }

    if (formats.length === 0) {
      // Try alternate pattern - contentUrl from JSON-LD
      if (jsonLdMatch) {
        try {
          const jsonLd = JSON.parse(jsonLdMatch[1]);
          if (jsonLd.contentUrl) {
            // Try to determine quality from URL
            const qualityMatch = jsonLd.contentUrl.match(/_(\d+)x(\d+)_/);
            const height = qualityMatch ? parseInt(qualityMatch[2]) : 480;
            formats.push({
              quality: `${height}p`,
              url: jsonLd.contentUrl,
              format_id: `mp4-${height}p`,
              ext: 'mp4',
              height,
              width: Math.round(height * 16 / 9),
              hasVideo: true,
              hasAudio: true,
              headers: {
                Referer: 'https://pornone.com/',
                'User-Agent': HEADERS['User-Agent'],
              },
            });
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      }
    }

    if (formats.length === 0) {
      throw new Error('No video sources found in page');
    }

    // Sort by quality (highest first)
    formats.sort((a, b) => b.height - a.height);
    console.log(`[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`);

    // Extract thumbnail from JSON-LD or og:image
    let thumbnail = null;
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        if (jsonLd.thumbnailUrl) {
          thumbnail = Array.isArray(jsonLd.thumbnailUrl) ? jsonLd.thumbnailUrl[0] : jsonLd.thumbnailUrl;
        }
      } catch (e) {
        // Ignore
      }
    }
    if (!thumbnail) {
      const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
      if (thumbMatch) thumbnail = thumbMatch[1];
    }

    return {
      title,
      formats,
      thumbnail,
      extractor: this.name,
      id: videoId,
      url,
    };
  }
}
