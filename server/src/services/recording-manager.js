const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

class RecordingManager {
  constructor(db, recordingsPath, broadcast) {
    this.db = db;
    this.recordingsPath = recordingsPath;
    this.broadcast = broadcast;
    this.processes = new Map(); // cameraId -> { process, recordingId, stopping, startTime }
  }
  
  startRecording(camera) {
    if (this.processes.has(camera.id)) {
      console.log(`[REC] Already recording camera: ${camera.name}`);
      return;
    }
    console.log(`[REC] Starting recording for: ${camera.name}`);
    this._spawnSegment(camera);
  }
  
  _spawnSegment(camera) {
    const segmentMinutes = 15;
    const cameraDir = path.join(this.recordingsPath, camera.id);
    fs.mkdirSync(cameraDir, { recursive: true });
    
    const now = new Date();
    const fileName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.mp4`;
    const filePath = path.join(camera.id, fileName);
    const fullPath = path.join(this.recordingsPath, filePath);
    
    const recordingId = uuidv4();
    const startTime = Date.now();
    
    this.db.prepare(`
      INSERT INTO recordings (id, camera_id, file_path, file_name, start_time, status)
    VALUES (?, ?, ?, ?, datetime('now'), 'recording')
    `).run(recordingId, camera.id, filePath, fileName);
    
    const args = [
      '-y',
      '-rtsp_transport', 'tcp',
      '-i', camera.rtsp_url,      // URL gốc, không thêm gì
      '-c:v', 'copy',             // copy H.265 không re-encode
      '-c:a', 'aac',              // PCM ALAW → AAC (giống Python đang chạy)
      '-movflags', '+faststart',  // giống Python đang chạy
      '-t', String(segmentMinutes * 60),
      fullPath,
    ];
    
    const proc = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: false,
    });
    
    proc.stderr.resume();
    
    proc.stderr.on('data', (data) => {
      const msg = data.toString();
      if (/error|failed|400|401|403/i.test(msg)) {
        console.error(`[REC] ${camera.name}: ${msg.trim()}`);
      }
    });
    
    proc.on('close', (code) => {
      const actualDuration = Math.round((Date.now() - startTime) / 1000);
      try {
        const fileExists = fs.existsSync(fullPath);
        const fileSize = fileExists ? fs.statSync(fullPath).size : 0;
        const isValid = fileExists && fileSize > 10000;
        
        this.db.prepare(`
        UPDATE recordings
        SET end_time = datetime('now'),
            duration_seconds = ?,
            size_bytes = ?,
            status = ?
        WHERE id = ?
      `).run(actualDuration, fileSize, isValid ? 'completed' : 'failed', recordingId);
        
        if (!isValid && fileExists) {
          try { fs.unlinkSync(fullPath); } catch {}
          console.warn(`[REC] ${camera.name}: file invalid (${fileSize} bytes), deleted`);
        }
      } catch (e) {
        console.error('[REC] DB update error:', e.message);
      }
      
      this.broadcast({ type: 'recording_completed', cameraId: camera.id, recordingId });
      
      const info = this.processes.get(camera.id);
      if (info && !info.stopping) {
        setTimeout(() => {
          if (this.processes.has(camera.id) && !this.processes.get(camera.id).stopping) {
            this._spawnSegment(camera);
          }
        }, 2000);
      } else {
        this.processes.delete(camera.id);
      }
    });
    
    proc.on('error', (err) => {
      console.error(`[REC] FFmpeg spawn error for ${camera.name}:`, err.message);
      this.processes.delete(camera.id);
    });
    
    this.processes.set(camera.id, { process: proc, recordingId, stopping: false, startTime });
    this.broadcast({ type: 'recording_started', cameraId: camera.id, recordingId });
  }
  
  stopRecording(cameraId) {
    const info = this.processes.get(cameraId);
    if (!info) return;
    
    console.log(`[REC] Stopping recording for camera: ${cameraId}`);
    info.stopping = true;
    
    // FIX: stdin.write('q') không hoạt động với stdio pipe đúng cách
    // Dùng SIGINT để FFmpeg finalize file MP4 trước khi thoát
    try {
      info.process.kill('SIGINT');
    } catch {
      try { info.process.kill('SIGTERM'); } catch {}
    }
    
    // Force kill sau 8s nếu vẫn chưa thoát
    const forceKill = setTimeout(() => {
      try { info.process.kill('SIGKILL'); } catch {}
      this.processes.delete(cameraId);
    }, 8000);
    
    // Khi process thoát sớm hơn, clear timer
    info.process.on('close', () => {
      clearTimeout(forceKill);
    });
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
      status[cameraId] = {
        recordingId: info.recordingId,
        stopping: info.stopping,
        durationSeconds: Math.round((Date.now() - info.startTime) / 1000),
      };
    }
    return status;
  }
}

module.exports = RecordingManager;