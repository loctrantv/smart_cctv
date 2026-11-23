const express = require('express');
const fs = require('fs');
const { resolveSafePath } = require('../utils/security');
const router = express.Router();

// GET /api/recordings - List recordings with filters
router.get('/', (req, res) => {
  try {
    const { camera_id, date, start, end, status, limit = 100, offset = 0 } = req.query;

    const safeLimit = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const where = ['1=1'];
    const params = [];

    if (camera_id) {
      where.push('r.camera_id = ?');
      params.push(String(camera_id));
    }

    if (date) {
      where.push('date(r.start_time) = ?');
      params.push(String(date));
    }

    if (start) {
      where.push('r.start_time >= ?');
      params.push(String(start));
    }

    if (end) {
      where.push('r.start_time <= ?');
      params.push(String(end));
    }

    if (status) {
      where.push('r.status = ?');
      params.push(String(status));
    }

    const recordings = req.db
      .prepare(`
        SELECT r.*, c.name as camera_name, c.stream_id
        FROM recordings r
        JOIN cameras c ON r.camera_id = c.id
        WHERE ${where.join(' AND ')}
        ORDER BY r.start_time DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, safeLimit, safeOffset);

    const total = req.db
      .prepare(`SELECT COUNT(*) as count FROM recordings r WHERE ${where.join(' AND ')}`)
      .get(...params).count;

    res.json({ recordings, total, limit: safeLimit, offset: safeOffset });
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải danh sách bản ghi' });
  }
});

// GET /api/recordings/timeline/:cameraId - Get timeline data for a specific date
router.get('/timeline/:cameraId', (req, res) => {
  try {
    const { date } = req.query;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: 'Tham số date không hợp lệ (YYYY-MM-DD)' });
    }

    const recordings = req.db
      .prepare(`
        SELECT id, start_time, end_time, duration_seconds, status
        FROM recordings
        WHERE camera_id = ? AND date(start_time) = ?
        ORDER BY start_time ASC
      `)
      .all(req.params.cameraId, String(date));

    const events = req.db
      .prepare(`
        SELECT id, type, label, confidence, timestamp, snapshot_path
        FROM events
        WHERE camera_id = ? AND date(timestamp) = ?
        ORDER BY timestamp ASC
      `)
      .all(req.params.cameraId, String(date));

    res.json({ recordings, events, date });
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải dữ liệu timeline' });
  }
});

// GET /api/recordings/:id/stream - Stream video file with range support & path traversal protection
router.get('/:id/stream', (req, res) => {
  try {
    const recording = req.db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: 'Không tìm thấy bản ghi' });

    const filePath = resolveSafePath(req.config.RECORDINGS_PATH, recording.file_path);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Không tìm thấy file video trên ổ đĩa' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Prevent proxy buffering (Nginx/Cloudflare) and declare byte-range capability on both 200 and 206
    const commonHeaders = {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'video/mp4',
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'private, max-age=3600',
    };

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

      if (isNaN(start) || isNaN(end) || start >= fileSize || end >= fileSize || start > end) {
        res.writeHead(416, {
          ...commonHeaders,
          'Content-Range': `bytes */${fileSize}`,
        });
        return res.end();
      }

      const chunkSize = end - start + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Content-Length': chunkSize,
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        ...commonHeaders,
        'Content-Length': fileSize,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: 'Lỗi phát video' });
  }
});

// DELETE /api/recordings/:id - Delete a recording
router.delete('/:id', (req, res) => {
  try {
    const recording = req.db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: 'Không tìm thấy bản ghi' });

    const filePath = resolveSafePath(req.config.RECORDINGS_PATH, recording.file_path);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
    }

    req.db.prepare('DELETE FROM recordings WHERE id = ?').run(req.params.id);
    res.json({ message: 'Đã xóa bản ghi' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa bản ghi' });
  }
});

// GET /api/recordings/dates/:cameraId - Get dates that have recordings
router.get('/dates/:cameraId', (req, res) => {
  try {
    const dates = req.db
      .prepare(`
        SELECT DISTINCT date(start_time) as date,
          COUNT(*) as recording_count,
          SUM(duration_seconds) as total_seconds
        FROM recordings
        WHERE camera_id = ?
        GROUP BY date(start_time)
        ORDER BY date DESC
        LIMIT 90
      `)
      .all(req.params.cameraId);

    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải danh sách ngày ghi hình' });
  }
});

module.exports = router;
