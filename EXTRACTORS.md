# Site Extractor Guide

## Overview

videodl-cli now includes built-in extractors for popular video sites, similar to yt-dlp. This allows you to download videos from sites that don't provide direct download links.

## Supported Sites

21 built-in extractors:
- ✅ **YouTube** — metadata extraction (downloads limited, see [YOUTUBE-LIMITATIONS.md](YOUTUBE-LIMITATIONS.md))
- ✅ **xHamster** — full support
- ✅ **PornHub** — full support
- ✅ **XVideos** — full support
- ✅ **XNXX** — full support
- ✅ **YouPorn** — HLS streaming
- ✅ **RedTube** — full support
- ✅ **Tube8** — full support
- ✅ **Facebook** — facebook.com, fb.watch
- ✅ **Vimeo** — full support
- ✅ **Indavideo** — indavideo.hu
- ✅ **Videa** — videa.hu, videakid.hu
- ✅ **Motherless** — full support
- ✅ **InPorn** — full support
- ✅ **TnaFlix** — tnaflix.com, empflix.com
- ✅ **TubeSafari** — xHamster embeds
- ✅ **PornOne** — full support
- ✅ **PornZog** — HClips embeds
- ✅ **UncensoredHentai** — full support
- ✅ **Brazzers** — cookie-authenticated
- ✅ **KVS** — generic KVS engine (covers many sites)
- ✅ **Direct URLs** — any `.mp4`, `.mkv`, `.webm`, `.m3u8` URL

## Usage

### List Available Formats

Before downloading, you can see all available formats:

```bash
videodl list-formats "https://xhamster.com/videos/video-id"
```

Output:
```
Available formats:
──────────────────────────────────────────────────────────────────────────────
   0. 1080p        1080p    mp4   
   1. 720p         720p     mp4   
   2. 480p         480p     mp4   
   3. 240p         240p     mp4   
──────────────────────────────────────────────────────────────────────────────
```

### Download Specific Quality

Download with quality selection:

```bash
# Download best quality (default)
videodl download "URL" -f best

# Download 720p
videodl download "URL" -f 720p

# Download worst quality (fastest, smallest file)
videodl download "URL" -f worst

# Specific resolution
videodl download "URL" -f 1080p
```

### Download from xHamster

Example with the URL you provided:

```bash
# List available formats first
videodl list-formats "https://xhamster.com/videos/impromptu-anal-orgasms-xhk6fU9"

# Download in 720p
videodl download "https://xhamster.com/videos/impromptu-anal-orgasms-xhk6fU9" -f 720p -o video-720p.mp4

# Download best quality
videodl download "https://xhamster.com/videos/impromptu-anal-orgasms-xhk6fU9" -f best

# Download and convert to different format
videodl dl-convert "https://xhamster.com/videos/impromptu-anal-orgasms-xhk6fU9" output.mkv -q 720p
```

### Linux Usage

The tool is fully cross-platform and works identically on Linux:

```bash
# On Linux/Ubuntu
sudo apt install nodejs npm ffmpeg
cd videodl-cli
npm install
npm link

# Or run directly
node src/cli.js download "URL" -f 720p

# Or use the setup script
chmod +x setup.sh
./setup.sh
```

## How It Works

### Extractor Architecture

```
URL -> getExtractor() -> Specific Extractor -> Extract video sources -> Select quality -> Download
```

1. **URL Analysis**: Determines which extractor to use based on URL pattern
2. **Page Fetching**: Downloads the webpage with proper headers
3. **Source Extraction**: Parses HTML/JSON to find video URLs
4. **Format Selection**: Selects the requested quality or best available
5. **Download**: Downloads the selected format

### xHamster Extractor

The xHamster extractor:
- Fetches the video page with browser-like headers
- Extracts JSON data embedded in the page (`window.initials`)
- Finds all available video sources with quality information
- Returns formats sorted by quality (highest first)

Methods used:
1. Parse `window.initials` JSON object
2. Extract video URLs from script tags
3. Find m3u8 playlists as fallback

## Quality Selection

### Available Options

- `best` - Highest quality available (default)
- `worst` - Lowest quality (smallest file, fastest download)
- `720p`, `1080p`, `480p`, etc. - Specific resolution
- Format ID - Use specific format ID from `list-formats`

### Quality Matching

When you specify a quality like `720p`:
1. Looks for exact match (720p format)
2. If not found, selects closest available quality
3. Prefers higher quality over lower if equally distant

## Testing

Test the extractor without downloading:

```bash
# Test extraction
node test-extractor.js "https://xhamster.com/videos/impromptu-anal-orgasms-xhk6fU9"
```

Expected output:
```
Supported Sites:
  • XHamster

Testing URL: https://xhamster.com/videos/...

Video Information:
  Title:     impromptu anal orgasms
  ID:        xhk6fU9
  Extractor: XHamster

Available Formats (4):
  1   1080p        1080p        mp4    https://...
  2   720p         720p         mp4    https://...
  3   480p         480p         mp4    https://...
  4   240p         240p         mp4    https://...

Testing format selection:
  best       -> 1080p (1080p)
  720p       -> 720p (720p)
  480p       -> 480p (480p)
  worst      -> 240p (240p)

✓ All tests passed!
```

## Troubleshooting

### "No video formats found"

The site may have changed its HTML structure. Solutions:
- Try with `--list-formats` to see raw output
- Report the issue with the URL
- Use browser DevTools to find video URLs manually

### "Extraction failed"

Common causes:
- Network/firewall blocking the request
- Site requires login/authentication
- Geographic restrictions
- Site structure changed

Try:
```bash
# Use proxy
videodl download "URL" -f 720p --proxy http://proxy:8080

# Disable SSL verification (not recommended)
videodl download "URL" -f 720p --no-ssl-verify

# Add custom headers
videodl download "URL" -f 720p -H "Cookie: session=xxx"
```

### Different Results than yt-dlp

yt-dlp uses complex extractors with multiple fallback methods. Our extractors are simpler and may not handle all edge cases. If yt-dlp fails too (like in your example), our extractor might also fail on that specific video.

## Adding New Extractors

To add support for a new site:

1. Create extractor file: `src/extractors/newsite.js`

```javascript
import { BaseExtractor } from './base.js';
import got from 'got';

export class NewSiteExtractor extends BaseExtractor {
  constructor() {
    super();
    this.name = 'NewSite';
  }

  static canHandle(url) {
    return /newsite\.com/i.test(url);
  }

  async extract(url, options = {}) {
    // Fetch page
    const response = await got(url);
    const html = response.body;
    
    // Extract video info
    // ... parsing logic ...
    
    return {
      id: 'video-id',
      title: 'Video Title',
      formats: [
        { quality: '720p', url: 'https://...', height: 720, ext: 'mp4' }
      ],
      url,
      extractor: this.name
    };
  }
}
```

2. Register in `src/extractors/index.js`:

```javascript
import { NewSiteExtractor } from './newsite.js';

const EXTRACTORS = [
  NewSiteExtractor,
  XHamsterExtractor,
  DirectExtractor
];
```

3. Test:

```bash
node test-extractor.js "https://newsite.com/video"
```

## API Usage

Use extractors programmatically:

```javascript
import { extractVideoInfo, getExtractor } from './src/extractors/index.js';
import { VideoDownloader } from './src/downloader.js';

// Extract video info
const videoInfo = await extractVideoInfo('https://xhamster.com/videos/...');
console.log(`Title: ${videoInfo.title}`);
console.log(`Formats: ${videoInfo.formats.length}`);

// Select quality
const extractor = getExtractor(url);
const format = extractor.selectFormat(videoInfo.formats, '720p');

// Download
const downloader = new VideoDownloader();
await downloader.download({
  url: format.url,
  filename: `${videoInfo.title}.mp4`
});
```

## Comparison with yt-dlp

| Feature | yt-dlp | videodl-cli |
|---------|--------|--------------|
| Sites Supported | 1000+ | Growing |
| Extractor Complexity | Very High | Moderate |
| Fallback Methods | Multiple | Single/Double |
| Maintenance | Active | New |
| Dependencies | Python | Node.js |
| Speed | Fast | Fast |
| Success Rate | Very High | Good |

## Notes

- Extractors work on both Windows and Linux
- Some sites may block automated access
- Quality availability depends on the original video
- Geographic restrictions may apply
- Authentication may be required for some content

## Future Plans

- More site extractors (YouTube, Vimeo, etc.)
- Better error handling and fallback methods
- Playlist extraction
- Subtitle extraction
- Live stream recording
- Multi-part video handling
