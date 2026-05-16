const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// GET /api/cameras - List all cameras
router.get('/', (req, res) => {
  try {
    const cameras = req.db.prepare(`
      SELECT c.*,
        (SELECT COUNT(*) FROM recordings r WHERE r.camera_id = c.id AND r.status = 'recording') as active_recordings,
        (SELECT COUNT(*) FROM events e WHERE e.camera_id = c.id AND e.timestamp > datetime('now', '-24 hours')) as events_today
      FROM cameras c
      ORDER BY c.created_at DESC
    `).all();

    // Attach streaming URLs
    const result = cameras.map(cam => ({
      ...cam,
      enabled: !!cam.enabled,
      record_enabled: !!cam.record_enabled,
      detection_enabled: !!cam.detection_enabled,
      streams: {
        webrtc: req.go2rtcClient.getWebRTCUrl(cam.stream_id),
        hls: req.go2rtcClient.getHLSUrl(cam.stream_id),
        snapshot: req.go2rtcClient.getSnapshotUrl(cam.stream_id),
      }
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cameras/:id - Get single camera
router.get('/:id', (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    camera.enabled = !!camera.enabled;
    camera.record_enabled = !!camera.record_enabled;
    camera.detection_enabled = !!camera.detection_enabled;
    camera.streams = {
      webrtc: req.go2rtcClient.getWebRTCUrl(camera.stream_id),
      hls: req.go2rtcClient.getHLSUrl(camera.stream_id),
      snapshot: req.go2rtcClient.getSnapshotUrl(camera.stream_id),
    };

    res.json(camera);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cameras - Add new camera
router.post('/', async (req, res) => {
  try {
    const { name, rtsp_url, location, notes } = req.body;
    if (!name || !rtsp_url) {
      return res.status(400).json({ error: 'name and rtsp_url are required' });
    }

    const id = uuidv4();
    const stream_id = `cam_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

    req.db.prepare(`
      INSERT INTO cameras (id, name, stream_id, rtsp_url, location, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, stream_id, rtsp_url, location || '', notes || '');

    // Register with go2rtc
    await req.go2rtcClient.addStream(stream_id, rtsp_url);

    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    camera.streams = {
      webrtc: req.go2rtcClient.getWebRTCUrl(stream_id),
      hls: req.go2rtcClient.getHLSUrl(stream_id),
      snapshot: req.go2rtcClient.getSnapshotUrl(stream_id),
    };

    req.broadcast({ type: 'camera_added', camera });
    res.status(201).json(camera);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Camera name already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/cameras/:id - Update camera
router.put('/:id', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const {
      name, rtsp_url, enabled, record_enabled, detection_enabled,
      record_mode, location, notes
    } = req.body;

    req.db.prepare(`
      UPDATE cameras SET
        name = COALESCE(?, name),
        rtsp_url = COALESCE(?, rtsp_url),
        enabled = COALESCE(?, enabled),
        record_enabled = COALESCE(?, record_enabled),
        detection_enabled = COALESCE(?, detection_enabled),
        record_mode = COALESCE(?, record_mode),
        location = COALESCE(?, location),
        notes = COALESCE(?, notes),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name, rtsp_url, enabled, record_enabled, detection_enabled,
      record_mode, location, notes, req.params.id
    );

    // Update go2rtc stream if URL changed
    if (rtsp_url && rtsp_url !== camera.rtsp_url) {
      await req.go2rtcClient.addStream(camera.stream_id, rtsp_url);
    }

    // Handle recording state changes
    const updated = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (record_enabled === 1 && !camera.record_enabled) {
      req.recordingManager.startRecording(updated);
    } else if (record_enabled === 0 && camera.record_enabled) {
      req.recordingManager.stopRecording(req.params.id);
    }

    // Handle detection state changes
    if (detection_enabled === 1 && !camera.detection_enabled) {
      req.detectionWorker.startDetection(updated);
    } else if (detection_enabled === 0 && camera.detection_enabled) {
      req.detectionWorker.stopDetection(req.params.id);
    }

    req.broadcast({ type: 'camera_updated', camera: updated });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/cameras/:id - Delete camera
router.delete('/:id', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    // Stop recording and detection
    req.recordingManager.stopRecording(req.params.id);
    req.detectionWorker.stopDetection(req.params.id);

    // Remove from go2rtc
    await req.go2rtcClient.removeStream(camera.stream_id);

    // Delete from DB (cascade will handle recordings, events)
    req.db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);

    req.broadcast({ type: 'camera_removed', cameraId: req.params.id });
    res.json({ message: 'Camera deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cameras/:id/record/start - Start recording
router.post('/:id/record/start', (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    req.recordingManager.startRecording(camera);
    req.db.prepare('UPDATE cameras SET record_enabled = 1 WHERE id = ?').run(req.params.id);

    res.json({ message: 'Recording started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cameras/:id/record/stop - Stop recording
router.post('/:id/record/stop', (req, res) => {
  try {
    req.recordingManager.stopRecording(req.params.id);
    req.db.prepare('UPDATE cameras SET record_enabled = 0 WHERE id = ?').run(req.params.id);

    res.json({ message: 'Recording stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cameras/:id/snapshot - Get current frame
router.get('/:id/snapshot', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });

    const snapshotUrl = req.go2rtcClient.getSnapshotUrl(camera.stream_id);
    res.redirect(snapshotUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
