const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const { hashPassword } = require('../utils/auth');

const ALLOWED_SETTINGS_KEYS = new Set([
  'storage.max_gb',
  'storage.retention_days',
  'detection.interval_ms',
  'detection.confidence_threshold',
  'detection.person_enabled',
  'detection.face_enabled',
  'detection.vehicle_enabled',
  'detection.animal_enabled',
  'detection.plate_enabled',
  'detection.tripwire_enabled',
  'recording.segment_minutes',
  'recording.on_motion_enabled',
  'recording.on_motion_duration',
  'system.timezone',
  'sound.detection_enabled',
  'sound.ai_yamnet_enabled',
  'sound.night_start',
  'sound.night_end',
  'sound.threshold_db',
  'sound.recording_enabled',
  'sound.recording_duration',
]);

function initDatabase(dbPath) {
  const db = new Database(dbPath);

  // Enable WAL mode for better concurrent performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  db.exec(`
    -- ============================================
    -- Users (Admin authentication with scrypt hash)
    -- ============================================
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      token_version INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================
    -- Cameras
    -- ============================================
    CREATE TABLE IF NOT EXISTS cameras (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stream_id TEXT UNIQUE NOT NULL,
      rtsp_url TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      record_enabled INTEGER DEFAULT 0,
      detection_enabled INTEGER DEFAULT 0,
      record_mode TEXT DEFAULT 'continuous',
      snapshot_url TEXT,
      location TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      detection_zone TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================
    -- Recordings
    -- ============================================
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_seconds INTEGER DEFAULT 0,
      size_bytes INTEGER DEFAULT 0,
      status TEXT DEFAULT 'recording',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_recordings_camera_time
    ON recordings(camera_id, start_time);

    CREATE INDEX IF NOT EXISTS idx_recordings_status
    ON recordings(status);

    -- ============================================
    -- Detection Events
    -- ============================================
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      type TEXT NOT NULL,
      label TEXT DEFAULT '',
      confidence REAL DEFAULT 0,
      timestamp TEXT NOT NULL,
      snapshot_path TEXT,
      bbox_x REAL DEFAULT 0,
      bbox_y REAL DEFAULT 0,
      bbox_w REAL DEFAULT 0,
      bbox_h REAL DEFAULT 0,
      face_id TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE,
      FOREIGN KEY (face_id) REFERENCES faces(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_camera_time
    ON events(camera_id, timestamp);

    CREATE INDEX IF NOT EXISTS idx_events_type
    ON events(type);

    -- ============================================
    -- Known Faces
    -- ============================================
    CREATE TABLE IF NOT EXISTS faces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      photo_path TEXT,
      encoding TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- ============================================
    -- Recording Schedules
    -- ============================================
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      camera_id TEXT NOT NULL,
      type TEXT DEFAULT 'record',
      days TEXT DEFAULT '0,1,2,3,4,5,6',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (camera_id) REFERENCES cameras(id) ON DELETE CASCADE
    );

    -- ============================================
    -- System Settings
    -- ============================================
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Safe migration: add detection_zone, tripwire_config, ai_tasks to cameras if upgrading from older DB
  try {
    db.exec("ALTER TABLE cameras ADD COLUMN detection_zone TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec("ALTER TABLE cameras ADD COLUMN tripwire_config TEXT DEFAULT ''");
  } catch {}
  try {
    db.exec("ALTER TABLE cameras ADD COLUMN ai_tasks TEXT DEFAULT 'motion,person,face,plate,sound'");
  } catch {}

  // Seed initial admin user from environment variables if no user exists
  const existingUsers = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (existingUsers === 0) {
    const adminUser = (process.env.ADMIN_USERNAME || 'admin').trim();
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (adminPass === 'admin123' || adminPass === 'ChangeMe_StrongPassword_2026!') {
      console.warn(
        '[SECURITY WARNING] Admin account initialized with default password from .env. ' +
        'Please change your password immediately in Settings -> Bảo mật!'
      );
    }
    db.prepare(`
      INSERT INTO users (id, username, password_hash, token_version)
      VALUES (?, ?, ?, 1)
    `).run(uuidv4(), adminUser, hashPassword(adminPass));
    console.log(`[DB] Seeded admin account: ${adminUser}`);
  }

  // Insert default settings if not exist
  const insertSetting = db.prepare(`
    INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)
  `);

  const defaults = {
    'storage.max_gb': process.env.MAX_STORAGE_GB || '100',
    'storage.retention_days': process.env.RETENTION_DAYS || '30',
    'detection.interval_ms': process.env.DETECTION_INTERVAL_MS || '3000',
    'detection.confidence_threshold': '0.5',
    'detection.person_enabled': '1',
    'detection.face_enabled': '1',
    'recording.segment_minutes': '15',
    'recording.on_motion_enabled': '0',
    'recording.on_motion_duration': '30',
    'system.timezone': process.env.TZ || 'Asia/Ho_Chi_Minh',
    // Sound detection settings
    'sound.detection_enabled': '0',
    'sound.night_start': '22',
    'sound.night_end': '6',
    'sound.threshold_db': '-20',
    'sound.recording_enabled': '1',
    'sound.recording_duration': '30',
  };

  const insertMany = db.transaction(() => {
    for (const [key, value] of Object.entries(defaults)) {
      insertSetting.run(key, String(value));
    }
  });
  insertMany();

  console.log('[DB] Database initialized successfully');
  return db;
}

module.exports = { initDatabase, ALLOWED_SETTINGS_KEYS };
