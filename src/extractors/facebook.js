/**
 * Facebook Video Extractor
 * Extracts video URLs from facebook.com
 *
 * Supports:
 *   - facebook.com/watch/?v={id}
 *   - facebook.com/{user}/videos/{id}
 *   - facebook.com/video.php?v={id}
 *   - facebook.com/reel/{id}
 *   - facebook.com/{user}/posts/{id}  (with embedded video)
 *   - fb.watch/{short}
 *
 * Flow:
 *   1. Parse video ID from URL (resolve fb.watch short links)
 *   2. Fetch main page for title metadata
 *   3. Fetch embed plugin: /plugins/video.php?href=...&show_text=false
 *   4. Parse videoData JSON from embed HTML
 *   5. Extract progressive formats (sd_src, hd_src)
 *   6. Parse inline DASH manifest for additional DASH formats
 *   7. Return all formats with metadata
 *
 * Progressive formats are direct MP4 downloads (fastest, combined V+A).
 * DASH formats provide separate video-only and audio-only streams for
 * better quality selection (AV1, VP9, H.264 variants).
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class FacebookExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Facebook';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|m|mbasic|web)\.)?facebook\.com\//i.test(url) ||
           /(?:^|\/\/)fb\.watch\//i.test(url);
  }

  /**
   * Extract video ID from various Facebook URL patterns
   */
  _extractVideoId(url) {
    // /watch/?v={id}
    const watchMatch = url.match(/[?&]v=(\d+)/);
    if (watchMatch) return watchMatch[1];

    // /video.php?v={id}
    const phpMatch = url.match(/video\.php\?.*?v=(\d+)/);
    if (phpMatch) return phpMatch[1];

    // /{user}/videos/{id}  or  /videos/{id}
    const videosMatch = url.match(/\/videos\/(\d+)/);
    if (videosMatch) return videosMatch[1];

    // /reel/{id}
    const reelMatch = url.match(/\/reel\/(\d+)/);
    if (reelMatch) return reelMatch[1];

    // /{user}/posts/{id} — id may or may not be the video id
    const postsMatch = url.match(/\/posts\/(\d+)/);
    if (postsMatch) return postsMatch[1];

    // Fallback: any long numeric string in the path
    const numMatch = url.match(/\/(\d{10,})/);
    if (numMatch) return numMatch[1];

    return null;
  }

  /**
   * Resolve fb.watch short links to full facebook.com URLs
   */
  async _resolveShortUrl(url) {
    if (!/fb\.watch\//i.test(url)) return url;

    const resp = await got(url, {
      headers: { 'User-Agent': USER_AGENT },
      followRedirect: true,
      timeout: { request: 10000 }
    });
    return resp.url; // final redirected URL
  }

  /**
   * Fetch the main Facebook page and extract the title from Relay metadata
   */
  async _fetchTitle(videoId) {
    try {
      const resp = await got(`https://www.facebook.com/watch/?v=${videoId}`, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Language': 'en-US,en;q=0.9',
          'Cookie': 'locale=en_US; wd=1920x1080',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
        },
        followRedirect: true,
        timeout: { request: 15000 }
      });
      const html = resp.body;

      // Try Relay metadata: "meta":{"title":"..."}
      const metaTitle = html.match(/"meta":\s*\{[^}]*"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
      if (metaTitle) {
        return this._unescapeJson(metaTitle[1]);
      }

      // Try og:title
      const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
      if (ogTitle) return this._htmlDecode(ogTitle[1]);

      // Try <title> tag
      const titleTag = html.match(/<title[^>]*>([^<]+)<\/title>/);
      if (titleTag && titleTag[1] !== 'Facebook') return this._htmlDecode(titleTag[1]);

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the embed plugin page and extract videoData + DASH manifest
   */
  async _fetchEmbedData(videoId) {
    const embedUrl = `https://www.facebook.com/plugins/video.php?href=https%3A%2F%2Fwww.facebook.com%2Fwatch%2F%3Fv%3D${videoId}&show_text=false&width=560`;
    const resp = await got(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      followRedirect: true,
      timeout: { request: 15000 }
    });
    return resp.body;
  }

  /**
   * Parse the videoData JSON array from the embed HTML using bracket matching
   */
  _parseVideoData(html) {
    const idx = html.indexOf('"videoData"');
    if (idx === -1) return null;

    const startBracket = html.indexOf('[', idx);
    if (startBracket === -1 || startBracket - idx > 20) return null;

    let depth = 0, end = 0;
    for (let i = startBracket; i < Math.min(html.length, startBracket + 500000); i++) {
      if (html[i] === '[') depth++;
      if (html[i] === ']') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === 0) return null;

    const jsonStr = html.substring(startBracket, end);
    try {
      return JSON.parse(jsonStr);
    } catch {
      return null;
    }
  }

  /**
   * Parse the DASH manifest XML to extract individual video/audio representations
   */
  _parseDashManifest(manifestXml) {
    const formats = [];
    if (!manifestXml) return formats;

    // Decode escaped XML
    const xml = manifestXml
      .replace(/\\u003C/g, '<')
      .replace(/\\u003E/g, '>')
      .replace(/\\u0025/g, '%')
      .replace(/\\\//g, '/')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t');

    // Parse Representations
    const repPattern = /<Representation\s+([^>]+)>[\s\S]*?<BaseURL>([^<]+)<\/BaseURL>[\s\S]*?<\/Representation>/g;
    let match;
    while ((match = repPattern.exec(xml)) !== null) {
      const attrs = match[1];
      const baseUrl = this._htmlDecode(match[2]);

      const id = this._getAttr(attrs, 'id');
      const bandwidth = parseInt(this._getAttr(attrs, 'bandwidth') || '0');
      const codecs = this._getAttr(attrs, 'codecs');
      const mimeType = this._getAttr(attrs, 'mimeType');
      const width = parseInt(this._getAttr(attrs, 'width') || '0');
      const height = parseInt(this._getAttr(attrs, 'height') || '0');
      const qualityLabel = this._getAttr(attrs, 'FBQualityLabel');
      const qualityClass = this._getAttr(attrs, 'FBQualityClass');

      const isVideo = mimeType?.startsWith('video/');
      const isAudio = mimeType?.startsWith('audio/');

      let quality;
      if (isVideo) {
        // Use actual resolution; FBQualityLabel is misleading (e.g., "240p" for a 720p stream)
        if (height) {
          const bitrateK = Math.round(bandwidth / 1000);
          quality = `${height}p ${bitrateK}k`;
        } else {
          quality = `${Math.round(bandwidth / 1000)}k`;
        }
      } else if (isAudio) {
        quality = `${Math.round(bandwidth / 1000)}k`;
      } else {
        quality = `${Math.round(bandwidth / 1000)}k`;
      }

      // Determine extension from mimeType
      let ext = 'mp4';
      if (mimeType?.includes('webm')) ext = 'webm';
      else if (mimeType?.includes('audio/mp4')) ext = 'm4a';

      // Determine codec type
      let vcodec = null, acodec = null;
      if (isVideo && codecs) vcodec = codecs;
      if (isAudio && codecs) acodec = codecs;

      // Parse segment range from SegmentBase
      const segMatch = match[0].match(/indexRange="([^"]+)"/);
      const initMatch = match[0].match(/Initialization range="([^"]+)"/);

      formats.push({
        format_id: id || `dash-${bandwidth}`,
        quality,
        url: baseUrl,
        ext,
        protocol: 'https',
        width: isVideo ? width : 0,
        height: isVideo ? height : 0,
        hasVideo: !!isVideo,
        hasAudio: !!isAudio,
        mimeType: mimeType || '',
        bitrate: bandwidth,
        filesize: null,
        vcodec,
        acodec,
        fps: null,
        qualityClass,
        _dashSegment: {
          indexRange: segMatch?.[1] || null,
          initRange: initMatch?.[1] || null,
        }
      });
    }

    return formats;
  }

  /**
   * Get an XML attribute value by name
   */
  _getAttr(attrStr, name) {
    const match = attrStr.match(new RegExp(`${name}="([^"]*)"`, 'i'));
    return match ? match[1] : null;
  }

  /**
   * Unescape JSON string escape sequences
   */
  _unescapeJson(str) {
    return str
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Decode HTML entities
   */
  _htmlDecode(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /**
   * Parse quality from URL tag parameter (e.g., tag=dash_h264-basic-gen2_720p)
   */
  _parseQualityFromUrl(url) {
    const tagMatch = url.match(/tag=([^&]+)/);
    if (!tagMatch) return null;
    const tag = tagMatch[1];
    const heightMatch = tag.match(/(\d+)p/);
    return heightMatch ? parseInt(heightMatch[1]) : null;
  }

  async extract(url, options = {}) {
    // Resolve short URLs
    const resolvedUrl = await this._resolveShortUrl(url);
    const videoId = this._extractVideoId(resolvedUrl);
    if (!videoId) {
      throw new Error('Could not extract video ID from Facebook URL');
    }

    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Fetch title and embed data in parallel
    const [title, embedHtml] = await Promise.all([
      this._fetchTitle(videoId),
      this._fetchEmbedData(videoId)
    ]);

    // Parse videoData from embed page
    const videoDataArr = this._parseVideoData(embedHtml);
    if (!videoDataArr || videoDataArr.length === 0) {
      throw new Error('Could not extract video data from Facebook. The video may be private or unavailable.');
    }

    const videoData = videoDataArr[0];
    const formats = [];

    // Progressive formats (combined video+audio — direct MP4 download)
    if (videoData.sd_src) {
      const sdHeight = this._parseQualityFromUrl(videoData.sd_src);
      formats.push({
        format_id: 'sd',
        quality: sdHeight ? `${sdHeight}p` : 'SD',
        url: videoData.sd_src,
        ext: 'mp4',
        protocol: 'https',
        width: sdHeight ? Math.round(sdHeight * (videoData.aspect_ratio || 1.7778)) : 0,
        height: sdHeight || 360,
        hasVideo: true,
        hasAudio: true,
        mimeType: 'video/mp4',
        bitrate: parseInt(new URL(videoData.sd_src).searchParams.get('bitrate') || '0'),
        filesize: null,
        vcodec: 'h264',
        acodec: 'aac',
        fps: null,
      });
    }

    if (videoData.hd_src) {
      const hdHeight = this._parseQualityFromUrl(videoData.hd_src);
      formats.push({
        format_id: 'hd',
        quality: hdHeight ? `${hdHeight}p` : 'HD',
        url: videoData.hd_src,
        ext: 'mp4',
        protocol: 'https',
        width: hdHeight ? Math.round(hdHeight * (videoData.aspect_ratio || 1.7778)) : 0,
        height: hdHeight || 720,
        hasVideo: true,
        hasAudio: true,
        mimeType: 'video/mp4',
        bitrate: parseInt(new URL(videoData.hd_src).searchParams.get('bitrate') || '0'),
        filesize: null,
        vcodec: 'h264',
        acodec: 'aac',
        fps: null,
      });
    }

    // DASH formats (separate video-only + audio-only streams)
    if (videoData.dash_manifest) {
      const dashFormats = this._parseDashManifest(videoData.dash_manifest);
      formats.push(...dashFormats);
    }

    if (formats.length === 0) {
      throw new Error('No downloadable video formats found');
    }

    // Sort: combined first, then by height desc, then bitrate desc
    formats.sort((a, b) => {
      const ac = a.hasVideo && a.hasAudio ? 1 : 0;
      const bc = b.hasVideo && b.hasAudio ? 1 : 0;
      if (ac !== bc) return bc - ac; // combined first
      if (a.height !== b.height) return (b.height || 0) - (a.height || 0);
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    // Extract subtitles if available
    let subtitles = {};
    if (videoData.subtitles_src) {
      subtitles.default = {
        name: 'Default',
        lang: 'default',
        formats: { vtt: videoData.subtitles_src }
      };
    }

    const videoTitle = title || `Facebook Video ${videoId}`;
    const combined = formats.filter(f => f.hasVideo && f.hasAudio);
    const videoOnly = formats.filter(f => f.hasVideo && !f.hasAudio);
    const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);
    console.log(`[${this.name}] Extracted ${formats.length} format(s): ${combined.length} combined, ${videoOnly.length} video-only, ${audioOnly.length} audio-only`);

    return {
      title: videoTitle,
      formats,
      subtitles: Object.keys(subtitles).length > 0 ? subtitles : null,
      extractor: this.name,
      url: resolvedUrl,
      videoId,
      duration: this._parseDuration(videoData.dash_manifest),
    };
  }

  /**
   * Parse duration from DASH manifest (mediaPresentationDuration attribute)
   */
  _parseDuration(manifestXml) {
    if (!manifestXml) return null;
    const m = manifestXml.match(/mediaPresentationDuration="PT([\d.]+)S"/);
    if (m) return parseFloat(m[1]);
    // More complex format: PT1H2M30.5S
    const complex = manifestXml.match(/mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/);
    if (complex) {
      return (parseInt(complex[1] || 0) * 3600) +
             (parseInt(complex[2] || 0) * 60) +
             parseFloat(complex[3] || 0);
    }
    return null;
  }
}

export default FacebookExtractor;
