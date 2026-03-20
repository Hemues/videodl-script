/**
 * Direct URL Extractor
 * Handles direct video file URLs
 */

import { BaseExtractor } from './base.js';

export class DirectExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'Direct';
  }

  static canHandle(url) {
    // Check if URL points to a video file
    return /\.(mp4|mkv|webm|avi|mov|flv|m4v|ts|m3u8)(\?|$)/i.test(url);
  }

  async extract(url, options = {}) {
    // For direct URLs, just return the URL itself
    const ext = url.match(/\.([a-z0-9]+)(\?|$)/i)?.[1] || 'mp4';
    
    return {
      id: 'direct',
      title: url.split('/').pop().split('?')[0] || 'video',
      formats: [{
        quality: 'direct',
        url: url,
        height: 0,
        format_id: 'direct',
        ext: ext
      }],
      url,
      extractor: this.name
    };
  }
}

export default DirectExtractor;
