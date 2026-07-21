/**
 * Eporner Extractor
 * Extracts video URLs from eporner.com
 *
 * Supports:
 *   - eporner.com/video-{hash}/{slug}/
 *
 * Flow:
 *   1. Fetch video page, capture cookies
 *   2. Extract EP.video.player.vid and EP.video.player.hash
 *   3. Compute encoded hash (hex → base36 conversion)
 *   4. Call /xhr/video/{vid} API with computed hash + cookies
 *   5. Parse response for direct CDN MP4 URLs and HLS playlist
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

  /**
   * Compute the encoded hash the same way the eporner player does:
   * Split the 32-char hex hash into 4 groups of 8, parse each as hex int,
   * convert to base-36 string, and concatenate.
   */
  _computeHash(hash) {
    if (!hash || hash.length !== 32) return false;
    return parseInt(hash.substring(0, 8), 16).toString(36) +
           parseInt(hash.substring(8, 16), 16).toString(36) +
           parseInt(hash.substring(16, 24), 16).toString(36) +
           parseInt(hash.substring(24, 32), 16).toString(36);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/eporner\.com\/(?:video-|hd-porno\/)([a-zA-Z0-9]+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Step 1: Fetch page and capture cookies
    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    const setCookies = response.headers['set-cookie'];
    const cookieStr = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .filter(Boolean)
      .map(c => c.split(';')[0])
      .join('; ');

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    if (ogTitle) title = ogTitle[1];
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) title = titleTag[1];
    }
    if (title) title = title.replace(/\s*-\s*EPORNER.*$/i, '').trim();
    if (!title) title = `Eporner_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract duration
    let duration = 0;
    const durMatch = html.match(/<meta\s+property=["']og:(?:video:)?duration["']\s+content=["'](\d+)["']/i)
                  || html.match(/"duration"\s*:\s*"?PT?(\d[^"]*)"?/i);
    if (durMatch) {
      const raw = durMatch[1];
      if (/^\d+$/.test(raw)) {
        duration = parseInt(raw);
      } else {
        const hm = raw.match(/(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (hm) duration = (parseInt(hm[1] || 0) * 3600) + (parseInt(hm[2] || 0) * 60) + parseInt(hm[3] || 0);
      }
    }

    // Step 2: Extract player vid and hash
    const vidMatch = html.match(/EP\.video\.player\.vid\s*=\s*'([^']+)'/);
    const hashMatch = html.match(/EP\.video\.player\.hash\s*=\s*'([^']+)'/);
    const playerVid = vidMatch ? vidMatch[1] : videoId;
    const rawHash = hashMatch ? hashMatch[1] : null;

    const formats = [];

    // Step 3+4: Use XHR API for direct CDN URLs (preferred)
    if (rawHash) {
      const computedHash = this._computeHash(rawHash);
      console.log(`[${this.name}] Player hash found, calling video API...`);

      const params = new URLSearchParams({
        hash: computedHash,
        domain: 'www.eporner.com',
        pixelRatio: '1',
        playerWidth: '920',
        playerHeight: '518',
        fallback: 'false',
        embed: 'false',
        supportedFormats: 'dash,hls',
        _: Date.now().toString(),
      });
      const xhrUrl = `https://www.eporner.com/xhr/video/${playerVid}?${params.toString()}`;

      try {
        const xhrResp = await got(xhrUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            'Referer': url,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': cookieStr,
            'Accept': '*/*',
          },
          timeout: { request: 15000 },
          throwHttpErrors: false,
        });

        const data = JSON.parse(xhrResp.body);

        if (data.available && data.sources) {
          // Add MP4 sources
          if (data.sources.mp4) {
            for (const [label, info] of Object.entries(data.sources.mp4)) {
              if (!info.src || info.src.includes('na.mp4')) continue;
              const hMatch = (info.labelShort || label).match(/(\d+)p/);
              const height = hMatch ? parseInt(hMatch[1]) : 480;
              formats.push({
                url: info.src,
                ext: 'mp4',
                height,
                width: Math.round(height * 16 / 9),
                quality: info.labelShort || `${height}p`,
                hasVideo: true,
                hasAudio: true,
                format_id: `mp4-${height}p`,
                isDefault: !!info.default,
              });
            }
          }

          // Add HLS source
          if (data.sources.hls && data.sources.hls.auto && data.sources.hls.auto.src) {
            formats.push({
              url: data.sources.hls.auto.src,
              ext: 'mp4',
              height: 0,
              quality: 'auto (HLS)',
              protocol: 'hls',
              hasVideo: true,
              hasAudio: true,
              format_id: 'hls-auto',
              formatNote: 'HLS adaptive',
            });
          }
        } else {
          console.log(`[${this.name}] API returned available=false (code ${data.code}), falling back to dload links`);
        }
      } catch (e) {
        console.log(`[${this.name}] API call failed: ${e.message}, falling back to dload links`);
      }
    }

    // Fallback: dload links (only for qualities that don't require login)
    if (formats.length === 0) {
      console.log(`[${this.name}] Using dload link fallback...`);
      const dloadMatches = html.matchAll(/\/dload\/[^"'\s]+/g);
      const seenQualities = new Set();
      for (const match of dloadMatches) {
        const path = match[0];
        const qualityMatch = path.match(/\/(\d{3,4})\//);
        if (qualityMatch) {
          const height = parseInt(qualityMatch[1]);
          if (path.includes('-av1')) continue; // Skip AV1 variants in fallback
          if (!seenQualities.has(height)) {
            seenQualities.add(height);
            formats.push({
              url: `https://www.eporner.com${path}`,
              ext: 'mp4',
              height,
              width: Math.round(height * 16 / 9),
              quality: `${height}p`,
              hasVideo: true,
              hasAudio: true,
              format_id: `mp4-dload-${height}p`,
              headers: {
                'Referer': url,
                'User-Agent': USER_AGENT,
              },
            });
          }
        }
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
