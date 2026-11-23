use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::Local;
use rusqlite::params;
use serde_json::json;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::db::{CameraRow, Database};
use crate::security::resolve_safe_path;
use crate::ws::WsHub;

struct ActiveRecSession {
    stop_tx: Option<oneshot::Sender<()>>,
}

#[derive(Clone)]
pub struct RecordingManager {
    db: Database,
    recordings_path: PathBuf,
    go2rtc_rtsp_url: String,
    ws_hub: WsHub,
    sessions: Arc<Mutex<HashMap<String, ActiveRecSession>>>,
}

impl RecordingManager {
    pub fn new(
        db: Database,
        recordings_path: PathBuf,
        ws_hub: WsHub,
        go2rtc_rtsp_url: String,
    ) -> Self {
        Self {
            db,
            recordings_path,
            go2rtc_rtsp_url: go2rtc_rtsp_url.trim_end_matches('/').to_string(),
            ws_hub,
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Recover orphaned recordings left in 'recording' status after an abrupt power loss or restart
    pub fn recover_orphaned_recordings(&self) {
        let orphaned: Vec<(String, String)> = self.db.with_conn(|conn| {
            let mut list = Vec::new();
            if let Ok(mut stmt) =
                conn.prepare("SELECT id, file_path FROM recordings WHERE status = 'recording'")
            {
                if let Ok(rows) = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                }) {
                    for item in rows.flatten() {
                        list.push(item);
                    }
                }
            }
            list
        });

        if orphaned.is_empty() {
            return;
        }

        let mut recovered = 0;
        for (rec_id, rel_path) in orphaned {
            let full_path = resolve_safe_path(&self.recordings_path, &rel_path);
            let size = full_path
                .as_ref()
                .and_then(|p| fs::metadata(p).ok())
                .map(|m| m.len() as i64)
                .unwrap_or(0);

            if size > 0 {
                self.db.with_conn(|conn| {
                    let _ = conn.execute(
                        "UPDATE recordings SET end_time = COALESCE(end_time, datetime('now')), size_bytes = ?1, status = 'completed' WHERE id = ?2",
                        params![size, rec_id],
                    );
                });
                recovered += 1;
            } else {
                if let Some(p) = full_path {
                    let _ = fs::remove_file(p);
                }
                self.db.with_conn(|conn| {
                    let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![rec_id]);
                });
            }
        }
        tracing::info!("[REC] Recovered {} orphaned recording(s)", recovered);
    }

    pub fn is_recording(&self, camera_id: &str) -> bool {
        self.sessions.lock().unwrap().contains_key(camera_id)
    }

    pub fn start_recording(&self, camera: CameraRow) {
        self.spawn_worker(camera, None, "continuous");
    }

    pub fn start_motion_recording(&self, camera: CameraRow, duration_secs: u64) {
        let safe_dur = duration_secs.clamp(5, 300);
        self.spawn_worker(camera, Some(safe_dur), "motion");
    }

    pub fn start_sound_recording(&self, camera: CameraRow, duration_secs: u64) {
        let safe_dur = duration_secs.clamp(5, 300);
        self.spawn_worker(camera, Some(safe_dur), "sound");
    }

    fn spawn_worker(&self, camera: CameraRow, fixed_duration: Option<u64>, mode: &str) {
        {
            let guard = self.sessions.lock().unwrap();
            if guard.contains_key(&camera.id) {
                return;
            }
        }

        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();

        {
            let mut guard = self.sessions.lock().unwrap();
            guard.insert(
                camera.id.clone(),
                ActiveRecSession {
                    stop_tx: Some(stop_tx),
                },
            );
        }

        let mgr = self.clone();
        let mode_str = mode.to_string();

        tokio::spawn(async move {
            loop {
                let seg_duration = fixed_duration.unwrap_or_else(|| {
                    let mins = mgr
                        .db
                        .get_setting("recording.segment_minutes", "15")
                        .parse::<u64>()
                        .unwrap_or(15)
                        .clamp(1, 120);
                    mins * 60
                });

                let cam_dir = mgr.recordings_path.join(&camera.id);
                let _ = fs::create_dir_all(&cam_dir);

                let now = Local::now();
                let file_name = format!("{}.mp4", now.format("%Y-%m-%d_%H-%M-%S"));
                let rel_path = format!("{}/{}", camera.id, file_name);
                let full_path = cam_dir.join(&file_name);

                let segment_rec_id = Uuid::new_v4().to_string();
                mgr.db.with_conn(|conn| {
                    let _ = conn.execute(
                        "INSERT INTO recordings (id, camera_id, file_path, file_name, start_time, status) VALUES (?1, ?2, ?3, ?4, datetime('now'), 'recording')",
                        params![segment_rec_id, camera.id, rel_path, file_name],
                    );
                });

                mgr.ws_hub.broadcast(json!({
                    "type": "recording_started",
                    "cameraId": camera.id,
                    "recordingId": segment_rec_id
                }));

                let rtsp_input = format!("{}/{}", mgr.go2rtc_rtsp_url, camera.stream_id);
                let start_instant = Instant::now();

                let mut child_res = Command::new("ffmpeg")
                    .args([
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-y",
                        "-rtsp_transport",
                        "tcp",
                        "-i",
                        &rtsp_input,
                        "-c:v",
                        "copy",
                        "-c:a",
                        "aac",
                        "-movflags",
                        "+faststart",
                        "-t",
                        &seg_duration.to_string(),
                    ])
                    .arg(&full_path)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();

                let mut stopped_by_user = false;

                if let Ok(ref mut child) = child_res {
                    tokio::select! {
                        _ = child.wait() => {},
                        _ = &mut stop_rx => {
                            stopped_by_user = true;
                            if let Some(mut stdin) = child.stdin.take() {
                                let _ = stdin.write_all(b"q\n").await;
                            }
                            let _ = tokio::time::timeout(Duration::from_secs(4), child.wait()).await;
                            let _ = child.kill().await;
                        }
                    }
                } else {
                    tracing::error!("[REC] Failed to spawn FFmpeg for {}", camera.name);
                    stopped_by_user = true;
                }

                // Finalize segment metadata in SQLite
                let elapsed_secs = start_instant.elapsed().as_secs() as i64;
                let size_bytes = fs::metadata(&full_path)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);

                if size_bytes > 0 {
                    mgr.db.with_conn(|conn| {
                        let _ = conn.execute(
                            "UPDATE recordings SET end_time = datetime('now'), duration_seconds = ?1, size_bytes = ?2, status = 'completed' WHERE id = ?3",
                            params![elapsed_secs, size_bytes, segment_rec_id],
                        );
                    });
                } else {
                    let _ = fs::remove_file(&full_path);
                    mgr.db.with_conn(|conn| {
                        let _ = conn.execute(
                            "DELETE FROM recordings WHERE id = ?1",
                            params![segment_rec_id],
                        );
                    });
                }

                mgr.ws_hub.broadcast(json!({
                    "type": "recording_completed",
                    "cameraId": camera.id,
                    "recordingId": segment_rec_id
                }));

                if stopped_by_user || mode_str != "continuous" {
                    break;
                }

                if start_instant.elapsed() < Duration::from_secs(8) {
                    tracing::warn!(
                        "[REC] FFmpeg for {} exited quickly. Retrying in 10s...",
                        camera.name
                    );
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(10)) => {},
                        _ = &mut stop_rx => { break; }
                    }
                }
            }

            mgr.sessions.lock().unwrap().remove(&camera.id);
        });
    }

    pub fn stop_recording(&self, camera_id: &str) {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(mut session) = guard.remove(camera_id) {
            if let Some(tx) = session.stop_tx.take() {
                let _ = tx.send(());
            }
            tracing::info!("[REC] Stopping recording for camera: {}", camera_id);
        }
    }

    pub fn stop_all(&self) {
        let ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.stop_recording(&id);
        }
    }
}
