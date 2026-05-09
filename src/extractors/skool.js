/**
 * Skool Extractor
 * Extracts classroom lesson metadata and attached video URLs from skool.com
 *
 * For classroom posts, Skool commonly embeds attachment metadata in the page
 * HTML. The video attachment is often a YouTube URL, so this extractor parses
 * the attached URL and delegates format extraction to the existing YouTube
 * extractor while preserving the Skool lesson title.
 */

import { BaseExtractor } from './base.js';
import got from 'got';
import { YouTubeExtractor } from './youtube.js';
import { buildCookieHeader } from '../cookies.js';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class SkoolExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Skool';
    this.youtubeExtractor = new YouTubeExtractor();
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?skool\.com\/[^?#]+\/classroom\//i.test(url);
  }

  _extractTitle(html, url) {
    const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i)
      || html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);

    let title = titleMatch ? titleMatch[1] : null;
    if (!title) return `Skool_${url.split('/').pop() || 'classroom'}`;

    return title
      .replace(/\s*[\-–—]\s*Moziterem\s*·\s*EOS Club$/i, '')
      .replace(/\s*[\-–—]\s*EOS Club$/i, '')
      .replace(/\s*·\s*EOS Club$/i, '')
      .trim();
  }

  _extractAttachmentVideoUrl(html) {
    const patterns = [
      /video_url\\":\\"(https?:\\\/\\\/[^\\"]+)\\"/i,
      /videoUrl\\":\\"(https?:\\\/\\\/[^\\"]+)\\"/i,
      /video_url\"?\s*:\s*\"([^\"]+)\"/i,
      /videoUrl\"?\s*:\s*\"([^\"]+)\"/i,
      /https?:\/\/www\.youtube\.com\/watch\?v=[^\"'\s]+/i,
      /https?:\/\/youtu\.be\/[A-Za-z0-9_-]+/i,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        return match[1].replace(/\\\//g, '/').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
      }
      if (match && match[0]) {
        return match[0].replace(/&amp;/g, '&');
      }
    }

    return null;
  }

  _extractDuration(html) {
    const msMatch = html.match(/video_length_ms\\":(\d+)/i) || html.match(/video_length_ms\"?\s*:\s*(\d+)/i);
    if (msMatch) {
      return Math.round(parseInt(msMatch[1], 10) / 1000);
    }
    return 0;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const cookieHeader = options.cookies ? buildCookieHeader(options.cookies, url) : '';

    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });

    const html = response.body;
    const title = this._extractTitle(html, url);
    const duration = this._extractDuration(html);
    const attachmentVideoUrl = this._extractAttachmentVideoUrl(html);

    if (!attachmentVideoUrl) {
      throw new Error('No Skool video attachment URL found');
    }

    console.log(`[${this.name}] Title: ${title}`);
    console.log(`[${this.name}] Attachment URL: ${attachmentVideoUrl}`);

    const attachedInfo = await this.youtubeExtractor.extract(attachmentVideoUrl, options);

    return {
      ...attachedInfo,
      id: url.match(/\/classroom\/([a-zA-Z0-9]+)/)?.[1] || attachedInfo.id,
      title,
      duration: duration || attachedInfo.duration,
      extractor: this.name,
      url,
    };
  }
}

export default SkoolExtractor;