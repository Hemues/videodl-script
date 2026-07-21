/**
 * JustSwallows Extractor (justswallows.live)
 *
 * justswallows.live is a WordPress site (RetroTube theme) that does NOT host
 * video itself — each post embeds a third-party host. Observed embeds point at
 * vtbe.to, exposed two ways in the page:
 *
 *   <meta itemprop="embedURL" content="https://vtbe.to/embed-<id>.html" />
 *   <iframe ... data-lazy-src="https://vtbe.to/embed-<id>.html"></iframe>
 *
 * Flow:
 *   1. Fetch the post page → read og:title for a clean title.
 *   2. Find the embed URL (itemprop embedURL, else the iframe src/data-lazy-src).
 *   3. Delegate resolution to the reusable Vtbe host extractor, keeping the
 *      site's title (which is nicer than the embed page's).
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import { VtbeExtractor } from './vtbe.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class JustSwallowsExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'JustSwallows';
  }

  static canHandle(url) {
    return /justswallows\.live\//i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&#8211;/g, '–')
      .replace(/&#8212;/g, '—')
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

    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://justswallows.live/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Title from og:title, dropping the " - JustSwallows" site suffix.
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) title = this._decodeHtmlEntities(titleTag[1]).trim();
    }
    if (title) title = title.replace(/\s*[-–—|]\s*JustSwallows\s*$/i, '').trim();

    // Find the vtbe embed URL: itemprop embedURL first, then the iframe.
    let embedUrl = null;
    const embedMeta = html.match(/itemprop=["']embedURL["']\s+content=["'](https?:\/\/[^"']*vtbe\.to\/[^"']+)["']/i);
    if (embedMeta) {
      embedUrl = embedMeta[1];
    } else {
      const iframeMatch = html.match(/(?:data-lazy-src|src)=["'](https?:\/\/[^"']*vtbe\.to\/embed-[a-z0-9]+\.html)["']/i);
      if (iframeMatch) embedUrl = iframeMatch[1];
    }

    if (!embedUrl) {
      throw new Error('No vtbe.to embed found on JustSwallows page');
    }
    embedUrl = embedUrl.replace(/&amp;/g, '&');
    console.log(`[${this.name}] Embed: ${embedUrl}`);

    // Delegate to the reusable vtbe host extractor, keeping our nicer title.
    const info = await new VtbeExtractor().extract(embedUrl, { title });

    return {
      ...info,
      title: title || info.title,
      url,
      webpage_url: url,
      extractor: this.name,
    };
  }
}

export default JustSwallowsExtractor;
