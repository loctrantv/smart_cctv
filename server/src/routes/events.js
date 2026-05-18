const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

// GET /api/events - List detection events with filters
router.get('/', (req, res) => {
  try {
    const { camera_id, type, face_id, start, end, limit = 50, offset = 0 } = req.query;

    let where = ['1=1'];
    let params = [];

    if (camera_id) {
      where.push('e.camera_id = ?');
      params.push(camera_id);
    }

    if (type) {
      where.push('e.type = ?');
      params.push(type);
    }

    if (face_id) {
      where.push('e.face_id = ?');
      params.push(face_id);
    }

    if (start) {
      where.push('e.timestamp >= ?');
      params.push(start);
    }

    if (end) {
      where.push('e.timestamp <= ?');
      params.push(end);
    }

    const events = req.db.prepare(`
      SELECT e.*, c.name as camera_name,
        f.name as face_name
      FROM events e
      JOIN cameras c ON e.camera_id = c.id
      LEFT JOIN faces f ON e.face_id = f.id
      WHERE ${where.join(' AND ')}
      ORDER BY e.timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, parseInt(limit), parseInt(offset));

    const total = req.db.prepare(`
      SELECT COUNT(*) as count FROM events e WHERE ${where.join(' AND ')}
    `).get(...params).count;

    res.json({ events, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/stats - Detection statistics
router.get('/stats', (req, res) => {
  try {
    const { camera_id, days = 7 } = req.query;

    let cameraFilter = '';
    let params = [days];

    if (camera_id) {
      cameraFilter = 'AND camera_id = ?';
      params.push(camera_id);
    }

    // Events per day
    const daily = req.db.prepare(`
      SELECT date(timestamp) as date, type, COUNT(*) as count
      FROM events
      WHERE timestamp >= datetime('now', '-' || ? || ' days') ${cameraFilter}
      GROUP BY date(timestamp), type
      ORDER BY date ASC
    `).all(...params);

    // Total by type
    const byType = req.db.prepare(`
      SELECT type, COUNT(*) as count
      FROM events
      WHERE timestamp >= datetime('now', '-' || ? || ' days') ${cameraFilter}
      GROUP BY type
    `).all(...params);

    // Recent events count
    const recentCount = req.db.prepare(`
      SELECT COUNT(*) as count
      FROM events
      WHERE timestamp >= datetime('now', '-1 hour') ${cameraFilter}
    `).get(...(camera_id ? [camera_id] : [])).count;

    res.json({ daily, byType, recentCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/events/:id - Get single event
router.get('/:id', (req, res) => {
  try {
    const event = req.db.prepare(`
      SELECT e.*, c.name as camera_name, f.name as face_name
      FROM events e
      JOIN cameras c ON e.camera_id = c.id
      LEFT JOIN faces f ON e.face_id = f.id
      WHERE e.id = ?
    `).get(req.params.id);

    if (!event) return res.status(404).json({ error: 'Event not found' });

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/:id - Delete an event
router.delete('/:id', (req, res) => {
  try {
    const event = req.db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Delete snapshot image file from disk if exists
    if (event.snapshot_path) {
      const snapshotFilePath = path.join(req.config.SNAPSHOTS_PATH, event.snapshot_path);
      if (fs.existsSync(snapshotFilePath)) {
        try {
          fs.unlinkSync(snapshotFilePath);
        } catch (e) {
          console.error(`[Event] Failed to delete file ${snapshotFilePath}:`, e.message);
        }
      }
    }

    req.db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events - Bulk delete events
router.delete('/', (req, res) => {
  try {
    const { before, camera_id } = req.query;

    let where = [];
    let params = [];

    if (before) {
      where.push('timestamp < ?');
      params.push(before);
    }

    if (camera_id) {
      where.push('camera_id = ?');
      params.push(camera_id);
    }

    if (where.length === 0) {
      return res.status(400).json({ error: 'Specify at least one filter (before, camera_id)' });
    }

    // Find all events to delete their physical snapshot files first
    const eventsToDelete = req.db.prepare(`
      SELECT snapshot_path FROM events WHERE ${where.join(' AND ')}
    `).all(...params);

    eventsToDelete.forEach(event => {
      if (event.snapshot_path) {
        const snapshotFilePath = path.join(req.config.SNAPSHOTS_PATH, event.snapshot_path);
        if (fs.existsSync(snapshotFilePath)) {
          try {
            fs.unlinkSync(snapshotFilePath);
          } catch (e) {}
        }
      }
    });

    const result = req.db.prepare(`
      DELETE FROM events WHERE ${where.join(' AND ')}
    `).run(...params);

    res.json({ deleted: result.changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
