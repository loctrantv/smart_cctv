const express = require('express');
const os = require('os');
const fs = require('fs');
const path = require('path');
const router = express.Router();

router.get('/info', (req, res) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();

  // Disk usage for recordings path
  let diskInfo = { total: 0, free: 0, used: 0 };
  try {
    const stats = fs.statfsSync(req.config.RECORDINGS_PATH);
    diskInfo = {
      total: stats.blocks * stats.bsize,
      free: stats.bfree * stats.bsize,
      used: (stats.blocks - stats.bfree) * stats.bsize,
    };
  } catch (e) { /* statfs may not be available on all platforms */ }

  const cameras = req.db.prepare('SELECT COUNT(*) as count FROM cameras').get().count;
  const activeRec = req.db.prepare("SELECT COUNT(*) as count FROM recordings WHERE status = 'recording'").get().count;
  const totalEvents = req.db.prepare("SELECT COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-24 hours')").get().count;
  const totalStorage = req.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM recordings').get().total;

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
    settings.forEach(s => { result[s.key] = s.value; });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings', (req, res) => {
  try {
    const update = req.db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))");
    const tx = req.db.transaction(() => {
      for (const [key, value] of Object.entries(req.body)) {
        update.run(key, String(value));
      }
    });
    tx();
    res.json({ message: 'Settings updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
