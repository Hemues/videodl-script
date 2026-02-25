/**
 * Base Extractor Class
 * All site-specific extractors extend this
 */

export class BaseExtractor {
  constructor() {
    this.name = 'BaseExtractor';
  }

  /**
   * Check if this extractor can handle the URL
   * @param {string} url - URL to check
   * @returns {boolean}
   */
  static canHandle(url) {
    return false;
  }

  /**
   * Extract video information from URL
   * @param {string} url - Video page URL
   * @param {Object} options - Extraction options
   * @returns {Promise<Object>} Video info with formats
   */
  async extract(url, options = {}) {
    throw new Error('extract() must be implemented by subclass');
  }

  /**
   * Select best format based on quality preference
   * @param {Array} formats - Available formats
   * @param {string} quality - Desired quality (e.g., '720p', 'best', 'worst')
   * @returns {Object} Selected format
   */
  selectFormat(formats, quality = 'best') {
    if (!formats || formats.length === 0) {
      throw new Error('No formats available');
    }

    // Sort by resolution/quality
    const sortedFormats = [...formats].sort((a, b) => {
      const heightA = a.height || 0;
      const heightB = b.height || 0;
      return heightB - heightA; // Descending order
    });

    // Default: try 720p first, fall back to best (highest) if not available
    if (quality === 'default') {
      const match720 = sortedFormats.find(f => f.height === 720);
      return match720 || sortedFormats[0];
    }

    if (quality === 'best') {
      return sortedFormats[0];
    }

    if (quality === 'worst') {
      return sortedFormats[sortedFormats.length - 1];
    }

    // Match specific quality (e.g., '720p', '1080p')
    const qualityMatch = quality.match(/(\d+)p?/);
    if (qualityMatch) {
      const targetHeight = parseInt(qualityMatch[1]);
      const exactMatch = sortedFormats.find(f => f.height === targetHeight);
      if (exactMatch) return exactMatch;

      // No exact match — prefer the next HIGHER quality, fall back to lower
      // sortedFormats is descending by height, so walk from lowest to highest
      // and pick the first one that is >= target.
      const ascending = [...sortedFormats].reverse();
      const higher = ascending.find(f => (f.height || 0) >= targetHeight);
      if (higher) return higher;
      // Nothing higher exists — pick highest available (first in descending)
      return sortedFormats[0];
    }

    return sortedFormats[0];
  }

  /**
   * Select best video-only + audio-only pair for DASH merge download.
   * Returns { video, audio, ext } or null if no DASH formats available.
   * Downloading separate DASH streams is MUCH faster on YouTube (no throttling).
   */
  selectFormatPair(formats, quality = 'best') {
    if (!formats || formats.length === 0) return null;

    const videoOnly = formats.filter(f => f.hasVideo && !f.hasAudio);
    const audioOnly = formats.filter(f => !f.hasVideo && f.hasAudio);

    if (videoOnly.length === 0 || audioOnly.length === 0) return null;

    // Codec efficiency rank: AV1 > VP9 > H.264 (smaller files at same quality)
    const codecRank = (f) => {
      const vc = (f.vcodec || '').toLowerCase();
      if (vc.startsWith('av01')) return 0; // AV1 — best compression
      if (vc.startsWith('vp9') || vc.startsWith('vp09')) return 1;
      return 2; // avc1 / H.264
    };

    // Sort video: height descending → prefer AV1 → then by filesize ascending
    const sortedVideo = [...videoOnly].sort((a, b) => {
      if ((b.height || 0) !== (a.height || 0)) return (b.height || 0) - (a.height || 0);
      // At same height, prefer most efficient codec
      const cr = codecRank(a) - codecRank(b);
      if (cr !== 0) return cr;
      // Same codec + height: prefer smallest file
      if (a.filesize && b.filesize) return a.filesize - b.filesize;
      return 0;
    });

    let selectedVideo;
    if (quality === 'default') {
      // Default: try 720p first, fall back to best (highest) if not available
      selectedVideo = sortedVideo.find(f => f.height === 720) || sortedVideo[0];
    } else if (quality === 'best') {
      selectedVideo = sortedVideo[0];
    } else if (quality === 'worst') {
      selectedVideo = sortedVideo[sortedVideo.length - 1];
    } else {
      const targetHeight = parseInt(quality);
      if (targetHeight) {
        selectedVideo = sortedVideo.find(f => f.height === targetHeight);
        if (!selectedVideo) {
          // No exact match — prefer the next HIGHER quality, fall back to lower
          // sortedVideo is descending by height
          const ascending = [...sortedVideo].reverse();
          selectedVideo = ascending.find(f => (f.height || 0) >= targetHeight);
          if (!selectedVideo) {
            // Nothing higher exists — pick highest available
            selectedVideo = sortedVideo[0];
          }
        }
      } else {
        selectedVideo = sortedVideo[0];
      }
    }

    // Select best audio (highest bitrate)
    const selectedAudio = [...audioOnly].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

    // Determine output container based on codec compatibility
    const vcodec = (selectedVideo.vcodec || '').toLowerCase();
    const acodec = (selectedAudio.acodec || '').toLowerCase();
    // Pick container: webm for VP9/AV1+Opus, mp4 for H.264/AV1+AAC, mkv fallback
    const isWebmVideo = vcodec.startsWith('vp9') || vcodec.startsWith('vp09') || vcodec.startsWith('av01');
    const isWebmAudio = acodec.startsWith('opus') || acodec.startsWith('vorbis');
    const isMp4Video = vcodec.startsWith('avc1') || vcodec.startsWith('av01');
    const isMp4Audio = acodec.startsWith('mp4a');
    let ext = 'mkv'; // universal fallback
    if (isWebmVideo && isWebmAudio) ext = 'webm';
    else if (isMp4Video && isMp4Audio) ext = 'mp4';

    return { video: selectedVideo, audio: selectedAudio, ext };
  }

  /**
   * Parse resolution string to height
   * @param {string} resolution - Resolution string (e.g., '1920x1080', '720p')
   * @returns {number} Height in pixels
   */
  parseResolution(resolution) {
    if (!resolution) return 0;

    // Match 'NNNp' format
    const pMatch = resolution.match(/(\d+)p/);
    if (pMatch) return parseInt(pMatch[1]);

    // Match 'WIDTHxHEIGHT' format
    const xMatch = resolution.match(/\d+x(\d+)/);
    if (xMatch) return parseInt(xMatch[1]);

    return 0;
  }
}

export default BaseExtractor;
