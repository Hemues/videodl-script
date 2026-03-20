/**
 * xHamster Extractor
 * Extracts video URLs from xhamster.com
 */

import { BaseExtractor } from './base.js';
import got from 'got';

export class XHamsterExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'XHamster';
  }

  static canHandle(url) {
    return /xhamster\.com/i.test(url);
  }

  async extract(url, options = {}) {
    try {
      console.log(`[${this.name}] Extracting from: ${url}`);

      // Fetch the webpage with proper headers
      const response = await got(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webm,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          'Referer': 'https://xhamster.com/'
        },
        timeout: {
          request: 30000
        },
        followRedirect: true
      });

      const html = response.body;

      // Extract video ID and slug from URL
      // URL format: /videos/slug-videoId
      const urlMatch = url.match(/\/videos\/([^\/]+)-([a-zA-Z0-9]+)$/);
      const videoId = urlMatch ? urlMatch[2] : 'unknown';
      const urlSlug = urlMatch ? urlMatch[1] : null;

      // Extract title from page - try multiple methods
      let title = null;
      
      // Method 1: Extract from <title> tag
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        title = titleMatch[1]
          .replace(/ - xHamster.*$/i, '')
          .replace(/ - Pornhub\.com$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      // Method 2: Look for og:title meta tag
      if (!title) {
        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
        if (ogTitleMatch) {
          title = ogTitleMatch[1].trim();
        }
      }
      
      // Fallback: Use URL slug if title extraction failed
      if (!title || title.length === 0) {
        title = urlSlug ? urlSlug.replace(/-/g, ' ') : `video_${videoId}`;
      }

      console.log(`[${this.name}] Extracting video formats...`);

      // Method 1: Find HLS playlist with quality ladder
      const formats = [];
      const standardHeaders = {
        'Referer': url,
        'Origin': 'https://xhamster.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Look for HLS master playlist URL with quality info
      const hlsPattern = /https:\/\/[^"'\s]*xhcdn\.com[^"'\s]*\/media=[^"'\s]*multi=([^"'\s:]+:[^"'\s:]+:,)*[^"'\s]*\/([^"'\s]+)\/_TPL_\.([^"'\s.]+)\.mp4\.m3u8/g;
      const hlsMatches = [...html.matchAll(hlsPattern)];
      
      if (hlsMatches.length > 0) {
        for (const match of hlsMatches) {
          const baseUrl = match[0];
          const pathPart = match[2]; // e.g., "027/584/888"
          const codec = match[3];     // e.g., "av1" or "h264"
          
          // Parse quality ladder from "multi=" parameter
          const multiMatch = baseUrl.match(/multi=([^/]+)/);
          if (multiMatch) {
            const qualityString = multiMatch[1];
            // Format: "256x144:144p:,426x240:240p:,854x480:480p:,1280x720:720p:,..."
            const qualityPairs = qualityString.split(',').filter(Boolean);
            
            for (const pair of qualityPairs) {
              const parts = pair.split(':');
              if (parts.length >= 2) {
                const resolution = parts[0]; // e.g., "1280x720"
                const quality = parts[1];     // e.g., "720p"
                const height = this.parseResolution(quality);
                
                // Generate HLS playlist URL for this quality
                // Replace _TPL_ with quality (e.g., 720p)
                const playlistUrl = baseUrl.replace('_TPL_', quality);
                
                formats.push({
                  quality: `${quality} (${codec})`,
                  url: playlistUrl,
                  height,
                  format_id: `${quality}-${codec}`,
                  ext: 'm3u8',
                  protocol: 'hls',
                  codec,
                  resolution,
                  headers: standardHeaders
                });
              }
            }
          }
        }
      }

      // Method 2: Find direct MP4 URLs (fallback)
      const directMp4Pattern = /https:\/\/video[^"'\s]*xhcdn\.com[^"'\s]*\/(\d+p)\.(h264|av1)\.mp4[^"'\s]*/g;
      const directMatches = [...html.matchAll(directMp4Pattern)];
      
      for (const match of directMatches) {
        const fullUrl = match[0];
        const quality = match[1];
        const codec = match[2];
        const height = this.parseResolution(quality);
        const formatId = `${quality}-${codec}`;
        
        // Skip if we already have this format from HLS parsing
        if (!formats.some(f => f.format_id === formatId)) {
          formats.push({
            quality: `${quality} (${codec})`,
            url: fullUrl,
            height,
            format_id: formatId,
            ext: 'mp4',
            codec,
            headers: standardHeaders
          });
        }
      }

      // Method 2: Look for direct video URLs in the HTML as fallback
      if (formats.length === 0) {
        const urlPatterns = [
          /https?:\/\/[^"'\s]*\.mp4[^"'\s]*/g,
          /"file"\s*:\s*"([^"]*\.mp4[^"]*)"/g,
          /"videoUrl"\s*:\s*"([^"]*)"/g
        ];
        
        const foundUrls = new Set();
        
        for (const pattern of urlPatterns) {
          const matches = html.matchAll(pattern);
          for (const match of matches) {
            const videoUrl = match[1] || match[0];
            if (videoUrl && videoUrl.includes('.mp4') && !foundUrls.has(videoUrl)) {
              foundUrls.add(videoUrl);
              
              // Try to extract quality from URL
              const qualityMatch = videoUrl.match(/(\d+)p/);
              const quality = qualityMatch ? `${qualityMatch[1]}p` : 'unknown';
              const height = qualityMatch ? parseInt(qualityMatch[1]) : 0;

              formats.push({
                quality,
                url: videoUrl,
                height,
                format_id: quality,
                ext: 'mp4',
                headers: {
                  'Referer': url,
                  'Origin': 'https://xhamster.com',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
              });
            }
          }
        }
      }

      // Method 3: Look for m3u8 playlists as fallback
      if (formats.length === 0) {
        const m3u8Match = html.match(/"file":"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
        if (m3u8Match) {
          formats.push({
            quality: 'hls',
            url: m3u8Match[1],
            height: 0,
            format_id: 'hls',
            ext: 'm3u8',
            protocol: 'hls',
            headers: {
              'Referer': url,
              'Origin': 'https://xhamster.com'
            }
          });
        }
      }

      if (formats.length === 0) {
        throw new Error('No video formats found');
      }

      console.log(`[${this.name}] Found ${formats.length} formats`);

      return {
        id: videoId,
        title,
        formats,
        url,
        extractor: this.name
      };
    } catch (error) {
      console.error(`[${this.name}] Extraction failed:`, error.message);
      throw error;
    }
  }
}

export default XHamsterExtractor;
