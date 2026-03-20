/**
 * Twitter/X Extractor
 * Extracts video URLs from twitter.com / x.com posts
 *
 * Supports:
 *   - twitter.com/{user}/status/{id}
 *   - x.com/{user}/status/{id}
 *   - mobile.twitter.com/{user}/status/{id}
 *
 * Flow:
 *   1. Extract tweet ID and username from URL
 *   2. Use vxtwitter.com API (third-party mirror) for video data
 *   3. Fall back to syndication API
 *   4. Collect MP4 progressive formats
 *
 * Note: All official Twitter/X public APIs (syndication, guest GQL) stopped
 *       working in 2024. This extractor relies on third-party mirrors.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class TwitterExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Twitter';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|mobile)\.)?(?:twitter\.com|x\.com)\/[^/]+\/status\/\d+/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const match = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/);
    if (!match) throw new Error('Could not extract tweet ID from URL');

    const userName = match[1];
    const tweetId = match[2];
    console.log(`[${this.name}] Tweet ID: ${tweetId}, User: ${userName}`);

    // Try fxtwitter API (third-party FixTweet mirror that returns JSON)
    let data = null;
    try {
      console.log(`[${this.name}] Trying fxtwitter API...`);
      const fxUrl = `https://api.fxtwitter.com/${userName}/status/${tweetId}`;
      const resp = await got(fxUrl, {
        headers: { 'User-Agent': USER_AGENT },
        responseType: 'json',
        timeout: { request: 20000 },
        throwHttpErrors: false,
      });
      if (resp.statusCode === 200 && resp.body?.tweet) {
        data = resp.body.tweet;
      }
    } catch (e) {
      console.log(`[${this.name}] fxtwitter API failed: ${e.message}`);
    }

    if (!data) {
      throw new Error(
        'Could not fetch tweet data. Twitter/X public APIs no longer work without authentication. ' +
        'The fxtwitter mirror may also be unavailable for this tweet.'
      );
    }

    const authorName = data.author?.name || userName;
    const title = `${authorName} - ${(data.text || '').substring(0, 100)}`;
    console.log(`[${this.name}] Title: ${title.substring(0, 80)}...`);

    const formats = [];

    // fxtwitter returns media.all / media.videos arrays
    const allMedia = data.media?.all || [];
    for (const media of allMedia) {
      if (media.type !== 'video' && media.type !== 'gif') continue;

      if (media.url) {
        const height = media.height || 720;
        const width = media.width || 1280;
        formats.push({
          url: media.url,
          ext: 'mp4',
          height,
          width,
          quality: `${height}p`,
          hasVideo: true,
          hasAudio: media.type !== 'gif',
          format_id: `mp4-${height}p`,
          duration: media.duration || undefined,
        });
      }
    }

    // Fallback: media.videos array
    if (formats.length === 0 && data.media?.videos) {
      for (const video of data.media.videos) {
        if (video.url) {
          formats.push({
            url: video.url,
            ext: 'mp4',
            height: video.height || 720,
            width: video.width || 1280,
            quality: `${video.height || 720}p`,
            hasVideo: true,
            hasAudio: true,
            format_id: 'mp4-video',
          });
        }
      }
    }

    if (formats.length === 0) {
      throw new Error('No video found in this tweet (may be a text/image-only tweet)');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: tweetId,
      title: title.substring(0, 200),
      formats,
      thumbnail: allMedia[0]?.thumbnail_url || data.media?.all?.[0]?.thumbnail_url || '',
      uploader: authorName,
      extractor: this.name,
      url,
    };
  }
}

export default TwitterExtractor;
