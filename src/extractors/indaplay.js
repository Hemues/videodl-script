/**
 * IndaPlay Extractor (indaplay.hu / cms.indaplay.hu)
 *
 * IndaPlay is the Indamedia Group video platform (DisplayNOW / DN Network Zrt.).
 * It is a **PeerTube instance** (`cms.indaplay.hu`) behind a Next.js portal
 * (`indaplay.hu`), and it is the host that backs the IndaEvents conference
 * recordings (see indaevents.js).
 *
 * Two independent data sources, used in that order:
 *
 *   1. The PeerTube API — `https://cms.indaplay.hu/api/v1/videos/<uuid>` — which
 *      returns the title, description, duration, thumbnail and, for every
 *      transcoded resolution, both an HLS variant and a progressive fMP4
 *      (`downloadEnabled` is true on this instance). This is the preferred path.
 *   2. The portal page payload — the Next.js RSC flight data embeds one JSON
 *      object per video carrying `uuid` / `slug` / `contentPlaylistUrl`. Used to
 *      turn a portal *slug* into a PeerTube uuid, and as a fallback source of the
 *      HLS master if the API is unreachable.
 *
 * URL forms handled:
 *   - https://indaplay.hu/hu/video/<channel>/<slug>            (watch page)
 *   - https://indaplay.hu/hu/video/<parent>/<child>/<slug>     (nested channel)
 *   - https://indaplay.hu/hu/embed/<channel>/<uuid-or-slug>    (iframe embed)
 *   - https://indaplay.hu/hu/csatornak/<channel>[/<child>]     (channel → playlist)
 *   - https://cms.indaplay.hu/videos/watch/<uuid>              (PeerTube native)
 *   - https://cms.indaplay.hu/videos/embed/<uuid>              (PeerTube embed)
 *   - https://cms.indaplay.hu/w/<shortUUID>                    (PeerTube short link)
 *   - a raw `.../static/streaming-playlists/hls/<uuid>/…master.m3u8`
 *
 * Traps this extractor works around, all observed live:
 *   - The PeerTube API returns URLs as `http://cms.indaplay.hu:443/…` — an
 *     http scheme glued to the https port (reverse-proxy misconfiguration).
 *     Every URL out of the API goes through `_normalizeCmsUrl()`.
 *   - A portal page carries **many** videos (31 on a watch page, 514 on the home
 *     page). The wanted one is *not* first in document order, so the slug must be
 *     matched exactly — never "take the first contentPlaylistUrl".
 *   - `/embed/<channel>/<id>` returns **HTTP 500** for some videos/channels even
 *     though the video itself is fine; embed pages are therefore best-effort and
 *     a failure falls through to the channel listing / search resolvers.
 *   - `https://indaplay.hu/<channel>/<slug>` answers **200** but renders the
 *     Next.js `notfound` segment — a soft 404 carrying no payload. Pages are
 *     accepted only when they actually contain video objects.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
};

const CMS = 'https://cms.indaplay.hu';
const PORTAL = 'https://indaplay.hu';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Portal path segments that are routes, not channel names.
const RESERVED_SEGMENTS = new Set([
  'hu', 'en', 'video', 'videos', 'embed', 'csatornak', 'channels', 'w', 'search', 'kereses',
]);

// How many videos to pull per PeerTube listing request (API caps this at 100).
const PAGE_SIZE = 100;
// Cap the channel walk so a huge channel cannot spin forever while resolving a slug.
const MAX_RESOLVE_PAGES = 6;

export class IndaplayExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'IndaPlay';
  }

  static canHandle(url) {
    return /(^|[/.])(?:cms\.)?indaplay\.hu\//i.test(url);
  }

  /**
   * The PeerTube API hands back `http://cms.indaplay.hu:443/…`. Force https and
   * drop the bogus port so the downloader does not try http-on-443.
   */
  _normalizeCmsUrl(raw) {
    if (!raw) return null;
    let out = String(raw).trim();
    if (out.startsWith('//')) out = 'https:' + out;
    try {
      const u = new URL(out);
      if (/(^|\.)indaplay\.hu$/i.test(u.hostname)) {
        u.protocol = 'https:';
        if (u.port === '443' || u.port === '80') u.port = '';
      }
      return u.toString();
    } catch {
      return out;
    }
  }

  /**
   * Portal slugs are the video name, accent-folded and hyphenated.
   * Verified against live pairs, e.g.
   *   "AI Summit 2025 Aftermovie"  → "ai-summit-2025-aftermovie"
   *   "Köllő Babett: „Megkaptam …" → "kollo-babett-megkaptam-…"
   */
  _slugify(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  _decodeHtmlEntities(text) {
    return String(text || '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  /** Strip HTML tags from a PeerTube description (it is stored as HTML). */
  _stripHtml(text) {
    if (!text) return null;
    const plain = this._decodeHtmlEntities(String(text).replace(/<[^>]*>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    return plain || null;
  }

  /**
   * Classify an IndaPlay URL.
   * @returns {{kind:'video'|'channel', uuid:?string, slug:?string, channel:?string}}
   */
  _parseUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Not a valid IndaPlay URL: ${url}`);
    }

    // A uuid anywhere in the path is unambiguous — PeerTube watch/embed links,
    // and raw HLS paths (…/hls/<videoUuid>/<playlistUuid>-master.m3u8).
    const hlsMatch = parsed.pathname.match(
      /\/streaming-playlists\/hls\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    if (hlsMatch) return { kind: 'video', uuid: hlsMatch[1], slug: null, channel: null };

    const segments = parsed.pathname.split('/').filter(Boolean);

    const uuidSegment = segments.find(s => UUID_RE.test(s) && s.length === 36);
    if (uuidSegment) {
      const channel = this._channelFromSegments(segments, uuidSegment);
      return { kind: 'video', uuid: uuidSegment, slug: null, channel };
    }

    // PeerTube short links: /w/<shortUUID>. The API accepts a shortUUID as an id.
    const wIndex = segments.indexOf('w');
    if (wIndex !== -1 && segments[wIndex + 1]) {
      return { kind: 'video', uuid: segments[wIndex + 1], slug: null, channel: null };
    }

    // Channel listing: /hu/csatornak/<channel>[/<child>]
    const chIndex = segments.findIndex(s => s === 'csatornak' || s === 'channels');
    if (chIndex !== -1) {
      const rest = segments.slice(chIndex + 1).filter(s => !RESERVED_SEGMENTS.has(s));
      if (rest.length > 0) {
        return { kind: 'channel', uuid: null, slug: null, channel: rest[rest.length - 1] };
      }
    }

    // Watch / embed: /hu/video/<channel…>/<slug>  or  /hu/embed/<channel…>/<slug>
    const vIndex = segments.findIndex(s => s === 'video' || s === 'videos' || s === 'embed');
    if (vIndex !== -1 && segments.length > vIndex + 1) {
      const rest = segments.slice(vIndex + 1);
      const slug = rest[rest.length - 1];
      const channel = rest.length > 1 ? rest[rest.length - 2] : null;
      return { kind: 'video', uuid: null, slug, channel };
    }

    // Bare /<slug> — accept it and let slug resolution do the work.
    const tail = segments.filter(s => !RESERVED_SEGMENTS.has(s));
    if (tail.length > 0) {
      return {
        kind: 'video',
        uuid: null,
        slug: tail[tail.length - 1],
        channel: tail.length > 1 ? tail[tail.length - 2] : null,
      };
    }

    throw new Error(`Could not tell what this IndaPlay URL points at: ${url}`);
  }

  /** The channel is the path segment right before the video id, when present. */
  _channelFromSegments(segments, idSegment) {
    const i = segments.indexOf(idSegment);
    for (let j = i - 1; j >= 0; j--) {
      if (!RESERVED_SEGMENTS.has(segments[j])) return segments[j];
    }
    return null;
  }

  /** GET a PeerTube API endpoint. Returns null instead of throwing. */
  async _api(path, searchParams = undefined) {
    try {
      const resp = await got(`${CMS}/api/v1${path}`, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        searchParams,
        responseType: 'json',
        timeout: { request: 25000 },
        retry: { limit: 1 },
      });
      return resp.body;
    } catch (e) {
      console.log(`[${this.name}] API ${path} failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Fetch a portal page and pull out every embedded video object.
   * Returns [{uuid, name, slug, duration, playlistUrl, thumbnail}] in document order.
   */
  async _pageVideos(pageUrl) {
    let html;
    try {
      const resp = await got(pageUrl, {
        headers: { ...HEADERS, Referer: PORTAL + '/' },
        timeout: { request: 30000 },
        followRedirect: true,
        decompress: true,
        // Embed pages 500 for some videos while still being useful elsewhere;
        // never let that abort the whole extraction.
        throwHttpErrors: false,
      });
      if (resp.statusCode >= 400) {
        console.log(`[${this.name}] ${pageUrl} → HTTP ${resp.statusCode}`);
        return [];
      }
      html = resp.body;
    } catch (e) {
      console.log(`[${this.name}] Could not fetch ${pageUrl}: ${e.message}`);
      return [];
    }
    if (!html) return [];

    // The payload lives inside JS string literals in self.__next_f.push(...),
    // so the JSON is escaped one level. Unescape before matching.
    const flat = html.replace(/\\"/g, '"').replace(/\\\//g, '/');

    const videos = [];
    const seen = new Set();
    const slugRe = /"slug":"([^"]+)"/g;
    let m;
    while ((m = slugRe.exec(flat)) !== null) {
      const slug = m[1];

      // Fields are emitted as uuid, name, …, slug — look back for the nearest uuid.
      const before = flat.slice(Math.max(0, m.index - 4000), m.index);
      const uuidMatches = before.match(/"uuid":"([0-9a-f-]{36})"/gi);
      if (!uuidMatches) continue;
      const uuid = uuidMatches[uuidMatches.length - 1].split('"')[3];

      const key = `${uuid}|${slug}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const nameMatch = before.match(/"name":"((?:[^"\\]|\\.)*)"(?=[^"]*$)/);
      const after = flat.slice(m.index, m.index + 6000);
      const playlistMatch = after.match(/"contentPlaylistUrl":"([^"]+)"/);
      const durationMatch = (before + after.slice(0, 400)).match(/"duration":(\d+)/);
      const thumbMatch = after.match(/"thumbnailPath":"([^"]+)"/);

      videos.push({
        uuid,
        slug,
        name: nameMatch ? this._decodeHtmlEntities(nameMatch[1]) : null,
        duration: durationMatch ? parseInt(durationMatch[1], 10) : null,
        playlistUrl: playlistMatch ? this._normalizeCmsUrl(playlistMatch[1]) : null,
        thumbnail: thumbMatch ? thumbMatch[1] : null,
      });
    }
    return videos;
  }

  /**
   * Turn a portal slug into a PeerTube uuid.
   * Strategy order: the portal page itself → the channel listing → site search.
   */
  async _resolveSlug(target, originalUrl) {
    const { slug, channel } = target;

    // 1. The page the user gave us, then the embed variant. The portal renders the
    //    payload on watch pages; embeds render it too when they do not 500.
    const candidates = [originalUrl];
    if (channel) {
      candidates.push(`${PORTAL}/hu/video/${channel}/${slug}`);
      candidates.push(`${PORTAL}/hu/embed/${channel}/${slug}`);
    }

    for (const pageUrl of candidates) {
      const videos = await this._pageVideos(pageUrl);
      const hit = videos.find(v => v.slug === slug);
      if (hit) {
        console.log(`[${this.name}] Resolved slug via page payload → ${hit.uuid}`);
        return hit;
      }
    }

    // 2. Walk the channel listing and match on the slugified video name.
    if (channel) {
      for (let page = 0; page < MAX_RESOLVE_PAGES; page++) {
        const body = await this._api(`/video-channels/${encodeURIComponent(channel)}/videos`, {
          count: PAGE_SIZE,
          start: page * PAGE_SIZE,
          sort: '-publishedAt',
        });
        const data = body && Array.isArray(body.data) ? body.data : null;
        if (!data || data.length === 0) break;

        const hit = data.find(v => this._slugify(v.name) === slug);
        if (hit) {
          console.log(`[${this.name}] Resolved slug via channel listing → ${hit.uuid}`);
          return { uuid: hit.uuid, slug, name: hit.name, duration: hit.duration, playlistUrl: null };
        }
        if ((page + 1) * PAGE_SIZE >= (body.total || 0)) break;
      }
    }

    // 3. Instance search, using the slug words as the query.
    const search = await this._api('/search/videos', {
      search: slug.replace(/-/g, ' '),
      count: 25,
    });
    if (search && Array.isArray(search.data)) {
      const hit = search.data.find(v => this._slugify(v.name) === slug);
      if (hit) {
        console.log(`[${this.name}] Resolved slug via search → ${hit.uuid}`);
        return { uuid: hit.uuid, slug, name: hit.name, duration: hit.duration, playlistUrl: null };
      }
    }

    return null;
  }

  /**
   * Fetch an HLS master playlist and turn its variants into formats.
   * Returns [] when the body is not a usable master playlist.
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
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const resM = line.match(/RESOLUTION=(\d+)x(\d+)/i);
      const bwM = line.match(/BANDWIDTH=(\d+)/i);
      const fpsM = line.match(/FRAME-RATE=([\d.]+)/i);

      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trim().startsWith('#'))) j++;
      if (j >= lines.length) break;

      let variantUrl = lines[j].trim();
      if (!/^https?:\/\//i.test(variantUrl)) variantUrl = new URL(variantUrl, masterUrl).toString();

      variants.push({
        url: this._normalizeCmsUrl(variantUrl),
        width: resM ? parseInt(resM[1], 10) : 0,
        height: resM ? parseInt(resM[2], 10) : 0,
        bitrate: bwM ? parseInt(bwM[1], 10) : null,
        fps: fpsM ? Math.round(parseFloat(fpsM[1])) : null,
      });
      i = j;
    }
    return variants;
  }

  /**
   * Build formats from a PeerTube video object.
   *
   * Every resolution is offered twice: the progressive fMP4 (a single GET, no
   * remuxing — preferred) and the HLS variant playlist (ffmpeg mux) as a
   * same-height alternative for when the progressive endpoint is unavailable.
   */
  _formatsFromApi(video, stdHeaders) {
    const formats = [];
    const playlists = Array.isArray(video.streamingPlaylists) ? video.streamingPlaylists : [];

    for (const playlist of playlists) {
      for (const file of playlist.files || []) {
        const height = file.resolution?.id || file.height || 0;
        if (!height) continue;
        const progressive = this._normalizeCmsUrl(file.fileDownloadUrl || file.fileUrl);
        if (!progressive) continue;
        formats.push({
          url: progressive,
          ext: 'mp4',
          height,
          width: file.width || Math.round(height * (video.aspectRatio || 16 / 9)),
          fps: file.fps || null,
          filesize: file.size || null,
          quality: `${height}p`,
          format_id: `mp4-${height}p`,
          protocol: 'https',
          hasVideo: true,
          hasAudio: true,
          headers: stdHeaders,
        });
      }
    }

    // PeerTube also exposes plain progressive files outside HLS on some videos.
    for (const file of video.files || []) {
      const height = file.resolution?.id || file.height || 0;
      const progressive = this._normalizeCmsUrl(file.fileDownloadUrl || file.fileUrl);
      if (!height || !progressive) continue;
      if (formats.some(f => f.height === height && f.protocol === 'https')) continue;
      formats.push({
        url: progressive,
        ext: 'mp4',
        height,
        width: file.width || Math.round(height * (video.aspectRatio || 16 / 9)),
        fps: file.fps || null,
        filesize: file.size || null,
        quality: `${height}p`,
        format_id: `mp4-${height}p`,
        protocol: 'https',
        hasVideo: true,
        hasAudio: true,
        headers: stdHeaders,
      });
    }

    return formats;
  }

  /** A channel URL becomes a playlist of PeerTube watch links. */
  async _extractChannel(target, url) {
    const channel = target.channel;
    console.log(`[${this.name}] Channel listing: ${channel}`);

    const entries = [];
    let displayName = channel;
    let total = 0;

    for (let page = 0; page < 20; page++) {
      const body = await this._api(`/video-channels/${encodeURIComponent(channel)}/videos`, {
        count: PAGE_SIZE,
        start: page * PAGE_SIZE,
        sort: '-publishedAt',
      });
      const data = body && Array.isArray(body.data) ? body.data : null;
      if (!data || data.length === 0) break;
      total = body.total || 0;

      for (const v of data) {
        if (v.channel?.displayName) displayName = v.channel.displayName;
        entries.push({
          url: `${CMS}/videos/watch/${v.uuid}`,
          title: v.name,
          id: v.uuid,
          duration: v.duration || null,
        });
      }
      if (entries.length >= total) break;
    }

    if (entries.length === 0) {
      throw new Error(`No videos found on IndaPlay channel "${channel}"`);
    }

    console.log(`[${this.name}] Found ${entries.length} video(s) on channel ${displayName}`);

    return {
      _type: 'playlist',
      title: displayName,
      entries,
      url,
      extractor: this.name,
    };
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const target = this._parseUrl(url);
    if (target.kind === 'channel') return this._extractChannel(target, url);

    let uuid = target.uuid;
    let pageHit = null;

    if (!uuid) {
      console.log(`[${this.name}] Resolving slug: ${target.slug}`);
      pageHit = await this._resolveSlug(target, url);
      if (!pageHit) {
        throw new Error(
          `Could not resolve IndaPlay video "${target.slug}" to a video id ` +
          '(not found on the page, in the channel listing, or in search)'
        );
      }
      uuid = pageHit.uuid;
    }

    console.log(`[${this.name}] Video id: ${uuid}`);

    const stdHeaders = {
      'User-Agent': USER_AGENT,
      Referer: PORTAL + '/',
    };

    const video = await this._api(`/videos/${encodeURIComponent(uuid)}`);

    let formats = [];
    // PeerTube always carries the real video title, so a caller-supplied title
    // (e.g. the IndaEvents event name) is only ever a fallback.
    let title = null;
    let info = {};

    if (video) {
      title = video.name || null;
      formats = this._formatsFromApi(video, stdHeaders);

      const masterUrl = this._normalizeCmsUrl(video.streamingPlaylists?.[0]?.playlistUrl);
      if (masterUrl) {
        const variants = await this._parseMaster(masterUrl, stdHeaders);
        for (const v of variants) {
          formats.push({
            url: v.url,
            ext: 'mp4',
            height: v.height,
            width: v.width,
            fps: v.fps,
            bitrate: v.bitrate,
            quality: v.height > 0 ? `${v.height}p` : 'auto',
            format_id: `hls-${v.height > 0 ? v.height + 'p' : 'auto'}`,
            protocol: 'hls',
            hasVideo: true,
            hasAudio: true,
            headers: stdHeaders,
          });
        }
      }

      const thumbPath = video.thumbnailPath || video.previewPath;
      info = {
        videoId: video.uuid || uuid,
        duration: video.duration ?? null,
        description: this._stripHtml(video.description || video.truncatedDescription),
        uploader: video.channel?.displayName || null,
        uploaderId: video.channel?.name || null,
        thumbnail: thumbPath ? this._normalizeCmsUrl(CMS + thumbPath) : null,
        uploadDate: video.publishedAt || null,
        isLive: !!video.isLive,
      };
    }

    // API unavailable (or gave nothing): fall back to the master playlist that the
    // portal page carried for this exact video.
    if (formats.length === 0) {
      const masterUrl =
        pageHit?.playlistUrl ||
        `${CMS}/static/streaming-playlists/hls/${uuid}/master.m3u8`;
      console.log(`[${this.name}] Falling back to page playlist: ${masterUrl}`);

      const variants = await this._parseMaster(masterUrl, stdHeaders);
      for (const v of variants) {
        formats.push({
          url: v.url,
          ext: 'mp4',
          height: v.height,
          width: v.width,
          fps: v.fps,
          bitrate: v.bitrate,
          quality: v.height > 0 ? `${v.height}p` : 'auto',
          format_id: `hls-${v.height > 0 ? v.height + 'p' : 'auto'}`,
          protocol: 'hls',
          hasVideo: true,
          hasAudio: true,
          headers: stdHeaders,
        });
      }
      if (formats.length === 0 && pageHit?.playlistUrl) {
        // Master was not parseable — hand the master itself to ffmpeg.
        formats.push({
          url: pageHit.playlistUrl,
          ext: 'mp4',
          height: 0,
          width: 0,
          quality: 'auto',
          format_id: 'hls-auto',
          protocol: 'hls',
          hasVideo: true,
          hasAudio: true,
          headers: stdHeaders,
        });
      }
      if (!title) title = pageHit?.name || null;
      if (info.duration == null && pageHit?.duration) info.duration = pageHit.duration;
    }

    if (formats.length === 0) {
      throw new Error(`No downloadable formats found for IndaPlay video ${uuid}`);
    }

    // Highest resolution first; at equal height prefer the progressive MP4 over HLS.
    formats.sort((a, b) => {
      if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
      if (a.protocol === b.protocol) return 0;
      return a.protocol === 'https' ? -1 : 1;
    });

    if (!title) title = options.title || `IndaPlay_${uuid}`;

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: uuid,
      title,
      formats,
      url,
      webpage_url: url,
      extractor: this.name,
      ...info,
    };
  }
}

export default IndaplayExtractor;
