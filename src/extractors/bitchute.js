/**
 * Bitchute Extractor
 * Extracts video URLs from bitchute.com
 *
 * Supports:
 *   - bitchute.com/video/{id}/
 *
 * Flow:
 *   1. Fetch video page via cycletls (TLS fingerprint to bypass Cloudflare)
 *   2. Extract <source src="..."> or og:video from the page
 *   3. Video is a direct MP4 URL from CDN
 */

import { BaseExtractor } from './base.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class BitchuteExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Bitchute';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?bitchute\.com\/video\/[a-zA-Z0-9]+/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/bitchute\.com\/video\/([a-zA-Z0-9]+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Use cycletls to bypass Cloudflare TLS fingerprint checks
    const { createCycleTLS } = await import('../cycletls-helper.js');
    const cycleTLS = await createCycleTLS();

    let html;
    try {
      const resp = await cycleTLS(url, {
        body: '',
        ja3: CHROME_JA3,
        userAgent: USER_AGENT,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }, 'get');

      html = await resp.text();
      if (!html || html.length < 1000) {
        throw new Error(`Page returned insufficient content (${html?.length || 0} bytes)`);
      }
    } finally {
      cycleTLS.exit();
    }

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle) title = ogTitle[1];
    if (!title) {
      const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleMatch) title = titleMatch[1].replace(/\s*[-|]\s*BitChute\s*$/i, '').trim();
    }
    if (!title) title = `Bitchute_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract video source URL from multiple possible locations
    let videoUrl = null;
    const sourceMatch = html.match(/<source\s+src="([^"]+)"/i);
    const ogVideo = html.match(/<meta[^>]+property="og:video(?::secure_url|:url)?"[^>]+content="([^"]+)"/i);
    // Also try data attributes and JS variables
    const dataSrc = html.match(/data-src="(https?:\/\/[^"]*\.mp4[^"]*)"/i);
    const jsSrc = html.match(/(?:videoUrl|source|video_url)\s*[:=]\s*['"]?(https?:\/\/[^'"\s]+\.mp4[^'"\s]*)/i);

    if (sourceMatch) videoUrl = sourceMatch[1];
    else if (ogVideo) videoUrl = ogVideo[1];
    else if (dataSrc) videoUrl = dataSrc[1];
    else if (jsSrc) videoUrl = jsSrc[1];

    if (!videoUrl) {
      throw new Error(
        'Could not find video URL on Bitchute page. ' +
        'Bitchute may require JavaScript rendering for this video.'
      );
    }

    videoUrl = videoUrl.replace(/&amp;/g, '&');
    if (videoUrl.startsWith('//')) videoUrl = 'https:' + videoUrl;

    const ogWidth = html.match(/<meta[^>]+property="og:video:width"[^>]+content="(\d+)"/i);
    const ogHeight = html.match(/<meta[^>]+property="og:video:height"[^>]+content="(\d+)"/i);
    const height = ogHeight ? parseInt(ogHeight[1]) : 720;
    const width = ogWidth ? parseInt(ogWidth[1]) : Math.round(height * 16 / 9);

    const thumbnail = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || '';

    const formats = [{
      url: videoUrl,
      ext: 'mp4',
      height,
      width,
      quality: `${height}p`,
      hasVideo: true,
      hasAudio: true,
      format_id: `mp4-${height}p`,
      headers: { 'Referer': 'https://www.bitchute.com/' },
    }];

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

export default BitchuteExtractor;
