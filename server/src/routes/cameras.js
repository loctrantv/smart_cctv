const express = require('express');
const { v4: uuidv4 } = require('uuid');
const {
  validateRtspUrl,
  maskRtspUrl,
  validateDetectionZone,
} = require('../utils/security');

const router = express.Router();

function formatCameraForClient(cam, go2rtcClient) {
  return {
    ...cam,
    rtsp_url: maskRtspUrl(cam.rtsp_url),
    enabled: !!cam.enabled,
    record_enabled: !!cam.record_enabled,
    detection_enabled: !!cam.detection_enabled,
    streams: go2rtcClient.getClientStreamUrls(cam.id),
  };
}

// GET /api/cameras - List all cameras (with masked RTSP credentials)
router.get('/', (req, res) => {
  try {
    const cameras = req.db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM recordings r WHERE r.camera_id = c.id AND r.status = 'recording') as active_recordings,
          (SELECT COUNT(*) FROM events e WHERE e.camera_id = c.id AND e.timestamp > datetime('now', '-24 hours')) as events_today
        FROM cameras c
        ORDER BY c.created_at DESC
      `)
      .all();

    const result = cameras.map((cam) => formatCameraForClient(cam, req.go2rtcClient));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải danh sách camera' });
  }
});

// GET /api/cameras/:id - Get single camera
router.get('/:id', (req, res) => {
  try {
    const camera = req.db
      .prepare(`
        SELECT c.*,
          (SELECT COUNT(*) FROM recordings r WHERE r.camera_id = c.id AND r.status = 'recording') as active_recordings,
          (SELECT COUNT(*) FROM events e WHERE e.camera_id = c.id AND e.timestamp > datetime('now', '-24 hours')) as events_today
        FROM cameras c
        WHERE c.id = ?
      `)
      .get(req.params.id);

    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    res.json(formatCameraForClient(camera, req.go2rtcClient));
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải thông tin camera' });
  }
});

// POST /api/cameras - Add new camera
router.post('/', async (req, res) => {
  try {
    const { name, rtsp_url, location, notes } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim() || !rtsp_url) {
      return res.status(400).json({ error: 'Vui lòng nhập tên camera và RTSP URL' });
    }

    const cleanName = name.trim().slice(0, 100);
    const rtspCheck = validateRtspUrl(rtsp_url);
    if (!rtspCheck.valid) {
      return res.status(400).json({ error: rtspCheck.error });
    }

    const id = uuidv4();
    const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'camera';
    const stream_id = `cam_${slug}_${id.slice(0, 6)}`;

    req.db
      .prepare(`
        INSERT INTO cameras (id, name, stream_id, rtsp_url, location, notes)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        cleanName,
        stream_id,
        rtspCheck.url,
        typeof location === 'string' ? location.trim().slice(0, 200) : '',
        typeof notes === 'string' ? notes.trim().slice(0, 500) : ''
      );

    await req.go2rtcClient.addStream(stream_id, rtspCheck.url);

    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    const formatted = formatCameraForClient(camera, req.go2rtcClient);

    req.broadcast({ type: 'camera_added', camera: formatted });
    res.status(201).json(formatted);
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Tên hoặc mã luồng camera đã tồn tại' });
    }
    res.status(500).json({ error: 'Không thể thêm camera' });
  }
});

// PUT /api/cameras/:id - Update camera
router.put('/:id', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    const {
      name,
      rtsp_url,
      enabled,
      record_enabled,
      detection_enabled,
      record_mode,
      location,
      notes,
      detection_zone,
    } = req.body || {};

    let validatedRtspUrl = null;
    // Ignore masked URL if frontend echoes it back unchanged
    if (rtsp_url !== undefined && rtsp_url !== null && !String(rtsp_url).includes('******')) {
      const rtspCheck = validateRtspUrl(rtsp_url);
      if (!rtspCheck.valid) {
        return res.status(400).json({ error: rtspCheck.error });
      }
      validatedRtspUrl = rtspCheck.url;
    }

    let validatedZone = null;
    if (detection_zone !== undefined) {
      const zoneCheck = validateDetectionZone(detection_zone);
      if (!zoneCheck.valid) {
        return res.status(400).json({ error: zoneCheck.error });
      }
      validatedZone = zoneCheck.value;
    }

    const nextEnabled = enabled !== undefined ? (enabled ? 1 : 0) : null;
    const nextRecordEnabled = record_enabled !== undefined ? (record_enabled ? 1 : 0) : null;
    const nextDetectionEnabled = detection_enabled !== undefined ? (detection_enabled ? 1 : 0) : null;
    const nextName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;
    const nextLocation = typeof location === 'string' ? location.trim().slice(0, 200) : null;
    const nextNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : null;
    const nextRecordMode =
      record_mode && ['continuous', 'motion', 'schedule'].includes(record_mode)
        ? record_mode
        : null;

    req.db
      .prepare(`
        UPDATE cameras SET
          name = COALESCE(?, name),
          rtsp_url = COALESCE(?, rtsp_url),
          enabled = COALESCE(?, enabled),
          record_enabled = COALESCE(?, record_enabled),
          detection_enabled = COALESCE(?, detection_enabled),
          record_mode = COALESCE(?, record_mode),
          location = COALESCE(?, location),
          notes = COALESCE(?, notes),
          detection_zone = COALESCE(?, detection_zone),
          updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(
        nextName,
        validatedRtspUrl,
        nextEnabled,
        nextRecordEnabled,
        nextDetectionEnabled,
        nextRecordMode,
        nextLocation,
        nextNotes,
        validatedZone,
        req.params.id
      );

    if (validatedRtspUrl && validatedRtspUrl !== camera.rtsp_url) {
      await req.go2rtcClient.addStream(camera.stream_id, validatedRtspUrl);
    }

    const updated = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);

    // Handle recording state changes
    if (nextRecordEnabled === 1 && !camera.record_enabled) {
      req.recordingManager.startRecording(updated);
    } else if (nextRecordEnabled === 0 && camera.record_enabled) {
      req.recordingManager.stopRecording(req.params.id);
    }

    // Handle detection state changes (or refresh camera config in worker if zone changed)
    if (nextDetectionEnabled === 1 && !camera.detection_enabled) {
      req.detectionWorker.startDetection(updated);
      req.detectionWorker.refreshSoundDetectionForCamera(updated);
    } else if (nextDetectionEnabled === 0 && camera.detection_enabled) {
      req.detectionWorker.stopDetection(req.params.id);
      req.detectionWorker.stopSoundDetection(req.params.id);
    } else if (updated.detection_enabled && validatedZone !== null) {
      req.detectionWorker.updateCameraConfig(updated);
    }

    const formatted = formatCameraForClient(updated, req.go2rtcClient);
    req.broadcast({ type: 'camera_updated', camera: formatted });
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: 'Không thể cập nhật camera' });
  }
});

// DELETE /api/cameras/:id - Delete camera
router.delete('/:id', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    req.recordingManager.stopRecording(req.params.id);
    req.detectionWorker.stopDetection(req.params.id);
    req.detectionWorker.stopSoundDetection(req.params.id);

    await req.go2rtcClient.removeStream(camera.stream_id);
    req.db.prepare('DELETE FROM cameras WHERE id = ?').run(req.params.id);

    req.broadcast({ type: 'camera_removed', cameraId: req.params.id });
    res.json({ message: 'Đã xóa camera' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa camera' });
  }
});

// POST /api/cameras/:id/record/start - Start recording
router.post('/:id/record/start', (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    req.recordingManager.startRecording(camera);
    req.db.prepare('UPDATE cameras SET record_enabled = 1 WHERE id = ?').run(req.params.id);

    res.json({ message: 'Đã bắt đầu ghi hình' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể bắt đầu ghi hình' });
  }
});

// POST /api/cameras/:id/record/stop - Stop recording
router.post('/:id/record/stop', (req, res) => {
  try {
    req.recordingManager.stopRecording(req.params.id);
    req.db.prepare('UPDATE cameras SET record_enabled = 0 WHERE id = ?').run(req.params.id);

    res.json({ message: 'Đã dừng ghi hình' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể dừng ghi hình' });
  }
});

// ============================================
// Authenticated Streaming Proxy Endpoints (go2rtc)
// ============================================

// POST /api/cameras/:id/webrtc - Authenticated WebRTC SDP exchange proxy
router.post('/:id/webrtc', express.text({ type: ['application/sdp', 'text/plain'], limit: '64kb' }), async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    const sdpOffer = typeof req.body === 'string' ? req.body : '';
    if (!sdpOffer) {
      return res.status(400).json({ error: 'Thiếu SDP offer' });
    }

    const answerSdp = await req.go2rtcClient.exchangeWebRTCOffer(camera.stream_id, sdpOffer);
    res.setHeader('Content-Type', 'application/sdp');
    res.send(answerSdp);
  } catch (err) {
    res.status(502).json({ error: 'Không thể kết nối WebRTC tới go2rtc' });
  }
});

// GET /api/cameras/:id/snapshot - Authenticated snapshot proxy
router.get('/:id/snapshot', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    const upstream = await req.go2rtcClient.fetchRaw(
      `/api/frame.jpeg?src=${encodeURIComponent(camera.stream_id)}`
    );
    if (!upstream.ok) {
      return res.status(502).json({ error: 'Không thể lấy ảnh từ camera' });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Lỗi kết nối luồng snapshot' });
  }
});

// GET /api/cameras/:id/hls/* - Authenticated HLS playlist & segment proxy (supports nested hls/ paths from go2rtc)
router.get('/:id/hls/*', async (req, res) => {
  try {
    const camera = req.db.prepare('SELECT * FROM cameras WHERE id = ?').get(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Không tìm thấy camera' });

    const subPath = req.params[0] || '';
    // Allow safe HLS subpaths (e.g. stream.m3u8, hls/playlist.m3u8, hls/segment.ts, hls/init.mp4)
    if (!subPath || subPath.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(subPath)) {
      return res.status(400).json({ error: 'Đường dẫn HLS không hợp lệ' });
    }

    const queryParams = new URLSearchParams(req.query);
    queryParams.delete('token');
    if (!queryParams.has('src') && !queryParams.has('id')) {
      queryParams.set('src', camera.stream_id);
    }

    const upstream = await req.go2rtcClient.fetchRaw(`/api/${subPath}?${queryParams.toString()}`);
    if (!upstream.ok) {
      return res.status(upstream.status).end();
    }

    const contentType = upstream.headers.get('content-type') || 'application/vnd.apple.mpegurl';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');

    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(502).json({ error: 'Lỗi kết nối luồng HLS' });
  }
});

module.exports = router;
