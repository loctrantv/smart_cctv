const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// GET /api/recordings - List recordings with filters
router.get('/', (req, res) => {
  try {
    const { camera_id, date, start, end, status, limit = 100, offset = 0 } = req.query;

    let where = ['1=1'];
    let params = [];

    if (camera_id) {
      where.push('r.camera_id = ?');
      params.push(camera_id);
    }

    if (date) {
      where.push("date(r.start_time) = ?");
      params.push(date);
    }

    if (start) {
      where.push('r.start_time >= ?');
      params.push(start);
    }

    if (end) {
      where.push('r.start_time <= ?');
      params.push(end);
    }

    if (status) {
      where.push('r.status = ?');
      params.push(status);
    }

    const recordings = req.db.prepare(`
      SELECT r.*, c.name as camera_name, c.stream_id
      FROM recordings r
      JOIN cameras c ON r.camera_id = c.id
      WHERE ${where.join(' AND ')}
      ORDER BY r.start_time DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = req.db.prepare(`
      SELECT COUNT(*) as count FROM recordings r WHERE ${where.join(' AND ')}
    `).get(...params).count;

    res.json({ recordings, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recordings/timeline/:cameraId - Get timeline data for a specific date
router.get('/timeline/:cameraId', (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date parameter required (YYYY-MM-DD)' });

    // Get recordings for the day
    const recordings = req.db.prepare(`
      SELECT id, start_time, end_time, duration_seconds, status
      FROM recordings
      WHERE camera_id = ? AND date(start_time) = ?
      ORDER BY start_time ASC
    `).all(req.params.cameraId, date);

    // Get events for the day
    const events = req.db.prepare(`
      SELECT id, type, label, confidence, timestamp, snapshot_path
      FROM events
      WHERE camera_id = ? AND date(timestamp) = ?
      ORDER BY timestamp ASC
    `).all(req.params.cameraId, date);

    res.json({ recordings, events, date });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recordings/:id/stream - Stream video file with range support
router.get('/:id/stream', (req, res) => {
  try {
    const recording = req.db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });

    const filePath = path.join(req.config.RECORDINGS_PATH, recording.file_path);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Video file not found on disk' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
        'Content-Type': 'video/mp4',
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': fileSize,
        'Content-Type': 'video/mp4',
      });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/recordings/:id - Delete a recording
router.delete('/:id', (req, res) => {
  try {
    const recording = req.db.prepare('SELECT * FROM recordings WHERE id = ?').get(req.params.id);
    if (!recording) return res.status(404).json({ error: 'Recording not found' });

    // Delete file from disk
    const filePath = path.join(req.config.RECORDINGS_PATH, recording.file_path);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Delete from DB
    req.db.prepare('DELETE FROM recordings WHERE id = ?').run(req.params.id);

    res.json({ message: 'Recording deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recordings/dates/:cameraId - Get dates that have recordings
router.get('/dates/:cameraId', (req, res) => {
  try {
    const dates = req.db.prepare(`
      SELECT DISTINCT date(start_time) as date,
        COUNT(*) as recording_count,
        SUM(duration_seconds) as total_seconds
      FROM recordings
      WHERE camera_id = ?
      GROUP BY date(start_time)
      ORDER BY date DESC
      LIMIT 90
    `).all(req.params.cameraId);

    res.json(dates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
