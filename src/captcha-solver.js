/**
 * Free reCAPTCHA Solver — Audio Challenge + wit.ai Speech-to-Text
 *
 * Solves reCAPTCHA v2 challenges completely FREE using:
 *   1. Clicking the reCAPTCHA checkbox
 *   2. Switching to the audio challenge
 *   3. Downloading the audio MP3
 *   4. Transcribing via wit.ai's free speech-to-text API
 *   5. Typing the answer and verifying
 *
 * Requirements:
 *   - A free wit.ai account (https://wit.ai) — takes 2 minutes to set up
 *   - A wit.ai Server Access Token (found in Settings of any wit.ai app)
 *
 * Usage:
 *   videodl download <url> --generate-cookies --captcha-provider wit --captcha-key <WIT_TOKEN>
 *
 * Or set env vars:
 *   CAPTCHA_PROVIDER=wit
 *   CAPTCHA_API_KEY=<WIT_TOKEN>
 */

import got from 'got';

/* ─── reCAPTCHA iframe selectors ─────────────────────────────────── */

/** The main checkbox iframe ('I am not a robot') */
const MAIN_FRAME_SEL = "iframe[title='reCAPTCHA']";

/** The challenge popup iframe (image/audio challenge) */
const BFRAME_SELS = [
  "iframe[src*='google.com/recaptcha/api2/bframe']",
  "iframe[src*='google.com/recaptcha/enterprise/bframe']",
];

/* ─── Helpers ────────────────────────────────────────────────────── */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Find the reCAPTCHA challenge (bframe) iframe handle on the page.
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<import('puppeteer-core').ElementHandle|null>}
 */
async function findBframe(page) {
  for (const sel of BFRAME_SELS) {
    const handle = await page.$(sel);
    if (handle) return handle;
  }
  return null;
}

/**
 * Transcribe an MP3 audio buffer using wit.ai's free /dictation endpoint.
 *
 * wit.ai returns newline-delimited JSON chunks; the final chunk has
 * is_final: true and the complete transcription in .text.
 *
 * @param {Buffer} audioBuffer - MP3 audio data
 * @param {string} token       - wit.ai Bearer token
 * @param {boolean} verbose
 * @returns {Promise<string>}  - The transcribed text (empty on failure)
 */
async function transcribeWithWitAi(audioBuffer, token, verbose) {
  const log = (...args) => { if (verbose) console.log('[CaptchaSolver]', ...args); };

  try {
    const response = await got.post('https://api.wit.ai/dictation?v=20230215', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'audio/mpeg3',
      },
      body: audioBuffer,
      timeout: { request: 30000 },
    });

    // Parse newline-delimited JSON — keep last non-empty text
    const lines = response.body.split('\n').filter(l => l.trim());
    let finalText = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.text) finalText = obj.text;
      } catch { /* partial / non-JSON line */ }
    }
    return finalText.trim();
  } catch (err) {
    log('wit.ai transcription error:', err.message);
    return '';
  }
}

/* ─── Main solver ────────────────────────────────────────────────── */

/**
 * Solve a reCAPTCHA v2 challenge on a Puppeteer page using the audio
 * challenge + wit.ai speech-to-text.
 *
 * @param {import('puppeteer-core').Page} page       - Active Puppeteer page
 * @param {string}                        witToken   - wit.ai Bearer token
 * @param {object}                        [opts]
 * @param {boolean}                       [opts.verbose=false]
 * @param {number}                        [opts.retries=3]     - Max solve attempts
 * @param {number}                        [opts.delay=50]      - Typing delay (ms)
 * @param {number}                        [opts.waitTimeout=10000] - Element wait timeout (ms)
 * @returns {Promise<{found: boolean, solved: boolean, error?: string}>}
 */
export async function solveRecaptchaFreeAudio(page, witToken, opts = {}) {
  const verbose   = !!opts.verbose;
  const maxRetries = opts.retries ?? 3;
  const typingDelay = opts.delay ?? 50;
  const waitMs     = opts.waitTimeout ?? 10000;

  const log = (...args) => { if (verbose) console.log('[CaptchaSolver]', ...args); };

  /* ── Step 1: Locate reCAPTCHA ──────────────────────────────────── */

  let bframeHandle = await findBframe(page);
  let bframe = bframeHandle ? await bframeHandle.contentFrame() : null;
  let challengeVisible = false;

  if (bframe) {
    try {
      challengeVisible =
        !!(await bframe.$('#recaptcha-audio-button')) ||
        !!(await bframe.$('#audio-source'));
    } catch { /* frame may have detached */ }
  }

  log('bframe found:', !!bframe, '| challenge visible:', challengeVisible);

  /* ── Step 2: Click checkbox if challenge not visible yet ────────── */

  if (!challengeVisible) {
    const mainHandle = await page.$(MAIN_FRAME_SEL);
    if (!mainHandle) {
      log('No reCAPTCHA detected on page');
      return { found: false, solved: false };
    }

    const mainFrame = await mainHandle.contentFrame();
    if (!mainFrame) {
      return { found: false, solved: false, error: 'main iframe inaccessible' };
    }

    // Invisible reCAPTCHA cannot be solved with the audio approach
    if (await mainFrame.$('div.rc-anchor-invisible')) {
      log('Invisible reCAPTCHA — audio solver not applicable');
      return { found: true, solved: false, error: 'invisible reCAPTCHA' };
    }

    // Already solved?
    if (await mainFrame.$('.recaptcha-checkbox-checked')) {
      log('reCAPTCHA already solved');
      return { found: true, solved: true };
    }

    // Click the checkbox
    const anchor = await mainFrame.$('#recaptcha-anchor');
    if (!anchor) {
      return { found: true, solved: false, error: 'checkbox anchor not found' };
    }

    await anchor.click();
    log('Clicked reCAPTCHA checkbox');
    await sleep(2500 + Math.random() * 1000);

    // High-trust score may solve it immediately
    if (await mainFrame.$('.recaptcha-checkbox-checked')) {
      log('Solved by click alone (high trust score)');
      return { found: true, solved: true };
    }

    // Wait for challenge popup
    bframeHandle = await findBframe(page);
    if (!bframeHandle) {
      if (await mainFrame.$('.recaptcha-checkbox-checked')) {
        return { found: true, solved: true };
      }
      return { found: true, solved: false, error: 'challenge popup did not appear' };
    }
    bframe = await bframeHandle.contentFrame();
  }

  if (!bframe) {
    return { found: true, solved: false, error: 'challenge frame inaccessible' };
  }

  /* ── Step 3: Switch to audio challenge ─────────────────────────── */

  try {
    const audioBtn = await bframe.$('#recaptcha-audio-button');
    if (audioBtn) {
      await audioBtn.click();
      log('Switched to audio challenge');
      await sleep(1500 + Math.random() * 1000);
    }
  } catch (e) {
    log('Error switching to audio:', e.message);
  }

  // Check for rate-limit / block error
  const errorEl = await bframe.$('.rc-audiochallenge-error-message');
  if (errorEl) {
    const errText = await bframe.evaluate(el => el?.textContent || '', errorEl);
    if (errText) {
      log('Audio challenge error:', errText);
      return { found: true, solved: false, error: `audio blocked: ${errText}` };
    }
  }

  /* ── Step 4: Solve loop with retries ───────────────────────────── */

  let solved = false;

  for (let attempt = 1; attempt <= maxRetries && !solved; attempt++) {
    log(`Attempt ${attempt}/${maxRetries}`);

    // 4a. Wait for audio source element
    try {
      await bframe.waitForSelector('#audio-source', { timeout: waitMs });
    } catch {
      log('#audio-source not found');
      break;
    }

    // 4b. Extract audio URL
    let audioUrl;
    try {
      audioUrl = await bframe.$eval('#audio-source', el => el.src);
    } catch {
      log('Could not read audio src attribute');
      break;
    }
    if (!audioUrl) { log('Audio URL is empty'); break; }

    log('Audio URL:', audioUrl.substring(0, 100) + (audioUrl.length > 100 ? '...' : ''));

    // 4c. Download audio MP3
    let audioBuffer;
    try {
      const resp = await got(audioUrl, {
        responseType: 'buffer',
        timeout: { request: 15000 },
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        },
      });
      audioBuffer = resp.body;
      log(`Downloaded audio: ${audioBuffer.length} bytes`);
    } catch (dlErr) {
      log('Direct download failed:', dlErr.message, '— trying in-page fetch...');
      try {
        const b64 = await bframe.evaluate(async (url) => {
          const r = await fetch(url);
          const blob = await r.blob();
          return new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
        }, audioUrl);
        audioBuffer = Buffer.from(b64, 'base64');
        log(`In-page fetch OK: ${audioBuffer.length} bytes`);
      } catch (fetchErr) {
        log('In-page fetch also failed:', fetchErr.message);
        break;
      }
    }

    // 4d. Transcribe with wit.ai
    log('Transcribing with wit.ai...');
    const transcript = await transcribeWithWitAi(audioBuffer, witToken, verbose);

    if (!transcript) {
      log('Empty transcript — requesting new challenge');
      const reloadBtn = await bframe.$('#recaptcha-reload-button');
      if (reloadBtn && attempt < maxRetries) {
        await reloadBtn.click();
        await sleep(2000 + Math.random() * 1500);
      }
      continue;
    }

    log('Transcript:', transcript);

    // 4e. Type the answer
    const input = await bframe.$('#audio-response');
    if (!input) { log('#audio-response input not found'); break; }

    await input.click({ clickCount: 3 }); // select-all existing text
    await sleep(100);
    await input.type(transcript, { delay: typingDelay });

    // 4f. Set up verification listener (intercept userverify response)
    const verifyPromise = new Promise(resolve => {
      const timer = setTimeout(() => {
        page.off('response', onRes);
        resolve(null); // timeout — unknown result
      }, 12000);

      const onRes = async (res) => {
        try {
          const url = res.url();
          if (
            url.includes('recaptcha/api2/userverify') ||
            url.includes('recaptcha/enterprise/userverify')
          ) {
            const body = await res.text();
            const clean = body.replace(")]}'\n", '').trim();
            const arr = JSON.parse(clean);
            clearTimeout(timer);
            page.off('response', onRes);
            resolve(Array.isArray(arr) && arr[2] === 1);
          }
        } catch { /* ignore parse errors */ }
      };

      page.on('response', onRes);
    });

    // 4g. Click verify
    const verifyBtn = await bframe.$('#recaptcha-verify-button');
    if (!verifyBtn) { log('Verify button not found'); break; }

    await verifyBtn.click();
    log('Clicked verify');

    const passed = await verifyPromise;

    if (passed === true) {
      solved = true;
      log('reCAPTCHA SOLVED!');
    } else if (passed === null) {
      // Timeout — fallback: check the main checkbox
      const mfHandle = await page.$(MAIN_FRAME_SEL);
      if (mfHandle) {
        const mf = await mfHandle.contentFrame();
        if (mf && await mf.$('.recaptcha-checkbox-checked')) {
          solved = true;
          log('reCAPTCHA SOLVED (confirmed via checkbox)!');
        }
      }
      if (!solved) log('Verification timed out');
    } else {
      log('Incorrect answer');
      if (attempt < maxRetries) {
        await sleep(2000 + Math.random() * 1000);
      }
    }
  }

  return { found: true, solved, error: solved ? undefined : 'max retries exceeded' };
}
