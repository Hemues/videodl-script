/**
 * IndaEvents Extractor (indaevents.hu)
 *
 * IndaEvents is the Indamedia Group event platform (DisplayNOW / DN Network Zrt.)
 * behind the "IndaEvents" mobile app — conferences, club evenings and book
 * launches such as AI Summit Budapest, Automotive Summit, Money Talks,
 * Media Regatta, The Shift, DOGZ Fesztivál and Femina Klub.
 *
 * The site hosts no video itself. Each event page at `/e/<event-slug>` embeds a
 * player in an iframe, and two hosts are used in practice:
 *
 *   <iframe src="https://indaplay.hu/embed/<channel>/<uuid-or-slug>">   (IndaPlay)
 *   <iframe src="https://www.youtube.com/embed/<id>">                   (YouTube)
 *
 * Resolution is delegated to the matching host extractor — IndaPlay for the
 * conference recordings and aftermovies, YouTube for the promo clips — keeping
 * the event page's own title, which is more descriptive than the embed's.
 *
 * Event pages with several recordings return a playlist; a page whose event has
 * not happened yet carries no player at all and reports that plainly.
 *
 * Note that the recordings are also published together on the IndaPlay
 * "indaevents" channel, so the whole back catalogue can be fetched with:
 *   https://indaplay.hu/hu/csatornak/indaevents
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import { IndaplayExtractor } from './indaplay.js';
import { YouTubeExtractor } from './youtube.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
};

// Embedded iframes that are never video players.
const IGNORED_EMBED_HOSTS = /googletagmanager\.com|google\.com\/maps|maps\.google\.|doubleclick\.net|adocean\.pl/i;

export class IndaEventsExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'IndaEvents';
  }

  static canHandle(url) {
    return /indaevents\.hu\//i.test(url);
  }

  _decodeHtmlEntities(text) {
    return String(text || '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  /** Page title, preferring og:title and dropping the site suffix. */
  _pageTitle(html) {
    let title = null;
    const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
    if (og) title = this._decodeHtmlEntities(og[1]).trim();
    if (!title) {
      const tag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (tag) title = this._decodeHtmlEntities(tag[1]).trim();
    }
    if (title) title = title.replace(/\s*[-–—|]\s*IndaEvents\s*$/i, '').trim();
    return title || null;
  }

  /**
   * Collect the player embeds on an event page, in document order.
   * Handles lazy-loaded iframes (`data-src` / `data-lazy-src`) as well as `src`.
   * @returns {Array<{host:'indaplay'|'youtube', url:string}>}
   */
  _findEmbeds(html) {
    const embeds = [];
    const seen = new Set();

    const add = (host, url) => {
      const clean = this._decodeHtmlEntities(url).trim();
      if (seen.has(clean)) return;
      seen.add(clean);
      embeds.push({ host, url: clean });
    };

    const iframeRe = /<iframe\b[^>]*>/gi;
    let tag;
    while ((tag = iframeRe.exec(html)) !== null) {
      const attrs = tag[0];
      const srcMatch = attrs.match(/(?:data-lazy-src|data-src|src)\s*=\s*["']([^"']+)["']/i);
      if (!srcMatch) continue;

      let src = srcMatch[1];
      if (src.startsWith('//')) src = 'https:' + src;
      if (IGNORED_EMBED_HOSTS.test(src)) continue;

      if (/(?:^|\/\/|\.)indaplay\.hu\//i.test(src)) add('indaplay', src);
      else if (/(?:youtube\.com|youtube-nocookie\.com)\/embed\//i.test(src)) add('youtube', src);
    }

    // Some pages expose the player through a meta tag rather than an iframe.
    const metaRe = /<meta\s+(?:property|itemprop)=["'](?:og:video(?::url|:secure_url)?|embedURL)["']\s+content=["']([^"']+)["']/gi;
    let meta;
    while ((meta = metaRe.exec(html)) !== null) {
      let src = meta[1];
      if (src.startsWith('//')) src = 'https:' + src;
      if (IGNORED_EMBED_HOSTS.test(src)) continue;
      if (/(?:^|\/\/|\.)indaplay\.hu\//i.test(src)) add('indaplay', src);
      else if (/(?:youtube\.com|youtube-nocookie\.com)\/embed\//i.test(src)) add('youtube', src);
    }

    return embeds;
  }

  /** Turn a YouTube embed URL into a normal watch URL. */
  _youtubeWatchUrl(embedUrl) {
    const id = embedUrl.match(/\/embed\/([A-Za-z0-9_-]{6,})/);
    return id ? `https://www.youtube.com/watch?v=${id[1]}` : embedUrl;
  }

  async _resolveEmbed(embed, title) {
    if (embed.host === 'indaplay') {
      return new IndaplayExtractor().extract(embed.url, { title });
    }
    return new YouTubeExtractor().extract(this._youtubeWatchUrl(embed.url), {});
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://indaevents.hu/' },
      timeout: { request: 30000 },
      followRedirect: true,
      decompress: true,
    });
    const html = response.body;

    const title = this._pageTitle(html);
    if (title) console.log(`[${this.name}] Event: ${title}`);

    const embeds = this._findEmbeds(html);
    if (embeds.length === 0) {
      throw new Error(
        'No video player found on this IndaEvents page — the event may not have ' +
        'been recorded yet. Past recordings are published on the IndaPlay ' +
        '"indaevents" channel: https://indaplay.hu/hu/csatornak/indaevents'
      );
    }

    console.log(`[${this.name}] Found ${embeds.length} embed(s): ${embeds.map(e => e.host).join(', ')}`);

    // Several recordings on one event page → hand back a playlist.
    if (embeds.length > 1) {
      return {
        _type: 'playlist',
        title: title || 'IndaEvents',
        entries: embeds.map((e, i) => ({
          url: e.host === 'youtube' ? this._youtubeWatchUrl(e.url) : e.url,
          title: title ? `${title} (${i + 1})` : e.url,
        })),
        url,
        webpage_url: url,
        extractor: this.name,
      };
    }

    const info = await this._resolveEmbed(embeds[0], title);

    // The host's own title names the recording ("AI Summit 2025 Aftermovie");
    // the event page title only names the event, so it is the fallback.
    return {
      ...info,
      title: info.title || title,
      url,
      webpage_url: url,
      extractor: this.name,
    };
  }
}

export default IndaEventsExtractor;
