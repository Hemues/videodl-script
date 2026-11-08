/**
 * Pornhex Extractor
 * Extracts video URLs from pornhex.com (any language subdomain, e.g. hu.pornhex.com)
 *
 * Flow:
 *   1. Every pornhex.com page sits behind a Cloudflare managed challenge that
 *      only a real browser engine passes, and the clearance cookie is bound to
 *      that browser's fingerprint (LESSONS-LEARNED #31). The page is therefore
 *      loaded in a local headless Chromium-family browser (src/browser-page.js).
 *   2. The player script defines `var videoSources = [{src, k, label, type}, ...]`:
 *      one progressive MP4 per quality (1080p / 720p / 480p). The download URL
 *      is `src + "?h=" + k`, where `k` is a signed token that is ALREADY
 *      URL-encoded (encoding it again gives 403).
 *   3. The media host (`<name>.pornhex.com/volN/media/video/<id>/<q>.mp4`) is not
 *      challenged: a plain HTTPS client downloads the tokened URL (range requests
 *      work), so the formats go through the normal download path.
 *
 * URL format: https://[xx.]pornhex.com/video/<slug>
 */

import { BaseExtractor, hostMatches } from './base.js';
import { fetchRenderedPage } from '../browser-page.js';

export class PornhexExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Pornhex';
  }

  static canHandle(url) {
    if (!hostMatches(url, 'pornhex.com')) return false;
    try {
      return /^\/video\/[^/]+/i.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  _decodeHtmlEntities(text) {
    return String(text)
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  _sourcesFromHtml(html) {
    const m = html.match(/var\s+videoSources\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);
    const pageUrl = url.replace(/#.*$/, '');

    const page = await fetchRenderedPage(pageUrl, {
      waitFor: "Array.isArray(window.videoSources) || !!document.querySelector('video[data-id]')",
      evaluate: 'window.videoSources || null',
      timeout: 90_000,
      log: (msg) => console.log(`[${this.name}] ${msg}`),
    });
    const html = page.html;

    let sources = Array.isArray(page.value) ? page.value : this._sourcesFromHtml(html);
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('No video sources found on the page (the page layout may have changed)');
    }

    // Title: og:title is the clean video title; <title> carries " HD • Pornhex".
    let title = null;
    const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (og) title = this._decodeHtmlEntities(og[1]).trim();
    if (!title && page.title) {
      title = page.title.replace(/\s*(?:HD\s*)?[•|-]\s*Pornhex.*$/i, '').trim();
    }

    const videoId = html.match(/\bdata-id=["'](\d+)["']/)?.[1]
      || pageUrl.match(/\/video\/([^/?#]+)/)?.[1] || 'unknown';
    if (!title) title = `Pornhex_${videoId}`;
    const duration = parseInt(html.match(/\bdata-dur=["'](\d+)["']/)?.[1] || '0', 10) || null;
    const thumbnail = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<video[^>]+poster=["']([^"']+)["']/i)?.[1] || null;

    const origin = new URL(page.url || pageUrl).origin;
    const formats = [];
    for (const s of sources) {
      if (!s || !s.src) continue;
      let mediaUrl = s.src;
      // After the player script runs, `src` already carries `?h=`; the raw page source does not.
      if (s.k && !/[?&]h=/.test(mediaUrl)) {
        // k is already percent-encoded; encode only when it is not.
        const token = /%[0-9A-F]{2}/i.test(s.k) ? s.k : encodeURIComponent(s.k);
        mediaUrl += (mediaUrl.includes('?') ? '&' : '?') + 'h=' + token;
      }
      const label = String(s.label || '');
      const height = parseInt(label, 10) || parseInt(s.src.match(/\/(\d{3,4})p\.mp4/i)?.[1] || '0', 10) || 0;
      formats.push({
        format_id: label || `mp4-${formats.length}`,
        quality: label || 'default',
        url: mediaUrl,
        ext: 'mp4',
        height,
        width: height ? Math.round(height * 16 / 9) : 0,
        protocol: 'https',
        hasVideo: true,
        hasAudio: true,
        headers: {
          Referer: origin + '/',
          'User-Agent': page.userAgent,
        },
      });
    }
    if (formats.length === 0) throw new Error('No playable video sources found');
    formats.sort((a, b) => a.height - b.height);

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`);

    return {
      id: videoId,
      title,
      duration,
      thumbnail,
      formats,
      extractor: this.name,
      url: pageUrl,
    };
  }
}
