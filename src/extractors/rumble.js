/**
 * Rumble Extractor
 * Extracts video URLs from rumble.com
 *
 * Supports:
 *   - rumble.com/{video-slug}.html
 *   - rumble.com/embed/{id}/
 *
 * Flow:
 *   1. Fetch video page HTML
 *   2. Extract embedUrl from JSON-LD structured data
 *   3. Fetch embed page and parse the JSON config
 *   4. Collect MP4 progressive formats from ua.mp4 entries
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class RumbleExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Rumble';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?rumble\.com\//i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    let embedUrl = null;

    // If it's already an embed URL
    const embedMatch = url.match(/rumble\.com\/embed\/([a-zA-Z0-9]+)/);
    if (embedMatch) {
      embedUrl = `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${embedMatch[1]}`;
    }

    // Otherwise, fetch the video page to find the embed ID
    if (!embedUrl) {
      console.log(`[${this.name}] Fetching video page...`);
      const pageResp = await got(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: { request: 20000 },
        followRedirect: true,
      });
      const html = pageResp.body;

      // Try to extract embed video ID from data-video-id or embedUrl in JSON-LD
      const videoIdMatch = html.match(/embedUrl["']\s*:\s*["']https?:\/\/rumble\.com\/embed\/([a-zA-Z0-9]+)\//);
      if (videoIdMatch) {
        embedUrl = `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${videoIdMatch[1]}`;
      }

      // Fallback: look for <script.*data-rumble> or <div id="rumble".*data-video="...">
      if (!embedUrl) {
        const dataVideoMatch = html.match(/data-video="([a-zA-Z0-9]+)"/);
        if (dataVideoMatch) {
          embedUrl = `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${dataVideoMatch[1]}`;
        }
      }

      // Fallback: look for video config in page script
      if (!embedUrl) {
        const scriptMatch = html.match(/(?:Rumble|RumblePlayer)\s*\(\s*["']play["']\s*,\s*\{[^}]*video\s*:\s*["']([a-zA-Z0-9]+)["']/);
        if (scriptMatch) {
          embedUrl = `https://rumble.com/embedJS/u3/?request=video&ver=2&v=${scriptMatch[1]}`;
        }
      }

      if (!embedUrl) {
        throw new Error('Could not find Rumble embed/video ID in page');
      }
    }

    console.log(`[${this.name}] Fetching embed data...`);
    const embedResp = await got(embedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': url,
      },
      responseType: 'json',
      timeout: { request: 20000 },
    });

    const data = embedResp.body;
    if (!data) throw new Error('Empty response from Rumble embed API');

    const title = data.title || 'Rumble Video';
    const videoId = data.vid || 'unknown';
    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const formats = [];
    const ua = data.ua || {};

    // Progressive MP4 formats
    if (ua.mp4) {
      for (const [qualityKey, info] of Object.entries(ua.mp4)) {
        if (!info?.url) continue;

        const height = info.meta?.h || parseInt((qualityKey.match(/(\d+)/) || [])[1]) || 0;
        const width = info.meta?.w || Math.round(height * 16 / 9);

        formats.push({
          url: info.url,
          ext: 'mp4',
          height,
          width,
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: true,
          format_id: `mp4-${qualityKey}`,
          tbr: info.meta?.bitrate ? Math.round(info.meta.bitrate / 1000) : 0,
        });
      }
    }

    // HLS if available
    if (ua.hls?.auto?.url) {
      formats.push({
        url: ua.hls.auto.url,
        ext: 'mp4',
        height: 0,
        quality: 'auto',
        protocol: 'hls',
        hasVideo: true,
        hasAudio: true,
        format_id: 'hls-auto',
        formatNote: 'HLS (auto)',
      });
    }

    // WebM formats
    if (ua.webm) {
      for (const [qualityKey, info] of Object.entries(ua.webm)) {
        if (!info?.url) continue;
        const height = info.meta?.h || parseInt((qualityKey.match(/(\d+)/) || [])[1]) || 0;
        formats.push({
          url: info.url,
          ext: 'webm',
          height,
          width: info.meta?.w || Math.round(height * 16 / 9),
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: true,
          format_id: `webm-${qualityKey}`,
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('No downloadable formats found on Rumble');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: videoId,
      title,
      formats,
      thumbnail: data.i || '',
      duration: data.duration || 0,
      uploader: data.author?.name || '',
      extractor: this.name,
      url,
    };
  }
}

export default RumbleExtractor;
