/**
 * Comprehensive help text for videodl CLI
 * Styled after youtube-dl / yt-dlp help output
 */

import { listSupportedSites } from './extractors/index.js';

const VERSION = '__VERSION__'; // replaced at build time or read from package.json

export function getFullHelp(version) {
  const ver = version || VERSION;
  return `Usage: videodl [OPTIONS] COMMAND [ARGS]
       videodl download [OPTIONS] URL
       videodl convert  [OPTIONS] INPUT OUTPUT

videodl ${ver} — A CLI video downloader and converter.
Similar to yt-dlp / youtube-dl but with built-in site extractors and
DASH merging, HLS download, subtitle support, and format conversion.

General Options:
  -V, --version                Show version number and exit
  -h, --help                   Show this help message and exit

Commands:
  download <url>               Download a video from a URL
  convert <input> <output>     Convert a video file to a different format
  dl-convert <url> <output>    Download and convert in one step
  list-formats <url>           List available formats for a URL
  generate-cookies             Generate/refresh cookies (only if expired)
  sites                        List all supported sites
  extractors                   List all extractors with URL patterns
  probe <file>                 Show media file information
  info                         Show ffmpeg installation info
  formats                      List supported output formats (ffmpeg)
  codecs                       List supported codecs (ffmpeg)

Download Options:
  -o, --output <filename>      Output filename (overrides auto-generated name)
  -d, --directory <path>       Output directory (default: ./downloads)
  -f, --format <quality>       Quality/format to download
                                 (none)  — 720p if available, otherwise best (default)
                                 best    — highest quality available
                                 worst   — lowest quality / smallest file
                                 720p    — specific resolution
                                 1080p   — specific resolution
  -H, --header <header>        Add custom HTTP header (repeatable)
                                 Example: -H "Referer: https://example.com"
      --list-formats           List available formats without downloading
      --no-base-url            Do not prepend domain to output filename
                                 (domain is added by default)

Network Options:
      --no-ssl-verify          Disable SSL certificate verification
      --proxy <url>            Use an HTTP/SOCKS proxy
                                 Example: --proxy socks5://127.0.0.1:9050

Cookie / Authentication Options:
      --cookies <file>         Netscape/Mozilla cookie file (same format
                                 as yt-dlp / curl / wget)
                                 Default: cookies/cookies.txt
      --generate-cookies       Auto-regenerate expired cookies from logins
                                 file before downloading
      --logins <file>          Login-details file for cookie generation
                                 Default: logins/logins.txt
                                 Format: loginPageUrl::username::password

Subtitle Options (download command):
      --no-subtitle            Do not download or embed subtitles
                                 (subtitles are included by default when
                                 available)
      --sub-lang <lang>        Subtitle language code to download
                                 en    — English
                                 hu    — Hungarian
                                 de    — German
                                 all   — download every available track
      --sub-translate <lang>   Auto-translate subtitles to this language
                                 (uses the source track + YouTube's
                                 translation API)

Conversion Options (convert / dl-convert):
  -vc, --video-codec <codec>   Video codec (libx264, libx265, vp9, ...)
  -ac, --audio-codec <codec>   Audio codec (aac, mp3, opus, ...)
  -vb, --video-bitrate <br>    Video bitrate (e.g., 2M, 5000k)
  -ab, --audio-bitrate <br>    Audio bitrate (e.g., 128k, 320k)
  -s,  --resolution <res>      Output resolution (e.g., 1920x1080)
  -r,  --fps <fps>             Frame rate (e.g., 30, 60)
  -f,  --format <fmt>          Output format (mp4, mkv, webm, avi, ...)
  -q,  --quality <q>           Quality factor (1-31, lower = better)
      --no-overwrite           Do not overwrite existing output file
      --keep-original          Keep the original file after conversion
                                 (dl-convert only)

Probe Options:
  -j, --json                   Output file info as JSON

Filename Formatting:
  By default, the output filename is built as:
    <sanitized_title>-<domain>.<ext>
  where <domain> is the source website (e.g., youtube.com).
  Use --no-base-url to omit the domain part.
  Use -o / --output to set an explicit filename.

  Special characters are stripped; Unicode letters are preserved.

Environment:
  FFmpeg is required for DASH merging, HLS downloads, and conversions.
  If ffmpeg is not found in PATH, videodl will automatically download
  a static build to ~/.videodl-cli/ffmpeg/ on first use.

  Cloudflare-protected CDNs are handled transparently via TLS fingerprint
  impersonation (requires the cycletls package at install time).

Exit Codes:
  0    Success
  1    Error (network, extraction, file I/O, etc.)

Examples:
  # Download best quality
  videodl download "https://www.youtube.com/watch?v=dQw4w9WgXcQ"

  # Download 720p to a specific folder
  videodl download -f 720p -d ~/Videos "https://example.com/video"

  # List available formats
  videodl download --list-formats "https://www.youtube.com/watch?v=ID"

  # Download with cookies (for age-restricted / members-only content)
  videodl download --cookies cookies.txt "https://example.com/video"

  # Download with auto cookie refresh (regenerates if expired)
  videodl download --generate-cookies "https://site-ma.brazzers.com/scene/123/slug"

  # Generate/refresh cookies (only expired ones)
  videodl generate-cookies

  # Force-regenerate all cookies
  videodl generate-cookies --force

  # Download with subtitles translated to Hungarian
  videodl download --sub-translate hu "https://www.youtube.com/watch?v=ID"

  # Convert MKV to MP4
  videodl convert input.mkv output.mp4

  # Download and convert in one step
  videodl dl-convert "https://example.com/video" output.mp4 -vc libx265

  # Show supported sites
  videodl sites

  # Show all extractors with URL patterns and class names
  videodl extractors
  videodl extractors --json

  # Probe a local file
  videodl probe video.mp4 --json

Report bugs: https://github.com/AiondaDotCom/edge-extension/issues
`;
}

export function getSupportedSitesHelp() {
  const sites = listSupportedSites();
  let text = 'Supported Sites:\n';
  sites.forEach(site => {
    text += `  • ${site}\n`;
  });
  text += '\n  Plus any direct video URL (.mp4, .mkv, .webm, .m3u8, etc.)\n';
  return text;
}
