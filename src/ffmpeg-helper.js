/**
 * FFmpeg Helper - Auto-download ffmpeg if not available
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import got from 'got';

const FFMPEG_DIR = path.join(os.homedir(), '.videodl-cli', 'ffmpeg');
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest';

/**
 * Check if ffmpeg is available in PATH
 * @returns {boolean}
 */
export function checkFFmpegInPath() {
  try {
    if (process.platform === 'win32') {
      execSync('where ffmpeg', { stdio: 'ignore' });
    } else {
      execSync('which ffmpeg', { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the path to ffmpeg executable
 * @returns {string}
 */
export function getFFmpegPath() {
  // Check if in PATH first
  if (checkFFmpegInPath()) {
    return 'ffmpeg';
  }
  
  // Check local installation
  const platform = process.platform;
  const exeName = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const localPath = path.join(FFMPEG_DIR, 'bin', exeName);
  
  if (fs.existsSync(localPath)) {
    return localPath;
  }
  
  return null;
}

/**
 * Detect the appropriate FFmpeg build for current OS
 * @returns {string} Build identifier
 */
function detectBuild() {
  const platform = process.platform;
  const arch = process.arch;
  
  if (platform === 'win32') {
    // Use static builds on Windows to avoid DLL issues
    return arch === 'x64' ? 'win64-gpl' : 'win32-gpl';
  } else if (platform === 'linux') {
    if (arch === 'x64' || arch === 'x86_64') {
      return 'linux64-gpl';
    } else if (arch === 'arm64' || arch === 'aarch64') {
      return 'linuxarm64-gpl';
    }
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'macos-arm64-gpl' : 'macos-64-gpl';
  }
  
  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

/**
 * Download and install FFmpeg
 * @param {Function} progressCallback - Progress callback
 * @returns {Promise<string>} Path to ffmpeg executable
 */
export async function downloadFFmpeg(progressCallback = () => {}) {
  console.log('Downloading FFmpeg...');
  
  const buildType = detectBuild();
  
  // Ensure directory exists
  if (!fs.existsSync(FFMPEG_DIR)) {
    fs.mkdirSync(FFMPEG_DIR, { recursive: true });
  }
  
  progressCallback({ status: 'fetching_release_info' });
  
  // Get latest release info
  const releaseResponse = await got(GITHUB_RELEASES_URL, {
    headers: { 'User-Agent': 'videodl-cli' }
  }).json();
  
  // Find the appropriate asset - prefer static builds
  let asset = releaseResponse.assets.find(a => 
    a.name.includes(buildType) &&
    a.name.toLowerCase().includes('static') &&
    (a.name.endsWith('.tar.xz') || a.name.endsWith('.zip'))
  );
  
  // Fallback to non-static if static not available
  if (!asset) {
    asset = releaseResponse.assets.find(a => 
      a.name.includes(buildType) && 
      (a.name.endsWith('.tar.xz') || a.name.endsWith('.zip'))
    );
  }
  
  if (!asset) {
    throw new Error(`No FFmpeg build found for ${buildType}`);
  }
  
  console.log(`Downloading: ${asset.name} (${(asset.size / 1024 / 1024).toFixed(2)} MB)`);
  progressCallback({ status: 'downloading', total: asset.size });
  
  const downloadPath = path.join(FFMPEG_DIR, asset.name);
  const downloadStream = got.stream(asset.browser_download_url);
  const fileStream = fs.createWriteStream(downloadPath);
  
  let downloaded = 0;
  downloadStream.on('data', (chunk) => {
    downloaded += chunk.length;
    progressCallback({ 
      status: 'downloading', 
      downloaded, 
      total: asset.size,
      percent: (downloaded / asset.size) * 100
    });
  });
  
  await pipeline(downloadStream, fileStream);
  
  console.log('Extracting FFmpeg...');
  progressCallback({ status: 'extracting' });
  
  // Extract the archive
  if (asset.name.endsWith('.tar.xz')) {
    await extractTarXz(downloadPath, FFMPEG_DIR);
  } else if (asset.name.endsWith('.zip')) {
    await extractZip(downloadPath, FFMPEG_DIR);
  }
  
  // Clean up downloaded archive
  fs.unlinkSync(downloadPath);
  
  // Find the ffmpeg binary in extracted files
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const binDir = findDirectory(FFMPEG_DIR, 'bin');
  
  if (!binDir) {
    throw new Error('bin directory not found after extraction');
  }
  
  const ffmpegPath = path.join(binDir, exeName);
  if (!fs.existsSync(ffmpegPath)) {
    throw new Error('FFmpeg binary not found in bin directory');
  }
  
  // Copy entire bin directory to standard location
  const targetDir = path.join(FFMPEG_DIR, 'bin');
  if (fs.existsSync(targetDir)) {
    // Clean old installation
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  
  // Copy all files from source bin to target bin (includes DLLs on Windows)
  copyDirectory(binDir, targetDir);
  
  const targetPath = path.join(targetDir, exeName);
  
  // Make executable on Unix
  if (process.platform !== 'win32' && fs.existsSync(targetPath)) {
    fs.chmodSync(targetPath, 0o755);
  }
  
  console.log('FFmpeg installed successfully!');
  progressCallback({ status: 'complete' });
  
  return targetPath;
}

/**
 * Extract tar.xz archive
 */
async function extractTarXz(archivePath, destPath) {
  return new Promise((resolve, reject) => {
    // Check if tar is available
    try {
      execSync('tar --version', { stdio: 'ignore' });
    } catch {
      reject(new Error('tar command not found. Please install tar or extract the archive manually.'));
      return;
    }
    
    const args = ['-xJf', archivePath, '-C', destPath, '--strip-components=1'];
    const tar = spawn('tar', args);
    
    let errorOutput = '';
    
    tar.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    tar.on('error', (error) => {
      reject(new Error(`tar process error: ${error.message}`));
    });
    
    tar.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extraction failed with code ${code}: ${errorOutput}`));
      }
    });
  });
}

/**
 * Extract zip archive (for Windows)
 */
async function extractZip(archivePath, destPath) {
  // Use PowerShell Expand-Archive on Windows
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -Path '${archivePath}' -DestinationPath '${destPath}' -Force`
    ]);
    
    let errorOutput = '';
    
    ps.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });
    
    ps.on('error', (error) => {
      reject(new Error(`PowerShell error: ${error.message}`));
    });
    
    ps.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`zip extraction failed with code ${code}: ${errorOutput}`));
      }
    });
  });
}

/**
 * Recursively find a file
 */
function findFile(dir, filename) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      const found = findFile(fullPath, filename);
      if (found) return found;
    } else if (file === filename) {
      return fullPath;
    }
  }
  
  return null;
}

/**
 * Recursively find a directory
 */
function findDirectory(dir, dirname) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      if (file === dirname) {
        return fullPath;
      }
      const found = findDirectory(fullPath, dirname);
      if (found) return found;
    }
  }
  
  return null;
}

/**
 * Copy directory recursively
 */
function copyDirectory(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const files = fs.readdirSync(src);
  
  for (const file of files) {
    const srcPath = path.join(src, file);
    const destPath = path.join(dest, file);
    const stat = fs.statSync(srcPath);
    
    if (stat.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      // Preserve executable permissions on Unix
      if (process.platform !== 'win32') {
        fs.chmodSync(destPath, stat.mode);
      }
    }
  }
}

/**
 * Ensure ffmpeg is available (download if necessary)
 * @param {Function} progressCallback
 * @returns {Promise<string>} Path to ffmpeg
 */
export async function ensureFFmpeg(progressCallback = () => {}) {
  const ffmpegPath = getFFmpegPath();
  
  if (ffmpegPath) {
    return ffmpegPath;
  }
  
  // Download if not available
  return await downloadFFmpeg(progressCallback);
}
