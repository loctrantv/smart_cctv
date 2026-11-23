const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { validateDetectionZone } = require('../utils/security');

/**
 * Lightweight Detection Worker
 * Periodically captures snapshots and runs motion/bounding-box detection & night sound detection.
 * Supports hot-reloading settings from SQLite without restarting the server.
 */
class DetectionWorker {
  constructor(db, snapshotsPath, go2rtcClient, broadcast, go2rtcRtspUrl, recordingManager) {
    this.db = db;
    this.snapshotsPath = snapshotsPath;
    this.go2rtcClient = go2rtcClient;
    this.go2rtcRtspUrl = (go2rtcRtspUrl || 'rtsp://127.0.0.1:8554').replace(/\/+$/, '');
    this.broadcast = broadcast;
    this.recordingManager = recordingManager;
    this.workers = new Map();      // cameraId -> { timer, stopped, camera }
    this.soundWorkers = new Map(); // cameraId -> { timer, stopped, camera }
    this.intervalMs = this._getDetectionIntervalMs();
    this.soundIntervalMs = 5000;
  }

  _getDetectionIntervalMs() {
    try {
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key = 'detection.interval_ms'")
        .get();
      const val = row ? parseInt(row.value, 10) : parseInt(process.env.DETECTION_INTERVAL_MS || '3000', 10);
      return Math.min(60000, Math.max(500, val || 3000));
    } catch {
      return 3000;
    }
  }

  _isSoundDetectionGloballyEnabled() {
    try {
      const row = this.db
        .prepare("SELECT value FROM settings WHERE key = 'sound.detection_enabled'")
        .get();
      return row ? row.value === '1' : false;
    } catch {
      return false;
    }
  }

  /**
   * Hot-reload settings when updated via PUT /api/system/settings
   */
  reloadSettings() {
    this.intervalMs = this._getDetectionIntervalMs();
    const soundEnabled = this._isSoundDetectionGloballyEnabled();

    const cameras = this.db
      .prepare('SELECT * FROM cameras WHERE enabled = 1 AND detection_enabled = 1')
      .all();

    if (soundEnabled) {
      for (const cam of cameras) {
        this.startSoundDetection(cam);
      }
    } else {
      for (const [cameraId] of this.soundWorkers) {
        this.stopSoundDetection(cameraId);
      }
    }
    console.log(
      `[DET] Hot-reloaded detection settings (interval=${this.intervalMs}ms, sound=${soundEnabled})`
    );
  }

  updateCameraConfig(camera) {
    const worker = this.workers.get(camera.id);
    if (worker) {
      worker.camera = camera;
    }
    const sWorker = this.soundWorkers.get(camera.id);
    if (sWorker) {
      sWorker.camera = camera;
    }
  }

  refreshSoundDetectionForCamera(camera) {
    if (this._isSoundDetectionGloballyEnabled() && camera.enabled && camera.detection_enabled) {
      this.startSoundDetection(camera);
    } else {
      this.stopSoundDetection(camera.id);
    }
  }

  startDetection(camera) {
    if (this.workers.has(camera.id)) {
      this.updateCameraConfig(camera);
      return;
    }
    console.log(`[DET] Starting detection for: ${camera.name}`);

    const cameraSnapDir = path.join(this.snapshotsPath, camera.id);
    fs.mkdirSync(cameraSnapDir, { recursive: true });

    const scheduleNext = () => {
      const worker = this.workers.get(camera.id);
      if (!worker || worker.stopped) return;

      worker.timer = setTimeout(async () => {
        if (!worker.stopped) {
          await this._captureAndAnalyze(worker.camera, cameraSnapDir);
          scheduleNext();
        }
      }, this.intervalMs);
    };

    this.workers.set(camera.id, { timer: null, stopped: false, camera });
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

  // ============================================
  // Sound Detection
  // ============================================

  startSoundDetection(camera) {
    if (this.soundWorkers.has(camera.id)) {
      this.updateCameraConfig(camera);
      return;
    }
    console.log(`[SND] Starting sound detection for: ${camera.name}`);

    const scheduleNext = () => {
      const worker = this.soundWorkers.get(camera.id);
      if (!worker || worker.stopped) return;

      worker.timer = setTimeout(async () => {
        if (!worker.stopped) {
          await this._captureAndAnalyzeSound(worker.camera);
          scheduleNext();
        }
      }, this.soundIntervalMs);
    };

    this.soundWorkers.set(camera.id, { timer: null, stopped: false, camera });
    scheduleNext();
  }

  stopSoundDetection(cameraId) {
    const worker = this.soundWorkers.get(cameraId);
    if (!worker) return;
    worker.stopped = true;
    clearTimeout(worker.timer);
    this.soundWorkers.delete(cameraId);
    console.log(`[SND] Stopped sound detection for camera: ${cameraId}`);
  }

  stopAll() {
    for (const [cameraId] of this.workers) {
      this.stopDetection(cameraId);
    }
    for (const [cameraId] of this.soundWorkers) {
      this.stopSoundDetection(cameraId);
    }
  }

  async _captureAndAnalyze(camera, snapDir) {
    try {
      const snapName = `snap_${Date.now()}.jpg`;
      const snapPath = path.join(snapDir, snapName);

      // Strictly validate detection_zone coordinates to prevent FFmpeg filter injection
      let cropArgs = null;
      if (camera.detection_zone) {
        const zoneCheck = validateDetectionZone(camera.detection_zone);
        if (zoneCheck.valid && zoneCheck.value) {
          const zones = JSON.parse(zoneCheck.value);
          if (Array.isArray(zones) && zones.length === 1) {
            const z = zones[0];
            cropArgs = {
              vf: `crop=in_w*${z.w.toFixed(3)}:in_h*${z.h.toFixed(3)}:in_w*${z.x.toFixed(3)}:in_h*${z.y.toFixed(3)}`,
            };
          } else if (Array.isArray(zones) && zones.length > 1) {
            const cropFilters = zones.map((z, idx) => {
              return `[0:v]crop=in_w*${z.w.toFixed(3)}:in_h*${z.h.toFixed(3)}:in_w*${z.x.toFixed(3)}:in_h*${z.y.toFixed(3)},scale=320:180[c${idx}]`;
            });
            const inputs = zones.map((_, idx) => `[c${idx}]`).join('');
            cropArgs = {
              filterComplex: `${cropFilters.join('; ')}; ${inputs}vstack=inputs=${zones.length}`,
            };
          }
        }
      }

      await this._captureSnapshot(`${this.go2rtcRtspUrl}/${camera.stream_id}`, snapPath, cropArgs);

      if (!fs.existsSync(snapPath)) return;

      const stats = fs.statSync(snapPath);
      if (stats.size < 1000) {
        fs.unlinkSync(snapPath);
        return;
      }

      const worker = this.workers.get(camera.id);
      if (!worker || worker.stopped) {
        try {
          fs.unlinkSync(snapPath);
        } catch {}
        return;
      }

      const hasRedBox = await this._detectRedBox(snapPath);

      if (hasRedBox) {
        this._createEvent(
          camera,
          snapPath,
          path.join(camera.id, snapName).replace(/\\/g, '/'),
          'motion',
          'motion_detected',
          1.0
        );
        this._triggerMotionRecording(camera);
      } else {
        try {
          fs.unlinkSync(snapPath);
        } catch {}
      }

      this._cleanupSnapshots(snapDir, 100);
    } catch {
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

      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-rtsp_transport', 'tcp', '-i', rtspUrl];

      if (cropArgs) {
        if (cropArgs.vf) {
          args.push('-vf', cropArgs.vf);
        } else if (cropArgs.filterComplex) {
          args.push('-filter_complex', cropArgs.filterComplex);
        }
      }

      args.push('-vframes', '1', '-f', 'image2', outputPath);

      proc = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        detached: false,
      });

      proc.stderr?.resume();

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
    this.db
      .prepare(`
        INSERT INTO events (id, camera_id, type, label, confidence, timestamp, snapshot_path)
        VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
      `)
      .run(id, camera.id, type, label, Math.min(confidence, 1), relativeSnapPath);

    const event = {
      id,
      camera_id: camera.id,
      camera_name: camera.name,
      type,
      label,
      confidence,
      timestamp,
      snapshot_path: relativeSnapPath,
    };
    this.broadcast({ type: 'detection_event', event });
    console.log(`[DET] ${camera.name}: ${label} (${(confidence * 100).toFixed(1)}%)`);
  }

  _triggerMotionRecording(camera) {
    if (!this.recordingManager) return;
    try {
      const enabledRow = this.db
        .prepare("SELECT value FROM settings WHERE key = 'recording.on_motion_enabled'")
        .get();
      const onMotionEnabled = enabledRow ? enabledRow.value === '1' : false;

      if (onMotionEnabled) {
        const durationRow = this.db
          .prepare("SELECT value FROM settings WHERE key = 'recording.on_motion_duration'")
          .get();
        const duration = durationRow ? parseInt(durationRow.value, 10) : 30;

        this.recordingManager.startMotionRecording(camera, duration);
      }
    } catch (err) {
      console.error('[DET] Failed to trigger motion recording:', err.message);
    }
  }

  // ============================================
  // Sound Detection Helpers
  // ============================================

  _isNightTime() {
    try {
      const startRow = this.db
        .prepare("SELECT value FROM settings WHERE key = 'sound.night_start'")
        .get();
      const endRow = this.db
        .prepare("SELECT value FROM settings WHERE key = 'sound.night_end'")
        .get();
      const nightStart = startRow ? parseInt(startRow.value, 10) : 22;
      const nightEnd = endRow ? parseInt(endRow.value, 10) : 6;

      const hour = new Date().getHours();
      if (nightStart < nightEnd) {
        return hour >= nightStart && hour < nightEnd;
      } else {
        return hour >= nightStart || hour < nightEnd;
      }
    } catch {
      return false;
    }
  }

  async _captureAndAnalyzeSound(camera) {
    if (!this._isSoundDetectionGloballyEnabled()) return;
    if (!this._isNightTime()) return;

    try {
      const threshRow = this.db
        .prepare("SELECT value FROM settings WHERE key = 'sound.threshold_db'")
        .get();
      const thresholdDb = threshRow ? parseFloat(threshRow.value) : -20;

      const rmsLevel = await this._measureAudioRms(camera);
      if (rmsLevel === null) return;

      console.log(
        `[SND] ${camera.name} RMS: ${rmsLevel.toFixed(1)} dBFS (threshold: ${thresholdDb} dBFS)`
      );

      if (rmsLevel >= thresholdDb) {
        const overDb = rmsLevel - thresholdDb;
        const confidence = Math.min(overDb / 20, 1.0);

        this._createEvent(camera, null, null, 'sound_alert', 'unusual_sound', confidence);
        this._triggerSoundRecording(camera);
      }
    } catch {
      // Silent fail
    }
  }

  _measureAudioRms(camera) {
    return new Promise((resolve) => {
      let resolved = false;
      let proc = null;
      const done = (val) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      const hardTimer = setTimeout(() => {
        try {
          proc && proc.kill('SIGKILL');
        } catch {}
        done(null);
      }, 10000);

      const args = [
        '-hide_banner',
        '-rtsp_transport',
        'tcp',
        '-i',
        `${this.go2rtcRtspUrl}/${camera.stream_id}`,
        '-vn',
        '-af',
        'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level',
        '-f',
        'null',
        '-t',
        '4',
        '-',
      ];

      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderr = '';
      proc.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      proc.on('close', () => {
        clearTimeout(hardTimer);
        const match = stderr.match(/lavfi\.astats\.Overall\.RMS_level=([\-\d.]+)/);
        if (match) {
          const db = parseFloat(match[1]);
          done(isFinite(db) ? db : null);
        } else {
          done(null);
        }
      });

      proc.on('error', () => {
        clearTimeout(hardTimer);
        done(null);
      });
    });
  }

  _triggerSoundRecording(camera) {
    if (!this.recordingManager) return;
    try {
      const enabledRow = this.db
        .prepare("SELECT value FROM settings WHERE key = 'sound.recording_enabled'")
        .get();
      const recordingEnabled = enabledRow ? enabledRow.value === '1' : true;

      if (recordingEnabled) {
        const durRow = this.db
          .prepare("SELECT value FROM settings WHERE key = 'sound.recording_duration'")
          .get();
        const duration = durRow ? parseInt(durRow.value, 10) : 30;
        this.recordingManager.startSoundRecording(camera, duration);
      }
    } catch (err) {
      console.error('[SND] Failed to trigger sound recording:', err.message);
    }
  }

  _detectRedBox(snapPath) {
    return new Promise((resolve) => {
      const width = 640;
      const height = 360;
      const expectedBytes = width * height * 3;

      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        snapPath,
        '-vf',
        'scale=640:360',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ];

      const proc = spawn('ffmpeg', args);
      const chunks = [];

      proc.stdout.on('data', (chunk) => {
        chunks.push(chunk);
      });

      proc.stderr?.resume();

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

        if (r > 150 && g < 80 && b < 80 && r - g > 80 && r - b > 80) {
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

      if (w >= 20 && h >= 20 && w <= 620 && h <= 340) {
        let borderCount = 0;
        let innerCount = 0;
        const borderTolerance = 5;

        for (const p of cluster) {
          const distToLeft = p.x - minX;
          const distToRight = maxX - p.x;
          const distToTop = p.y - minY;
          const distToBottom = maxY - p.y;

          const nearBorder =
            distToLeft <= borderTolerance ||
            distToRight <= borderTolerance ||
            distToTop <= borderTolerance ||
            distToBottom <= borderTolerance;

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

        if (innerRatio < 0.3 && coverage > 0.15) {
          console.log(
            `[DET] Detected red box: bounds=[${minX}, ${minY}, ${maxX}, ${maxY}], size=${w}x${h}, innerRatio=${innerRatio.toFixed(
              2
            )}, coverage=${coverage.toFixed(2)}`
          );
          return true;
        }
      }
    }

    return false;
  }

  _cleanupSnapshots(dir, maxFiles) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('snap_'))
        .sort();
      if (files.length > maxFiles) {
        files.slice(0, files.length - maxFiles).forEach((f) => {
          try {
            fs.unlinkSync(path.join(dir, f));
          } catch {}
        });
      }
    } catch {}
  }
}

module.exports = DetectionWorker;
