/**
 * Twitch Extractor
 * Extracts video URLs from twitch.tv clips and VODs
 *
 * Supports:
 *   - twitch.tv/{channel}/clip/{slug}
 *   - clips.twitch.tv/{slug}
 *   - twitch.tv/videos/{id}
 *
 * Flow (clips):
 *   1. Use GQL API to get clip playback access token
 *   2. Get clip video qualities from token response
 *
 * Flow (VODs):
 *   1. Use GQL API to get VOD access token
 *   2. Construct usher API URL for HLS playlist
 *   3. Parse HLS variants
 */

import { BaseExtractor } from './base.js';
import got from 'got';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const GQL_URL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Public Twitch web client ID

export class TwitchExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Twitch';
  }

  static canHandle(url) {
    return /(?:^|\/\/)(?:(?:www|clips|m)\.)?twitch\.tv\//i.test(url);
  }

  async extract(url, options = {}) {
    console.log(`[${this.name}] Extracting from: ${url}`);

    // Determine if it's a clip or VOD
    const clipMatch = url.match(/clips\.twitch\.tv\/([a-zA-Z0-9_-]+)/) ||
                      url.match(/twitch\.tv\/(?:[^/]+\/)?clip\/([a-zA-Z0-9_-]+)/);
    const vodMatch = url.match(/twitch\.tv\/videos\/(\d+)/);

    if (clipMatch) {
      return await this._extractClip(clipMatch[1], url);
    } else if (vodMatch) {
      return await this._extractVod(vodMatch[1], url);
    } else {
      throw new Error('Unsupported Twitch URL format. Supported: clips and VODs.');
    }
  }

  async _extractClip(slug, url) {
    console.log(`[${this.name}] Extracting clip: ${slug}`);

    // Use direct GQL query to get clip info + playback URLs
    const clipQuery = [{
      query: `query { clip(slug: "${slug}") { title broadcaster { displayName } game { name } thumbnailURL videoQualities { sourceURL quality frameRate } } }`,
    }];

    const tokenResp = await got.post(GQL_URL, {
      json: clipQuery,
      headers: {
        'Client-ID': CLIENT_ID,
        'User-Agent': USER_AGENT,
      },
      responseType: 'json',
      timeout: { request: 20000 },
    });

    const tokenData = tokenResp.body?.[0]?.data?.clip;
    if (!tokenData) {
      throw new Error('Could not get clip access token from Twitch GQL');
    }

    const title = tokenData.title || `Twitch Clip ${slug}`;
    const broadcaster = tokenData.broadcaster?.displayName || '';
    const game = tokenData.game?.name || '';
    console.log(`[${this.name}] Title: ${title}`);
    if (broadcaster) console.log(`[${this.name}] Channel: ${broadcaster}`);

    const formats = [];

    // videoQualities contains direct MP4 URLs
    if (tokenData.videoQualities) {
      for (const q of tokenData.videoQualities) {
        const height = parseInt(q.quality) || 0;
        formats.push({
          url: q.sourceURL,
          ext: 'mp4',
          height,
          width: Math.round(height * 16 / 9),
          quality: `${height}p`,
          fps: q.frameRate || 0,
          hasVideo: true,
          hasAudio: true,
          format_id: `clip-${height}p`,
        });
      }
    }

    if (formats.length === 0) {
      // Fallback: try thumbnail URL manipulation
      if (tokenData.thumbnailURL) {
        const mp4Url = tokenData.thumbnailURL.replace(/-preview-\d+x\d+\.jpg/, '.mp4');
        formats.push({
          url: mp4Url,
          ext: 'mp4',
          height: 720,
          quality: '720p',
          hasVideo: true,
          hasAudio: true,
          format_id: 'clip-fallback',
        });
      }
    }

    if (formats.length === 0) {
      throw new Error('No playback URLs found for this clip');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: slug,
      title,
      formats,
      thumbnail: tokenData.thumbnailURL || '',
      uploader: broadcaster,
      extractor: this.name,
      url,
    };
  }

  async _extractVod(vodId, url) {
    console.log(`[${this.name}] Extracting VOD: ${vodId}`);

    // Get VOD access token via GQL
    const tokenQuery = [{
      operationName: 'PlaybackAccessToken',
      variables: {
        isLive: false,
        login: '',
        isVod: true,
        vodID: vodId,
        playerType: 'site',
      },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb11c9e12ee2d6ef21b02',
        },
      },
    }];

    const tokenResp = await got.post(GQL_URL, {
      json: tokenQuery,
      headers: {
        'Client-ID': CLIENT_ID,
        'User-Agent': USER_AGENT,
      },
      responseType: 'json',
      timeout: { request: 20000 },
    });

    const tokenData = tokenResp.body?.[0]?.data?.videoPlaybackAccessToken;
    if (!tokenData) {
      throw new Error('Could not get VOD access token (may be subscriber-only)');
    }

    // Get video metadata
    const metaQuery = [{
      operationName: 'VideoMetadata',
      variables: { channelLogin: '', videoID: vodId },
      extensions: {
        persistedQuery: {
          version: 1,
          sha256Hash: '45111672eea2e507f8ba44d101a61862f9c56b11dee09a15634cb75cb4b82dc4',
        },
      },
    }];

    let title = `Twitch VOD ${vodId}`;
    let broadcaster = '';
    let duration = 0;
    let thumbnail = '';

    try {
      const metaResp = await got.post(GQL_URL, {
        json: metaQuery,
        headers: { 'Client-ID': CLIENT_ID, 'User-Agent': USER_AGENT },
        responseType: 'json',
        timeout: { request: 15000 },
      });
      const video = metaResp.body?.[0]?.data?.video;
      if (video) {
        title = video.title || title;
        broadcaster = video.owner?.displayName || '';
        duration = video.lengthSeconds || 0;
        thumbnail = video.previewThumbnailURL || '';
      }
    } catch (e) {
      console.log(`[${this.name}] Metadata fetch failed: ${e.message}`);
    }

    console.log(`[${this.name}] Title: ${title}`);

    // Build usher HLS URL
    const usherUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8` +
      `?allow_source=true&allow_audio_only=true&allow_spectre=true` +
      `&player_backend=mediaplayer` +
      `&sig=${tokenData.signature}` +
      `&token=${encodeURIComponent(tokenData.value)}`;

    console.log(`[${this.name}] Fetching HLS playlist...`);
    const hlsResp = await got(usherUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: { request: 20000 },
    });

    const formats = [];
    const lines = hlsResp.body.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;

      const resoMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
      const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
      const nameMatch = line.match(/VIDEO="([^"]+)"/);
      const height = resoMatch ? parseInt(resoMatch[2]) : 0;

      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith('#')) { uri = next; break; }
      }

      if (!uri) continue;

      const qualityName = nameMatch?.[1] || `${height}p`;
      formats.push({
        url: uri,
        ext: 'mp4',
        height: height || (qualityName === 'audio_only' ? 0 : 480),
        width: resoMatch ? parseInt(resoMatch[1]) : 0,
        quality: qualityName,
        protocol: 'hls',
        hasVideo: qualityName !== 'audio_only',
        hasAudio: true,
        format_id: `hls-${qualityName}`,
        tbr: bandwidthMatch ? Math.round(parseInt(bandwidthMatch[1]) / 1000) : 0,
        formatNote: 'HLS',
      });
    }

    if (formats.length === 0) {
      throw new Error('No HLS variants found for this VOD');
    }

    formats.sort((a, b) => (b.height || 0) - (a.height || 0));
    console.log(`[${this.name}] Found ${formats.length} format(s)`);

    return {
      id: vodId,
      title,
      formats,
      thumbnail,
      duration,
      uploader: broadcaster,
      extractor: this.name,
      url,
    };
  }
}

export default TwitchExtractor;
