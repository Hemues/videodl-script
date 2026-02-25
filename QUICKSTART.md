# Video Downloader CLI - Quick Start

## Installation

```bash
npm install
npm link  # Make globally available
```

## Basic Commands

### 1. Download a video
```bash
videodl download https://example.com/video.mp4
```

### 2. Convert a video
```bash
videodl convert input.mp4 output.mkv
```

### 3. Download and convert
```bash
videodl dl-convert https://example.com/video.mp4 output.mp4 -s 1280x720
```

### 4. Get video info
```bash
videodl probe video.mp4
```

### 5. Check system info
```bash
videodl info
```

## Common Options

**Download:**
- `-o, --output <filename>` - Specify output filename
- `-d, --directory <path>` - Output directory
- `-H, --header <header>` - Add custom header
- `--proxy <url>` - Use proxy

**Convert:**
- `-vc, --video-codec <codec>` - Video codec (libx264, libx265, etc.)
- `-ac, --audio-codec <codec>` - Audio codec (aac, mp3, etc.)
- `-s, --resolution <res>` - Resolution (1920x1080, 1280x720, etc.)
- `-vb, --video-bitrate <bitrate>` - Video bitrate (2M, 5000k)
- `-ab, --audio-bitrate <bitrate>` - Audio bitrate (128k, 320k)
- `-f, --format <format>` - Output format

## Examples

### Download with authentication
```bash
videodl download https://api.example.com/video.mp4 \
  -H "Authorization: Bearer TOKEN" \
  -o secure-video.mp4
```

### Convert to web-friendly format
```bash
videodl convert input.mov output.mp4 \
  -vc libx264 \
  -ac aac \
  -s 1920x1080 \
  -vb 4M
```

### Download and convert to 720p
```bash
videodl dl-convert https://example.com/hd-video.mp4 output-720p.mp4 \
  -s 1280x720 \
  -vb 2M \
  -ab 128k
```

## Prerequisites

- Node.js >= 18
- ffmpeg and ffprobe in PATH

Check ffmpeg:
```bash
ffmpeg -version
```

## See README.md for full documentation
