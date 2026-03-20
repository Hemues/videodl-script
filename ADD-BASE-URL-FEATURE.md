# Base URL in Filename Feature (Default Behavior)

## Overview
By default, the tool automatically adds the base domain name to downloaded video filenames, making it easier to identify the source of videos. Use `--no-base-url` to disable this behavior.

## Usage

### Default Behavior (domain added automatically)
```bash
videodl download "https://www.xvideos.com/video.ouomvii5e97/my_best_friends_mom" -f 720p
```
**Result:** `y_best_friends_Mom_treats_me_like_family-xvideos.com.mp4`

### Disable with --no-base-url
```bash
videodl download "https://www.xvideos.com/video.ouomvii5e97/my_best_friends_mom" -f 720p --no-base-url
```
**Result:** `y_best_friends_Mom_treats_me_like_family.mp4`

## Examples

### XVideos (with domain - default)
```bash
videodl download "https://www.xvideos.com/video12345/example_video"
```
Output: `example_video-xvideos.com.mp4`

### XVideos (without domain)
```bash
videodl download "https://www.xvideos.com/video12345/example_video" --no-base-url
```
Output: `example_video.mp4`

### PornHub (with domain - default)
```bash
videodl download "https://www.pornhub.com/view_video.php?viewkey=abc123" -f 1080p
```
Output: `Video_Title_Here-pornhub.com.mp4`

### xHamster (with domain - default)
```bash
videodl download "https://xhamster.com/videos/example-123" -f 720p
```
Output: `Video_Title_Here-xhamster.com.mp4`

## How It Works

1. **Domain Extraction**: Extracts the hostname from the URL (e.g., `xvideos.com`, `pornhub.com`)
2. **www Removal**: Automatically removes the `www.` prefix if present
3. **Filename Construction**: Appends `-<domain>` before the file extension
4. **Sanitization**: Still applies to title (alphanumeric only + underscores)

## Format

```
<sanitized_title>-<domain>.<extension>
```

Where:
- `<sanitized_title>`: Video title with only alphanumeric characters and underscores
- `<domain>`: Base domain without www (e.g., xvideos.com, pornhub.com)
- `<extension>`: File extension (mp4, m3u8, etc.)

## Important Notes

1. **Custom Output Names**: If you specify `-o` or `--output`, the domain is NOT added (your custom name is used as-is)
   ```bash
   # This will use "my-custom-name.mp4" (no domain added)
   videodl download "https://xvideos.com/..." -o "my-custom-name.mp4"
   ```

2. **All Extractors**: Works with all supported sites by default:
   - xvideos.com → `video_title-xvideos.com.mp4`
   - pornhub.com → `video_title-pornhub.com.mp4`
   - xhamster.com → `video_title-xhamster.com.mp4`
   - Direct URLs → Uses full domain

3. **Disable for Direct URLs**: Use `--no-base-url` when downloading direct video files if you don't want the domain
   ```bash
   videodl download "https://server.com/files/video.mp4" --no-base-url
   ```

4. **Subfolder Downloads**: Works with the `-d` directory option
   ```bash
   videodl download "url" -d "./videos/favorites"
   # Result: ./videos/favorites/video_title-xvideos.com.mp4
   ```

## Command Line Options Compatibility

The base domain feature works by default with all other options:

```bash
# Default behavior (domain added)
videodl download "URL" -f 1080p -d "./downloads"
# Result: video_title-domain.com.mp4

# Disable domain in filename
videodl download "URL" -f 1080p -d "./downloads" --no-base-url -H "Custom-Header: Value"
# Result: video_title.mp4
```

## Use Cases

1. **Organize by Source**: Quickly identify which site a video came from (default behavior)
2. **Avoid Filename Conflicts**: Videos with the same title from different sites won't overwrite each other
3. **Batch Downloads**: When downloading from multiple sites, filenames automatically stay organized
4. **Archive Management**: Makes it easier to manage large video collections with clear source identification

## Testing

To test the default behavior:
```bash
# List formats to see the video title
videodl download "URL" --list-formats

# Download with domain (default)
videodl download "URL" -f 720p
# Filename will be: video_title-domain.com.mp4

# Download without domain
videodl download "URL" -f 720p --no-base-url
# Filename will be: video_title.mp4
```

## Implementation Details

The feature:
- **Enabled by default** - Domain is automatically added to all filenames
- Uses `--no-base-url` flag to disable
- Available on the `download` command
- Available on the `dl-convert` command (for consistency)
- Extracts domain using Node.js URL parser
- Inserts domain before the file extension
- Gracefully handles edge cases (malformed URLs, missing domains)
- Respects custom output names (when `-o` is used, domain is not added)
