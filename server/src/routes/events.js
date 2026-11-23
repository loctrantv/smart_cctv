const express = require('express');
const fs = require('fs');
const { resolveSafePath } = require('../utils/security');
const router = express.Router();

// GET /api/events - List detection events with filters
router.get('/', (req, res) => {
  try {
    const { camera_id, type, face_id, start, end, limit = 50, offset = 0 } = req.query;

    const safeLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
    const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

    const where = ['1=1'];
    const params = [];

    if (camera_id) {
      where.push('e.camera_id = ?');
      params.push(String(camera_id));
    }

    if (type) {
      where.push('e.type = ?');
      params.push(String(type));
    }

    if (face_id) {
      where.push('e.face_id = ?');
      params.push(String(face_id));
    }

    if (start) {
      where.push('e.timestamp >= ?');
      params.push(String(start));
    }

    if (end) {
      where.push('e.timestamp <= ?');
      params.push(String(end));
    }

    const events = req.db
      .prepare(`
        SELECT e.*, c.name as camera_name,
          f.name as face_name
        FROM events e
        JOIN cameras c ON e.camera_id = c.id
        LEFT JOIN faces f ON e.face_id = f.id
        WHERE ${where.join(' AND ')}
        ORDER BY e.timestamp DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params, safeLimit, safeOffset);

    const total = req.db
      .prepare(`SELECT COUNT(*) as count FROM events e WHERE ${where.join(' AND ')}`)
      .get(...params).count;

    res.json({ events, total, limit: safeLimit, offset: safeOffset });
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải danh sách sự kiện' });
  }
});

// GET /api/events/stats - Detection statistics
router.get('/stats', (req, res) => {
  try {
    const { camera_id, days = 7 } = req.query;
    const safeDays = Math.min(365, Math.max(1, parseInt(days, 10) || 7));

    let cameraFilter = '';
    const params = [safeDays];

    if (camera_id) {
      cameraFilter = 'AND camera_id = ?';
      params.push(String(camera_id));
    }

    const daily = req.db
      .prepare(`
        SELECT date(timestamp) as date, type, COUNT(*) as count
        FROM events
        WHERE timestamp >= datetime('now', '-' || ? || ' days') ${cameraFilter}
        GROUP BY date(timestamp), type
        ORDER BY date ASC
      `)
      .all(...params);

    const byType = req.db
      .prepare(`
        SELECT type, COUNT(*) as count
        FROM events
        WHERE timestamp >= datetime('now', '-' || ? || ' days') ${cameraFilter}
        GROUP BY type
      `)
      .all(...params);

    const recentCount = req.db
      .prepare(`
        SELECT COUNT(*) as count
        FROM events
        WHERE timestamp >= datetime('now', '-1 hour') ${cameraFilter}
      `)
      .get(...(camera_id ? [String(camera_id)] : [])).count;

    res.json({ daily, byType, recentCount });
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải thống kê sự kiện' });
  }
});

// GET /api/events/:id - Get single event
router.get('/:id', (req, res) => {
  try {
    const event = req.db
      .prepare(`
        SELECT e.*, c.name as camera_name, f.name as face_name
        FROM events e
        JOIN cameras c ON e.camera_id = c.id
        LEFT JOIN faces f ON e.face_id = f.id
        WHERE e.id = ?
      `)
      .get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải thông tin sự kiện' });
  }
});

// DELETE /api/events/:id - Delete an event
router.delete('/:id', (req, res) => {
  try {
    const event = req.db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Không tìm thấy sự kiện' });

    if (event.snapshot_path) {
      const snapshotFilePath = resolveSafePath(req.config.SNAPSHOTS_PATH, event.snapshot_path);
      if (snapshotFilePath && fs.existsSync(snapshotFilePath)) {
        try {
          fs.unlinkSync(snapshotFilePath);
        } catch (e) {
          console.error(`[Event] Failed to delete file ${snapshotFilePath}:`, e.message);
        }
      }
    }

    req.db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
    res.json({ message: 'Đã xóa sự kiện' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa sự kiện' });
  }
});

// DELETE /api/events - Bulk delete events (by query filter or list of IDs)
router.delete('/', (req, res) => {
  try {
    const { ids } = req.body || {};
    const { before, camera_id } = req.query;

    const where = [];
    const params = [];

    if (Array.isArray(ids) && ids.length > 0) {
      const safeIds = ids.slice(0, 500).map(String);
      const placeholders = safeIds.map(() => '?').join(',');
      where.push(`id IN (${placeholders})`);
      params.push(...safeIds);
    } else {
      if (before) {
        where.push('timestamp < ?');
        params.push(String(before));
      }

      if (camera_id) {
        where.push('camera_id = ?');
        params.push(String(camera_id));
      }
    }

    if (where.length === 0) {
      return res.status(400).json({ error: 'Vui lòng chọn ít nhất một điều kiện xóa' });
    }

    const eventsToDelete = req.db
      .prepare(`SELECT snapshot_path FROM events WHERE ${where.join(' AND ')}`)
      .all(...params);

    eventsToDelete.forEach((event) => {
      if (event.snapshot_path) {
        const snapshotFilePath = resolveSafePath(req.config.SNAPSHOTS_PATH, event.snapshot_path);
        if (snapshotFilePath && fs.existsSync(snapshotFilePath)) {
          try {
            fs.unlinkSync(snapshotFilePath);
          } catch {}
        }
      }
    });

    const result = req.db
      .prepare(`DELETE FROM events WHERE ${where.join(' AND ')}`)
      .run(...params);

    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa danh sách sự kiện' });
  }
});

module.exports = router;
