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

// InnerTube client configurations (from yt-dlp)
// Order: authenticated clients first (SAPISIDHASH), then clients that don't
// need PO tokens, then PO-token-required clients as last resort.
const INNERTUBE_CLIENTS = [
  // --- Authenticated clients (SAPISIDHASH + onBehalfOfUser) ---
  // When auth works, these give full-resolution streams without PO tokens.
  {
    name: 'WEB_CREATOR',
    clientNameId: 62,
    client: {
      clientName: 'WEB_CREATOR',
      clientVersion: '1.20260228.01.00',
      hl: 'en',
      timeZone: 'UTC',
      utcOffsetMinutes: 0,
    },
    apiKey: 'AIzaSyBUPetSUmoZL-OhlxA7wSac5XinrygCqMo',
    requiresJs: true,
    useSts: true,
  },
  {
    name: 'TV',
    clientNameId: 7,
    client: {
      clientName: 'TVHTML5',
      clientVersion: '7.20260228.01.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
      hl: 'en',
    },
    requiresJs: true,
    useSts: true,
  },
  // --- Clients that reportedly don't need PO tokens ---
  {
    name: 'TV_EMBEDDED',
    clientNameId: 85,
    client: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
      clientVersion: '2.0',
      hl: 'en',
    },
    thirdParty: { embedUrl: 'https://www.youtube.com/' },
    requiresJs: true,
    useSts: true,
  },
  {
    name: 'MEDIA_CONNECT',
    clientNameId: 95,
    client: {
      clientName: 'MEDIA_CONNECT_FRONTEND',
      clientVersion: '0.1',
      hl: 'en',
    },
    requiresJs: false,
  },
  // --- IOS client: gives direct URLs, may work for some content ---
  {
    name: 'IOS',
    clientNameId: 5,
    client: {
      clientName: 'IOS',
      clientVersion: '20.03.02',
      deviceMake: 'Apple',
      deviceModel: 'iPhone16,2',
      userAgent: 'com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_3_1 like Mac OS X;)',
      osName: 'iPhone',
      osVersion: '18.3.1.22D72',
      hl: 'en',
    },
    requiresJs: false,
  },
  // --- PO token usually required for full content ---
  {
    name: 'WEB',
    clientNameId: 1,
    client: {
      clientName: 'WEB',
      clientVersion: '2.20260228.01.00',
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
      clientVersion: '2.20260228.01.00',
      hl: 'en',
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1,gzip(gfe)',
    },
    requiresJs: true,
    useSts: true,
  },
  {
    name: 'ANDROID_VR',
    clientNameId: 28,
    client: {
      clientName: 'ANDROID_VR',
      clientVersion: '1.71.26',
      deviceMake: 'Oculus',
      deviceModel: 'Quest 3',
      androidSdkVersion: 32,
      userAgent: 'com.google.android.apps.youtube.vr.oculus/1.71.26 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      osName: 'Android',
      osVersion: '12L',
      hl: 'en',
    },
    requiresJs: false,
  },
  {
    name: 'WEB_EMBEDDED',
    clientNameId: 56,
    client: {
      clientName: 'WEB_EMBEDDED_PLAYER',
      clientVersion: '1.20260228.01.00',
      hl: 'en',
    },
    thirdParty: { embedUrl: 'https://www.youtube.com/' },
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
    // Format is typically "number||" — extract the numeric part
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
    const sapisidHash = this._generateSapisidHash('https://www.youtube.com');
    if (sapisidHash) {
      headers['Authorization'] = sapisidHash;
      headers['X-Goog-AuthUser'] = '0';
      headers['X-Origin'] = 'https://www.youtube.com';
      if (this._datasyncId) {
        headers['X-Goog-PageId'] = this._datasyncId;
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
    for (const clientConfig of INNERTUBE_CLIENTS) {
      if (skipClients.has(clientConfig.name)) continue;
      // Mark client as tried immediately — prevents re-trying failed clients
      // when the caller re-invokes after a probe rejection.
      skipClients.add(clientConfig.name);

      try {
        console.log(`[${this.name}] Trying ${clientConfig.name} client...`);
        const response = await this._callPlayerApi(videoId, clientConfig, sts, visitorData);

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

    const result = solver({ type: 'player', player: playerJS, requests });

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
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
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
      if (!apiResult) break; // all clients exhausted

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
        await this._solveAllChallenges(playerUrl, playerJS, [...sigLengthsSet], [...nValuesSet]);
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

        let quality = fmt.qualityLabel || fmt.quality || 'unknown';
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

      formats = candidateFormats;
      break;
    }

    // IOS client DASH/adaptive format URLs contain &c=IOS and the CDN
    // enforces that only tiny Range requests (probe-size) succeed — larger
    // bounded-Range or full-file downloads get 403.  The real iOS app uses
    // HLS, not DASH.  So when IOS is the winning client and an HLS manifest
    // is available, discard the DASH formats and jump straight to HLS
    // (skip PAGE fallback which would only yield a low-quality combined format).
    let forceHLS = false;
    if (formats && formats.length > 0 && clientName === 'IOS' && hlsManifestUrl) {
      console.log(`[${this.name}] IOS DASH formats have CDN restrictions — switching to HLS manifest`);
      formats = null;
      forceHLS = true;
    }

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
          await this._solveAllChallenges(playerUrl, playerJS, [...sigLengthsSet], [...nValuesSet]);
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

          let quality = fmt.qualityLabel || fmt.quality || 'unknown';
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
    formats.sort((a, b) => {
      const ac = a.hasVideo && a.hasAudio;
      const bc = b.hasVideo && b.hasAudio;
      if (ac && !bc) return -1;
      if (!ac && bc) return 1;
      if (a.height !== b.height) return (b.height || 0) - (a.height || 0);
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

    return {
      title,
      formats,
      extractor: this.name,
      url,
      videoId,
      duration: videoDetails2.lengthSeconds ? parseInt(videoDetails2.lengthSeconds) : null,
      description: videoDetails2.shortDescription || null,
      uploader: videoDetails2.author || null,
      thumbnail: videoDetails2.thumbnail?.thumbnails?.at(-1)?.url || null,
      subtitles: subtitles || null,
      translationLanguages: translationLanguages || null
    };
  }
}
