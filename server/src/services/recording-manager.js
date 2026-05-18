const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

/**
 * Recording Manager - Orchestrates FFmpeg processes for camera recording
 * Uses stream copy (-c copy) for near-zero CPU usage
 */
class RecordingManager {
  constructor(db, recordingsPath, broadcast, go2rtcRtspUrl) {
    this.db = db;
    this.recordingsPath = recordingsPath;
    this.go2rtcRtspUrl = go2rtcRtspUrl || 'rtsp://localhost:8554';
    this.broadcast = broadcast;
    this.processes = new Map(); // cameraId -> { process, recordingId, timer }
  }
  
  startRecording(camera) {
    if (this.processes.has(camera.id)) {
      console.log(`[REC] Already recording camera: ${camera.name}`);
      return;
    }
    console.log(`[REC] Starting recording for: ${camera.name}`);
    this._spawnSegment(camera, null, 'continuous');
  }

  startMotionRecording(camera, durationSeconds = 30) {
    if (this.processes.has(camera.id)) {
      return; // Already recording (either continuous or active motion segment)
    }
    console.log(`[REC] Starting motion recording for: ${camera.name} (${durationSeconds}s)`);
    this._spawnSegment(camera, durationSeconds, 'motion');
  }
  
  _spawnSegment(camera, durationSeconds, mode = 'continuous') {
    let segmentDuration = durationSeconds;
    if (!segmentDuration) {
      try {
        const segRow = this.db.prepare("SELECT value FROM settings WHERE key = 'recording.segment_minutes'").get();
        const segmentMinutes = segRow ? parseInt(segRow.value) : 15;
        segmentDuration = segmentMinutes * 60;
      } catch {
        segmentDuration = 15 * 60;
      }
    }

    const cameraDir = path.join(this.recordingsPath, camera.id);
    fs.mkdirSync(cameraDir, { recursive: true });
    
    const now = new Date();
    const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.mp4`;
    const filePath = path.join(camera.id, fileName);
    const fullPath = path.join(this.recordingsPath, filePath);
    
    const recordingId = uuidv4();
    this.db.prepare(`
      INSERT INTO recordings (id, camera_id, file_path, file_name, start_time, status)
      VALUES (?, ?, ?, ?, datetime('now'), 'recording')
    `).run(recordingId, camera.id, filePath, fileName);
    
    console.log(`${this.go2rtcRtspUrl}/${camera.stream_id}`)
    const args = [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', `${this.go2rtcRtspUrl}/${camera.stream_id}`,
      '-c:v', 'copy',             // copy H.265 không re-encode
      '-c:a', 'aac',              // PCM ALAW → AAC (giống Python đang chạy)
      '-movflags', '+faststart',  // giống Python đang chạy
      '-t', String(segmentDuration),
      fullPath,
    ];
    
    const startTime = Date.now();
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('error') || msg.includes('Error')) {
        console.error(`[REC] ${camera.name}: ${msg.trim()}`);
      }
    });
    
    proc.on('close', (code) => {
      // Finalize recording in DB
      try {
        const stats = fs.existsSync(fullPath) ? fs.statSync(fullPath) : { size: 0 };
        const duration = Math.round((Date.now() - startTime) / 1000);
        this.db.prepare(`
          UPDATE recordings SET end_time = datetime('now'), duration_seconds = ?,
            size_bytes = ?, status = 'completed' WHERE id = ?
        `).run(duration, stats.size, recordingId);
      } catch (e) { console.error('[REC] DB update error:', e.message); }
      
      this.broadcast({ type: 'recording_completed', cameraId: camera.id, recordingId });
      
      // If still tracking this camera, start next segment (for continuous mode only)
      if (this.processes.has(camera.id)) {
        const info = this.processes.get(camera.id);
        if (info.mode === 'continuous') {
          if (!info.stopping) {
            const elapsed = Date.now() - startTime;
            if (elapsed < 10000) {
              console.warn(`[REC] FFmpeg process for ${camera.name} exited too quickly (${Math.round(elapsed/1000)}s). Retrying in 10s to avoid spamming...`);
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
          // Motion recording completed
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
    
    // Send 'q' to FFmpeg for graceful stop
    try {
      info.process.stdin.write('q');
    } catch {
      info.process.kill('SIGTERM');
    }
    
    // Force kill after 5 seconds
    setTimeout(() => {
      try { info.process.kill('SIGKILL'); } catch {}
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
      status[cameraId] = { recordingId: info.recordingId, stopping: info.stopping };
    }
    return status;
  }
}

module.exports = RecordingManager;
