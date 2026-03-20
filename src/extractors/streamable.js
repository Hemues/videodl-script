/**
 * Streamable Extractor
 * Extracts video URLs from streamable.com
 *
 * Supports:
 *   - streamable.com/{shortcode}
 *
 * Flow:
 *   1. Extract shortcode from URL
 *   2. Fetch video page and extract __data JSON (or use OEmbed/page parsing)
 *   3. Collect MP4 formats from files object
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class StreamableExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Streamable';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?streamable\.com\/(?!login|signup|recover|settings|privacy|terms|account|upload)[a-z0-9]+/i.test(url);
  }

  _decodeEntities(text) {
    return text
      .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#x27;/g, "'")
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/streamable\.com\/([a-z0-9]+)/i);
    if (!idMatch) throw new Error('Could not extract video ID from Streamable URL');

    const videoId = idMatch[1];
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Fetch the video page
    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: { request: 20000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title from og:title or <title>
    let title = null;
    const ogTitleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                         html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    if (ogTitleMatch) title = this._decodeEntities(ogTitleMatch[1]);
    if (!title) {
      const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleMatch) title = this._decodeEntities(titleMatch[1]).replace(/\s*[-|]\s*Streamable\s*$/i, '').trim();
    }
    // Also strip "Watch " prefix and " | Streamable" suffix
    if (title) title = title.replace(/^Watch\s+[""]?/i, '').replace(/[""]?\s*\|\s*Streamable\s*$/i, '').trim();
    if (!title) title = `Streamable_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract video URL from og:video meta tag or video source
    const formats = [];

    // Try og:video:url — direct MP4 link
    const ogVideoMatch = html.match(/<meta[^>]+property="og:video:url"[^>]+content="([^"]+)"/i) ||
                         html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video:url"/i);
    // og:video:width/height
    const ogWidth = html.match(/<meta[^>]+property="og:video:width"[^>]+content="(\d+)"/i);
    const ogHeight = html.match(/<meta[^>]+property="og:video:height"[^>]+content="(\d+)"/i);

    if (ogVideoMatch) {
      let videoUrl = ogVideoMatch[1].replace(/&amp;/g, '&');
      if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;

      const height = ogHeight ? parseInt(ogHeight[1]) : 720;
      const width = ogWidth ? parseInt(ogWidth[1]) : Math.round(height * 16 / 9);

      formats.push({
        url: videoUrl,
        ext: 'mp4',
        height,
        width,
        quality: `${height}p`,
        hasVideo: true,
        hasAudio: true,
        format_id: `mp4-${height}p`,
      });
    }

    // Try to find additional formats from page scripts (JSON data)
    const scriptMatch = html.match(/var\s+videoObject\s*=\s*({[\s\S]*?});/) ||
                        html.match(/"files"\s*:\s*({[^}]+(?:{[^}]*}[^}]*)*)}/);

    // Also try the meta video:secure_url or source tags
    const sourceMatches = html.matchAll(/<source[^>]+src="([^"]+)"[^>]*type="video\/mp4"[^>]*/gi);
    for (const sm of sourceMatches) {
      let src = sm[1].replace(/&amp;/g, '&');
      if (src.startsWith('//')) src = 'https:' + src;
      // Avoid duplicate
      if (!formats.some(f => f.url === src)) {
        formats.push({
          url: src,
          ext: 'mp4',
          height: 720,
          width: 1280,
          quality: '720p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'mp4-source',
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found on Streamable page');
    }

    const thumbnail = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || '';

    console.log(`[${this.name}] Found ${formats.length} format(s)`);
    return {
      id: videoId,
      title,
      formats,
      thumbnail: thumbnail.startsWith('//') ? 'https:' + thumbnail : thumbnail,
      extractor: this.name,
      url,
    };
  }
}

export default StreamableExtractor;
