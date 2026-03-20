/**
 * SpankBang Extractor
 * Extracts video URLs from spankbang.com
 *
 * Supports:
 *   - spankbang.com/{id}/video/{slug}
 *   - spankbang.com/{id}/play/{slug}
 *
 * Flow:
 *   1. Fetch video page via cycletls (TLS fingerprint to bypass 403)
 *   2. Parse stream_data JS variable for quality -> URL mapping
 *   3. Also extract HLS playlist URL as fallback
 */

import { BaseExtractor } from './base.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class SpankBangExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'SpankBang';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?spankbang\.com\/[a-z0-9]+\/(?:video|play|embed)\//i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/spankbang\.com\/([a-z0-9]+)\/(?:video|play|embed)\//i);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const videoPageUrl = `https://spankbang.com/${videoId}/video/`;

    // Use cycletls to bypass TLS fingerprint checks
    const { createCycleTLS } = await import('../cycletls-helper.js');
    const cycleTLS = await createCycleTLS();

    let html;
    try {
      const resp = await cycleTLS(videoPageUrl, {
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
      const h1Match = html.match(/<h1[^>]*title="([^"]+)"/i) || html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1Match) title = h1Match[1].trim();
    }
    if (!title) title = `SpankBang_${videoId}`;
    // Clean title suffix
    title = title.replace(/:\s*Porn\s*-\s*SpankBang$/i, '').trim();
    console.log(`[${this.name}] Title: ${title}`);

    const formats = [];

    // Parse stream_data JS object - it uses single-quoted JS syntax:
    // var stream_data = {'240p': ['url1'], '480p': ['url2'], ...};
    const streamDataMatch = html.match(/var\s+stream_data\s*=\s*(\{[^;]+\})/);
    if (streamDataMatch) {
      try {
        // Convert JS single-quoted object to valid JSON
        const jsObj = streamDataMatch[1];
        // Extract key-value pairs with regex
        const entries = jsObj.matchAll(/'(\d+p)'\s*:\s*\[\s*'([^']*?)'\s*\]/g);
        for (const [, quality, urlStr] of entries) {
          if (!urlStr) continue;
          const height = parseInt(quality);
          if (!height) continue;
          formats.push({
            url: urlStr,
            ext: 'mp4',
            height,
            width: Math.round(height * 16 / 9),
            quality,
            hasVideo: true,
            hasAudio: true,
            format_id: `mp4-${quality}`,
            headers: { 'Referer': 'https://spankbang.com/' },
          });
        }
      } catch (e) {
        console.error(`[${this.name}] stream_data parse error: ${e.message}`);
      }
    }

    // Extract HLS URLs
    const hlsMatches = html.matchAll(/https?:\/\/hls[^"'\s]*\.m3u8[^"'\s]*/g);
    for (const hm of hlsMatches) {
      const hlsUrl = hm[0];
      if (!formats.some(f => f.url === hlsUrl)) {
        formats.push({
          url: hlsUrl,
          ext: 'mp4',
          height: 0,
          quality: 'auto',
          protocol: 'hls',
          hasVideo: true,
          hasAudio: true,
          format_id: 'hls-auto',
          formatNote: 'HLS',
        });
      }
    }

    // Fallback: <source src=""> for the main video player
    if (formats.length === 0) {
      const sourceMatch = html.match(/<source\s+src="(https:\/\/vdownload[^"]+)"/);
      if (sourceMatch) {
        formats.push({
          url: sourceMatch[1],
          ext: 'mp4',
          height: 480,
          quality: '480p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'mp4-source',
          headers: { 'Referer': 'https://spankbang.com/' },
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found on SpankBang page');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    const thumbnail = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || '';

    return {
      id: videoId,
      title,
      formats,
      thumbnail,
      extractor: this.name,
      url,
    };
  }
}

export default SpankBangExtractor;
