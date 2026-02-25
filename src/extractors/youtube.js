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

import { BaseExtractor } from './base.js';
import got from 'got';
import fs from 'fs';
import path from 'path';
import { buildCookieHeader } from '../cookies.js';
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

// InnerTube client configurations (from yt-dlp)
// Priority: clients that DON'T need PO (Proof of Origin) tokens first
const INNERTUBE_CLIENTS = [
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
    name: 'TV',
    clientNameId: 7,
    client: {
      clientName: 'TVHTML5',
      clientVersion: '7.20260114.12.00',
      userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
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
    // web_embedded needs thirdParty.embedUrl in the context
    thirdParty: { embedUrl: 'https://www.youtube.com/' },
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
      /shorts\/([a-zA-Z0-9_-]{11})/
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
    const apiUrl = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

    const context = { client: { ...clientConfig.client } };

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
   * Returns the first response that has formats with URLs.
   */
  async _getFormatsFromApi(videoId, sts, visitorData) {
    for (const clientConfig of INNERTUBE_CLIENTS) {
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

        const allFormats = [
          ...(sd.formats || []),
          ...(sd.adaptiveFormats || [])
        ];

        // Count formats with URLs
        const withUrl = allFormats.filter(f => f.url).length;
        const withSigCipher = allFormats.filter(f => f.signatureCipher).length;
        const usable = withUrl + withSigCipher;

        console.log(`[${this.name}] ${clientConfig.name}: ${allFormats.length} formats (${withUrl} url, ${withSigCipher} signatureCipher)`);

        if (usable > 0) {
          return { formats: allFormats, clientName: clientConfig.name, clientConfig, requiresJs: clientConfig.requiresJs };
        }
      } catch (e) {
        console.log(`[${this.name}] ${clientConfig.name} failed: ${e.message}`);
      }
    }

    throw new Error('No InnerTube client returned downloadable formats');
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
    if (options.cookies && options.cookies.length > 0) {
      this._cookieHeader = buildCookieHeader(options.cookies, url);
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

    // 5. Try multiple InnerTube clients to get formats with URLs
    const { formats: rawFormats, clientName, clientConfig, requiresJs } = await this._getFormatsFromApi(videoId, sts, visitorData);

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
    const clientUA = clientConfig?.client?.userAgent || DOWNLOAD_HEADERS['User-Agent'];
    const formatDownloadHeaders = {
      ...DOWNLOAD_HEADERS,
      'User-Agent': clientUA
    };
    if (this._cookieHeader) formatDownloadHeaders['Cookie'] = this._cookieHeader;

    // 8. Build final format list
    const formats = [];

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

      formats.push({
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
        headers: formatDownloadHeaders
      });
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

    if (formats.length === 0) {
      throw new Error('No downloadable formats found after processing');
    }

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

    const videoDetails = pagePlayerResponse?.videoDetails || {};

    return {
      title,
      formats,
      extractor: this.name,
      url,
      videoId,
      duration: videoDetails.lengthSeconds ? parseInt(videoDetails.lengthSeconds) : null,
      description: videoDetails.shortDescription || null,
      uploader: videoDetails.author || null,
      thumbnail: videoDetails.thumbnail?.thumbnails?.at(-1)?.url || null,
      subtitles: subtitles || null,
      translationLanguages: translationLanguages || null
    };
  }
}
