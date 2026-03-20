#!/usr/bin/env node

/**
 * Example: Programmatic usage of videodl-cli
 */

import { VideoDownloader, VideoConverter } from './src/index.js';

async function example() {
  console.log('=== Video Downloader CLI - Programmatic Example ===\n');

  // Example 1: Download a video
  console.log('Example 1: Downloading video...');
  const downloader = new VideoDownloader({
    downloadFolder: './downloads'
  });

  downloader.on('progress', ({ percent, downloaded, total }) => {
    const downloadedMB = (downloaded / 1024 / 1024).toFixed(2);
    const totalMB = (total / 1024 / 1024).toFixed(2);
    console.log(`Progress: ${percent}% (${downloadedMB}MB / ${totalMB}MB)`);
  });

  downloader.on('complete', ({ filepath, size }) => {
    const sizeMB = (size / 1024 / 1024).toFixed(2);
    console.log(`✓ Downloaded: ${filepath} (${sizeMB}MB)\n`);
  });

  // Uncomment to test download:
  // const downloadPath = await downloader.download({
  //   url: 'https://example.com/sample.mp4',
  //   filename: 'sample.mp4'
  // });

  // Example 2: Convert a video
  console.log('Example 2: Converting video...');
  const converter = new VideoConverter();

  converter.on('progress', ({ time, fps, size, speed }) => {
    console.log(`Converting: time=${time} fps=${fps} size=${size}kB speed=${speed}x`);
  });

  converter.on('complete', ({ output }) => {
    console.log(`✓ Converted: ${output}\n`);
  });

  // Uncomment to test conversion:
  // await converter.convert('input.mp4', 'output.mkv', {
  //   videoCodec: 'libx264',
  //   audioCodec: 'aac',
  //   resolution: '1280x720'
  // });

  // Example 3: Probe video
  console.log('Example 3: Getting video info...');
  
  // Uncomment to test probe:
  // const info = await converter.probe('video.mp4');
  // console.log('Video Info:', info);
  // console.log(`Resolution: ${info.width}x${info.height}`);
  // console.log(`Duration: ${info.duration}s`);
  // console.log(`Video Codec: ${info.videoCodec}`);
  // console.log(`Audio Codec: ${info.audioCodec}\n`);

  // Example 4: Get system info
  console.log('Example 4: Getting system info...');
  const systemInfo = await converter.getInfo();
  console.log('FFmpeg Info:', systemInfo);
  console.log(`Version: ${systemInfo.version}`);
  console.log(`Path: ${systemInfo.path}\n`);

  console.log('=== Examples Complete ===');
  console.log('Uncomment code in examples.js to test download/convert functionality');
}

// Run examples
example().catch(error => {
  console.error('Error:', error.message);
  process.exit(1);
});
