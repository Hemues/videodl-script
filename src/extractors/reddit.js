/**
 * Reddit Extractor
 * Extracts video URLs from reddit.com video posts
 *
 * Supports:
 *   - reddit.com/r/{sub}/comments/{id}/...
 *   - old.reddit.com/r/{sub}/comments/{id}/...
 *   - v.redd.it/{id}
 *
 * Flow:
 *   1. Normalize URL to reddit.com format
 *   2. Fetch .json endpoint for post metadata
 *   3. Extract DASH/HLS media URLs from reddit_video
 *   4. Parse DASH manifest for video+audio tracks (DASH merge)
 *      or fall back to HLS URL
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class RedditExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Reddit';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|old|np|new)\.)?reddit\.com\/r\/[^/]+\/comments\//i.test(url) ||
           /(?:^|\/\/)v\.redd\.it\/[a-z0-9]+/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    let jsonUrl = url;

    // Handle v.redd.it shortlinks — resolve redirect to full reddit URL
    if (/v\.redd\.it\/[a-z0-9]+/i.test(url)) {
      console.log(`[${this.name}] Resolving v.redd.it shortlink...`);
      const resp = await got(url, {
        headers: { 'User-Agent': USER_AGENT },
        followRedirect: false,
        timeout: { request: 15000 },
      });
      if (resp.headers.location) {
        jsonUrl = resp.headers.location;
        console.log(`[${this.name}] Resolved to: ${jsonUrl}`);
      }
    }

    // Normalize URL — strip trailing slash, query, hash
    jsonUrl = jsonUrl.replace(/[?#].*$/, '').replace(/\/$/, '');
    // Append .json
    if (!jsonUrl.endsWith('.json')) jsonUrl += '.json';

    console.log(`[${this.name}] Fetching JSON data...`);
    const response = await got(jsonUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
      timeout: { request: 20000 },
      followRedirect: true,
    });

    const data = JSON.parse(response.body);
    if (!Array.isArray(data) || !data[0]?.data?.children?.[0]?.data) {
      throw new Error('Unexpected Reddit JSON structure');
    }

    const post = data[0].data.children[0].data;
    const title = post.title || 'Reddit Video';
    const postId = post.id || 'unknown';
    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Post ID: ${postId}`);

    const formats = [];

    // Check for reddit_video (v.redd.it hosted)
    const media = post.media || post.secure_media;
    const redditVideo = media?.reddit_video;

    if (redditVideo) {
      console.log(`[${this.name}] Found reddit_video`);

      // HLS playlist — for ffmpeg download
      if (redditVideo.hls_url) {
        const hlsUrl = redditVideo.hls_url.replace(/&amp;/g, '&');
        try {
          await this._parseHlsFormats(hlsUrl, formats);
        } catch (e) {
          console.log(`[${this.name}] HLS parsing failed: ${e.message}`);
        }
      }

      // Fallback URL (highest quality progressive)
      if (redditVideo.fallback_url) {
        const fallbackUrl = redditVideo.fallback_url.replace(/&amp;/g, '&');
        const heightMatch = fallbackUrl.match(/DASH_(\d+)/);
        const height = heightMatch ? parseInt(heightMatch[1]) : (redditVideo.height || 720);

        formats.push({
          url: fallbackUrl,
          ext: 'mp4',
          height,
          width: redditVideo.width || Math.round(height * 16 / 9),
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: false,
          format_id: `dash-${height}p-video`,
          formatNote: 'video only (no audio)',
          audioUrl: this._buildAudioUrl(fallbackUrl),
        });
      }
    }

    // Check for crosspost
    if (formats.length === 0 && post.crosspost_parent_list?.length > 0) {
      const crossMedia = post.crosspost_parent_list[0].media?.reddit_video ||
                         post.crosspost_parent_list[0].secure_media?.reddit_video;
      if (crossMedia?.fallback_url) {
        const fallbackUrl = crossMedia.fallback_url.replace(/&amp;/g, '&');
        const heightMatch = fallbackUrl.match(/DASH_(\d+)/);
        const height = heightMatch ? parseInt(heightMatch[1]) : (crossMedia.height || 720);

        formats.push({
          url: fallbackUrl,
          ext: 'mp4',
          height,
          width: crossMedia.width || Math.round(height * 16 / 9),
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: false,
          format_id: `dash-${height}p-video`,
          formatNote: 'video only (no audio)',
          audioUrl: this._buildAudioUrl(fallbackUrl),
        });
      }
    }

    // Check for external embeds (e.g. YouTube, Streamable, etc)
    if (formats.length === 0 && post.url_overridden_by_dest) {
      throw new Error(`This Reddit post links to an external video: ${post.url_overridden_by_dest}\nPlease use that URL directly.`);
    }

    if (formats.length === 0) {
      throw new Error('No video found in this Reddit post (may be an image/text post)');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: postId,
      title,
      formats,
      thumbnail: post.thumbnail && post.thumbnail !== 'self' ? post.thumbnail : '',
      duration: redditVideo?.duration || 0,
      uploader: post.author || '',
      extractor: this.name,
      url,
    };
  }

  /**
   * Build the audio URL from a DASH video URL.
   * Reddit hosts audio separately at .../DASH_AUDIO_128.mp4 or DASH_audio.mp4
   */
  _buildAudioUrl(videoUrl) {
    const base = videoUrl.replace(/DASH_\d+\.mp4.*/, '');
    return base + 'DASH_AUDIO_128.mp4';
  }

  /**
   * Parse HLS master playlist for variants
   */
  async _parseHlsFormats(hlsUrl, formats) {
    console.log(`[${this.name}] Fetching HLS master playlist...`);
    const resp = await got(hlsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: { request: 15000 },
    });

    const lines = resp.body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const resoMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      const height = resoMatch ? parseInt(resoMatch[2]) : 0;

      // Next non-comment line is the variant URI
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) { uri = next; break; }
      }

      if (!uri || !height) continue;

      // Resolve relative URIs
      if (!uri.startsWith('http')) {
        const baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);
        uri = baseUrl + uri;
      }

      formats.push({
        url: uri,
        ext: 'mp4',
        height,
        width: resoMatch ? parseInt(resoMatch[1]) : Math.round(height * 16 / 9),
        quality: `${height}p`,
        protocol: 'hls',
        hasVideo: true,
        hasAudio: true,
        format_id: `hls-${height}p`,
        tbr: bandwidthMatch ? Math.round(parseInt(bandwidthMatch[1]) / 1000) : 0,
        formatNote: 'HLS',
      });
    }
  }
}

export default RedditExtractor;
