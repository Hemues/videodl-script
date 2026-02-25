/**
 * PornZog Extractor
 * Extracts video URLs from pornzog.com
 *
 * PornZog embeds videos via iframes from hclips.com / privatehomeclips.com.
 * The source site uses the same base164-encoded API as InPorn:
 *
 * Flow:
 *   1. Fetch pornzog.com page HTML → get title + iframe embed URL.
 *   2. Extract video_id from the iframe src (e.g. /embed/3522427/).
 *   3. Call hclips.com/api/videofile.php?video_id={id} → JSON array with
 *      base164-encoded video_url for each quality.
 *   4. Decode with base164_decode() (Cyrillic-Latin alphabet mix).
 *   5. Prepend https://hclips.com to the path → 302 redirects to CDN.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

/* ------------------------------------------------------------------ */
/*  Custom base-164 decoder (same alphabet as InPorn / HClips)        */
/* ------------------------------------------------------------------ */

const B164_ALPHABET =
  'АВСDЕFGHIJKLМNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,~';
const B164_STRIP_RE = /[^АВСЕМA-Za-z0-9.,~]/g;

function base164Decode(encoded) {
  const s = encoded.replace(B164_STRIP_RE, '');
  let out = '';
  let r = 0;
  while (r < s.length) {
    const a = B164_ALPHABET.indexOf(s.charAt(r++));
    const b = B164_ALPHABET.indexOf(s.charAt(r++));
    const c = B164_ALPHABET.indexOf(s.charAt(r++));
    const d = B164_ALPHABET.indexOf(s.charAt(r++));

    out += String.fromCharCode((a << 2) | (b >> 4));
    if (c !== 64) out += String.fromCharCode(((b & 15) << 4) | (c >> 2));
    if (d !== 64) out += String.fromCharCode(((c & 3) << 6) | d);
  }
  return unescape(out);
}

/* ------------------------------------------------------------------ */

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

const FORMAT_MAP = {
  '_lq': { label: '360p', height: 360 },
  '_hq': { label: '480p', height: 480 },
  '_fhd': { label: '1080p', height: 1080 },
};

export class PornZogExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'PornZog';
  }

  static canHandle(url) {
    return /pornzog\.com\/video\/\d+/i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&mdash;/g, '—')
      .replace(/&ndash;/g, '–')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) =>
        String.fromCharCode(parseInt(h, 16)),
      )
      .replace(/&#(\d+);/g, (_, d) =>
        String.fromCharCode(parseInt(d, 10)),
      );
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Step 1: Fetch PornZog page
    const response = await got(url, {
      headers: { ...HEADERS, Referer: 'https://pornzog.com/' },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract PornZog video ID from URL
    const pornzogIdMatch = url.match(/\/video\/(\d+)\//);
    const pornzogId = pornzogIdMatch ? pornzogIdMatch[1] : 'unknown';

    // Extract title
    let title = null;
    const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
    if (titleMatch) {
      title = this._decodeHtmlEntities(titleMatch[1])
        .replace(/\s*[-–—|]\s*(?:PornZog|Free Porn).*$/i, '')
        .trim();
    }
    if (!title) title = `PornZog_${pornzogId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // Step 2: Find iframe embed URL
    const iframeMatch = html.match(
      /<iframe\s+src="(https?:\/\/(?:privatehomeclips|hclips)\.com\/embed\/(\d+)[^"]*)"[^>]*>/i,
    );
    if (!iframeMatch) {
      throw new Error('No embed iframe found on PornZog page');
    }

    const embedHost = new URL(iframeMatch[1]).hostname;
    const sourceVideoId = iframeMatch[2];
    console.log(`[${this.name}] Embed: ${embedHost}/embed/${sourceVideoId}/`);

    // Step 3: Call the API for video files
    const apiUrl = `https://${embedHost}/api/videofile.php?video_id=${sourceVideoId}`;
    console.log(`[${this.name}] Fetching API: ${apiUrl}`);

    const apiResponse = await got(apiUrl, {
      headers: { ...HEADERS, Referer: `https://${embedHost}/embed/${sourceVideoId}/` },
      timeout: { request: 15000 },
    });

    let videoFiles;
    try {
      videoFiles = JSON.parse(apiResponse.body);
    } catch (e) {
      throw new Error(`Failed to parse video API response: ${e.message}`);
    }

    if (!Array.isArray(videoFiles) || videoFiles.length === 0) {
      throw new Error('No video files returned by API');
    }

    // Step 4: Decode each video_url and build formats
    const formats = [];
    for (const item of videoFiles) {
      if (!item.video_url) continue;

      const decodedPath = base164Decode(item.video_url);
      console.log(`[${this.name}] Format ${item.format}: ${decodedPath.substring(0, 80)}...`);

      // Determine quality from format string (e.g. "_hq.mp4", "_lq.mp4")
      const fmtKey = Object.keys(FORMAT_MAP).find(k => item.format.includes(k));
      const quality = fmtKey
        ? FORMAT_MAP[fmtKey]
        : { label: '480p', height: 480 };

      // Step 5: Get final CDN URL by following the redirect
      const getFileUrl = `https://${embedHost}${decodedPath}`;
      let videoUrl;
      try {
        const redirectResponse = await got(getFileUrl, {
          headers: { ...HEADERS, Referer: `https://${embedHost}/` },
          timeout: { request: 15000 },
          followRedirect: false,
          throwHttpErrors: false,
        });

        if (redirectResponse.statusCode === 302 && redirectResponse.headers.location) {
          videoUrl = redirectResponse.headers.location;
        } else {
          // If no redirect, use the URL directly
          videoUrl = getFileUrl;
        }
      } catch (e) {
        console.log(`[${this.name}] Warning: redirect failed for ${item.format}: ${e.message}`);
        videoUrl = getFileUrl;
      }

      formats.push({
        quality: quality.label,
        url: videoUrl,
        format_id: `mp4-${quality.label}`,
        ext: 'mp4',
        height: quality.height,
        width: Math.round(quality.height * 16 / 9),
        hasVideo: true,
        hasAudio: true,
        headers: {
          Referer: `https://${embedHost}/`,
          'User-Agent': HEADERS['User-Agent'],
        },
      });
    }

    if (formats.length === 0) {
      throw new Error('No video formats could be extracted');
    }

    // Sort by quality (highest first)
    formats.sort((a, b) => b.height - a.height);
    console.log(
      `[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`,
    );

    // Extract thumbnail
    let thumbnail = null;
    const thumbMatch = html.match(/property="og:image"\s+content="([^"]+)"/i);
    if (thumbMatch) thumbnail = thumbMatch[1];

    return {
      title,
      formats,
      thumbnail,
      extractor: this.name,
      id: pornzogId,
      url,
    };
  }
}
