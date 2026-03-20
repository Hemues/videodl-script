import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Video Converter - Wraps ffmpeg functionality
 */
export class VideoConverter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ffmpegPath = options.ffmpegPath || this.findExecutable('ffmpeg');
    this.ffprobePath = options.ffprobePath || this.findExecutable('ffprobe');
    this.activeProcesses = new Map();

    if (!this.ffmpegPath) {
      throw new Error('ffmpeg not found. Please install ffmpeg and ensure it\'s in your PATH');
    }

    if (!this.ffprobePath) {
      console.warn('ffprobe not found. Some features may be limited.');
    }
  }

  /**
   * Find executable in PATH
   */
  findExecutable(programName) {
    const isWindows = os.platform() === 'win32';
    const executable = isWindows ? `${programName}.exe` : programName;
    
    const envPath = process.env.PATH || '';
    const pathDirs = envPath.split(path.delimiter);

    for (const dir of pathDirs) {
      const fullPath = path.join(dir, executable);
      if (fs.existsSync(fullPath)) {
        try {
          fs.accessSync(fullPath, fs.constants.X_OK);
          return fullPath;
        } catch (e) {
          continue;
        }
      }
    }

    return null;
  }

  /**
   * Get ffmpeg version info
   */
  async getInfo() {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ffmpegPath, ['-version']);
      let output = '';

      process.stdout.on('data', data => output += data.toString());
      process.stderr.on('data', data => output += data.toString());

      process.on('exit', code => {
        if (code !== 0) {
          return reject(new Error(`ffmpeg returned exit code ${code}`));
        }

        const versionMatch = /ffmpeg version (\S+)/.exec(output);
        resolve({
          program: 'ffmpeg',
          version: versionMatch ? versionMatch[1] : 'unknown',
          path: this.ffmpegPath
        });
      });

      process.on('error', reject);
    });
  }

  /**
   * Convert video file
   * @param {string} input - Input file path
   * @param {string} output - Output file path
   * @param {Object} options - Conversion options
   * @returns {Promise<Object>} Conversion result
   */
  async convert(input, output, options = {}) {
    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`);
    }

    const args = this.buildFFmpegArgs(input, output, options);

    return new Promise((resolve, reject) => {
      const child = spawn(this.ffmpegPath, args);
      const pid = child.pid;

      if (!pid) {
        return reject(new Error('Failed to start ffmpeg process'));
      }

      this.activeProcesses.set(pid, child);

      let stderr = '';
      let currentProgress = {
        time: 0,
        fps: 0,
        size: 0,
        bitrate: 0,
        speed: 0
      };

      // Parse progress from stderr
      child.stderr.on('data', data => {
        const text = data.toString();
        stderr += text;

        // Parse progress information
        const progressMatch = /time=(\d+:\d+:\d+\.\d+).*fps=\s*(\d+\.?\d*).*size=\s*(\d+)kB.*bitrate=\s*(\d+\.?\d*)kbits\/s.*speed=\s*(\d+\.?\d*)x/g.exec(text);
        
        if (progressMatch) {
          currentProgress = {
            time: progressMatch[1],
            fps: parseFloat(progressMatch[2]),
            size: parseInt(progressMatch[3]),
            bitrate: parseFloat(progressMatch[4]),
            speed: parseFloat(progressMatch[5])
          };

          this.emit('progress', {
            pid,
            input,
            output,
            ...currentProgress
          });
        }
      });

      child.on('exit', code => {
        this.activeProcesses.delete(pid);

        if (code === 0) {
          this.emit('complete', { pid, input, output });
          resolve({
            exitCode: code,
            pid,
            input,
            output,
            size: fs.existsSync(output) ? fs.statSync(output).size : 0
          });
        } else {
          const error = new Error(`Conversion failed with exit code ${code}`);
          error.stderr = stderr;
          this.emit('error', { pid, input, output, error });
          reject(error);
        }
      });

      child.on('error', err => {
        this.activeProcesses.delete(pid);
        reject(err);
      });

      this.emit('start', { pid, input, output });
    });
  }

  /**
   * Build ffmpeg command arguments
   */
  buildFFmpegArgs(input, output, options) {
    const args = [
      '-i', input,
      '-hide_banner',
      '-loglevel', 'info'
    ];

    // Video codec
    if (options.videoCodec) {
      args.push('-c:v', options.videoCodec);
    }

    // Audio codec
    if (options.audioCodec) {
      args.push('-c:a', options.audioCodec);
    }

    // Video bitrate
    if (options.videoBitrate) {
      args.push('-b:v', options.videoBitrate);
    }

    // Audio bitrate
    if (options.audioBitrate) {
      args.push('-b:a', options.audioBitrate);
    }

    // Resolution
    if (options.resolution) {
      args.push('-s', options.resolution);
    }

    // Frame rate
    if (options.fps) {
      args.push('-r', options.fps.toString());
    }

    // Format
    if (options.format) {
      args.push('-f', options.format);
    }

    // Quality
    if (options.quality) {
      args.push('-q:v', options.quality.toString());
    }

    // Custom arguments
    if (options.customArgs && Array.isArray(options.customArgs)) {
      args.push(...options.customArgs);
    }

    // Overwrite output
    if (options.overwrite !== false) {
      args.push('-y');
    }

    args.push(output);

    return args;
  }

  /**
   * Probe video file for metadata
   */
  async probe(input, json = false) {
    if (!this.ffprobePath) {
      throw new Error('ffprobe not available');
    }

    if (!fs.existsSync(input)) {
      throw new Error(`Input file not found: ${input}`);
    }

    return new Promise((resolve, reject) => {
      const args = json
        ? ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input]
        : ['-i', input];

      const process = spawn(this.ffprobePath, args);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', data => stdout += data.toString());
      process.stderr.on('data', data => stderr += data.toString());

      process.on('exit', code => {
        if (json) {
          if (code !== 0) {
            return reject(new Error(`ffprobe failed: ${stderr}`));
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (e) {
            reject(new Error('Failed to parse ffprobe output'));
          }
        } else {
          // Parse text output
          const info = {};

          const resMatch = /(\d{2,})x(\d{2,})/.exec(stderr);
          if (resMatch) {
            info.width = parseInt(resMatch[1]);
            info.height = parseInt(resMatch[2]);
          }

          const durationMatch = /Duration: (\d{2}):(\d{2}):(\d{2})\.(\d{2})/.exec(stderr);
          if (durationMatch) {
            info.duration = parseInt(durationMatch[1]) * 3600 + 
                           parseInt(durationMatch[2]) * 60 + 
                           parseInt(durationMatch[3]);
          }

          const videoCodecMatch = /Video:\s+([^\s(,]+)/.exec(stderr);
          if (videoCodecMatch) {
            info.videoCodec = videoCodecMatch[1];
          }

          const audioCodecMatch = /Audio:\s+([^\s(,]+)/.exec(stderr);
          if (audioCodecMatch) {
            info.audioCodec = audioCodecMatch[1];
          }

          const fpsMatch = /(\d+(?:\.\d+)?)\s+fps/.exec(stderr);
          if (fpsMatch) {
            info.fps = parseFloat(fpsMatch[1]);
          }

          resolve(info);
        }
      });

      process.on('error', reject);
    });
  }

  /**
   * Get supported formats
   */
  async getFormats() {
    return this.execFFmpeg(['-formats']);
  }

  /**
   * Get supported codecs
   */
  async getCodecs() {
    return this.execFFmpeg(['-codecs']);
  }

  /**
   * Execute ffmpeg with args and return stdout
   */
  async execFFmpeg(args) {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ffmpegPath, args);
      let stdout = '';

      process.stdout.on('data', data => stdout += data.toString());
      process.stderr.on('data', () => {}); // Consume stderr

      process.on('exit', code => {
        if (code !== 0) {
          return reject(new Error(`ffmpeg returned exit code ${code}`));
        }
        resolve(stdout);
      });

      process.on('error', reject);
    });
  }

  /**
   * Abort conversion by PID
   */
  async abort(pid) {
    const process = this.activeProcesses.get(pid);
    if (process && process.exitCode == null) {
      // Try graceful shutdown first
      process.stdin.write('q');
      
      // Force kill after timeout
      setTimeout(() => {
        if (process.exitCode == null) {
          process.kill('SIGKILL');
        }
      }, 10000);

      return true;
    }
    return false;
  }

  /**
   * Kill all active processes
   */
  killAll() {
    for (const [pid, process] of this.activeProcesses) {
      try {
        process.kill('SIGKILL');
      } catch (e) {
        // Ignore errors
      }
    }
    this.activeProcesses.clear();
  }
}

export default VideoConverter;
