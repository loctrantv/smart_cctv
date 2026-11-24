use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::params;
use serde_json::{json, Value};
use sysinfo::{Disks, System};

use crate::{db::allowed_settings_keys, security::detect_image_type, AppState};

pub async fn system_info_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut sys = System::new_all();
    sys.refresh_memory();
    sys.refresh_cpu_all();

    let total_mem = sys.total_memory();
    let used_mem = sys.used_memory();
    let free_mem = total_mem.saturating_sub(used_mem);
    let mem_pct = if total_mem > 0 {
        ((used_mem as f64 / total_mem as f64) * 100.0).round() as u64
    } else {
        0
    };

    let cpu_count = sys.cpus().len().max(1);
    let cpu_model = sys
        .cpus()
        .first()
        .map(|c| c.brand().to_string())
        .unwrap_or_else(|| "Rust Native CPU".to_string());

    let disks = Disks::new_with_refreshed_list();
    let mut disk_total = 0u64;
    let mut disk_free = 0u64;
    for d in &disks {
        if state.config.recordings_path.starts_with(d.mount_point())
            || disk_total == 0
        {
            disk_total = d.total_space();
            disk_free = d.available_space();
        }
    }
    let disk_used = disk_total.saturating_sub(disk_free);

    let (cameras, active_rec, events_today, total_storage) = state.db.with_conn(|conn| {
        let cams: i64 = conn
            .query_row("SELECT COUNT(*) FROM cameras", [], |r| r.get(0))
            .unwrap_or(0);
        let rec: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM recordings WHERE status = 'recording'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let evts: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM events WHERE timestamp >= datetime('now', '-24 hours')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let store: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(size_bytes), 0) FROM recordings",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (cams, rec, evts, store)
    });

    let app_uptime = state.start_instant.elapsed().as_secs();

    Json(json!({
        "system": {
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "hostname": System::host_name().unwrap_or_else(|| "smart-cctv-nvr".to_string()),
            "uptime": System::uptime(),
            "cpuCount": cpu_count,
            "cpuModel": cpu_model,
            "totalMemory": total_mem,
            "freeMemory": free_mem,
            "usedMemory": used_mem,
            "memoryPercent": mem_pct,
            "engine": "Rust Native AI NVR v2.0"
        },
        "disk": {
            "total": disk_total,
            "free": disk_free,
            "used": disk_used
        },
        "app": {
            "cameras": cameras,
            "activeRecordings": active_rec,
            "eventsToday": events_today,
            "totalStorageUsed": total_storage,
            "uptime": app_uptime
        }
    }))
}

pub async fn get_settings_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.db.get_all_settings())
}

pub async fn update_settings_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<HashMap<String, Value>>,
) -> Response {
    let allowed = allowed_settings_keys();

    state.db.with_conn(|conn| {
        for (k, v) in body {
            if allowed.contains(k.as_str()) {
                let val_str = match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                let clean: String = val_str.chars().take(200).collect();
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
                    params![k, clean],
                );
            }
        }
    });

    state.detection_engine.reload_settings();

    Json(json!({ "message": "Đã lưu và áp dụng cài đặt thành công (Hot-Reload)" })).into_response()
}

pub async fn list_ai_models_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.detection_engine.model_mgr.list_status())
}

pub async fn download_ai_model_handler(
    State(state): State<Arc<AppState>>,
    Path(model_id): Path<String>,
) -> Response {
    match state
        .detection_engine
        .model_mgr
        .download_model(&model_id)
        .await
    {
        Ok(path) => {
            if let Err(e) = state
                .detection_engine
                .hot_load_model_async(model_id.clone(), path)
                .await
            {
                tracing::error!("[AI Model] Downloaded {} but hot-load failed: {}", model_id, e);
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": format!("Đã tải file model '{}' nhưng không thể nạp vào Rust Engine: {}", model_id, e),
                        "models": state.detection_engine.model_mgr.list_status()
                    })),
                )
                    .into_response();
            }
            Json(json!({
                "message": format!("Đã tải và kích hoạt model '{}' thành công!", model_id),
                "models": state.detection_engine.model_mgr.list_status()
            }))
            .into_response()
        }
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}

pub async fn list_logs_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(150)
        .clamp(1, 300);
    Json(json!({
        "logs": state.ws_hub.recent_logs(limit)
    }))
}

pub async fn clear_logs_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    state.ws_hub.clear_logs();
    state
        .ws_hub
        .push_log("INFO", "SYSTEM", "Đã xóa bộ đệm nhật ký hoạt động");
    Json(json!({ "message": "Đã xóa nhật ký" }))
}

pub async fn run_ai_test_handler(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart,
) -> Response {
    let mut file_bytes: Option<Vec<u8>> = None;
    let mut filename = "test_video.mp4".to_string();
    let mut sample_fps = 1.0f32;
    let mut max_frames = 10usize;
    let mut conf_opt: Option<f32> = None;

    while let Ok(Some(field)) = multipart.next_field().await {
        let field_name = field.name().unwrap_or_default().to_string();
        if field_name == "file" {
            if let Some(fname) = field.file_name() {
                if !fname.trim().is_empty() {
                    filename = fname.trim().chars().take(120).collect();
                }
            }
            match field.bytes().await {
                Ok(b) => {
                    if b.len() > 50 * 1024 * 1024 {
                        return (
                            StatusCode::PAYLOAD_TOO_LARGE,
                            Json(json!({ "error": "File kiểm thử tối đa 50MB" })),
                        )
                            .into_response();
                    }
                    if !b.is_empty() {
                        file_bytes = Some(b.to_vec());
                    }
                }
                Err(_) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "error": "Lỗi đọc file tải lên (tối đa 50MB)" })),
                    )
                        .into_response();
                }
            }
        } else if field_name == "sample_fps" {
            if let Ok(txt) = field.text().await {
                if let Ok(v) = txt.trim().parse::<f32>() {
                    sample_fps = v;
                }
            }
        } else if field_name == "max_frames" {
            if let Ok(txt) = field.text().await {
                if let Ok(v) = txt.trim().parse::<usize>() {
                    max_frames = v;
                }
            }
        } else if field_name == "confidence_threshold" {
            if let Ok(txt) = field.text().await {
                if let Ok(v) = txt.trim().parse::<f32>() {
                    conf_opt = Some(v);
                }
            }
        }
    }

    let Some(bytes) = file_bytes else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng chọn file video (.mp4/.mov/.mkv) hoặc ảnh (.jpg/.png) để kiểm thử" })),
        )
            .into_response();
    };

    let is_image = detect_image_type(&bytes).is_some();
    let conf = conf_opt.unwrap_or_else(|| {
        state
            .db
            .get_setting("detection.confidence_threshold", "0.35")
            .parse::<f32>()
            .unwrap_or(0.35)
    });

    match state
        .detection_engine
        .run_ai_test_media(bytes, filename, is_image, sample_fps, max_frames, conf)
        .await
    {
        Ok(summary) => Json(summary).into_response(),
        Err(msg) => (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response(),
    }
}
