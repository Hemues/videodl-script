/**
 * PornHub Extractor
 * Extracts video URLs from pornhub.com
 */

import { BaseExtractor } from './base.js';
import got from 'got';

export class PornHubExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'PornHub';
  }

  static canHandle(url) {
    return /pornhub\.com/i.test(url);
  }

  async extract(url, options = {}) {
    try {
      console.log(`[${this.name}] Extracting from: ${url}`);

      // Fetch the webpage with proper headers
      const response = await got(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          'Referer': 'https://www.pornhub.com/'
        },
        timeout: {
          request: 30000
        },
        followRedirect: true
      });

      const html = response.body;

      // Extract video ID from URL
      const viewkeyMatch = url.match(/viewkey=([a-zA-Z0-9]+)/);
      const videoId = viewkeyMatch ? viewkeyMatch[1] : 'unknown';

      // Extract title from page - try multiple methods
      let title = null;
      
      // Helper function to decode HTML entities
      const decodeHtmlEntities = (text) => {
        return text
          .replace(/&quot;/g, '"')
          .replace(/&#039;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#x([0-9A-F]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
          .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
      };

      // Method 1: Extract from <title> tag
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch) {
        title = decodeHtmlEntities(titleMatch[1])
          .replace(/ - Pornhub\.com$/i, '')
          .replace(/ - PORNHUB\.COM$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
      }
      
      // Method 2: Look for og:title meta tag
      if (!title) {
        const ogTitleMatch = html.match(/<meta\s+property=["']og:title["']\s+content="([^"]+)"/i);
        if (ogTitleMatch) {
          title = decodeHtmlEntities(ogTitleMatch[1]).trim();
        }
      }
      
      // Method 3: Look for video title in JSON data
      if (!title) {
        const jsonTitleMatch = html.match(/"video_title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        if (jsonTitleMatch) {
          title = decodeHtmlEntities(jsonTitleMatch[1].replace(/\\"/g, '"')).trim();
        }
      }
      
      // Fallback: Use video ID
      if (!title || title.length === 0) {
        title = `video_${videoId}`;
      }

      console.log(`[${this.name}] Extracting video formats...`);

      // Extract duration (seconds)
      let duration = 0;

      // Method 1: Extract from flashvars_* JSON
      const formats = [];
      const standardHeaders = {
        'Referer': url,
        'Origin': 'https://www.pornhub.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Look for flashvars or media definitions
      const flashvarsMatch = html.match(/var\s+flashvars_\d+\s*=\s*({.+?});/s);
      if (flashvarsMatch) {
        try {
          const flashvars = JSON.parse(flashvarsMatch[1]);

          // Extract duration from flashvars
          if (flashvars.video_duration) duration = parseInt(flashvars.video_duration);
          
          // Extract from mediaDefinitions
          if (flashvars.mediaDefinitions && Array.isArray(flashvars.mediaDefinitions)) {
            for (const media of flashvars.mediaDefinitions) {
              
              if (media.videoUrl && media.format === 'hls') {
                // HLS format - fetch and parse the master playlist
                try {
                  const mediaResponse = await got(media.videoUrl, {
                    headers: standardHeaders,
                    timeout: { request: 10000 }
                  });
                  const m3u8Content = mediaResponse.body;
                  
                  // Parse HLS master playlist for different quality streams
                  const streamMatches = m3u8Content.matchAll(/#EXT-X-STREAM-INF:.*?RESOLUTION=(\d+)x(\d+).*?\n(https?:\/\/[^\s]+)/g);
                  let foundStreams = false;
                  for (const match of streamMatches) {
                    foundStreams = true;
                    const width = parseInt(match[1]);
                    const height = parseInt(match[2]);
                    const streamUrl = match[3];
                    const quality = `${height}p`;
                    
                    formats.push({
                      quality,
                      url: streamUrl,
                      width,
                      height,
                      format_id: quality,
                      ext: 'm3u8',
                      protocol: 'hls',
                      headers: standardHeaders
                    });
                  }
                  
                  // If no streams found in master playlist, use the playlist URL directly
                  if (!foundStreams && media.quality) {
                    const quality = `${media.quality}p`;
                    const height = parseInt(media.quality);
                    const width = Math.round(height * 16 / 9); // Assume 16:9 aspect ratio
                    formats.push({
                      quality,
                      url: media.videoUrl,
                      width,
                      height,
                      format_id: quality,
                      ext: 'm3u8',
                      protocol: 'hls',
                      headers: standardHeaders
                    });
                  }
                } catch (e) {
                  console.log(`[${this.name}] Failed to parse HLS playlist: ${e.message}`);
                }
              } else if (media.videoUrl && media.format === 'mp4') {
                // MP4 format - try to parse as JSON
                try {
                  const mediaResponse = await got(media.videoUrl, {
                    headers: standardHeaders,
                    timeout: { request: 10000 }
                  });
                  const mediaData = JSON.parse(mediaResponse.body);
                  
                  if (Array.isArray(mediaData)) {
                    for (const item of mediaData) {
                      if (item.quality && item.videoUrl) {
                        const quality = item.quality.includes('p') ? item.quality : `${item.quality}p`;
                        const height = this.parseResolution(quality);
                        const width = Math.round(height * 16 / 9); // Assume 16:9 aspect ratio
                        formats.push({
                          quality,
                          url: item.videoUrl,
                          width,
                          height,
                          format_id: quality,
                          ext: 'mp4',
                          protocol: 'https',
                          headers: standardHeaders
                        });
                      }
                    }
                  }
                } catch (e) {
                  console.log(`[${this.name}] Failed to fetch MP4 media definition: ${e.message}`);
                }
              } else if (media.quality && media.url) {
                // Direct URL in media definitions
                const quality = typeof media.quality === 'string' && media.quality.includes('p') ? media.quality : `${media.quality}p`;
                const height = this.parseResolution(quality);
                const width = Math.round(height * 16 / 9); // Assume 16:9 aspect ratio
                formats.push({
                  quality,
                  url: media.url,
                  width,
                  height,
                  format_id: quality,
                  ext: 'mp4',
                  protocol: 'https',
                  headers: standardHeaders
                });
              }
            }
          }
        } catch (e) {
          console.log(`[${this.name}] Failed to parse flashvars: ${e.message}`);
        }
      }

      // Method 2: Look for direct video URLs in the HTML
      if (formats.length === 0) {
        const videoUrlMatches = html.matchAll(/"quality_(\d+)p"\s*:\s*"(https?:\/\/[^"]+)"/g);
        for (const match of videoUrlMatches) {
          const quality = match[1] + 'p';
          const height = parseInt(match[1]);
          const width = Math.round(height * 16 / 9); // Assume 16:9 aspect ratio
          formats.push({
            quality,
            url: match[2],
            width,
            height,
            format_id: quality,
            ext: 'mp4',
            protocol: 'https',
            headers: standardHeaders
          });
        }
      }

      // Method 3: Look for HLS streams
      if (formats.length === 0) {
        const hlsMatch = html.match(/"(https?:\/\/[^"]+\.m3u8[^"]*)"/);
        if (hlsMatch) {
          formats.push({
            quality: 'hls',
            url: hlsMatch[1],
            format_id: 'hls',
            ext: 'm3u8',
            protocol: 'hls',
            headers: standardHeaders
          });
        }
      }

      console.log(`[${this.name}] Found ${formats.length} formats`);

      return {
        id: videoId,
        title,
        duration,
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

export default PornHubExtractor;
