/**
 * NoodleMagazine Extractor
 * Extracts video URLs from noodlemagazine.com
 *
 * Flow:
 *   1. Fetch the watch page via cycletls (TLS fingerprint to bypass 403).
 *   2. Look for the embedded player iframe or inline video sources.
 *   3. If iframe found, fetch the player/embed page.
 *   4. Extract video source URLs from the player page (JSON config,
 *      <source> tags, or JS variables).
 *
 * URL formats:
 *   Watch:   https://noodlemagazine.com/watch/-OWNERID_VIDEOID
 *   Listing: https://noodlemagazine.com/video/QUERY?p=N
 *
 * Listing pages return a playlist of /watch/ URLs found on the page.
 */

import { BaseExtractor } from './base.js';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME_JA3 =
  '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-27-17513,29-23-24,0';

export class NoodleMagazineExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'NoodleMagazine';
  }

  static canHandle(url) {
    return /noodlemagazine\.com\/(?:watch|video)\//i.test(url);
  }

  static _isListingUrl(url) {
    return /noodlemagazine\.com\/video\//i.test(url);
  }

  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
  }

  /**
   * Try to extract video sources from HTML (player page or main page).
   * Looks for common patterns: <source> tags, JSON configs, JS variables.
   */
  _extractSourcesFromHtml(html, referer) {
    const formats = [];
    const seen = new Set();

    // Pattern 1: <source src="..." type="video/mp4" label="..." res="...">
    const sourceTagRe = /<source\s+[^>]*src="([^"]+)"[^>]*(?:type="video\/(?:mp4|webm)")?[^>]*(?:label="([^"]*)")?[^>]*(?:res="(\d+)")?[^>]*\/?>/gi;
    let m;
    while ((m = sourceTagRe.exec(html)) !== null) {
      const url = m[1].replace(/&amp;/g, '&');
      if (seen.has(url) || url.startsWith('/vtt') || !url.startsWith('http')) continue;
      seen.add(url);
      const label = m[2] || '';
      const height = m[3] ? parseInt(m[3]) : (parseInt(label) || 0);
      const ext = url.includes('.webm') ? 'webm' : 'mp4';
      formats.push(this._makeFormat(url, height, ext, referer));
    }

    // Pattern 2: JSON with "url" and "label"/"quality" keys (e.g. video_balancer)
    const jsonArrayRe = /\[\s*\{[^[\]]*"(?:url|file)"\s*:\s*"[^"]+"/g;
    const jsonMatches = html.match(jsonArrayRe);
    if (jsonMatches) {
      for (const rawMatch of jsonMatches) {
        // Find the complete array
        const startIdx = html.indexOf(rawMatch);
        let depth = 0, endIdx = startIdx;
        for (let i = startIdx; i < html.length; i++) {
          if (html[i] === '[') depth++;
          else if (html[i] === ']') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
        }
        try {
          const arr = JSON.parse(html.substring(startIdx, endIdx));
          for (const item of arr) {
            const url = item.url || item.file;
            if (!url || seen.has(url) || url.startsWith('/vtt') || !url.startsWith('http')) continue;
            seen.add(url);
            const height = parseInt(item.label || item.quality || item.res) || 0;
            const ext = url.includes('.webm') ? 'webm' : 'mp4';
            formats.push(this._makeFormat(url, height, ext, referer));
          }
        } catch { /* not valid JSON, skip */ }
      }
    }

    // Pattern 3: "video_url":"..." or video_url = "..."
    const videoUrlRe = /["']?(?:video_url|videoUrl|video_src|videoSrc|mp4|source)["']?\s*[:=]\s*["']([^"']+\.(?:mp4|webm)[^"']*?)["']/gi;
    while ((m = videoUrlRe.exec(html)) !== null) {
      let url = m[1].replace(/&amp;/g, '&').replace(/\\/g, '');
      if (seen.has(url) || url.startsWith('/vtt')) continue;
      seen.add(url);
      const hMatch = url.match(/(\d{3,4})p/);
      const height = hMatch ? parseInt(hMatch[1]) : 0;
      const ext = url.includes('.webm') ? 'webm' : 'mp4';
      formats.push(this._makeFormat(url, height, ext, referer));
    }

    // Pattern 4: m3u8 playlist
    const m3u8Re = /["']([^"']+\.m3u8[^"']*?)["']/gi;
    while ((m = m3u8Re.exec(html)) !== null) {
      let url = m[1].replace(/&amp;/g, '&').replace(/\\/g, '');
      if (seen.has(url) || url.startsWith('/vtt')) continue;
      seen.add(url);
      formats.push({
        quality: 'HLS',
        url,
        format_id: 'hls',
        ext: 'mp4',
        height: 0,
        width: 0,
        protocol: 'hls',
        headers: { Referer: referer, 'User-Agent': HEADERS['User-Agent'] },
      });
    }

    return formats;
  }

  _makeFormat(url, height, ext, referer) {
    const fmt = {
      quality: height > 0 ? `${height}p` : 'default',
      url,
      format_id: height > 0 ? `${ext}-${height}p` : `${ext}-default`,
      ext,
      height,
      width: height > 0 ? Math.round(height * 16 / 9) : 0,
      hasVideo: true,
      hasAudio: true,
      headers: {
        Referer: referer,
        Origin: new URL(referer).origin,
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Site': 'cross-site',
      },
    };
    // pvvstream.pro proxy CDN URLs encode the real VK/OK CDN URL in a base64
    // `url` query param.  Provide it as a fallback so the downloader can
    // retry on the direct CDN when the proxy returns 403.
    const directUrl = NoodleMagazineExtractor._decodeProxyCdnUrl(url);
    if (directUrl) fmt.fallbackUrl = directUrl;
    return fmt;
  }

  /**
   * Decode a pvvstream.pro proxy CDN URL to the direct VK/OK CDN URL.
   * Returns null if the URL is not a pvvstream proxy or cannot be decoded.
   */
  static _decodeProxyCdnUrl(proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      if (!u.hostname.includes('pvvstream')) return null;
      const encoded = u.searchParams.get('url');
      if (!encoded) return null;
      // URL-safe base64 → standard base64
      const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      if (!decoded || !decoded.includes('.')) return null;
      return 'https://' + decoded;
    } catch {
      return null;
    }
  }

  async _fetchPage(cycleTLS, pageUrl, referer) {
    const resp = await cycleTLS(pageUrl, {
      body: '',
      ja3: CHROME_JA3,
      userAgent: USER_AGENT,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': referer,
      },
    }, 'get');
    return await resp.text();
  }

  /**
   * Extract a listing page: scrape all /watch/ links and return a playlist.
   */
  async _extractListing(url, options) {
    console.log(`[${this.name}] Listing page detected: ${url}`);

    const { createCycleTLS } = await import('../cycletls-helper.js');
    const cycleTLS = await createCycleTLS();

    try {
      const html = await this._fetchPage(cycleTLS, url, 'https://noodlemagazine.com/');
      if (!html || html.length < 500) {
        throw new Error(`Listing page returned insufficient content (${html?.length || 0} bytes)`);
      }

      // Page title (e.g. "Vicats - found videos")
      let title = null;
      const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
      if (titleMatch) {
        title = this._decodeHtmlEntities(titleMatch[1])
          .replace(/\s*[-|]\s*NoodleMagazine.*$/i, '')
          .trim();
      }
      if (!title) title = 'NoodleMagazine playlist';

      // Collect video items from <div class="item"> blocks
      const entries = [];
      const seen = new Set();

      // Each item: <a href="/watch/ID" ...>...<div class="title">TITLE</div>...</a>
      const itemRe = /<a\s+href="(\/watch\/[^"]+)"[^>]*class="item_link"[^>]*>[\s\S]*?<div\s+class="title">([^<]+)<\/div>[\s\S]*?<\/a>/gi;
      let m;
      while ((m = itemRe.exec(html)) !== null) {
        const watchPath = m[1];
        if (seen.has(watchPath)) continue;
        seen.add(watchPath);
        entries.push({
          _type: 'video',
          id: watchPath.replace('/watch/', ''),
          title: this._decodeHtmlEntities(m[2]).trim(),
          url: `https://noodlemagazine.com${watchPath}`,
          webpage_url: `https://noodlemagazine.com${watchPath}`,
          extractor: this.name,
        });
      }

      // Fallback: any /watch/ link not yet seen (without title)
      const linkRe = /href="(\/watch\/[^"]+)"/gi;
      while ((m = linkRe.exec(html)) !== null) {
        const watchPath = m[1];
        if (seen.has(watchPath)) continue;
        seen.add(watchPath);
        entries.push({
          _type: 'video',
          id: watchPath.replace('/watch/', ''),
          title: watchPath.replace('/watch/', ''),
          url: `https://noodlemagazine.com${watchPath}`,
          webpage_url: `https://noodlemagazine.com${watchPath}`,
          extractor: this.name,
        });
      }

      console.log(`[${this.name}] Found ${entries.length} video(s) on listing page`);

      if (entries.length === 0) {
        throw new Error('No video links found on listing page');
      }

      return {
        _type: 'playlist',
        title,
        entries,
        url,
        extractor: this.name,
      };
    } finally {
      cycleTLS.exit();
    }
  }

  async extract(url, options = {}) {
    // Route listing/search pages to playlist extraction
    if (NoodleMagazineExtractor._isListingUrl(url)) {
      return this._extractListing(url, options);
    }

    console.log(`[${this.name}] Extracting from: ${url}`);

    const idMatch = url.match(/\/watch\/([^\/?#]+)/);
    const videoId = idMatch ? idMatch[1] : 'unknown';
    console.log(`[${this.name}] Video ID: ${videoId}`);

    // Use cycletls to bypass TLS fingerprint checks (regular got gets 403)
    const { createCycleTLS } = await import('../cycletls-helper.js');
    const cycleTLS = await createCycleTLS();

    let html;
    try {
      html = await this._fetchPage(cycleTLS, url, 'https://noodlemagazine.com/');

      if (!html || html.length < 500) {
        throw new Error(`Page returned insufficient content (${html?.length || 0} bytes)`);
      }

      // Extract title
      let title = null;
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
      if (ogTitle) title = this._decodeHtmlEntities(ogTitle[1]).trim();
      if (!title) {
        const titleMatch = html.match(/<title>\s*([^<]+?)\s*<\/title>/i);
        if (titleMatch) {
          title = this._decodeHtmlEntities(titleMatch[1])
            .replace(/\s*[-|]\s*NoodleMagazine.*$/i, '')
            .trim();
        }
      }
      if (!title) title = `NoodleMagazine_${videoId}`;
      console.log(`[${this.name}] Title: ${title}`);

      // Try extracting sources directly from the main page
      let formats = this._extractSourcesFromHtml(html, url);

      // If no sources found, look for an embedded iframe player
      if (formats.length === 0) {
        const iframeSrcRe = /<iframe[^>]+src="([^"]+(?:player|embed|video)[^"]*)"/gi;
        const iframes = [];
        let im;
        while ((im = iframeSrcRe.exec(html)) !== null) {
          let src = im[1].replace(/&amp;/g, '&');
          if (src.startsWith('//')) src = 'https:' + src;
          iframes.push(src);
        }

        // Also check for window.playlist or playerConfig JSON
        const configRe = /(?:window\.)?(?:playlist|playerConfig|config)\s*=\s*(\{[\s\S]*?\})\s*;/;
        const configMatch = html.match(configRe);
        if (configMatch) {
          try {
            const config = JSON.parse(configMatch[1]);
            const sources = config.sources || config.playlist || config.video?.sources;
            if (Array.isArray(sources)) {
              for (const src of sources) {
                const sUrl = src.url || src.file || src.src;
                if (sUrl) {
                  const h = parseInt(src.label || src.quality || src.res) || 0;
                  const ext = sUrl.includes('.webm') ? 'webm' : 'mp4';
                  formats.push(this._makeFormat(sUrl, h, ext, url));
                }
              }
            }
          } catch { /* skip */ }
        }

        // Fetch each iframe and try to extract sources
        for (const iframeSrc of iframes) {
          if (formats.length > 0) break;
          try {
            console.log(`[${this.name}] Fetching player iframe: ${iframeSrc}`);
            const iframeHtml = await this._fetchPage(cycleTLS, iframeSrc, url);
            formats = this._extractSourcesFromHtml(iframeHtml, iframeSrc);
          } catch (e) {
            console.log(`[${this.name}] Could not fetch iframe: ${e.message}`);
          }
        }
      }

      // Try og:video meta tag as last resort
      if (formats.length === 0) {
        const ogVideo = html.match(/<meta\s+property=["']og:video(?::url)?["']\s+content="([^"]+)"/i);
        if (ogVideo) {
          const videoUrl = ogVideo[1].replace(/&amp;/g, '&');
          formats.push(this._makeFormat(videoUrl, 0, 'mp4', url));
        }
      }

      // Sort by height descending
      formats.sort((a, b) => (b.height || 0) - (a.height || 0));

      console.log(`[${this.name}] Found ${formats.length} format(s)`);

      if (formats.length === 0) {
        throw new Error('No downloadable video sources found on page');
      }

      return {
        id: videoId,
        title,
        formats,
        url,
        extractor: this.name,
      };
    } finally {
      cycleTLS.exit();
    }
  }
}

export default NoodleMagazineExtractor;
