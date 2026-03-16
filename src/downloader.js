import got from 'got';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { ensureFFmpeg } from './ffmpeg-helper.js';
import { buildCookieHeader, buildFfmpegCookieString } from './cookies.js';

const NAME_PATTERN = /\/([^/]+?)(?:\.([a-z0-9]{1,5}))?(?:\?|#|$)/i;

/**
 * Return a filepath that doesn't collide with existing files.
 * If "dir/name.ext" exists, returns "dir/name_1.ext", "dir/name_2.ext", etc.
 */
export function uniqueFilepath(filepath) {
  if (!fs.existsSync(filepath)) return filepath;
  const dir = path.dirname(filepath);
  const ext = path.extname(filepath);
  const base = path.basename(filepath, ext);
  let n = 1;
  while (fs.existsSync(path.join(dir, `${base}_${n}${ext}`))) {
    n++;
  }
  return path.join(dir, `${base}_${n}${ext}`);
}

export class VideoDownloader extends EventEmitter {
  constructor(options = {}) {
    super();
    this.downloadFolder = options.downloadFolder || './downloads';
    this.currentDownloads = new Map();
    
    // Ensure download folder exists
    if (!fs.existsSync(this.downloadFolder)) {
      fs.mkdirSync(this.downloadFolder, { recursive: true });
    }
  }

  /**
   * Download a video from URL
   * @param {Object} options Download options
   * @param {string} options.url - URL to download from
   * @param {string} options.filename - Optional filename
   * @param {string} options.directory - Optional output directory
   * @param {Array} options.headers - Optional HTTP headers
   * @param {Object} options.proxy - Optional proxy settings
   * @param {boolean} options.rejectUnauthorized - Verify SSL certificates
   * @returns {Promise<string>} Path to downloaded file
   */
  async download(options) {
    if (!options.url) {
      throw new Error('URL not specified');
    }

    // Check if this is an HLS stream
    const isHLS = options.url.includes('.m3u8') || options.protocol === 'hls';
    
    if (isHLS) {
      return await this.downloadHLS(options);
    }

    // Determine filename
    let filename = options.filename;
    if (!filename) {
      const match = NAME_PATTERN.exec(options.url);
      if (match) {
        filename = match[1] + (match[2] ? '.' + match[2] : '');
      } else {
        filename = 'video_' + Date.now();
      }
    }

    const directory = options.directory || this.downloadFolder;
    const filepath = uniqueFilepath(path.join(directory, filename));

    // Ensure directory exists
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    // Build merged headers: format headers + user headers + cookies
    const mergedHeaders = {};
    if (options.formatHeaders && typeof options.formatHeaders === 'object') {
      Object.assign(mergedHeaders, options.formatHeaders);
    }
    if (options.headers && Array.isArray(options.headers)) {
      options.headers.forEach(header => {
        if (header.value !== undefined) {
          mergedHeaders[header.name] = header.value;
        }
      });
    }

    try {
      this.emit('start', { url: options.url, filepath });

      const downloadedSize = await this._downloadStream(options.url, filepath, {
        headers: mergedHeaders,
        cookies: options.cookies,
        rejectUnauthorized: options.rejectUnauthorized
      }, (downloaded, total) => {
        this.emit('progress', {
          url: options.url,
          filepath,
          downloaded,
          total,
          percent: total > 0 ? (downloaded / total * 100) : 0
        });
      });

      this.emit('complete', {
        url: options.url,
        filepath,
        size: downloadedSize
      });

      return filepath;
    } catch (error) {
      // Clean up partial file on error
      if (fs.existsSync(filepath)) {
        try { fs.unlinkSync(filepath); } catch {}
      }
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  /**
   * Download multiple videos
   * @param {Array<Object>} downloads - Array of download options
   * @returns {Promise<Array<string>>} Array of downloaded file paths
   */
  async downloadMultiple(downloads) {
    const results = [];
    
    for (const downloadOptions of downloads) {
      try {
        const filepath = await this.download(downloadOptions);
        results.push({ success: true, filepath });
      } catch (error) {
        results.push({ success: false, error: error.message, url: downloadOptions.url });
      }
    }

    return results;
  }

  // ========== Merge Integrity Validation ==========

  /**
   * Probe the duration of a media file using ffmpeg.
   * Returns duration in seconds, or null if the file cannot be probed.
   */
  _probeDuration(ffmpegPath, filePath) {
    return new Promise((resolve) => {
      // Use -stats to force progress output even when stderr is piped.
      // This gives us the ACTUAL playable duration (last time= printed)
      // rather than container metadata which may be wrong for truncated files.
      const args = [
        '-v', 'error',
        '-stats',
        '-i', filePath,
        '-f', 'null',
        '-c', 'copy',
        'NUL'
      ];
      const proc = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.stdout.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', () => resolve(null));
      proc.on('close', () => {
        // ffmpeg prints "time=HH:MM:SS.ss" progress lines as it processes.
        // The LAST match is the actual playable duration.
        const allMatches = [...stderr.matchAll(/time=(\d{2}):(\d{2}):([\d.]+)/g)];
        if (allMatches.length > 0) {
          const last = allMatches[allMatches.length - 1];
          const h = parseInt(last[1]);
          const m = parseInt(last[2]);
          const s = parseFloat(last[3]);
          resolve(h * 3600 + m * 60 + s);
          return;
        }
        resolve(null);
      });
    });
  }

  /**
   * Validate a merge by comparing input and output durations.
   * Returns { ok, videoDuration, audioDuration, outputDuration, ratio }.
   * A merge is considered bad if the output covers less than 90% of the
   * longest input stream.
   */
  async _validateMerge(ffmpegPath, videoPath, audioPath, outputPath) {
    const [vDur, aDur, oDur] = await Promise.all([
      this._probeDuration(ffmpegPath, videoPath),
      this._probeDuration(ffmpegPath, audioPath),
      this._probeDuration(ffmpegPath, outputPath),
    ]);

    const inputMax = Math.max(vDur || 0, aDur || 0);
    // If we can't probe the output at all, treat it as a failure
    if (oDur === null && inputMax > 0) {
      return {
        ok: false,
        videoDuration: vDur,
        audioDuration: aDur,
        outputDuration: null,
        ratio: 0,
      };
    }
    const ratio = (inputMax > 0 && oDur !== null) ? oDur / inputMax : 1;

    return {
      ok: ratio >= 0.90,
      videoDuration: vDur,
      audioDuration: aDur,
      outputDuration: oDur,
      ratio,
    };
  }

  /**
   * Download separate video+audio DASH streams and merge with ffmpeg.
   * Downloads both streams in parallel for maximum speed, then merges.
   * Optionally downloads subtitles and embeds them in the output.
   */
  async downloadAndMerge(options) {
    const directory = options.directory || this.downloadFolder;
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }

    const finalPath = uniqueFilepath(path.join(directory, options.filename));
    const videoTmpPath = finalPath + '.f_video.tmp';
    const audioTmpPath = finalPath + '.f_audio.tmp';
    const subTmpPaths = [];  // subtitle temp file paths

    // Ensure ffmpeg is ready before starting downloads
    let ffmpegPath;
    try {
      ffmpegPath = await ensureFFmpeg((progress) => {
        if (progress.status === 'downloading') {
          this.emit('ffmpeg-download', progress);
        }
      });
    } catch (error) {
      throw new Error(`Failed to setup ffmpeg: ${error.message}`);
    }

    this.emit('start', { filepath: finalPath });

    try {
      // Phase 1: Download video + audio in parallel
      this.emit('merge-phase', { phase: 'download', label: `Downloading video (${options.videoInfo}) + audio (${options.audioInfo}) in parallel...` });

      let videoDownloaded = 0, audioDownloaded = 0;
      let videoTotal = options.videoStream.filesize || 0;
      let audioTotal = options.audioStream.filesize || 0;

      const emitCombinedProgress = () => {
        const total = videoTotal + audioTotal;
        const downloaded = videoDownloaded + audioDownloaded;
        if (total > 0) {
          this.emit('progress', {
            downloaded,
            total,
            percent: (downloaded / total * 100)
          });
        }
      };

      const videoOpts = {
        headers: options.videoStream.headers || {},
        cookies: options.cookies,
        rejectUnauthorized: options.rejectUnauthorized
      };
      const audioOpts = {
        headers: options.audioStream.headers || {},
        cookies: options.cookies,
        rejectUnauthorized: options.rejectUnauthorized
      };

      const [vSize, aSize] = await Promise.all([
        this._downloadStream(options.videoStream.url, videoTmpPath, videoOpts, (dl, total) => {
          videoDownloaded = dl;
          if (total > 0) videoTotal = total;
          emitCombinedProgress();
        }),
        this._downloadStream(options.audioStream.url, audioTmpPath, audioOpts, (dl, total) => {
          audioDownloaded = dl;
          if (total > 0) audioTotal = total;
          emitCombinedProgress();
        })
      ]);

      console.log(`  Video: ${(vSize / 1024 / 1024).toFixed(2)} MB  Audio: ${(aSize / 1024 / 1024).toFixed(2)} MB`);

      // Validate that both streams actually have data before proceeding
      if (vSize === 0 || aSize === 0) {
        const failed = [];
        if (vSize === 0) failed.push('video');
        if (aSize === 0) failed.push('audio');
        throw new Error(
          `Download failed: ${failed.join(' and ')} stream(s) returned 0 bytes. ` +
          'The format URLs may have expired or the YouTube client returned unusable streams. ' +
          'Try again or use a different format (e.g., --format best).'
        );
      }

      // Phase 1b: Download subtitles if requested
      if (options.subtitles && options.subtitles.length > 0) {
        this.emit('merge-phase', { phase: 'subtitles', label: `Downloading ${options.subtitles.length} subtitle track(s)...` });
        for (const sub of options.subtitles) {
          const subPath = finalPath + `.f_sub_${sub.lang}.vtt`;
          try {
            await this._downloadSubtitle(sub.url, subPath);
            const stats = fs.statSync(subPath);
            subTmpPaths.push({ path: subPath, lang: sub.lang, name: sub.name });
            console.log(`  Subtitle [${sub.lang}]: ${(stats.size / 1024).toFixed(1)} KB`);
          } catch (e) {
            console.log(`  ⚠ Subtitle [${sub.lang}] failed: ${e.message}`);
            try { if (fs.existsSync(subPath)) fs.unlinkSync(subPath); } catch {}
          }
        }
      }

      // Phase 2: Pre-merge validation — ensure temp files are complete
      this.emit('merge-phase', { phase: 'validate', label: 'Validating downloaded streams...' });
      const preMerge = await Promise.all([
        this._probeDuration(ffmpegPath, videoTmpPath),
        this._probeDuration(ffmpegPath, audioTmpPath),
      ]);
      const [preVideoDur, preAudioDur] = preMerge;
      if (preVideoDur !== null && preAudioDur !== null) {
        const fmtDur = (s) => {
          const m = Math.floor(s / 60);
          const sec = (s % 60).toFixed(1);
          return `${m}:${sec.padStart(4, '0')}`;
        };
        console.log(`  Pre-merge durations — Video: ${fmtDur(preVideoDur)}  Audio: ${fmtDur(preAudioDur)}`);
        if (preVideoDur > 0 && preAudioDur > 0) {
          const preRatio = Math.min(preVideoDur, preAudioDur) / Math.max(preVideoDur, preAudioDur);
          if (preRatio < 0.50) {
            console.log(`  ⚠ Warning: large duration mismatch between video and audio streams (${(preRatio * 100).toFixed(0)}%)`);
          }
        }
      }

      // Phase 3: Merge with ffmpeg
      const mergeLabel = subTmpPaths.length > 0
        ? `Merging video + audio + ${subTmpPaths.length} subtitle(s) with ffmpeg...`
        : 'Merging video + audio with ffmpeg...';
      this.emit('merge-phase', { phase: 'merge', label: mergeLabel });
      await this._ffmpegMerge(ffmpegPath, videoTmpPath, audioTmpPath, finalPath, subTmpPaths);

      // Phase 4: Post-merge validation — detect truncated output
      const validation = await this._validateMerge(ffmpegPath, videoTmpPath, audioTmpPath, finalPath);
      if (!validation.ok) {
        const pct = (validation.ratio * 100).toFixed(1);
        const expected = validation.videoDuration?.toFixed(1) || '?';
        const got = validation.outputDuration?.toFixed(1) || '?';
        console.log(`  ⚠ Merge integrity check FAILED — output has ${got}s of ${expected}s (${pct}%)`);
        console.log(`  Attempting recovery: re-reading temp files and retrying merge...`);

        // Recovery strategy: the most common cause is a partially-flushed
        // temp file.  Re-open, read, and re-write each temp file to force
        // a complete flush, then retry the merge.
        for (const tmpPath of [videoTmpPath, audioTmpPath]) {
          try {
            const buf = fs.readFileSync(tmpPath);
            fs.writeFileSync(tmpPath, buf);
          } catch {}
        }

        await this._ffmpegMerge(ffmpegPath, videoTmpPath, audioTmpPath, finalPath, subTmpPaths);

        // Validate again
        const retry = await this._validateMerge(ffmpegPath, videoTmpPath, audioTmpPath, finalPath);
        if (!retry.ok) {
          const retryPct = (retry.ratio * 100).toFixed(1);
          const retryGot = retry.outputDuration?.toFixed(1) || '?';
          console.log(`  ✗ Recovery merge still truncated — output has ${retryGot}s of ${expected}s (${retryPct}%)`);
          console.log(`  The output file may be incomplete. Try downloading again.`);
        } else {
          console.log(`  ✓ Recovery merge successful — output is now ${retry.outputDuration?.toFixed(1)}s`);
        }
      }

      const stats = fs.statSync(finalPath);
      this.emit('complete', { filepath: finalPath, size: stats.size });
      return finalPath;
    } finally {
      // Cleanup temp files
      try { if (fs.existsSync(videoTmpPath)) fs.unlinkSync(videoTmpPath); } catch {}
      try { if (fs.existsSync(audioTmpPath)) fs.unlinkSync(audioTmpPath); } catch {}
      for (const sub of subTmpPaths) {
        try { if (fs.existsSync(sub.path)) fs.unlinkSync(sub.path); } catch {}
      }
    }
  }

  // ========== Internal Download Helpers ==========

  /**
   * Dispatch: probes Range support on any URL and auto-selects chunked vs direct.
   * Chunked mode is used when the server supports Range and file is > 2 MB.
   * Adaptive download: starts direct, detects throttling, auto-switches to chunked.
   *
   * How throttle detection works:
   *   1. Start a normal direct download
   *   2. During the first PROBE_BYTES (1 MB burst), track the peak throughput
   *   3. After the probe phase, sample speed every second
   *   4. If current speed drops below 15% of peak speed → throttle detected
   *   5. Abort the direct connection and resume from the same offset using
   *      Range-based chunked requests (10 MB chunks)
   *
   * This catches YouTube's CDN pattern (fast burst → crawl) without
   * any hardcoded domain checks — works for any throttling CDN.
   * Non-throttled servers (XHamster, PornHub etc.) maintain steady speed
   * so they continue with the efficient direct connection.
   */
  async _downloadStream(url, filepath, options = {}, onProgress = null) {
    const PROBE_BYTES      = 1_048_576;  // Measure peak speed during first 1 MB
    const THROTTLE_RATIO   = 0.15;       // Current speed < 15% of peak → throttled
    const MIN_PEAK_SPEED   = 2_097_152;  // Only trigger if peak was > 2 MB/s
    const CHUNK_SIZE       = 10_485_760; // 10 MB chunks for chunked mode
    const MIN_FILE_SIZE    = 4_194_304;  // Don't bother for files < 4 MB

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Encoding': 'identity',
      ...(options.headers || {})
    };

    if (options.cookies && Array.isArray(options.cookies)) {
      const cookieHeader = buildCookieHeader(options.cookies, url);
      if (cookieHeader) headers['Cookie'] = cookieHeader;
    }

    const reqBase = {
      https: { rejectUnauthorized: options.rejectUnauthorized !== false },
      timeout: { lookup: 10000, connect: 10000, secureConnect: 10000, response: 30000 }
    };

    // Always use Range header for the initial request.  Some CDNs (e.g.
    // YouTube IOS client URLs) reject plain GET with 403 while accepting
    // Range-based requests.  `Range: bytes=0-` requests the full file but
    // signals Range capability, which is safe for virtually all HTTP servers
    // (they return 206 with the complete body, or 200 if Range is ignored).
    const initialHeaders = { ...headers };
    if (!initialHeaders['Range']) {
      initialHeaders['Range'] = 'bytes=0-';
    }

    // ── Phase 1: Start direct download with speed monitoring ──
    let totalSize = 0;
    let downloaded = 0;
    let throttleDetected = false;
    let rangeSupported = false;
    let serverRejected = false;   // CDN returned 403 — needs bounded-Range retry

    // Speed tracking
    let peakSpeed = 0;
    let lastCheckTime = 0;
    let lastCheckBytes = 0;
    let probePhase = true;       // true while downloading first PROBE_BYTES
    let downloadStartTime = 0;

    const fileStream = fs.createWriteStream(filepath);

    try {
      await new Promise((resolve, reject) => {
        let resolved = false;
        let httpError = null; // Track HTTP-level errors

        const done = (err) => {
          if (resolved) return;
          resolved = true;
          const finalErr = err || httpError;
          // Wait for fileStream to fully flush to disk before resolving.
          // Without this, the merge step can start reading an incomplete file
          // (on fast CDNs the source delivers data faster than disk writes,
          //  so Node.js buffers significant amounts internally).
          fileStream.end(() => {
            if (finalErr && !throttleDetected) reject(finalErr);
            else resolve();
          });
        };

        const stream = got.stream(url, { ...reqBase, headers: initialHeaders });

        stream.on('response', (resp) => {
          totalSize = parseInt(resp.headers['content-length'] || '0');
          const acceptRanges = resp.headers['accept-ranges'];
          if (acceptRanges && acceptRanges !== 'none') rangeSupported = true;

          // 206 Partial Content confirms Range support.  Also extract the
          // definitive total size from Content-Range (more reliable than
          // Content-Length which is the *range* size in 206 responses).
          if (resp.statusCode === 206) {
            rangeSupported = true;
            const cr = resp.headers['content-range']; // e.g. "bytes 0-123456/123457"
            if (cr) {
              const m = cr.match(/\/(\d+)/);
              if (m) totalSize = parseInt(m[1]);
            }
          }

          downloadStartTime = Date.now();
          lastCheckTime = downloadStartTime;

          // Detect non-2xx responses early — the stream will still emit data/end
          // events for the error body, but we flag it so we can reject later.
          if (resp.statusCode >= 400) {
            httpError = new Error(`HTTP ${resp.statusCode} ${resp.statusMessage || ''} — server rejected the download request`.trim());
          }
        });

        stream.on('data', (chunk) => {
          downloaded += chunk.length;
          fileStream.write(chunk);
          if (onProgress) onProgress(downloaded, totalSize);

          const now = Date.now();
          if (!downloadStartTime) downloadStartTime = now; // Safeguard: track from first data

          // During probe phase: track peak speed
          if (probePhase) {
            if (downloaded >= PROBE_BYTES) {
              const elapsed = now - downloadStartTime;
              if (elapsed > 0) {
                peakSpeed = (downloaded / elapsed) * 1000;
              }
              probePhase = false;
              lastCheckTime = now;
              lastCheckBytes = downloaded;
            } else if (totalSize >= MIN_FILE_SIZE && (now - downloadStartTime) > 5000) {
              // Probe taking >5 seconds for 1 MB = already throttled from the start
              // Check if we have Range support to switch to chunked
              const probeSpeed = downloaded / ((now - downloadStartTime) / 1000);
              if (probeSpeed < 500_000) { // < 500 KB/s during probe = almost certainly throttled
                peakSpeed = 999_999_999; // Fake high peak so ratio check works on resume
                throttleDetected = true;
                stream.destroy();
                done();
                return;
              }
            }
            return;
          }

          // Post-probe: check speed every ~1 second
          const sinceLast = now - lastCheckTime;
          if (sinceLast >= 1000 && totalSize >= MIN_FILE_SIZE) {
            const recentBytes = downloaded - lastCheckBytes;
            const currentSpeed = (recentBytes / sinceLast) * 1000;

            // Update peak if somehow speed recovered
            if (currentSpeed > peakSpeed) peakSpeed = currentSpeed;

            // Detection 1: Current speed dropped well below peak (burst→crawl pattern)
            if (peakSpeed > MIN_PEAK_SPEED && currentSpeed < peakSpeed * THROTTLE_RATIO) {
              throttleDetected = true;
              stream.destroy();
              done();
              return;
            }

            // Detection 2: Absolute minimum speed (throttled from the start, no burst)
            // If we've been downloading for 5+ seconds and overall average is < 2 MB/s
            const overallElapsed = now - downloadStartTime;
            if (overallElapsed > 5000) {
              const overallSpeed = (downloaded / overallElapsed) * 1000;
              if (overallSpeed < MIN_PEAK_SPEED) {
                throttleDetected = true;
                stream.destroy();
                done();
                return;
              }
            }

            lastCheckTime = now;
            lastCheckBytes = downloaded;
          }
        });

        stream.on('end', () => done());
        stream.on('error', (err) => done(err));
        // 'close' as safety-net only — 'end' or 'error' should fire first.
        // Using a short delay avoids a race where 'close' resolves before
        // 'error' has a chance to fire.
        stream.on('close', () => setTimeout(() => done(), 50));
      });
    } catch (err) {
      // Some CDNs (e.g. YouTube IOS client URLs) require explicit bounded
      // Range headers and reject open-ended Range or plain GET with 403.
      // Catch this so we can retry with bounded-Range chunks below.
      const is403 = /\b403\b/.test(err.message || '')
                  || (err.response && err.response.statusCode === 403);
      if (is403) {
        serverRejected = true;
        try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {}
      } else {
        throw err;
      }
    }

    // ── CDN rejected the request (403) — retry with bounded-Range chunks ──
    // YouTube IOS client URLs only accept bounded Range requests like the
    // real iOS app sends (e.g. bytes=0-10485759), not open-ended or no Range.
    if (serverRejected) {
      let probeTotal = 0;
      try {
        const probe = await got(url, {
          ...reqBase,
          headers: { ...headers, 'Range': 'bytes=0-0' },
          responseType: 'buffer',
          throwHttpErrors: false
        });
        if (probe.statusCode === 206) {
          const cr = probe.headers['content-range'];
          if (cr) { const m = cr.match(/\/(\d+)/); if (m) probeTotal = parseInt(m[1]); }
        }
      } catch {}

      if (!probeTotal) {
        throw new Error('HTTP 403 — server rejected the download and bounded-Range probe also failed');
      }

      const numChunks = Math.ceil(probeTotal / CHUNK_SIZE);
      console.log(`[download] Server rejected initial request (403) → downloading ${(probeTotal / 1048576).toFixed(1)} MB in ${numChunks} bounded-Range chunk(s)`);

      let chunked = 0;
      while (chunked < probeTotal) {
        const end = Math.min(chunked + CHUNK_SIZE - 1, probeTotal - 1);
        const chunkHeaders = { ...headers, 'Range': `bytes=${chunked}-${end}` };

        const chunkStream = got.stream(url, { ...reqBase, headers: chunkHeaders });
        const appendStream = fs.createWriteStream(filepath, { flags: chunked === 0 ? 'w' : 'a' });

        const base = chunked;
        chunkStream.on('downloadProgress', progress => {
          if (onProgress) onProgress(base + progress.transferred, probeTotal);
        });

        await pipeline(chunkStream, appendStream);
        chunked = base + (end - base + 1);
      }

      const finalSize = fs.statSync(filepath).size;
      if (finalSize === 0) {
        throw new Error('Chunked download produced 0 bytes');
      }
      return finalSize;
    }

    // ── If no throttling → done (direct download completed) ──
    if (!throttleDetected) {
      const finalSize = downloaded || (fs.existsSync(filepath) ? fs.statSync(filepath).size : 0);
      if (finalSize === 0) {
        throw new Error('Download returned 0 bytes — the server sent an empty response (URL may have expired or the format is unavailable)');
      }
      return finalSize;
    }

    // ── Phase 2: Throttling detected — probe Range support and resume with chunks ──
    // Verify Range with a 1-byte probe if we haven't confirmed yet
    if (!rangeSupported) {
      try {
        const probe = await got(url, {
          ...reqBase,
          headers: { ...headers, 'Range': 'bytes=0-0' },
          responseType: 'buffer',
          throwHttpErrors: false
        });
        if (probe.statusCode === 206) {
          rangeSupported = true;
          if (!totalSize) {
            const cr = probe.headers['content-range'];
            if (cr) { const m = cr.match(/\/(\d+)/); if (m) totalSize = parseInt(m[1]); }
          }
        }
      } catch {}
    }

    if (!rangeSupported) {
      // Server doesn't support Range — continue with what we have via direct
      // Re-download fully since we can't resume
      console.log('[download] Throttling detected but server has no Range support — continuing direct');
      fs.unlinkSync(filepath);
      return this._downloadDirect(url, filepath, options, onProgress);
    }

    // If we don't have totalSize yet, get it from a Range probe
    if (!totalSize) {
      try {
        const probe = await got(url, {
          ...reqBase,
          headers: { ...headers, 'Range': 'bytes=0-0' },
          responseType: 'buffer',
          throwHttpErrors: false
        });
        const cr = probe.headers['content-range'];
        if (cr) { const m = cr.match(/\/(\d+)/); if (m) totalSize = parseInt(m[1]); }
      } catch {}
    }

    if (!totalSize) {
      console.log('[download] Throttling detected but cannot determine file size — restarting direct');
      fs.unlinkSync(filepath);
      return this._downloadDirect(url, filepath, options, onProgress);
    }

    const remaining = totalSize - downloaded;
    const numChunks = Math.ceil(remaining / CHUNK_SIZE);
    const avgSpeed = downloadStartTime ? (downloaded / ((Date.now() - downloadStartTime) / 1000)) : 0;
    // Cap displayed peak speed to a reasonable value (fake 999MB/s is just a flag)
    const displayPeakSpeed = peakSpeed > 100_000_000 ? avgSpeed * 2 : peakSpeed;
    console.log(`[download] Throttling detected at ${(downloaded / 1048576).toFixed(1)} MB (avg: ${(avgSpeed / 1048576).toFixed(1)} MB/s, peak: ${(displayPeakSpeed / 1048576).toFixed(1)} MB/s) → switching to chunked`);

    // ── Phase 3: Smart validation — download first chunk and compare speed ──
    // If chunking doesn't improve speed, revert to direct (saves overhead)
    const CHUNK_SPEEDUP_THRESHOLD = 1.5; // Chunk must be ≥1.5x faster to continue chunking

    // Download first chunk and measure speed
    const firstChunkEnd = Math.min(downloaded + CHUNK_SIZE - 1, totalSize - 1);
    const firstChunkSize = firstChunkEnd - downloaded + 1;
    const firstChunkHeaders = { ...headers, 'Range': `bytes=${downloaded}-${firstChunkEnd}` };

    const firstChunkStart = Date.now();
    const firstChunkStream = got.stream(url, { ...reqBase, headers: firstChunkHeaders });
    const firstAppendStream = fs.createWriteStream(filepath, { flags: 'a' });

    const firstBase = downloaded;
    firstChunkStream.on('downloadProgress', progress => {
      if (onProgress) onProgress(firstBase + progress.transferred, totalSize);
    });

    await pipeline(firstChunkStream, firstAppendStream);
    downloaded = firstBase + firstChunkSize;

    const firstChunkElapsed = (Date.now() - firstChunkStart) / 1000;
    const firstChunkSpeed = firstChunkSize / firstChunkElapsed;

    // Compare to pre-throttle average speed
    const speedRatio = firstChunkSpeed / avgSpeed;

    if (speedRatio < CHUNK_SPEEDUP_THRESHOLD) {
      // Chunking didn't help significantly — abort chunking, continue direct
      console.log(`[download] Chunking not beneficial (${(firstChunkSpeed / 1048576).toFixed(2)} MB/s vs ${(avgSpeed / 1048576).toFixed(2)} MB/s avg, ratio ${speedRatio.toFixed(2)}x) → continuing direct`);
      
      // Continue downloading the rest directly (append mode)
      const remainingAfterChunk = totalSize - downloaded;
      if (remainingAfterChunk > 0) {
        // Download remaining bytes directly, appending to existing file
        const continueStream = got.stream(url, {
          ...reqBase,
          headers: { ...headers, 'Range': `bytes=${downloaded}-${totalSize - 1}` }
        });
        const continueAppend = fs.createWriteStream(filepath, { flags: 'a' });
        const continueBase = downloaded;
        continueStream.on('downloadProgress', progress => {
          if (onProgress) onProgress(continueBase + progress.transferred, totalSize);
        });
        await pipeline(continueStream, continueAppend);
      }
      return fs.statSync(filepath).size;
    }

    // Chunking is beneficial — continue with remaining chunks
    const remainingAfterFirst = totalSize - downloaded;
    const remainingChunks = Math.ceil(remainingAfterFirst / CHUNK_SIZE);
    console.log(`[download] Chunking confirmed beneficial (${(firstChunkSpeed / 1048576).toFixed(2)} MB/s, ${speedRatio.toFixed(1)}x speedup) — ${remainingChunks} chunk(s) left`);

    // ── Resume from where direct download left off using Range chunks ──
    while (downloaded < totalSize) {
      const end = Math.min(downloaded + CHUNK_SIZE - 1, totalSize - 1);
      const chunkHeaders = { ...headers, 'Range': `bytes=${downloaded}-${end}` };

      const chunkStream = got.stream(url, { ...reqBase, headers: chunkHeaders });
      const appendStream = fs.createWriteStream(filepath, { flags: 'a' });

      const base = downloaded;
      chunkStream.on('downloadProgress', progress => {
        if (onProgress) onProgress(base + progress.transferred, totalSize);
      });

      await pipeline(chunkStream, appendStream);
      downloaded = base + (end - base + 1);
    }

    return fs.statSync(filepath).size;
  }

  /**
   * Standard single-connection streaming download (no throttle detection).
   * Used as fallback when Range is not supported.
   */
  async _downloadDirect(url, filepath, options = {}, onProgress = null) {
    const dlOpts = {
      https: { rejectUnauthorized: options.rejectUnauthorized !== false },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(options.headers || {})
      },
      timeout: { lookup: 10000, connect: 10000, secureConnect: 10000, response: 30000 }
    };

    if (options.cookies && Array.isArray(options.cookies)) {
      const cookieHeader = buildCookieHeader(options.cookies, url);
      if (cookieHeader) dlOpts.headers['Cookie'] = cookieHeader;
    }

    const downloadStream = got.stream(url, dlOpts);
    const fileWriterStream = fs.createWriteStream(filepath);
    let totalBytes = 0, downloadedBytes = 0;

    downloadStream.on('downloadProgress', progress => {
      totalBytes = progress.total || totalBytes;
      downloadedBytes = progress.transferred;
      if (onProgress) onProgress(downloadedBytes, totalBytes);
    });

    await pipeline(downloadStream, fileWriterStream);
    return downloadedBytes || (fs.existsSync(filepath) ? fs.statSync(filepath).size : 0);
  }

  /**
   * Backward-compatible wrapper that emits 'progress' events.
   * Used by callers that expect the old event-based interface.
   */
  async _downloadToFile(url, filepath, options = {}) {
    return this._downloadStream(url, filepath, options, (downloaded, total) => {
      this.emit('progress', {
        downloaded,
        total,
        percent: total > 0 ? (downloaded / total * 100) : 0
      });
    });
  }

  /**
   * Download a subtitle file (VTT) from URL to a local path.
   * Includes retry logic for 429 rate limits.
   */
  async _downloadSubtitle(url, outputPath) {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    // Set Referer based on subtitle URL origin
    try {
      const urlObj = new URL(url);
      headers['Referer'] = urlObj.origin + '/';
    } catch {
      headers['Referer'] = 'https://www.youtube.com/';
    }
    const maxRetries = 3;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await got(url, { headers, timeout: { request: 30000 } });
        if (response.body.length === 0) {
          throw new Error('Subtitle download returned empty response');
        }
        fs.writeFileSync(outputPath, response.body, 'utf-8');
        return response.body.length;
      } catch (e) {
        const is429 = e.response?.statusCode === 429;
        if (is429 && attempt < maxRetries) {
          const delay = (attempt + 1) * 2000; // 2s, 4s, 6s
          console.log(`  [Subtitle] Rate limited (429), retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * Merge video and audio files using ffmpeg -c copy (no re-encoding).
   * Optionally embeds subtitle tracks.
   * @param {string} ffmpegPath - path to ffmpeg binary
   * @param {string} videoPath - video temp file
   * @param {string} audioPath - audio temp file
   * @param {string} outputPath - final output file
   * @param {Array} [subtitlePaths] - array of {path, lang, name} objects
   */
  _ffmpegMerge(ffmpegPath, videoPath, audioPath, outputPath, subtitlePaths = []) {
    return new Promise((resolve, reject) => {
      const args = [
        '-loglevel', 'warning',
        '-i', videoPath,
        '-i', audioPath
      ];

      // Add subtitle inputs
      for (const sub of subtitlePaths) {
        args.push('-i', sub.path);
      }

      // Copy video and audio streams
      args.push('-c:v', 'copy', '-c:a', 'copy');

      // Determine subtitle codec based on output container
      const ext = path.extname(outputPath).toLowerCase();
      if (subtitlePaths.length > 0) {
        if (ext === '.mkv' || ext === '.webm') {
          args.push('-c:s', 'webvtt');
        } else {
          // MP4: use mov_text
          args.push('-c:s', 'mov_text');
        }
      }

      // Map all streams: video from input 0, audio from input 1, subs from inputs 2+
      args.push('-map', '0:v', '-map', '1:a');
      for (let i = 0; i < subtitlePaths.length; i++) {
        args.push('-map', `${i + 2}:0`);
      }

      // Set subtitle metadata (language + title)
      for (let i = 0; i < subtitlePaths.length; i++) {
        const sub = subtitlePaths[i];
        args.push(`-metadata:s:s:${i}`, `language=${sub.lang}`);
        if (sub.name) {
          args.push(`-metadata:s:s:${i}`, `title=${sub.name}`);
        }
      }

      args.push('-y', outputPath);

      console.log(`[Merge] ffmpeg ${args.join(' ')}`);

      const ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderrOutput = '';

      ffmpeg.stderr.on('data', (data) => {
        stderrOutput += data.toString();
      });

      ffmpeg.on('error', (error) => {
        reject(new Error(`ffmpeg error: ${error.message}`));
      });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const errorLines = stderrOutput.split('\n').slice(-10).join('\n');
          console.error(`[ffmpeg] ${errorLines}`);
          reject(new Error(`ffmpeg merge failed with code ${code}`));
        }
      });
    });
  }

  /**
   * Search for downloaded files matching a pattern
   * @param {Object} query - Search criteria
   * @param {string} query.filename - Filename pattern to search for
   * @returns {Array<Object>} Array of matching files
   */
  search(query) {
    const results = [];
    
    if (!query || !query.filename) {
      return results;
    }

    try {
      const files = fs.readdirSync(this.downloadFolder);
      const pattern = new RegExp(query.filename, 'i');

      for (const file of files) {
        if (pattern.test(file)) {
          const filepath = path.join(this.downloadFolder, file);
          const stats = fs.statSync(filepath);

          results.push({
            filename: file,
            path: filepath,
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime
          });
        }
      }
    } catch (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    return results;
  }

  /**
   * Download HLS stream using ffmpeg
   * @param {Object} options Download options
   * @returns {Promise<string>} Path to downloaded file
   */
  async downloadHLS(options) {
    const filename = options.filename || `video_${Date.now()}.mp4`;
    const directory = options.directory || this.downloadFolder;
    
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    
    const filepath = uniqueFilepath(path.join(directory, filename.replace(/\.m3u8$/, '.mp4')));

    this.emit('start', { filepath });

    // Ensure ffmpeg is available
    let ffmpegPath;
    try {
      ffmpegPath = await ensureFFmpeg((progress) => {
        if (progress.status === 'downloading') {
          this.emit('ffmpeg-download', progress);
        }
      });
    } catch (error) {
      throw new Error(`Failed to setup ffmpeg: ${error.message}`);
    }

    // If a filtered single-variant playlist was provided (e.g. Vimeo quality selection),
    // write it to a temp file so ffmpeg downloads exactly the right variant.
    let hlsUrl = options.url;
    let variantTempFile = null;
    if (options.hlsPlaylist) {
      variantTempFile = path.join(directory, `.vdl_variant_${Date.now()}.m3u8`);
      fs.writeFileSync(variantTempFile, options.hlsPlaylist, 'utf-8');
      hlsUrl = variantTempFile;
      console.log(`[HLS] Using filtered playlist for exact quality selection`);
    }

    // Check if the URL is an API endpoint that returns an m3u8 playlist or JSON
    if (options.url.includes('/media/hls/') || options.url.includes('?s=')) {
      try {
        console.log(`[HLS] Fetching playlist from API: ${options.url.substring(0, 80)}...`);
        const response = await got(options.url, {
          headers: options.formatHeaders || {},
          followRedirect: true
        });
        
        const contentType = response.headers['content-type'] || '';
        
        // Check if response is JSON containing an m3u8 URL
        if (contentType.includes('application/json') || response.body.startsWith('{') || response.body.startsWith('[')) {
          try {
            const data = JSON.parse(response.body);
            console.log(`[HLS] Received JSON response`);
            
            // Look for m3u8 URL in various possible properties
            let foundUrl = null;
            if (data.videoUrl && data.videoUrl.includes('.m3u8')) {
              foundUrl = data.videoUrl;
            } else if (data.url && data.url.includes('.m3u8')) {
              foundUrl = data.url;
            } else if (data.hls && data.hls.includes('.m3u8')) {
              foundUrl = data.hls;
            } else if (data.stream && data.stream.includes('.m3u8')) {
              foundUrl = data.stream;
            } else if (Array.isArray(data)) {
              // Search in array
              for (const item of data) {
                const url = item.videoUrl || item.url || item.hls || item.stream;
                if (url && url.includes('.m3u8')) {
                  foundUrl = url;
                  break;
                }
              }
            }
            
            if (foundUrl) {
              console.log(`[HLS] Extracted m3u8 URL from JSON: ${foundUrl.substring(0, 80)}...`);
              hlsUrl = foundUrl;
            } else {
              console.log(`[HLS] No m3u8 URL found in JSON response`);
              console.log(`[HLS] JSON keys: ${Object.keys(data).join(', ')}`);
            }
          } catch (e) {
            console.log(`[HLS] Failed to parse JSON: ${e.message}`);
          }
        }
        // Check if response is an m3u8 playlist
        else if (contentType.includes('application/vnd.apple.mpegurl') || 
                 contentType.includes('application/x-mpegURL') ||
                 response.body.includes('#EXTM3U')) {
          // It's a playlist - write to temp file and use that
          console.log(`[HLS] Received m3u8 playlist (${response.body.length} bytes)`);
          
          // Check if playlist has absolute URLs
          if (response.body.includes('http://') || response.body.includes('https://')) {
            console.log(`[HLS] Playlist contains absolute URLs, can use API endpoint directly`);
            // Can use the API endpoint URL directly with ffmpeg
          } else {
            console.log(`[HLS] Playlist contains relative URLs`);
            // Need to save the playlist to a temp file and resolve base URL
            const tempPlaylist = path.join(directory, '.temp_playlist.m3u8');
            fs.writeFileSync(tempPlaylist, response.body);
            hlsUrl = tempPlaylist;
            console.log(`[HLS] Saved playlist to temp file: ${tempPlaylist}`);
          }
        } else {
          console.log(`[HLS] Response Content-Type: ${contentType}`);
          console.log(`[HLS] First 200 chars: ${response.body.substring(0, 200)}`);
        }
      } catch (error) {
        console.log(`[HLS] Warning: Could not fetch playlist URL: ${error.message}`);
        console.log(`[HLS] Continuing with original URL...`);
      }
    }

    return new Promise((resolve, reject) => {
      const args = [
        '-loglevel', 'warning',
        '-stats'
      ];
      
      // Add cookies for ffmpeg (must be before -i)
      if (options.cookies && Array.isArray(options.cookies)) {
        const ffmpegCookies = buildFfmpegCookieString(options.cookies, hlsUrl);
        if (ffmpegCookies) {
          args.push('-cookies', ffmpegCookies);
        }
      }

      // Add headers if provided (must be before -i)
      if (options.formatHeaders) {
        // Combine all headers into a single string for -headers option
        const headerLines = [];
        for (const [key, value] of Object.entries(options.formatHeaders)) {
          if (key !== 'User-Agent') {
            headerLines.push(`${key}: ${value}`);
          }
        }
        
        if (headerLines.length > 0) {
          args.push('-headers', headerLines.join('\r\n') + '\r\n');
        }
        
        // User-Agent has its own option
        if (options.formatHeaders['User-Agent']) {
          args.push('-user_agent', options.formatHeaders['User-Agent']);
        }
      }
      
      // ffmpeg's HLS demuxer may restrict sub-resource protocols to
      // file,crypto,data by default. Always whitelist the full set so
      // remote segments / init sections (https) can be fetched.
      args.push('-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data');

      // HLS pair: two separate inputs (video + audio variant playlists)
      if (options.hlsAudioUrl) {
        args.push('-i', hlsUrl);  // input 0: video-only variant
        // Audio input needs the same headers/cookies — they were added above -i
        args.push('-i', options.hlsAudioUrl);  // input 1: audio-only variant
        args.push('-map', '0:v', '-map', '1:a');
        args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc');
      } else {
        args.push('-i', hlsUrl);
        args.push('-c', 'copy', '-bsf:a', 'aac_adtstoasc');
      }
      args.push('-y', filepath);

      console.log(`[HLS] ffmpeg command: ${ffmpegPath} ${args.join(' ')}`);
      console.log(`[HLS] Using URL: ${hlsUrl.substring(0, 100)}...`);

      const ffmpeg = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });

      let duration = 0;
      let totalSize = 0;
      let stderrOutput = '';

      // Parse ffmpeg stderr for progress
      ffmpeg.stderr.on('data', (data) => {
        const output = data.toString();
        stderrOutput += output;
        
        // Log errors
        if (output.includes('error') || output.includes('Error') || output.includes('Invalid')) {
          console.error(`[ffmpeg] ${output.trim()}`);
        }
        
        // Parse duration from ffmpeg output
        const durationMatch = output.match(/Duration: (\d{2}):(\d{2}):(\d{2})/);
        if (durationMatch && !duration) {
          const hours = parseInt(durationMatch[1]);
          const minutes = parseInt(durationMatch[2]);
          const seconds = parseInt(durationMatch[3]);
          duration = hours * 3600 + minutes * 60 + seconds;
        }
        
        // Parse current time for progress
        const timeMatch = output.match(/time=(\d{2}):(\d{2}):(\d{2})/);
        if (timeMatch && duration > 0) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseInt(timeMatch[3]);
          const currentTime = hours * 3600 + minutes * 60 + seconds;
          
          const percent = Math.min(100, (currentTime / duration) * 100);
          this.emit('progress', {
            downloaded: currentTime,
            total: duration,
            percent: percent
          });
        }
        
        // Parse size
        const sizeMatch = output.match(/size=\s*(\d+)kB/);
        if (sizeMatch) {
          totalSize = parseInt(sizeMatch[1]) * 1024;
        }
      });

      // Clean up temp variant playlist if we created one
      const cleanupVariantTemp = () => {
        if (variantTempFile) {
          try { fs.unlinkSync(variantTempFile); } catch {}
        }
      };

      ffmpeg.on('error', (error) => {
        cleanupVariantTemp();
        reject(new Error(`ffmpeg error: ${error.message}`));
      });

      ffmpeg.on('close', async (code) => {
        cleanupVariantTemp();
        if (code === 0) {
          // Post-process: embed subtitles if provided
          if (options.subtitles && options.subtitles.length > 0) {
            try {
              await this._embedSubtitlesHLS(ffmpegPath, filepath, options.subtitles, directory);
            } catch (subErr) {
              console.log(`[HLS] Warning: subtitle embedding failed: ${subErr.message}`);
            }
          }
          // After subtitle embedding the file may have changed to .mkv
          let finalPath = filepath;
          const mkvPath = filepath.replace(/\.[^.]+$/, '.mkv');
          if (!fs.existsSync(finalPath) && fs.existsSync(mkvPath)) {
            finalPath = mkvPath;
          }
          const stats = fs.statSync(finalPath);
          this.emit('complete', { filepath: finalPath, size: stats.size });
          resolve(finalPath);
        } else {
          // Log last part of stderr for debugging
          const errorLines = stderrOutput.split('\n').slice(-10).join('\n');
          console.error(`[ffmpeg] Last output:\n${errorLines}`);
          reject(new Error(`ffmpeg exited with code ${code}. Check the output above for details.`));
        }
      });
    });
  }

  /**
   * Download VTT subtitle files and remux them into an existing video file.
   * Used as a post-processing step after HLS download.
   */
  async _embedSubtitlesHLS(ffmpegPath, videoPath, subtitles, directory) {
    const subTmpPaths = [];

    // Download each subtitle track
    console.log(`[HLS] Downloading ${subtitles.length} subtitle track(s)...`);
    for (const sub of subtitles) {
      const subPath = videoPath + `.f_sub_${sub.lang}.vtt`;
      try {
        await this._downloadSubtitle(sub.url, subPath);
        const stats = fs.statSync(subPath);
        subTmpPaths.push({ path: subPath, lang: sub.lang, name: sub.name });
        console.log(`  Subtitle [${sub.lang}]: ${(stats.size / 1024).toFixed(1)} KB`);
      } catch (e) {
        console.log(`  \u26A0 Subtitle [${sub.lang}] failed: ${e.message}`);
        try { if (fs.existsSync(subPath)) fs.unlinkSync(subPath); } catch {}
      }
    }

    if (subTmpPaths.length === 0) return;

    // Remux: video (copy) + subtitles → temp file, then replace original
    const tmpOutput = videoPath + '.tmp_with_subs.mp4';
    console.log(`[HLS] Embedding ${subTmpPaths.length} subtitle(s) into output...`);

    // Determine subtitle codec based on output container
    const ext = path.extname(videoPath).toLowerCase();
    let subCodec;
    if (ext === '.mkv' || ext === '.webm') {
      subCodec = 'webvtt';
    } else {
      subCodec = 'mov_text';
    }

    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-loglevel', 'warning',
          '-i', videoPath,
        ];

        for (const sub of subTmpPaths) {
          args.push('-i', sub.path);
        }

        args.push('-c:v', 'copy', '-c:a', 'copy');

        args.push('-c:s', subCodec);

        // Map: video+audio from input 0, subs from inputs 1+
        // Use '?' suffix so ffmpeg doesn't fail if stream is absent (e.g. video-only HLS)
        args.push('-map', '0:v', '-map', '0:a?');
        for (let i = 0; i < subTmpPaths.length; i++) {
          args.push('-map', `${i + 1}:0`);
        }

        // Set subtitle metadata
        for (let i = 0; i < subTmpPaths.length; i++) {
          const sub = subTmpPaths[i];
          args.push(`-metadata:s:s:${i}`, `language=${sub.lang}`);
          if (sub.name) {
            args.push(`-metadata:s:s:${i}`, `title=${sub.name}`);
          }
        }

        args.push('-y', tmpOutput);

        const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stderr = '';
        ff.stderr.on('data', d => { stderr += d.toString(); });
        ff.on('error', e => reject(new Error(`ffmpeg error: ${e.message}`)));
        ff.on('close', code => {
          if (code === 0) resolve();
          else {
            const errLines = stderr.split('\n').slice(-5).join('\n');
            reject(new Error(`ffmpeg subtitle embed failed (code ${code}): ${errLines}`));
          }
        });
      });

      // Replace original with subtitled version
      fs.unlinkSync(videoPath);
      fs.renameSync(tmpOutput, videoPath);
      console.log(`[HLS] Subtitles embedded successfully`);
    } catch (e) {
      // Clean up temp output on failure
      try { if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput); } catch {}

      // If mov_text encoder failed, try with srt (more widely available)
      if (/mov_text|encoder/i.test(e.message) && subCodec === 'mov_text') {
        console.log(`[HLS] mov_text not available, retrying with srt codec...`);
        try {
          await new Promise((resolve, reject) => {
            const retryArgs = [
              '-loglevel', 'warning',
              '-i', videoPath,
            ];
            for (const sub of subTmpPaths) retryArgs.push('-i', sub.path);
            retryArgs.push('-c:v', 'copy', '-c:a', 'copy', '-c:s', 'srt');
            retryArgs.push('-map', '0:v', '-map', '0:a?');
            for (let i = 0; i < subTmpPaths.length; i++) retryArgs.push('-map', `${i + 1}:0`);
            for (let i = 0; i < subTmpPaths.length; i++) {
              retryArgs.push(`-metadata:s:s:${i}`, `language=${subTmpPaths[i].lang}`);
              if (subTmpPaths[i].name) retryArgs.push(`-metadata:s:s:${i}`, `title=${subTmpPaths[i].name}`);
            }
            // srt in mp4 may not work; try mkv container
            const mkvOutput = videoPath.replace(/\.[^.]+$/, '.mkv');
            retryArgs.push('-y', mkvOutput);
            const ff = spawn(ffmpegPath, retryArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
            let stderr = '';
            ff.stderr.on('data', d => { stderr += d.toString(); });
            ff.on('error', e2 => reject(e2));
            ff.on('close', code => {
              if (code === 0) {
                // MKV created successfully — remove the original mp4
                try { fs.unlinkSync(videoPath); } catch {}
                console.log(`[HLS] Subtitles embedded into .mkv container`);
                resolve();
              } else {
                reject(new Error(`srt fallback also failed (code ${code})`));
              }
            });
          });
        } catch (e2) {
          // Both embed methods failed — save subtitles as sidecar files
          console.log(`[HLS] Subtitle embedding not supported by this ffmpeg — saving as sidecar file(s)`);
          for (const sub of subTmpPaths) {
            const sidecarPath = videoPath.replace(/\.[^.]+$/, `.${sub.lang}.vtt`);
            try {
              fs.copyFileSync(sub.path, sidecarPath);
              console.log(`  Saved: ${path.basename(sidecarPath)}`);
            } catch {}
          }
        }
      } else {
        throw e;
      }
    } finally {
      // Clean up subtitle temp files
      for (const sub of subTmpPaths) {
        try { if (fs.existsSync(sub.path)) fs.unlinkSync(sub.path); } catch {}
      }
    }
  }
}

export default VideoDownloader;
