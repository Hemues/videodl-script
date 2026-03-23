/**
 * AShemaleTube Extractor
 * Extracts video URLs from ashemaletube.com
 *
 * Flow:
 *   1. Fetch main watch page via cycletls (TLS fingerprint to bypass 403).
 *   2. Extract og:title from main page.
 *   3. Find /embed/{id}/{hash}/{w}/{h}/ iframe URL.
 *   4. Fetch embed page via cycletls.
 *   5. Parse `var sources = [...]` for HLS stream URLs with quality labels.
 *
 * URL format: https://www.ashemaletube.com/videos/{id}/{slug}/
 */

import { BaseExtractor } from './base.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class AShemaleTubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'AShemaleTube';
  }

  static canHandle(url) {
    return /ashemaletube\.com\/videos\/\d+/i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  async _fetchPage(cycleTLS, pageUrl, referer) {
    const resp = await cycleTLS(pageUrl, {
      body: '',
      ja3: CHROME_JA3,
      userAgent: USER_AGENT,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer,
      },
    }, 'get');
    return await resp.text();
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Strip tracking params
    const cleanUrl = url.replace(/[?#].*$/, '');

    const idMatch = cleanUrl.match(/\/videos\/(\d+)/);
    if (!idMatch) throw new Error('Could not extract video ID from URL');
    const videoId = idMatch[1];
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const { createCycleTLS } = await import('../cycletls-helper.js');
    const cycleTLS = await createCycleTLS();

    try {
      // 1. Fetch main page for title + embed URL
      const html = await this._fetchPage(cycleTLS, cleanUrl, 'https://www.ashemaletube.com/');

      if (!html || html.length < 1000) {
        throw new Error(`Page returned insufficient content (${html?.length || 0} bytes)`);
      }

      // Extract title
      let title = null;
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
      if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
      if (!title) {
        const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
        if (titleMatch) {
          title = this._decodeHtmlEntities(titleMatch[1])
            .replace(/\s*[-|]\s*(?:AShemaleTube|a]?Shemale).*$/i, '')
            .trim();
        }
      }
      if (!title) title = `AShemaleTube_${videoId}`;
      console.log(`[${this.name}] Title: ${title}`);

      // 2. Find embed iframe URL
      const embedMatch = html.match(/<iframe\s+src=["'](https?:\/\/[^"']*ashemaletube\.com\/embed\/[^"']+)["']/i);
      if (!embedMatch) {
        throw new Error('Could not find embed iframe on page');
      }
      const embedUrl = embedMatch[1];
      console.log(`[${this.name}] Embed URL: ${embedUrl}`);

      // 3. Fetch embed page
      const embedHtml = await this._fetchPage(cycleTLS, embedUrl, cleanUrl);

      // 4. Parse var sources = [...] array
      const sourcesMatch = embedHtml.match(/var\s+sources\s*=\s*(\[[\s\S]*?\]);/);
      if (!sourcesMatch) {
        throw new Error('Could not find sources array in embed page');
      }

      let sourcesArr;
      try {
        sourcesArr = JSON.parse(sourcesMatch[1]);
      } catch {
        throw new Error('Failed to parse sources JSON from embed page');
      }

      const formats = [];
      for (const source of sourcesArr) {
        const src = source.src;
        if (!src) continue;

        const desc = source.desc || 'default';
        const height = parseInt(desc) || 0;
        const isHls = source.hls === true || source.format === 'hls';

        formats.push({
          quality: height > 0 ? `${height}p` : desc,
          url: src,
          format_id: `${isHls ? 'hls' : 'mp4'}-${height > 0 ? height + 'p' : desc}`,
          ext: 'mp4',
          height,
          width: height > 0 ? Math.round(height * 16 / 9) : 0,
          protocol: isHls ? 'hls' : 'https',
          hasVideo: true,
          hasAudio: true,
          headers: {
            Referer: 'https://www.ashemaletube.com/',
            'User-Agent': USER_AGENT,
          },
        });
      }

      // Sort by height descending
      formats.sort((a, b) => (b.height || 0) - (a.height || 0));

      console.log(`[${this.name}] Found ${formats.length} format(s)`);

      if (formats.length === 0) {
        throw new Error('No downloadable video sources found');
      }

      return {
        id: videoId,
        title,
        formats,
        url: cleanUrl,
        extractor: this.name,
      };
    } finally {
      cycleTLS.exit();
    }
  }
}

export default AShemaleTubeExtractor;
