/**
 * HentaiHaven Extractor (hentaihaven.xxx)
 *
 * The site plays video through the WordPress "player-logic" plugin (zarat.dev):
 *
 *   1. Watch page  → <iframe src=".../player-logic/player.php?data=<blob>&lang=en">
 *   2. player.php  → <meta name="x-secure-token" content="sha512-<blob>">
 *        Decode: strip "sha512-", then 3× (ROT13 → base64-decode) → JSON config
 *        { en, iv, uri, image, host, subtitle_config, ... }
 *   3. POST <uri>api.php   body: action=zarat_get_data_player_ajax & a=<en> & b=<iv>
 *        → { status:true, data:{ sources:[{ src:"<master.m3u8>", type, label }] } }
 *   4. sources[].src is an HLS master playlist → parse variants (480p/720p/1080p).
 *
 * ── Cloudflare note ──────────────────────────────────────────────────────────
 * hentaihaven.xxx serves /watch/ and the player endpoints behind a Cloudflare
 * *managed challenge* that fingerprints the TLS client. Node's own TLS stack
 * (got / fetch) is answered with a 403 "Just a moment…" page, and cycletls'
 * utls handshake is rejected outright ("tls: protocol version not supported").
 * The system `curl` client passes cleanly, so every request here is made through
 * a curl subprocess. curl is present in the videodl container (Fedora runtime),
 * on the build host, and on Windows 10+/macOS/Linux, alongside the existing
 * ffmpeg/yt-dlp external-binary dependencies.
 */

import { BaseExtractor } from './base.js';
import { execFile } from 'node:child_process';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STATUS_MARKER = '\n__VDL_HTTP_STATUS__:';

/** ROT13 — the "cipher" player.js uses between base64 rounds (letters only). */
function rot13(s) {
  return s.replace(/[A-Za-z]/g, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/**
 * Decode the x-secure-token meta value into the player config object.
 * Mirrors player.js: e = token.replace("sha512-",""); 3× ( e = atob(rot13(e)) ).
 */
function decodeSecureToken(token) {
  let e = token.replace('sha512-', '');
  for (let i = 0; i < 3; i++) {
    e = rot13(e);
    e = Buffer.from(e, 'base64').toString('latin1');
  }
  return JSON.parse(e);
}

export class HentaiHavenExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'HentaiHaven';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?hentaihaven\.xxx\/watch\//i.test(url);
  }

  /**
   * Fetch a URL through a curl subprocess (bypasses the Cloudflare managed
   * challenge that blocks Node's TLS fingerprint). Returns { status, body }.
   * @param {string} url
   * @param {Object} [opts]
   * @param {string} [opts.referer]
   * @param {string} [opts.body]  urlencoded POST body (implies POST)
   */
  _curl(url, opts = {}) {
    const args = [
      '-sS', '-L', '--compressed', '--max-time', '30',
      '-A', USER_AGENT,
      '-H', 'Accept-Language: en-US,en;q=0.9',
      // Append the HTTP status after the body so we can detect failures.
      '-w', `${STATUS_MARKER}%{http_code}`,
    ];
    if (opts.referer) args.push('-H', `Referer: ${opts.referer}`);
    if (opts.body != null) {
      args.push('-H', 'Content-Type: application/x-www-form-urlencoded');
      args.push('-H', 'X-Requested-With: XMLHttpRequest');
      args.push('-H', 'Origin: https://hentaihaven.xxx');
      args.push('--data-binary', opts.body);
    }
    args.push(url);

    return new Promise((resolve, reject) => {
      execFile('curl', args, { maxBuffer: 64 * 1024 * 1024, timeout: 45000 }, (err, stdout, stderr) => {
        if (err && !stdout) {
          if (err.code === 'ENOENT') {
            return reject(new Error('curl is required for HentaiHaven (Cloudflare-protected) but was not found on PATH'));
          }
          return reject(new Error(`curl failed: ${err.message}${stderr ? ' — ' + stderr.trim() : ''}`));
        }
        const idx = stdout.lastIndexOf(STATUS_MARKER);
        if (idx === -1) return resolve({ status: 0, body: stdout });
        const status = parseInt(stdout.slice(idx + STATUS_MARKER.length).trim(), 10) || 0;
        resolve({ status, body: stdout.slice(0, idx) });
      });
    });
  }

  /** Parse an HLS master playlist into one format per variant (resolved URLs). */
  _parseMaster(masterUrl, masterBody, headers) {
    const formats = [];
    const lines = masterBody.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const reso = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bw = line.match(/BANDWIDTH=(\d+)/);

      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) { uri = next; break; }
      }
      if (!uri) continue;

      const width = reso ? parseInt(reso[1]) : 0;
      const height = reso ? parseInt(reso[2]) : 0;
      const absUrl = new URL(uri, masterUrl).href;

      formats.push({
        url: absUrl,
        ext: 'mp4',
        width,
        height,
        quality: height ? `${height}p` : 'auto',
        protocol: 'hls',
        hasVideo: true,
        hasAudio: true,
        tbr: bw ? Math.round(parseInt(bw[1]) / 1000) : 0,
        format_id: height ? `hls-${height}p` : 'hls',
        formatNote: 'HLS',
        headers,
      });
    }
    return formats;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // ── Step 1: Watch page → player.php iframe ─────────────────────────────
    const watch = await this._curl(url, { referer: 'https://hentaihaven.xxx/' });
    if (watch.status === 403 || /Just a moment|challenge-platform.*cf_chl/i.test(watch.body.slice(0, 2000))) {
      throw new Error('Cloudflare challenge blocked the watch page (curl fingerprint rejected)');
    }
    if (watch.status && watch.status >= 400) {
      throw new Error(`Watch page returned HTTP ${watch.status}`);
    }
    const html = watch.body;

    // Title
    let title = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1]
             || html.match(/<title>([^<]+)<\/title>/i)?.[1] || 'video';
    title = title
      .replace(/\s*-\s*Hentai\s*Haven.*$/i, '')
      .replace(/^\s*Watch\s+/i, '')
      .trim() || 'video';
    console.log(`[${this.name}] Title: ${title}`);

    // player-logic iframe
    const iframe = html.match(/<iframe[^>]*\bsrc=["']([^"']*player-logic\/player\.php[^"']*)["']/i);
    if (!iframe) throw new Error('Could not find player-logic iframe on watch page');
    let playerUrl = iframe[1].replace(/&#0*38;/g, '&').replace(/&amp;/g, '&');
    if (playerUrl.startsWith('//')) playerUrl = 'https:' + playerUrl;
    console.log(`[${this.name}] Player: ${playerUrl.substring(0, 90)}...`);

    // ── Step 2: player.php → x-secure-token → config ───────────────────────
    const player = await this._curl(playerUrl, { referer: url });
    if (player.status && player.status >= 400) {
      throw new Error(`player.php returned HTTP ${player.status}`);
    }
    const tokenMatch = player.body.match(/name=["']x-secure-token["']\s+content=["']([^"']+)["']/i);
    if (!tokenMatch) throw new Error('Could not find x-secure-token in player page');

    let cfg;
    try {
      cfg = decodeSecureToken(tokenMatch[1]);
    } catch (e) {
      throw new Error(`Failed to decode x-secure-token: ${e.message}`);
    }
    if (!cfg?.en || !cfg?.iv || !cfg?.uri) {
      throw new Error('Decoded player config is missing en/iv/uri');
    }
    const thumbnail = cfg.image || null;

    // ── Step 3: POST api.php → sources ─────────────────────────────────────
    let apiBase = cfg.uri;                                  // "//hentaihaven.xxx/wp-content/plugins/player-logic/"
    if (apiBase.startsWith('//')) apiBase = 'https:' + apiBase;
    const apiUrl = apiBase.replace(/\/?$/, '/') + 'api.php';
    const postBody = new URLSearchParams({
      action: 'zarat_get_data_player_ajax',
      a: cfg.en,
      b: cfg.iv,
    }).toString();

    console.log(`[${this.name}] Requesting sources from api.php...`);
    const api = await this._curl(apiUrl, { referer: playerUrl, body: postBody });
    if (api.status && api.status >= 400) {
      throw new Error(`api.php returned HTTP ${api.status}`);
    }

    let apiJson;
    try {
      apiJson = JSON.parse(api.body);
    } catch (e) {
      throw new Error(`api.php did not return JSON (${api.body.slice(0, 120)})`);
    }
    if (!apiJson?.status || !Array.isArray(apiJson?.data?.sources) || apiJson.data.sources.length === 0) {
      throw new Error('api.php returned no video sources');
    }

    // ── Step 4: Build formats from the HLS source(s) ───────────────────────
    const dlHeaders = { 'User-Agent': USER_AGENT, 'Referer': 'https://hentaihaven.xxx/' };
    const formats = [];

    for (const src of apiJson.data.sources) {
      const srcUrl = src.src;
      if (!srcUrl) continue;
      const isHls = /\.m3u8(\?|$)/i.test(srcUrl) || /mpegurl/i.test(src.type || '');

      if (isHls) {
        // Fetch & parse the master playlist for per-quality variants.
        try {
          const master = await this._curl(srcUrl, { referer: 'https://hentaihaven.xxx/' });
          if (master.status && master.status < 400 && /#EXT-X-STREAM-INF/i.test(master.body)) {
            const variants = this._parseMaster(srcUrl, master.body, dlHeaders);
            if (variants.length) { formats.push(...variants); continue; }
          }
        } catch (e) {
          console.log(`[${this.name}] Master parse failed (${e.message}); using master URL directly`);
        }
        // Fallback: hand the master playlist straight to the downloader.
        formats.push({
          url: srcUrl, ext: 'mp4', width: 0, height: 0,
          quality: src.label || 'auto', protocol: 'hls',
          hasVideo: true, hasAudio: true,
          format_id: 'hls-master', formatNote: 'HLS', headers: dlHeaders,
        });
      } else {
        formats.push({
          url: srcUrl, ext: 'mp4', width: 0, height: 0,
          quality: src.label || 'default',
          hasVideo: true, hasAudio: true,
          format_id: 'mp4', headers: dlHeaders,
        });
      }
    }

    if (formats.length === 0) throw new Error('No downloadable formats found');
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s): ${formats.map(f => f.quality).join(', ')}`);

    return {
      title,
      formats,
      thumbnail,
      extractor: this.name,
      url,
    };
  }
}

export default HentaiHavenExtractor;
