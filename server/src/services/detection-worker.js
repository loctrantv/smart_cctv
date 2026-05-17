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
  constructor(db, snapshotsPath, go2rtcClient, broadcast, go2rtcRtspUrl) {
    this.db = db;
    this.snapshotsPath = snapshotsPath;
    this.go2rtcClient = go2rtcClient;
    this.go2rtcRtspUrl = go2rtcRtspUrl || 'rtsp://localhost:8554';
    this.broadcast = broadcast;
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
    
    this.workers.set(camera.id, { timer: null, lastFrame: null, stopped: false });
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

      await this._captureSnapshot(`${this.go2rtcRtspUrl}/${camera.stream_id}`, snapPath);

      if (!fs.existsSync(snapPath)) return;

      const stats = fs.statSync(snapPath);
      if (stats.size < 1000) {
        fs.unlinkSync(snapPath);
        return; // Too small, probably error frame
      }

      // Basic frame difference detection (lightweight)
      const worker = this.workers.get(camera.id);
      if (!worker) return;

      const currentSize = stats.size;
      const lastFrame = worker.lastFrame;

      // Simple heuristic: significant file size change suggests motion
      if (lastFrame) {
        const diff = Math.abs(currentSize - lastFrame) / lastFrame;
        if (diff > 0.15) { // >15% size change suggests significant change
          this._createEvent(camera, snapPath, path.join(camera.id, snapName), 'motion', 'motion_detected', diff);
        } else {
          // No significant change, clean up snapshot
          fs.unlinkSync(snapPath);
        }
      }

      worker.lastFrame = currentSize;

      // Keep only last 100 snapshots per camera
      this._cleanupSnapshots(snapDir, 100);
    } catch (err) {
      // Silent fail - detection is non-critical
    }
  }
  
  _captureSnapshot(rtspUrl, outputPath) {
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
  
      proc = spawn('ffmpeg', [
        '-y',
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,          // URL gốc
        '-frames:v', '1',
        '-q:v', '5',
        outputPath,
      ], {
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
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, camera.id, type, label, Math.min(confidence, 1), timestamp, relativeSnapPath);

    const event = { id, camera_id: camera.id, camera_name: camera.name, type, label, confidence, timestamp, snapshot_path: relativeSnapPath };
    this.broadcast({ type: 'detection_event', event });
    console.log(`[DET] ${camera.name}: ${label} (${(confidence * 100).toFixed(1)}%)`);
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
