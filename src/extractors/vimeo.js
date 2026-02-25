/**
 * Vimeo Extractor
 * Extracts video URLs from vimeo.com
 *
 * Supports:
 *   - vimeo.com/{id}
 *   - vimeo.com/{id}/{unlisted_hash}
 *   - player.vimeo.com/video/{id}
 *   - vimeo.com/channels/{channel}/{id}
 *   - vimeo.com/groups/{group}/videos/{id}
 *
 * Flow:
 *   1. Parse video ID from URL
 *   2. Fetch player page: player.vimeo.com/video/{id}
 *   3. Extract playerConfig JSON from HTML
 *   4. Parse progressive formats (direct MP4) if available
 *   5. Parse HLS master playlist to enumerate quality variants
 *   6. Return all formats with metadata
 *
 * Progressive formats are direct MP4 downloads (fastest).
 * HLS variants are downloaded via ffmpeg.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class VimeoExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Vimeo';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|player)\.)?vimeo\.com\//i.test(url);
  }

  /**
   * Extract video ID from various Vimeo URL patterns
   */
  _extractVideoId(url) {
    // player.vimeo.com/video/{id}
    const playerMatch = url.match(/player\.vimeo\.com\/video\/(\d+)/);
    if (playerMatch) return playerMatch[1];

    // vimeo.com/channels/{ch}/{id}  or  vimeo.com/groups/{g}/videos/{id}
    const chGrpMatch = url.match(/vimeo\.com\/(?:channels\/[^/]+|groups\/[^/]+\/videos)\/(\d+)/);
    if (chGrpMatch) return chGrpMatch[1];

    // vimeo.com/album|showcase/{id}/video/{id}
    const albumMatch = url.match(/vimeo\.com\/(?:album|showcase)\/\d+\/video\/(\d+)/);
    if (albumMatch) return albumMatch[1];

    // vimeo.com/{id} or vimeo.com/{id}/{unlisted_hash}
    const simpleMatch = url.match(/vimeo\.com\/(\d+)/);
    if (simpleMatch) return simpleMatch[1];

    return null;
  }

  /**
   * Extract unlisted hash from URL (e.g. vimeo.com/123456/abcdef1234)
   */
  _extractUnlistedHash(url) {
    const m = url.match(/vimeo\.com\/\d+\/([0-9a-f]{10,})/);
    return m ? m[1] : null;
  }

  /**
   * Parse the playerConfig JSON from the player page HTML.
   * Vimeo embeds it as: playerConfig = {...}
   */
  _parsePlayerConfig(html) {
    const idx = html.indexOf('playerConfig');
    if (idx === -1) return null;

    const startBrace = html.indexOf('{', idx);
    if (startBrace === -1) return null;

    let depth = 0;
    let end = 0;
    for (let i = startBrace; i < html.length; i++) {
      if (html[i] === '{') depth++;
      if (html[i] === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }

    if (end === 0) return null;
    return JSON.parse(html.substring(startBrace, end));
  }

  /**
   * Resolve a possibly-relative URI against an HLS master playlist URL.
   */
  _resolveHlsUri(uri, masterUrlObj, basePath) {
    if (!uri || uri.startsWith('http')) return uri;
    return new URL(uri, masterUrlObj.origin + basePath).href;
  }

  /**
   * Parse the HLS master playlist to extract variant stream info.
   * For each variant, also builds a filtered single-variant m3u8
   * (with absolute URIs) so ffmpeg downloads exactly the right quality.
   *
   * Returns array of { bandwidth, width, height, fps, codecs, uri, filteredPlaylist }
   */
  _parseHlsMaster(masterPlaylist, masterUrl) {
    const lines = masterPlaylist.split('\n');
    const masterUrlObj = new URL(masterUrl);
    const basePath = masterUrlObj.pathname.substring(0, masterUrlObj.pathname.lastIndexOf('/') + 1);

    // Collect header lines and EXT-X-MEDIA lines (audio / subtitle groups)
    const headerLines = ['#EXTM3U'];
    const mediaLines = [];
    const variantRaw = []; // { infLine, uri }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line === '#EXT-X-INDEPENDENT-SEGMENTS') {
        headerLines.push(line);
        continue;
      }

      // EXT-X-MEDIA — resolve any URI attribute to absolute
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch) {
          const absUri = this._resolveHlsUri(uriMatch[1], masterUrlObj, basePath);
          mediaLines.push(line.replace(uriMatch[1], absUri));
        } else {
          mediaLines.push(line);
        }
        continue;
      }

      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      // Next non-comment, non-empty line is the variant URI
      let rawUri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) { rawUri = next; break; }
      }

      variantRaw.push({ infLine: line, rawUri });
    }

    // Build structured variants with filtered playlists
    const variants = [];
    for (const vr of variantRaw) {
      const attrs = vr.infLine.substring('#EXT-X-STREAM-INF:'.length);
      const bandwidth = parseInt((attrs.match(/BANDWIDTH=(\d+)/) || [])[1]) || 0;
      const resoMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
      const width = resoMatch ? parseInt(resoMatch[1]) : 0;
      const height = resoMatch ? parseInt(resoMatch[2]) : 0;
      const fps = parseFloat((attrs.match(/FRAME-RATE=([\d.]+)/) || [])[1]) || 0;
      const codecs = (attrs.match(/CODECS="([^"]+)"/) || [])[1] || '';
      const uri = this._resolveHlsUri(vr.rawUri, masterUrlObj, basePath);

      // Build a filtered master playlist with only this variant (all URIs absolute)
      const filteredPlaylist = [
        ...headerLines,
        ...mediaLines,
        vr.infLine,
        uri,
        '',
      ].join('\n');

      variants.push({ bandwidth, width, height, fps, codecs, uri, filteredPlaylist });
    }

    return variants;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const videoId = this._extractVideoId(url);
    if (!videoId) {
      throw new Error('Could not extract video ID from Vimeo URL');
    }
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': 'https://vimeo.com/',
    };

    // Step 1: Fetch the player embed page
    const playerUrl = `https://player.vimeo.com/video/${videoId}`;
    console.log(`[${this.name}] Fetching player page: ${playerUrl}`);

    const playerResp = await got(playerUrl, {
      headers,
      followRedirect: true,
      maxRedirects: 5,
      timeout: { request: 30000 },
    });

    // Step 2: Parse playerConfig
    let config;
    try {
      config = this._parsePlayerConfig(playerResp.body);
    } catch (e) {
      throw new Error(`Failed to parse Vimeo player config: ${e.message}`);
    }

    if (!config) {
      throw new Error('Could not find playerConfig in Vimeo player page');
    }

    // Step 3: Extract video metadata
    const video = config.video || {};
    const owner = video.owner || {};
    const title = video.title || `Vimeo ${videoId}`;
    const duration = video.duration || 0;
    const thumbnailUrl = video.thumbs?.base || video.thumbnail || null;

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Duration: ${duration}s`);

    // Step 4: Collect formats
    const formats = [];
    const files = config.request?.files || video.files || {};

    // 4a. Progressive formats (direct MP4 downloads)
    const progressive = files.progressive || [];
    for (const p of progressive) {
      if (!p.url) continue;
      formats.push({
        url: p.url,
        quality: `${p.height || p.quality}p`,
        height: p.height || 0,
        width: p.width || 0,
        ext: 'mp4',
        fps: p.fps || 0,
        mime: p.mime || 'video/mp4',
        hasVideo: true,
        hasAudio: true,
        vcodec: p.codec || 'h264',
        acodec: 'aac',
        protocol: 'https',
        formatNote: `progressive (${p.quality || ''})`,
      });
    }

    if (progressive.length > 0) {
      console.log(`[${this.name}] Found ${progressive.length} progressive format(s)`);
    }

    // 4b. HLS formats — parse master playlist for quality variants
    const hlsCdns = files.hls?.cdns || {};
    const defaultHlsCdn = files.hls?.default_cdn;
    const hlsMasterUrl = hlsCdns[defaultHlsCdn]?.url || Object.values(hlsCdns)[0]?.url;

    if (hlsMasterUrl) {
      try {
        console.log(`[${this.name}] Fetching HLS master playlist...`);
        const hlsResp = await got(hlsMasterUrl, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: { request: 15000 },
        });

        const variants = this._parseHlsMaster(hlsResp.body, hlsMasterUrl);
        console.log(`[${this.name}] HLS variants: ${variants.map(v => `${v.height}p`).join(', ')}`);

        if (variants.length > 0) {
          for (const v of variants) {
            // Extract codec info
            const codecParts = v.codecs.split(',').map(c => c.trim());
            const vcodec = codecParts.find(c => c.startsWith('avc1') || c.startsWith('hev') || c.startsWith('vp')) || '';
            const acodec = codecParts.find(c => c.startsWith('mp4a') || c.startsWith('opus')) || '';

            formats.push({
              url: hlsMasterUrl,
              quality: `${v.height}p`,
              height: v.height,
              width: v.width,
              ext: 'mp4',
              fps: v.fps || 0,
              hasVideo: true,
              hasAudio: true,
              vcodec,
              acodec,
              protocol: 'hls',
              tbr: Math.round(v.bandwidth / 1000),
              formatNote: `HLS`,
              _hlsPlaylist: v.filteredPlaylist,  // filtered single-variant m3u8
            });
          }
        } else {
          // Fallback: return master URL as single format
          formats.push({
            url: hlsMasterUrl,
            quality: `${video.height || 720}p`,
            height: video.height || 720,
            width: video.width || 1280,
            ext: 'mp4',
            hasVideo: true,
            hasAudio: true,
            protocol: 'hls',
            formatNote: 'HLS (auto quality)',
          });
        }
      } catch (hlsErr) {
        console.log(`[${this.name}] HLS fetch failed: ${hlsErr.message}, using master URL`);
        formats.push({
          url: hlsMasterUrl,
          quality: `${video.height || 720}p`,
          height: video.height || 720,
          width: video.width || 1280,
          ext: 'mp4',
          hasVideo: true,
          hasAudio: true,
          protocol: 'hls',
          formatNote: 'HLS (auto quality)',
        });
      }
    }

    // 4c. Subtitles
    const subtitles = {};
    const textTracks = config.request?.text_tracks || [];
    for (const tt of textTracks) {
      if (tt.lang && tt.url) {
        const vttUrl = tt.url.startsWith('http')
          ? tt.url
          : `https://player.vimeo.com${tt.url}`;
        subtitles[tt.lang] = {
          name: tt.label || tt.lang,
          lang: tt.lang,
          formats: { vtt: vttUrl },
        };
      }
    }

    if (formats.length === 0) {
      throw new Error('No formats found for this Vimeo video. It may be private or region-restricted.');
    }

    // Sort: progressive first, then HLS; within each group, by height descending
    formats.sort((a, b) => {
      // Progressive > HLS
      const aProto = a.protocol === 'hls' ? 1 : 0;
      const bProto = b.protocol === 'hls' ? 1 : 0;
      if (aProto !== bProto) return aProto - bProto;
      // Higher resolution first
      return (b.height || 0) - (a.height || 0);
    });

    // Deduplicate: if we have progressive + HLS at same height, keep only progressive
    const seen = new Set();
    const dedupedFormats = [];
    for (const fmt of formats) {
      const key = `${fmt.height}-${fmt.protocol}`;
      if (!seen.has(key)) {
        seen.add(key);
        dedupedFormats.push(fmt);
      }
    }

    return {
      id: videoId,
      title,
      formats: dedupedFormats,
      duration,
      thumbnail: thumbnailUrl,
      uploader: owner.name || null,
      uploaderId: owner.id || null,
      extractor: this.name,
      subtitles: Object.keys(subtitles).length ? subtitles : undefined,
      webpage_url: `https://vimeo.com/${videoId}`,
    };
  }
}
