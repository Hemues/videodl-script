/**
 * Odysee Extractor
 * Extracts video URLs from odysee.com (LBRY protocol)
 *
 * Supports:
 *   - odysee.com/@{channel}/{claim}
 *   - odysee.com/{claim}
 *
 * Flow:
 *   1. Parse URL to extract channel + claim name
 *   2. Use LBRY resolve API to get claim metadata (title, video info, sd_hash)
 *   3. Construct streaming URL: player.odycdn.com/api/v3/streams/free/{name}/{claimId}/{sdHash6}.mp4
 *   4. Fallback: fetch embed page and extract player URL
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const STREAM_BASE = 'https://player.odycdn.com/api/v3/streams/free';

export class OdyseeExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Odysee';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:www\.)?odysee\.com\//i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Parse URL to get channel and claim path
    const pathMatch = url.match(/odysee\.com\/(.+?)(?:\?|#|$)/);
    if (!pathMatch) throw new Error('Could not parse Odysee URL');

    const urlPath = decodeURIComponent(pathMatch[1]).replace(/\/+$/, '');
    let lbryUri = null;

    // Build LBRY URI from URL path
    const channelClaimMatch = urlPath.match(/^(@[^/]+)\/(.+)$/);
    if (channelClaimMatch) {
      lbryUri = `lbry://${channelClaimMatch[1]}/${channelClaimMatch[2]}`;
    } else if (!urlPath.startsWith('$')) {
      lbryUri = `lbry://${urlPath}`;
    }

    let title = null;
    let thumbnail = '';
    let claimName = '';
    let claimId = '';
    let sdHash = '';
    let videoHeight = 720;
    let videoWidth = 1280;
    const formats = [];

    // Try LBRY resolve API
    if (lbryUri) {
      console.log(`[${this.name}] Resolving: ${lbryUri}`);
      try {
        const apiResp = await got.post('https://api.na-backend.odysee.com/api/v1/proxy?m=resolve', {
          json: { jsonrpc: '2.0', method: 'resolve', params: { urls: [lbryUri] } },
          headers: { 'User-Agent': USER_AGENT },
          responseType: 'json',
          timeout: { request: 20000 },
        });

        const claim = Object.values(apiResp.body?.result || {})[0];
        if (claim && !claim.error) {
          claimName = claim.name || '';
          claimId = claim.claim_id || '';
          title = claim.value?.title || null;
          thumbnail = claim.value?.thumbnail?.url || '';
          videoHeight = claim.value?.video?.height || 720;
          videoWidth = claim.value?.video?.width || 1280;
          sdHash = claim.value?.source?.sd_hash || '';

          if (claimName && claimId && sdHash) {
            const streamUrl = `${STREAM_BASE}/${encodeURIComponent(claimName)}/${claimId}/${sdHash.substring(0, 6)}.mp4`;
            formats.push({
              url: streamUrl,
              ext: 'mp4',
              height: videoHeight,
              width: videoWidth,
              quality: `${videoHeight}p`,
              hasVideo: true,
              hasAudio: true,
              format_id: 'lbry-stream',
            });
          }
        }
      } catch (e) {
        console.log(`[${this.name}] LBRY resolve failed: ${e.message}`);
      }
    }

    // Fallback: fetch embed page and extract player URL
    if (formats.length === 0) {
      console.log(`[${this.name}] Trying embed page fallback...`);
      try {
        // Construct embed URL from the path
        const embedPath = urlPath.replace(/^(@[^/:]+(?::[a-f0-9]*)?)\//, '$1/');
        const parts = urlPath.split('/');
        let embedUrl;
        if (parts.length >= 2) {
          embedUrl = `https://odysee.com/$/embed/${parts[parts.length - 1]}`;
        } else {
          embedUrl = `https://odysee.com/$/embed/${urlPath}`;
        }

        const embedResp = await got(embedUrl, {
          headers: { 'User-Agent': USER_AGENT },
          timeout: { request: 20000 },
          followRedirect: true,
        });

        // Look for player.odycdn.com URLs
        const playerUrl = embedResp.body.match(/https?:\/\/player\.odycdn\.com\/[^"'\s]+\.mp4/);
        if (playerUrl) {
          formats.push({
            url: playerUrl[0],
            ext: 'mp4',
            height: videoHeight,
            width: videoWidth,
            quality: `${videoHeight}p`,
            hasVideo: true,
            hasAudio: true,
            format_id: 'embed-player',
          });
        }

        if (!title) {
          const ogTitle = embedResp.body.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
          if (ogTitle && ogTitle[1] !== 'Odysee') title = ogTitle[1];
        }
      } catch (e) {
        console.log(`[${this.name}] Embed fallback failed: ${e.message}`);
      }
    }

    if (!title) title = `Odysee ${claimName || urlPath}`;
    if (!claimId) claimId = urlPath.replace(/[^a-zA-Z0-9]/g, '_');

    console.log(`[${this.name}] Title: ${title}`);

    if (formats.length === 0) {
      throw new Error('Could not extract video URL from Odysee');
    }

    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: claimId,
      title,
      formats,
      thumbnail,
      extractor: this.name,
      url,
    };
  }
}

export default OdyseeExtractor;
