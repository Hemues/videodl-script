/**
 * XVideos Extractor
 * Extracts video URLs from xvideos.com
 */

import { BaseExtractor } from './base.js';
import got from 'got';

export class XVideosExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'XVideos';
  }

  static canHandle(url) {
    return /xvideos\.com/i.test(url);
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
          'Referer': 'https://www.xvideos.com/'
        },
        timeout: {
          request: 30000
        },
        followRedirect: true
      });

      const html = response.body;

      // Extract video ID from URL
      const videoIdMatch = url.match(/video\.([a-zA-Z0-9]+)\//);
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
          .replace(/ - XVIDEOS\.COM$/i, '')
          .replace(/ - XVideos\.com$/i, '')
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
      
      // Method 3: Look for video title in page heading
      if (!title) {
        const h2TitleMatch = html.match(/<h2[^>]*class=["'][^"']*title[^"']*["'][^>]*>([^<]+)<\/h2>/i);
        if (h2TitleMatch) {
          title = decodeHtmlEntities(h2TitleMatch[1]).trim();
        }
      }
      
      // Fallback: Use video ID
      if (!title || title.length === 0) {
        title = `video_${videoId}`;
      }

      // Extract duration (seconds)
      let duration = 0;
      const durFnMatch = html.match(/setVideoDuration\(['"]?(\d+)['"]?\)/);
      if (durFnMatch) {
        duration = parseInt(durFnMatch[1]);
      } else {
        const durMetaMatch = html.match(/<meta\s+property=["']og:(?:video:)?duration["']\s+content=["'](\d+)["']/i)
                          || html.match(/"duration"\s*:\s*(\d{2,})/);
        if (durMetaMatch) duration = parseInt(durMetaMatch[1]);
      }

      console.log(`[${this.name}] Extracting video formats...`);

      const formats = [];
      const standardHeaders = {
        'Referer': url,
        'Origin': 'https://www.xvideos.com',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      };

      // Method 1: Look for HLS playlists FIRST (most reliable for multiple qualities)
      const hlsMatch = html.match(/setVideoHLS\(['"]([^'"]+)['"]\)/);
      if (hlsMatch && hlsMatch[1].startsWith('http')) {
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

      // Method 2: Look for all MP4 URLs - XVideos uses multiple patterns
      if (formats.length === 0) {
        console.log(`[${this.name}] No HLS found, searching for MP4 URLs...`);
        // Search for all .mp4 URLs in the HTML
        const allMp4Pattern = /(https?:\/\/[^\s'"<>]+\.mp4[^\s'"<>]*)/g;
        const allMp4Matches = [...html.matchAll(allMp4Pattern)];
        
        console.log(`[${this.name}] Found ${allMp4Matches.length} MP4 URLs in HTML`);
        
        const urlMap = new Map(); // Track URLs by quality to avoid duplicates
        
        for (const match of allMp4Matches) {
          const videoUrl = match[1];
          
          // Try to extract quality from URL
          // Pattern 1: /files/quality/hash.mp4
          let qualityMatch = videoUrl.match(/\/files\/(\d+)\//);
          if (!qualityMatch) {
            // Pattern 2: /quality/hash.mp4 or hash-quality.mp4
            qualityMatch = videoUrl.match(/\/(\d{3,4})\//);
          }
          if (!qualityMatch) {
            // Pattern 3: Look for quality in filename like video-1080.mp4
            qualityMatch = videoUrl.match(/-(\d{3,4})\.mp4/);
          }
          
          if (!qualityMatch) continue;
          
          const qualityNum = parseInt(qualityMatch[1]);
          if (qualityNum < 240 || qualityNum > 4320) continue; // Skip invalid quality numbers
          
          let quality, height;
          if (qualityNum >= 2160) {
            quality = '2160p';
            height = 2160;
          } else if (qualityNum >= 1440) {
            quality = '1440p';
            height = 1440;
          } else if (qualityNum >= 1080) {
            quality = '1080p';
            height = 1080;
          } else if (qualityNum >= 720) {
            quality = '720p';
            height = 720;
          } else if (qualityNum >= 480) {
            quality = '480p';
            height = 480;
          } else if (qualityNum >= 360) {
            quality = '360p';
            height = 360;
          } else {
            quality = '240p';
            height = 240;
          }
          
          // Keep the URL for each quality (prefer longer URLs as they may have more complete paths)
          const existing = urlMap.get(quality);
          if (!existing || videoUrl.length > existing.url.length) {
            urlMap.set(quality, {
              quality,
              url: videoUrl,
              width: Math.round(height * 16 / 9),
              height,
              format_id: quality,
              ext: 'mp4',
              protocol: 'https',
              headers: standardHeaders
            });
          }
        }
        
        // Add all unique quality formats
        for (const format of urlMap.values()) {
          formats.push(format);
          console.log(`[${this.name}] Extracted ${format.quality}`);
        }
      }

      // Method 3: Parse video data from JavaScript objects
      if (formats.length === 0) {
        console.log(`[${this.name}] No MP4 URLs found, checking JavaScript objects...`);
        // Try to find quality/URL pairs in JavaScript
        const jsQualityUrls = html.matchAll(/['"]?(\d{3,4})['"]?\s*:\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/g);
        const jsMatches = [...jsQualityUrls];
        console.log(`[${this.name}] Found ${jsMatches.length} quality:URL pairs in JavaScript`);
        
        for (const match of jsMatches) {
          const qualityNum = parseInt(match[1]);
          const videoUrl = match[2];
          
          if (qualityNum < 240 || qualityNum > 4320) continue;
          
          let height = qualityNum;
          formats.push({
            quality: `${height}p`,
            url: videoUrl,
            width: Math.round(height * 16 / 9),
            height,
            format_id: `${height}p`,
            ext: 'mp4',
            protocol: 'https',
            headers: standardHeaders
          });
          console.log(`[${this.name}] Extracted ${height}p from JavaScript`);
        }
      }

      // Method 4: Fallback to setVideoUrlHigh/Low but also look for additional qualities
      if (formats.length === 0) {
        console.log(`[${this.name}] Using fallback method, searching for all setVideoUrl* functions...`);
        
        // Search for ALL setVideoUrl variations (not just High and Low)
        // XVideos may use: setVideoUrl, setVideoUrlHigh, setVideoUrlLow, setVideoUrlHD, etc.
        const videoUrlPattern = /setVideoUrl(High|Low|HD|1080p|720p|480p|360p|240p)?\(['"]([^'"]+)['"]\)/g;
        const videoUrlMatches = [...html.matchAll(videoUrlPattern)];
        
        console.log(`[${this.name}] Found ${videoUrlMatches.length} setVideoUrl function calls`);
        
        for (const match of videoUrlMatches) {
          const qualityLabel = match[1] || 'default';
          const videoUrl = match[2];
          
          // Map quality labels to actual resolutions
          let quality, height;
          if (/1080p?|hd/i.test(qualityLabel)) {
            quality = '1080p';
            height = 1080;
          } else if (/720p?|high/i.test(qualityLabel)) {
            quality = '720p';
            height = 720;
          } else if (/480p?/i.test(qualityLabel)) {
            quality = '480p';
            height = 480;
          } else if (/360p?|low/i.test(qualityLabel)) {
            quality = '360p';
            height = 360;
          } else if (/240p?/i.test(qualityLabel)) {
            quality = '240p';
            height = 240;
          } else {
            // For 'default' or other labels, try to detect from URL
            console.log(`[${this.name}] Found setVideoUrl${qualityLabel}: ${videoUrl.substring(0, 60)}...`);
            continue; // Skip unknown qualities for now
          }
          
          // Only add if we don't already have this quality
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
            console.log(`[${this.name}] Found ${quality} URL (from setVideoUrl${qualityLabel})`);
          }
        }
        
        // If still no formats, issue a warning
        if (formats.length === 0) {
          console.log(`[${this.name}] WARNING: No video URLs found at all!`);
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

export default XVideosExtractor;
