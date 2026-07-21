/**
 * Vtbe Extractor (vtbe.to)
 *
 * vtbe.to is a JWPlayer-based video host embedded by many WordPress "tube"
 * sites (RetroTube theme etc.). The embed page carries a plain, unobfuscated
 * JWPlayer setup:
 *
 *   jwplayer("vplayer").setup({
 *     sources: [{file:"https://strNN.vtube.network/hls/,<key>,.urlset/master.m3u8"}],
 *     ...
 *   });
 *
 * The `file` is a standard HLS master playlist on the *.vtube.network CDN.
 * We parse its `#EXT-X-STREAM-INF` variants into per-quality formats. Some
 * embeds instead expose one or more direct `.mp4` files — handled too.
 *
 * URL forms handled:
 *   - https://vtbe.to/embed-<id>.html   (embed/iframe form)
 *   - https://vtbe.to/<id>.html         (watch form)
 *   - https://vtbe.to/<id>
 *
 * This extractor is reusable: any site embedding vtbe.to can delegate to it
 * (see justswallows.js).
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class VtbeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Vtbe';
  }

  static canHandle(url) {
    return /\bvtbe\.to\//i.test(url);
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

  /** Extract the vtbe file id from any accepted URL form. */
  _extractId(url) {
    const embed = url.match(/\/embed-([a-z0-9]+)\.html/i);
    if (embed) return embed[1];
    const watch = url.match(/vtbe\.to\/([a-z0-9]{8,})(?:\.html)?(?:[?#]|$)/i);
    if (watch) return watch[1];
    return null;
  }

  /**
   * Fetch an HLS master playlist and turn its variant streams into formats.
   * Returns [] if the body is not a usable master playlist.
   */
  async _parseMaster(masterUrl, headers) {
    let body;
    try {
      const resp = await got(masterUrl, { headers, timeout: { request: 30000 } });
      body = resp.body;
    } catch (e) {
      console.log(`[${this.name}] Could not fetch master playlist: ${e.message}`);
      return [];
    }
    if (!body || !body.includes('#EXT')) return [];

    const lines = body.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue; // skip I-FRAME + media lines

      const resM = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwM = line.match(/BANDWIDTH=(\d+)/i);

      // Next non-empty, non-comment line is the variant playlist URL.
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
      if (j >= lines.length) break;

      let vurl = lines[j].trim();
      if (!/^https?:\/\//i.test(vurl)) vurl = new URL(vurl, masterUrl).toString();

      variants.push({
        url: vurl,
        width: resM ? parseInt(resM[1], 10) : 0,
        height: resM ? parseInt(resM[2], 10) : 0,
        bitrate: bwM ? parseInt(bwM[1], 10) : null,
      });
      i = j;
    }
    return variants;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const id = this._extractId(url) || 'unknown';
    const embedUrl = `https://vtbe.to/embed-${id}.html`;
    console.log(`[${this.name}] Video ID: ${id}`);

    const response = await got(embedUrl, {
      headers: { ...HEADERS, Referer: 'https://vtbe.to/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Title: prefer a caller-supplied title (site page has a better one),
    // else the embed page <title>, else the id.
    let title = options.title || null;
    if (!title) {
      const titleTag = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleTag) title = this._decodeHtmlEntities(titleTag[1]).trim();
    }
    if (!title) title = `Vtbe_${id}`;

    // Isolate the JWPlayer setup({...}) block, then collect every source `file`.
    const setupMatch = html.match(/\.setup\s*\(\s*\{([\s\S]*?)\}\s*\)\s*;/);
    const scope = setupMatch ? setupMatch[1] : html;

    const fileRe = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4)[^"']*)["']/gi;
    const sourceUrls = [];
    let m;
    while ((m = fileRe.exec(scope)) !== null) {
      const u = m[1].replace(/\\\//g, '/');
      if (!sourceUrls.includes(u)) sourceUrls.push(u);
    }

    if (sourceUrls.length === 0) {
      throw new Error('No JWPlayer video sources found on vtbe embed page');
    }

    const stdHeaders = {
      Referer: 'https://vtbe.to/',
      'User-Agent': USER_AGENT,
    };

    const formats = [];
    for (const src of sourceUrls) {
      if (/\.m3u8/i.test(src)) {
        const variants = await this._parseMaster(src, stdHeaders);
        if (variants.length > 0) {
          for (const v of variants) {
            formats.push({
              quality: v.height > 0 ? `${v.height}p` : 'auto',
              url: v.url,
              format_id: `hls-${v.height > 0 ? v.height + 'p' : 'auto'}`,
              ext: 'mp4',
              height: v.height,
              width: v.width,
              bitrate: v.bitrate,
              protocol: 'hls',
              hasVideo: true,
              hasAudio: true,
              headers: stdHeaders,
            });
          }
        } else {
          // Master unparseable — let the downloader/ffmpeg pick from the master.
          formats.push({
            quality: 'auto',
            url: src,
            format_id: 'hls-auto',
            ext: 'mp4',
            height: 0,
            width: 0,
            protocol: 'hls',
            hasVideo: true,
            hasAudio: true,
            headers: stdHeaders,
          });
        }
      } else {
        // Direct MP4 source
        let height = 0;
        const hM = src.match(/(\d{3,4})[pP]/) || src.match(/[_-](\d{3,4})\./);
        if (hM) height = parseInt(hM[1], 10);
        formats.push({
          quality: height > 0 ? `${height}p` : 'default',
          url: src,
          format_id: `mp4-${height > 0 ? height + 'p' : 'default'}`,
          ext: 'mp4',
          height,
          width: height > 0 ? Math.round(height * 16 / 9) : 0,
          protocol: 'https',
          hasVideo: true,
          hasAudio: true,
          headers: stdHeaders,
        });
      }
    }

    // Sort by height descending
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable video sources found on vtbe embed page');
    }

    return {
      id,
      title,
      formats,
      url,
      extractor: this.name,
    };
  }
}

export default VtbeExtractor;
