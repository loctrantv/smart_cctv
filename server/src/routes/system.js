const express = require('express');
const os = require('os');
const fs = require('fs');
const { ALLOWED_SETTINGS_KEYS } = require('../db/schema');
const router = express.Router();

router.get('/info', (req, res) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  let diskInfo = { total: 0, free: 0, used: 0 };
  try {
    const stats = fs.statfsSync(req.config.RECORDINGS_PATH);
    diskInfo = {
      total: stats.blocks * stats.bsize,
      free: stats.bfree * stats.bsize,
      used: (stats.blocks - stats.bfree) * stats.bsize,
    };
  } catch {
    /* statfs may not be available on all platforms */
  }

  const cameras = req.db.prepare('SELECT COUNT(*) as count FROM cameras').get().count;
  const activeRec = req.db
    .prepare("SELECT COUNT(*) as count FROM recordings WHERE status = 'recording'")
    .get().count;
  const totalEvents = req.db
    .prepare("SELECT COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-24 hours')")
    .get().count;
  const totalStorage = req.db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM recordings')
    .get().total;

  res.json({
    system: {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model || 'unknown',
      totalMemory: totalMem,
      freeMemory: freeMem,
      usedMemory: totalMem - freeMem,
      memoryPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
    },
    disk: diskInfo,
    app: {
      cameras,
      activeRecordings: activeRec,
      eventsToday: totalEvents,
      totalStorageUsed: totalStorage,
      uptime: process.uptime(),
    },
  });
});

router.get('/settings', (req, res) => {
  try {
    const settings = req.db.prepare('SELECT * FROM settings').all();
    const result = {};
    settings.forEach((s) => {
      if (ALLOWED_SETTINGS_KEYS.has(s.key)) {
        result[s.key] = s.value;
      }
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải cài đặt hệ thống' });
  }
});

router.put('/settings', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({ error: 'Dữ liệu cài đặt không hợp lệ' });
    }

    const update = req.db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    );
    const tx = req.db.transaction(() => {
      for (const [key, value] of Object.entries(req.body)) {
        if (ALLOWED_SETTINGS_KEYS.has(key)) {
          update.run(key, String(value).slice(0, 200));
        }
      }
    });
    tx();

    // Hot-reload settings in DetectionWorker without requiring server restart
    if (req.detectionWorker && typeof req.detectionWorker.reloadSettings === 'function') {
      req.detectionWorker.reloadSettings();
    }

    res.json({ message: 'Đã lưu và áp dụng cài đặt thành công' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể lưu cài đặt hệ thống' });
  }
});

const AI_MODELS_CATALOG = [
  {
    id: 'yolov8n',
    name: 'YOLOv8n Object Detector (Người / Xe / Động vật)',
    category: 'object',
    filename: 'yolov8n.onnx',
    size_mb: 12.3,
    description: 'Phát hiện Người (person), Xe máy, Ô tô, Xe tải, Chó/Mèo trên cả 2 mắt camera (640x640)',
  },
  {
    id: 'yunet_face',
    name: 'YuNet Face & 5-Landmark Detector',
    category: 'face_det',
    filename: 'face_detection_yunet_2023mar.onnx',
    size_mb: 0.23,
    description: 'Phát hiện khuôn mặt tốc độ cực nhanh kèm 5 điểm mốc mắt-mũi-miệng',
  },
  {
    id: 'arcface_mbf',
    name: 'ArcFace MobileFaceNet (512-D Face Embedding)',
    category: 'face_rec',
    filename: 'face_recognition_sface_2021dec.onnx',
    size_mb: 36.9,
    description: 'Trích xuất Vector đặc trưng khuôn mặt để so khớp Cosine Similarity < 0.1ms',
  },
  {
    id: 'alpr_plate',
    name: 'YOLO Vietnam License Plate & OCR',
    category: 'alpr',
    filename: 'license_plate_detector.onnx',
    size_mb: 11.8,
    description: 'Phát hiện & đọc ký tự biển số xe Việt Nam (1 dòng & 2 dòng)',
  },
  {
    id: 'yamnet_audio',
    name: 'YAMNet Smart Audio Classifier',
    category: 'audio',
    filename: 'yamnet.onnx',
    size_mb: 14.5,
    description: 'Phân biệt Tiếng kính vỡ, Tiếng la hét, Trẻ em khóc, Chó sủa, Còi báo động',
  },
];

router.get('/models', (req, res) => {
  const modelsDir = path.resolve(req.config.SNAPSHOTS_PATH, '..', 'models');
  fs.mkdirSync(modelsDir, { recursive: true });
  const list = AI_MODELS_CATALOG.map((m) => {
    const p = path.join(modelsDir, m.filename);
    const exists = fs.existsSync(p);
    const size = exists ? fs.statSync(p).size : 0;
    return {
      ...m,
      installed: size > 1024,
      loaded: size > 1024,
      downloading: false,
      file_size_bytes: size,
    };
  });
  res.json(list);
});

router.post('/models/:modelId/download', async (req, res) => {
  try {
    const urls = {
      yolov8n: 'https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx',
      yunet_face: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
      arcface_mbf: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx',
      alpr_plate: 'https://huggingface.co/DavidDrill69/yolov11-license-plate-detection/resolve/main/license-plate-finetune-v1n.onnx',
      yamnet_audio: 'https://huggingface.co/jafet21/yamnetonnx/resolve/main/yamnet.onnx',
    };
    const spec = AI_MODELS_CATALOG.find((m) => m.id === req.params.modelId);
    if (!spec || !urls[spec.id]) {
      return res.status(404).json({ error: 'Không tìm thấy cấu hình model' });
    }
    const modelsDir = path.resolve(req.config.SNAPSHOTS_PATH, '..', 'models');
    fs.mkdirSync(modelsDir, { recursive: true });
    const resp = await fetch(urls[spec.id]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(path.join(modelsDir, spec.filename), buf);
    res.json({ message: `Đã tải model ${spec.name} thành công!` });
  } catch (err) {
    res.status(500).json({ error: 'Lỗi tải model: ' + err.message });
  }
});

module.exports = router;
