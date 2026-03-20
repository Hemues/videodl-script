/**
 * Eporner Extractor
 * Extracts video URLs from eporner.com
 *
 * Supports:
 *   - eporner.com/video-{hash}/{slug}/
 *
 * Flow:
 *   1. Fetch video page
 *   2. Extract video hash and download links
 *   3. Eporner provides direct MP4 download links at various qualities
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class EpornerExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Eporner';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?eporner\.com\/(?:video-|hd-porno\/)/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/eporner\.com\/(?:video-|hd-porno\/)([a-zA-Z0-9]+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    if (ogTitle) title = ogTitle[1];
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) title = titleTag[1].replace(/\s*-\s*EPORNER.*$/i, '').trim();
    }
    if (!title) title = `Eporner_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract duration (seconds)
    let duration = 0;
    const durMatch = html.match(/<meta\s+property=["']og:(?:video:)?duration["']\s+content=["'](\d+)["']/i)
                  || html.match(/"duration"\s*:\s*(\d{2,})/);
    if (durMatch) duration = parseInt(durMatch[1]);

    const formats = [];

    // Extract download links - pattern: /dload/{id}/{quality}/{filename}.mp4
    const dloadMatches = html.matchAll(/\/dload\/[^"'\s]+/g);
    const seenQualities = new Set();
    for (const match of dloadMatches) {
      const path = match[0];
      // Extract quality from path like /dload/xxx/720/xxx-720p.mp4
      const qualityMatch = path.match(/\/(\d{3,4})\//);
      if (qualityMatch) {
        const height = parseInt(qualityMatch[1]);
        // Prefer non-av1 variants
        const isAv1 = path.includes('-av1');
        const key = `${height}${isAv1 ? '-av1' : ''}`;
        if (!seenQualities.has(key)) {
          seenQualities.add(key);
          formats.push({
            url: `https://www.eporner.com${path}`,
            ext: 'mp4',
            height,
            width: Math.round(height * 16 / 9),
            quality: `${height}p${isAv1 ? ' (AV1)' : ''}`,
            hasVideo: true,
            hasAudio: true,
            format_id: `mp4-${height}p${isAv1 ? '-av1' : ''}`,
            headers: {
              'Referer': url,
              'User-Agent': USER_AGENT,
            },
          });
        }
      }
    }

    // Try to extract the video player config
    const configMatch = html.match(/var\s+EP\s*=\s*\{([\s\S]*?)\};/) ||
                        html.match(/vid_info\s*=\s*\{([\s\S]*?)\};/);

    // Also try to find HLS source
    const hlsMatch = html.match(/['"](?:hls|m3u8)['"]:\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
    if (hlsMatch) {
      let hlsUrl = hlsMatch[1].replace(/\\/g, '');
      if (hlsUrl.startsWith('//')) hlsUrl = 'https:' + hlsUrl;
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

    // Look for direct video source URLs in script tags
    const sourceMatches = html.matchAll(/['"](?:src|file|video_url|url)['"]:\s*['"]([^'"]+\.mp4[^'"]*)['"]/gi);
    for (const sm of sourceMatches) {
      let src = sm[1].replace(/\\/g, '');
      if (src.startsWith('//')) src = 'https:' + src;
      if (!formats.some(f => f.url === src)) {
        const hMatch = src.match(/(\d{3,4})p/);
        const height = hMatch ? parseInt(hMatch[1]) : 480;
        formats.push({
          url: src,
          ext: 'mp4',
          height,
          width: Math.round(height * 16 / 9),
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: true,
          format_id: `mp4-script-${height}p`,
        });
      }
    }

    // Fallback: og:video
    if (formats.length === 0) {
      const ogVideo = html.match(/<meta[^>]+property="og:video(?::url|:secure_url)?"[^>]+content="([^"]+)"/i);
      if (ogVideo) {
        formats.push({
          url: ogVideo[1].replace(/&amp;/g, '&'),
          ext: 'mp4',
          height: 720,
          quality: '720p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'og-video',
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found on Eporner page');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    const thumbnail = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || [])[1] || '';

    return {
      id: videoId,
      title,
      duration,
      formats,
      thumbnail,
      extractor: this.name,
      url,
    };
  }
}

export default EpornerExtractor;
