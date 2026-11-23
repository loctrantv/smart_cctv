use std::collections::HashMap;
use std::fs;
use std::io::SeekFrom;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, types::Value as SqlValue, OptionalExtension};
use serde_json::json;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::{db::RecordingRow, security::resolve_safe_path, AppState};

pub async fn list_recordings_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    let offset = query
        .get("offset")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);

    let mut where_clauses = vec!["1=1".to_string()];
    let mut sql_params: Vec<SqlValue> = Vec::new();

    if let Some(cid) = query.get("camera_id").filter(|s| !s.is_empty()) {
        where_clauses.push("r.camera_id = ?".to_string());
        sql_params.push(SqlValue::Text(cid.clone()));
    }
    if let Some(d) = query.get("date").filter(|s| !s.is_empty()) {
        where_clauses.push("date(r.start_time) = ?".to_string());
        sql_params.push(SqlValue::Text(d.clone()));
    }
    if let Some(st) = query.get("start").filter(|s| !s.is_empty()) {
        where_clauses.push("r.start_time >= ?".to_string());
        sql_params.push(SqlValue::Text(st.clone()));
    }
    if let Some(en) = query.get("end").filter(|s| !s.is_empty()) {
        where_clauses.push("r.start_time <= ?".to_string());
        sql_params.push(SqlValue::Text(en.clone()));
    }
    if let Some(status) = query.get("status").filter(|s| !s.is_empty()) {
        where_clauses.push("r.status = ?".to_string());
        sql_params.push(SqlValue::Text(status.clone()));
    }

    let where_sql = where_clauses.join(" AND ");

    let (recordings, total) = state.db.with_conn(|conn| {
        let count_sql = format!("SELECT COUNT(*) FROM recordings r WHERE {}", where_sql);
        let total: i64 = conn
            .query_row(
                &count_sql,
                rusqlite::params_from_iter(sql_params.iter()),
                |r| r.get(0),
            )
            .unwrap_or(0);

        let mut list_params = sql_params.clone();
        list_params.push(SqlValue::Integer(limit));
        list_params.push(SqlValue::Integer(offset));

        let list_sql = format!(
            r#"
            SELECT r.id, r.camera_id, r.file_path, r.file_name, r.start_time, r.end_time,
                   r.duration_seconds, r.size_bytes, r.status, r.created_at,
                   c.name as camera_name, c.stream_id
            FROM recordings r
            JOIN cameras c ON r.camera_id = c.id
            WHERE {}
            ORDER BY r.start_time DESC
            LIMIT ? OFFSET ?
            "#,
            where_sql
        );

        let mut list = Vec::new();
        if let Ok(mut stmt) = conn.prepare(&list_sql) {
            if let Ok(rows) =
                stmt.query_map(rusqlite::params_from_iter(list_params.iter()), |r| {
                    Ok(RecordingRow {
                        id: r.get(0)?,
                        camera_id: r.get(1)?,
                        file_path: r.get(2)?,
                        file_name: r.get(3)?,
                        start_time: r.get(4)?,
                        end_time: r.get(5)?,
                        duration_seconds: r.get(6)?,
                        size_bytes: r.get(7)?,
                        status: r.get(8)?,
                        created_at: r.get(9)?,
                        camera_name: r.get(10)?,
                        stream_id: r.get(11)?,
                    })
                })
            {
                for item in rows.flatten() {
                    list.push(item);
                }
            }
        }
        (list, total)
    });

    Json(json!({
        "recordings": recordings,
        "total": total,
        "limit": limit,
        "offset": offset
    }))
}

pub async fn timeline_handler(
    State(state): State<Arc<AppState>>,
    Path(camera_id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let Some(date) = query.get("date").filter(|d| d.len() == 10) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Tham số date không hợp lệ (YYYY-MM-DD)" })),
        )
            .into_response();
    };

    let (recordings, events) = state.db.with_conn(|conn| {
        let mut recs = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, start_time, end_time, duration_seconds, status FROM recordings WHERE camera_id = ?1 AND date(start_time) = ?2 ORDER BY start_time ASC",
        ) {
            if let Ok(rows) = stmt.query_map(params![camera_id, date], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "start_time": r.get::<_, String>(1)?,
                    "end_time": r.get::<_, Option<String>>(2)?,
                    "duration_seconds": r.get::<_, i64>(3)?,
                    "status": r.get::<_, String>(4)?
                }))
            }) {
                for row in rows.flatten() {
                    recs.push(row);
                }
            }
        }

        let mut evts = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, type, label, confidence, timestamp, snapshot_path FROM events WHERE camera_id = ?1 AND date(timestamp) = ?2 ORDER BY timestamp ASC",
        ) {
            if let Ok(rows) = stmt.query_map(params![camera_id, date], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?,
                    "type": r.get::<_, String>(1)?,
                    "label": r.get::<_, String>(2)?,
                    "confidence": r.get::<_, f64>(3)?,
                    "timestamp": r.get::<_, String>(4)?,
                    "snapshot_path": r.get::<_, Option<String>>(5)?
                }))
            }) {
                for row in rows.flatten() {
                    evts.push(row);
                }
            }
        }
        (recs, evts)
    });

    Json(json!({
        "recordings": recordings,
        "events": events,
        "date": date
    }))
    .into_response()
}

pub async fn recording_dates_handler(
    State(state): State<Arc<AppState>>,
    Path(camera_id): Path<String>,
) -> impl IntoResponse {
    let dates = state.db.with_conn(|conn| {
        let mut list = Vec::new();
        if let Ok(mut stmt) = conn.prepare(
            r#"
            SELECT DISTINCT date(start_time) as date,
              COUNT(*) as recording_count,
              SUM(duration_seconds) as total_seconds
            FROM recordings
            WHERE camera_id = ?1
            GROUP BY date(start_time)
            ORDER BY date DESC
            LIMIT 90
            "#,
        ) {
            if let Ok(rows) = stmt.query_map(params![camera_id], |r| {
                Ok(json!({
                    "date": r.get::<_, String>(0)?,
                    "recording_count": r.get::<_, i64>(1)?,
                    "total_seconds": r.get::<_, Option<i64>>(2)?.unwrap_or(0)
                }))
            }) {
                for item in rows.flatten() {
                    list.push(item);
                }
            }
        }
        list
    });

    Json(dates)
}

/// Zero-copy HTTP 206 Byte-Range Video Streaming with `Accept-Ranges: bytes` & `X-Accel-Buffering: no`
pub async fn stream_recording_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Response {
    let rel_path_opt: Option<String> = state.db.with_conn(|conn| {
        conn.query_row(
            "SELECT file_path FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
    });

    let Some(rel_path) = rel_path_opt else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy bản ghi" })),
        )
            .into_response();
    };

    let Some(full_path) = resolve_safe_path(&state.config.recordings_path, &rel_path) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Đường dẫn video không hợp lệ" })),
        )
            .into_response();
    };

    let Ok(meta) = tokio::fs::metadata(&full_path).await else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy file video trên ổ đĩa" })),
        )
            .into_response();
    };

    let file_size = meta.len();
    if file_size == 0 {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "File video rỗng" })),
        )
            .into_response();
    }

    let range_header = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    if let Some(range_str) = range_header {
        if let Some(stripped) = range_str.strip_prefix("bytes=") {
            let mut parts = stripped.split('-');
            let start = parts
                .next()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            let end = parts
                .next()
                .and_then(|s| if s.is_empty() { None } else { s.parse::<u64>().ok() })
                .unwrap_or(file_size - 1)
                .min(file_size - 1);

            if start >= file_size || start > end {
                return (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [
                        (header::CONTENT_RANGE, format!("bytes */{}", file_size)),
                        (header::ACCEPT_RANGES, "bytes".to_string()),
                    ],
                    Body::empty(),
                )
                    .into_response();
            }

            let chunk_size = end - start + 1;
            let Ok(mut file) = File::open(&full_path).await else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };
            if file.seek(SeekFrom::Start(start)).await.is_err() {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }

            let stream = ReaderStream::new(file.take(chunk_size));
            return (
                StatusCode::PARTIAL_CONTENT,
                [
                    (
                        header::CONTENT_RANGE,
                        format!("bytes {}-{}/{}", start, end, file_size),
                    ),
                    (header::ACCEPT_RANGES, "bytes".to_string()),
                    (header::CONTENT_LENGTH, chunk_size.to_string()),
                    (header::CONTENT_TYPE, "video/mp4".to_string()),
                    (
                        header::HeaderName::from_static("x-accel-buffering"),
                        "no".to_string(),
                    ),
                ],
                Body::from_stream(stream),
            )
                .into_response();
        }
    }

    let Ok(file) = File::open(&full_path).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let stream = ReaderStream::new(file);

    (
        StatusCode::OK,
        [
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_LENGTH, file_size.to_string()),
            (header::CONTENT_TYPE, "video/mp4".to_string()),
            (
                header::HeaderName::from_static("x-accel-buffering"),
                "no".to_string(),
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

pub async fn delete_recording_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let rel_path_opt: Option<String> = state.db.with_conn(|conn| {
        conn.query_row(
            "SELECT file_path FROM recordings WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
    });

    let Some(rel_path) = rel_path_opt else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy bản ghi" })),
        )
            .into_response();
    };

    if let Some(full) = resolve_safe_path(&state.config.recordings_path, &rel_path) {
        let _ = fs::remove_file(full);
    }

    state.db.with_conn(|conn| {
        let _ = conn.execute("DELETE FROM recordings WHERE id = ?1", params![id]);
    });

    Json(json!({ "message": "Đã xóa bản ghi" })).into_response()
}
