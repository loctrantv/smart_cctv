use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::params;
use serde_json::{json, Value};
use sysinfo::{Disks, System};

use crate::{db::allowed_settings_keys, AppState};

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
            if let Err(e) = state.detection_engine.hot_load_model(&model_id, &path) {
                tracing::warn!("[AI Model] Downloaded {} but hot-load note: {}", model_id, e);
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
