/**
 * Imgur Extractor
 * Extracts video/gif URLs from imgur.com
 *
 * Supports:
 *   - imgur.com/{id}  (gifv/video posts)
 *   - i.imgur.com/{id}.gifv
 *   - i.imgur.com/{id}.mp4
 *
 * Flow:
 *   1. Extract media ID from URL
 *   2. Try direct .mp4 URL (i.imgur.com/{id}.mp4)
 *   3. Fall back to page scraping for video sources
 *
 * Note: Imgur has moved to client-side rendering. Direct .mp4 links may
 *       redirect to the homepage. This extractor works best with .gifv URLs.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class ImgurExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Imgur';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|i|m)\.)?imgur\.com\/[a-zA-Z0-9]/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Extract ID - handle /gallery/{id}, /a/{id}, and /{id}
    const galleryMatch = url.match(/imgur\.com\/(?:gallery|a)\/([a-zA-Z0-9]+)/);
    const directMatch = url.match(/imgur\.com\/([a-zA-Z0-9]+)/);
    let mediaId = galleryMatch ? galleryMatch[1] : (directMatch ? directMatch[1] : null);
    if (!mediaId) throw new Error('Could not extract ID from Imgur URL');

    mediaId = mediaId.replace(/\.\w+$/, '');
    console.log(`[${this.name}] Media ID: ${mediaId}`);

    const directMp4 = `https://i.imgur.com/${mediaId}.mp4`;

    // Check if direct MP4 exists (HEAD request, no redirect follow to detect SPA redirect)
    try {
      const headResp = await got.head(directMp4, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: { request: 15000 },
        followRedirect: false,
      });

      if (headResp.statusCode === 200) {
        const contentType = headResp.headers['content-type'] || '';
        if (contentType.includes('video')) {
          console.log(`[${this.name}] Direct MP4 available`);

          let title = `Imgur_${mediaId}`;
          try {
            const pageResp = await got(`https://imgur.com/${mediaId}`, {
              headers: { 'User-Agent': USER_AGENT },
              timeout: { request: 15000 },
            });
            const ogTitle = pageResp.body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
            if (ogTitle && ogTitle[1] !== 'Imgur') title = ogTitle[1];
          } catch (e) { /* ignore */ }

          console.log(`[${this.name}] Title: ${title}`);
          console.log(`[${this.name}] Found 1 format(s)`);

          return {
            id: mediaId,
            title,
            formats: [{
              url: directMp4,
              ext: 'mp4',
              height: 720,
              width: 1280,
              quality: '720p',
              hasVideo: true,
              hasAudio: true,
              format_id: 'mp4-direct',
            }],
            thumbnail: `https://i.imgur.com/${mediaId}.jpg`,
            extractor: this.name,
            url,
          };
        }
      }
    } catch (e) {
      // Not a video or redirect — try page scraping
    }

    // Fetch page and look for video elements
    console.log(`[${this.name}] Fetching page...`);
    const response = await got(`https://imgur.com/${mediaId}`, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    let title = `Imgur_${mediaId}`;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle && ogTitle[1] !== 'Imgur') title = ogTitle[1];

    const formats = [];

    // Look for <source> elements
    const sourceMatch = html.match(/<source\s+src="([^"]+\.mp4[^"]*)"/i);
    if (sourceMatch) {
      let src = sourceMatch[1].replace(/&amp;/g, '&');
      if (src.startsWith('//')) src = 'https:' + src;
      formats.push({
        url: src,
        ext: 'mp4',
        height: 720,
        width: 1280,
        quality: '720p',
        hasVideo: true,
        hasAudio: true,
        format_id: 'mp4-source',
      });
    }

    // Look for og:video
    const ogVideo = html.match(/<meta[^>]+property="og:video(?::url)?"[^>]+content="([^"]+)"/i);
    if (ogVideo) {
      let videoUrl = ogVideo[1].replace(/&amp;/g, '&');
      if (videoUrl.endsWith('.gifv')) videoUrl = videoUrl.replace(/\.gifv$/, '.mp4');
      if (!formats.some(f => f.url === videoUrl)) {
        formats.push({
          url: videoUrl,
          ext: 'mp4',
          height: 720,
          width: 1280,
          quality: '720p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'og-video',
        });
      }
    }

    if (formats.length === 0) {
      throw new Error(
        'No video found at this Imgur URL. Imgur now uses client-side rendering ' +
        'and may not serve video content in the initial HTML response. ' +
        'This extractor works best with direct .gifv links.'
      );
    }

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: mediaId,
      title,
      formats,
      thumbnail: `https://i.imgur.com/${mediaId}.jpg`,
      extractor: this.name,
      url,
    };
  }
}

export default ImgurExtractor;
