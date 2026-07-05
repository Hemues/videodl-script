/**
 * YouTube Extractor with Native Signature Decryption & Multi-Client Support
 * 
 * Strategy:
 * 1. Fetch YouTube page → extract metadata, player JS URL, visitor data
 * 2. Download player JS (base.js) → extract signatureTimestamp
 * 3. Try multiple InnerTube API clients to get formats:
 *    - ANDROID / IOS: return direct URLs (no signature needed)
 *    - MWEB: returns direct URLs with web-compatible headers
 *    - WEB: may require signatureCipher decryption (SABR fallback)
 * 4. Solve n-challenges to prevent download throttling
 * 5. For signatureCipher formats: decrypt signature using EJS solver
 * 
 * The EJS solver (yt.solver.core.js from yt-dlp) uses meriyah + astring to
 * parse YouTube's player JS AST and extract sig/n manipulation functions.
 */

import { createHash } from 'node:crypto';
import { BaseExtractor } from './base.js';
import got from 'got';
import fs from 'fs';
import path from 'path';
import { buildCookieHeader, getCookiesForUrl } from '../cookies.js';
import { getSolverCode } from '../solver-loader.js';

// Browser-like headers for YouTube page requests
const YT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'DNT': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Cache-Control': 'max-age=0'
};

// Headers sent with actual video download requests
const DOWNLOAD_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.5',
  'Origin': 'https://www.youtube.com',
  'Referer': 'https://www.youtube.com/'
};

// Default InnerTube API key (used when no per-client key is specified)
const INNERTUBE_API_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';

// InnerTube client configurations — aligned with yt-dlp's client table (2026).
//
// Ordered by reliability for UNAUTHENTICATED downloads:
//   1) clients whose googlevideo media URLs need NO gvs PO token
//      (ANDROID_VR, TV, WEB_EMBEDDED) — tried first,
//   2) authenticated (cookies) client (WEB_CREATOR),
//   3) clients whose media URLs now REQUIRE a gvs PO token (IOS, WEB, MWEB) —
//      last resort: without a minted token their CDN fetch returns HTTP 403.
//
// NOTE (Phase 2 / future): gvs PO-token *minting* is not implemented. yt-dlp
// offloads it to an external provider (bgutil / bgutils-js + jsdom). Until we
// vendor that, the token-required clients below only succeed opportunistically
// (e.g. cached/experiment-exempt sessions); ANDROID_VR is the primary path.
//
// Removed vs. older revisions: TV_EMBEDDED (TVHTML5_SIMPLY_EMBEDDED_PLAYER) and
// MEDIA_CONNECT no longer exist in yt-dlp's client table.
const INNERTUBE_CLIENTS = [
  // --- No gvs PO token required: direct URLs, JS-player not needed ---
  // PRIMARY. ANDROID_VR must stay pinned <= 1.65.x: newer client versions
  // return SABR-only responses (serverAbrStreamingUrl, no plain `url`) which
  // we cannot download, so they get skipped and we lose the best path.
  {
    name: 'ANDROID_VR',
    clientNameId: 28,
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.65.10',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
    },
    requiresJs: false,
  },
  {
    name: 'TV',
    clientNameId: 7,
    client: {
      clientName: 'TVHTML5',
      clientVersion: '7.20260114.12.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
      hl: 'en',
    },
    requiresJs: true,
    useSts: true,
  },
  {
    name: 'WEB_EMBEDDED',
    clientNameId: 56,
    client: {
      clientName: 'WEB_EMBEDDED_PLAYER',
      clientVersion: '1.20260115.01.00',
      hl: 'en',
    },
    thirdParty: { embedUrl: 'https://www.youtube.com/' },
    requiresJs: true,
    useSts: true,
  },
  // --- Authenticated (SAPISIDHASH + cookies): full-resolution when signed in ---
  {
    name: 'WEB_CREATOR',
    clientNameId: 62,
    client: {
      clientName: 'WEB_CREATOR',
      clientVersion: '1.20260114.05.00',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
    apiKey: 'AIzaSyBUPetSUmoZL-OhlxA7wSac5XinrygCqMo',
    requiresJs: true,
    useSts: true,
  },
  // --- gvs PO token REQUIRED (last resort until minting is implemented) ---
  // IOS: /player extraction succeeds but its `c=IOS` googlevideo media URLs
  // now 403 at the CDN without a gvs (or player) PO token. Kept last because
  // its HLS manifest path (see extract()) still works for some content.
  {
    name: 'IOS',
    clientNameId: 5,
    client: {
      clientName: 'IOS',
      clientVersion: '21.02.3',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      userAgent: 'com.google.ios.youtube/21.02.3 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)',
      osName: 'iPhone',
      osVersion: '18.3.1.22D72',
      hl: 'en',
    },
    requiresJs: false,
  },
  {
    name: 'WEB',
    clientNameId: 1,
    client: {
      clientName: 'WEB',
      clientVersion: '2.20260114.08.00',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
    requiresJs: true,
    useSts: true,
  },
  {
    name: 'MWEB',
    clientNameId: 2,
    client: {
      clientName: 'MWEB',
      clientVersion: '2.20260115.01.00',
      hl: 'en',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    },
    requiresJs: true,
    useSts: true,
  },
];

export class YouTubeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'YouTube';
    this._solver = null;
    this._playerCache = new Map();
  }

  static canHandle(url) {
    return /(?:youtube\.com|youtu\.be)/i.test(url);
  }

  // ========== Solver ==========

  /**
   * Load the EJS challenge solver (yt.solver.core.js with meriyah + astring)
   */
  async _loadSolver() {
    if (this._solver) return this._solver;

    const meriyah = await import('meriyah');
    const astring = await import('astring');

    // Try multiple paths: dev (relative to source), bundled (relative to cwd)
    let solverCode;
    try {
      solverCode = getSolverCode();
    } catch (err) {
      throw new Error('YouTube challenge solver (yt.solver.core.js) not found: ' + err.message);
    }

    const factory = new Function('meriyah', 'astring', solverCode + '\nreturn jsc;');
    this._solver = factory(meriyah, astring);

    console.log(`[${this.name}] Challenge solver loaded`);
    return this._solver;
  }

  // ========== Helpers ==========

  _extractVideoId(url) {
    const patterns = [
      /[?&]v=([a-zA-Z0-9_-]{11})/,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/,
      /embed\/([a-zA-Z0-9_-]{11})/,
      /\bv\/([a-zA-Z0-9_-]{11})/,
      /shorts\/([a-zA-Z0-9_-]{11})/,
      /live\/([a-zA-Z0-9_-]{11})/,
      /clip\/([a-zA-Z0-9_-]{11})/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return m[1];
    }
    return null;
  }

  _extractPlayerUrl(html) {
    const patterns = [
      /"PLAYER_JS_URL"\s*:\s*"([^"]+base\.js)"/,
      /"jsUrl"\s*:\s*"([^"]+base\.js)"/,
      /src="(\/s\/player\/[^"]+base\.js)"/
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        return m[1].startsWith('http') ? m[1] : 'https://www.youtube.com' + m[1];
      }
    }
    return null;
  }

  _extractSignatureTimestamp(playerJS) {
    const m = playerJS.match(/(?:signatureTimestamp|sts)\s*:\s*(\d{5})/);
    return m ? parseInt(m[1]) : null;
  }

  _extractVisitorData(html) {
    const m = html.match(/"VISITOR_DATA"\s*:\s*"([^"]+)"/) ||
              html.match(/visitorData\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
  }

  /**
   * Generate SAPISIDHASH for YouTube API authentication.
   * Algorithm (from yt-dlp): SAPISIDHASH <ts>_<sha1(ts + ' ' + SAPISID + ' ' + origin)>
   * Uses __Secure-3PAPISID or SAPISID cookie value.
   * @param {string} [origin='https://www.youtube.com']
   * @returns {string|null} Authorization header value, or null if no SAPISID cookie
   */
  _generateSapisidHash(origin = 'https://www.youtube.com') {
    if (!this._cookies || this._cookies.length === 0) return null;

    // __Secure-3PAPISID is preferred (always present when logged in);
    // fall back to SAPISID which may be absent in some cookie exports.
    const sapisidCookie = this._cookies.find(c => c.name === '__Secure-3PAPISID') ||
                          this._cookies.find(c => c.name === 'SAPISID');
    if (!sapisidCookie || !sapisidCookie.value) return null;

    const timeNow = Math.round(Date.now() / 1000);
    const hash = createHash('sha1')
      .update(`${timeNow} ${sapisidCookie.value} ${origin}`)
      .digest('hex');

    return `SAPISIDHASH ${timeNow}_${hash}`;
  }

  /**
   * Extract the DATASYNC_ID from the page for X-Goog-PageId header.
   * Required for downloading premium/member content when authenticated.
   */
  _extractDatasyncId(html) {
    const m = html.match(/"DATASYNC_ID"\s*:\s*"([^"]*)"/) ||
              html.match(/datasyncId\s*:\s*"([^"]*)"/);
    if (!m) return null;
    // Format is typically "<id>||" — extract the part before the pipes.
    // Only numeric IDs represent real user sessions; IDs starting with 'V'
    // (e.g. "V70cc6223||") are visitor sessions and must NOT be used for
    // onBehalfOfUser — doing so causes 401 Unauthorized on all API clients.
    const match = m[1].match(/^(\d+)/);
    return match ? match[1] : null;
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

  // ========== Player JS & API ==========

  async _getPlayerJS(playerUrl) {
    if (this._playerCache.has(playerUrl)) {
      return this._playerCache.get(playerUrl).playerJS;
    }

    console.log(`[${this.name}] Downloading player JS...`);
    const headers = { 'User-Agent': YT_HEADERS['User-Agent'] };
    if (this._cookieHeader) headers['Cookie'] = this._cookieHeader;
    
    const response = await got(playerUrl, {
      headers,
      timeout: { request: 30000 }
    });

    const playerJS = response.body;
    this._playerCache.set(playerUrl, { playerJS, sigSpecs: {}, nResults: {} });
    console.log(`[${this.name}] Player JS downloaded (${(playerJS.length / 1024).toFixed(0)} KB)`);
    return playerJS;
  }

  /**
   * Call YouTube InnerTube Player API with a specific client config
   */
  async _callPlayerApi(videoId, clientConfig, sts, visitorData) {
    const apiKey = clientConfig.apiKey || INNERTUBE_API_KEY;
    const apiUrl = `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`;

    const context = { client: { ...clientConfig.client } };

    // Authenticated user context — yt-dlp sends onBehalfOfUser (datasyncId)
    // for ALL authenticated API calls.  Without this, YouTube ignores the
    // SAPISIDHASH header and treats the request as unauthenticated.
    if (this._datasyncId) {
      context.user = { onBehalfOfUser: this._datasyncId };
    }

    // web_embedded needs thirdParty in the context
    if (clientConfig.thirdParty) {
      context.thirdParty = clientConfig.thirdParty;
    }

    const body = {
      context,
      videoId: videoId,
      contentCheckOk: true,
      racyCheckOk: true,
      playbackContext: {
        contentPlaybackContext: {
          html5Preference: 'HTML5_PREF_WANTS',
          ...(clientConfig.useSts && sts ? { signatureTimestamp: sts } : {})
        }
      }
    };

    const headers = {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': String(clientConfig.clientNameId),
      'X-YouTube-Client-Version': clientConfig.client.clientVersion,
      'Origin': 'https://www.youtube.com',
      'Referer': 'https://www.youtube.com/',
      'User-Agent': clientConfig.client.userAgent || YT_HEADERS['User-Agent']
    };

    if (visitorData) {
      headers['X-Goog-Visitor-Id'] = visitorData;
    }

    if (this._cookieHeader) {
      headers['Cookie'] = this._cookieHeader;
    }

    // SAPISIDHASH authentication (yt-dlp algorithm):
    // Required for YouTube to treat API calls as authenticated even when
    // cookies are present.  Without this, YouTube serves preview/stub content
    // for restricted videos (live replays, members-only, age-gated, etc.).
    // Only send auth when YouTube confirmed a valid session (LOGGED_IN=true).
    // With incomplete cookies (LOGGED_IN=false), sending SAPISIDHASH causes
    // hard 401 Unauthorized on ALL clients instead of graceful fallbacks.
    if (this._isLoggedIn) {
      const sapisidHash = this._generateSapisidHash('https://www.youtube.com');
      if (sapisidHash) {
        headers['Authorization'] = sapisidHash;
        headers['X-Goog-AuthUser'] = '0';
        headers['X-Origin'] = 'https://www.youtube.com';
        if (this._datasyncId) {
          headers['X-Goog-PageId'] = this._datasyncId;
        }
      }
    }

    const response = await got.post(apiUrl, {
      json: body,
      headers: headers,
      responseType: 'json',
      timeout: { request: 20000 }
    });

    return response.body;
  }

  /**
   * Try multiple InnerTube clients to get the best format list.
   * Returns the first response that has formats with URLs, or null if all exhausted.
   * @param {string} videoId
   * @param {number} sts - signature timestamp
   * @param {string} visitorData
   * @param {Set<string>} [skipClients] - client names to skip (already tried)
   */
  async _getFormatsFromApi(videoId, sts, visitorData, skipClients = new Set()) {
    this._lastApiAll401 = true; // assume all 401 until we see a non-401 response
    for (const clientConfig of INNERTUBE_CLIENTS) {
      if (skipClients.has(clientConfig.name)) continue;
      // Mark client as tried immediately — prevents re-trying failed clients
      // when the caller re-invokes after a probe rejection.
      skipClients.add(clientConfig.name);

      try {
        console.log(`[${this.name}] Trying ${clientConfig.name} client...`);
        const response = await this._callPlayerApi(videoId, clientConfig, sts, visitorData);
        this._lastApiAll401 = false; // got a non-error response

        const sd = response.streamingData;
        if (!sd) {
          const status = response.playabilityStatus?.status || 'UNKNOWN';
          const reason = response.playabilityStatus?.reason || '';
          console.log(`[${this.name}] ${clientConfig.name}: No streaming data (${status}${reason ? ': ' + reason : ''})`);
          continue;
        }

        // Log available streaming data keys for debugging
        const sdKeys = Object.keys(sd).join(', ');
        console.log(`[${this.name}] ${clientConfig.name}: streamingData keys: [${sdKeys}]`);

        const allFormats = [
          ...(sd.formats || []),
          ...(sd.adaptiveFormats || [])
        ];

        // Count formats with URLs
        const withUrl = allFormats.filter(f => f.url).length;
        const withSigCipher = allFormats.filter(f => f.signatureCipher).length;
        const usable = withUrl + withSigCipher;

        // Extract HLS manifest URL — live streams/replays often have one
        const hlsManifestUrl = sd.hlsManifestUrl || null;
        if (hlsManifestUrl) {
          console.log(`[${this.name}] ${clientConfig.name}: HLS manifest available`);
        }

        console.log(`[${this.name}] ${clientConfig.name}: ${allFormats.length} formats (${withUrl} url, ${withSigCipher} signatureCipher)`);

        if (usable === 0 && !hlsManifestUrl) continue;

        // Extract PO (Proof of Origin) token from response — needed on format
        // URLs for the CDN to serve real content instead of preview stubs.
        const poToken = response.serviceIntegrityDimensions?.poToken || null;
        if (poToken) {
          console.log(`[${this.name}] ${clientConfig.name}: PO token available (${poToken.length} chars)`);
        }

        return { formats: allFormats, clientName: clientConfig.name, clientConfig, requiresJs: clientConfig.requiresJs, poToken, hlsManifestUrl };
      } catch (e) {
        const is401 = /401|Unauthorized/i.test(e.message);
        if (!is401) this._lastApiAll401 = false;
        console.log(`[${this.name}] ${clientConfig.name} failed: ${e.message}`);
      }
    }

    return null;
  }

  /**
   * Probe a format URL with a small Range request to verify the CDN serves
   * real, full-length data (not just a stub/preview).
   *
   * @param {string} url - fully processed format URL
   * @param {Object} clientConfig - InnerTube client config (for User-Agent)
   * @param {Object} [opts]
   * @param {number} [opts.expectedDuration] - expected video duration in seconds
   * @returns {Promise<boolean>} true if the URL is usable
   */
  async _probeFormatUrl(url, clientConfig, opts = {}) {
    try {
      const probeHeaders = {
        ...DOWNLOAD_HEADERS,
        'User-Agent': clientConfig?.client?.userAgent || DOWNLOAD_HEADERS['User-Agent'],
        'Range': 'bytes=0-1023',
      };
      if (this._cookieHeader) probeHeaders['Cookie'] = this._cookieHeader;

      const resp = await got(url, {
        headers: probeHeaders,
        timeout: { request: 10000 },
        responseType: 'buffer',
        throwHttpErrors: false,
      });

      // Must be 200/206 with actual body bytes
      if (resp.statusCode !== 200 && resp.statusCode !== 206) {
        console.log(`[${this.name}] Probe: HTTP ${resp.statusCode}, body ${resp.body.length} bytes`);
        return false;
      }
      if (resp.body.length === 0) {
        console.log(`[${this.name}] Probe: HTTP ${resp.statusCode}, body 0 bytes`);
        return false;
      }

      // Check Content-Range / Content-Length for suspiciously small streams.
      // YouTube preview/stub responses typically have a complete file < 100 KB
      // while real video streams are many megabytes.
      const expectedDuration = opts.expectedDuration || 0;
      if (expectedDuration > 30) { // only check for videos > 30 seconds
        let fullSize = 0;
        const cr = resp.headers['content-range']; // e.g. "bytes 0-1023/1234567"
        if (cr) {
          const m = cr.match(/\/(\d+)/);
          if (m) fullSize = parseInt(m[1]);
        }
        if (!fullSize) {
          fullSize = parseInt(resp.headers['content-length'] || '0');
        }

        // Heuristic: a real video stream should be at least ~10 KB per second
        // of content (even at the lowest quality).  A 90-minute movie at
        // lowest quality would be ~50 MB; a 5-second preview is ~50 KB.
        const minExpectedBytes = expectedDuration * 1024; // ~1 KB/s absolute minimum
        if (fullSize > 0 && fullSize < minExpectedBytes) {
          console.log(`[${this.name}] Probe: Content is only ${(fullSize / 1024).toFixed(0)} KB but video is ${Math.round(expectedDuration)}s long — likely a preview/stub`);
          return false;
        }
      }

      return true;
    } catch (e) {
      console.log(`[${this.name}] Probe error: ${e.message}`);
      return false;
    }
  }

  // ========== HLS Master Playlist Parsing ==========

  /**
   * Parse an HLS master (variant) playlist into individual format entries.
   * YouTube's demuxed HLS manifests contain separate video-only and audio-only
   * variant streams.  Each `#EXT-X-STREAM-INF` line describes a variant with
   * RESOLUTION, BANDWIDTH, CODECS, etc.  Audio-only variants have no
   * RESOLUTION tag but do have an audio codec in CODECS.
   *
   * Returns an array of format objects compatible with the rest of the pipeline.
   */
  _parseHlsMasterPlaylist(playlist, masterUrl, headers) {
    const lines = playlist.split('\n').map(l => l.trim());
    const formats = [];
    const baseUrl = masterUrl.replace(/[?#].*$/, '').replace(/\/[^/]*$/, '/');

    // 1. Detect demuxed manifest: parse #EXT-X-MEDIA:TYPE=AUDIO tags.
    //    In a demuxed YouTube HLS manifest, audio streams are separate #EXT-X-MEDIA entries
    //    and the #EXT-X-STREAM-INF entries reference them via AUDIO="group" attribute.
    const audioGroups = {};  // groupId → array of audio renditions
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-MEDIA:')) continue;
      const mediaAttrs = lines[i].substring('#EXT-X-MEDIA:'.length);
      const mediaType = (mediaAttrs.match(/TYPE=([A-Z]+)/) || [])[1];
      if (mediaType !== 'AUDIO') continue;

      const groupId = (mediaAttrs.match(/GROUP-ID="([^"]+)"/) || [])[1] || '';
      let uri = (mediaAttrs.match(/URI="([^"]+)"/) || [])[1] || '';
      if (uri && !uri.startsWith('http')) uri = new URL(uri, masterUrl).toString();
      const name = (mediaAttrs.match(/NAME="([^"]+)"/) || [])[1] || 'audio';
      const channels = (mediaAttrs.match(/CHANNELS="(\d+)"/) || [])[1] || '';
      const codecMatch = (mediaAttrs.match(/CODECS="([^"]+)"/) || [])[1] || '';
      const language = (mediaAttrs.match(/LANGUAGE="([^"]+)"/) || [])[1] || '';
      const isDefault = (mediaAttrs.match(/DEFAULT=(YES|NO)/) || [])[1] === 'YES';

      if (!audioGroups[groupId]) audioGroups[groupId] = [];
      audioGroups[groupId].push({ uri, name, channels, codec: codecMatch, groupId, language, isDefault });
    }

    const hasDemuxedAudio = Object.keys(audioGroups).length > 0;

    // 2. Parse #EXT-X-STREAM-INF variants (video or combined)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;

      const attrs = lines[i].substring('#EXT-X-STREAM-INF:'.length);
      // Next non-empty, non-comment line is the variant URL
      let variantUrl = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          variantUrl = lines[j];
          break;
        }
      }
      if (!variantUrl) continue;

      // Resolve relative URLs
      if (!variantUrl.startsWith('http')) {
        variantUrl = new URL(variantUrl, masterUrl).toString();
      }

      // Parse attributes
      const bandwidth = parseInt((attrs.match(/BANDWIDTH=(\d+)/) || [])[1] || '0');
      const resParts = (attrs.match(/RESOLUTION=(\d+)x(\d+)/) || []);
      const width = parseInt(resParts[1] || '0');
      const height = parseInt(resParts[2] || '0');
      const codecs = (attrs.match(/CODECS="([^"]+)"/) || [])[1] || '';
      const fps = parseFloat((attrs.match(/FRAME-RATE=([\d.]+)/) || [])[1] || '0');
      const audioGroupRef = (attrs.match(/AUDIO="([^"]+)"/) || [])[1] || '';

      // Determine media type from codecs
      const codecParts = codecs.split(',').map(c => c.trim());
      const videoCodecs = codecParts.filter(c => /^(avc|hev|hvc|vp0?[89]|av01)/.test(c));
      const audioCodecs = codecParts.filter(c => /^(mp4a|opus|ac-3|ec-3|flac|vorbis)/.test(c));

      const hasVideo = videoCodecs.length > 0 || height > 0;
      // If this variant references an AUDIO group, it's video-only (demuxed manifest).
      // The CODECS attribute lists both video+audio per HLS spec, but actual stream is video-only.
      const isDemuxedVideo = hasDemuxedAudio && !!audioGroupRef;
      const hasAudio = isDemuxedVideo ? false : audioCodecs.length > 0;

      const quality = height > 0 ? `${height}p` : `${Math.round(bandwidth / 1000)}k`;
      const formatId = `hls-${height}p`;

      formats.push({
        quality: fps > 30 ? `${quality}${Math.round(fps)}` : quality,
        url: variantUrl,
        width,
        height,
        format_id: formatId,
        ext: 'mp4',
        protocol: 'hls',
        hasVideo,
        hasAudio,
        mimeType: 'application/vnd.apple.mpegURL',
        bitrate: bandwidth,
        filesize: null,
        fps: fps || null,
        vcodec: videoCodecs[0] || null,
        acodec: isDemuxedVideo ? null : (audioCodecs[0] || null),
        headers,
        _hlsMasterUrl: masterUrl,
        _audioGroupRef: audioGroupRef || null,
      });
    }

    // 3. Add audio-only formats from #EXT-X-MEDIA tags
    if (hasDemuxedAudio) {
      const seenAudioUrls = new Set();
      for (const [groupId, renditions] of Object.entries(audioGroups)) {
        for (const aud of renditions) {
          if (!aud.uri || seenAudioUrls.has(aud.uri)) continue;
          seenAudioUrls.add(aud.uri);

          // Try to extract itag from URL for a better format_id
          const itagMatch = aud.uri.match(/\/itag\/(\d+)\//);
          const itagLabel = itagMatch ? `itag${itagMatch[1]}` : groupId;

          // Estimate bitrate from codec or use a default
          const bitrate = aud.codec && aud.codec.includes('mp4a') ? 128000 : 64000;
          const bitrateK = Math.round(bitrate / 1000);

          formats.push({
            quality: `${bitrateK}k`,
            url: aud.uri,
            width: 0,
            height: 0,
            format_id: `hls-audio-${itagLabel}`,
            ext: 'mp4',
            protocol: 'hls',
            hasVideo: false,
            hasAudio: true,
            mimeType: 'application/vnd.apple.mpegURL',
            bitrate,
            filesize: null,
            fps: null,
            vcodec: null,
            acodec: aud.codec || 'mp4a.40.2',
            audioTrackLang: aud.language || undefined,
            audioTrackName: aud.name || undefined,
            audioIsDefault: aud.isDefault || false,
            headers,
            _hlsMasterUrl: masterUrl,
            _audioGroupId: groupId,
          });
        }
      }
    }

    return formats;
  }

  // ========== Challenge Solving ==========

  async _solveAllChallenges(playerUrl, playerJS, sigLengths, nValues) {
    const solver = await this._loadSolver();
    if (!solver) throw new Error('Failed to load challenge solver');

    const cache = this._playerCache.get(playerUrl);
    const requests = [];

    // Sig challenges: synthetic strings per unique length
    const uncachedSigLengths = sigLengths.filter(len => !(len in cache.sigSpecs));
    if (uncachedSigLengths.length > 0) {
      const sigChallenges = uncachedSigLengths.map(len =>
        Array.from({ length: len }, (_, i) => String.fromCharCode(i)).join('')
      );
      requests.push({ type: 'sig', challenges: sigChallenges });
    }

    // N challenges: actual n values
    const uncachedNValues = nValues.filter(n => !(n in cache.nResults));
    if (uncachedNValues.length > 0) {
      requests.push({ type: 'n', challenges: uncachedNValues });
    }

    if (requests.length === 0) return;

    console.log(`[${this.name}] Solving ${uncachedSigLengths.length} sig + ${uncachedNValues.length} n challenges...`);

    let result;
    try {
      result = solver({ type: 'player', player: playerJS, requests });
    } catch (solverErr) {
      // Solver may throw raw strings, not Error objects
      const msg = solverErr instanceof Error ? solverErr.message : String(solverErr);
      throw new Error(`Challenge solver failed: ${msg}`);
    }

    if (result.type === 'error') {
      throw new Error(`Solver error: ${result.error}`);
    }

    let reqIdx = 0;

    if (uncachedSigLengths.length > 0) {
      const resp = result.responses[reqIdx++];
      if (resp.type === 'result') {
        for (const [syntheticSig, solvedSig] of Object.entries(resp.data)) {
          cache.sigSpecs[syntheticSig.length] = Array.from(solvedSig).map(c => c.charCodeAt(0));
        }
        console.log(`[${this.name}] Solved ${Object.keys(resp.data).length} sig challenge(s)`);
      } else {
        console.error(`[${this.name}] Sig error: ${resp.error}`);
      }
    }

    if (uncachedNValues.length > 0) {
      const resp = result.responses[reqIdx++];
      if (resp.type === 'result') {
        Object.assign(cache.nResults, resp.data);
        console.log(`[${this.name}] Solved ${Object.keys(resp.data).length} n challenge(s)`);
      } else {
        console.error(`[${this.name}] N-challenge error: ${resp.error}`);
      }
    }
  }

  _applySignature(spec, encryptedSig, sigParam, baseUrl) {
    const decryptedSig = spec.map(i => encryptedSig[i]).join('');
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}${sigParam}=${encodeURIComponent(decryptedSig)}`;
  }

  _applyNChallenge(url, nResult) {
    try {
      const u = new URL(url);
      u.searchParams.set('n', nResult);
      return u.toString();
    } catch {
      return url.replace(/([?&])n=[^&]+/, `$1n=${encodeURIComponent(nResult)}`);
    }
  }

  // ========== Subtitle Extraction ==========

  /**
   * Fetch captions from the WEB InnerTube client.
   * ANDROID_VR (our primary format client) never returns captions,
   * so we make a separate WEB API call just for subtitle metadata.
   * The URLs returned by the WEB client actually work for downloading
   * (unlike the ones embedded in ytInitialPlayerResponse on the page).
   */
  async _getCaptionsFromApi(videoId, sts, visitorData) {
    const webConfig = INNERTUBE_CLIENTS.find(c => c.name === 'WEB');
    if (!webConfig) return null;

    try {
      const response = await this._callPlayerApi(videoId, webConfig, sts, visitorData);
      const renderer = response?.captions?.playerCaptionsTracklistRenderer;
      if (!renderer?.captionTracks?.length) return null;

      const subtitles = {};
      for (const track of renderer.captionTracks) {
        const lang = track.languageCode;
        const entry = {
          url: track.baseUrl,
          name: track.name?.simpleText || lang,
          lang,
          kind: track.kind || 'manual',   // 'asr' = auto-generated
          isAutoGenerated: track.kind === 'asr',
          isTranslatable: !!track.isTranslatable
        };
        // Build per-format download URLs
        entry.formats = {};
        for (const fmt of ['vtt', 'json3', 'srv3', 'ttml']) {
          entry.formats[fmt] = track.baseUrl + '&fmt=' + fmt;
        }
        // Per-language preference: a manually authored track always beats
        // an auto-generated (ASR) one. If an ASR track arrives first and
        // is followed by a manual track in the same language, replace it;
        // if a manual track is already stored, do NOT let an ASR track
        // overwrite it.
        const existing = subtitles[lang];
        if (existing && !existing.isAutoGenerated && entry.isAutoGenerated) continue;
        subtitles[lang] = entry;
      }

      // Collect available translation languages
      const translationLanguages = (renderer.translationLanguages || []).map(tl => ({
        code: tl.languageCode,
        name: tl.languageName?.simpleText || tl.languageCode
      }));

      return { subtitles, translationLanguages };
    } catch (e) {
      console.log(`[${this.name}] Caption fetch failed: ${e.message}`);
      return null;
    }
  }

  // ========== Playlist / Channel ==========

  /**
   * Extract video entries from a YouTube playlist or channel URL.
   * Uses the YouTube browse API (via ytInitialData) to fetch the full list.
   */
  async _extractPlaylist(url, options) {
    console.log(`[${this.name}] Handling as playlist/channel URL`);

    const pageHeaders = { ...YT_HEADERS };
    if (this._cookieHeader) pageHeaders['Cookie'] = this._cookieHeader;

    const response = await got(url, {
      headers: pageHeaders,
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract ytInitialData
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\})\s*;/s) ||
                      html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;/s);
    if (!dataMatch) throw new Error('Could not parse YouTube playlist page');

    let initialData;
    try { initialData = JSON.parse(dataMatch[1]); } catch {
      throw new Error('Failed to parse YouTube playlist data');
    }

    // Try playlist tab content (for /playlist?list= URLs)
    let playlistTitle = null;
    let videoItems = [];

    // Path 1: Playlist page (/playlist?list=...)
    const playlistHeader = initialData?.header?.playlistHeaderRenderer;
    if (playlistHeader) {
      playlistTitle = playlistHeader.title?.simpleText || null;
    }

    const tabContents = initialData?.contents?.twoColumnBrowseResultsRenderer?.tabs;
    if (tabContents) {
      for (const tab of tabContents) {
        const tabRenderer = tab?.tabRenderer;
        if (!tabRenderer?.content) continue;

        // Playlist page: sectionListRenderer → itemSectionRenderer → playlistVideoListRenderer
        const sections = tabRenderer.content?.sectionListRenderer?.contents;
        if (sections) {
          for (const section of sections) {
            const items = section?.itemSectionRenderer?.contents;
            if (!items) continue;
            for (const item of items) {
              const plRenderer = item?.playlistVideoListRenderer;
              if (plRenderer?.contents) {
                for (const vid of plRenderer.contents) {
                  const r = vid?.playlistVideoRenderer;
                  if (r?.videoId) {
                    videoItems.push({
                      _type: 'video',
                      id: r.videoId,
                      title: r.title?.runs?.[0]?.text || `Video ${r.videoId}`,
                      url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      webpage_url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      duration: this._parseDuration(r.lengthText?.simpleText),
                      extractor: this.name,
                    });
                  }
                }
              }

              // Channel videos tab: gridRenderer or richGridRenderer
              const gridRenderer = item?.gridRenderer;
              if (gridRenderer?.items) {
                for (const gi of gridRenderer.items) {
                  const r = gi?.gridVideoRenderer;
                  if (r?.videoId) {
                    videoItems.push({
                      _type: 'video',
                      id: r.videoId,
                      title: r.title?.runs?.[0]?.text || r.title?.simpleText || `Video ${r.videoId}`,
                      url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      webpage_url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      duration: this._parseDuration(r.thumbnailOverlays?.[0]?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText),
                      extractor: this.name,
                    });
                  }
                }
              }

              // Rich grid (channel pages, newer layout)
              const richGrid = item?.richGridRenderer;
              if (richGrid?.contents) {
                for (const ri of richGrid.contents) {
                  const r = ri?.richItemRenderer?.content?.videoRenderer;
                  if (r?.videoId) {
                    videoItems.push({
                      _type: 'video',
                      id: r.videoId,
                      title: r.title?.runs?.[0]?.text || `Video ${r.videoId}`,
                      url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      webpage_url: `https://www.youtube.com/watch?v=${r.videoId}`,
                      duration: this._parseDuration(r.lengthText?.simpleText),
                      extractor: this.name,
                    });
                  }
                }
              }
            }
          }
        }

        // Channel page: richGridRenderer directly under tab content
        const richGrid = tabRenderer.content?.richGridRenderer;
        if (richGrid?.contents) {
          for (const ri of richGrid.contents) {
            const r = ri?.richItemRenderer?.content?.videoRenderer;
            if (r?.videoId) {
              videoItems.push({
                _type: 'video',
                id: r.videoId,
                title: r.title?.runs?.[0]?.text || `Video ${r.videoId}`,
                url: `https://www.youtube.com/watch?v=${r.videoId}`,
                webpage_url: `https://www.youtube.com/watch?v=${r.videoId}`,
                duration: this._parseDuration(r.lengthText?.simpleText),
                extractor: this.name,
              });
            }
          }
        }
      }
    }

    // Fallback: try to get channel/playlist title from metadata
    if (!playlistTitle) {
      const metadata = initialData?.metadata?.channelMetadataRenderer ||
                       initialData?.metadata?.playlistMetadataRenderer;
      playlistTitle = metadata?.title || null;
    }
    if (!playlistTitle) {
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
      if (ogTitle) playlistTitle = this._decodeHtmlEntities(ogTitle[1]);
    }
    if (!playlistTitle) playlistTitle = 'YouTube Playlist';

    if (videoItems.length === 0) throw new Error('No videos found in playlist/channel');
    console.log(`[${this.name}] Found ${videoItems.length} video(s) in "${playlistTitle}"`);

    return {
      _type: 'playlist',
      title: playlistTitle,
      entries: videoItems,
      extractor: this.name,
      url,
    };
  }

  // ========== Search ==========

  /**
   * Extract video results from a YouTube search URL.
   * Returns a playlist-style object with entries for each video found.
   */
  async _extractSearch(url, options) {
    console.log(`[${this.name}] Handling as search URL`);

    const pageHeaders = { ...YT_HEADERS };
    if (this._cookieHeader) pageHeaders['Cookie'] = this._cookieHeader;

    const response = await got(url, {
      headers: pageHeaders,
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    // Extract ytInitialData from the search results page
    const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\})\s*;/s) ||
                      html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;/s);
    if (!dataMatch) throw new Error('Could not parse YouTube search results');

    let initialData;
    try { initialData = JSON.parse(dataMatch[1]); } catch {
      throw new Error('Failed to parse YouTube search data');
    }

    // Navigate to the video results in ytInitialData
    const contents = initialData?.contents?.twoColumnSearchResultsRenderer
      ?.primaryContents?.sectionListRenderer?.contents;
    if (!contents) throw new Error('No search results found');

    const entries = [];
    for (const section of contents) {
      const items = section?.itemSectionRenderer?.contents;
      if (!items) continue;
      for (const item of items) {
        const renderer = item?.videoRenderer;
        if (!renderer?.videoId) continue;
        entries.push({
          _type: 'video',
          id: renderer.videoId,
          title: renderer.title?.runs?.[0]?.text || `Video ${renderer.videoId}`,
          url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
          webpage_url: `https://www.youtube.com/watch?v=${renderer.videoId}`,
          duration: this._parseDuration(renderer.lengthText?.simpleText),
          extractor: this.name,
        });
      }
    }

    if (entries.length === 0) throw new Error('No videos found in search results');
    console.log(`[${this.name}] Found ${entries.length} video(s) in search results`);

    return {
      _type: 'playlist',
      title: `YouTube Search: ${new URL(url).searchParams.get('search_query') || 'unknown'}`,
      entries,
      extractor: this.name,
      url,
    };
  }

  _parseDuration(text) {
    if (!text) return null;
    const parts = text.split(':').map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] || null;
  }

  // ========== Main Extract ==========

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Store cookies for use in all sub-requests
    this._cookieHeader = '';
    this._cookies = [];
    if (options.cookies && options.cookies.length > 0) {
      this._cookieHeader = buildCookieHeader(options.cookies, url);
      // Keep structured cookie objects for SAPISIDHASH generation
      this._cookies = getCookiesForUrl(options.cookies, 'https://www.youtube.com');
      if (this._cookieHeader) {
        console.log(`[${this.name}] Using ${options.cookies.length} cookies (${this._cookieHeader.split(';').length} matching)`);
      }
    }

    // Handle search URLs → return first result as a redirect
    if (/\/results\?.*search_query=/i.test(url)) {
      return await this._extractSearch(url, options);
    }

    // Handle playlist URLs → return playlist entries
    // Matches both /playlist?list=xxx and /watch?v=xxx&list=xxx
    if (/[?&]list=/.test(url)) {
      try {
        const parsed = new URL(url);
        const listId = parsed.searchParams.get('list');
        if (listId) {
          const playlistUrl = `https://www.youtube.com/playlist?list=${listId}`;
          return await this._extractPlaylist(playlistUrl, options);
        }
      } catch {}
    }

    // Handle channel URLs → return channel video entries
    if (/\/@[^/]+/.test(url) || /\/channel\//.test(url) || /\/c\//.test(url) || /\/user\//.test(url)) {
      return await this._extractPlaylist(url, options);
    }

    const videoId = this._extractVideoId(url);
    if (!videoId) throw new Error('Could not extract video ID from URL');
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // 1. Fetch YouTube page (for metadata + player JS URL)
    const pageHeaders = { ...YT_HEADERS };
    if (this._cookieHeader) pageHeaders['Cookie'] = this._cookieHeader;
    
    const response = await got(url, {
      headers: pageHeaders,
      timeout: { request: 30000 },
      followRedirect: true
    });
    const html = response.body;

    // 2. Extract title from page
    let title = null;
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
    if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]);
    if (!title) {
      const titleTag = html.match(/<title>([^<]+)<\/title>/);
      if (titleTag) title = this._decodeHtmlEntities(titleTag[1]).replace(/ - YouTube$/i, '').trim();
    }
    if (!title) title = `YouTube Video ${videoId}`;
    console.log(`[${this.name}] Title: ${title}`);

    // 3. Get player JS URL and download it
    const playerUrl = this._extractPlayerUrl(html);
    if (!playerUrl) throw new Error('Could not find player JS URL');
    console.log(`[${this.name}] Player URL: ${playerUrl}`);

    const playerJS = await this._getPlayerJS(playerUrl);
    const sts = this._extractSignatureTimestamp(playerJS);
    console.log(`[${this.name}] Signature timestamp: ${sts || 'not found'}`);

    // 4. Get metadata from embedded response
    const visitorData = this._extractVisitorData(html);
    let pagePlayerResponse = null;
    const prMatch = html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s) ||
                    html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;/s);
    try { if (prMatch) pagePlayerResponse = JSON.parse(prMatch[1]); } catch {}

    // Extract datasync ID and log SAPISIDHASH availability
    this._datasyncId = this._extractDatasyncId(html);
    if (this._datasyncId) {
      console.log(`[${this.name}] Datasync ID: ${this._datasyncId}`);
    }
    const sapisidTest = this._generateSapisidHash();
    if (sapisidTest) {
      console.log(`[${this.name}] SAPISIDHASH authentication available`);
    } else if (this._cookieHeader) {
      console.log(`[${this.name}] Warning: Cookies loaded but no SAPISID/__Secure-3PAPISID found — API calls will be unauthenticated`);
    }

    // Check LOGGED_IN status from page — warns when cookies are stale or incomplete
    const loggedInMatch = html.match(/"LOGGED_IN"\s*:\s*(true|false)/);
    const pageLoggedIn = loggedInMatch ? loggedInMatch[1] === 'true' : false;
    // Fix A: Trust cookie-based auth when SAPISID is derivable and __Secure-3PSID is present.
    // The page HTML LOGGED_IN flag is missing/unreliable on consent walls, bot-check pages,
    // and some geo-redirected responses — but if we have SAPISID + __Secure-3PSID cookies
    // we CAN generate a valid SAPISIDHASH, so API auth will work.
    const hasSapisid = !!sapisidTest;
    const has3PSID = !!this._cookies.find(c => c.name === '__Secure-3PSID');
    const cookieAuthPossible = hasSapisid && has3PSID;
    this._isLoggedIn = pageLoggedIn || cookieAuthPossible;
    this._sessionExpired = false;
    if (!pageLoggedIn && cookieAuthPossible) {
      console.log(`[${this.name}] ✓ Page says LOGGED_IN=false but auth cookies present — trusting SAPISIDHASH auth`);
    } else if (!this._isLoggedIn && this._cookieHeader) {
      this._sessionExpired = true;
      // Check which critical cookies are missing
      const criticalNames = ['HSID', 'SSID', '__Secure-1PSID', '__Secure-3PSID', 'LOGIN_INFO'];
      const missing = criticalNames.filter(name => !this._cookies.find(c => c.name === name));
      if (missing.length > 0) {
        console.log(`[${this.name}] ⚠ YouTube says LOGGED_IN=false — missing critical cookies: ${missing.join(', ')}`);
        console.log(`[${this.name}]   Premium formats require a complete cookie export. Re-export ALL cookies from your browser while logged in.`);
      } else {
        console.log(`[${this.name}] ⚠ YouTube says LOGGED_IN=false — session may have expired. Re-export cookies from your browser.`);
      }
    } else if (this._isLoggedIn) {
      console.log(`[${this.name}] ✓ Authenticated session (LOGGED_IN=true)`);
    }

    // Expected video duration from page metadata (used for probe validation)
    const videoDetails = pagePlayerResponse?.videoDetails || {};
    const expectedDuration = videoDetails.lengthSeconds ? parseInt(videoDetails.lengthSeconds) : 0;
    if (expectedDuration > 0) {
      const durMin = Math.floor(expectedDuration / 60);
      const durSec = expectedDuration % 60;
      console.log(`[${this.name}] Expected duration: ${durMin}:${String(durSec).padStart(2, '0')}`);
    }

    // 5-8. Try InnerTube clients with full challenge solving + URL probe.
    //       If a client's processed URLs are rejected by the CDN, fall back
    //       to the next client.  This is necessary because YouTube's n-challenge
    //       parameters make raw URLs return 403 — probing must happen AFTER solving.
    const triedClients = new Set();
    let formats = null;
    let clientName = null;
    let clientConfig = null;
    let hlsManifestUrl = null;  // Captured across iterations for HLS fallback

    while (triedClients.size < INNERTUBE_CLIENTS.length) {
      // 5. Get formats from next untried client
      const apiResult = await this._getFormatsFromApi(videoId, sts, visitorData, triedClients);
      if (!apiResult) {
        // If every single API client returned 401 and we were sending SAPISIDHASH,
        // the auth is being rejected (stale PSIDTS, missing runtime Set-Cookie,
        // etc.).  Retry ALL clients without auth so IOS/HLS fallback can work.
        if (this._lastApiAll401 && this._isLoggedIn) {
          console.log(`[${this.name}] All API clients returned 401 with auth — retrying without SAPISIDHASH`);
          this._isLoggedIn = false;
          this._sessionExpired = true;
          this._datasyncId = null;
          triedClients.clear();
          continue;
        }
        break; // all clients exhausted
      }

      const { formats: rawFormats, clientName: cName, clientConfig: cConfig, poToken, hlsManifestUrl: hlsUrl } = apiResult;
      if (hlsUrl && !hlsManifestUrl) hlsManifestUrl = hlsUrl;  // Keep first HLS URL
      clientName = cName;
      clientConfig = cConfig;

      // 6. Process formats: collect challenges, build entries
      const sigLengthsSet = new Set();
      const nValuesSet = new Set();
      const formatEntries = [];

      for (const fmt of rawFormats) {
        let fmtUrl = fmt.url || null;
        let encryptedSig = null;
        let sigParam = 'signature';

        if (!fmtUrl && fmt.signatureCipher) {
          const params = new URLSearchParams(fmt.signatureCipher);
          fmtUrl = params.get('url');
          encryptedSig = params.get('s');
          sigParam = params.get('sp') || 'signature';
          if (encryptedSig) sigLengthsSet.add(encryptedSig.length);
        }

        if (!fmtUrl) continue;

        let nValue = null;
        try {
          nValue = new URL(fmtUrl).searchParams.get('n');
          if (nValue) nValuesSet.add(nValue);
        } catch {}

        formatEntries.push({ raw: fmt, url: fmtUrl, encryptedSig, sigParam, nValue });
      }

      console.log(`[${this.name}] Challenges: ${sigLengthsSet.size} sig, ${nValuesSet.size} n`);

      // 7. Solve challenges if needed
      if (sigLengthsSet.size > 0 || nValuesSet.size > 0) {
        try {
          await this._solveAllChallenges(playerUrl, playerJS, [...sigLengthsSet], [...nValuesSet]);
        } catch (solverErr) {
          console.warn(`[${this.name}] ${cName}: Challenge solver failed — skipping client: ${solverErr.message}`);
          continue;
        }
      }

      const cache = this._playerCache.get(playerUrl);

      // Build per-client download headers (must match the client User-Agent for CDN validation)
      const clientUA = cConfig?.client?.userAgent || DOWNLOAD_HEADERS['User-Agent'];
      const formatDownloadHeaders = {
        ...DOWNLOAD_HEADERS,
        'User-Agent': clientUA
      };
      if (this._cookieHeader) formatDownloadHeaders['Cookie'] = this._cookieHeader;

      // 8. Build final format list
      const candidateFormats = [];

      for (const entry of formatEntries) {
        const { raw: fmt, encryptedSig, sigParam, nValue } = entry;
        let finalUrl = entry.url;

        // Apply signature decryption if needed
        if (encryptedSig) {
          const spec = cache.sigSpecs[encryptedSig.length];
          if (!spec) {
            console.warn(`[${this.name}] No sig spec for length ${encryptedSig.length}, skipping itag=${fmt.itag}`);
            continue;
          }
          finalUrl = this._applySignature(spec, encryptedSig, sigParam, finalUrl);
        }

        // Apply n-challenge result
        if (nValue && cache?.nResults?.[nValue]) {
          finalUrl = this._applyNChallenge(finalUrl, cache.nResults[nValue]);
        }

        // Apply PO (Proof of Origin) token — required by the CDN to serve
        // real content instead of preview stubs for many video types.
        if (poToken) {
          try {
            const u = new URL(finalUrl);
            u.searchParams.set('pot', poToken);
            finalUrl = u.toString();
          } catch {}
        }

        // Parse format metadata
        const mimeType = fmt.mimeType || '';
        const hasVideo = mimeType.startsWith('video/');
        const hasAudio = mimeType.startsWith('audio/') ||
                         (hasVideo && /mp4a|opus|vorbis|aac/.test(mimeType));
        const height = fmt.height || 0;
        const width = fmt.width || 0;

        let ext = 'mp4';
        if (mimeType.includes('video/webm')) ext = 'webm';
        else if (mimeType.includes('audio/mp4')) ext = 'm4a';
        else if (mimeType.includes('audio/webm')) ext = 'webm';
        else if (mimeType.includes('video/3gpp')) ext = '3gp';

        // Detect YouTube Premium enhanced bitrate formats
        const rawQualityLabel = fmt.qualityLabel || '';
        const isPremium = /premium/i.test(rawQualityLabel);

        let quality = rawQualityLabel || fmt.quality || 'unknown';
        if (height > 0) {
          quality = `${height}p`;
          if (fmt.fps && fmt.fps > 30) quality += `${fmt.fps}`;
        } else if (hasAudio && !hasVideo) {
          if (fmt.averageBitrate) quality = `${Math.round(fmt.averageBitrate / 1000)}k`;
          else if ((fmt.audioQuality || '').includes('MEDIUM')) quality = '128k';
          else if ((fmt.audioQuality || '').includes('LOW')) quality = '50k';
          else if ((fmt.audioQuality || '').includes('HIGH')) quality = '256k';
          else quality = 'audio';
        }

        const codecsMatch = mimeType.match(/codecs="([^"]+)"/);
        const codecParts = (codecsMatch ? codecsMatch[1] : '').split(',').map(c => c.trim());

        candidateFormats.push({
          quality,
          url: finalUrl,
          width,
          height,
          format_id: fmt.itag ? `${fmt.itag}` : quality,
          ext,
          protocol: 'https',
          hasVideo,
          hasAudio,
          mimeType,
          bitrate: fmt.bitrate || 0,
          filesize: fmt.contentLength ? parseInt(fmt.contentLength) : null,
          fps: fmt.fps || null,
          vcodec: hasVideo ? (codecParts[0] || null) : null,
          acodec: hasAudio ? (codecParts[hasVideo ? 1 : 0] || null) : null,
          audioTrackLang: fmt.audioTrack?.id?.split('.')[0] || null,
          audioTrackName: fmt.audioTrack?.displayName || null,
          audioIsDefault: fmt.audioTrack?.audioIsDefault || false,
          isPremium,
          headers: formatDownloadHeaders
        });
      }

      if (candidateFormats.length === 0) {
        console.log(`[${this.name}] ${cName}: No formats survived processing, trying next client...`);
        continue;
      }

      // Quick pre-probe: if the API reported contentLength for formats and
      // we know the expected duration, check if the sizes make sense before
      // doing an HTTP probe.  This avoids wasting time on clients that the
      // API itself already reveals as serving preview/stub content.
      if (expectedDuration > 30) {
        const videoFmt = candidateFormats.find(f => f.hasVideo && f.filesize);
        if (videoFmt && videoFmt.filesize > 0) {
          const minExpected = expectedDuration * 1024; // ~1 KB/s minimum
          if (videoFmt.filesize < minExpected) {
            console.log(`[${this.name}] ${cName}: Video stream is only ${(videoFmt.filesize / 1024).toFixed(0)} KB for a ${Math.round(expectedDuration)}s video — preview/stub, skipping client`);
            continue;
          }
        }
      }

      // Probe a processed URL to verify the CDN actually serves bytes.
      // This catches clients like ANDROID_VR whose URLs look valid but
      // return 0 bytes, as well as expired/blocked URLs.
      const probeTarget = candidateFormats.find(f => f.url);
      if (probeTarget) {
        const probeOk = await this._probeFormatUrl(probeTarget.url, cConfig, { expectedDuration });
        if (!probeOk) {
          console.log(`[${this.name}] ${cName}: Post-processing URL probe failed \u2014 CDN rejected, trying next client...`);
          continue;
        }
        console.log(`[${this.name}] ${cName}: URL probe OK`);
      }

      // Fix B: Some clients (notably TV/TVHTML5) return mostly SABR formats
      // where only a single low-res muxed format has a direct URL — the other
      // 30+ adaptive 1080p/4K entries use serverAbrStreamingUrl which we can't
      // decode.  If we only got combined-muxed formats (no video-only adaptive),
      // keep trying other clients that may return proper DASH adaptive streams.
      const hasAdaptive = candidateFormats.some(f => f.hasVideo && !f.hasAudio);
      const bestMuxedHeight = Math.max(0, ...candidateFormats.map(f => f.height || 0));
      if (!hasAdaptive) {
        console.log(`[${this.name}] ${cName}: only muxed formats (best ${bestMuxedHeight}p, no adaptive) — stashing as fallback, trying next client for DASH`);
        // Keep the best muxed result as fallback in case no client yields adaptive
        if (!formats || (bestMuxedHeight > Math.max(0, ...(formats.map(f => f.height || 0))))) {
          formats = candidateFormats;
          clientName = cName;
          clientConfig = cConfig;
        }
        continue;
      }

      // Fix C: IOS DASH/adaptive format URLs contain &c=IOS and the CDN
      // enforces that only tiny Range requests (probe-size) succeed — larger
      // bounded-Range or full-file downloads get 403.  Instead of breaking
      // here, continue the loop to give WEB/MWEB a chance to return proper
      // DASH adaptive streams (which often include AV1/av01 at high quality).
      // If no later client succeeds, the HLS fallback (step 10) picks it up.
      if (cName === 'IOS' && hlsManifestUrl) {
        console.log(`[${this.name}] IOS: DASH has CDN restrictions — trying remaining clients (WEB/MWEB) for DASH/AV1 before HLS...`);
        // Clear any Fix B muxed stash so the HLS fallback can win over it
        formats = null;
        clientName = null;
        clientConfig = null;
        continue;
      }

      formats = candidateFormats;
      break;
    }

    // IOS client handling is now done inside the loop (Fix C above).
    // If no later client produced DASH formats, formats remains null and the
    // HLS fallback at step 10 will use hlsManifestUrl from IOS.
    let forceHLS = false;

    // 9. Fallback: try formats from the page-embedded ytInitialPlayerResponse.
    //    The page was fetched WITH cookies, so the embedded response reflects
    //    the authenticated session — it may have full formats even when the
    //    API clients (without SAPISIDHASH) returned only preview stubs.
    if (!forceHLS && (!formats || formats.length === 0) && pagePlayerResponse?.streamingData) {
      const sd = pagePlayerResponse.streamingData;
      // Also check page-embedded HLS manifest
      if (sd.hlsManifestUrl && !hlsManifestUrl) {
        hlsManifestUrl = sd.hlsManifestUrl;
        console.log(`[${this.name}] PAGE: HLS manifest available`);
      }
      const pageFormats = [...(sd.formats || []), ...(sd.adaptiveFormats || [])];
      const withUrl = pageFormats.filter(f => f.url).length;
      const withSigCipher = pageFormats.filter(f => f.signatureCipher).length;
      // Extract PO token from page player response
      const pagePoToken = pagePlayerResponse.serviceIntegrityDimensions?.poToken || null;
      console.log(`[${this.name}] PAGE (embedded): ${pageFormats.length} formats (${withUrl} url, ${withSigCipher} signatureCipher)${pagePoToken ? ` [PO token: ${pagePoToken.length} chars]` : ''}`);


      if (pageFormats.length > 0) {
        // Process exactly like API formats: collect challenges, solve, build entries
        const sigLengthsSet = new Set();
        const nValuesSet = new Set();
        const formatEntries = [];

        for (const fmt of pageFormats) {
          let fmtUrl = fmt.url || null;
          let encryptedSig = null;
          let sigParam = 'signature';

          if (!fmtUrl && fmt.signatureCipher) {
            const params = new URLSearchParams(fmt.signatureCipher);
            fmtUrl = params.get('url');
            encryptedSig = params.get('s');
            sigParam = params.get('sp') || 'signature';
            if (encryptedSig) sigLengthsSet.add(encryptedSig.length);
          }
          if (!fmtUrl) continue;

          let nValue = null;
          try {
            nValue = new URL(fmtUrl).searchParams.get('n');
            if (nValue) nValuesSet.add(nValue);
          } catch {}

          formatEntries.push({ raw: fmt, url: fmtUrl, encryptedSig, sigParam, nValue });
        }

        if (sigLengthsSet.size > 0 || nValuesSet.size > 0) {
          try {
            await this._solveAllChallenges(playerUrl, playerJS, [...sigLengthsSet], [...nValuesSet]);
          } catch (solverErr) {
            console.warn(`[${this.name}] PAGE: Challenge solver failed — skipping page formats: ${solverErr.message}`);
            // Fall through to HLS
          }
        }

        const cache = this._playerCache.get(playerUrl);
        const pageDownloadHeaders = {
          ...DOWNLOAD_HEADERS,
          // Page-embedded response is the WEB client
          'User-Agent': DOWNLOAD_HEADERS['User-Agent']
        };
        if (this._cookieHeader) pageDownloadHeaders['Cookie'] = this._cookieHeader;

        const pageCandidates = [];
        for (const entry of formatEntries) {
          const { raw: fmt, encryptedSig, sigParam, nValue } = entry;
          let finalUrl = entry.url;

          if (encryptedSig) {
            const spec = cache.sigSpecs[encryptedSig.length];
            if (!spec) continue;
            finalUrl = this._applySignature(spec, encryptedSig, sigParam, finalUrl);
          }
          if (nValue && cache?.nResults?.[nValue]) {
            finalUrl = this._applyNChallenge(finalUrl, cache.nResults[nValue]);
          }

          // Apply PO token from page response
          if (pagePoToken) {
            try {
              const u = new URL(finalUrl);
              u.searchParams.set('pot', pagePoToken);
              finalUrl = u.toString();
            } catch {}
          }

          const mimeType = fmt.mimeType || '';
          const hasVideo = mimeType.startsWith('video/');
          const hasAudio = mimeType.startsWith('audio/') ||
                           (hasVideo && /mp4a|opus|vorbis|aac/.test(mimeType));
          const height = fmt.height || 0;
          const width = fmt.width || 0;

          let ext = 'mp4';
          if (mimeType.includes('video/webm')) ext = 'webm';
          else if (mimeType.includes('audio/mp4')) ext = 'm4a';
          else if (mimeType.includes('audio/webm')) ext = 'webm';
          else if (mimeType.includes('video/3gpp')) ext = '3gp';

          // Detect YouTube Premium enhanced bitrate formats
          const rawQualityLabel = fmt.qualityLabel || '';
          const isPremium = /premium/i.test(rawQualityLabel);

          let quality = rawQualityLabel || fmt.quality || 'unknown';
          if (height > 0) {
            quality = `${height}p`;
            if (fmt.fps && fmt.fps > 30) quality += `${fmt.fps}`;
          } else if (hasAudio && !hasVideo) {
            if (fmt.averageBitrate) quality = `${Math.round(fmt.averageBitrate / 1000)}k`;
            else if ((fmt.audioQuality || '').includes('MEDIUM')) quality = '128k';
            else if ((fmt.audioQuality || '').includes('LOW')) quality = '50k';
            else if ((fmt.audioQuality || '').includes('HIGH')) quality = '256k';
            else quality = 'audio';
          }

          const codecsMatch = mimeType.match(/codecs="([^"]+)"/);
          const codecParts = (codecsMatch ? codecsMatch[1] : '').split(',').map(c => c.trim());

          pageCandidates.push({
            quality,
            url: finalUrl,
            width,
            height,
            format_id: fmt.itag ? `${fmt.itag}` : quality,
            ext,
            protocol: 'https',
            hasVideo,
            hasAudio,
            mimeType,
            bitrate: fmt.bitrate || 0,
            filesize: fmt.contentLength ? parseInt(fmt.contentLength) : null,
            fps: fmt.fps || null,
            vcodec: hasVideo ? (codecParts[0] || null) : null,
            acodec: hasAudio ? (codecParts[hasVideo ? 1 : 0] || null) : null,
            isPremium,
            headers: pageDownloadHeaders
          });
        }

        if (pageCandidates.length > 0) {
          // Same pre-probe and probe as API clients
          let pageOk = true;
          if (expectedDuration > 30) {
            const videoFmt = pageCandidates.find(f => f.hasVideo && f.filesize);
            if (videoFmt && videoFmt.filesize > 0) {
              const minExpected = expectedDuration * 1024;
              if (videoFmt.filesize < minExpected) {
                console.log(`[${this.name}] PAGE: Video stream is only ${(videoFmt.filesize / 1024).toFixed(0)} KB for a ${Math.round(expectedDuration)}s video — preview/stub`);
                pageOk = false;
              }
            }
          }

          if (pageOk) {
            const webConfig = INNERTUBE_CLIENTS.find(c => c.name === 'WEB');
            const probeTarget = pageCandidates.find(f => f.url);
            if (probeTarget) {
              const probeOk = await this._probeFormatUrl(probeTarget.url, webConfig, { expectedDuration });
              if (probeOk) {
                console.log(`[${this.name}] PAGE (embedded): URL probe OK — using page formats`);
                formats = pageCandidates;
                clientName = 'PAGE';
              } else {
                console.log(`[${this.name}] PAGE (embedded): URL probe failed`);
              }
            }
          }
        }
      }
    }

    // 10. Last resort: HLS manifest fallback.
    //     Live streams/replays often have HLS manifests that serve real content
    //     via segment URLs without PO tokens.  Use ffmpeg-based HLS download.
    if ((!formats || formats.length === 0) && hlsManifestUrl) {
      console.log(`[${this.name}] All direct-download clients exhausted — falling back to HLS manifest`);
      console.log(`[${this.name}] HLS URL: ${hlsManifestUrl}`);

      const hlsHeaders = { ...DOWNLOAD_HEADERS };
      if (this._cookieHeader) hlsHeaders['Cookie'] = this._cookieHeader;

      // Fetch and parse the master playlist to extract per-quality variants
      try {
        const hlsResp = await got(hlsManifestUrl, {
          headers: hlsHeaders,
          timeout: { request: 15000 },
        });
        const masterPlaylist = hlsResp.body;
        const hlsFormats = this._parseHlsMasterPlaylist(masterPlaylist, hlsManifestUrl, hlsHeaders);

        if (hlsFormats.length > 0) {
          formats = hlsFormats;
          console.log(`[${this.name}] HLS: parsed ${hlsFormats.length} variant(s) — ${hlsFormats.filter(f => f.hasVideo && !f.hasAudio).length} video-only, ${hlsFormats.filter(f => f.hasAudio && !f.hasVideo).length} audio-only, ${hlsFormats.filter(f => f.hasVideo && f.hasAudio).length} combined`);
        } else {
          // Parsing returned nothing useful — fall back to single "best" entry
          console.log(`[${this.name}] HLS: could not parse variants, using master playlist as single format`);
          formats = [{
            quality: 'best',
            url: hlsManifestUrl,
            width: 0,
            height: 0,
            format_id: 'hls-manifest',
            ext: 'm3u8',
            protocol: 'hls',
            hasVideo: true,
            hasAudio: true,
            mimeType: 'application/vnd.apple.mpegURL',
            bitrate: 0,
            filesize: null,
            fps: null,
            vcodec: null,
            acodec: null,
            headers: hlsHeaders
          }];
        }
      } catch (e) {
        console.log(`[${this.name}] HLS: failed to fetch master playlist (${e.message}), using URL directly`);
        formats = [{
          quality: 'best',
          url: hlsManifestUrl,
          width: 0,
          height: 0,
          format_id: 'hls-manifest',
          ext: 'm3u8',
          protocol: 'hls',
          hasVideo: true,
          hasAudio: true,
          mimeType: 'application/vnd.apple.mpegURL',
          bitrate: 0,
          filesize: null,
          fps: null,
          vcodec: null,
          acodec: null,
          headers: hlsHeaders
        }];
      }

      clientName = 'HLS';
    }

    if (!formats || formats.length === 0) {
      throw new Error('No InnerTube client returned downloadable formats (all clients exhausted)');
    }

    // Sort: combined video+audio first, then by height, then bitrate
    // Sort: combined video+audio first, then by height, then codec (AV1 > VP9 > H.264), then bitrate
    const _codecRank = (f) => {
      const vc = (f.vcodec || '').toLowerCase();
      if (vc.startsWith('av01')) return 0; // AV1 — best compression
      if (vc.startsWith('vp0')) return 1;  // VP9
      return 2;                            // H.264 / other
    };
    formats.sort((a, b) => {
      const ac = a.hasVideo && a.hasAudio;
      const bc = b.hasVideo && b.hasAudio;
      if (ac && !bc) return -1;
      if (!ac && bc) return 1;
      if (a.height !== b.height) return (b.height || 0) - (a.height || 0);
      const cr = _codecRank(a) - _codecRank(b);
      if (cr !== 0) return cr;
      return (b.bitrate || 0) - (a.bitrate || 0);
    });

    console.log(`[${this.name}] Extracted ${formats.length} format(s) via ${clientName}`);

    const combined = formats.filter(f => f.hasVideo && f.hasAudio);
    const videoOnly = formats.filter(f => f.hasVideo && !f.hasAudio);
    const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);
    console.log(`[${this.name}] ${combined.length} combined, ${videoOnly.length} video-only, ${audioOnly.length} audio-only`);

    // 9. Fetch captions via WEB client (ANDROID_VR never returns captions)
    let subtitles = null;
    let translationLanguages = null;
    try {
      const captionData = await this._getCaptionsFromApi(videoId, sts, visitorData);
      if (captionData) {
        subtitles = captionData.subtitles;
        translationLanguages = captionData.translationLanguages;
        const langs = Object.keys(subtitles);
        const kinds = langs.map(l => subtitles[l].isAutoGenerated ? `${l}(auto)` : l);
        console.log(`[${this.name}] Subtitles: ${kinds.join(', ')} (${translationLanguages?.length || 0} translation languages)`);
      } else {
        console.log(`[${this.name}] No subtitles available`);
      }
    } catch (e) {
      console.log(`[${this.name}] Subtitle extraction failed: ${e.message}`);
    }

    const videoDetails2 = pagePlayerResponse?.videoDetails || {};

    // 10. Extract chapters from description or page data
    const videoDuration = videoDetails2.lengthSeconds ? parseInt(videoDetails2.lengthSeconds) : null;
    let chapters = this._extractChapters(videoDetails2.shortDescription || '', videoDuration);
    if (!chapters || chapters.length === 0) {
      // Try from engagementPanels / macroMarkers in page data
      chapters = this._extractChaptersFromPageData(html, videoDuration);
    }
    if (chapters && chapters.length > 0) {
      console.log(`[${this.name}] Chapters: ${chapters.length} markers found`);
    }

    return {
      title,
      formats,
      extractor: this.name,
      url,
      videoId,
      duration: videoDuration,
      description: videoDetails2.shortDescription || null,
      uploader: videoDetails2.author || null,
      thumbnail: videoDetails2.thumbnail?.thumbnails?.at(-1)?.url || null,
      subtitles: subtitles || null,
      translationLanguages: translationLanguages || null,
      chapters: chapters && chapters.length > 0 ? chapters : null,
      sessionExpired: this._sessionExpired || false,
      hasSapisidAuth: !!this._generateSapisidHash()
    };
  }

  /**
   * Parse chapters from YouTube video description.
   * YouTube requires: first timestamp at 0:00, at least 3 timestamps.
   * Format: "H:MM:SS title" or "MM:SS title" or "M:SS title"
   */
  _extractChapters(description, duration) {
    if (!description) return null;

    const lines = description.split('\n');
    const timestamps = [];

    for (const line of lines) {
      // Match patterns like "0:00 Intro", "01:30 Topic", "1:05:30 Section"
      const match = line.match(/^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/);
      if (match) {
        const hours = match[1] ? parseInt(match[1]) : 0;
        const minutes = parseInt(match[2]);
        const seconds = parseInt(match[3]);
        const title = match[4].trim();
        const startTime = hours * 3600 + minutes * 60 + seconds;
        timestamps.push({ start_time: startTime, title });
      }
    }

    // YouTube requires at least 3 chapters and the first must start at 0:00
    if (timestamps.length < 3 || timestamps[0].start_time !== 0) return null;

    // Verify timestamps are in ascending order
    for (let i = 1; i < timestamps.length; i++) {
      if (timestamps[i].start_time <= timestamps[i - 1].start_time) return null;
    }

    // Build chapter array with end_time
    const chapters = [];
    for (let i = 0; i < timestamps.length; i++) {
      const endTime = (i + 1 < timestamps.length)
        ? timestamps[i + 1].start_time
        : (duration || timestamps[i].start_time + 1);
      chapters.push({
        start_time: timestamps[i].start_time,
        end_time: endTime,
        title: timestamps[i].title,
      });
    }
    return chapters;
  }

  /**
   * Try to extract chapters from YouTube's page data (engagementPanels / macroMarkers).
   */
  _extractChaptersFromPageData(html, duration) {
    try {
      // Look for ytInitialData which contains engagement panels with chapters
      const dataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script/s) ||
                        html.match(/ytInitialData\s*=\s*(\{.+?\})\s*;\s*<\/script/s);
      if (!dataMatch) return null;

      const data = JSON.parse(dataMatch[1]);

      // Navigate to macroMarkers in engagementPanels
      const panels = data?.engagementPanels || [];
      for (const panel of panels) {
        const content = panel?.engagementPanelSectionListRenderer?.content;
        const macroMarkers = content?.macroMarkersListItemRenderer;
        if (macroMarkers) {
          // Found chapter markers
          return this._parseMacroMarkers(macroMarkers, duration);
        }

        // Also check structured description chapters
        const chapters = content?.structuredDescriptionContentRenderer?.items;
        if (chapters) {
          for (const item of chapters) {
            const renderer = item?.horizontalCardListRenderer;
            if (!renderer) continue;
            const cards = renderer.cards || [];
            const result = [];
            for (const card of cards) {
              const ch = card?.macroMarkersListItemRenderer;
              if (!ch) continue;
              const title = ch.title?.simpleText || ch.title?.runs?.map(r => r.text).join('') || '';
              const startSecs = parseInt(ch.onTap?.watchEndpoint?.startTimeSeconds || '0');
              result.push({ start_time: startSecs, title });
            }
            if (result.length >= 3) {
              // Add end_time
              const chapters = [];
              for (let i = 0; i < result.length; i++) {
                const endTime = (i + 1 < result.length)
                  ? result[i + 1].start_time
                  : (duration || result[i].start_time + 1);
                chapters.push({ start_time: result[i].start_time, end_time: endTime, title: result[i].title });
              }
              return chapters;
            }
          }
        }
      }
    } catch {
      // Parsing failed — not critical
    }
    return null;
  }

  _parseMacroMarkers(markers, duration) {
    if (!markers || !Array.isArray(markers)) return null;
    const result = [];
    for (const m of markers) {
      const title = m.title?.simpleText || m.title?.runs?.map(r => r.text).join('') || '';
      const startSecs = parseInt(m.onTap?.watchEndpoint?.startTimeSeconds || '0');
      result.push({ start_time: startSecs, title });
    }
    if (result.length < 3) return null;
    const chapters = [];
    for (let i = 0; i < result.length; i++) {
      const endTime = (i + 1 < result.length)
        ? result[i + 1].start_time
        : (duration || result[i].start_time + 1);
      chapters.push({ start_time: result[i].start_time, end_time: endTime, title: result[i].title });
    }
    return chapters;
  }
}
