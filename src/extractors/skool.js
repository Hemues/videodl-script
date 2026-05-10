/**
 * Skool Extractor
 * Extracts videos from skool.com
 *
 * Skool is a Next.js SPA. Page metadata (title, video) is embedded in the
 * __NEXT_DATA__ JSON blob of the server-rendered HTML.  When the user is
 * authenticated (cookies forwarded from the browser extension) the server
 * returns the full title and the Mux video token required for playback.
 *
 * Supported page types:
 *  1. Classroom lesson — `skool.com/<community>/classroom/<id>?md=<lesson_id>`
 *     pageProps.course (course tree) + pageProps.selectedModule + pageProps.video
 *  2. Community post — `skool.com/<community>/<post-slug>`
 *     pageProps.postTree.post.metadata.title + pageProps.postTree.videos[0]
 *
 * Video types handled (in priority order):
 *  1. Mux video — embedded directly in the lesson/post
 *  2. YouTube fallback — attached YouTube URL in content (rare)
 *
 * Authentication note: the Skool session cookie (client_id) is scoped to the
 * parent domain .skool.com.  The extension must use chrome.cookies.getAll({url})
 * (not {domain}) to capture it, otherwise the title and video come back
 * unauthenticated ("EOS Club" fallback).
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
    return /(?:^|\/\/)(?:www\.)?skool\.com\//i.test(url);
  }

  /** Parse Skool's __NEXT_DATA__ JSON blob from the page HTML. */
  _parseNextData(html) {
    const match = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

  /**
   * Walk the course tree and find the selected lesson by id, returning the
   * breadcrumb of titles from the course root down to (and including) the
   * lesson.  Returns null if not found.
   */
  _findLessonPath(node, targetId, parents = []) {
    if (!node || typeof node !== 'object') return null;
    const course = node.course || node;
    const id = course?.id;
    const title = course?.metadata?.title;
    const newParents = title ? [...parents, title] : parents;
    if (id && id === targetId) return newParents;
    const children = node.children || course?.children;
    if (Array.isArray(children)) {
      for (const child of children) {
        const found = this._findLessonPath(child, targetId, newParents);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Extract the clean lesson title from parsed __NEXT_DATA__.
   *
   * Strategy:
   *  1. Use `selectedModule` (the active lesson id) and walk the course tree
   *     to build a breadcrumb [courseRoot, section?, ..., lesson].  Join all
   *     parts with " - " so the resulting title is e.g.:
   *       "Moziterem - 2018-as Mesterkurzus novemberi modul összefoglaló"
   *       "Leader-Follow Modell - LFM Bevezető előadás"
   *       "Leader-Follow Modell - Katasztrófapontok - 1. Találkozás - Bemutatkozás"
   *     Replace any `/` in titles with ` - ` (filesystem-unsafe and the
   *     downstream sanitizer would otherwise strip the slash entirely).
   *  2. Fall back to the SSR page title, stripping Skool's "· Community" suffix.
   */
  _titleFromNextData(pageProps) {
    const courseTree =
      pageProps?.course || pageProps?.renderData?.course;
    const selectedId =
      pageProps?.selectedModule || pageProps?.renderData?.selectedModule;
    if (courseTree && selectedId) {
      const path = this._findLessonPath(courseTree, selectedId);
      if (path && path.length) {
        // Include the course-root (classroom name) through to the lesson
        const joined = path.join(' - ');
        const safe = joined.replace(/\s*\/\s*/g, ' - ').trim();
        if (safe) return safe;
      }
    }
    // Fall back to the SSR page title, stripping Skool's suffix
    const pageTitle = pageProps?.settings?.pageTitle || pageProps?.renderData?.settings?.pageTitle;
    if (pageTitle && typeof pageTitle === 'string') {
      return pageTitle
        .replace(/\s*·\s*[^·]+$/i, '')
        .replace(/\s*[\-–—]\s*[^\-–—]+$/i, '')
        .replace(/\s*\/\s*/g, ' - ')
        .trim();
    }
    return null;
  }

  /** Extract a Mux video object from __NEXT_DATA__ if present.
   *  Looks at the well-known classroom location (pageProps.video) first,
   *  then the post location (pageProps.postTree.videos[0]).
   */
  _muxFromNextData(pageProps) {
    // Classroom lesson
    const classroomVideo = pageProps?.video || pageProps?.renderData?.video;
    if (classroomVideo?.playbackId && classroomVideo?.playbackToken) {
      return classroomVideo;
    }
    // Community post
    const postVideos =
      pageProps?.postTree?.videos
      || pageProps?.renderData?.postTree?.videos
      || pageProps?.settings?.postMeta?.postTree?.videos;
    if (Array.isArray(postVideos)) {
      const v = postVideos.find(x => x?.playbackId && x?.playbackToken);
      if (v) return v;
    }
    return null;
  }

  /** Extract a clean title for a community post page. */
  _titleFromPostData(pageProps) {
    const post =
      pageProps?.postTree?.post
      || pageProps?.renderData?.postTree?.post
      || pageProps?.settings?.postMeta?.postTree?.post;
    const t = post?.metadata?.title;
    if (typeof t === 'string' && t.trim()) {
      return t.replace(/\s*\/\s*/g, ' - ').trim();
    }
    return null;
  }

  /** Fallback: extract a YouTube URL from the raw page HTML (legacy). */
  _extractYouTubeUrl(html) {
    // Look inside lesson-level content JSON strings, not lpAttachmentsData
    // (lpAttachmentsData holds the community landing-page promo video, not the lesson).
    const patterns = [
      /https?:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}/,
      /https?:\/\/youtu\.be\/[A-Za-z0-9_-]{11}/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return m[0].replace(/&amp;/g, '&');
    }
    return null;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const isClassroom = /\/classroom\//i.test(url);
    const cookieHeader = options.cookies ? buildCookieHeader(options.cookies, url) : '';

    const response = await got(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.5',
        ...(cookieHeader ? { 'Cookie': cookieHeader } : {}),
      },
      timeout: { request: 30000 },
      followRedirect: true,
    });

    const html = response.body;
    const lessonId = url.match(/[?&]md=([a-zA-Z0-9]+)/)?.[1]
      || url.match(/\/classroom\/([a-zA-Z0-9]+)/)?.[1];
    const postSlug = !isClassroom
      ? url.match(/skool\.com\/[^/]+\/([^/?#]+)/i)?.[1]
      : null;

    // --- Parse __NEXT_DATA__ ---
    const nextData = this._parseNextData(html);
    const pageProps = nextData?.props?.pageProps || {};

    // --- Title ---
    // Classroom path: walk the course tree using selectedModule.
    // Post path: read postTree.post.metadata.title.
    const title =
      (isClassroom
        ? this._titleFromNextData(pageProps)
        : (this._titleFromPostData(pageProps) || this._titleFromNextData(pageProps)))
      || html.match(/<title>\s*([^<]+?)\s*<\/title>/i)?.[1]?.replace(/\s*[\-–—][^<]+$/, '').trim()
      || `Skool_${lessonId || postSlug || 'lesson'}`;

    console.log(`[${this.name}] Title: ${title}`);

    // --- Primary: Mux video ---
    const muxVideo = this._muxFromNextData(pageProps);
    if (muxVideo) {
      const muxUrl = `https://stream.mux.com/${muxVideo.playbackId}.m3u8?token=${muxVideo.playbackToken}`;
      const duration = muxVideo.duration ? Math.round(muxVideo.duration / 1000) : 0;

      console.log(`[${this.name}] Mux video: ${muxVideo.playbackId}, duration: ${duration}s`);

      // Mux signed playback URLs enforce a Referer/Origin allow-list (Skool's
      // playback restriction).  Without these headers ffmpeg gets HTTP 403.
      const muxHeaders = {
        'Referer': 'https://www.skool.com/',
        'Origin': 'https://www.skool.com',
        'User-Agent': USER_AGENT,
      };

      return {
        id: lessonId || postSlug || muxVideo.id,
        title,
        url,
        formats: [
          {
            quality: 'best',
            url: muxUrl,
            ext: 'mp4',
            height: null,
            isHLS: true,
            masterPlaylistUrl: muxUrl,
            label: 'best',
            headers: muxHeaders,
          }
        ],
        duration,
        extractor: this.name,
        headers: muxHeaders,
      };
    }

    // --- Fallback: YouTube URL in lesson/post content ---
    const ytUrl = this._extractYouTubeUrl(html);
    if (!ytUrl) {
      throw new Error(
        `No video found in this Skool ${isClassroom ? 'lesson' : 'post'}. ` +
        'The page may require authentication — make sure you are logged into ' +
        'Skool in your browser when using the browser extension to send URLs.'
      );
    }

    console.log(`[${this.name}] YouTube fallback: ${ytUrl}`);
    const attachedInfo = await this.youtubeExtractor.extract(ytUrl, options);

    return {
      ...attachedInfo,
      id: lessonId || postSlug || attachedInfo.id,
      title,
      duration: attachedInfo.duration,
      extractor: this.name,
      url,
    };
  }
}

export default SkoolExtractor;
