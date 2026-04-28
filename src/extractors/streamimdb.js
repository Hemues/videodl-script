/**
 * StreamIMDb Extractor (streamimdb.ru / VidAPI / VaPlayer)
 *
 * Supports:
 *   - streamimdb.ru/embed/movie/{imdb_id}
 *   - streamimdb.ru/embed/tv/{imdb_id}  (with season/episode)
 *   - vidapi.ru / vaplayer.ru embed URLs
 *
 * Flow:
 *   1. Fetch outer embed page → extract inner iframe URL (brightpathsignals.com etc.)
 *   2. Fetch inner iframe → extract CONFIG JSON (streamDataApiUrl, mediaId, etc.)
 *   3. Call streamdata API → get HLS stream URLs, title, backdrop
 *   4. Parse HLS master playlist → collect quality variants
 *   5. Search OpenSubtitles for requested languages (Hungarian + English)
 *   6. Return formats + subtitles
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
};

// OpenSubtitles language codes to search
const SUBTITLE_LANGUAGES = [
  { osCode: 'hun', lang: 'hu', name: 'Hungarian' },
  { osCode: 'eng', lang: 'en', name: 'English' },
];

export class StreamImdbExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'StreamIMDb';
  }

  static canHandle(url) {
    return /(?:streamimdb\.ru|vidapi\.ru|vaplayer\.ru)\/embed\//i.test(url);
  }

  /**
   * Search OpenSubtitles REST API for subtitles by IMDB ID and language.
   * Returns the best subtitle entry (highest download count).
   */
  async _searchOpenSubtitles(imdbId, osLangCode) {
    // OpenSubtitles wants numeric IMDB ID without 'tt' prefix
    const numericId = imdbId.replace(/^tt/, '');
    const apiUrl = `https://rest.opensubtitles.org/search/imdbid-${numericId}/sublanguageid-${osLangCode}`;

    try {
      const resp = await got(apiUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'X-User-Agent': 'trailers.to-UA',
        },
        timeout: { request: 15000 },
        responseType: 'json',
      });

      const results = resp.body;
      if (!Array.isArray(results) || results.length === 0) return null;

      // Sort by download count descending, pick the best SRT
      const sorted = results
        .filter(s => s.SubFormat === 'srt')
        .sort((a, b) => parseInt(b.SubDownloadsCnt || '0') - parseInt(a.SubDownloadsCnt || '0'));

      return sorted[0] || results[0];
    } catch (err) {
      console.log(`[${this.name}] OpenSubtitles search failed for ${osLangCode}: ${err.message}`);
      return null;
    }
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // ── Step 1: Fetch outer embed page ─────────────────────────────────
    console.log(`[${this.name}] Fetching embed page...`);
    const outerResp = await got(url, {
      headers: HEADERS,
      timeout: { request: 20000 },
      followRedirect: true,
    });
    const outerHtml = outerResp.body;

    // Extract inner iframe URL (e.g. brightpathsignals.com/embed/movie/tt...)
    const iframeMatch = outerHtml.match(/<iframe\s[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/i);
    let innerUrl;
    if (iframeMatch) {
      innerUrl = iframeMatch[1];
      console.log(`[${this.name}] Inner iframe: ${innerUrl}`);
    } else {
      // Maybe we're already on the inner page (direct brightpathsignals URL)
      innerUrl = null;
      console.log(`[${this.name}] No inner iframe found, checking current page for CONFIG`);
    }

    // ── Step 2: Fetch inner page and extract CONFIG ────────────────────
    const innerHtml = innerUrl
      ? (await got(innerUrl, {
          headers: { ...HEADERS, Referer: url },
          timeout: { request: 20000 },
          followRedirect: true,
        })).body
      : outerHtml;

    const configMatch = innerHtml.match(/const\s+CONFIG\s*=\s*(\{[^;]+\});/);
    if (!configMatch) throw new Error('Could not find CONFIG in player page');

    let config;
    try {
      config = JSON.parse(configMatch[1]);
    } catch (e) {
      throw new Error(`Failed to parse CONFIG JSON: ${e.message}`);
    }
    console.log(`[${this.name}] Config: mediaId=${config.mediaId}, type=${config.mediaType}, idType=${config.idType}`);

    // ── Step 3: Call stream data API ───────────────────────────────────
    let apiUrl = config.streamDataApiUrl + '?';
    if (config.idType === 'imdb') {
      apiUrl += `imdb=${encodeURIComponent(config.mediaId)}`;
    } else {
      apiUrl += `tmdb=${encodeURIComponent(config.mediaId)}`;
    }
    apiUrl += `&type=${config.mediaType}`;
    if (config.mediaType === 'tv' && config.season && config.episode) {
      apiUrl += `&season=${config.season}&episode=${config.episode}`;
    }

    console.log(`[${this.name}] Fetching stream data from API...`);
    const apiResp = await got(apiUrl, {
      headers: {
        ...HEADERS,
        Referer: innerUrl || url,
      },
      timeout: { request: 20000 },
      responseType: 'json',
    });

    const apiData = apiResp.body;
    if (!apiData || apiData.status_code !== '200' || !apiData.data) {
      throw new Error(`Stream data API error: ${JSON.stringify(apiData)}`);
    }

    const streamData = apiData.data;
    const title = streamData.title || config.title || 'video';
    const poster = streamData.backdrop || null;
    const streamUrls = streamData.stream_urls || [];

    if (streamUrls.length === 0) {
      throw new Error('No stream URLs returned by API');
    }

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Stream URLs: ${streamUrls.length}`);

    // ── Step 4: Parse HLS master playlist(s) for quality variants ──────
    // Pick the first stream URL as primary, others as fallbacks
    const primaryHls = streamUrls[0];
    const hlsBase = primaryHls.match(/^(https?:\/\/[^/]+)/)?.[1] || '';

    console.log(`[${this.name}] Fetching HLS master playlist...`);
    const hlsResp = await got(primaryHls, {
      headers: {
        ...HEADERS,
        Referer: innerUrl || url,
      },
      timeout: { request: 20000 },
    });
    const masterPlaylist = hlsResp.body;

    const formats = [];
    const lines = masterPlaylist.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const nextLine = (lines[i + 1] || '').trim();
      if (!nextLine || nextLine.startsWith('#')) continue;

      // Parse attributes
      const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bwMatch = line.match(/BANDWIDTH=(\d+)/);
      const codecMatch = line.match(/CODECS="([^"]+)"/);
      const fpsMatch = line.match(/FRAME-RATE=([\d.]+)/);

      const width = resMatch ? parseInt(resMatch[1]) : null;
      const height = resMatch ? parseInt(resMatch[2]) : null;
      const bitrate = bwMatch ? parseInt(bwMatch[1]) : null;
      const codecs = codecMatch ? codecMatch[1] : null;
      const fps = fpsMatch ? parseFloat(fpsMatch[1]) : null;

      // Build absolute URL for variant playlist
      let variantUrl;
      if (nextLine.startsWith('http')) {
        variantUrl = nextLine;
      } else if (nextLine.startsWith('/')) {
        variantUrl = hlsBase + nextLine;
      } else {
        variantUrl = primaryHls.replace(/\/[^/]*$/, '/') + nextLine;
      }

      formats.push({
        url: variantUrl,
        ext: 'mp4',
        height,
        width,
        bitrate,
        fps,
        vcodec: codecs?.split(',').find(c => c.includes('avc'))?.trim() || null,
        acodec: codecs?.split(',').find(c => c.includes('mp4a'))?.trim() || null,
        isHLS: true,
        masterPlaylistUrl: primaryHls,
        label: height ? `${height}p` : 'unknown',
      });
    }

    // Add fallback stream URLs as additional formats if they differ in domain
    for (let idx = 1; idx < streamUrls.length; idx++) {
      const fallbackUrl = streamUrls[idx];
      formats.push({
        url: fallbackUrl,
        ext: 'mp4',
        height: null,
        width: null,
        bitrate: null,
        isHLS: true,
        masterPlaylistUrl: fallbackUrl,
        label: `source-${idx + 1}`,
      });
    }

    if (formats.length === 0) {
      // If playlist parsing failed, add raw stream URLs
      for (const sUrl of streamUrls) {
        formats.push({
          url: sUrl,
          ext: 'mp4',
          height: null,
          width: null,
          bitrate: null,
          isHLS: true,
          masterPlaylistUrl: sUrl,
        });
      }
    }

    console.log(`[${this.name}] Formats: ${formats.filter(f => f.height).map(f => `${f.height}p`).join(', ') || 'HLS'}`);

    // ── Step 5: Search for subtitles (Hungarian + English) ─────────────
    const imdbId = config.idType === 'imdb' ? config.mediaId : null;
    const subtitles = {};

    if (imdbId) {
      console.log(`[${this.name}] Searching OpenSubtitles for subtitles (IMDB: ${imdbId})...`);
      for (const { osCode, lang, name } of SUBTITLE_LANGUAGES) {
        const sub = await this._searchOpenSubtitles(imdbId, osCode);
        if (sub) {
          subtitles[lang] = {
            url: sub.SubDownloadLink,
            lang,
            name,
            isAutoGenerated: false,
            isTranslatable: false,
            osFileName: sub.SubFileName || null,
            osFormat: sub.SubFormat || 'srt',
            isGzipped: true,  // OpenSubtitles download links are .gz compressed
          };
          console.log(`[${this.name}] Subtitle: ${name} (${lang}) → ${sub.SubFileName}`);
        } else {
          console.log(`[${this.name}] No ${name} subtitle found`);
        }
      }
    }

    return {
      title,
      formats,
      extractor: this.name,
      url,
      thumbnail: poster,
      subtitles: Object.keys(subtitles).length > 0 ? subtitles : null,
      translationLanguages: null,
    };
  }
}
