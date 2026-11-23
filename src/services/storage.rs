use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use rusqlite::params;

use crate::db::Database;
use crate::security::resolve_safe_path;

#[derive(Clone)]
pub struct StorageManager {
    db: Database,
    recordings_path: PathBuf,
    snapshots_path: PathBuf,
}

impl StorageManager {
    pub fn new(db: Database, recordings_path: PathBuf, snapshots_path: PathBuf) -> Self {
        Self {
            db,
            recordings_path,
            snapshots_path,
        }
    }

    pub fn start_scheduler(&self) {
        let mgr = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(3600));
            loop {
                interval.tick().await;
                mgr.cleanup();
            }
        });
        tracing::info!("[STORAGE] Hourly retention cleanup scheduler started");
    }

    pub fn cleanup(&self) {
        let retention_days = self
            .db
            .get_setting("storage.retention_days", "30")
            .parse::<i64>()
            .unwrap_or(30)
            .max(1);
        let max_gb = self
            .db
            .get_setting("storage.max_gb", "100")
            .parse::<i64>()
            .unwrap_or(100)
            .max(1);

        // 1. Remove recordings older than retention_days
        let old_recs: Vec<(String, String, i64)> = self.db.with_conn(|conn| {
            let mut list = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT id, file_path, size_bytes FROM recordings WHERE start_time < datetime('now', '-' || ?1 || ' days') AND status = 'completed'",
            ) {
                if let Ok(rows) = stmt.query_map(params![retention_days], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                }) {
                    for row in rows.flatten() {
                        list.push(row);
                    }
                }
            }
            list
        });

        let mut deleted_count = 0;
        let mut freed_bytes: i64 = 0;

        for (id, rel_path, size) in old_recs {
            if let Some(full) = resolve_safe_path(&self.recordings_path, &rel_path) {
                if full.exists() {
                    let _ = fs::remove_file(full);
                    freed_bytes += size;
                }
            }
            self.db.with_conn(|conn| {
                let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
            });
            deleted_count += 1;
        }

        // 2. Enforce max_gb storage quota (clean down to 90%)
        let total_bytes: i64 = self.db.with_conn(|conn| {
            conn.query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM recordings",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
        });
        let max_bytes = max_gb * 1024 * 1024 * 1024;

        if total_bytes > max_bytes {
            let excess: Vec<(String, String, i64)> = self.db.with_conn(|conn| {
                let mut list = Vec::new();
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT id, file_path, size_bytes FROM recordings WHERE status = 'completed' ORDER BY start_time ASC",
                ) {
                    if let Ok(rows) = stmt.query_map([], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    }) {
                        for row in rows.flatten() {
                            list.push(row);
                        }
                    }
                }
                list
            });

            let mut current_total = total_bytes;
            let target_bytes = (max_bytes as f64 * 0.9) as i64;
            for (id, rel_path, size) in excess {
                if current_total <= target_bytes {
                    break;
                }
                if let Some(full) = resolve_safe_path(&self.recordings_path, &rel_path) {
                    let _ = fs::remove_file(full);
                }
                self.db.with_conn(|conn| {
                    let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
                });
                current_total -= size;
                freed_bytes += size;
                deleted_count += 1;
            }
        }

        // 3. Clean old events & snapshot files
        let old_events: Vec<(String, Option<String>)> = self.db.with_conn(|conn| {
            let mut list = Vec::new();
            if let Ok(mut stmt) = conn.prepare(
                "SELECT id, snapshot_path FROM events WHERE timestamp < datetime('now', '-' || ?1 || ' days')",
            ) {
                if let Ok(rows) = stmt.query_map(params![retention_days], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                }) {
                    for row in rows.flatten() {
                        list.push(row);
                    }
                }
            }
            list
        });

        for (_, snap_opt) in old_events {
            if let Some(rel) = snap_opt {
                if let Some(full) = resolve_safe_path(&self.snapshots_path, &rel) {
                    let _ = fs::remove_file(full);
                }
            }
        }
        self.db.with_conn(|conn| {
            let _ = conn.execute(
                "DELETE FROM events WHERE timestamp < datetime('now', '-' || ?1 || ' days')",
                params![retention_days],
            );
        });

        if deleted_count > 0 {
            tracing::info!(
                "[STORAGE] Cleaned {} recordings, freed {:.1} MB",
                deleted_count,
                freed_bytes as f64 / (1024.0 * 1024.0)
            );
        }
    }
}
