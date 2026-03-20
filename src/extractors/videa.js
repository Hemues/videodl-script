/**
 * Videa.hu Extractor
 * Extracts video URLs from videa.hu (Hungarian video platform)
 *
 * Flow:
 *   1. Fetch video page → find player iframe URL (/player?f=...)
 *   2. Fetch player page → extract nonce (_xt = "...")
 *   3. Decrypt nonce using static secret to get result token
 *   4. Call XML API: videa.hu/player/xml with auth query params
 *   5. Response is base64-encoded RC4-encrypted XML (or plain XML)
 *   6. Decrypt with RC4 using key = result[16:] + randomSeed + x-videa-xs header
 *   7. Parse XML for video_sources (URLs + hash_values for auth)
 *
 * Based on yt-dlp's VideaIE extractor.
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Static secret used to decrypt the nonce (from yt-dlp)
const STATIC_SECRET = 'xHb0ZvME5q8CBcoQi6AngerDu3FGO9fkUlwPmLVY_RTzj2hJIS4NasXWKy1td7p';

export class VideaExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Videa';
  }

  static canHandle(url) {
    return /videa(?:kid)?\.hu\//i.test(url);
  }

  /**
   * RC4 stream cipher — decrypts base64-decoded ciphertext with the given key
   */
  _rc4(cipherBuf, key) {
    const keyLen = key.length;
    const S = Array.from({ length: 256 }, (_, i) => i);
    let j = 0;
    for (let i = 0; i < 256; i++) {
      j = (j + S[i] + key.charCodeAt(i % keyLen)) % 256;
      [S[i], S[j]] = [S[j], S[i]];
    }
    const result = Buffer.alloc(cipherBuf.length);
    let ii = 0;
    j = 0;
    for (let m = 0; m < cipherBuf.length; m++) {
      ii = (ii + 1) % 256;
      j = (j + S[ii]) % 256;
      [S[ii], S[j]] = [S[j], S[ii]];
      const k = S[(S[ii] + S[j]) % 256];
      result[m] = k ^ cipherBuf[m];
    }
    return result.toString('utf-8');
  }

  /**
   * Extract video ID from URL
   * Supports: /videok/.../title-ID, /player?v=ID, /player/v/ID
   */
  _extractVideoId(url) {
    // /videok/.../<title>-<ID> pattern
    const pageMatch = url.match(/videa(?:kid)?\.hu\/videok\/(?:[^/]+\/)*[^?#&]+-([^?#&]+)/);
    if (pageMatch) return pageMatch[1];
    // /player?v=ID
    const playerQs = url.match(/[?&]v=([^?#&]+)/);
    if (playerQs) return playerQs[1];
    // /player/v/ID
    const playerPath = url.match(/player\/v\/([^?#&]+)/);
    if (playerPath) return playerPath[1];
    return null;
  }

  /**
   * Decode HTML entities
   */
  _decodeHtmlEntities(text) {
    return text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#x([0-9A-F]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
  }

  /**
   * Simple XPath-like helpers to extract text/attribute from XML string
   */
  _xmlText(xml, tag) {
    const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? this._decodeHtmlEntities(m[1].trim()) : null;
  }

  _xmlAttr(xml, tag, attr) {
    const m = xml.match(new RegExp(`<${tag}\\s[^>]*${attr}="([^"]*)"`, 'i'));
    return m ? m[1] : null;
  }

  _xmlAll(xml, tag) {
    const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`, 'gi');
    const results = [];
    let m;
    while ((m = re.exec(xml)) !== null) {
      results.push({ attrs: m[1], text: m[2].trim() });
    }
    return results;
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    const headers = {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    };

    const videoId = this._extractVideoId(url);
    if (videoId) {
      console.log(`[${this.name}] Video ID: ${videoId}`);
    }

    // Step 1: Determine if this is a player URL or a watch page
    let playerUrl;
    let pageUrl = url;

    if (/videa(?:kid)?\.hu\/player/i.test(url)) {
      // It's already a player URL
      playerUrl = url;
    } else {
      // Fetch the video page and find the player iframe
      console.log(`[${this.name}] Fetching video page...`);
      const pageResp = await got(url, {
        headers,
        followRedirect: true,
        maxRedirects: 5,
        timeout: { request: 30000 },
      });

      const iframeMatch = pageResp.body.match(
        /<iframe[^>]+id="videa_player_iframe"[^>]+src="([^"]+)"/
      ) || pageResp.body.match(
        /<iframe[^>]+src="([^"]*videa\.hu\/player[^"]*)"/i
      );

      if (!iframeMatch) {
        throw new Error('Could not find videa.hu player iframe on page');
      }

      const iframeSrc = iframeMatch[1].replace(/&amp;/g, '&');
      playerUrl = new URL(iframeSrc, 'https://videa.hu').href;
    }

    console.log(`[${this.name}] Player URL: ${playerUrl}`);

    // Step 2: Fetch player page → extract nonce
    console.log(`[${this.name}] Fetching player page...`);
    const playerResp = await got(playerUrl, {
      headers: { ...headers, 'Referer': pageUrl },
      followRedirect: true,
      timeout: { request: 30000 },
    });

    const nonceMatch = playerResp.body.match(/_xt\s*=\s*"([^"]+)"/);
    if (!nonceMatch) {
      throw new Error('Could not find nonce (_xt) in player page');
    }

    const nonce = nonceMatch[1];
    const l = nonce.substring(0, 32);
    const s = nonce.substring(32);

    // Step 3: Decrypt nonce using static secret
    let result = '';
    for (let i = 0; i < 32; i++) {
      const secretIdx = STATIC_SECRET.indexOf(l[i]);
      result += s[i - (secretIdx - 31)];
    }

    // Step 4: Build query for XML API
    const parsedPlayerUrl = new URL(playerUrl);
    const query = {};
    for (const [k, v] of parsedPlayerUrl.searchParams) {
      query[k] = v;
    }

    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const randomSeed = Array.from({ length: 8 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');

    query['_s'] = randomSeed;
    query['_t'] = result.substring(0, 16);

    // Step 5: Call XML API
    console.log(`[${this.name}] Fetching video data...`);
    const xmlResp = await got('http://videa.hu/player/xml', {
      searchParams: query,
      headers: { 'User-Agent': USER_AGENT, 'Referer': playerUrl },
      timeout: { request: 20000 },
    });

    // Step 6: Decrypt response
    let xmlStr;
    if (xmlResp.body.startsWith('<?xml')) {
      xmlStr = xmlResp.body;
    } else {
      const xvs = xmlResp.headers['x-videa-xs'];
      if (!xvs) {
        throw new Error('Missing x-videa-xs header in XML API response');
      }
      const key = result.substring(16) + randomSeed + xvs;
      const decoded = Buffer.from(xmlResp.body, 'base64');
      xmlStr = this._rc4(decoded, key);
    }

    // Step 7: Check for errors
    const errorText = this._xmlText(xmlStr, 'error');
    if (errorText && !this._xmlText(xmlStr, 'video')) {
      throw new Error(`Videa error: ${errorText}`);
    }

    // Step 8: Parse video metadata
    const videoBlock = xmlStr.match(/<video\b[^>]*>[\s\S]*?<\/video>/i)?.[0] || xmlStr;
    const title = this._xmlText(videoBlock, 'title') || `Videa Video ${videoId || 'unknown'}`;
    const duration = parseInt(this._xmlText(videoBlock, 'duration') || '0', 10) || null;
    const posterSrc = this._xmlText(videoBlock, 'poster_src');
    const isAdult = this._xmlText(videoBlock, 'is_adult_content');
    const description = this._xmlText(videoBlock, 'description');
    const uploader = this._xmlText(videoBlock, 'uploader_name') ||
                     this._xmlText(videoBlock, 'channel');

    console.log(`[${this.name}] Title: ${title}`);

    // Step 9: Parse video sources
    const sources = this._xmlAll(xmlStr, 'video_source');
    const sourcesExpMatch = xmlStr.match(/<video_sources[^>]+exp="(\d+)"/);
    const sourcesExp = sourcesExpMatch ? sourcesExpMatch[1] : null;

    // Parse hash values
    const hashValues = {};
    const hashBlock = xmlStr.match(/<hash_values>[\s\S]*?<\/hash_values>/i)?.[0] || '';
    const hashRe = /<hash_value_([^>]+)>([^<]+)<\/hash_value_\1>/gi;
    let hm;
    while ((hm = hashRe.exec(hashBlock)) !== null) {
      hashValues[hm[1]] = hm[2];
    }

    console.log(`[${this.name}] Sources: ${sources.length}, hashes: ${Object.keys(hashValues).length}`);

    // Step 10: Build format list
    const formats = [];

    for (const src of sources) {
      let sourceUrl = src.text;
      if (!sourceUrl) continue;

      // Parse attributes
      const nameMatch = src.attrs.match(/name="([^"]*)"/);
      const mimeMatch = src.attrs.match(/mimetype="([^"]*)"/);
      const codecsMatch = src.attrs.match(/codecs="([^"]*)"/);
      const widthMatch = src.attrs.match(/width="([^"]*)"/);
      const heightMatch = src.attrs.match(/height="([^"]*)"/);
      const expMatch = src.attrs.match(/exp="([^"]*)"/);

      const name = nameMatch ? nameMatch[1] : null;
      const mimetype = mimeMatch ? mimeMatch[1] : 'video/mp4';
      const codecs = codecsMatch ? codecsMatch[1] : '';
      const width = widthMatch ? parseInt(widthMatch[1], 10) : 0;
      const height = heightMatch ? parseInt(heightMatch[1], 10) : 0;
      const exp = expMatch ? expMatch[1] : sourcesExp;

      // Apply hash_value and expires to URL
      const hashValue = name ? hashValues[name] : null;
      if (hashValue && exp) {
        const sep = sourceUrl.includes('?') ? '&' : '?';
        sourceUrl = `${sourceUrl}${sep}md5=${hashValue}&expires=${exp}`;
      }

      // Ensure https
      if (sourceUrl.startsWith('//')) {
        sourceUrl = 'https:' + sourceUrl;
      }

      // Determine extension
      let ext = 'mp4';
      if (mimetype.includes('webm')) ext = 'webm';
      else if (mimetype.includes('3gpp')) ext = '3gp';

      // Parse codecs
      const codecParts = codecs.split(',').map(c => c.trim());
      const vcodec = codecParts.find(c => /^(avc|hev|vp[89]|av0?1)/i.test(c)) || null;
      const acodec = codecParts.find(c => /^(mp4a|opus|vorb)/i.test(c)) || null;

      formats.push({
        url: sourceUrl,
        ext,
        height,
        width,
        quality: height ? `${height}p` : name || 'unknown',
        format_id: name || (height ? `${ext}-${height}p` : ext),
        hasVideo: true,
        hasAudio: true,
        protocol: 'https',
        mimeType: mimetype,
        vcodec,
        acodec,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': 'https://videa.hu/',
        },
      });
    }

    // Sort by height descending
    formats.sort((a, b) => (b.height || 0) - (a.height || 0));

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    if (formats.length === 0) {
      throw new Error('No downloadable formats found');
    }

    // Build thumbnail URL
    let thumbnail = posterSrc;
    if (thumbnail && thumbnail.startsWith('//')) {
      thumbnail = 'https:' + thumbnail;
    }

    return {
      title,
      formats,
      extractor: this.name,
      url,
      videoId: videoId || this._xmlText(videoBlock, 'vcode') || null,
      duration,
      description,
      uploader,
      thumbnail,
      ageLimit: isAdult === '1' ? 18 : 0,
    };
  }
}
