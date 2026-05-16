const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

/**
 * Storage Manager - Handles disk cleanup and retention policies
 */
class StorageManager {
  constructor(db, recordingsPath, snapshotsPath) {
    this.db = db;
    this.recordingsPath = recordingsPath;
    this.snapshotsPath = snapshotsPath;
  }

  startScheduler() {
    // Run cleanup every hour
    cron.schedule('0 * * * *', () => {
      console.log('[STORAGE] Running scheduled cleanup...');
      this.cleanup();
    });
    console.log('[STORAGE] Cleanup scheduler started (hourly)');
  }

  cleanup() {
    try {
      const retentionDays = parseInt(this._getSetting('storage.retention_days', '30'));
      const maxGB = parseInt(this._getSetting('storage.max_gb', '100'));

      // Delete recordings older than retention period
      const oldRecordings = this.db.prepare(`
        SELECT * FROM recordings
        WHERE start_time < datetime('now', '-' || ? || ' days') AND status = 'completed'
      `).all(retentionDays);

      let deletedCount = 0;
      let freedBytes = 0;

      oldRecordings.forEach(rec => {
        const filePath = path.join(this.recordingsPath, rec.file_path);
        if (fs.existsSync(filePath)) {
          freedBytes += rec.size_bytes || 0;
          fs.unlinkSync(filePath);
        }
        this.db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
        deletedCount++;
      });

      // If still over max storage, delete oldest first
      const totalBytes = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM recordings').get().total;
      const maxBytes = maxGB * 1024 * 1024 * 1024;

      if (totalBytes > maxBytes) {
        const excess = this.db.prepare(`
          SELECT * FROM recordings WHERE status = 'completed'
          ORDER BY start_time ASC
        `).all();

        let currentTotal = totalBytes;
        for (const rec of excess) {
          if (currentTotal <= maxBytes * 0.9) break; // Clean to 90%
          const filePath = path.join(this.recordingsPath, rec.file_path);
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          this.db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id);
          currentTotal -= (rec.size_bytes || 0);
          deletedCount++;
          freedBytes += rec.size_bytes || 0;
        }
      }

      // Clean old events (keep 7 days)
      this.db.prepare("DELETE FROM events WHERE timestamp < datetime('now', '-7 days')").run();

      if (deletedCount > 0) {
        console.log(`[STORAGE] Cleaned ${deletedCount} recordings, freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
      }
    } catch (err) {
      console.error('[STORAGE] Cleanup error:', err.message);
    }
  }

  getStorageInfo() {
    const total = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) as total FROM recordings').get().total;
    const count = this.db.prepare('SELECT COUNT(*) as count FROM recordings').get().count;
    return { totalBytes: total, recordingCount: count };
  }

  _getSetting(key, defaultValue) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : defaultValue;
  }
}

module.exports = StorageManager;
