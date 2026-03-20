/**
 * Instagram Extractor
 * Extracts video URLs from instagram.com posts/reels
 *
 * Supports:
 *   - instagram.com/p/{shortcode}/
 *   - instagram.com/reel/{shortcode}/
 *   - instagram.com/reels/{shortcode}/
 *   - instagram.com/tv/{shortcode}/
 *
 * Flow:
 *   1. Extract shortcode from URL
 *   2. Fetch the page and look for embedded JSON data
 *   3. Extract video URL from the structured data
 *   Note: Many Instagram videos require authentication (cookies)
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class InstagramExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Instagram';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?instagram\.com\/(?:p|reel|reels|tv)\/[a-zA-Z0-9_-]+/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/);
    if (!idMatch) throw new Error('Could not extract shortcode from Instagram URL');

    const shortcode = idMatch[1];
    console.log(`[${this.name}] Shortcode: ${shortcode}`);

    // Fetch the page
    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.cookies ? { 'Cookie': options.cookies } : {}),
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    let title = `Instagram ${shortcode}`;
    let uploader = '';
    let thumbnail = '';
    const formats = [];

    // Try to extract video URL from og:video meta tag
    const ogVideo = html.match(/<meta[^>]+property="og:video(?::url|:secure_url)?"[^>]+content="([^"]+)"/i) ||
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::url|:secure_url)?"/i);

    if (ogVideo) {
      let videoUrl = ogVideo[1].replace(/&amp;/g, '&');
      formats.push({
        url: videoUrl,
        ext: 'mp4',
        height: 1080,
        width: 1080,
        quality: '1080p',
        hasVideo: true,
        hasAudio: true,
        format_id: 'og-video',
      });
    }

    // Extract title from og:title
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                    html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:title"/i);
    if (ogTitle) title = ogTitle[1].substring(0, 200);

    // Extract thumbnail
    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (ogImage) thumbnail = ogImage[1];

    // Try to extract from JSON-LD or embedded scripts
    const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>(\{[\s\S]*?\})<\/script>/);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]);
        if (jsonLd.video?.contentUrl && !formats.some(f => f.url === jsonLd.video.contentUrl)) {
          formats.push({
            url: jsonLd.video.contentUrl,
            ext: 'mp4',
            height: jsonLd.video.height || 1080,
            width: jsonLd.video.width || 1080,
            quality: `${jsonLd.video.height || 1080}p`,
            hasVideo: true,
            hasAudio: true,
            format_id: 'jsonld-video',
          });
        }
        if (jsonLd.name) title = jsonLd.name;
        if (jsonLd.author?.name) uploader = jsonLd.author.name;
      } catch (e) { /* ignore parse errors */ }
    }

    // Try the __additionalDataLoaded or window._sharedData patterns
    const sharedDataMatch = html.match(/window\._sharedData\s*=\s*(\{[\s\S]*?\});<\/script>/) ||
                            html.match(/window\.__additionalDataLoaded\s*\([^,]*,\s*(\{[\s\S]*?\})\s*\)/);
    if (sharedDataMatch) {
      try {
        const sharedData = JSON.parse(sharedDataMatch[1]);
        const media = sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media ||
                      sharedData?.graphql?.shortcode_media;
        if (media) {
          if (media.video_url && !formats.some(f => f.url === media.video_url)) {
            formats.push({
              url: media.video_url,
              ext: 'mp4',
              height: media.dimensions?.height || 1080,
              width: media.dimensions?.width || 1080,
              quality: `${media.dimensions?.height || 1080}p`,
              hasVideo: true,
              hasAudio: true,
              format_id: 'graphql-video',
            });
          }
          if (media.owner?.username) uploader = media.owner.username;
          if (media.edge_media_to_caption?.edges?.[0]?.node?.text) {
            title = media.edge_media_to_caption.edges[0].node.text.substring(0, 200);
          }
        }
      } catch (e) { /* ignore */ }
    }

    if (formats.length === 0) {
      throw new Error('Could not extract video URL. Instagram often requires cookies for video access.\nTip: Use --cookies option with your Instagram session cookies.');
    }

    console.log(`[${this.name}] Title: ${title.substring(0, 80)}`);
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: shortcode,
      title,
      formats,
      thumbnail,
      uploader,
      extractor: this.name,
      url,
    };
  }
}

export default InstagramExtractor;
