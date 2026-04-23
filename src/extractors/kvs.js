/**
 * KVS (Kernel Video Sharing) Extractor
 * Extracts video URLs from sites running the KVS platform.
 *
 * KVS is a widely-used adult video CMS. Sites using it have a
 * `kt_player` JS player with `flashvars` containing video URLs.
 *
 * URL patterns in flashvars:
 * - Direct: "https://site.com/get_file/..."
 * - function/0/: "function/0/https://site.com/get_file/...?br=NNN"
 *   → license-code hash transformation required
 * - function/<N>/: same transformation (all modes use same algorithm)
 *
 * Supports multiple qualities via video_url, video_alt_url, video_alt_url2, etc.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0',
};

// Known KVS-powered domains
const KVS_DOMAINS = [
  /blowjobs\.pro/i,
  /tgtsporn\.com/i,
];

export class KVSExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'KVS';
  }

  static canHandle(url) {
    return KVS_DOMAINS.some(re => re.test(url));
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }

  /**
   * Compute KVS license token array from license_code.
   * Ported from yt-dlp's GenericIE._kvs_get_license_token.
   */
  _getLicenseToken(licenseCode) {
    const code = licenseCode.replace(/\$/g, '');
    const licenseValues = code.split('').map(Number);

    const modlicense = code.replace(/0/g, '1');
    const center = Math.floor(modlicense.length / 2);
    const fronthalf = parseInt(modlicense.substring(0, center + 1));
    const backhalf = parseInt(modlicense.substring(center));
    const modStr = String(4 * Math.abs(fronthalf - backhalf)).substring(0, center + 1);

    const token = [];
    for (let index = 0; index < modStr.length; index++) {
      const current = parseInt(modStr[index]);
      for (let offset = 0; offset < 4; offset++) {
        token.push((licenseValues[index + offset] + current) % 10);
      }
    }
    return token;
  }

  /**
   * Resolve KVS video_url value using license-code hash unscrambling.
   * Ported from yt-dlp's GenericIE._kvs_get_real_url.
   *
   * The URL hash (first 32 chars of path part [3]) is scrambled; we must
   * unscramble it using the license token by reversing a series of swaps.
   */
  _resolveVideoUrl(rawUrl, licenseCode) {
    if (!rawUrl) return null;

    const funcMatch = rawUrl.match(/^function\/(\d+)\/(https?:\/\/.+)$/);
    if (!funcMatch) {
      // Already a direct URL
      return rawUrl;
    }

    const videoUrl = funcMatch[2];
    if (!licenseCode) return videoUrl;

    try {
      const parsed = new URL(videoUrl);
      const licenseToken = this._getLicenseToken(licenseCode);
      const urlparts = parsed.pathname.split('/');

      const HASH_LENGTH = 32;
      const hashFull = urlparts[3]; // e.g. "482ec725bad8bee727bae9319c61eea80686fedeb0"
      const hash = hashFull.substring(0, HASH_LENGTH);
      const hashArray = hash.split('');
      const indices = Array.from({ length: HASH_LENGTH }, (_, i) => i);

      // Swap indices according to license token (reversed iteration)
      let accum = 0;
      for (let src = HASH_LENGTH - 1; src >= 0; src--) {
        accum += licenseToken[src];
        const dest = (src + accum) % HASH_LENGTH;
        [indices[src], indices[dest]] = [indices[dest], indices[src]];
      }

      // Rebuild hash using the computed indices
      const newHash = indices.map(idx => hashArray[idx]).join('');
      urlparts[3] = newHash + hashFull.substring(HASH_LENGTH);
      parsed.pathname = urlparts.join('/');
      return parsed.toString();
    } catch (e) {
      console.error(`[KVS] Hash transform failed: ${e.message}`);
      return videoUrl;
    }
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const origin = new URL(url).origin;

    // Fetch the page
    const response = await got(url, {
      headers: { ...HEADERS, Referer: origin + '/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract title
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>([^<]+)<\/title>/);
      if (titleTag) title = this._decodeHtmlEntities(titleTag[1]).trim();
    }
    if (!title) title = `KVS_video`;
    console.log(`[${this.name}] Title: ${title}`);

    // Find flashvars block — if absent, this is a listing/model/category page
    const fvMatch = html.match(/var\s+flashvars\s*=\s*\{([\s\S]*?)\}\s*;/);
    if (!fvMatch) {
      return this._extractListing(html, url, origin, title);
    }
    const fvBlock = fvMatch[1];

    // Extract individual flashvar values
    const getVar = (name) => {
      const m = fvBlock.match(new RegExp(`${name}\\s*:\\s*'([^'\\\\]*(?:\\\\.[^'\\\\]*)*)'`));
      return m ? m[1] : null;
    };

    const videoId = getVar('video_id') || 'unknown';
    const videoTitle = getVar('video_title');
    if (videoTitle) title = this._decodeHtmlEntities(videoTitle);

    const licenseCode = getVar('license_code');
    const postfix = getVar('postfix') || '.mp4';

    const standardHeaders = {
      'Referer': url,
      'Origin': origin,
      'User-Agent': HEADERS['User-Agent'],
    };

    // Collect all video URLs (video_url, video_alt_url, video_alt_url2, ...)
    const formats = [];
    const urlKeys = ['video_url'];
    // Check for alternate quality URLs
    for (let i = 1; i <= 10; i++) {
      const key = i === 1 ? 'video_alt_url' : `video_alt_url${i}`;
      if (fvBlock.includes(key + ':') || fvBlock.includes(key + ' :')) {
        urlKeys.push(key);
      }
    }

    for (const key of urlKeys) {
      const rawUrl = getVar(key);
      if (!rawUrl) continue;

      const resolvedUrl = this._resolveVideoUrl(rawUrl, licenseCode);
      if (!resolvedUrl) continue;

      // Try to determine quality from the URL or from companion flashvar
      let quality = 'default';
      const qualityKey = key === 'video_url' ? 'video_url_text' : key + '_text';
      const qualityText = getVar(qualityKey);
      if (qualityText) {
        quality = qualityText;
      } else {
        // Try to extract from URL (e.g., _720P_ or ?br=796)
        const resMatch = resolvedUrl.match(/(\d{3,4})[Pp]_/);
        if (resMatch) {
          quality = resMatch[1] + 'p';
        }
      }

      // Extract height from quality text  
      let height = 0;
      const hMatch = quality.match(/(\d{3,4})/);
      if (hMatch) height = parseInt(hMatch[1]);

      // Extract extension
      let ext = 'mp4';
      if (postfix === '.webm' || resolvedUrl.includes('.webm')) ext = 'webm';

      formats.push({
        quality: quality.includes('p') ? quality : (height > 0 ? `${height}p` : quality),
        url: resolvedUrl,
        width: height > 0 ? Math.round(height * 16 / 9) : 0,
        height,
        format_id: key.replace('video_', ''),
        ext,
        protocol: 'https',
        headers: standardHeaders,
      });
    }

    // Sort by height descending
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable formats found in flashvars');
    }

    return {
      id: videoId,
      title,
      formats,
      url,
      extractor: this.name,
    };
  }

  /**
   * Extract a playlist from a KVS listing page (model, category, tag, etc.).
   * Collects all <a href="/videos/ID/slug/" title="Title"> links on the page,
   * including subsequent pages if pagination is present.
   */
  async _extractListing(html, url, origin, pageTitle) {
    console.log(`[${this.name}] Listing page detected: ${url}`);

    const entries = [];
    const seen = new Set();

    const collectFromHtml = (h) => {
      // KVS listing items: <a href="https://site/videos/ID/slug/" title="Title">
      const re = /<a\s+[^>]*href="((?:https?:\/\/[^"]*)?\/videos\/(\d+)\/[^"]*)"[^>]*title="([^"]*)"[^>]*>/gi;
      let m;
      while ((m = re.exec(h)) !== null) {
        const videoUrl = m[1].startsWith('http') ? m[1] : origin + m[1];
        const videoId = m[2];
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        entries.push({
          _type: 'video',
          id: videoId,
          title: this._decodeHtmlEntities(m[3]).trim(),
          url: videoUrl,
          webpage_url: videoUrl,
          extractor: this.name,
        });
      }
    };

    collectFromHtml(html);

    // Follow pagination links (KVS uses /models/name/N/ or ?from=N patterns)
    const pageRe = /<a\s+[^>]*href="([^"]+)"[^>]*class="[^"]*(?:(?<!["\w])page(?!["\w]))[^"]*"[^>]*>|<a\s+[^>]*class="[^"]*(?:(?<!["\w])page(?!["\w]))[^"]*"[^>]*href="([^"]+)"/gi;
    const paginationLinks = new Set();
    let pm;
    while ((pm = pageRe.exec(html)) !== null) {
      paginationLinks.add(pm[1] || pm[2]);
    }
    // Also check for "next" links or numbered page links in pagination div
    const paginationM = html.match(/<div class="pagination[^"]*">([\s\S]*?)<\/div>/i);
    if (paginationM) {
      const pLinkRe = /href="([^"]+)"/gi;
      while ((pm = pLinkRe.exec(paginationM[1])) !== null) {
        const href = pm[1].startsWith('http') ? pm[1] : origin + pm[1];
        if (href !== url) paginationLinks.add(href);
      }
    }

    for (const pageUrl of paginationLinks) {
      try {
        console.log(`[${this.name}] Fetching page: ${pageUrl}`);
        const resp = await got(pageUrl, {
          headers: { ...HEADERS, Referer: url },
          timeout: { request: 30000 },
          followRedirect: true,
        });
        collectFromHtml(resp.body);
      } catch (e) {
        console.log(`[${this.name}] Could not fetch page ${pageUrl}: ${e.message}`);
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

export default KVSExtractor;
