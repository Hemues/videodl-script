/**
 * yt-dlp Fallback Extractor
 *
 * When no native extractor can handle a URL, this extractor delegates to
 * the `yt-dlp` binary (if installed) to extract metadata and format info.
 * This instantly adds support for 1000+ sites that yt-dlp covers.
 *
 * In the VideoDL container yt-dlp is always available (installed via pip).
 * In standalone mode it gracefully fails if yt-dlp is not on PATH.
 */

import { BaseExtractor } from './base.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

// Cache the yt-dlp availability check so we only probe once
let _ytdlpAvailable = null;
let _ytdlpBinary = null;

/**
 * Find the yt-dlp binary. Prefers `yt-dlp` on PATH, falls back to common
 * locations inside the VideoDL container.
 */
async function findYtdlp() {
  if (_ytdlpAvailable !== null) return _ytdlpAvailable;

  const candidates = [
    'yt-dlp',                         // On PATH (most common)
    '/opt/venv/bin/yt-dlp',           // VideoDL container venv
    '/usr/local/bin/yt-dlp',          // Global pip install
  ];

  for (const bin of candidates) {
    try {
      await execFileAsync(bin, ['--version'], { timeout: 5000 });
      _ytdlpBinary = bin;
      _ytdlpAvailable = true;
      return true;
    } catch {
      // Try next candidate
    }
  }

  _ytdlpAvailable = false;
  return false;
}

export class YtdlpExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'yt-dlp';
  }

  /**
   * This extractor is a catch-all — it claims to handle ANY URL, but only
   * if yt-dlp is installed.  The registry places it just before
   * DirectExtractor so native extractors always get first priority.
   *
   * The actual availability check happens asynchronously in extract().
   */
  static canHandle(_url) {
    // Accept any http/https URL. The extract() method will fail gracefully
    // if yt-dlp is not installed.
    return /^https?:\/\//i.test(_url);
  }

  async extract(url, options = {}) {
    const available = await findYtdlp();
    if (!available) {
      throw new Error(
        'yt-dlp is not installed. Install it with "pip install yt-dlp" for extended site support.'
      );
    }

    const args = [
      '--dump-json',       // Output metadata as JSON
      '--no-playlist',     // Single video only (playlists handled below)
      '--no-warnings',
      '--no-check-certificates',
    ];

    // Pass cookies through if provided
    if (options.cookies && options._cookieFile) {
      args.push('--cookies', options._cookieFile);
    }

    args.push('--', url);

    let result;
    try {
      result = await execFileAsync(_ytdlpBinary, args, {
        timeout: 120_000,
        maxBuffer: 50 * 1024 * 1024, // 50 MB — some playlist dumps are large
      });
    } catch (err) {
      const msg = (err.stderr || err.message || '').trim();
      throw new Error(`yt-dlp extraction failed: ${msg}`);
    }

    const stdout = result.stdout.trim();
    if (!stdout) {
      throw new Error('yt-dlp returned empty output');
    }

    // yt-dlp may output multiple JSON objects (one per line) for playlists
    const lines = stdout.split('\n').filter(Boolean);

    if (lines.length === 1) {
      return this._parseSingleVideo(JSON.parse(lines[0]), url);
    }

    // Multiple entries → playlist
    const entries = lines.map(line => {
      const data = JSON.parse(line);
      return this._parseSingleVideo(data, data.webpage_url || data.url || url);
    });

    return {
      _type: 'playlist',
      title: entries[0]?.title || 'Playlist',
      url,
      extractor: this.name,
      entries,
    };
  }

  /**
   * Also try playlist extraction (for channels, playlists, etc.)
   */
  async extractPlaylist(url, options = {}) {
    const available = await findYtdlp();
    if (!available) {
      throw new Error('yt-dlp is not installed.');
    }

    const args = [
      '--dump-json',
      '--flat-playlist',   // Only extract metadata, not full info per entry
      '--no-warnings',
      '--no-check-certificates',
    ];

    if (options.cookies && options._cookieFile) {
      args.push('--cookies', options._cookieFile);
    }

    args.push('--', url);

    const result = await execFileAsync(_ytdlpBinary, args, {
      timeout: 120_000,
      maxBuffer: 50 * 1024 * 1024,
    });

    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const entries = lines.map(line => {
      const data = JSON.parse(line);
      return {
        _type: 'video',
        id: data.id || '',
        title: data.title || 'Untitled',
        url: data.url || data.webpage_url || '',
        webpage_url: data.webpage_url || data.url || '',
        duration: data.duration || null,
        extractor: this.name,
      };
    });

    return {
      _type: 'playlist',
      title: 'Playlist',
      url,
      extractor: this.name,
      entries,
    };
  }

  /**
   * Convert a single yt-dlp JSON object into videodl-cli's format structure.
   */
  _parseSingleVideo(data, url) {
    const formats = (data.formats || []).map(fmt => ({
      quality: fmt.format_note || fmt.format || '',
      height: fmt.height || 0,
      width: fmt.width || 0,
      ext: fmt.ext || 'mp4',
      url: fmt.url || '',
      hasVideo: fmt.vcodec !== 'none' && !!fmt.vcodec,
      hasAudio: fmt.acodec !== 'none' && !!fmt.acodec,
      vcodec: fmt.vcodec !== 'none' ? fmt.vcodec : null,
      acodec: fmt.acodec !== 'none' ? fmt.acodec : null,
      filesize: fmt.filesize || fmt.filesize_approx || null,
      bitrate: fmt.tbr ? Math.round(fmt.tbr * 1000) : null,
      protocol: fmt.protocol || 'https',
      format_id: fmt.format_id || '',
      // Pass HTTP headers that yt-dlp requires for this format
      headers: fmt.http_headers || null,
      // Mark manifest-based formats
      _hlsPlaylist: (fmt.protocol === 'm3u8' || fmt.protocol === 'm3u8_native') ? fmt.url : null,
    }));

    // Filter out storyboard/mhtml formats
    const validFormats = formats.filter(f =>
      f.ext !== 'mhtml' && f.url && !f.url.includes('videoplayback') === false
    ).filter(f => f.url);

    return {
      _type: 'video',
      id: data.id || '',
      title: data.title || data.fulltitle || 'Untitled',
      url: data.webpage_url || url,
      webpage_url: data.webpage_url || url,
      extractor: `yt-dlp:${data.extractor || data.extractor_key || 'unknown'}`,
      formats: validFormats.length > 0 ? validFormats : formats.filter(f => f.url),
      subtitles: this._parseSubtitles(data.subtitles),
      thumbnail: data.thumbnail || null,
      duration: data.duration || null,
      description: data.description || null,
      filesize: data.filesize || data.filesize_approx || null,
      filesize_approx: data.filesize_approx || null,
    };
  }

  /**
   * Convert yt-dlp subtitle structure to videodl-cli format.
   */
  _parseSubtitles(subs) {
    if (!subs || typeof subs !== 'object') return {};
    const result = {};
    for (const [lang, tracks] of Object.entries(subs)) {
      if (Array.isArray(tracks) && tracks.length > 0) {
        // Prefer SRT or VTT formats
        const preferred = tracks.find(t => t.ext === 'vtt' || t.ext === 'srt') || tracks[0];
        result[lang] = {
          url: preferred.url,
          ext: preferred.ext || 'vtt',
          name: preferred.name || lang,
        };
      }
    }
    return result;
  }
}

export default YtdlpExtractor;
