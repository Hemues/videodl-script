/**
 * Indavideo Extractor
 * Extracts video URLs from indavideo.hu (Hungarian video platform)
 *
 * Supports all subdomains: indavideo.hu, film.indavideo.hu, index.indavideo.hu,
 * auto.indavideo.hu, palyazat.indavideo.hu, embed.indavideo.hu, etc.
 *
 * Flow:
 *   1. Fetch video page → find embed hash from embed.indavideo.hu/player/video/{hash}
 *   2. Fetch embed page → establish player session (cookies)
 *   3. Call JSON API with session: amfphp.indavideo.hu/SYm0json.php/player.playerHandler.getVideoData/{hash}/
 *   4. API returns video_files (MP4 URLs) + filesh (height→token map)
 *   5. Build download URLs: clean malformed query string + append token
 *   6. Pass session cookies with the format for CDN authentication
 *
 * The CDN (index1/2/3-hu.indavideo.hu) validates tokens and may require
 * proper session state from the embed player page.
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import { CookieJar } from 'tough-cookie';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class IndavideoExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Indavideo';
  }

  static canHandle(url) {
    return /indavideo\.hu/i.test(url);
  }

  /**
   * Build a clean video URL with the auth token.
   * Raw URLs from the API often have malformed query strings like ??& 
   * e.g. "https://index1-hu.../video.720.mp4??&channel=main&zone=hu&zone=upc"
   */
  _buildVideoUrl(rawUrl, token) {
    let urlStr = rawUrl;
    // Ensure https
    if (urlStr.startsWith('//')) urlStr = 'https:' + urlStr;
    // Fix double ?? → single ? before parsing
    urlStr = urlStr.replace(/\?\?/g, '?');
    // Fix leading ?& → ?
    urlStr = urlStr.replace(/\?&/, '?');

    const urlObj = new URL(urlStr);
    urlObj.searchParams.set('token', token);
    return urlObj.toString();
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Shared cookie jar for all requests in this extraction
    const cookieJar = new CookieJar();
    const baseHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };

    // Step 1: Get video hash from URL or page
    let videoHash = null;
    let pageReferer = url;

    // Check if this IS an embed URL already
    const embedMatch = url.match(/embed\.indavideo\.hu\/player\/video\/([a-f0-9]+)/);
    if (embedMatch) {
      videoHash = embedMatch[1];
    } else {
      // Fetch the video page and find the embed hash
      const resp = await got(url, {
        headers: baseHeaders,
        followRedirect: true,
        maxRedirects: 5,
        timeout: { request: 30000 },
        cookieJar,
      });
      pageReferer = resp.url; // use final (possibly redirected) URL

      const hashMatch = resp.body.match(/indavideo\.hu\/player\/video\/([a-f0-9]+)/) ||
                         resp.body.match(/vID=([a-f0-9]+)/);
      if (hashMatch) {
        videoHash = hashMatch[1];
      }

      if (!videoHash) {
        throw new Error('Could not find video hash on page');
      }
    }

    console.log(`[${this.name}] Video hash: ${videoHash}`);

    // Step 2: Fetch embed page to establish proper player session
    const embedUrl = `https://embed.indavideo.hu/player/video/${videoHash}/`;
    try {
      await got(embedUrl, {
        headers: {
          ...baseHeaders,
          'Referer': pageReferer,
        },
        followRedirect: true,
        timeout: { request: 15000 },
        cookieJar,
      });
      console.log(`[${this.name}] Embed session established`);
    } catch (e) {
      // Non-fatal: continue even if embed page fails
      console.log(`[${this.name}] Embed page fetch failed (non-fatal): ${e.message}`);
    }

    // Step 3: Call the JSON API with shared cookies
    const ts = Math.floor(Date.now() / 1000);
    const apiUrl = `https://amfphp.indavideo.hu/SYm0json.php/player.playerHandler.getVideoData/${videoHash}/`;

    console.log(`[${this.name}] Fetching video data...`);
    const apiResp = await got(apiUrl, {
      searchParams: { _: ts },
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': embedUrl,
      },
      responseType: 'json',
      timeout: { request: 20000 },
      cookieJar,
    });

    const data = apiResp.body?.data;
    if (!data) {
      throw new Error('No video data returned from API');
    }

    const title = data.title || 'Indavideo Video';
    console.log(`[${this.name}] Title: ${title}`);

    // Step 4: Build format list from video_files + filesh tokens
    const videoFiles = [];
    if (Array.isArray(data.video_files)) {
      videoFiles.push(...data.video_files);
    } else if (data.video_files && typeof data.video_files === 'object') {
      videoFiles.push(...Object.values(data.video_files));
    }

    // Deduplicate video URLs (API sometimes returns duplicates)
    const uniqueFiles = [...new Set(videoFiles)];

    const filesh = data.filesh || {};

    // Collect session cookies to forward to the downloader
    let sessionCookieHeader = '';
    try {
      const cdnSample = uniqueFiles[0] || 'https://index1-hu.indavideo.hu/';
      let cookieUrl = cdnSample.startsWith('//') ? 'https:' + cdnSample : cdnSample;
      cookieUrl = cookieUrl.replace(/\?\?/, '?');
      const cookies = await cookieJar.getCookies(cookieUrl);
      sessionCookieHeader = cookies.map(c => `${c.key}=${c.value}`).join('; ');
    } catch {
      // Cookie extraction failed — continue without
    }

    const formats = [];

    for (const videoUrl of uniqueFiles) {
      // Extract height from URL pattern: .360.mp4, .720.mp4, etc.
      const heightMatch = videoUrl.match(/\.(\d{3,4})\.mp4(?:\?|$)/);
      let height = heightMatch ? parseInt(heightMatch[1]) : null;

      // Fallback: if only one token and no height, use that
      if (!height && Object.keys(filesh).length === 1) {
        height = parseInt(Object.keys(filesh)[0]);
      }

      // Find matching token
      const token = height ? filesh[String(height)] : null;
      if (!token) {
        console.log(`[${this.name}] Skipping URL (no token for height ${height}): ${videoUrl.substring(0, 60)}...`);
        continue;
      }

      // Build final URL with token
      const finalUrl = this._buildVideoUrl(videoUrl, token);

      // Build per-format download headers
      const formatHeaders = {
        'User-Agent': USER_AGENT,
        'Referer': embedUrl,
      };
      if (sessionCookieHeader) {
        formatHeaders['Cookie'] = sessionCookieHeader;
      }

      formats.push({
        url: finalUrl,
        ext: 'mp4',
        height: height || 0,
        width: height ? Math.round(height * (data.aspect || 16 / 9)) : 0,
        quality: height ? `${height}p` : 'unknown',
        format_id: height ? `mp4-${height}p` : 'mp4',
        hasVideo: true,
        hasAudio: true,
        protocol: 'https',
        headers: formatHeaders,
      });
    }

    // Sort by height descending
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable formats found');
    }

    // Build thumbnail URLs
    const thumbnails = (data.thumbnails || []).map(t =>
      t.startsWith('//') ? 'https:' + t : t
    );

    return {
      title,
      formats,
      extractor: this.name,
      url,
      videoId: data.id || videoHash,
      duration: data.length ? parseInt(data.length) : null,
      description: data.description || null,
      uploader: data.user_name || null,
      uploaderId: data.user_id || null,
      thumbnail: thumbnails[0] || null,
      ageLimit: data.age_limit != null ? parseInt(data.age_limit) : null,
    };
  }
}
