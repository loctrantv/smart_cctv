use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::hash_password;

pub fn allowed_settings_keys() -> HashSet<&'static str> {
    HashSet::from([
        "storage.max_gb",
        "storage.retention_days",
        "detection.interval_ms",
        "detection.confidence_threshold",
        "detection.person_enabled",
        "detection.face_enabled",
        "detection.vehicle_enabled",
        "detection.animal_enabled",
        "detection.plate_enabled",
        "detection.tripwire_enabled",
        "recording.segment_minutes",
        "recording.on_motion_enabled",
        "recording.on_motion_duration",
        "system.timezone",
        "sound.detection_enabled",
        "sound.ai_yamnet_enabled",
        "sound.night_start",
        "sound.night_end",
        "sound.threshold_db",
        "sound.recording_enabled",
        "sound.recording_duration",
    ])
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRow {
    pub id: String,
    pub username: String,
    pub password_hash: String,
    pub token_version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CameraRow {
    pub id: String,
    pub name: String,
    pub stream_id: String,
    pub rtsp_url: String,
    pub enabled: i64,
    pub record_enabled: i64,
    pub detection_enabled: i64,
    pub record_mode: String,
    pub snapshot_url: Option<String>,
    pub location: String,
    pub notes: String,
    pub detection_zone: String,
    pub tripwire_config: String,
    pub ai_tasks: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub active_recordings: i64,
    #[serde(default)]
    pub events_today: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingRow {
    pub id: String,
    pub camera_id: String,
    pub file_path: String,
    pub file_name: String,
    pub start_time: String,
    pub end_time: Option<String>,
    pub duration_seconds: i64,
    pub size_bytes: i64,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub camera_id: String,
    pub r#type: String,
    pub label: String,
    pub confidence: f64,
    pub timestamp: String,
    pub snapshot_path: Option<String>,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
    pub face_id: Option<String>,
    pub metadata: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceRow {
    pub id: String,
    pub name: String,
    pub photo_path: Option<String>,
    pub encoding: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub event_count: i64,
    pub last_seen: Option<String>,
}

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn init(db_path: &Path) -> Self {
        let conn = Connection::open(db_path).expect("Failed to open SQLite database");

        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;

            CREATE TABLE IF NOT EXISTS users (
              id TEXT PRIMARY KEY,
              username TEXT UNIQUE NOT NULL,
              password_hash TEXT NOT NULL,
              token_version INTEGER DEFAULT 1,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            );

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
              tripwire_config TEXT DEFAULT '',
              ai_tasks TEXT DEFAULT 'motion,person,face,plate,sound',
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            );

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

            CREATE TABLE IF NOT EXISTS faces (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              photo_path TEXT,
              encoding TEXT,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            );

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

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at TEXT DEFAULT (datetime('now'))
            );
            "#,
        )
        .expect("Failed to initialize database schema");

        // Safe column migrations for existing databases
        let _ = conn.execute("ALTER TABLE cameras ADD COLUMN detection_zone TEXT DEFAULT ''", []);
        let _ = conn.execute("ALTER TABLE cameras ADD COLUMN tripwire_config TEXT DEFAULT ''", []);
        let _ = conn.execute(
            "ALTER TABLE cameras ADD COLUMN ai_tasks TEXT DEFAULT 'motion,person,face,plate,sound'",
            [],
        );

        // Seed admin account if users table is empty
        let user_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
            .unwrap_or(0);
        if user_count == 0 {
            let admin_user = std::env::var("ADMIN_USERNAME")
                .unwrap_or_else(|_| "admin".to_string())
                .trim()
                .to_string();
            let admin_pass =
                std::env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin123".to_string());
            let hash = hash_password(&admin_pass);
            let _ = conn.execute(
                "INSERT INTO users (id, username, password_hash, token_version) VALUES (?1, ?2, ?3, 1)",
                params![Uuid::new_v4().to_string(), admin_user, hash],
            );
            tracing::info!("[DB] Seeded initial admin user: {}", admin_user);
        }

        // Seed default settings
        let defaults = [
            (
                "storage.max_gb",
                std::env::var("MAX_STORAGE_GB").unwrap_or_else(|_| "100".to_string()),
            ),
            (
                "storage.retention_days",
                std::env::var("RETENTION_DAYS").unwrap_or_else(|_| "30".to_string()),
            ),
            (
                "detection.interval_ms",
                std::env::var("DETECTION_INTERVAL_MS").unwrap_or_else(|_| "2500".to_string()),
            ),
            ("detection.confidence_threshold", "0.45".to_string()),
            ("detection.person_enabled", "1".to_string()),
            ("detection.face_enabled", "1".to_string()),
            ("detection.vehicle_enabled", "1".to_string()),
            ("detection.animal_enabled", "1".to_string()),
            ("detection.plate_enabled", "1".to_string()),
            ("detection.tripwire_enabled", "1".to_string()),
            ("recording.segment_minutes", "15".to_string()),
            ("recording.on_motion_enabled", "0".to_string()),
            ("recording.on_motion_duration", "30".to_string()),
            (
                "system.timezone",
                std::env::var("TZ").unwrap_or_else(|_| "Asia/Ho_Chi_Minh".to_string()),
            ),
            ("sound.detection_enabled", "0".to_string()),
            ("sound.ai_yamnet_enabled", "1".to_string()),
            ("sound.night_start", "22".to_string()),
            ("sound.night_end", "6".to_string()),
            ("sound.threshold_db", "-20".to_string()),
            ("sound.recording_enabled", "1".to_string()),
            ("sound.recording_duration", "30".to_string()),
        ];

        for (k, v) in defaults {
            let _ = conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
                params![k, v],
            );
        }

        tracing::info!("[DB] SQLite WAL database initialized at {:?}", db_path);
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    pub fn with_conn<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&Connection) -> R,
    {
        let guard = self.conn.lock().unwrap();
        f(&guard)
    }

    pub fn get_user_by_username(&self, username: &str) -> Option<UserRow> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT id, username, password_hash, token_version FROM users WHERE username = ?1",
                params![username],
                |r| {
                    Ok(UserRow {
                        id: r.get(0)?,
                        username: r.get(1)?,
                        password_hash: r.get(2)?,
                        token_version: r.get(3)?,
                    })
                },
            )
            .optional()
            .unwrap_or(None)
        })
    }

    pub fn get_setting(&self, key: &str, default_val: &str) -> String {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .unwrap_or(None)
            .unwrap_or_else(|| default_val.to_string())
        })
    }

    pub fn get_all_settings(&self) -> HashMap<String, String> {
        let allowed = allowed_settings_keys();
        self.with_conn(|conn| {
            let mut map = HashMap::new();
            if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM settings") {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                }) {
                    for row in rows.flatten() {
                        if allowed.contains(row.0.as_str()) {
                            map.insert(row.0, row.1);
                        }
                    }
                }
            }
            map
        })
    }

    pub fn list_cameras(&self) -> Vec<CameraRow> {
        self.with_conn(|conn| {
            let mut list = Vec::new();
            let sql = r#"
                SELECT c.id, c.name, c.stream_id, c.rtsp_url, c.enabled, c.record_enabled,
                       c.detection_enabled, c.record_mode, c.snapshot_url, c.location, c.notes,
                       COALESCE(c.detection_zone, ''), COALESCE(c.tripwire_config, ''),
                       COALESCE(c.ai_tasks, 'motion,person,face,plate,sound'),
                       c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id = c.id AND r.status = 'recording') as active_recordings,
                       (SELECT COUNT(*) FROM events e WHERE e.camera_id = c.id AND e.timestamp > datetime('now', '-24 hours')) as events_today
                FROM cameras c
                ORDER BY c.created_at DESC
            "#;
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok(CameraRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        stream_id: r.get(2)?,
                        rtsp_url: r.get(3)?,
                        enabled: r.get(4)?,
                        record_enabled: r.get(5)?,
                        detection_enabled: r.get(6)?,
                        record_mode: r.get(7)?,
                        snapshot_url: r.get(8)?,
                        location: r.get(9)?,
                        notes: r.get(10)?,
                        detection_zone: r.get(11)?,
                        tripwire_config: r.get(12)?,
                        ai_tasks: r.get(13)?,
                        created_at: r.get(14)?,
                        updated_at: r.get(15)?,
                        active_recordings: r.get(16)?,
                        events_today: r.get(17)?,
                    })
                }) {
                    for item in rows.flatten() {
                        list.push(item);
                    }
                }
            }
            list
        })
    }

    pub fn get_camera(&self, id: &str) -> Option<CameraRow> {
        self.with_conn(|conn| {
            let sql = r#"
                SELECT c.id, c.name, c.stream_id, c.rtsp_url, c.enabled, c.record_enabled,
                       c.detection_enabled, c.record_mode, c.snapshot_url, c.location, c.notes,
                       COALESCE(c.detection_zone, ''), COALESCE(c.tripwire_config, ''),
                       COALESCE(c.ai_tasks, 'motion,person,face,plate,sound'),
                       c.created_at, c.updated_at,
                       (SELECT COUNT(*) FROM recordings r WHERE r.camera_id = c.id AND r.status = 'recording') as active_recordings,
                       (SELECT COUNT(*) FROM events e WHERE e.camera_id = c.id AND e.timestamp > datetime('now', '-24 hours')) as events_today
                FROM cameras c
                WHERE c.id = ?1
            "#;
            conn.query_row(sql, params![id], |r| {
                Ok(CameraRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    stream_id: r.get(2)?,
                    rtsp_url: r.get(3)?,
                    enabled: r.get(4)?,
                    record_enabled: r.get(5)?,
                    detection_enabled: r.get(6)?,
                    record_mode: r.get(7)?,
                    snapshot_url: r.get(8)?,
                    location: r.get(9)?,
                    notes: r.get(10)?,
                    detection_zone: r.get(11)?,
                    tripwire_config: r.get(12)?,
                    ai_tasks: r.get(13)?,
                    created_at: r.get(14)?,
                    updated_at: r.get(15)?,
                    active_recordings: r.get(16)?,
                    events_today: r.get(17)?,
                })
            })
            .optional()
            .unwrap_or(None)
        })
    }

    pub fn list_faces(&self) -> Vec<FaceRow> {
        self.with_conn(|conn| {
            let mut list = Vec::new();
            let sql = r#"
                SELECT f.id, f.name, f.photo_path, f.encoding, f.created_at, f.updated_at,
                       (SELECT COUNT(*) FROM events e WHERE e.face_id = f.id) as event_count,
                       (SELECT e.timestamp FROM events e WHERE e.face_id = f.id ORDER BY e.timestamp DESC LIMIT 1) as last_seen
                FROM faces f
                ORDER BY f.name ASC
            "#;
            if let Ok(mut stmt) = conn.prepare(sql) {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok(FaceRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        photo_path: r.get(2)?,
                        encoding: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                        event_count: r.get(6)?,
                        last_seen: r.get(7)?,
                    })
                }) {
                    for row in rows.flatten() {
                        list.push(row);
                    }
                }
            }
            list
        })
    }
}
