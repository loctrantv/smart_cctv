const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { detectImageType, resolveSafePath } = require('../utils/security');
const router = express.Router();

// Use memoryStorage so we can inspect magic bytes before writing to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
});

function saveValidatedPhoto(req) {
  if (!req.file) return { filename: null };
  const detected = detectImageType(req.file.buffer);
  if (!detected) {
    return { error: 'Định dạng ảnh không hợp lệ. Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP.' };
  }
  const filename = `face_${uuidv4()}${detected.ext}`;
  const fullPath = resolveSafePath(req.config.SNAPSHOTS_PATH, filename);
  if (!fullPath) {
    return { error: 'Đường dẫn lưu ảnh không hợp lệ' };
  }
  fs.writeFileSync(fullPath, req.file.buffer);
  return { filename };
}

router.get('/', (req, res) => {
  try {
    const faces = req.db
      .prepare(`
        SELECT f.*, (SELECT COUNT(*) FROM events e WHERE e.face_id = f.id) as event_count,
          (SELECT e.timestamp FROM events e WHERE e.face_id = f.id ORDER BY e.timestamp DESC LIMIT 1) as last_seen
        FROM faces f ORDER BY f.name ASC
      `)
      .all();
    res.json(faces);
  } catch (err) {
    res.status(500).json({ error: 'Không thể tải danh sách khuôn mặt' });
  }
});

router.post('/', upload.single('photo'), (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập tên khuôn mặt' });
    }

    const photoResult = saveValidatedPhoto(req);
    if (photoResult.error) {
      return res.status(400).json({ error: photoResult.error });
    }

    const id = uuidv4();
    req.db
      .prepare('INSERT INTO faces (id, name, photo_path) VALUES (?, ?, ?)')
      .run(id, name.trim().slice(0, 100), photoResult.filename);

    res.status(201).json(req.db.prepare('SELECT * FROM faces WHERE id = ?').get(id));
  } catch (err) {
    res.status(500).json({ error: 'Không thể lưu khuôn mặt' });
  }
});

router.put('/:id', upload.single('photo'), (req, res) => {
  try {
    const face = req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
    if (!face) return res.status(404).json({ error: 'Không tìm thấy khuôn mặt' });

    let newPhotoFilename;
    if (req.file) {
      const photoResult = saveValidatedPhoto(req);
      if (photoResult.error) {
        return res.status(400).json({ error: photoResult.error });
      }
      newPhotoFilename = photoResult.filename;

      // Remove old photo file if present
      if (face.photo_path) {
        const oldPath = resolveSafePath(req.config.SNAPSHOTS_PATH, face.photo_path);
        if (oldPath && fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch {}
        }
      }
    }

    const cleanName =
      req.body && typeof req.body.name === 'string' && req.body.name.trim()
        ? req.body.name.trim().slice(0, 100)
        : null;

    req.db
      .prepare(
        "UPDATE faces SET name = COALESCE(?, name), photo_path = COALESCE(?, photo_path), updated_at = datetime('now') WHERE id = ?"
      )
      .run(cleanName, newPhotoFilename, req.params.id);

    res.json(req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: 'Không thể cập nhật khuôn mặt' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const face = req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
    if (!face) {
      return res.status(404).json({ error: 'Không tìm thấy khuôn mặt' });
    }

    if (face.photo_path) {
      const photoPath = resolveSafePath(req.config.SNAPSHOTS_PATH, face.photo_path);
      if (photoPath && fs.existsSync(photoPath)) {
        try {
          fs.unlinkSync(photoPath);
        } catch {}
      }
    }

    req.db.prepare('DELETE FROM faces WHERE id = ?').run(req.params.id);
    res.json({ message: 'Đã xóa khuôn mặt' });
  } catch (err) {
    res.status(500).json({ error: 'Không thể xóa khuôn mặt' });
  }
});

module.exports = router;
