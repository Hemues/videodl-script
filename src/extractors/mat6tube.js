/**
 * Mat6tube Extractor
 * Extracts video URLs from mat6tube.com
 *
 * Flow:
 *   1. Fetch video page via standard HTTP.
 *   2. Extract og:title for video title.
 *   3. Parse window.playlist JSON for JWPlayer sources (CDN MP4 URLs at multiple qualities).
 *
 * URL format: https://mat6tube.com/watch/{owner_id}_{video_id}
 * CDN: pvvstream.pro (time-limited signed URLs)
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class Mat6tubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Mat6tube';
  }

  static canHandle(url) {
    return /mat6tube\.com\/watch\//i.test(url);
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

    // Extract video ID from URL: /watch/{owner_id}_{video_id}
    const idMatch = url.match(/\/watch\/(-?\d+_\d+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title from og:title
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) {
        title = this._decodeHtmlEntities(titleTag[1])
          .replace(/\s*[-|]\s*BEST XXX TUBE.*$/i, '')
          .trim();
      }
    }
    if (!title) title = `Mat6tube_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract duration from meta tag (seconds)
    let duration = null;
    const durMatch = html.match(/<meta\s+property=["']video:duration["']\s+content=["'](\d+)["']/i);
    if (durMatch) duration = parseInt(durMatch[1]);

    // Extract thumbnail
    let thumbnail = null;
    const ogImage = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
    if (ogImage) thumbnail = ogImage[1];

    // Extract window.playlist JSON for JWPlayer sources
    const formats = [];
    const playlistMatch = html.match(/window\.playlist\s*=\s*(\{[\s\S]*?\});/);
    if (playlistMatch) {
      try {
        const playlist = JSON.parse(playlistMatch[1]);
        if (playlist.sources && Array.isArray(playlist.sources)) {
          for (const src of playlist.sources) {
            if (!src.file || src.type !== 'mp4') continue;
            const label = src.label || '0';
            const height = parseInt(label) || 0;
            formats.push({
              quality: `${height}p`,
              url: src.file,
              format_id: `mp4_${label}`,
              ext: 'mp4',
              height,
              width: 0,
              protocol: 'https',
              hasVideo: true,
              hasAudio: true,
              vcodec: null,
              acodec: null,
              filesize: null,
              bitrate: null,
              headers: {
                Referer: 'https://mat6tube.com/',
                'User-Agent': USER_AGENT,
              },
              fallbackUrl: null,
              cfProtected: false,
              _hlsPlaylist: null,
            });
          }
        }
      } catch (e) {
        console.log(`[${this.name}] Failed to parse window.playlist: ${e.message}`);
      }
    }

    // Sort by height descending
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable video sources found on page');
    }

    return {
      id: videoId,
      title,
      formats,
      url,
      extractor: this.name,
      _type: 'video',
      subtitles: {},
      translationLanguages: [],
      thumbnail,
      duration,
      webpage_url: url,
    };
  }
}

export default Mat6tubeExtractor;
