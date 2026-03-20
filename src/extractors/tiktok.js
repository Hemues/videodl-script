/**
 * TikTok Extractor
 * Extracts video URLs from tiktok.com
 *
 * Supports:
 *   - tiktok.com/@{user}/video/{id}
 *   - vm.tiktok.com/{shortcode}
 *
 * Flow:
 *   1. Extract or resolve video ID
 *   2. Fetch the page HTML and extract SIGI_STATE or __UNIVERSAL_DATA_FOR_REHYDRATION__
 *   3. Parse video URLs from the JSON data
 *   4. Also try the oEmbed API for metadata
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class TikTokExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'TikTok';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|m|vm)\.)?tiktok\.com\//i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Resolve vm.tiktok.com shortlinks
    let resolvedUrl = url;
    if (/vm\.tiktok\.com/i.test(url)) {
      console.log(`[${this.name}] Resolving shortlink...`);
      const resp = await got(url, {
        headers: { 'User-Agent': USER_AGENT },
        followRedirect: false,
        timeout: { request: 15000 },
      });
      if (resp.headers.location) {
        resolvedUrl = resp.headers.location;
        console.log(`[${this.name}] Resolved to: ${resolvedUrl}`);
      }
    }

    // Extract video ID
    const idMatch = resolvedUrl.match(/\/video\/(\d+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Try oEmbed API first for metadata
    let title = `TikTok ${videoId}`;
    let uploader = '';
    let thumbnail = '';

    try {
      const oembedUrl = `https://www.tiktok.com/oembed?url=${encodeURIComponent(resolvedUrl)}`;
      const oembedResp = await got(oembedUrl, {
        headers: { 'User-Agent': USER_AGENT },
        responseType: 'json',
        timeout: { request: 15000 },
      });
      if (oembedResp.body) {
        title = oembedResp.body.title || title;
        uploader = oembedResp.body.author_name || '';
        thumbnail = oembedResp.body.thumbnail_url || '';
      }
    } catch (e) {
      console.log(`[${this.name}] OEmbed failed: ${e.message}`);
    }

    console.log(`[${this.name}] Title: ${title.substring(0, 80)}`);
    if (uploader) console.log(`[${this.name}] Uploader: ${uploader}`);

    // Fetch the page and look for video data
    console.log(`[${this.name}] Fetching video page...`);
    const response = await got(resolvedUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.cookies ? { 'Cookie': options.cookies } : {}),
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });
    const html = response.body;

    const formats = [];

    // Try __UNIVERSAL_DATA_FOR_REHYDRATION__ (newer TikTok pages)
    const universalMatch = html.match(/<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>(\{[\s\S]*?\})<\/script>/);
    if (universalMatch) {
      try {
        const universalData = JSON.parse(universalMatch[1]);
        const defaultScope = universalData['__DEFAULT_SCOPE__'] || {};
        const videoDetail = defaultScope['webapp.video-detail'] || {};
        const itemStruct = videoDetail.itemInfo?.itemStruct || {};
        const video = itemStruct.video || {};

        if (video.downloadAddr) {
          formats.push(this._makeFormat(video.downloadAddr, video, 'download'));
        }
        if (video.playAddr) {
          formats.push(this._makeFormat(video.playAddr, video, 'play'));
        }
        if (video.bitrateInfo) {
          for (const br of video.bitrateInfo) {
            if (br.PlayAddr?.UrlList?.length) {
              formats.push(this._makeFormat(br.PlayAddr.UrlList[0], {
                height: br.PlayAddr.Height || video.height,
                width: br.PlayAddr.Width || video.width,
              }, `bitrate-${br.QualityType || 'unknown'}`));
            }
          }
        }

        // Update metadata
        if (itemStruct.desc) title = itemStruct.desc;
        if (itemStruct.author?.nickname) uploader = itemStruct.author.nickname;
      } catch (e) {
        console.log(`[${this.name}] Universal data parse error: ${e.message}`);
      }
    }

    // Try SIGI_STATE (older TikTok pages)
    if (formats.length === 0) {
      const sigiMatch = html.match(/<script[^>]+id="SIGI_STATE"[^>]*>(\{[\s\S]*?\})<\/script>/);
      if (sigiMatch) {
        try {
          const sigiData = JSON.parse(sigiMatch[1]);
          const itemModule = sigiData.ItemModule || {};
          for (const [key, item] of Object.entries(itemModule)) {
            const video = item.video || {};
            if (video.downloadAddr) {
              formats.push(this._makeFormat(video.downloadAddr, video, 'download'));
            }
            if (video.playAddr) {
              formats.push(this._makeFormat(video.playAddr, video, 'play'));
            }
          }
        } catch (e) {
          console.log(`[${this.name}] SIGI_STATE parse error: ${e.message}`);
        }
      }
    }

    // Fallback: try og:video meta tag
    if (formats.length === 0) {
      const ogVideo = html.match(/<meta[^>]+property="og:video(?::url|:secure_url)?"[^>]+content="([^"]+)"/i) ||
                      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:video(?::url|:secure_url)?"/i);
      if (ogVideo) {
        formats.push({
          url: ogVideo[1].replace(/&amp;/g, '&'),
          ext: 'mp4',
          height: 1080,
          width: 608,
          quality: '1080p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'og-video',
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('Could not extract video URL from TikTok page. TikTok may require cookies for this video.');
    }

    // Deduplicate by URL
    const seen = new Set();
    const uniqueFormats = formats.filter(f => {
      const key = f.url.split('?')[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    uniqueFormats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${uniqueFormats.length} format(s)`);

    return {
      id: videoId,
      title: title.substring(0, 200),
      formats: uniqueFormats,
      thumbnail,
      uploader,
      extractor: this.name,
      url: resolvedUrl,
    };
  }

  _makeFormat(urlOrObj, video, tag) {
    let videoUrl;
    if (typeof urlOrObj === 'string') {
      videoUrl = urlOrObj;
    } else if (Array.isArray(urlOrObj)) {
      videoUrl = urlOrObj[0];
    } else if (urlOrObj?.UrlList) {
      videoUrl = urlOrObj.UrlList[0];
    } else {
      videoUrl = String(urlOrObj);
    }

    const height = video.height || 1080;
    const width = video.width || 608;

    return {
      url: videoUrl,
      ext: 'mp4',
      height: typeof height === 'number' ? height : parseInt(height) || 1080,
      width: typeof width === 'number' ? width : parseInt(width) || 608,
      quality: `${height}p`,
      hasVideo: true,
      hasAudio: true,
      format_id: `mp4-${tag}`,
      headers: {
        'Referer': 'https://www.tiktok.com/',
        'User-Agent': USER_AGENT,
      },
    };
  }
}

export default TikTokExtractor;
