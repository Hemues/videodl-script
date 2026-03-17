#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import ProgressBar from 'progress';
import path from 'node:path';
import fs from 'node:fs';
import { VideoDownloader, uniqueFilepath } from './downloader.js';
import { VideoConverter } from './converter.js';
import { extractVideoInfo, listSupportedSites, listExtractors, getExtractor } from './extractors/index.js';
import { parseCookieFile, buildCookieHeader, buildFfmpegCookieString } from './cookies.js';
import { cfProtectedDownload } from './cf-solver.js';
import { getFullHelp, getSupportedSitesHelp } from './help.js';
import { generateCookies, checkCookieExpiry, DEFAULT_COOKIE_FILE, DEFAULT_LOGIN_FILE } from './cookie-generator.js';

const program = new Command();

// Package info — works both in dev (import.meta.url) and in compiled binary
let packageVersion = '1.0.0';
let buildTimestamp = '';
try {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf-8')
  );
  packageVersion = packageJson.version;
} catch {
  // In compiled binary the package.json may be embedded; version is baked in
  packageVersion = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : '1.0.0';
}
try {
  buildTimestamp = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : '';
} catch {
  buildTimestamp = '';
}
const fullVersion = buildTimestamp ? `${packageVersion} (${buildTimestamp})` : packageVersion;

program
  .name('videodl')
  .description('CLI video downloader and converter - inspired by Video DownloadHelper')
  .version(fullVersion)
  .addHelpText('beforeAll', () => getFullHelp(fullVersion))
  .helpOption('-h, --help', 'Show this help message and exit');

/**
 * Clean a URL by removing tracking/UTM query parameters.
 * This also defends against cmd.exe truncating at '&' chars.
 */
function cleanUrl(rawUrl) {
  try {
    const urlObj = new URL(rawUrl);
    const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_referrer'];
    for (const param of trackingParams) {
      urlObj.searchParams.delete(param);
    }
    return urlObj.toString();
  } catch {
    return rawUrl;
  }
}

// Download command
program
  .command('download <url>')
  .description('Download a video from URL (supports xHamster and direct URLs)')
  .option('-o, --output <filename>', 'Output filename')
  .option('-d, --directory <path>', 'Output directory', './downloads')
  .option('-f, --format <quality>', 'Quality/format to download (e.g., 720p, 1080p, best, worst)', 'default')
  .option('-H, --header <header>', 'Add custom header (can be used multiple times)', collectHeaders, [])
  .option('--no-ssl-verify', 'Disable SSL certificate verification')
  .option('--proxy <url>', 'Use proxy server')
  .option('--no-base-url', 'Do not add base domain to filename (domain is added by default)')
  .option('--list-formats', 'List available formats without downloading')
  .option('--cookies <file>', 'Cookie file in Netscape/Mozilla format (like yt-dlp)')
  .option('--generate-cookies', 'Auto-regenerate cookies from logins.txt if they have expired')
  .option('--force-cookies', 'Force cookie regeneration even if cookies appear valid (use when server rejects session)')
  .option('--no-headless', 'Show browser window during cookie generation (allows manual CAPTCHA solving)')
  .option('--captcha-provider <id>', 'CAPTCHA solver provider: "wit" (free, wit.ai) or "2captcha" (paid); default: wit')
  .option('--captcha-key <key>', 'CAPTCHA API key / token (wit.ai server token or 2captcha key; or set env CAPTCHA_API_KEY)')
  .option('--logins <file>', 'Login-details file for cookie generation (default: logins/logins.txt)')
  .option('--no-subtitle', 'Do not download/embed subtitles (subtitles are included by default when available)')
  .option('--sub-lang <lang>', 'Subtitle language code to download (e.g., en, hu, de). Use "all" for all tracks')
  .option('--sub-translate <lang>', 'Auto-translate subtitles to this language code (e.g., hu for Hungarian)')
  .option('--audio-lang <lang>', 'Audio language: specific code (en, de), "all" for all tracks (default: auto-detect)')
  .action(async (rawUrl, options) => {
    try {
      const url = cleanUrl(rawUrl);
      const cookieFile = options.cookies || DEFAULT_COOKIE_FILE;
      const loginFile = options.logins || DEFAULT_LOGIN_FILE;

      // Parse cookies — use default path if not specified
      let cookies = null;
      const cookieFileExists = fs.existsSync(path.resolve(cookieFile));

      if (cookieFileExists) {
        try {
          cookies = parseCookieFile(cookieFile);
          console.log(chalk.gray(`🍪 Loaded ${cookies.length} cookies from ${cookieFile}`));
        } catch (e) {
          console.error(chalk.red(`Failed to load cookies: ${e.message}`));
          process.exit(1);
        }
      }

      // Check cookie expiry and auto-regenerate if --generate-cookies is set
      const expiryCheck = checkCookieExpiry(url, cookieFile);
      const forceRegen = !!options.forceCookies;
      if (expiryCheck.expired || forceRegen) {
        if (options.generateCookies || forceRegen) {
          // Auto-regenerate
          if (!fs.existsSync(path.resolve(loginFile))) {
            console.error(chalk.red(`\n✗ Cookie expired (${expiryCheck.reason}) but login file not found: ${loginFile}`));
            console.error(chalk.gray('  Create a logins.txt file with: loginPageUrl::username::password'));
            process.exit(1);
          }
          const regenReason = forceRegen && !expiryCheck.expired
            ? 'forced regeneration (--force-cookies)'
            : expiryCheck.reason;
          console.log(chalk.yellow(`🔄 Cookie refresh: ${regenReason} — regenerating...`));
          try {
            const genResult = await generateCookies(loginFile, cookieFile, {
              onlyIfExpired: false,
              verbose: false,
              headless: options.headless !== false,
              captchaProvider: options.captchaProvider,
              captchaKey: options.captchaKey,
            });

            // Check whether regeneration actually succeeded
            if (genResult.succeeded === 0) {
              console.error(chalk.yellow(`⚠ Cookie regeneration failed — login did not succeed.`));
              if (genResult.failed > 0) {
                console.error(chalk.gray('  The browser-based login was unable to obtain fresh cookies.'));
                console.error(chalk.gray('  Possible causes:'));
                console.error(chalk.gray('    • reCAPTCHA blocked the headless browser'));
                console.error(chalk.gray('    • Invalid username/password in logins.txt'));
                console.error(chalk.gray('    • Site UI changed (login form not found)'));
              }
              console.error(chalk.gray('  Continuing with expired cookies (trailer/preview may still be available)...'));
            } else {
              // Reload fresh cookies
              cookies = parseCookieFile(cookieFile);

              // Re-verify the cookie is actually fresh
              const recheck = checkCookieExpiry(url, cookieFile);
              if (recheck.expired) {
                console.error(chalk.yellow(`⚠ Cookie is still expired after regeneration: ${recheck.reason}`));
                console.error(chalk.gray('  Continuing with expired cookies (trailer/preview may still be available)...'));
              } else {
                console.log(chalk.green(`✓ Cookies refreshed (${cookies.length} cookies loaded)`));
              }
            }
          } catch (genErr) {
            console.error(chalk.yellow(`⚠ Cookie regeneration failed: ${genErr.message}`));
            console.error(chalk.gray('  Continuing with expired cookies (trailer/preview may still be available)...'));
          }
        } else if (expiryCheck.cookieName) {
          // No --generate-cookies flag — warn but continue (extractor may fall back to trailer)
          console.error(chalk.yellow(`⚠ Cookie has expired: ${expiryCheck.reason}`));
          console.error(chalk.gray('  Full video requires valid cookies. Trailer/preview may still work.'));
          console.error(chalk.gray('  Use --generate-cookies to auto-refresh, or manually update the cookie file.'));
          console.error(chalk.gray(`  Cookie file: ${cookieFile}`));
        }
        // If cookieName is null, no extractor registered — not a cookie-required site, continue normally
      }

      // Extract video info first
      console.log(chalk.blue('🔍 Extracting video information...'));
      console.log(chalk.gray(`URL: ${url}`));
      
      let videoInfo;
      let selectedFormat;
      let formatPair = null;
      
      try {
        videoInfo = await extractVideoInfo(url, { cookies });
        console.log(chalk.green(`✓ Found: ${videoInfo.title}`));
        console.log(chalk.gray(`  Extractor: ${videoInfo.extractor}`));
        
        // List formats if requested
        if (options.listFormats) {
          console.log(chalk.cyan('\nAvailable formats:'));
          videoInfo.formats.forEach((fmt, idx) => {
            const type = (fmt.hasVideo && fmt.hasAudio) ? 'V+A' :
                         fmt.hasVideo ? 'V  ' : 'A  ';
            const res = fmt.height ? `${fmt.height}p`.padEnd(6) : '      ';
            const codec = [fmt.vcodec, fmt.acodec].filter(Boolean).join('+');
            const size = fmt.filesize ? `${(fmt.filesize / 1024 / 1024).toFixed(1)}MB` : '';
            console.log(`  [${String(idx).padStart(2)}] ${type} ${res} ${fmt.quality.padEnd(10)} ${fmt.ext.padEnd(5)} ${codec.padEnd(20)} ${size}`);
          });
          const combined = videoInfo.formats.filter(f => f.hasVideo && f.hasAudio);
          const voCount = videoInfo.formats.filter(f => f.hasVideo && !f.hasAudio).length;
          const aoCount = videoInfo.formats.filter(f => !f.hasVideo && f.hasAudio).length;
          console.log(chalk.gray(`\n  ${combined.length} combined, ${voCount} video-only, ${aoCount} audio-only`));
          if (voCount > 0 && aoCount > 0) {
            console.log(chalk.green(`  ⚡ DASH merge available (video+audio downloaded separately = much faster)`));
          }          // Show subtitles if available
          if (videoInfo.subtitles && Object.keys(videoInfo.subtitles).length > 0) {
            console.log(chalk.cyan('\nAvailable subtitles (auto-included by default, use --no-subtitle to skip):'));
            for (const [lang, sub] of Object.entries(videoInfo.subtitles)) {
              const auto = sub.isAutoGenerated ? chalk.gray(' (auto-generated)') : '';
              console.log(`  ${lang}: ${sub.name}${sub.name.includes('auto-generated') ? '' : auto}`);
            }
            if (videoInfo.translationLanguages?.length > 0) {
              console.log(chalk.gray(`  + ${videoInfo.translationLanguages.length} auto-translation languages (use --sub-translate <lang>)`));
            }
          }          return;
        }
        
        // Select format — try DASH merge first (much faster on YouTube)
        const extractor = (await import('./extractors/index.js')).getExtractor(url);
        formatPair = extractor.selectFormatPair(videoInfo.formats, options.format, options.audioLang || null);
        if (formatPair) {
          const isHlsPair = formatPair.video.protocol === 'hls' && formatPair.audio.protocol === 'hls';
          const vInfo = `${formatPair.video.quality} ${formatPair.video.vcodec || ''}`.trim();
          const aInfo = `${formatPair.audio.quality} ${formatPair.audio.acodec || ''}`.trim();
          if (isHlsPair) {
            const trackCount = formatPair.audioTracks ? formatPair.audioTracks.length : 1;
            const extLabel = trackCount > 1 ? '.mkv' : '.mp4';
            console.log(chalk.cyan(`⚡ HLS merge: ${vInfo} + ${trackCount} audio track(s) → ${extLabel}`));
            // Stash variant URLs so ffmpeg can open them as separate -i inputs.
            formatPair._hlsVideoUrl = formatPair.video.url;
            if (formatPair.audioTracks && formatPair.audioTracks.length > 1) {
              formatPair._hlsAudioUrls = formatPair.audioTracks.map(a => ({
                url: a.url, lang: a.audioTrackLang || null, name: a.audioTrackName || null,
              }));
            } else {
              formatPair._hlsAudioUrl = formatPair.audio.url;
            }
          } else {
            console.log(chalk.cyan(`⚡ DASH merge: ${vInfo} + ${aInfo} → .${formatPair.ext}`));
          }
          selectedFormat = formatPair.video; // for filename building
        } else {
          selectedFormat = extractor.selectFormat(videoInfo.formats, options.format);
          console.log(chalk.cyan(`Selected format: ${selectedFormat.quality} (${selectedFormat.height}p)`));
        }
        
      } catch (extractError) {
        // Check whether a site-specific extractor matched this URL.
        // If one did, the error is meaningful (e.g. missing cookies, expired
        // auth, scene not found) — do NOT fall back to a direct download
        // because that would just save an HTML page.
        const matchedExtractor = getExtractor(url);
        const isSiteSpecific = matchedExtractor && matchedExtractor.constructor.name !== 'DirectExtractor';

        if (isSiteSpecific) {
          console.error(chalk.red(`\n✗ ${matchedExtractor.name || 'Extractor'} error: ${extractError.message}`));

          // Give helpful hints for auth-required sites
          if (/cookie|auth|token|login|expired|401/i.test(extractError.message)) {
            console.error(chalk.gray('  Make sure you have valid cookies:'));
            console.error(chalk.gray(`    videodl download --cookies cookies/cookies.txt "${url}"`));
            console.error(chalk.gray('  Or auto-generate cookies from your login:'));
            console.error(chalk.gray(`    videodl download --generate-cookies "${url}"`));
          }
          process.exit(1);
        }

        // No site-specific extractor — genuine direct URL, try downloading as-is
        console.log(chalk.yellow(`⚠ Extraction failed, trying as direct URL...`));
        selectedFormat = { url: url };
        videoInfo = { title: 'video' };
      }

      console.log(chalk.blue('\n📥 Starting download...'));
      const downloader = new VideoDownloader({
        downloadFolder: options.directory
      });

      let progressBar;

      downloader.on('start', ({ filepath }) => {
        console.log(chalk.gray(`Saving to: ${filepath}`));
      });

      downloader.on('ffmpeg-download', (progress) => {
        if (progress.status === 'downloading' && progress.percent) {
          if (!progressBar) {
            console.log(chalk.yellow('📦 Downloading ffmpeg...'));
          }
          process.stdout.write(`\r${chalk.cyan('Downloading ffmpeg:')} ${progress.percent.toFixed(1)}%`);
        }
      });

      downloader.on('merge-phase', ({ phase, label }) => {
        if (progressBar) {
          progressBar = null;
          console.log();
        }
        console.log(chalk.blue(`  ${label}`));
      });

      downloader.on('progress', ({ downloaded, total, percent }) => {
        if (!progressBar && total > 0) {
          progressBar = new ProgressBar(
            chalk.cyan('  [:bar] :percent :etas'),
            {
              complete: '█',
              incomplete: '░',
              width: 40,
              total: 100
            }
          );
        }
        if (progressBar) {
          progressBar.update(percent / 100);
        }
      });

      downloader.on('complete', ({ filepath, size }) => {
        const sizeMB = (size / 1024 / 1024).toFixed(2);
        console.log(chalk.green(`\n✓ Download complete!`));
        console.log(chalk.gray(`File: ${filepath}`));
        console.log(chalk.gray(`Size: ${sizeMB} MB`));
      });

      downloader.on('error', ({ error }) => {
        console.error(chalk.red(`\n✗ Download failed: ${error.message}`));
      });

      // Sanitize filename: keep letters (including accented), digits and spaces
      const sanitizeFilename = (title) => {
        return title
          .replace(/[^\p{L}\p{N}\s]/gu, '') // Remove non-letter/non-digit chars, keep Unicode letters
          .replace(/\s+/g, '_')          // Replace spaces with underscores
          .replace(/_+/g, '_')           // Collapse multiple underscores
          .replace(/^_+|_+$/g, '')       // Trim underscores from start/end
          .trim() || 'video';            // Fallback to 'video' if empty
      };

      // Extract base domain from URL (e.g., xvideos.com, pornhub.com)
      const extractBaseDomain = (url) => {
        try {
          const urlObj = new URL(url);
          return urlObj.hostname.replace(/^www\./, ''); // Remove www. prefix
        } catch {
          return null;
        }
      };

      // Build filename with base domain (by default, unless --no-base-url is specified)
      let filename;
      if (options.output) {
        filename = options.output;
      } else {
        const baseName = sanitizeFilename(videoInfo.title);
        // HLS pair → mkv for multi-audio, mp4 for single, otherwise use formatPair or selectedFormat ext
        const ext = (formatPair && formatPair._hlsAudioUrls) ? 'mkv'
          : (formatPair && formatPair._hlsVideoUrl) ? 'mp4'
          : formatPair ? formatPair.ext
          : (selectedFormat.ext || 'mp4');
        // Add domain by default (baseUrl defaults to true)
        if (options.baseUrl !== false) {
          const domain = extractBaseDomain(url);
          filename = domain ? `${baseName}-${domain}.${ext}` : `${baseName}.${ext}`;
        } else {
          filename = `${baseName}.${ext}`;
        }
      }

      // ─── Cloudflare-protected CDN: download with TLS fingerprint impersonation ─
      const cfFormat = (formatPair ? formatPair.video : selectedFormat);
      if (cfFormat?.cfProtected) {
        console.log(chalk.yellow('\n🔒 CDN is Cloudflare-protected — using TLS impersonation...'));

        let cfProgressBar;
        try {
          const result = await cfProtectedDownload({
            url: cfFormat.url || selectedFormat.url,
            filepath: uniqueFilepath(path.join(options.directory || './downloads', filename)),
            headers: cfFormat.headers || {},
            timeout: 600000, // 10 min for large videos
            onStatus: s => console.log(chalk.gray(`  ${s}`)),
            onProgress: (downloaded, total) => {
              if (!cfProgressBar && total > 0) {
                cfProgressBar = new ProgressBar(
                  chalk.cyan('  [:bar] :percent :etas'),
                  { complete: '█', incomplete: '░', width: 40, total: 100 }
                );
              }
              if (cfProgressBar && total > 0) {
                cfProgressBar.update(Math.min(downloaded / total, 1));
              }
            }
          });
          const sizeMB = (result.size / 1024 / 1024).toFixed(2);
          console.log(chalk.green(`\n✓ Download complete!`));
          console.log(chalk.gray(`File: ${result.filepath}`));
          console.log(chalk.gray(`Size: ${sizeMB} MB`));
        } catch (cfErr) {
          console.error(chalk.red(`Error: ${cfErr.message}`));
          process.exit(1);
        }
        return; // Skip normal download flow
      }

      const downloadOptions = {
        url: selectedFormat.url,
        filename: filename,
        directory: options.directory,
        headers: options.header,
        formatHeaders: selectedFormat.headers, // Pass format-specific headers
        rejectUnauthorized: options.sslVerify,
        cookies: cookies // Pass parsed cookies to downloader
      };

      if (options.proxy) {
        downloadOptions.proxy = options.proxy;
      }

      // Use DASH merge for video-only+audio-only pairs, HLS for m3u8, regular for direct
      if (formatPair && formatPair._hlsVideoUrl) {
        // HLS pair: pass video + audio variant URLs as separate ffmpeg inputs
        downloadOptions.url = formatPair._hlsVideoUrl;
        if (formatPair._hlsAudioUrls) {
          downloadOptions.hlsAudioUrls = formatPair._hlsAudioUrls;
        } else {
          downloadOptions.hlsAudioUrl = formatPair._hlsAudioUrl;
        }
        downloadOptions.formatHeaders = formatPair.video.headers;

        // Resolve subtitle downloads (same logic as DASH branch)
        const wantSubs = options.subtitle !== false;
        let subtitleDownloads = [];
        if (wantSubs && videoInfo.subtitles && Object.keys(videoInfo.subtitles).length > 0) {
          const subs = videoInfo.subtitles;
          const requestedLang = options.subLang || null;
          const translateLang = options.subTranslate || null;

          if (translateLang) {
            const firstTrack = Object.values(subs)[0];
            if (firstTrack.isTranslatable) {
              const transUrl = firstTrack.formats.vtt + '&tlang=' + translateLang;
              subtitleDownloads.push({ url: transUrl, lang: translateLang, name: `${translateLang} (auto-translated)` });
              console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${translateLang} (auto-translated from ${firstTrack.lang})`));
            }
          } else if (requestedLang === 'all' || !requestedLang) {
            for (const [lang, sub] of Object.entries(subs)) {
              subtitleDownloads.push({ url: sub.formats.vtt, lang, name: sub.name });
            }
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitles: ${subtitleDownloads.map(s => s.lang).join(', ')}`));
          } else if (requestedLang && subs[requestedLang]) {
            const sub = subs[requestedLang];
            subtitleDownloads.push({ url: sub.formats.vtt, lang: requestedLang, name: sub.name });
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${requestedLang} - ${sub.name}`));
          } else if (requestedLang && !subs[requestedLang]) {
            const firstTrack = Object.values(subs)[0];
            if (firstTrack.isTranslatable) {
              const transUrl = firstTrack.formats.vtt + '&tlang=' + requestedLang;
              subtitleDownloads.push({ url: transUrl, lang: requestedLang, name: `${requestedLang} (auto-translated)` });
              console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${requestedLang} (auto-translated)`));
            } else {
              console.log(chalk.yellow(`\u26A0 Subtitle language '${requestedLang}' not available`));
            }
          }
        }
        if (subtitleDownloads.length > 0) {
          downloadOptions.subtitles = subtitleDownloads;
        }

        await downloader.downloadHLS(downloadOptions);
      } else if (formatPair) {
        // Resolve subtitle downloads for DASH merge
        // Subtitles are included by default when available; --no-subtitle opts out
        const wantSubs = options.subtitle !== false;
        let subtitleDownloads = [];
        if (wantSubs && videoInfo.subtitles && Object.keys(videoInfo.subtitles).length > 0) {
          const subs = videoInfo.subtitles;
          const requestedLang = options.subLang || null;
          const translateLang = options.subTranslate || null;

          if (translateLang) {
            // Auto-translate: take the first available track, add &tlang=XX
            const firstTrack = Object.values(subs)[0];
            if (firstTrack.isTranslatable) {
              const transUrl = firstTrack.formats.vtt + '&tlang=' + translateLang;
              subtitleDownloads.push({ url: transUrl, lang: translateLang, name: `${translateLang} (auto-translated)` });
              console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${translateLang} (auto-translated from ${firstTrack.lang})`));
            } else {
              console.log(chalk.yellow('\u26A0 Subtitle track is not translatable'));
            }
          } else if (requestedLang === 'all' || !requestedLang) {
            // Default: download all available subtitle tracks
            for (const [lang, sub] of Object.entries(subs)) {
              subtitleDownloads.push({ url: sub.formats.vtt, lang, name: sub.name });
            }
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitles: ${subtitleDownloads.map(s => s.lang).join(', ')}`));
          } else if (requestedLang && subs[requestedLang]) {
            // Specific language requested and available
            const sub = subs[requestedLang];
            subtitleDownloads.push({ url: sub.formats.vtt, lang: requestedLang, name: sub.name });
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${requestedLang} - ${sub.name}`));
          } else if (requestedLang && !subs[requestedLang]) {
            // Requested language not available as native track — try auto-translate
            const firstTrack = Object.values(subs)[0];
            if (firstTrack.isTranslatable) {
              const transUrl = firstTrack.formats.vtt + '&tlang=' + requestedLang;
              subtitleDownloads.push({ url: transUrl, lang: requestedLang, name: `${requestedLang} (auto-translated)` });
              console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${requestedLang} (auto-translated, native ${firstTrack.lang} not matched)`));
            } else {
              console.log(chalk.yellow(`\u26A0 Subtitle language '${requestedLang}' not available`));
            }
          }
        } else if (wantSubs && (options.subLang || options.subTranslate)) {
          console.log(chalk.yellow('\u26A0 No subtitles available for this video'));
        }

        const audioStreams = (formatPair.audioTracks || [formatPair.audio]).map(a => ({
          url: a.url, headers: a.headers, filesize: a.filesize || 0,
          lang: a.audioTrackLang || null, name: a.audioTrackName || null,
        }));
        await downloader.downloadAndMerge({
          videoStream: { url: formatPair.video.url, headers: formatPair.video.headers, filesize: formatPair.video.filesize || 0 },
          audioStreams,
          videoInfo: `${formatPair.video.quality} ${formatPair.video.vcodec || ''}`.trim(),
          audioInfo: audioStreams.map(a => `${a.lang || 'audio'}`).join('+'),
          filename: filename,
          directory: options.directory,
          cookies: cookies,
          rejectUnauthorized: options.sslVerify,
          subtitles: subtitleDownloads
        });
      } else if (selectedFormat.protocol === 'hls' || selectedFormat.ext === 'm3u8' || selectedFormat.url.includes('.m3u8')) {
        if (selectedFormat._hlsPlaylist) {
          downloadOptions.hlsPlaylist = selectedFormat._hlsPlaylist;
        }

        // Resolve subtitle downloads for HLS (same logic as DASH branch)
        const wantSubs = options.subtitle !== false;
        let subtitleDownloads = [];
        if (wantSubs && videoInfo.subtitles && Object.keys(videoInfo.subtitles).length > 0) {
          const subs = videoInfo.subtitles;
          const requestedLang = options.subLang || null;

          if (requestedLang === 'all' || !requestedLang) {
            for (const [lang, sub] of Object.entries(subs)) {
              subtitleDownloads.push({ url: sub.formats.vtt, lang, name: sub.name });
            }
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitles: ${subtitleDownloads.map(s => s.lang).join(', ')}`));
          } else if (requestedLang && subs[requestedLang]) {
            const sub = subs[requestedLang];
            subtitleDownloads.push({ url: sub.formats.vtt, lang: requestedLang, name: sub.name });
            console.log(chalk.cyan(`\uD83D\uDCDD Subtitle: ${requestedLang} - ${sub.name}`));
          } else if (requestedLang && !subs[requestedLang]) {
            console.log(chalk.yellow(`\u26A0 Subtitle language '${requestedLang}' not available`));
          }
        }
        if (subtitleDownloads.length > 0) {
          downloadOptions.subtitles = subtitleDownloads;
        }

        await downloader.downloadHLS(downloadOptions);
      } else {
        await downloader.download(downloadOptions);
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Convert command
program
  .command('convert <input> <output>')
  .description('Convert video file to different format')
  .option('-vc, --video-codec <codec>', 'Video codec (e.g., libx264, libx265, vp9)')
  .option('-ac, --audio-codec <codec>', 'Audio codec (e.g., aac, mp3, opus)')
  .option('-vb, --video-bitrate <bitrate>', 'Video bitrate (e.g., 2M, 5000k)')
  .option('-ab, --audio-bitrate <bitrate>', 'Audio bitrate (e.g., 128k, 320k)')
  .option('-s, --resolution <res>', 'Resolution (e.g., 1920x1080, 1280x720)')
  .option('-r, --fps <fps>', 'Frame rate', parseFloat)
  .option('-f, --format <format>', 'Output format (e.g., mp4, mkv, webm)')
  .option('-q, --quality <quality>', 'Quality (1-31, lower is better)', parseInt)
  .option('--no-overwrite', 'Do not overwrite existing files')
  .action(async (input, output, options) => {
    try {
      console.log(chalk.blue('🎬 Starting conversion...'));
      console.log(chalk.gray(`Input:  ${input}`));
      console.log(chalk.gray(`Output: ${output}`));

      const converter = new VideoConverter();

      converter.on('start', ({ pid }) => {
        console.log(chalk.gray(`Process ID: ${pid}`));
      });

      converter.on('progress', ({ time, fps, size, bitrate, speed }) => {
        process.stdout.write(
          chalk.cyan(
            `\rProgress: time=${time || '00:00:00.00'} fps=${fps || 0} size=${size || 0}kB bitrate=${bitrate || 0}kbits/s speed=${speed || 0}x`
          )
        );
      });

      converter.on('complete', ({ output }) => {
        const stats = fs.statSync(output);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(chalk.green(`\n\n✓ Conversion complete!`));
        console.log(chalk.gray(`File: ${output}`));
        console.log(chalk.gray(`Size: ${sizeMB} MB`));
      });

      converter.on('error', ({ error }) => {
        console.error(chalk.red(`\n✗ Conversion failed: ${error.message}`));
      });

      const conversionOptions = {
        videoCodec: options.videoCodec,
        audioCodec: options.audioCodec,
        videoBitrate: options.videoBitrate,
        audioBitrate: options.audioBitrate,
        resolution: options.resolution,
        fps: options.fps,
        format: options.format,
        quality: options.quality,
        overwrite: options.overwrite
      };

      await converter.convert(input, output, conversionOptions);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// List formats command
program
  .command('list-formats <url>')
  .description('List all available formats for a video URL')
  .alias('formats-list')
  .option('--cookies <file>', 'Cookie file in Netscape/Mozilla format (like yt-dlp)')
  .action(async (rawUrl, options) => {
    try {
      const url = cleanUrl(rawUrl);
      let cookies = null;
      if (options.cookies) {
        try {
          cookies = parseCookieFile(options.cookies);
          console.log(chalk.gray(`\uD83C\uDF6A Loaded ${cookies.length} cookies from ${options.cookies}`));
        } catch (e) {
          console.error(chalk.red(`Failed to load cookies: ${e.message}`));
          process.exit(1);
        }
      }
      console.log(chalk.blue('\uD83D\uDD0D Extracting video information...'));
      const videoInfo = await extractVideoInfo(url, { cookies });
      
      console.log(chalk.green(`\n✓ Video: ${videoInfo.title}`));
      console.log(chalk.gray(`  Extractor: ${videoInfo.extractor}`));
      console.log(chalk.cyan('\nAvailable formats:'));
      console.log(chalk.gray('─'.repeat(80)));
      
      videoInfo.formats.forEach((fmt, idx) => {
        const quality = fmt.quality.padEnd(12);
        const resolution = `${fmt.height}p`.padEnd(8);
        const ext = fmt.ext.padEnd(6);
        console.log(`  ${String(idx).padStart(2)}. ${quality} ${resolution} ${ext}`);
      });
      
      console.log(chalk.gray('─'.repeat(80)));
      console.log(chalk.cyan('\nUsage:'));
      console.log(`  videodl download "${url}" -f best`);
      console.log(`  videodl download "${url}" -f 720p`);
      console.log(`  videodl download "${url}" -f worst`);
      
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Supported sites command
program
  .command('sites')
  .description('List supported video sites')
  .action(() => {
    const sites = listSupportedSites();
    console.log(chalk.blue('🌐 Supported Sites:'));
    console.log(chalk.gray('─'.repeat(50)));
    sites.forEach(site => {
      console.log(`  • ${site}`);
    });
    console.log(chalk.gray('─'.repeat(50)));
    console.log(chalk.cyan('\nPlus direct video URLs (.mp4, .mkv, .webm, etc.)'));
  });

// Extractors command
program
  .command('extractors')
  .description('List all supported extractors with details')
  .option('-j, --json', 'Output as JSON')
  .action((options) => {
    const extractors = listExtractors();

    if (options.json) {
      console.log(JSON.stringify(extractors, null, 2));
      return;
    }

    console.log(chalk.blue('\n🔧 Supported Extractors:\n'));
    console.log(chalk.gray(`  ${'#'.padEnd(4)} ${'Name'.padEnd(22)} ${'Class'.padEnd(30)} URL Pattern`));
    console.log(chalk.gray('  ' + '─'.repeat(90)));

    extractors.forEach((ext, idx) => {
      const num = String(idx + 1).padEnd(4);
      const name = ext.isDirect
        ? chalk.yellow(ext.name.padEnd(22))
        : chalk.green(ext.name.padEnd(22));
      const cls = chalk.gray(ext.className.padEnd(30));
      const pattern = chalk.cyan(ext.pattern);
      console.log(`  ${num}${name} ${cls} ${pattern}`);
    });

    console.log(chalk.gray('\n  ' + '─'.repeat(90)));
    console.log(`  ${chalk.green(extractors.filter(e => !e.isDirect).length)} site extractors + ${chalk.yellow('1')} direct URL handler`);
    console.log(chalk.cyan('\n  Direct handler matches: .mp4, .mkv, .webm, .avi, .mov, .flv, .m4v, .ts, .m3u8'));
    console.log('');
  });

// Download and convert command
program
  .command('dl-convert <url> <output>')
  .description('Download and convert video in one step')
  .option('-d, --directory <path>', 'Download directory', './downloads')
  .option('-q, --quality <quality>', 'Quality to download (e.g., 720p, best)', 'best')
  .option('-H, --header <header>', 'Add custom header', collectHeaders, [])
  .option('--no-base-url', 'Do not add base domain to filename (domain is added by default)')
  .option('-vc, --video-codec <codec>', 'Video codec')
  .option('-ac, --audio-codec <codec>', 'Audio codec')
  .option('-vb, --video-bitrate <bitrate>', 'Video bitrate')
  .option('-ab, --audio-bitrate <bitrate>', 'Audio bitrate')
  .option('-s, --resolution <res>', 'Resolution')
  .option('-f, --format <format>', 'Output format')
  .option('--keep-original', 'Keep the original downloaded file')
  .option('--cookies <file>', 'Cookie file in Netscape/Mozilla format (like yt-dlp)')
  .action(async (rawUrl, output, options) => {
    try {
      const url = cleanUrl(rawUrl);
      let cookies = null;
      if (options.cookies) {
        try {
          cookies = parseCookieFile(options.cookies);
          console.log(chalk.gray(`\uD83C\uDF6A Loaded ${cookies.length} cookies from ${options.cookies}`));
        } catch (e) {
          console.error(chalk.red(`Failed to load cookies: ${e.message}`));
          process.exit(1);
        }
      }
      console.log(chalk.blue('\uD83D\uDCE5\uD83C\uDFAC Download and convert...'));

      // Extract video info
      console.log(chalk.blue('\n[1/3] Extracting video information...'));
      let videoInfo;
      let selectedFormat;
      
      try {
        videoInfo = await extractVideoInfo(url, { cookies });
        console.log(chalk.green(`✓ Found: ${videoInfo.title}`));
        
        const extractor = (await import('./extractors/index.js')).getExtractor(url);
        selectedFormat = extractor.selectFormat(videoInfo.formats, options.quality);
        console.log(chalk.cyan(`Selected: ${selectedFormat.quality} (${selectedFormat.height}p)`));
      } catch (extractError) {
        console.log(chalk.yellow(`⚠ Using direct URL`));
        selectedFormat = { url: url };
      }

      const downloader = new VideoDownloader({
        downloadFolder: options.directory
      });
      const converter = new VideoConverter();

      // Download phase
      console.log(chalk.blue('\n[2/3] Downloading...'));
      let downloadPath;

      downloader.on('progress', ({ percent }) => {
        process.stdout.write(chalk.cyan(`\rProgress: ${percent}%`));
      });

      downloadPath = await downloader.download({
        url: selectedFormat.url,
        directory: options.directory,
        headers: options.header
      });

      console.log(chalk.green(`\n✓ Download complete: ${downloadPath}`));

      // Convert phase
      console.log(chalk.blue('\n[3/3] Converting...'));

      converter.on('progress', ({ time, fps, speed }) => {
        process.stdout.write(
          chalk.cyan(`\rProgress: time=${time || '00:00:00.00'} fps=${fps || 0} speed=${speed || 0}x`)
        );
      });

      await converter.convert(downloadPath, output, {
        videoCodec: options.videoCodec,
        audioCodec: options.audioCodec,
        videoBitrate: options.videoBitrate,
        audioBitrate: options.audioBitrate,
        resolution: options.resolution,
        format: options.format
      });

      console.log(chalk.green(`\n✓ Conversion complete: ${output}`));

      // Clean up original if requested
      if (!options.keepOriginal && downloadPath !== output) {
        fs.unlinkSync(downloadPath);
        console.log(chalk.gray(`Removed original file: ${downloadPath}`));
      }

      console.log(chalk.green('\n✓ All done!'));
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Probe command
program
  .command('probe <file>')
  .description('Get video file information')
  .option('-j, --json', 'Output as JSON')
  .action(async (file, options) => {
    try {
      console.log(chalk.blue('🔍 Probing video file...'));

      const converter = new VideoConverter();
      const info = await converter.probe(file, options.json);

      if (options.json) {
        console.log(JSON.stringify(info, null, 2));
      } else {
        console.log(chalk.green('\n📹 Video Information:'));
        console.log(chalk.gray('─'.repeat(50)));
        if (info.duration) console.log(`Duration:     ${formatDuration(info.duration)}`);
        if (info.width && info.height) console.log(`Resolution:   ${info.width}x${info.height}`);
        if (info.videoCodec) console.log(`Video Codec:  ${info.videoCodec}`);
        if (info.audioCodec) console.log(`Audio Codec:  ${info.audioCodec}`);
        if (info.fps) console.log(`Frame Rate:   ${info.fps} fps`);
        console.log(chalk.gray('─'.repeat(50)));
      }
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Info command
program
  .command('info')
  .description('Show ffmpeg information')
  .action(async () => {
    try {
      const converter = new VideoConverter();
      const info = await converter.getInfo();

      console.log(chalk.blue('ℹ️  System Information:'));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(`Program:  ${info.program}`);
      console.log(`Version:  ${info.version}`);
      console.log(`Path:     ${info.path}`);
      console.log(chalk.gray('─'.repeat(50)));
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Formats command
program
  .command('formats')
  .description('List supported formats')
  .action(async () => {
    try {
      const converter = new VideoConverter();
      const formats = await converter.getFormats();
      console.log(formats);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Codecs command
program
  .command('codecs')
  .description('List supported codecs')
  .action(async () => {
    try {
      const converter = new VideoConverter();
      const codecs = await converter.getCodecs();
      console.log(codecs);
    } catch (error) {
      console.error(chalk.red(`Error: ${error.message}`));
      process.exit(1);
    }
  });

// Helper functions
function collectHeaders(value, previous) {
  const [name, ...valueParts] = value.split(':');
  const headerValue = valueParts.join(':').trim();
  return previous.concat([{ name: name.trim(), value: headerValue }]);
}

function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════
//  Machine-readable API commands (for integration with videodl backend)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Write a JSON line to stdout (for machine-readable output).
 * Each message is a single JSON object on its own line.
 */
function jsonLine(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// Extract command — output video info as JSON for programmatic use
program
  .command('extract <url>')
  .description('Extract video information and output as JSON (machine-readable)')
  .option('--cookies <file>', 'Cookie file in Netscape/Mozilla format')
  .action(async (rawUrl, options) => {
    try {
      const url = cleanUrl(rawUrl);
      let cookies = null;
      if (options.cookies) {
        try {
          cookies = parseCookieFile(options.cookies);
        } catch (e) {
          jsonLine({ status: 'error', msg: `Failed to load cookies: ${e.message}` });
          process.exit(1);
        }
      }

      const videoInfo = await extractVideoInfo(url, { cookies });

      // Build a normalized output structure for the backend
      const result = {
        status: 'ok',
        id: videoInfo.id || '',
        title: videoInfo.title || 'Untitled',
        url: url,
        extractor: videoInfo.extractor || 'unknown',
        _type: 'video',
        formats: (videoInfo.formats || []).map(fmt => ({
          quality: fmt.quality || '',
          height: fmt.height || 0,
          ext: fmt.ext || 'mp4',
          url: fmt.url || '',
          hasVideo: !!fmt.hasVideo,
          hasAudio: !!fmt.hasAudio,
          vcodec: fmt.vcodec || null,
          acodec: fmt.acodec || null,
          filesize: fmt.filesize || null,
          bitrate: fmt.bitrate || null,
          protocol: fmt.protocol || 'https',
          headers: fmt.headers || null,
          cfProtected: !!fmt.cfProtected,
          _hlsPlaylist: fmt._hlsPlaylist || null,
        })),
        subtitles: videoInfo.subtitles || {},
        translationLanguages: videoInfo.translationLanguages || [],
        thumbnail: videoInfo.thumbnail || null,
        duration: videoInfo.duration || null,
        webpage_url: url,
      };

      jsonLine(result);
    } catch (error) {
      jsonLine({ status: 'error', msg: error.message });
      process.exit(1);
    }
  });

// Download with JSON progress output (machine-readable for backend integration)
program
  .command('download-json <url>')
  .description('Download a video with JSON progress output (machine-readable)')
  .option('-o, --output <filename>', 'Output filename')
  .option('-d, --directory <path>', 'Output directory', './downloads')
  .option('-f, --format <quality>', 'Quality/format (e.g., 720p, 1080p, best, worst)', 'best')
  .option('-H, --header <header>', 'Add custom header', collectHeaders, [])
  .option('--no-ssl-verify', 'Disable SSL certificate verification')
  .option('--proxy <url>', 'Use proxy server')
  .option('--no-base-url', 'Do not add base domain to filename')
  .option('--cookies <file>', 'Cookie file in Netscape/Mozilla format')
  .option('--no-subtitle', 'Do not download/embed subtitles')
  .option('--sub-lang <lang>', 'Subtitle language code')
  .option('--sub-translate <lang>', 'Auto-translate subtitles to this language code')
  .option('--audio-lang <lang>', 'Audio language: specific code (en, de), "all" for all tracks (default: auto-detect)')
  .action(async (rawUrl, options) => {
    try {
      const url = cleanUrl(rawUrl);
      let cookies = null;
      if (options.cookies) {
        try {
          cookies = parseCookieFile(options.cookies);
        } catch (e) {
          jsonLine({ status: 'error', msg: `Failed to load cookies: ${e.message}` });
          process.exit(1);
        }
      }

      // Extract video info
      jsonLine({ status: 'extracting', msg: 'Extracting video information...' });

      let videoInfo, selectedFormat, formatPair = null;
      try {
        videoInfo = await extractVideoInfo(url, { cookies });
        jsonLine({ status: 'extracted', title: videoInfo.title, id: videoInfo.id || '' });

        const extractor = getExtractor(url);
        formatPair = extractor.selectFormatPair(videoInfo.formats, options.format, options.audioLang || null);
        if (formatPair) {
          selectedFormat = formatPair.video;
          // Detect HLS pairs — route to downloadHLS instead of DASH merge
          if (formatPair.video.protocol === 'hls' && formatPair.audio.protocol === 'hls') {
            formatPair._hlsVideoUrl = formatPair.video.url;
            if (formatPair.audioTracks && formatPair.audioTracks.length > 1) {
              formatPair._hlsAudioUrls = formatPair.audioTracks.map(a => ({
                url: a.url, lang: a.audioTrackLang || null, name: a.audioTrackName || null,
              }));
            } else {
              formatPair._hlsAudioUrl = formatPair.audio.url;
            }
          }
        } else {
          selectedFormat = extractor.selectFormat(videoInfo.formats, options.format);
        }
      } catch (extractError) {
        jsonLine({ status: 'extract_fallback', msg: 'Extraction failed, using direct URL' });
        selectedFormat = { url: url };
        videoInfo = { title: 'video' };
      }

      // Build filename
      const sanitize = (t) => t.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').trim() || 'video';
      const extractDomain = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };

      let filename;
      if (options.output) {
        filename = options.output;
      } else {
        const baseName = sanitize(videoInfo.title);
        const ext = (formatPair && formatPair._hlsAudioUrls) ? 'mkv' : (formatPair && formatPair._hlsVideoUrl) ? 'mp4' : formatPair ? formatPair.ext : (selectedFormat.ext || 'mp4');
        if (options.baseUrl !== false) {
          const domain = extractDomain(url);
          filename = domain ? `${baseName}-${domain}.${ext}` : `${baseName}.${ext}`;
        } else {
          filename = `${baseName}.${ext}`;
        }
      }

      jsonLine({ status: 'preparing', filename, msg: `Downloading: ${videoInfo.title}` });

      const downloader = new VideoDownloader({ downloadFolder: options.directory });

      // Throttle progress updates to max ~2/second
      let lastProgressTime = 0;
      const PROGRESS_THROTTLE = 500;

      downloader.on('start', ({ filepath }) => {
        jsonLine({ status: 'downloading', msg: `Saving to: ${filepath}`, filename: filepath });
      });

      downloader.on('progress', ({ downloaded, total, percent }) => {
        const now = Date.now();
        if (now - lastProgressTime >= PROGRESS_THROTTLE) {
          lastProgressTime = now;
          jsonLine({
            status: 'downloading',
            downloaded_bytes: downloaded,
            total_bytes: total,
            total_bytes_estimate: total,
            percent: percent,
            speed: null,
            eta: null,
          });
        }
      });

      downloader.on('merge-phase', ({ phase, label }) => {
        jsonLine({ status: 'postprocessing', msg: label, phase });
      });

      downloader.on('complete', ({ filepath, size }) => {
        jsonLine({ status: 'finished', filename: filepath, size });
      });

      downloader.on('error', ({ error }) => {
        jsonLine({ status: 'error', msg: error.message });
      });

      // Handle Cloudflare-protected downloads
      const cfFormat = formatPair ? formatPair.video : selectedFormat;
      if (cfFormat?.cfProtected) {
        jsonLine({ status: 'downloading', msg: 'CDN is Cloudflare-protected, using TLS impersonation' });
        try {
          const result = await cfProtectedDownload({
            url: cfFormat.url || selectedFormat.url,
            filepath: uniqueFilepath(path.join(options.directory || './downloads', filename)),
            headers: cfFormat.headers || {},
            timeout: 600000,
            onProgress: (downloaded, total) => {
              const now = Date.now();
              if (now - lastProgressTime >= PROGRESS_THROTTLE) {
                lastProgressTime = now;
                jsonLine({ status: 'downloading', downloaded_bytes: downloaded, total_bytes: total, percent: total > 0 ? (downloaded / total * 100) : 0 });
              }
            }
          });
          jsonLine({ status: 'finished', filename: result.filepath, size: result.size });
        } catch (cfErr) {
          jsonLine({ status: 'error', msg: cfErr.message });
          process.exit(1);
        }
        return;
      }

      // Resolve subtitles (shared by all download methods)
      const wantSubs = options.subtitle !== false;
      let subtitleDownloads = [];
      if (wantSubs && videoInfo.subtitles && Object.keys(videoInfo.subtitles).length > 0) {
        const subs = videoInfo.subtitles;
        const requestedLang = options.subLang || null;
        const translateLang = options.subTranslate || null;

        if (translateLang) {
          const firstTrack = Object.values(subs)[0];
          if (firstTrack.isTranslatable) {
            subtitleDownloads.push({ url: firstTrack.formats.vtt + '&tlang=' + translateLang, lang: translateLang, name: `${translateLang} (auto-translated)` });
          }
        } else if (requestedLang === 'all' || !requestedLang) {
          // Default: download all available subtitle tracks
          for (const [lang, sub] of Object.entries(subs)) {
            subtitleDownloads.push({ url: sub.formats.vtt, lang, name: sub.name });
          }
        } else if (requestedLang && subs[requestedLang]) {
          const sub = subs[requestedLang];
          subtitleDownloads.push({ url: sub.formats.vtt, lang: requestedLang, name: sub.name });
        } else {
          // Requested lang not found — still download all
          for (const [lang, sub] of Object.entries(subs)) {
            subtitleDownloads.push({ url: sub.formats.vtt, lang, name: sub.name });
          }
        }
      }

      // Choose download method: HLS pair, DASH merge, HLS single, or direct
      if (formatPair && formatPair._hlsVideoUrl) {
        // HLS pair: pass video + audio variant URLs as separate ffmpeg inputs
        const hlsOpts = {
          url: formatPair._hlsVideoUrl,
          filename, directory: options.directory,
          formatHeaders: formatPair.video.headers,
          rejectUnauthorized: options.sslVerify, cookies,
          subtitles: subtitleDownloads.length > 0 ? subtitleDownloads : undefined,
        };
        if (formatPair._hlsAudioUrls) {
          hlsOpts.hlsAudioUrls = formatPair._hlsAudioUrls;
        } else {
          hlsOpts.hlsAudioUrl = formatPair._hlsAudioUrl;
        }
        await downloader.downloadHLS(hlsOpts);
      } else if (formatPair) {
        const audioStreams = (formatPair.audioTracks || [formatPair.audio]).map(a => ({
          url: a.url, headers: a.headers, filesize: a.filesize || 0,
          lang: a.audioTrackLang || null, name: a.audioTrackName || null,
        }));
        await downloader.downloadAndMerge({
          videoStream: { url: formatPair.video.url, headers: formatPair.video.headers, filesize: formatPair.video.filesize || 0 },
          audioStreams,
          videoInfo: `${formatPair.video.quality} ${formatPair.video.vcodec || ''}`.trim(),
          audioInfo: audioStreams.map(a => `${a.lang || 'audio'}`).join('+'),
          filename, directory: options.directory, cookies, rejectUnauthorized: options.sslVerify, subtitles: subtitleDownloads,
        });
      } else if (selectedFormat.protocol === 'hls' || selectedFormat.ext === 'm3u8' || (selectedFormat.url && selectedFormat.url.includes('.m3u8'))) {
        const dlOpts = {
          url: selectedFormat.url, filename, directory: options.directory,
          headers: options.header, formatHeaders: selectedFormat.headers,
          rejectUnauthorized: options.sslVerify, cookies,
        };
        if (selectedFormat._hlsPlaylist) dlOpts.hlsPlaylist = selectedFormat._hlsPlaylist;
        await downloader.downloadHLS(dlOpts);
      } else {
        await downloader.download({
          url: selectedFormat.url, filename, directory: options.directory,
          headers: options.header, formatHeaders: selectedFormat.headers,
          rejectUnauthorized: options.sslVerify, cookies,
        });
      }
    } catch (error) {
      jsonLine({ status: 'error', msg: error.message });
      process.exit(1);
    }
  });

// Generate cookies from login credentials
program
  .command('generate-cookies')
  .description('Generate/refresh cookies by automating browser login (only if expired)')
  .option('--logins <file>', 'Login-details file (loginUrl::user::pass)', DEFAULT_LOGIN_FILE)
  .option('--cookies <file>', 'Output cookie file in Netscape format', DEFAULT_COOKIE_FILE)
  .option('--force', 'Force regeneration even if cookies are still valid')
  .option('--no-headless', 'Show the browser window (useful for debugging)')
  .option('--verbose', 'Show detailed progress information')
  .action(async (options) => {
    try {
      const loginFile = options.logins;
      const cookieFile = options.cookies;

      if (!fs.existsSync(path.resolve(loginFile))) {
        console.error(chalk.red(`\n✗ Login file not found: ${loginFile}`));
        console.error(chalk.gray('  Create a logins.txt file with one entry per line:'));
        console.error(chalk.gray('  loginPageUrl::username::password'));
        console.error(chalk.gray(`  Default location: ${DEFAULT_LOGIN_FILE}`));
        process.exit(1);
      }

      console.log(chalk.blue('🔐 Cookie Generator'));
      console.log(chalk.gray(`Login file:    ${loginFile}`));
      console.log(chalk.gray(`Cookie output: ${cookieFile}`));
      console.log();

      const result = await generateCookies(loginFile, cookieFile, {
        onlyIfExpired: !options.force,
        headless: options.headless !== false,
        verbose: !!options.verbose,
      });

      console.log();
      if (result.skipped > 0) {
        console.log(chalk.gray(`⏭ ${result.skipped}/${result.total} login(s) skipped (cookies still valid)`));
      }
      if (result.succeeded > 0) {
        console.log(chalk.green(`✓ ${result.succeeded}/${result.total} login(s) succeeded`));
        console.log(chalk.gray(`Cookies saved to: ${cookieFile}`));
      }
      if (result.failed > 0) {
        console.log(chalk.red(`✗ ${result.failed}/${result.total} login(s) failed`));
        process.exit(1);
      }
      if (result.succeeded === 0 && result.failed === 0 && result.skipped > 0) {
        console.log(chalk.green('✓ All cookies are still valid — nothing to do'));
      }
    } catch (error) {
      console.error(chalk.red(`\n✗ Cookie generation failed: ${error.message}`));
      process.exit(1);
    }
  });

// Browser login — open a visible browser for manual login, capture cookies
program
  .command('browser-login <url>')
  .description('Open a browser to log in manually and capture cookies (for sites like Brazzers)')
  .option('--cookies <file>', 'Output cookie file in Netscape format', DEFAULT_COOKIE_FILE)
  .option('--timeout <seconds>', 'Maximum time to wait for login (default: 300)', '300')
  .option('--verbose', 'Enable verbose/debug logging')
  .option('--wait', 'Keep browser open after login until you close it manually')
  .action(async (rawUrl, options) => {
    const verbose = !!options.verbose;
    const waitForClose = !!options.wait;
    const vlog = (...args) => { if (verbose) console.log(chalk.gray('[verbose]'), ...args); };
    try {
      const url = cleanUrl(rawUrl);
      const cookieFile = options.cookies;
      const timeout = parseInt(options.timeout) * 1000;

      console.log(chalk.blue('🌐 Browser Login'));
      console.log(chalk.gray(`URL: ${url}`));
      console.log(chalk.gray(`Cookie output: ${cookieFile}`));
      console.log();
      console.log(chalk.yellow('A browser window will open. Log in with your account,'));
      console.log(chalk.yellow('then the cookies will be captured automatically.'));
      console.log();

      // Dynamic import to avoid loading puppeteer for non-login commands
      let puppeteerCore, puppeteerExtra;
      let stealthOk = false;
      try {
        puppeteerCore = (await import('puppeteer-core')).default;
      } catch (e) {
        console.error(chalk.red(`puppeteer-core not available: ${e.message}`));
        process.exit(1);
      }
      try {
        const pExtra = (await import('puppeteer-extra')).default;
        const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
        pExtra.use(StealthPlugin());
        puppeteerExtra = pExtra;
        stealthOk = true;
      } catch {
        // Stealth plugin not available (e.g. in compiled SEA binary) — continue without it
        puppeteerExtra = null;
      }

      // Find browser
      const browserPaths = [
        process.env.PROGRAMFILES + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
        process.env.PROGRAMFILES + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env['PROGRAMFILES(X86)'] + '\\Microsoft\\Edge\\Application\\msedge.exe',
        process.env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/microsoft-edge',
      ];
      const browserPath = browserPaths.find(p => p && fs.existsSync(p));
      if (!browserPath) {
        console.error(chalk.red('No Chrome or Edge browser found.'));
        process.exit(1);
      }
      vlog(`Browser: ${browserPath}`);
      vlog(`Stealth plugin: ${stealthOk ? 'loaded' : 'not available'}`);

      const launchOpts = {
        executablePath: browserPath,
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--window-size=1280,900',
          '--start-maximized',
          '--disable-infobars',
          '--disable-dev-shm-usage',
          '--lang=en-US,en',
        ],
        defaultViewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
      };

      // Try puppeteer-extra first, fall back to plain puppeteer-core
      let browser;
      const launcher = stealthOk ? puppeteerExtra : puppeteerCore;
      try {
        browser = await launcher.launch(launchOpts);
      } catch (launchErr) {
        if (launcher !== puppeteerCore) {
          console.log(chalk.gray('Stealth plugin failed, falling back to plain browser...'));
          browser = await puppeteerCore.launch(launchOpts);
        } else {
          throw launchErr;
        }
      }

      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      // Determine the login URL from the provided URL
      const urlObj = new URL(url);
      const loginUrl = urlObj.hostname.includes('brazzers') || urlObj.hostname.includes('realitykings') ||
        urlObj.hostname.includes('mofos') || urlObj.hostname.includes('babes') ||
        urlObj.hostname.includes('twistys') || urlObj.hostname.includes('digitalplayground')
        ? `${urlObj.protocol}//${urlObj.hostname}/login`
        : url;

      console.log(chalk.blue(`Opening: ${loginUrl}`));
      vlog(`Navigating to: ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      vlog(`Page loaded, current URL: ${page.url()}`);

      // Wait for the access_token_ma cookie to appear (polling)
      console.log(chalk.yellow('Waiting for you to log in...'));
      const pollInterval = 2000;
      const start = Date.now();
      let authenticated = false;

      while (Date.now() - start < timeout) {
        const client = await page.createCDPSession();
        const { cookies: allCdpCookies } = await client.send('Network.getAllCookies');
        await client.detach();

        if (verbose) {
          const cookieNames = allCdpCookies.map(c => `${c.name}@${c.domain}`);
          const elapsed2 = Math.round((Date.now() - start) / 1000);
          vlog(`[${elapsed2}s] CDP returned ${allCdpCookies.length} cookies: ${cookieNames.join(', ')}`);
          vlog(`[${elapsed2}s] Current page URL: ${page.url()}`);
        }

        const authCookie = allCdpCookies.find(c => c.name === 'access_token_ma' && c.value);
        if (authCookie) {
          // Check it's not expired
          const now = Math.floor(Date.now() / 1000);
          if (!authCookie.expires || authCookie.expires <= 0 || authCookie.expires > now) {
            authenticated = true;
            console.log(chalk.green('✓ Login detected!'));
            vlog(`access_token_ma found on domain: ${authCookie.domain}`);
            vlog(`Cookie expires: ${authCookie.expires} (${new Date(authCookie.expires * 1000).toISOString()})`);
            vlog(`Cookie value length: ${authCookie.value.length}`);

            if (waitForClose) {
              // Keep browser open — wait for user to close it, refresh cookies periodically
              console.log(chalk.yellow('\n🔓 Browser will stay open. Browse, play videos, etc.'));
              console.log(chalk.yellow('   Close the browser when you are done.\n'));
              let lastCookies = allCdpCookies;
              let browserClosed = false;
              const refreshInterval = 5000;
              browser.on('disconnected', () => { browserClosed = true; });
              while (!browserClosed) {
                try {
                  const session = await page.createCDPSession();
                  const { cookies: refreshed } = await session.send('Network.getAllCookies');
                  await session.detach();
                  lastCookies = refreshed;
                  if (verbose) {
                    const elapsed3 = Math.round((Date.now() - start) / 1000);
                    const pageUrl = await page.url().catch(() => 'unknown');
                    vlog(`[${elapsed3}s] Refreshed ${refreshed.length} cookies | URL: ${pageUrl}`);
                  }
                } catch {
                  // browser likely closed
                  browserClosed = true;
                  break;
                }
                await new Promise(r => setTimeout(r, refreshInterval));
              }
              console.log(chalk.blue('\n🔒 Browser closed — saving cookies...'));
              // Use the last captured cookies as finalCookies for the save logic below
              // We need to jump to the save section with lastCookies
              const saveCookiesFromList = lastCookies;
              const loginHostname2 = urlObj.hostname;
              const baseDomain2 = loginHostname2.split('.').slice(-2).join('.');
              const relevantDomains2 = [baseDomain2, 'project1service.com', 'project1content.com'];
              vlog(`Filtering domains: ${relevantDomains2.join(', ')}`);
              const filtered2 = saveCookiesFromList.filter(c => {
                const domain = (c.domain || '').replace(/^\./, '');
                const matched = relevantDomains2.some(rd => domain === rd || domain.endsWith('.' + rd));
                if (verbose && !matched) vlog(`  SKIP: ${c.name}@${c.domain}`);
                return matched;
              });
              vlog(`Filtered to ${filtered2.length} relevant cookies`);
              if (verbose) {
                for (const c of filtered2) {
                  vlog(`  KEEP: ${c.name} | domain=${c.domain} | path=${c.path} | valueLen=${(c.value||'').length}`);
                }
              }
              const lines2 = ['# Netscape HTTP Cookie File', '# Generated by videodl browser-login', ''];
              for (const c of filtered2) {
                const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
                const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
                const cookiePath = c.path || '/';
                const secure = c.secure ? 'TRUE' : 'FALSE';
                const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires).toString() : '0';
                lines2.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
              }
              const normDom2 = d => (d || '').replace(/^\./, '').toLowerCase();
              if (fs.existsSync(path.resolve(cookieFile))) {
                vlog(`Merging with existing cookie file`);
                try {
                  const existingLines = fs.readFileSync(path.resolve(cookieFile), 'utf8').split('\n');
                  const newKeys = new Set(filtered2.map(c => `${normDom2(c.domain)}|${c.name}|${c.path || '/'}`));
                  let mk = 0, sk = 0;
                  for (const line of existingLines) {
                    if (line.startsWith('#') || !line.trim()) continue;
                    const parts = line.split('\t');
                    if (parts.length >= 7) {
                      const key = `${normDom2(parts[0])}|${parts[5]}|${parts[2]}`;
                      if (!newKeys.has(key)) { lines2.push(line); mk++; vlog(`  MERGE-KEEP: ${parts[5]}@${parts[0]}`); }
                      else { sk++; vlog(`  MERGE-SKIP: ${parts[5]}@${parts[0]}`); }
                    }
                  }
                  vlog(`Merge: kept ${mk}, skipped ${sk}`);
                } catch (e) { vlog(`Merge error: ${e.message}`); }
              }
              if (verbose) {
                const fl = lines2.filter(l => !l.startsWith('#') && l.trim());
                vlog(`Final: ${fl.length} cookies`);
              }
              const cookieDir2 = path.dirname(path.resolve(cookieFile));
              if (!fs.existsSync(cookieDir2)) fs.mkdirSync(cookieDir2, { recursive: true });
              fs.writeFileSync(path.resolve(cookieFile), lines2.join('\n') + '\n');
              console.log(chalk.green(`✓ Saved ${filtered2.length} cookies to ${cookieFile}`));
              // Decode JWT for info
              const ac2 = filtered2.find(c => c.name === 'access_token_ma');
              if (ac2) {
                try {
                  const payload = JSON.parse(Buffer.from(ac2.value.split('.')[1], 'base64url').toString());
                  const roles = payload.realm_access?.roles || [];
                  console.log(chalk.gray(`  Token expires: ${new Date(payload.exp * 1000).toISOString()}`));
                  console.log(chalk.gray(`  Roles: ${roles.join(', ')}`));
                  if (payload.email) console.log(chalk.gray(`  Email: ${payload.email}`));
                } catch { /* ignore */ }
              }
              authenticated = true;
              break;
            }

            // Wait a moment for all cookies to settle
            await new Promise(r => setTimeout(r, 2000));

            // Capture all relevant cookies
            const finalSession = await page.createCDPSession();
            const { cookies: finalCookies } = await finalSession.send('Network.getAllCookies');
            await finalSession.detach();
            vlog(`Final CDP cookie count: ${finalCookies.length}`);
            if (verbose) {
              for (const c of finalCookies) {
                vlog(`  ALL: ${c.name} | domain=${c.domain} | path=${c.path} | secure=${c.secure} | expires=${c.expires} | valueLen=${(c.value||'').length}`);
              }
            }
            const loginHostname = urlObj.hostname;
            const baseDomain = loginHostname.split('.').slice(-2).join('.');
            const relevantDomains = [baseDomain, 'project1service.com', 'project1content.com'];
            vlog(`Filtering domains: ${relevantDomains.join(', ')}`);
            vlog(`Base domain: ${baseDomain}, hostname: ${loginHostname}`);

            const filtered = finalCookies.filter(c => {
              const domain = (c.domain || '').replace(/^\./, '');
              const matched = relevantDomains.some(rd => domain === rd || domain.endsWith('.' + rd));
              if (verbose && !matched) {
                vlog(`  SKIP: ${c.name}@${c.domain} (not in relevant domains)`);
              }
              return matched;
            });
            vlog(`Filtered to ${filtered.length} relevant cookies`);
            if (verbose) {
              for (const c of filtered) {
                vlog(`  KEEP: ${c.name} | domain=${c.domain} | path=${c.path} | valueLen=${(c.value||'').length}`);
              }
            }

            // Convert to Netscape format and save
            const lines = ['# Netscape HTTP Cookie File', '# Generated by videodl browser-login', ''];
            for (const c of filtered) {
              const domain = c.domain.startsWith('.') ? c.domain : '.' + c.domain;
              const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
              const cookiePath = c.path || '/';
              const secure = c.secure ? 'TRUE' : 'FALSE';
              const expiry = c.expires && c.expires > 0 ? Math.floor(c.expires).toString() : '0';
              lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${c.name}\t${c.value}`);
            }

            // Merge with existing cookies — deduplicate by normalized domain+name+path
            const normalizeDomain = d => (d || '').replace(/^\./, '').toLowerCase();
            if (fs.existsSync(path.resolve(cookieFile))) {
              vlog(`Merging with existing cookie file: ${path.resolve(cookieFile)}`);
              try {
                const existingLines = fs.readFileSync(path.resolve(cookieFile), 'utf8').split('\n');
                const newKeys = new Set(filtered.map(c =>
                  `${normalizeDomain(c.domain)}|${c.name}|${c.path || '/'}`
                ));
                if (verbose) {
                  vlog(`New cookie keys:`);
                  for (const k of newKeys) vlog(`  ${k}`);
                }
                let mergedCount = 0, skippedCount = 0;
                for (const line of existingLines) {
                  if (line.startsWith('#') || !line.trim()) continue;
                  const parts = line.split('\t');
                  if (parts.length >= 7) {
                    const key = `${normalizeDomain(parts[0])}|${parts[5]}|${parts[2]}`;
                    if (!newKeys.has(key)) {
                      lines.push(line);
                      mergedCount++;
                      vlog(`  MERGE-KEEP: ${parts[5]}@${parts[0]} (key: ${key})`);
                    } else {
                      skippedCount++;
                      vlog(`  MERGE-SKIP (dup): ${parts[5]}@${parts[0]} (key: ${key})`);
                    }
                  }
                }
                vlog(`Merge: kept ${mergedCount} existing, skipped ${skippedCount} duplicates`);
              } catch (mergeErr) { vlog(`Merge error: ${mergeErr.message}`); }
            } else {
              vlog(`No existing cookie file at: ${path.resolve(cookieFile)}`);
            }

            // Compute final cookie header size for diagnostics
            if (verbose) {
              const finalCookieLines = lines.filter(l => !l.startsWith('#') && l.trim());
              const headerSize = finalCookieLines.map(l => {
                const p = l.split('\t');
                return p.length >= 7 ? `${p[5]}=${p[6]}` : '';
              }).join('; ').length;
              vlog(`Final cookie file: ${finalCookieLines.length} cookies, estimated Cookie header: ${headerSize} bytes`);
            }

            const cookieDir = path.dirname(path.resolve(cookieFile));
            if (!fs.existsSync(cookieDir)) fs.mkdirSync(cookieDir, { recursive: true });
            fs.writeFileSync(path.resolve(cookieFile), lines.join('\n') + '\n');
            vlog(`Cookie file written to: ${path.resolve(cookieFile)}`);

            console.log(chalk.green(`✓ Saved ${filtered.length} cookies to ${cookieFile}`));

            // Decode JWT for info
            const accessCookie = filtered.find(c => c.name === 'access_token_ma');
            if (accessCookie) {
              try {
                const payload = JSON.parse(Buffer.from(accessCookie.value.split('.')[1], 'base64url').toString());
                const roles = payload.realm_access?.roles || [];
                const expDate = new Date(payload.exp * 1000);
                console.log(chalk.gray(`  Token expires: ${expDate.toISOString()}`));
                console.log(chalk.gray(`  Roles: ${roles.join(', ')}`));
                if (payload.email) console.log(chalk.gray(`  Email: ${payload.email}`));
                const hasSubscription = roles.some(r =>
                  r.includes('subscriber') || r.includes('member') || r.includes('premium') || r.includes('paid')
                );
                if (!hasSubscription && roles.length <= 3) {
                  console.log(chalk.yellow('\n⚠ Warning: No subscription role detected in JWT.'));
                  console.log(chalk.yellow('  This account may only have access to trailers.'));
                  console.log(chalk.yellow('  Make sure you log in with a subscribed account.'));
                }
              } catch { /* ignore decode errors */ }
            }
            break;
          }
        }

        const elapsed = Math.round((Date.now() - start) / 1000);
        if (elapsed % 30 === 0 && elapsed > 0) {
          console.log(chalk.gray(`  Still waiting... (${elapsed}s / ${Math.round(timeout / 1000)}s)`));
        }

        await new Promise(r => setTimeout(r, pollInterval));
      }

      if (!authenticated) {
        console.error(chalk.red(`\n✗ Login timed out after ${Math.round(timeout / 1000)}s.`));
        console.error(chalk.gray('  Try again with a longer --timeout.'));
      }

      if (!waitForClose) {
        try { await browser.close(); } catch { try { browser.process()?.kill('SIGKILL'); } catch {} }
      }
    } catch (error) {
      console.error(chalk.red(`\n✗ Browser login failed: ${error.message}`));
      process.exit(1);
    }
  });

// Strip Node.js runtime flags that Commander doesn't understand.
// The SEA binary wrapper prints a warning suggesting --trace-warnings which
// users naturally try to pass, but it's a Node.js flag, not a CLI option.
const NODE_FLAGS = ['--trace-warnings', '--trace-deprecation', '--pending-deprecation'];
process.argv = process.argv.filter(a => !NODE_FLAGS.includes(a));

// If the first non-option argument looks like a URL (no known subcommand),
// treat it as a shorthand for "download <url>" so users can just run:
//   videodl "https://example.com/video"
// instead of:
//   videodl download "https://example.com/video"
const knownCommands = program.commands.map(c => c.name());
const args = process.argv.slice(2);
const firstArg = args.find(a => !a.startsWith('-'));
if (firstArg && !knownCommands.includes(firstArg) && /^https?:\/\//i.test(firstArg)) {
  process.argv.splice(2, 0, 'download');
}

// Parse command
program.parse();
