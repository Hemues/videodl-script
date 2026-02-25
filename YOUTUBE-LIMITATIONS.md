# YouTube Support - Known Limitations

## Status

The YouTube extractor can:
- ✅ Extract video metadata (title, video ID)
- ✅ Parse available formats from the page
- ✅ Identify format quality and codecs
- ⚠️ Download limitations (see below)

## Download Limitations

YouTube implements several protections that make direct downloading challenging:

### 1. IP Address Binding
YouTube embeds IP addresses in video URLs (e.g., `ip=x.x.x.x`). Requests must come from the same IP that fetched the page.

### 2. Bot Detection
YouTube's sophisticated bot detection may block automated download attempts, resulting in **403 Forbidden** errors.

### 3. Signature Encryption
Most high-quality formats use encrypted signatures (`signatureCipher`) instead of direct URLs, requiring JavaScript execution to decrypt.

### 4. Limited Direct URLs
Only low-quality formats (typically 360p) provide direct URLs. Higher qualities (720p, 1080p, 4K) use adaptive streaming with encrypted signatures.

## Current Behavior

**Test Video**: `https://www.youtube.com/watch?v=<VIDEO_ID>`

**Extraction**: ✅ Works
```
[YouTube] Video ID: cWVKSQjsmTE
[YouTube] Title: Toyota Auris 1.8 HSD Teszt - Bemutató - Eladó
[YouTube] Found 26 formats
[YouTube] Found 360p video/mp4 (video+audio)
```

**Download**: ❌ 403 Forbidden
```
Error: Request failed with status code 403 (Forbidden)
```

## Why This Happens

1. **360p format** is the onlyformat with a direct URL out of 26 total formats
2. **URL contains**: `ip=x.x.x.x` (IP binding)
3. **URL expires**: Contains `expire=1770760388` timestamp
4. **Bot detection**: YouTube detects automated access

## Workarounds

### Option 1: Use yt-dlp Backend
For reliable YouTube downloads, integrate with yt-dlp:
```bash
# Install yt-dlp
pip install yt-dlp

# Use from Node.js
import { exec } from 'child_process';
exec('yt-dlp -f best "URL"', (error, stdout, stderr) => {
  // Handle download
});
```

### Option 2: Browser Automation
Use Puppeteer/Playwright to access YouTube as a real browser:
- Executes JavaScript
- Maintains cookies and session
- Bypasses bot detection
- Can decrypt signatures

### Option 3: Accept Limitations
- Only extract metadata
- Link to YouTube directly for viewing
- Document that download may not work

## Recommended Approach

For the videodl-cli project:

1. **Keep the current extractor** for metadata extraction
2. **Document limitations** in README
3. **Add yt-dlp integration** as optional backend:
   ```javascript
   // Check if yt-dlp is available
   if (isYouTubeUrl(url) && ytDlpAvailable()) {
     return await downloadWithYtDlp(url);
   }
   ```

## Testing Status

All header combinations tested:
- ❌ Original headers → 403
- ❌ With Range header → 403
- ❌ Minimal headers → 403
- ❌ Browser-like headers → 403
- ❌ With cookies → 403
- ❌ Raw HTTPS module → 403

**Conclusion**: The 403 error is not a header/client issue but YouTube's access control.

## Future Enhancements

1. Add yt-dlp backend support
2. Implement signature decryption (complex)
3. Add browser automation option
4. Cache working URLs (limited by expiration)
5. Support age-restricted videos
6. Handle private/unlisted videos

## User Communication

When YouTube download fails:
```
⚠️  YouTube download blocked (403 Forbidden)

YouTube restricts direct video downloads. This video may require:
- yt-dlp: Install with 'pip install yt-dlp'
- Browser: Play directly at the original URL

Metadata extracted successfully:
  Title: Toyota Auris 1.8 HSD Teszt - Bemutató - Eladó
  Quality: 360p (640x360)
```

## Related Issues

- IP address binding in URLs
- Signature encryption (requires JS execution)
- Bot detection (sophisticated fingerprinting)
- Rate limiting (too many requests → temporary ban)
- Geo-restrictions (some videos blocked by country)

## References

- yt-dlp: https://github.com/yt-dlp/yt-dlp
- YouTube Data API: https://developers.google.com/youtube/v3
- Video DownloadHelper approach: Use browser extension context
