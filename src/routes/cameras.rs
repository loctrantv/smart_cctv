use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    db::CameraRow,
    security::{
        mask_rtsp_url, validate_detection_zone, validate_rtsp_url, validate_tripwire_config,
    },
    services::go2rtc::Go2RtcClient,
    AppState,
};

fn format_camera_for_client(cam: &CameraRow, go2rtc: &Go2RtcClient) -> Value {
    json!({
        "id": cam.id,
        "name": cam.name,
        "stream_id": cam.stream_id,
        "rtsp_url": mask_rtsp_url(&cam.rtsp_url),
        "enabled": cam.enabled != 0,
        "record_enabled": cam.record_enabled != 0,
        "detection_enabled": cam.detection_enabled != 0,
        "record_mode": cam.record_mode,
        "snapshot_url": cam.snapshot_url,
        "location": cam.location,
        "notes": cam.notes,
        "detection_zone": cam.detection_zone,
        "tripwire_config": cam.tripwire_config,
        "ai_tasks": cam.ai_tasks,
        "created_at": cam.created_at,
        "updated_at": cam.updated_at,
        "active_recordings": cam.active_recordings,
        "events_today": cam.events_today,
        "streams": go2rtc.client_stream_urls(&cam.id)
    })
}

pub async fn list_cameras_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cameras = state.db.list_cameras();
    let formatted: Vec<Value> = cameras
        .iter()
        .map(|c| format_camera_for_client(c, &state.go2rtc))
        .collect();
    Json(formatted)
}

pub async fn get_camera_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    match state.db.get_camera(&id) {
        Some(cam) => Json(format_camera_for_client(&cam, &state.go2rtc)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct CreateCameraRequest {
    pub name: Option<String>,
    pub rtsp_url: Option<String>,
    pub location: Option<String>,
    pub notes: Option<String>,
}

pub async fn create_camera_handler(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateCameraRequest>,
) -> Response {
    let name = body.name.unwrap_or_default().trim().to_string();
    let raw_rtsp = body.rtsp_url.unwrap_or_default();

    if name.is_empty() || raw_rtsp.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng nhập tên camera và RTSP URL" })),
        )
            .into_response();
    }

    let valid_rtsp = match validate_rtsp_url(&raw_rtsp) {
        Ok(u) => u,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
        }
    };

    let clean_name: String = name.chars().take(100).collect();
    let id = Uuid::new_v4().to_string();
    let slug: String = clean_name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let slug_clean = slug.trim_matches('_');
    let stream_id = format!(
        "cam_{}_{}",
        if slug_clean.is_empty() { "camera" } else { slug_clean },
        &id[..6]
    );

    let location: String = body.location.unwrap_or_default().trim().chars().take(200).collect();
    let notes: String = body.notes.unwrap_or_default().trim().chars().take(500).collect();

    let insert_res = state.db.with_conn(|conn| {
        conn.execute(
            "INSERT INTO cameras (id, name, stream_id, rtsp_url, location, notes) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, clean_name, stream_id, valid_rtsp, location, notes],
        )
    });

    if insert_res.is_err() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Tên hoặc mã luồng camera đã tồn tại" })),
        )
            .into_response();
    }

    state.go2rtc.add_stream(&stream_id, &valid_rtsp).await;

    let Some(cam) = state.db.get_camera(&id) else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Không thể tạo camera" })),
        )
            .into_response();
    };

    let formatted = format_camera_for_client(&cam, &state.go2rtc);
    state.ws_hub.broadcast(json!({
        "type": "camera_added",
        "camera": formatted
    }));

    (StatusCode::CREATED, Json(formatted)).into_response()
}

pub async fn update_camera_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    let mut validated_rtsp: Option<String> = None;
    if let Some(rtsp_val) = body.get("rtsp_url").and_then(|v| v.as_str()) {
        if !rtsp_val.contains("******") && !rtsp_val.trim().is_empty() {
            match validate_rtsp_url(rtsp_val) {
                Ok(u) => validated_rtsp = Some(u),
                Err(msg) => {
                    return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
                }
            }
        }
    }

    let mut validated_zone: Option<String> = None;
    if let Some(zone_val) = body.get("detection_zone") {
        match validate_detection_zone(zone_val) {
            Ok(z) => validated_zone = Some(z),
            Err(msg) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
        }
    }

    let mut validated_tripwire: Option<String> = None;
    if let Some(tw_val) = body.get("tripwire_config") {
        match validate_tripwire_config(tw_val) {
            Ok(tw) => validated_tripwire = Some(tw),
            Err(msg) => {
                return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
            }
        }
    }

    let next_name = body
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(100).collect::<String>());

    let next_location = body
        .get("location")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(200).collect::<String>());

    let next_notes = body
        .get("notes")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(500).collect::<String>());

    let next_ai_tasks = body
        .get("ai_tasks")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(200).collect::<String>());

    let bool_to_i64 = |v: &Value| -> Option<i64> {
        if let Some(b) = v.as_bool() {
            Some(if b { 1 } else { 0 })
        } else {
            v.as_i64().map(|n| if n != 0 { 1 } else { 0 })
        }
    };

    let next_enabled = body.get("enabled").and_then(bool_to_i64);
    let next_record_enabled = body.get("record_enabled").and_then(bool_to_i64);
    let next_detection_enabled = body.get("detection_enabled").and_then(bool_to_i64);

    state.db.with_conn(|conn| {
        let _ = conn.execute(
            r#"
            UPDATE cameras SET
              name = COALESCE(?1, name),
              rtsp_url = COALESCE(?2, rtsp_url),
              enabled = COALESCE(?3, enabled),
              record_enabled = COALESCE(?4, record_enabled),
              detection_enabled = COALESCE(?5, detection_enabled),
              location = COALESCE(?6, location),
              notes = COALESCE(?7, notes),
              detection_zone = COALESCE(?8, detection_zone),
              tripwire_config = COALESCE(?9, tripwire_config),
              ai_tasks = COALESCE(?10, ai_tasks),
              updated_at = datetime('now')
            WHERE id = ?11
            "#,
            params![
                next_name,
                validated_rtsp,
                next_enabled,
                next_record_enabled,
                next_detection_enabled,
                next_location,
                next_notes,
                validated_zone,
                validated_tripwire,
                next_ai_tasks,
                id
            ],
        );
    });

    if let Some(ref new_rtsp) = validated_rtsp {
        if new_rtsp != &camera.rtsp_url {
            state.go2rtc.add_stream(&camera.stream_id, new_rtsp).await;
        }
    }

    let Some(updated) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    if updated.record_enabled == 1 && camera.record_enabled == 0 {
        state.recording_mgr.start_recording(updated.clone());
    } else if updated.record_enabled == 0 && camera.record_enabled == 1 {
        state.recording_mgr.stop_recording(&id);
    }

    if updated.detection_enabled == 1 && camera.detection_enabled == 0 {
        state.detection_engine.start_detection(updated.clone());
        if state.db.get_setting("sound.detection_enabled", "0") == "1" {
            state
                .detection_engine
                .start_sound_detection(updated.clone());
        }
    } else if updated.detection_enabled == 0 && camera.detection_enabled == 1 {
        state.detection_engine.stop_detection(&id);
        state.detection_engine.stop_sound_detection(&id);
    }

    let formatted = format_camera_for_client(&updated, &state.go2rtc);
    state.ws_hub.broadcast(json!({
        "type": "camera_updated",
        "camera": formatted
    }));

    Json(formatted).into_response()
}

pub async fn delete_camera_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    state.recording_mgr.stop_recording(&id);
    state.detection_engine.stop_detection(&id);
    state.detection_engine.stop_sound_detection(&id);

    state.go2rtc.remove_stream(&camera.stream_id).await;
    state.db.with_conn(|conn| {
        let _ = conn.execute("DELETE FROM cameras WHERE id = ?1", params![id]);
    });

    state.ws_hub.broadcast(json!({
        "type": "camera_removed",
        "cameraId": id
    }));

    Json(json!({ "message": "Đã xóa camera" })).into_response()
}

pub async fn start_record_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    state.recording_mgr.start_recording(camera);
    state.db.with_conn(|conn| {
        let _ = conn.execute(
            "UPDATE cameras SET record_enabled = 1 WHERE id = ?1",
            params![id],
        );
    });

    Json(json!({ "message": "Đã bắt đầu ghi hình" })).into_response()
}

pub async fn stop_record_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    state.recording_mgr.stop_recording(&id);
    state.db.with_conn(|conn| {
        let _ = conn.execute(
            "UPDATE cameras SET record_enabled = 0 WHERE id = ?1",
            params![id],
        );
    });

    Json(json!({ "message": "Đã dừng ghi hình" })).into_response()
}

// ============================================
// Authenticated go2rtc Proxy Endpoints
// ============================================

pub async fn webrtc_proxy_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    sdp_offer: String,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    if sdp_offer.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Thiếu SDP offer" })),
        )
            .into_response();
    }

    match state
        .go2rtc
        .exchange_webrtc_offer(&camera.stream_id, sdp_offer)
        .await
    {
        Ok(answer) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/sdp")],
            answer,
        )
            .into_response(),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Không thể kết nối WebRTC tới go2rtc" })),
        )
            .into_response(),
    }
}

pub async fn snapshot_proxy_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    let api_path = format!("/api/frame.jpeg?src={}", urlencoding::encode(&camera.stream_id));
    match state.go2rtc.fetch_raw(&api_path).await {
        Ok((200, ct, bytes)) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, ct.as_str()),
                (header::CACHE_CONTROL, "no-store"),
            ],
            Body::from(bytes),
        )
            .into_response(),
        _ => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Không thể lấy ảnh từ camera" })),
        )
            .into_response(),
    }
}

pub async fn hls_proxy_handler(
    State(state): State<Arc<AppState>>,
    Path((id, sub_path)): Path<(String, String)>,
    Query(mut query_map): Query<HashMap<String, String>>,
) -> Response {
    let Some(camera) = state.db.get_camera(&id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy camera" })),
        )
            .into_response();
    };

    if sub_path.is_empty()
        || sub_path.contains("..")
        || !sub_path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '/')
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Đường dẫn HLS không hợp lệ" })),
        )
            .into_response();
    }

    query_map.remove("token");
    if !query_map.contains_key("src") && !query_map.contains_key("id") {
        query_map.insert("src".to_string(), camera.stream_id);
    }

    let qs: String = query_map
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");

    let upstream_path = format!("/api/{}?{}", sub_path.trim_start_matches('/'), qs);

    match state.go2rtc.fetch_raw(&upstream_path).await {
        Ok((status, ct, bytes)) => {
            let code = StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY);
            (
                code,
                [
                    (header::CONTENT_TYPE, ct.as_str()),
                    (header::CACHE_CONTROL, "no-store"),
                ],
                Body::from(bytes),
            )
                .into_response()
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "Lỗi kết nối luồng HLS" })),
        )
            .into_response(),
    }
}
