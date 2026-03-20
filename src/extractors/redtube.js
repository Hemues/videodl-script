/**
 * RedTube Extractor
 * Extracts video URLs from redtube.com
 *
 * RedTube is part of the Aylo/MindGeek network (same as PornHub).
 * Page contains `playervars` with `mediaDefinitions` (remote).
 * Each mediaDefinition has a relative videoUrl → fetched from
 * https://www.redtube.com/media/{hls|mp4}?s=... → returns JSON
 * array with direct CDN URLs per quality.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

const AGE_COOKIES = 'accessAgeDisclaimerPH=1; accessAgeDisclaimerUK=1; accessPH=1; accessAgeDisclaimerRT=1; cookiesBannerOTDismissed=1';

export class RedTubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'RedTube';
  }

  static canHandle(url) {
    return /redtube\.com/i.test(url);
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

    // Extract video ID from URL (numeric path segment)
    const idMatch = url.match(/redtube\.com\/(\d+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';

    // Fetch the page
    const response = await got(url, {
      headers: { ...HEADERS, Cookie: AGE_COOKIES, Referer: 'https://www.redtube.com/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>([^<]+)<\/title>/);
      if (titleTag) {
        title = this._decodeHtmlEntities(titleTag[1])
          .replace(/\s*-\s*Free.*$/i, '')
          .trim();
      }
    }
    if (!title) title = `RedTube_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract duration
    let duration = 0;
    const durMatch = html.match(/"video_duration"\s*:\s*"?(\d+)"?/) || html.match(/"duration"\s*:\s*"?(\d{2,})"?/);
    if (durMatch) duration = parseInt(durMatch[1]);

    // Extract mediaDefinitions from playervars
    const mdMatch = html.match(/"mediaDefinitions"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
    if (!mdMatch) {
      throw new Error('Could not find mediaDefinitions in page');
    }

    let mediaDefs;
    try {
      mediaDefs = JSON.parse(mdMatch[1]);
    } catch (e) {
      throw new Error(`Failed to parse mediaDefinitions: ${e.message}`);
    }

    const standardHeaders = {
      'Referer': url,
      'Origin': 'https://www.redtube.com',
      'User-Agent': HEADERS['User-Agent'],
    };

    const formats = [];

    // Process each mediaDefinition (typically hls + mp4, both remote)
    for (const md of mediaDefs) {
      if (!md.videoUrl) continue;

      const resolvedUrl = md.videoUrl.startsWith('/')
        ? 'https://www.redtube.com' + md.videoUrl
        : md.videoUrl;

      if (md.remote) {
        // Remote: fetch the URL to get actual format list
        try {
          const resp = await got(resolvedUrl, {
            headers: { ...standardHeaders, Cookie: AGE_COOKIES },
            timeout: { request: 15000 },
          });

          let items;
          try {
            items = JSON.parse(resp.body);
          } catch {
            // Might be an HLS playlist directly
            if (resp.body.includes('#EXTM3U')) {
              formats.push({
                quality: md.quality ? `${md.quality}p` : 'hls',
                url: resolvedUrl,
                format_id: 'hls',
                ext: 'm3u8',
                protocol: 'hls',
                headers: standardHeaders,
              });
            }
            continue;
          }

          if (!Array.isArray(items)) continue;

          for (const item of items) {
            if (!item.videoUrl || !item.quality) continue;

            const quality = String(item.quality).includes('p') ? item.quality : `${item.quality}p`;
            const height = parseInt(item.quality) || 0;
            const width = item.width || Math.round(height * 16 / 9);
            const format = item.format || md.format || 'mp4';
            const isHls = format === 'hls';

            formats.push({
              quality,
              url: item.videoUrl,
              width,
              height: item.height || height,
              format_id: `${format}-${quality}`,
              ext: isHls ? 'm3u8' : 'mp4',
              protocol: isHls ? 'hls' : 'https',
              defaultQuality: item.defaultQuality || false,
              headers: standardHeaders,
            });
          }
        } catch (e) {
          console.log(`[${this.name}] Failed to fetch remote ${md.format}: ${e.message}`);
        }
      } else {
        // Direct URL in mediaDefinition
        const quality = md.quality ? `${md.quality}p` : 'unknown';
        const height = parseInt(md.quality) || 0;
        formats.push({
          quality,
          url: resolvedUrl,
          width: md.width || Math.round(height * 16 / 9),
          height: md.height || height,
          format_id: `${md.format || 'mp4'}-${quality}`,
          ext: md.format === 'hls' ? 'm3u8' : 'mp4',
          protocol: md.format === 'hls' ? 'hls' : 'https',
          headers: standardHeaders,
        });
      }
    }

    // Prefer MP4 over HLS, sort by height descending
    formats.sort((a, b) => {
      // MP4 first
      if (a.ext === 'mp4' && b.ext !== 'mp4') return -1;
      if (a.ext !== 'mp4' && b.ext === 'mp4') return 1;
      return (b.height || 0) - (a.height || 0);
    });

    console.log(`[${this.name}] Found ${formats.length} formats`);

    if (formats.length === 0) {
      throw new Error('No downloadable formats found');
    }

    return {
      id: videoId,
      title,
      duration,
      formats,
      url,
      extractor: this.name,
    };
  }
}

export default RedTubeExtractor;
