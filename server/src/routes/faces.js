const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, req.config.SNAPSHOTS_PATH),
  filename: (req, file, cb) => cb(null, `face_${uuidv4()}${path.extname(file.originalname) || '.jpg'}`),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

router.get('/', (req, res) => {
  try {
    const faces = req.db.prepare(`
      SELECT f.*, (SELECT COUNT(*) FROM events e WHERE e.face_id = f.id) as event_count,
        (SELECT e.timestamp FROM events e WHERE e.face_id = f.id ORDER BY e.timestamp DESC LIMIT 1) as last_seen
      FROM faces f ORDER BY f.name ASC
    `).all();
    res.json(faces);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', upload.single('photo'), (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const id = uuidv4();
    req.db.prepare('INSERT INTO faces (id, name, photo_path) VALUES (?, ?, ?)').run(id, name, req.file ? req.file.filename : null);
    res.status(201).json(req.db.prepare('SELECT * FROM faces WHERE id = ?').get(id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', upload.single('photo'), (req, res) => {
  try {
    const face = req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id);
    if (!face) return res.status(404).json({ error: 'Face not found' });
    req.db.prepare('UPDATE faces SET name = COALESCE(?, name), photo_path = COALESCE(?, photo_path), updated_at = datetime(\'now\') WHERE id = ?')
      .run(req.body.name, req.file ? req.file.filename : undefined, req.params.id);
    res.json(req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', (req, res) => {
  try {
    if (!req.db.prepare('SELECT * FROM faces WHERE id = ?').get(req.params.id))
      return res.status(404).json({ error: 'Face not found' });
    req.db.prepare('DELETE FROM faces WHERE id = ?').run(req.params.id);
    res.json({ message: 'Face deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
