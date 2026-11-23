const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { resolveSafePath } = require('../utils/security');

/**
 * Recording Manager - Orchestrates FFmpeg processes for camera recording
 * Uses stream copy (-c:v copy) for near-zero CPU usage
 */
class RecordingManager {
  constructor(db, recordingsPath, broadcast, go2rtcRtspUrl) {
    this.db = db;
    this.recordingsPath = recordingsPath;
    this.go2rtcRtspUrl = (go2rtcRtspUrl || 'rtsp://127.0.0.1:8554').replace(/\/+$/, '');
    this.broadcast = broadcast;
    this.processes = new Map(); // cameraId -> { process, recordingId, stopping, mode }
  }

  /**
   * Recover orphaned recordings left in 'recording' status after an unexpected crash or restart
   */
  recoverOrphanedRecordings() {
    try {
      const orphaned = this.db
        .prepare("SELECT * FROM recordings WHERE status = 'recording'")
        .all();

      if (orphaned.length === 0) return;

      for (const rec of orphaned) {
        const fullPath = resolveSafePath(this.recordingsPath, rec.file_path);
        const exists = fullPath && fs.existsSync(fullPath);
        const size = exists ? fs.statSync(fullPath).size : 0;

        if (size > 0) {
          this.db
            .prepare(`
              UPDATE recordings
              SET end_time = COALESCE(end_time, datetime('now')),
                  size_bytes = ?,
                  status = 'completed'
              WHERE id = ?
            `)
            .run(size, rec.id);
        } else {
          if (exists) {
            try {
              fs.unlinkSync(fullPath);
            } catch {}
          }
          this.db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
        }
      }
      console.log(`[REC] Recovered ${orphaned.length} orphaned recording(s) from previous session`);
    } catch (err) {
      console.error('[REC] Failed to recover orphaned recordings:', err.message);
    }
  }

  startRecording(camera) {
    if (this.processes.has(camera.id)) {
      console.log(`[REC] Already recording camera: ${camera.name}`);
      return;
    }
    console.log(`[REC] Starting continuous recording for: ${camera.name}`);
    this._spawnSegment(camera, null, 'continuous');
  }

  startMotionRecording(camera, durationSeconds = 30) {
    if (this.processes.has(camera.id)) {
      return; // Already recording (either continuous or active motion/sound segment)
    }
    const safeDuration = Math.min(300, Math.max(5, parseInt(durationSeconds, 10) || 30));
    console.log(`[REC] Starting motion recording for: ${camera.name} (${safeDuration}s)`);
    this._spawnSegment(camera, safeDuration, 'motion');
  }

  startSoundRecording(camera, durationSeconds = 30) {
    if (this.processes.has(camera.id)) {
      return; // Already recording - do not interrupt existing session
    }
    const safeDuration = Math.min(300, Math.max(5, parseInt(durationSeconds, 10) || 30));
    console.log(`[REC] Starting sound recording for: ${camera.name} (${safeDuration}s)`);
    this._spawnSegment(camera, safeDuration, 'sound');
  }

  _spawnSegment(camera, durationSeconds, mode = 'continuous') {
    let segmentDuration = durationSeconds;
    if (!segmentDuration) {
      try {
        const segRow = this.db
          .prepare("SELECT value FROM settings WHERE key = 'recording.segment_minutes'")
          .get();
        const segmentMinutes = segRow ? Math.min(120, Math.max(1, parseInt(segRow.value, 10) || 15)) : 15;
        segmentDuration = segmentMinutes * 60;
      } catch {
        segmentDuration = 15 * 60;
      }
    }

    const cameraDir = path.join(this.recordingsPath, camera.id);
    fs.mkdirSync(cameraDir, { recursive: true });

    const now = new Date();
    const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
      now.getDate()
    ).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(
      now.getMinutes()
    ).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.mp4`;
    const filePath = path.join(camera.id, fileName);
    const fullPath = path.join(this.recordingsPath, filePath);

    const recordingId = uuidv4();
    this.db
      .prepare(`
        INSERT INTO recordings (id, camera_id, file_path, file_name, start_time, status)
        VALUES (?, ?, ?, ?, datetime('now'), 'recording')
      `)
      .run(recordingId, camera.id, filePath, fileName);

    const rtspInput = `${this.go2rtcRtspUrl}/${camera.stream_id}`;
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-rtsp_transport',
      'tcp',
      '-i',
      rtspInput,
      '-c:v',
      'copy',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      '-t',
      String(segmentDuration),
      fullPath,
    ];

    const startTime = Date.now();
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });

    proc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.error(`[REC] ${camera.name}: ${msg}`);
      }
    });

    proc.on('close', () => {
      try {
        const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : { size: 0 };
        const duration = Math.round((Date.now() - startTime) / 1000);
        if (stats.size > 0) {
          this.db
            .prepare(`
              UPDATE recordings
              SET end_time = datetime('now'), duration_seconds = ?, size_bytes = ?, status = 'completed'
              WHERE id = ?
            `)
            .run(duration, stats.size, recordingId);
        } else {
          if (fs.existsSync(fullPath)) {
            try {
              fs.unlinkSync(fullPath);
            } catch {}
          }
          this.db.prepare('DELETE FROM recordings WHERE id = ?').run(recordingId);
        }
      } catch (e) {
        console.error('[REC] DB update error:', e.message);
      }

      this.broadcast({ type: 'recording_completed', cameraId: camera.id, recordingId });

      if (this.processes.has(camera.id)) {
        const info = this.processes.get(camera.id);
        if (info.mode === 'continuous') {
          if (!info.stopping) {
            const elapsed = Date.now() - startTime;
            if (elapsed < 10000) {
              console.warn(
                `[REC] FFmpeg process for ${camera.name} exited quickly (${Math.round(
                  elapsed / 1000
                )}s). Retrying in 10s...`
              );
              setTimeout(() => {
                if (this.processes.has(camera.id)) {
                  const currentInfo = this.processes.get(camera.id);
                  if (!currentInfo.stopping) {
                    this._spawnSegment(camera, null, 'continuous');
                  } else {
                    this.processes.delete(camera.id);
                  }
                }
              }, 10000);
            } else {
              this._spawnSegment(camera, null, 'continuous');
            }
          } else {
            this.processes.delete(camera.id);
          }
        } else {
          this.processes.delete(camera.id);
        }
      }
    });

    proc.on('error', (err) => {
      console.error(`[REC] FFmpeg spawn error for ${camera.name}:`, err.message);
      this.processes.delete(camera.id);
    });

    this.processes.set(camera.id, { process: proc, recordingId, stopping: false, mode });
    this.broadcast({ type: 'recording_started', cameraId: camera.id, recordingId });
  }

  stopRecording(cameraId) {
    const info = this.processes.get(cameraId);
    if (!info) return;

    console.log(`[REC] Stopping recording for camera: ${cameraId}`);
    info.stopping = true;

    try {
      info.process.stdin.write('q');
    } catch {
      try {
        info.process.kill('SIGTERM');
      } catch {}
    }

    setTimeout(() => {
      try {
        info.process.kill('SIGKILL');
      } catch {}
    }, 5000);
  }

  stopAll() {
    for (const [cameraId] of this.processes) {
      this.stopRecording(cameraId);
    }
  }

  isRecording(cameraId) {
    return this.processes.has(cameraId);
  }

  getStatus() {
    const status = {};
    for (const [cameraId, info] of this.processes) {
      status[cameraId] = { recordingId: info.recordingId, stopping: info.stopping, mode: info.mode };
    }
    return status;
  }
}

module.exports = RecordingManager;
