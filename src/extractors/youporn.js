/**
 * YouPorn Extractor
 * Extracts video URLs from youporn.com
 */

import { BaseExtractor } from './base.js';
import got from 'got';

export class YouPornExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'YouPorn';
  }

  static canHandle(url) {
    return /youporn\.com/i.test(url);
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
          'Cookie': 'age_verified=1; platform=pc; domain=.youporn.com',
          'Referer': 'https://www.youporn.com/'
        },
        timeout: {
          request: 30000
        },
        followRedirect: true
      });

      const html = response.body;

      // Extract video ID from URL - YouPorn format: /watch/VIDEO_ID/title
      const videoIdMatch = url.match(/\/watch\/(\d+)\//);
      const videoId = videoIdMatch ? videoIdMatch[1] : 'unknown';

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
          .replace(/ - Free Porn Videos - YouPorn$/i, '')
          .replace(/ - YouPorn$/i, '')
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
      
      // Method 4: Look for videoTitle in page
      if (!title) {
        const videoTitleMatch = html.match(/videoTitle['"]\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        if (videoTitleMatch) {
          title = decodeHtmlEntities(videoTitleMatch[1]).trim();
        }
      }
      
      // Fallback: Use video ID
      if (!title || title.length === 0) {
        title = `video_${videoId}`;
      }

      // Extract duration (seconds)
      let duration = 0;
      const durMatch = html.match(/"video_duration"\s*:\s*"?(\d+)"?/) || html.match(/"duration"\s*:\s*"?(\d{2,})"?/);
      if (durMatch) duration = parseInt(durMatch[1]);

      console.log(`[${this.name}] Extracting video formats...`);

      const formats = [];
      const standardHeaders = {
        'Referer': url,
        'Origin': 'https://www.youporn.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Method 1: Look for video data in JSON (YouPorn often embeds data in window.wpData or similar)
      // Try multiple JSON patterns
      let videoDataMatch = html.match(/mediaDefinition['"]\s*:\s*(\[[\s\S]*?\])/);
      if (!videoDataMatch) {
        // Alternative pattern: "mediaDefinitions":[...]
        videoDataMatch = html.match(/mediaDefinitions?['"]\s*:\s*(\[[\s\S]*?\])/);
      }
      if (!videoDataMatch) {
        // Alternative pattern: sources:[...]
        videoDataMatch = html.match(/sources['"]\s*:\s*(\[[\s\S]*?\])/);
      }
      if (!videoDataMatch) {
        // Alternative pattern: formats:[...]
        videoDataMatch = html.match(/formats?['"]\s*:\s*(\[[\s\S]*?\])/);
      }
      
      if (videoDataMatch) {
        try {
          const jsonStr = videoDataMatch[1];
          const mediaData = JSON.parse(jsonStr);
          
          console.log(`[${this.name}] Found media data with ${mediaData.length} entries`);
          
          for (const media of mediaData) {
            // Try different property names for URL and quality
            const videoUrl = media.videoUrl || media.url || media.src || media.link;
            const qualityStr = media.quality || media.format || media.label || media.height;
            
            if (videoUrl && qualityStr) {
              // Parse quality as number
              const qualityNum = parseInt(String(qualityStr).replace(/\D/g, ''));
              const height = qualityNum || 720;
              
              if (height >= 240 && height <= 4320) {
                // Detect if URL is HLS (m3u8) or direct MP4
                const isHLS = videoUrl.includes('.m3u8') || videoUrl.includes('/hls/') || videoUrl.includes('m3u8');
                
                formats.push({
                  quality: `${height}p`,
                  url: videoUrl,
                  width: Math.round(height * 16 / 9),
                  height: height,
                  format_id: `${height}p`,
                  ext: isHLS ? 'm3u8' : 'mp4',
                  protocol: isHLS ? 'hls' : 'https',
                  headers: standardHeaders
                });
                
                console.log(`[${this.name}] Found ${height}p from JSON (${isHLS ? 'HLS' : 'MP4'}): ${videoUrl.substring(0, 80)}...`);
              }
            }
          }
        } catch (e) {
          console.log(`[${this.name}] Failed to parse media JSON: ${e.message}`);
        }
      }

      // Method 2: Look for HLS playlist (m3u8)
      if (formats.length === 0) {
        const hlsMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/);
        if (hlsMatch) {
          try {
            console.log(`[${this.name}] Found HLS playlist, fetching qualities...`);
            const hlsUrl = hlsMatch[1];
            const hlsResponse = await got(hlsUrl, {
              headers: standardHeaders,
              timeout: { request: 10000 }
            });
            const m3u8Content = hlsResponse.body;
            
            // Parse HLS master playlist for different quality streams
            const lines = m3u8Content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.startsWith('#EXT-X-STREAM-INF')) {
                // Parse resolution from stream info
                const resMatch = line.match(/RESOLUTION=(\d+)x(\d+)/);
                if (resMatch && i + 1 < lines.length) {
                  const width = parseInt(resMatch[1]);
                  const height = parseInt(resMatch[2]);
                  const streamUrl = lines[i + 1].trim();
                  
                  // Make sure the URL is absolute
                  let fullUrl = streamUrl;
                  if (!streamUrl.startsWith('http')) {
                    const baseUrl = hlsUrl.substring(0, hlsUrl.lastIndexOf('/') + 1);
                    fullUrl = baseUrl + streamUrl;
                  }
                  
                  if (fullUrl && fullUrl.startsWith('http')) {
                    const quality = `${height}p`;
                    formats.push({
                      quality,
                      url: fullUrl,
                      width,
                      height,
                      format_id: quality,
                      ext: 'm3u8',
                      protocol: 'hls',
                      headers: standardHeaders
                    });
                    console.log(`[${this.name}] Found HLS ${quality}: ${fullUrl.substring(0, 80)}...`);
                  }
                }
              }
            }
          } catch (e) {
            console.log(`[${this.name}] Failed to parse HLS playlist: ${e.message}`);
          }
        }
      }

      // Method 2.5: Look for quality:URL pairs in JavaScript/JSON anywhere in page
      if (formats.length === 0) {
        console.log(`[${this.name}] Searching for quality:URL pairs in JavaScript...`);
        
        // Pattern: "1080":"http://url.mp4" or '720':'http://url.mp4'
        const qualityUrlPattern = /['"](\d{3,4})p?['"]\s*:\s*['"]([^'"]+\.mp4[^'"]*)['"]/g;
        const matches = [...html.matchAll(qualityUrlPattern)];
        
        console.log(`[${this.name}] Found ${matches.length} quality:URL pairs`);
        
        for (const match of matches) {
          const height = parseInt(match[1]);
          const videoUrl = match[2];
          
          if (height >= 240 && height <= 4320 && videoUrl.startsWith('http')) {
            const quality = `${height}p`;
            
            if (!formats.some(f => f.quality === quality)) {
              formats.push({
                quality,
                url: videoUrl,
                width: Math.round(height * 16 / 9),
                height,
                format_id: quality,
                ext: 'mp4',
                protocol: 'https',
                headers: standardHeaders
              });
              console.log(`[${this.name}] Found ${quality} from JS pair: ${videoUrl.substring(0, 80)}...`);
            }
          }
        }
      }

      // Method 3: Look for MP4 URLs in the page
      if (formats.length === 0) {
        console.log(`[${this.name}] Searching for MP4 URLs in HTML...`);
        const mp4Pattern = /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/g;
        const mp4Matches = [...html.matchAll(mp4Pattern)];
        
        console.log(`[${this.name}] Found ${mp4Matches.length} MP4 URLs`);
        
        // Show first few URLs for debugging
        if (mp4Matches.length > 0 && mp4Matches.length <= 5) {
          mp4Matches.forEach((m, i) => {
            console.log(`[${this.name}] Sample ${i + 1}: ${m[1].substring(0, 100)}...`);
          });
        } else if (mp4Matches.length > 5) {
          console.log(`[${this.name}] Sample 1: ${mp4Matches[0][1].substring(0, 100)}...`);
          console.log(`[${this.name}] Sample 2: ${mp4Matches[1][1].substring(0, 100)}...`);
        }
        
        const urlMap = new Map();
        
        for (const match of mp4Matches) {
          const videoUrl = match[1];
          
          // Try multiple quality extraction patterns for YouPorn URLs
          let qualityMatch = null;
          let height = null;
          
          // Pattern 1: /720p/ or /1080p/ in path
          qualityMatch = videoUrl.match(/\/(\d{3,4})p\//);
          if (!qualityMatch) {
            // Pattern 2: _720p.mp4 or _1080p.mp4 in filename
            qualityMatch = videoUrl.match(/_(\d{3,4})p\.mp4/);
          }
          if (!qualityMatch) {
            // Pattern 3: /720/ or /1080/ in path (without 'p')
            qualityMatch = videoUrl.match(/\/(\d{3,4})\//);
          }
          if (!qualityMatch) {
            // Pattern 4: -720.mp4 or -1080.mp4
            qualityMatch = videoUrl.match(/-(\d{3,4})\.mp4/);
          }
          if (!qualityMatch) {
            // Pattern 5: ?quality=720 or &quality=720 in query string
            qualityMatch = videoUrl.match(/[?&]quality=(\d{3,4})/);
          }
          if (!qualityMatch) {
            // Pattern 6: /files/quality/ path structure
            qualityMatch = videoUrl.match(/\/files\/(\d{3,4})\//);
          }
          if (!qualityMatch) {
            // Pattern 7: Look anywhere in URL for quality number between slashes or underscores
            const allNumbers = videoUrl.match(/[\/_-](\d{3,4})[\/_\-\.]/g);
            if (allNumbers) {
              for (const num of allNumbers) {
                const extracted = parseInt(num.match(/(\d{3,4})/)[1]);
                if (extracted >= 240 && extracted <= 4320) {
                  height = extracted;
                  break;
                }
              }
            }
          }
          
          if (qualityMatch && !height) {
            height = parseInt(qualityMatch[1]);
          }
          
          if (height && height >= 240 && height <= 4320) {
            const quality = `${height}p`;
            
            if (!urlMap.has(quality)) {
              const isHLS = videoUrl.includes('.m3u8') || videoUrl.includes('/hls/') || videoUrl.includes('m3u8');
              
              urlMap.set(quality, {
                quality,
                url: videoUrl,
                width: Math.round(height * 16 / 9),
                height,
                format_id: quality,
                ext: isHLS ? 'm3u8' : 'mp4',
                protocol: isHLS ? 'hls' : 'https',
                headers: standardHeaders
              });
              console.log(`[${this.name}] Extracted ${quality} (${isHLS ? 'HLS' : 'MP4'}): ${videoUrl.substring(0, 80)}...`);
            }
          }
        }
        
        for (const format of urlMap.values()) {
          formats.push(format);
        }
      }

      // Method 4: Fallback - look for any video source
      if (formats.length === 0) {
        console.log(`[${this.name}] Using fallback method, looking for video sources...`);
        const videoSrcMatch = html.match(/src=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i);
        if (videoSrcMatch) {
          formats.push({
            quality: 'default',
            url: videoSrcMatch[1],
            width: 1280,
            height: 720,
            format_id: '720p',
            ext: 'mp4',
            protocol: 'https',
            headers: standardHeaders
          });
          console.log(`[${this.name}] Found default video source (fallback)`);
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

export default YouPornExtractor;
