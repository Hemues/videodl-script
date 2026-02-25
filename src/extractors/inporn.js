/**
 * InPorn Extractor
 * Extracts video URLs from inporn.com
 *
 * Flow:
 *   1. Fetch the page HTML to get the title.
 *   2. Extract video_id from the URL path.
 *   3. Call /api/videofile.php?video_id={id}&lifetime=86400000 to get
 *      an array of quality entries, each with a base164-encoded video_url.
 *   4. Decode every video_url with the site's custom base164_decode()
 *      (base-64 variant whose alphabet mixes Cyrillic look-alikes for
 *      A В С E М with their Latin counterparts).
 *   5. Prepend the site origin so the path resolves to
 *      https://inporn.com/get_file/… which 302-redirects to the CDN.
 *
 * Quality labels embedded in the filename: _lq → 480p, _hq → 720p.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

/* ------------------------------------------------------------------ */
/*  Custom base-164 decoder (ported from embed.js)                    */
/* ------------------------------------------------------------------ */

// The alphabet contains Cyrillic А В С Е М at indices 0 1 2 4 12
// (they look identical to Latin letters but have different code-points).
const B164_ALPHABET =
  'АВСDЕFGHIJKLМNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,~';

// Strip anything not in the expected character set.
// А = U+0410, В = U+0412, С = U+0421, Е = U+0415, М = U+041C
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
/*  Quality-label map  (suffix in filename → resolution)              */
/*  NOTE: These labels are unreliable — _lq can be 720p, _hq can be   */
/*  1080p. We use the "HD" category from metadata as a hint instead.  */
/* ------------------------------------------------------------------ */

const QUALITY_MAP = {
  '_lq': { label: 'LQ', height: 0 },   // Low Quality — actual resolution varies
  '_hq': { label: 'HQ', height: 0 },   // High Quality — actual resolution varies
};

const ORIGIN = 'https://inporn.com';

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,' +
    'image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

export class InPornExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'InPorn';
  }

  /* ---- URL matching ------------------------------------------------ */

  static canHandle(url) {
    return /inporn\.com\/video\/\d+/i.test(url);
  }

  /* ---- Helpers ----------------------------------------------------- */

  _decodeHtmlEntities(text) {
    return text
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

  _qualityFromPath(path) {
    for (const [suffix, info] of Object.entries(QUALITY_MAP)) {
      if (path.includes(suffix)) return info;
    }
    // Fallback: try to guess from query params (br=bitrate, d=duration)
    return { label: 'unknown', height: 0 };
  }

  /* ---- Main extraction --------------------------------------------- */

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // 1. Extract video ID from URL
    const idMatch = url.match(/inporn\.com\/video\/(\d+)/i);
    if (!idMatch) throw new Error('Could not extract video ID from URL');
    const videoId = idMatch[1];
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // 2. Fetch video metadata via JSON API (the page is a Vue SPA with empty <title>)
    const megaBucket = 1e6 * Math.floor(videoId / 1e6);
    const kiloBucket = 1e3 * Math.floor(videoId / 1e3);
    const metaUrl =
      `${ORIGIN}/api/json/video/86400/${megaBucket}/${kiloBucket}/${videoId}.json`;

    let title = null;
    let thumbnail = null;
    let isHD = false;
    try {
      const metaResp = await got(metaUrl, {
        headers: { ...HEADERS, Referer: url },
        responseType: 'json',
        timeout: { request: 15000 },
      });
      const video = metaResp.body?.video;
      if (video) {
        title = video.title || null;
        thumbnail = video.thumbsrc || video.thumb || null;
        // Check if video has HD category
        if (video.categories) {
          const catTitles = Object.values(video.categories).map(c => c.title?.toLowerCase() || '');
          isHD = catTitles.some(t => t === 'hd' || t === '4k' || t === '1080p' || t === '720p');
        }
      }
    } catch {
      // Fall back to extracting from the URL slug
    }

    if (!title) {
      // Derive a readable title from the URL slug
      const slugMatch = url.match(/\/video\/\d+\/([^/?#]+)/i);
      title = slugMatch
        ? slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        : `InPorn_${videoId}`;
    }
    console.log(`[${this.name}] Title: ${title}`);

    // 3. Call the videofile API
    const apiUrl =
      `${ORIGIN}/api/videofile.php?video_id=${videoId}&lifetime=86400000`;
    console.log(`[${this.name}] Fetching video sources…`);
    const apiResp = await got(apiUrl, {
      headers: {
        ...HEADERS,
        Referer: url,
        'X-Requested-With': 'XMLHttpRequest',
      },
      responseType: 'json',
      timeout: { request: 15000 },
    });

    const sources = apiResp.body;
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('videofile API returned no sources');
    }

    // 4. Decode each source and build formats array
    const formats = [];

    for (const src of sources) {
      if (!src.video_url) continue;

      const decoded = base164Decode(src.video_url);
      const fullUrl = ORIGIN + decoded;
      let quality = this._qualityFromPath(decoded);

      // Override with HD category info if available
      // If the video is marked HD, the quality is likely 720p+
      if (isHD && quality.height === 0) {
        // For _lq (low quality): assume 720p when HD tagged
        // For _hq (high quality): assume 1080p when HD tagged
        if (decoded.includes('_lq')) {
          quality = { label: '720p', height: 720 };
        } else if (decoded.includes('_hq')) {
          quality = { label: '1080p', height: 1080 };
        } else {
          quality = { label: '720p', height: 720 };
        }
      }

      // Also try to pick up the format hint from the API (e.g. "_lq.mp4")
      const ext = decoded.match(/\.(mp4|m3u8|webm)/i)?.[1] || 'mp4';

      formats.push({
        quality: quality.label,
        url: fullUrl,
        format_id: `${ext}-${quality.label}`,
        ext,
        height: quality.height,
        width: quality.height ? Math.round(quality.height * 16 / 9) : 0,
        hasVideo: true,
        hasAudio: true,
        isDefault: !!src.is_default,
        headers: {
          Referer: ORIGIN + '/',
          'User-Agent': HEADERS['User-Agent'],
        },
      });
    }

    if (formats.length === 0) {
      throw new Error('No playable formats found after decoding');
    }

    // Sort: highest quality first
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`);

    return {
      id: videoId,
      title,
      formats,
      extractor: this.name,
      url,
      thumbnail,
    };
  }
}
