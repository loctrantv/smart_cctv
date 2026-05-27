const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

/**
 * Lightweight Detection Worker
 * Periodically captures snapshots and runs basic motion/change detection
 * For full AI detection, this can be extended with ONNX Runtime
 */
class DetectionWorker {
  constructor(db, snapshotsPath, go2rtcClient, broadcast, go2rtcRtspUrl, recordingManager) {
    this.db = db;
    this.snapshotsPath = snapshotsPath;
    this.go2rtcClient = go2rtcClient;
    this.go2rtcRtspUrl = go2rtcRtspUrl || 'rtsp://localhost:8554';
    this.broadcast = broadcast;
    this.recordingManager = recordingManager;
    this.workers = new Map(); // cameraId -> { interval, lastHash }
    this.intervalMs = parseInt(process.env.DETECTION_INTERVAL_MS || '3000');
  }
  
  startDetection(camera) {
    if (this.workers.has(camera.id)) return;
    console.log(`[DET] Starting detection for: ${camera.name}`);
    
    const cameraSnapDir = path.join(this.snapshotsPath, camera.id);
    fs.mkdirSync(cameraSnapDir, { recursive: true });
    
    // Dùng setTimeout thay vì setInterval để tránh chồng lấp
    const scheduleNext = () => {
      const worker = this.workers.get(camera.id);
      if (!worker || worker.stopped) return;
      
      worker.timer = setTimeout(async () => {
        if (!worker.stopped) {
          await this._captureAndAnalyze(camera, cameraSnapDir);
          scheduleNext(); // chỉ schedule tiếp sau khi xong
        }
      }, this.intervalMs);
    };
    
    this.workers.set(camera.id, { timer: null, stopped: false });
    scheduleNext();
  }
  
  stopDetection(cameraId) {
    const worker = this.workers.get(cameraId);
    if (!worker) return;
    worker.stopped = true;
    clearTimeout(worker.timer);
    this.workers.delete(cameraId);
    console.log(`[DET] Stopped detection for camera: ${cameraId}`);
  }

  stopAll() {
    for (const [cameraId] of this.workers) {
      this.stopDetection(cameraId);
    }
  }

  async _captureAndAnalyze(camera, snapDir) {
    try {
      // Capture a snapshot using FFmpeg from RTSP
      const snapName = `snap_${Date.now()}.jpg`;
      const snapPath = path.join(snapDir, snapName);

      // Check if detection_zone is configured
      let cropArgs = null;
      if (camera.detection_zone) {
        try {
          if (camera.detection_zone.startsWith('[')) {
            const zones = JSON.parse(camera.detection_zone);
            if (Array.isArray(zones) && zones.length > 0) {
              // Construct FFMPEG filter_complex!
              // For each zone, crop and scale to a common resolution (e.g. 320x180) to allow vstack
              const cropFilters = zones.map((z, idx) => {
                return `[0:v]crop=in_w*${z.w.toFixed(3)}:in_h*${z.h.toFixed(3)}:in_w*${z.x.toFixed(3)}:in_h*${z.y.toFixed(3)},scale=320:180[c${idx}]`;
              });
              const inputs = zones.map((_, idx) => `[c${idx}]`).join('');
              cropArgs = {
                filterComplex: `${cropFilters.join('; ')}; ${inputs}vstack=inputs=${zones.length}`
              };
            }
          } else {
            // Legacy single zone format (x,y,w,h string)
            const parts = camera.detection_zone.split(',').map(Number);
            if (parts.length === 4 && parts.every(p => !isNaN(p))) {
              const [x, y, w, h] = parts;
              cropArgs = {
                vf: `crop=in_w*${w.toFixed(3)}:in_h*${h.toFixed(3)}:in_w*${x.toFixed(3)}:in_h*${y.toFixed(3)}`
              };
            }
          }
        } catch (e) {
          console.error('[DET] Failed to parse detection zones:', e.message);
        }
      }

      await this._captureSnapshot(`${this.go2rtcRtspUrl}/${camera.stream_id}`, snapPath, cropArgs);

      if (!fs.existsSync(snapPath)) return;

      const stats = fs.statSync(snapPath);
      if (stats.size < 1000) {
        fs.unlinkSync(snapPath);
        return; // Too small, probably error frame
      }

      // Check if the snapshot contains a red box (bounding box)
      const worker = this.workers.get(camera.id);
      if (!worker) return;

      const hasRedBox = await this._detectRedBox(snapPath);

      if (hasRedBox) {
        // Red box detected, create event and trigger recording
        this._createEvent(camera, snapPath, path.join(camera.id, snapName), 'motion', 'motion_detected', 1.0);
        this._triggerMotionRecording(camera);
      } else {
        // No red box detected, clean up snapshot
        try {
          fs.unlinkSync(snapPath);
        } catch (e) {
          // Ignore unlink errors
        }
      }

      // Keep only last 100 snapshots per camera
      this._cleanupSnapshots(snapDir, 100);
    } catch (err) {
      // Silent fail - detection is non-critical
    }
  }
  
  _captureSnapshot(rtspUrl, outputPath, cropArgs) {
    return new Promise((resolve) => {
      let resolved = false;
      let proc = null;
      
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      
      const killProc = () => {
        if (!proc) return;
        try {
          proc.stdout?.destroy();
          proc.stderr?.destroy();
          proc.kill('SIGKILL');
        } catch {}
      };
      
      const hardTimer = setTimeout(() => {
        killProc();
        done();
      }, 8000);
      
      const args = [
        '-y',
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
      ];

      if (cropArgs) {
        if (typeof cropArgs === 'string') {
          args.push('-vf', cropArgs);
        } else if (cropArgs.vf) {
          args.push('-vf', cropArgs.vf);
        } else if (cropArgs.filterComplex) {
          args.push('-filter_complex', cropArgs.filterComplex);
        }
      }

      args.push(
        '-vframes', '1',
        '-f', 'image2',
        outputPath
      );
      
      proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });
      
      proc.stderr?.resume(); // drain stderr để không bị block
      
      proc.on('close', () => {
        clearTimeout(hardTimer);
        done();
      });
      
      proc.on('error', () => {
        clearTimeout(hardTimer);
        killProc();
        done();
      });
    });
  }

  _createEvent(camera, snapPath, relativeSnapPath, type, label, confidence) {
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO events (id, camera_id, type, label, confidence, timestamp, snapshot_path)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(id, camera.id, type, label, Math.min(confidence, 1), relativeSnapPath);

    const event = { id, camera_id: camera.id, camera_name: camera.name, type, label, confidence, timestamp, snapshot_path: relativeSnapPath };
    this.broadcast({ type: 'detection_event', event });
    console.log(`[DET] ${camera.name}: ${label} (${(confidence * 100).toFixed(1)}%)`);
  }

  _triggerMotionRecording(camera) {
    if (!this.recordingManager) return;
    try {
      const enabledRow = this.db.prepare("SELECT value FROM settings WHERE key = 'recording.on_motion_enabled'").get();
      const onMotionEnabled = enabledRow ? enabledRow.value === '1' : false;
      
      if (onMotionEnabled) {
        const durationRow = this.db.prepare("SELECT value FROM settings WHERE key = 'recording.on_motion_duration'").get();
        const duration = durationRow ? parseInt(durationRow.value) : 30;
        
        this.recordingManager.startMotionRecording(camera, duration);
      }
    } catch (err) {
      console.error('[DET] Failed to trigger motion recording:', err.message);
    }
  }

  _detectRedBox(snapPath) {
    return new Promise((resolve) => {
      const width = 640;
      const height = 360;
      const expectedBytes = width * height * 3;
      
      const args = [
        '-y',
        '-i', snapPath,
        '-vf', 'scale=640:360',
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-'
      ];
      
      const proc = spawn('ffmpeg', args);
      const chunks = [];
      
      proc.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      proc.stderr?.resume(); // Drain stderr to prevent process blocking
      
      proc.on('close', (code) => {
        if (code !== 0) {
          resolve(false);
          return;
        }
        
        const buffer = Buffer.concat(chunks);
        if (buffer.length !== expectedBytes) {
          resolve(false);
          return;
        }
        
        const detected = this._analyzeRgbBuffer(buffer, width, height);
        resolve(detected);
      });
      
      proc.on('error', () => {
        resolve(false);
      });
    });
  }

  _analyzeRgbBuffer(buffer, width, height) {
    const numPixels = width * height;
    const isRedPixel = new Uint8Array(numPixels);
    const redPixels = [];
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const r = buffer[3 * idx];
        const g = buffer[3 * idx + 1];
        const b = buffer[3 * idx + 2];
        
        // Match bright red color:
        // R is high, G and B are low. R should be significantly greater than G and B.
        if (r > 150 && g < 80 && b < 80 && (r - g) > 80 && (r - b) > 80) {
          isRedPixel[idx] = 1;
          redPixels.push({ x, y });
        }
      }
    }
    
    if (redPixels.length < 20) {
      return false;
    }
    
    const visited = new Uint8Array(numPixels);
    const clusters = [];
    
    for (const p of redPixels) {
      const startIdx = p.y * width + p.x;
      if (visited[startIdx]) continue;
      
      const cluster = [];
      const queue = [p];
      visited[startIdx] = 1;
      
      let head = 0;
      while (head < queue.length) {
        const curr = queue[head++];
        cluster.push(curr);
        
        // 8-connected BFS search with a radius of 2 to bridge gaps
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = curr.x + dx;
            const ny = curr.y + dy;
            
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const nidx = ny * width + nx;
              if (isRedPixel[nidx] && !visited[nidx]) {
                visited[nidx] = 1;
                queue.push({ x: nx, y: ny });
              }
            }
          }
        }
      }
      
      if (cluster.length >= 30) {
        clusters.push(cluster);
      }
    }
    
    for (const cluster of clusters) {
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      
      for (const p of cluster) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      
      const w = maxX - minX;
      const h = maxY - minY;
      
      // Bounding box size constraints
      if (w >= 20 && h >= 20 && w <= 620 && h <= 340) {
        let borderCount = 0;
        let innerCount = 0;
        const borderTolerance = 5;
        
        for (const p of cluster) {
          const distToLeft = p.x - minX;
          const distToRight = maxX - p.x;
          const distToTop = p.y - minY;
          const distToBottom = maxY - p.y;
          
          const nearBorder = (distToLeft <= borderTolerance) || 
                             (distToRight <= borderTolerance) || 
                             (distToTop <= borderTolerance) || 
                             (distToBottom <= borderTolerance);
                             
          if (nearBorder) {
            borderCount++;
          } else {
            innerCount++;
          }
        }
        
        const total = cluster.length;
        const innerRatio = innerCount / total;
        const perimeter = 2 * (w + h);
        const coverage = borderCount / perimeter;
        
        // hollow outline constraints:
        // 1. innerRatio should be low (< 0.3)
        // 2. coverage should be reasonable (> 0.15)
        if (innerRatio < 0.3 && coverage > 0.15) {
          console.log(`[DET] Detected red box: bounds=[${minX}, ${minY}, ${maxX}, ${maxY}], size=${w}x${h}, innerRatio=${innerRatio.toFixed(2)}, coverage=${coverage.toFixed(2)}`);
          return true;
        }
      }
    }
    
    return false;
  }

  _cleanupSnapshots(dir, maxFiles) {
    try {
      const files = fs.readdirSync(dir)
        .filter(f => f.startsWith('snap_'))
        .sort();
      if (files.length > maxFiles) {
        files.slice(0, files.length - maxFiles).forEach(f => {
          try { fs.unlinkSync(path.join(dir, f)); } catch {}
        });
      }
    } catch {}
  }
}

module.exports = DetectionWorker;
