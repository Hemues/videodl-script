/**
 * 9GAG Extractor
 * Extracts video URLs from 9gag.com
 *
 * Supports:
 *   - 9gag.com/gag/{id}
 *
 * Flow:
 *   1. Fetch gag page via cycletls (TLS fingerprint to bypass 403)
 *   2. Parse window._config JSON for post data with video URLs
 *   3. Fallback to og:video meta tags
 */

import { BaseExtractor } from './base.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 = '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class NineGagExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = '9GAG';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?9gag\.com\/gag\/[a-zA-Z0-9]+/i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/9gag\.com\/gag\/([a-zA-Z0-9]+)/);
    const gagId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] GAG ID: ${gagId}`);

    // Use cycletls to bypass TLS fingerprint checks (regular got gets 403)
    const { default: initCycleTLS } = await import('cycletls');
    const cycleTLS = await initCycleTLS();

    let html;
    try {
      const resp = await cycleTLS(url, {
        body: '',
        ja3: CHROME_JA3,
        userAgent: USER_AGENT,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      }, 'get');

      html = await resp.text();
      if (!html || html.length < 1000) {
        throw new Error(`Page returned insufficient content (${html?.length || 0} bytes)`);
      }
    } finally {
      cycleTLS.exit();
    }

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    if (ogTitle) title = ogTitle[1];
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) title = titleTag[1].replace(/\s*-?\s*9GAG\s*$/i, '').trim();
    }
    if (!title) title = `9GAG_${gagId}`;
    console.log(`[${this.name}] Title: ${title}`);

    const formats = [];

    // Try window._config data - 9GAG embeds post data as escaped JSON
    const configMatch = html.match(/window\._config\s*=\s*JSON\.parse\("([\s\S]*?)"\);/);
    if (configMatch) {
      try {
        // The _config value is JS-string-escaped JSON. The HTML has:
        //   JSON.parse("{\\\"config\\\":{...}")
        // We captured the inner content. Unescape JS string layer first
        // (order matters: \\\\ → \\ first, then \\" → "), then JSON.parse.
        const jsonStr = configMatch[1]
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"')
          .replace(/\\\//g, '/');
        const config = JSON.parse(jsonStr);

        // Navigate to post data - structure varies
        const post = config?.data?.post || config?.post;
        if (post?.images) {
          // image460sv = 460px wide video, image700sv = 700px wide video
          for (const key of ['image460sv', 'image700sv']) {
            const sv = post.images[key];
            if (sv?.url) {
              formats.push({
                url: sv.url,
                ext: 'mp4',
                height: sv.height || parseInt(key),
                width: sv.width || parseInt(key),
                quality: `${sv.height || parseInt(key)}p`,
                hasVideo: true,
                hasAudio: sv.hasAudio !== 0,
                format_id: `mp4-${key}`,
                duration: sv.duration || undefined,
              });
            }
          }
        }
      } catch (e) {
        console.log(`[${this.name}] _config parse error: ${e.message}`);
      }
    }

    // Try JSON-LD schema
    if (formats.length === 0) {
      const jsonLdMatches = html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      for (const m of jsonLdMatches) {
        try {
          const data = JSON.parse(m[1]);
          if (data.video?.contentUrl) {
            formats.push({
              url: data.video.contentUrl,
              ext: 'mp4',
              height: data.video.height || 460,
              width: data.video.width || 460,
              quality: `${data.video.height || 460}p`,
              hasVideo: true,
              hasAudio: true,
              format_id: 'jsonld-video',
            });
          }
        } catch (e) { /* ignore */ }
      }
    }

    // Fallback: og:video meta tag
    if (formats.length === 0) {
      const ogVideo = html.match(/<meta[^>]+property="og:video(?::url|:secure_url)?"[^>]+content="([^"]+)"/i);
      if (ogVideo) {
        formats.push({
          url: ogVideo[1].replace(/&amp;/g, '&'),
          ext: 'mp4',
          height: 460,
          width: 460,
          quality: '460p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'og-video',
        });
      }
    }

    // Fallback: direct MP4 URLs in page content
    if (formats.length === 0) {
      const videoUrls = html.matchAll(/https?:\/\/[^"'\s]*(?:9gag|img-9gag)[^"'\s]*\.mp4(?:\?[^"'\s]*)?/g);
      for (const vurl of videoUrls) {
        if (!formats.some(f => f.url === vurl[0])) {
          formats.push({
            url: vurl[0],
            ext: 'mp4',
            height: 460,
            quality: '460p',
            hasVideo: true,
            hasAudio: true,
            format_id: 'mp4-scraped',
          });
        }
      }
    }

    if (formats.length === 0) {
      throw new Error('No video found on this 9GAG page (may be an image post)');
    }

    // Deduplicate
    const seen = new Set();
    const uniqueFormats = formats.filter(f => {
      if (seen.has(f.url)) return false;
      seen.add(f.url);
      return true;
    });

    uniqueFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${uniqueFormats.length} format(s)`);

    const ogImage = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);

    return {
      id: gagId,
      title,
      formats: uniqueFormats,
      thumbnail: ogImage ? ogImage[1] : '',
      extractor: this.name,
      url,
    };
  }
}

export default NineGagExtractor;
