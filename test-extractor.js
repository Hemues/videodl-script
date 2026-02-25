#!/usr/bin/env node

/**
 * Test script for extractor functionality
 */

import { extractVideoInfo, listSupportedSites } from './src/extractors/index.js';
import chalk from 'chalk';

async function testExtractor() {
  console.log(chalk.blue('='.repeat(60)));
  console.log(chalk.blue('Video Extractor Test'));
  console.log(chalk.blue('='.repeat(60)));
  console.log('');

  // Test 1: List supported sites
  console.log(chalk.cyan('Supported Sites:'));
  const sites = listSupportedSites();
  sites.forEach(site => console.log(`  • ${site}`));
  console.log('');

  // Test 2: Test with actual URL (if provided)
  const testUrl = process.argv[2];
  
  if (!testUrl) {
    console.log(chalk.yellow('Usage: node test-extractor.js <url>'));
    console.log(chalk.yellow('Example: node test-extractor.js "https://xhamster.com/videos/..."'));
    console.log('');
    return;
  }

  console.log(chalk.cyan(`Testing URL: ${testUrl}`));
  console.log('');

  try {
    console.log(chalk.blue('Extracting video information...'));
    const videoInfo = await extractVideoInfo(testUrl);

    console.log(chalk.green('✓ Extraction successful!'));
    console.log('');
    console.log(chalk.cyan('Video Information:'));
    console.log(`  Title:     ${videoInfo.title}`);
    console.log(`  ID:        ${videoInfo.id}`);
    console.log(`  Extractor: ${videoInfo.extractor}`);
    console.log('');

    console.log(chalk.cyan(`Available Formats (${videoInfo.formats.length}):`));
    console.log('  ' + '-'.repeat(70));
    console.log('  #   Quality      Resolution  Ext    URL Preview');
    console.log('  ' + '-'.repeat(70));
    
    videoInfo.formats.forEach((fmt, idx) => {
      const index = String(idx + 1).padStart(2);
      const quality = fmt.quality.padEnd(12);
      const resolution = `${fmt.height || '?'}p`.padEnd(12);
      const ext = fmt.ext.padEnd(6);
      const urlPreview = fmt.url.substring(0, 40) + '...';
      console.log(`  ${index}  ${quality} ${resolution} ${ext} ${urlPreview}`);
    });
    
    console.log('  ' + '-'.repeat(70));
    console.log('');

    // Test format selection
    console.log(chalk.cyan('Testing format selection:'));
    const extractor = (await import('./src/extractors/index.js')).getExtractor(testUrl);
    
    const testQualities = ['best', '720p', '480p', 'worst'];
    for (const quality of testQualities) {
      try {
        const selected = extractor.selectFormat(videoInfo.formats, quality);
        console.log(`  ${quality.padEnd(10)} -> ${selected.quality} (${selected.height}p)`);
      } catch (e) {
        console.log(chalk.red(`  ${quality.padEnd(10)} -> Not available`));
      }
    }
    
    console.log('');
    console.log(chalk.green('✓ All tests passed!'));

  } catch (error) {
    console.error(chalk.red('✗ Extraction failed!'));
    console.error(chalk.red(`  Error: ${error.message}`));
    
    if (process.env.DEBUG) {
      console.error('');
      console.error(chalk.gray('Stack trace:'));
      console.error(chalk.gray(error.stack));
    }
    
    process.exit(1);
  }

  console.log('');
  console.log(chalk.blue('='.repeat(60)));
}

// Run test
testExtractor().catch(error => {
  console.error(chalk.red('Fatal error:'), error.message);
  process.exit(1);
});
