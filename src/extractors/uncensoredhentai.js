/**
 * UncensoredHentai Extractor (uncensoredhentai.xxx)
 * 
 * Flow:
 *   1. Fetch watch page → find nhplayer.com iframe embed URL
 *   2. Fetch nhplayer embed page → extract data-id (player.php path with base64-encoded vid)
 *   3. Fetch player.php → extract _cfg (vid, ct, pid, st) + DOM challenge parts (p1-p4, ts)
 *   4. Fetch player-core-v2.php → extract server challenge token (sc) and request ID (rid)
 *   5. Compute SHA-256 Proof-of-Work (find nonce where hash starts with 0x0000)
 *   6. Build browser fingerprint payload
 *   7. Call /get-video-url-v2.php with all params → receive signed video URL
 * 
 * Note: The video CDN (r2.1hanime.com) is behind Cloudflare's WAF with TLS
 * fingerprint detection. Downloads use cycletls (Chrome JA3 impersonation) to
 * bypass the WAF — no browser or cookies needed.
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import crypto from 'node:crypto';
import { CookieJar } from 'tough-cookie';
import { buildCookieHeader } from '../cookies.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

export class UncensoredHentaiExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'UncensoredHentai';
  }

  static canHandle(url) {
    return /uncensoredhentai\.xxx/i.test(url);
  }

  /**
   * Compute SHA-256 Proof-of-Work: find nonce where SHA-256(challenge + hex(nonce))
   * has first two bytes == 0x00.
   */
  _computePoW(challenge) {
    for (let n = 0; n < 10_000_000; n++) {
      const h = crypto.createHash('sha256').update(challenge + n.toString(16)).digest();
      if (h[0] === 0 && h[1] === 0) return n.toString(16);
    }
    throw new Error('PoW computation failed (exceeded 10M attempts)');
  }

  /**
   * Build a plausible browser fingerprint payload (base64 JSON).
   * The server validates behavior patterns to detect bots.
   */
  _buildFingerprint(elapsed) {
    return Buffer.from(JSON.stringify({
      t: elapsed,
      mm: [[480, 290, 800], [510, 310, 1050], [540, 325, 1300], [570, 340, 1550]],
      tm: [],
      cl: [[520, 310, Math.round(elapsed * 0.7)]],
      kp: [],
      sc: [],
      i: 1,
      mc: 4, tc: 0, cc: 1, kc: 0,
      b: {
        sw: 1920, sh: 1080, aw: 1920, ah: 1040, cd: 24, pd: 24,
        tz: -60, hc: 8, dm: 8, pl: 'Win32', lang: 'en-US',
        langs: 'en-US,en', dpr: 1, ww: 1920, wh: 937,
        touch: false, pdf: true, fonts: 0,
        w: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
        v: 'Google Inc. (NVIDIA)'
      }
    })).toString('base64');
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    let cookieHeader = '';
    if (options.cookies && options.cookies.length > 0) {
      cookieHeader = buildCookieHeader(options.cookies, url);
      if (cookieHeader) {
        console.log(`[${this.name}] Using ${options.cookies.length} cookies`);
      }
    }

    const reqHeaders = { ...HEADERS };
    if (cookieHeader) reqHeaders['Cookie'] = cookieHeader;

    // ── Step 1: Fetch watch page ───────────────────────────────────────
    console.log(`[${this.name}] Fetching watch page...`);
    const watchResp = await got(url, { headers: reqHeaders, timeout: { request: 20000 }, followRedirect: true });
    const watchHtml = watchResp.body;

    // Extract title from page
    let title = null;
    const ogTitle = watchHtml.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
    if (ogTitle) title = ogTitle[1].trim();
    if (!title) {
      const titleTag = watchHtml.match(/<title>([^<]+)<\/title>/i);
      if (titleTag) title = titleTag[1].trim();
    }
    // Strip common suffixes
    if (title) {
      title = title
        .replace(/\s*\|\s*Uncensored\s*Hentai.*/i, '')
        .replace(/\s*-\s*Uncensored\s*Hentai.*/i, '')
        .trim();
    }
    if (!title) title = 'video';
    console.log(`[${this.name}] Title: ${title}`);

    // Find nhplayer.com iframe (src may not be the first attribute)
    const iframeMatch = watchHtml.match(/<iframe\s[^>]*\bsrc=["'](https?:\/\/[^"']*nhplayer\.com[^"']*)["']/i);
    if (!iframeMatch) throw new Error('Could not find nhplayer.com embed iframe');
    const embedUrl = iframeMatch[1];
    console.log(`[${this.name}] Embed: ${embedUrl}`);

    // ── Step 2: Fetch nhplayer embed page ──────────────────────────────
    // The embed/player pages use a PHPSESSID cookie — maintain a cookie jar
    const jar = new CookieJar();

    console.log(`[${this.name}] Fetching embed page...`);
    const embedResp = await got(embedUrl, {
      headers: { ...HEADERS, Referer: url },
      timeout: { request: 15000 },
      cookieJar: jar,
    });

    const dataIdMatch = embedResp.body.match(/data-id="([^"]+)"/);
    if (!dataIdMatch) throw new Error('Could not find player data-id in embed page');
    const playerPath = dataIdMatch[1];

    // ── Step 3: Fetch player.php ───────────────────────────────────────
    const playerUrl = 'https://nhplayer.com' + (playerPath.startsWith('/') ? '' : '/') + playerPath;
    console.log(`[${this.name}] Fetching player page...`);
    const playerResp = await got(playerUrl, {
      headers: { ...HEADERS, Referer: embedUrl },
      timeout: { request: 15000 },
      cookieJar: jar,
    });
    const pH = playerResp.body;

    // Extract player config — handles both _cfg{...} and window._pV={...} formats
    const vid = pH.match(/vid:\s*"([^"]+)"/)?.[1] || pH.match(/vid\s*=\s*"([^"]+)"/)?.[1];
    const ct = pH.match(/ct:\s*"([^"]+)"/)?.[1] || pH.match(/ct\s*=\s*"([^"]+)"/)?.[1];
    const pid = pH.match(/pid:\s*"([^"]+)"/)?.[1] || pH.match(/pid\s*=\s*"([^"]+)"/)?.[1];
    const st = pH.match(/st:\s*"([^"]+)"/)?.[1] || pH.match(/st\s*=\s*"([^"]+)"/)?.[1];
    const mimeType = (pH.match(/type:\s*"([^"]+)"/)?.[1] || 'video/mp4').replace(/\\\//g, '/');
    // Poster/image may be in _pV or in JW Player config
    const poster = (pH.match(/poster:\s*"([^"]+)"/)?.[1] || pH.match(/image:\s*"([^"]+)"/)?.[1] || '').replace(/\\\//g, '/');

    if (!vid || !ct) throw new Error('Could not extract player config (vid / ct)');

    // Decode vid to get CDN info
    const decoded = Buffer.from(vid, 'base64').toString();
    const [cdnUrl] = decoded.split('|');
    console.log(`[${this.name}] CDN: ${cdnUrl}`);

    // Extract player-core URL (relative or absolute)
    const coreUrlMatch = pH.match(/src="([^"]*player-core[^"]*)"/);
    if (!coreUrlMatch) throw new Error('Could not find player-core script URL');

    // ── Step 4: Fetch player-core-v2.php ───────────────────────────────
    const coreRaw = coreUrlMatch[1];
    const coreUrl = coreRaw.startsWith('http') ? coreRaw
      : 'https://nhplayer.com/' + coreRaw.replace(/^\//, '');
    console.log(`[${this.name}] Fetching player core...`);
    const coreResp = await got(coreUrl, {
      headers: { ...HEADERS, Referer: playerUrl },
      timeout: { request: 15000 },
      cookieJar: jar,
    });
    const coreJs = coreResp.body;

    // Extract server challenge token and request ID (obfuscated variable names)
    const sc = coreJs.match(/var\s+\w+='([0-9a-f]+\.[0-9a-f]+)'/)?.[1];
    const rid = coreJs.match(/var\s+\w+='([0-9a-f]{16})'/)?.[1];
    if (!sc || !rid) throw new Error('Could not extract server challenge token');

    // ── Step 5: Extract DOM challenge parts ────────────────────────────
    // The player-core JS reads challenge values from DOM elements with
    // randomized IDs and data-attribute names (the first hidden div is a
    // honeypot; the real one uses IDs referenced in the JS).
    //
    // Parse the JS to find:  getElementById('xNNNNNN') → 5 element IDs
    // Then getAttribute('data-XXXX') for p1, p3, and ts; .value for p2;
    // .content.textContent for p4 (template element).
    const domIds = [...coreJs.matchAll(/getElementById\('(\w+)'\)/g)].map(m => m[1]);
    const dataAttrs = [...coreJs.matchAll(/\.getAttribute\('(data-[^']+)'\)/g)].map(m => m[1]);

    if (domIds.length < 5 || dataAttrs.length < 3) {
      throw new Error(`Could not parse DOM selectors from player-core (ids=${domIds.length}, attrs=${dataAttrs.length})`);
    }

    // The JS extracts parts in order: p1=e1.getAttribute(attr1), p2=e2.value,
    // p3=e3.getAttribute(attr2), p4=e4.content.textContent, ts=e5.getAttribute(attr3)
    const [id1, id2, id3, id4, id5] = domIds;
    const [attr1, attr2, attr3] = dataAttrs;

    // Look up the values from the player HTML's second hidden div
    const p1 = pH.match(new RegExp(`id="${id1}"[^>]*${attr1}="([^"]{8})"`))?.[1]
            || pH.match(new RegExp(`${attr1}="([^"]{8})"[^>]*id="${id1}"`))?.[1];
    const p2El = pH.match(new RegExp(`id="${id2}"[^>]*value="([^"]{8})"`))?.[1]
              || pH.match(new RegExp(`value="([^"]{8})"[^>]*id="${id2}"`))?.[1];
    const p3 = pH.match(new RegExp(`id="${id3}"[^>]*${attr2}="([^"]{8})"`))?.[1]
            || pH.match(new RegExp(`${attr2}="([^"]{8})"[^>]*id="${id3}"`))?.[1];
    // p4: template element — <template id="xNNNNNN"><p>XXXXXXXX</p></template>
    const p4 = pH.match(new RegExp(`<template[^>]*id="${id4}"[^>]*><p>([^<]{8})</p>`))?.[1];
    // ts: data-attr3 on element id5
    const ts = pH.match(new RegExp(`id="${id5}"[^>]*${attr3}="(\\d+)"`))?.[1]
            || pH.match(new RegExp(`${attr3}="(\\d+)"[^>]*id="${id5}"`))?.[1];

    if (!p1 || !p2El || !p3 || !p4 || !ts) {
      throw new Error(`Could not extract DOM challenge parts (p1=${!!p1} p2=${!!p2El} p3=${!!p3} p4=${!!p4} ts=${!!ts})`);
    }

    console.log(`[${this.name}] Challenge parts extracted from randomized DOM`);

    // ── Step 6: Compute Proof-of-Work ──────────────────────────────────
    const powChallenge = p1 + p2El + p3 + p4 + ts;
    console.log(`[${this.name}] Computing PoW...`);
    const powStart = Date.now();
    const pow = this._computePoW(powChallenge);
    const powTime = Date.now() - powStart;
    console.log(`[${this.name}] PoW solved in ${powTime}ms`);

    // Server requires minimum 2s elapsed time
    const totalElapsed = Date.now() - powStart + 2500;
    const fp = this._buildFingerprint(totalElapsed);

    // Ensure minimum ~2.5s elapsed since page load (server checks)
    if (powTime < 2100) {
      await new Promise(r => setTimeout(r, 2100 - powTime));
    }

    // ── Step 7: Call get-video-url-v2.php ──────────────────────────────
    const params = new URLSearchParams({
      vid, c: ct, p1, p2: p2El, p3, p4, t: ts,
      sc, rid, fp, df: '', pow,
      pid: pid || '', st: st || ''
    });

    console.log(`[${this.name}] Fetching signed video URL...`);
    const apiUrl = 'https://nhplayer.com/get-video-url-v2.php?' + params.toString();
    const apiResp = await got(apiUrl, {
      headers: {
        ...HEADERS,
        Referer: playerUrl,
        'X-Requested-With': 'XMLHttpRequest'
      },
      timeout: { request: 15000 },
      cookieJar: jar,
      responseType: 'json'
    });

    const videoUrl = apiResp.body?.url;
    if (!videoUrl) throw new Error('Server did not return a video URL');
    console.log(`[${this.name}] Got signed URL: ${videoUrl.substring(0, 80)}...`);

    // Determine extension from URL or mime type
    let ext = 'mp4';
    if (cdnUrl.endsWith('.webm') || mimeType.includes('webm')) ext = 'webm';
    else if (cdnUrl.endsWith('.mkv')) ext = 'mkv';

    // Build download headers — Referer/Origin required by the CF WAF
    const dlHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': '*/*',
      'Referer': 'https://nhplayer.com/',
      'Origin': 'https://nhplayer.com'
    };
    // Cookies are NOT needed — cfProtected flag triggers TLS impersonation download

    // Extract CDN domain for CF challenge solving
    const cdnDomain = new URL(cdnUrl).origin;

    const formats = [{
      quality: 'default',
      url: videoUrl,
      width: 0,
      height: 0,
      format_id: 'default',
      ext,
      protocol: 'https',
      hasVideo: true,
      hasAudio: true,
      mimeType,
      bitrate: 0,
      filesize: null,
      fps: null,
      vcodec: null,
      acodec: null,
      headers: dlHeaders,
      cfProtected: true,
      cfDomain: cdnDomain  // Domain root for CF challenge solving
    }];

    return {
      title,
      formats,
      extractor: this.name,
      url,
      thumbnail: poster || null,
      subtitles: null,
      translationLanguages: null
    };
  }
}
