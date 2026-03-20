/**
 * Dailymotion Extractor
 * Extracts video URLs from dailymotion.com
 *
 * Supports:
 *   - dailymotion.com/video/{id}
 *   - dai.ly/{id}
 *   - dailymotion.com/embed/video/{id}
 *
 * Flow:
 *   1. Parse video ID from URL
 *   2. Call Dailymotion's player metadata API to get title, duration, HLS URL
 *   3. Fetch HLS master playlist via cycletls (TLS fingerprint impersonation)
 *      — Dailymotion's CDN (cdndirector.dailymotion.com) blocks Node.js TLS
 *        fingerprint with 403. Same issue yt-dlp solves with curl_cffi.
 *   4. Parse HLS variants (the variant m3u8 URLs on vod*.cf.dmcdn.net work
 *      without impersonation, so ffmpeg can download them directly)
 *   5. Also collect any progressive HTTP URLs from the metadata qualities
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class DailymotionExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Dailymotion';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www\.)?dailymotion\.com|dai\.ly)\//i.test(url);
  }

  _extractVideoId(url) {
    const shortMatch = url.match(/dai\.ly\/([a-zA-Z0-9]+)/);
    if (shortMatch) return shortMatch[1];

    const embedMatch = url.match(/dailymotion\.com\/embed\/video\/([a-zA-Z0-9]+)/);
    if (embedMatch) return embedMatch[1];

    const videoMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/);
    if (videoMatch) return videoMatch[1];

    return null;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const videoId = this._extractVideoId(url);
    if (!videoId) {
      throw new Error('Could not extract video ID from Dailymotion URL');
    }
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Fetch player metadata API
    const metadataUrl = `https://www.dailymotion.com/player/metadata/video/${videoId}`;
    console.log(`[${this.name}] Fetching metadata...`);

    const metaResp = await got(metadataUrl, {
      headers: { 'User-Agent': USER_AGENT },
      responseType: 'json',
      timeout: { request: 20000 },
    });

    const data = metaResp.body;
    if (!data) {
      throw new Error('No metadata returned from Dailymotion API');
    }

    if (data.error) {
      const errMsg = data.error.message || data.error.title || 'Unknown error';
      throw new Error(`Dailymotion API error: ${errMsg}`);
    }

    const title = data.title || `Dailymotion ${videoId}`;
    const duration = data.duration || 0;
    const owner = data.owner?.screenname || '';
    console.log(`[${this.name}] Title: ${title}`);
    if (owner) console.log(`[${this.name}] Uploader: ${owner}`);
    if (duration) console.log(`[${this.name}] Duration: ${Math.floor(duration / 60)}m ${duration % 60}s`);

    const formats = [];
    const qualities = data.qualities || {};

    // Collect any progressive HTTP URLs (e.g. /H264-WxH/...)
    for (const [qualityKey, sources] of Object.entries(qualities)) {
      if (qualityKey === 'auto') continue;
      const height = parseInt(qualityKey);
      if (!height || !Array.isArray(sources)) continue;

      for (const source of sources) {
        if (!source.url || source.type === 'application/vnd.lumberjack.manifest') continue;

        if (source.type === 'video/mp4') {
          // Try to extract resolution from URL path like /H264-640x352-(60)/
          const urlReso = source.url.match(/\/H264-(\d+)x(\d+)(?:-(\d+))?/);
          formats.push({
            url: source.url,
            ext: 'mp4',
            height: urlReso ? parseInt(urlReso[2]) : height,
            width: urlReso ? parseInt(urlReso[1]) : Math.round(height * (16 / 9)),
            fps: urlReso?.[3] ? parseInt(urlReso[3]) : 0,
            quality: `${height}p`,
            type: 'progressive',
            hasVideo: true,
            hasAudio: true,
          });
        }
      }
    }

    // Parse HLS master playlist for quality variants
    // The master URL is at cdndirector.dailymotion.com which blocks Node.js
    // TLS fingerprint — use cycletls (Chrome JA3 impersonation)
    const autoSources = qualities.auto;
    if (Array.isArray(autoSources)) {
      for (const source of autoSources) {
        if (source.type === 'application/x-mpegURL' && source.url) {
          try {
            await this._parseHlsMaster(source.url, formats);
          } catch (e) {
            console.log(`[${this.name}] HLS master parsing failed: ${e.message}`);
          }
        }
      }
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found');
    }

    // Sort: highest quality first, prefer HLS (has all qualities) over progressive
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Found ${formats.length} format(s):`);
    for (const f of formats) {
      console.log(`  ${f.quality} ${f.type || 'hls'} (${f.ext})`);
    }

    return {
      id: videoId,
      title,
      formats,
      thumbnail: data.posters?.['1080'] || data.posters?.['720'] || data.posters?.['480'] || '',
      duration,
      uploader: owner,
      source: 'dailymotion',
    };
  }

  /**
   * Fetch & parse HLS master playlist using cycletls for TLS impersonation.
   * Dailymotion's CDN (cdndirector.dailymotion.com) returns 403 for requests
   * with Node.js's OpenSSL TLS fingerprint. cycletls uses utls to present
   * Chrome's JA3 fingerprint, bypassing the block.
   * The individual variant URLs (vod*.cf.dmcdn.net) work without impersonation.
   */
  async _parseHlsMaster(masterUrl, formats) {
    console.log(`[${this.name}] Fetching HLS master (TLS impersonation)...`);

    const { default: initCycleTLS } = await import('cycletls');
    const cycleTLS = await initCycleTLS();

    try {
      const resp = await cycleTLS(masterUrl, {
        body: '',
        ja3: CHROME_JA3,
        userAgent: USER_AGENT,
        headers: { 'Accept': '*/*' },
      }, 'get');

      if (resp.status !== 200) {
        throw new Error(`CDN returned HTTP ${resp.status}`);
      }

      const body = await resp.text();
      const lines = body.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

        const resoMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        const codecsMatch = line.match(/CODECS="([^"]+)"/);
        const nameMatch = line.match(/NAME="([^"]+)"/);
        const height = resoMatch ? parseInt(resoMatch[2]) : 0;

        // Next non-comment, non-empty line is the variant URI
        let uri = '';
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j].trim();
          if (next && !next.startsWith('#')) {
            uri = next;
            break;
          }
        }

        if (!uri || !height) continue;

        // Strip fragment (#cell=cf3 etc)
        uri = uri.split('#')[0];

        const codecParts = (codecsMatch?.[1] || '').split(',').map(c => c.trim());
        const vcodec = codecParts.find(c => c.startsWith('avc1') || c.startsWith('hev') || c.startsWith('vp')) || '';
        const acodec = codecParts.find(c => c.startsWith('mp4a') || c.startsWith('opus')) || '';

        formats.push({
          url: uri,
          ext: 'mp4',
          height,
          width: resoMatch ? parseInt(resoMatch[1]) : Math.round(height * (16 / 9)),
          quality: `${nameMatch?.[1] || height}p`,
          protocol: 'hls',
          hasVideo: true,
          hasAudio: true,
          vcodec,
          acodec,
          tbr: bandwidthMatch ? Math.round(parseInt(bandwidthMatch[1]) / 1000) : 0,
          formatNote: 'HLS',
        });
      }

      console.log(`[${this.name}] Parsed ${formats.length} HLS variant(s)`);
    } finally {
      cycleTLS.exit();
    }
  }
}
