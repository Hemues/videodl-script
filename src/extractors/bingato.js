/**
 * Bingato Extractor
 * Extracts video URLs from bingato.com
 *
 * Flow:
 *   1. Fetch video page via standard HTTP (no TLS fingerprint needed).
 *   2. Extract og:title for video title.
 *   3. Parse <source> tag inside <video> element for direct MP4 CDN URL.
 *
 * URL format: https://bingato.com/item/{slug}-{id}
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class BingatoExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Bingato';
  }

  static canHandle(url) {
    return /bingato\.com\/(?:item\/|s\?|categories\/|models\/|tags\/)/i.test(url);
  }

  static _isListingUrl(url) {
    return /bingato\.com\/(?:s\?|categories\/|models\/|tags\/)/i.test(url);
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

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    if (BingatoExtractor._isListingUrl(url)) {
      return this._extractListing(url, options);
    }

    const cleanUrl = url.replace(/[?#].*$/, '');

    // Extract ID from slug (last numeric segment)
    const idMatch = cleanUrl.match(/\/item\/.*?(\d+)\/?$/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    const response = await got(cleanUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) {
        title = this._decodeHtmlEntities(titleTag[1])
          .replace(/\s*(?:Free HD Porn)?\s*[-|]\s*Bingato.*$/i, '')
          .trim();
      }
    }
    if (!title) title = `Bingato_${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Extract <source> tags from <video> element
    const formats = [];
    const sourceRe = /<source\s+src=["']([^"']+)["'][^>]*type=["']video\/([^"']+)["'][^>]*\/?>/gi;
    let m;
    while ((m = sourceRe.exec(html)) !== null) {
      const videoUrl = m[1];
      const ext = m[2] === 'mp4' ? 'mp4' : m[2];
      formats.push({
        quality: 'default',
        url: videoUrl,
        format_id: ext,
        ext,
        height: 0,
        width: 0,
        protocol: 'https',
        hasVideo: true,
        hasAudio: true,
        headers: {
          Referer: 'https://bingato.com/',
          'User-Agent': USER_AGENT,
        },
      });
    }

    // Fallback: look for direct MP4 URLs in script blocks
    if (formats.length === 0) {
      const mp4Re = /["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*?)["']/gi;
      const seen = new Set();
      while ((m = mp4Re.exec(html)) !== null) {
        const videoUrl = m[1];
        if (seen.has(videoUrl)) continue;
        seen.add(videoUrl);
        formats.push({
          quality: 'default',
          url: videoUrl,
          format_id: 'mp4',
          ext: 'mp4',
          height: 0,
          width: 0,
          protocol: 'https',
          hasVideo: true,
          hasAudio: true,
          headers: {
            Referer: 'https://bingato.com/',
            'User-Agent': USER_AGENT,
          },
        });
      }
    }

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable video sources found on page');
    }

    return {
      id: videoId,
      title,
      formats,
      url: cleanUrl,
      extractor: this.name,
    };
  }
  /**
   * Extract a playlist from a Bingato listing/search page.
   * Follows pagination to collect all results.
   */
  async _extractListing(url, options = {}) {
    console.log(`[${this.name}] Listing page detected: ${url}`);

    const entries = [];
    const seen = new Set();
    const visited = new Set();

    const collectFromHtml = (h) => {
      const re = /<a\s+[^>]*href="(\/item\/([^"]+))"[^>]*title="([^"]*)"[^>]*>/gi;
      let m;
      while ((m = re.exec(h)) !== null) {
        const path = m[1];
        const slug = m[2];
        const title = this._decodeHtmlEntities(m[3]).trim();
        const idMatch = slug.match(/(\d+)$/);
        const videoId = idMatch ? idMatch[1] : slug;
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        entries.push({
          _type: 'video',
          id: videoId,
          title: title || slug,
          url: `https://bingato.com${path}`,
          webpage_url: `https://bingato.com${path}`,
          extractor: this.name,
        });
      }
    };

    const fetchPage = async (pageUrl) => {
      if (visited.has(pageUrl)) return '';
      visited.add(pageUrl);
      const resp = await got(pageUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html',
          'Referer': 'https://bingato.com/',
        },
        timeout: { request: 30000 },
        followRedirect: true,
      });
      return resp.body;
    };

    // Fetch first page
    const html = await fetchPage(url);
    collectFromHtml(html);

    // Extract page title
    let pageTitle = null;
    const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    if (titleTag) {
      pageTitle = this._decodeHtmlEntities(titleTag[1])
        .replace(/\s*[-|]\s*Bingato.*$/i, '')
        .trim();
    }
    if (!pageTitle) pageTitle = 'Bingato Search';

    // Follow pagination (?page=N)
    const pageRe = /href="([^"]*[?&]page=\d+[^"]*)"/gi;
    const paginationLinks = new Set();
    let pm;
    while ((pm = pageRe.exec(html)) !== null) {
      let href = pm[1];
      if (href.startsWith('/')) href = 'https://bingato.com' + href;
      paginationLinks.add(href);
    }

    for (const pageUrl of paginationLinks) {
      try {
        console.log(`[${this.name}] Fetching page: ${pageUrl}`);
        const pageHtml = await fetchPage(pageUrl);
        collectFromHtml(pageHtml);
      } catch (e) {
        console.log(`[${this.name}] Could not fetch ${pageUrl}: ${e.message}`);
      }
    }

    console.log(`[${this.name}] Found ${entries.length} video(s) on listing page`);

    if (entries.length === 0) {
      throw new Error('No videos found on listing page');
    }

    return {
      _type: 'playlist',
      title: pageTitle,
      entries,
      url,
      extractor: this.name,
    };
  }
}

export default BingatoExtractor;
