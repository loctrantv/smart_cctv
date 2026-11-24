use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, types::Value as SqlValue, OptionalExtension};
use serde_json::{json, Value};

use crate::{db::EventRow, security::resolve_safe_path, AppState};

pub async fn list_events_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let limit = query
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(50)
        .clamp(1, 300);
    let offset = query
        .get("offset")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0)
        .max(0);

    let mut where_clauses = vec!["1=1".to_string()];
    let mut sql_params: Vec<SqlValue> = Vec::new();

    if let Some(cid) = query.get("camera_id").filter(|s| !s.is_empty()) {
        where_clauses.push("e.camera_id = ?".to_string());
        sql_params.push(SqlValue::Text(cid.clone()));
    }
    if let Some(t) = query.get("type").filter(|s| !s.is_empty()) {
        where_clauses.push("e.type = ?".to_string());
        sql_params.push(SqlValue::Text(t.clone()));
    }
    if let Some(fid) = query.get("face_id").filter(|s| !s.is_empty()) {
        where_clauses.push("e.face_id = ?".to_string());
        sql_params.push(SqlValue::Text(fid.clone()));
    }
    if let Some(q) = query.get("search").filter(|s| !s.trim().is_empty()) {
        where_clauses.push("e.label LIKE ?".to_string());
        sql_params.push(SqlValue::Text(format!("%{}%", q.trim())));
    }
    if let Some(st) = query.get("start").filter(|s| !s.is_empty()) {
        where_clauses.push("e.timestamp >= ?".to_string());
        sql_params.push(SqlValue::Text(st.clone()));
    }
    if let Some(en) = query.get("end").filter(|s| !s.is_empty()) {
        where_clauses.push("e.timestamp <= ?".to_string());
        sql_params.push(SqlValue::Text(en.clone()));
    }

    let where_sql = where_clauses.join(" AND ");

    let (events, total) = state.db.with_conn(|conn| {
        let count_sql = format!("SELECT COUNT(*) FROM events e WHERE {}", where_sql);
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
            SELECT e.id, e.camera_id, e.type, e.label, e.confidence, e.timestamp,
                   e.snapshot_path, e.bbox_x, e.bbox_y, e.bbox_w, e.bbox_h,
                   e.face_id, e.metadata, e.created_at,
                   c.name as camera_name, f.name as face_name
            FROM events e
            JOIN cameras c ON e.camera_id = c.id
            LEFT JOIN faces f ON e.face_id = f.id
            WHERE {}
            ORDER BY e.timestamp DESC
            LIMIT ? OFFSET ?
            "#,
            where_sql
        );

        let mut list = Vec::new();
        if let Ok(mut stmt) = conn.prepare(&list_sql) {
            if let Ok(rows) =
                stmt.query_map(rusqlite::params_from_iter(list_params.iter()), |r| {
                    Ok(EventRow {
                        id: r.get(0)?,
                        camera_id: r.get(1)?,
                        r#type: r.get(2)?,
                        label: r.get(3)?,
                        confidence: r.get(4)?,
                        timestamp: r.get(5)?,
                        snapshot_path: r.get(6)?,
                        bbox_x: r.get(7)?,
                        bbox_y: r.get(8)?,
                        bbox_w: r.get(9)?,
                        bbox_h: r.get(10)?,
                        face_id: r.get(11)?,
                        metadata: r.get(12)?,
                        created_at: r.get(13)?,
                        camera_name: r.get(14)?,
                        face_name: r.get(15)?,
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
        "events": events,
        "total": total,
        "limit": limit,
        "offset": offset
    }))
}

pub async fn event_stats_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let days = query
        .get("days")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(7)
        .clamp(1, 365);
    let cam_id_opt = query.get("camera_id").filter(|s| !s.is_empty()).cloned();

    let (daily, by_type, recent_count) = state.db.with_conn(|conn| {
        let mut daily_list = Vec::new();
        let mut by_type_list = Vec::new();

        if let Some(ref cid) = cam_id_opt {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT date(timestamp) as date, type, COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-' || ?1 || ' days') AND camera_id = ?2 GROUP BY date(timestamp), type ORDER BY date ASC",
            ) {
                if let Ok(rows) = stmt.query_map(params![days, cid], |r| {
                    Ok(json!({
                        "date": r.get::<_, String>(0)?,
                        "type": r.get::<_, String>(1)?,
                        "count": r.get::<_, i64>(2)?
                    }))
                }) {
                    for item in rows.flatten() {
                        daily_list.push(item);
                    }
                }
            }

            if let Ok(mut stmt) = conn.prepare(
                "SELECT type, COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-' || ?1 || ' days') AND camera_id = ?2 GROUP BY type",
            ) {
                if let Ok(rows) = stmt.query_map(params![days, cid], |r| {
                    Ok(json!({
                        "type": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?
                    }))
                }) {
                    for item in rows.flatten() {
                        by_type_list.push(item);
                    }
                }
            }
        } else {
            if let Ok(mut stmt) = conn.prepare(
                "SELECT date(timestamp) as date, type, COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-' || ?1 || ' days') GROUP BY date(timestamp), type ORDER BY date ASC",
            ) {
                if let Ok(rows) = stmt.query_map(params![days], |r| {
                    Ok(json!({
                        "date": r.get::<_, String>(0)?,
                        "type": r.get::<_, String>(1)?,
                        "count": r.get::<_, i64>(2)?
                    }))
                }) {
                    for item in rows.flatten() {
                        daily_list.push(item);
                    }
                }
            }

            if let Ok(mut stmt) = conn.prepare(
                "SELECT type, COUNT(*) as count FROM events WHERE timestamp >= datetime('now', '-' || ?1 || ' days') GROUP BY type",
            ) {
                if let Ok(rows) = stmt.query_map(params![days], |r| {
                    Ok(json!({
                        "type": r.get::<_, String>(0)?,
                        "count": r.get::<_, i64>(1)?
                    }))
                }) {
                    for item in rows.flatten() {
                        by_type_list.push(item);
                    }
                }
            }
        }

        let recent: i64 = if let Some(ref cid) = cam_id_opt {
            conn.query_row(
                "SELECT COUNT(*) FROM events WHERE timestamp >= datetime('now', '-1 hour') AND camera_id = ?1",
                params![cid],
                |r| r.get(0),
            )
            .unwrap_or(0)
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM events WHERE timestamp >= datetime('now', '-1 hour')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0)
        };

        (daily_list, by_type_list, recent)
    });

    Json(json!({
        "daily": daily,
        "byType": by_type,
        "recentCount": recent_count
    }))
}

pub async fn get_event_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let evt_opt = state.db.with_conn(|conn| {
        conn.query_row(
            r#"
            SELECT e.id, e.camera_id, e.type, e.label, e.confidence, e.timestamp,
                   e.snapshot_path, e.bbox_x, e.bbox_y, e.bbox_w, e.bbox_h,
                   e.face_id, e.metadata, e.created_at,
                   c.name as camera_name, f.name as face_name
            FROM events e
            JOIN cameras c ON e.camera_id = c.id
            LEFT JOIN faces f ON e.face_id = f.id
            WHERE e.id = ?1
            "#,
            params![id],
            |r| {
                Ok(EventRow {
                    id: r.get(0)?,
                    camera_id: r.get(1)?,
                    r#type: r.get(2)?,
                    label: r.get(3)?,
                    confidence: r.get(4)?,
                    timestamp: r.get(5)?,
                    snapshot_path: r.get(6)?,
                    bbox_x: r.get(7)?,
                    bbox_y: r.get(8)?,
                    bbox_w: r.get(9)?,
                    bbox_h: r.get(10)?,
                    face_id: r.get(11)?,
                    metadata: r.get(12)?,
                    created_at: r.get(13)?,
                    camera_name: r.get(14)?,
                    face_name: r.get(15)?,
                })
            },
        )
        .optional()
        .unwrap_or(None)
    });

    match evt_opt {
        Some(e) => Json(e).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy sự kiện" })),
        )
            .into_response(),
    }
}

pub async fn delete_event_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let snap_opt: Option<Option<String>> = state.db.with_conn(|conn| {
        conn.query_row(
            "SELECT snapshot_path FROM events WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
    });

    let Some(snap_path) = snap_opt else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy sự kiện" })),
        )
            .into_response();
    };

    if let Some(rel) = snap_path {
        if let Some(full) = resolve_safe_path(&state.config.snapshots_path, &rel) {
            let _ = fs::remove_file(full);
        }
    }

    state.db.with_conn(|conn| {
        let _ = conn.execute("DELETE FROM events WHERE id = ?1", params![id]);
    });

    Json(json!({ "message": "Đã xóa sự kiện" })).into_response()
}

pub async fn bulk_delete_events_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<HashMap<String, String>>,
    body_opt: Option<Json<Value>>,
) -> Response {
    let body = body_opt.map(|b| b.0).unwrap_or_else(|| json!({}));

    let ids: Vec<String> = body
        .get("ids")
        .cloned()
        .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
        .unwrap_or_default()
        .into_iter()
        .take(500)
        .collect();

    if !ids.is_empty() {
        let mut deleted = 0usize;
        let mut files_removed = 0usize;
        for id in ids {
            let snap_opt: Option<Option<String>> = state.db.with_conn(|conn| {
                conn.query_row(
                    "SELECT snapshot_path FROM events WHERE id = ?1",
                    params![id],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None)
            });
            if let Some(Some(rel)) = snap_opt {
                if let Some(full) = resolve_safe_path(&state.config.snapshots_path, &rel) {
                    if fs::remove_file(full).is_ok() {
                        files_removed += 1;
                    }
                }
            }
            let changes = state.db.with_conn(|conn| {
                conn.execute("DELETE FROM events WHERE id = ?1", params![id])
                    .unwrap_or(0)
            });
            deleted += changes;
        }
        return Json(json!({ "deleted": deleted, "files_removed": files_removed })).into_response();
    }

    // Time-based & filter-based bulk cleanup
    let older_than_hours = body
        .get("older_than_hours")
        .and_then(|v| {
            v.as_i64()
                .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
        })
        .or_else(|| {
            query
                .get("older_than_hours")
                .and_then(|s| s.parse::<i64>().ok())
        })
        .filter(|&h| h > 0);

    let before = body
        .get("before")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            query
                .get("before")
                .filter(|s| !s.trim().is_empty())
                .cloned()
        });

    let start = body
        .get("start")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| query.get("start").filter(|s| !s.trim().is_empty()).cloned());

    let end = body
        .get("end")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| query.get("end").filter(|s| !s.trim().is_empty()).cloned());

    let camera_id = body
        .get("camera_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| {
            query
                .get("camera_id")
                .filter(|s| !s.trim().is_empty())
                .cloned()
        });

    let evt_type = body
        .get("type")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.trim().to_string())
        .or_else(|| query.get("type").filter(|s| !s.trim().is_empty()).cloned());

    let delete_all = body
        .get("all")
        .and_then(|v| v.as_bool())
        .unwrap_or_else(|| query.get("all").map(|s| s == "1" || s == "true").unwrap_or(false));

    let mut where_clauses: Vec<String> = Vec::new();
    let mut sql_params: Vec<SqlValue> = Vec::new();

    if let Some(hours) = older_than_hours {
        where_clauses.push("timestamp < datetime('now', '-' || ? || ' hours')".to_string());
        sql_params.push(SqlValue::Integer(hours.clamp(1, 24 * 3650)));
    }
    if let Some(b) = before {
        where_clauses.push("timestamp <= ?".to_string());
        sql_params.push(SqlValue::Text(b));
    }
    if let Some(st) = start {
        where_clauses.push("timestamp >= ?".to_string());
        sql_params.push(SqlValue::Text(st));
    }
    if let Some(en) = end {
        where_clauses.push("timestamp <= ?".to_string());
        sql_params.push(SqlValue::Text(en));
    }
    if let Some(cid) = camera_id {
        where_clauses.push("camera_id = ?".to_string());
        sql_params.push(SqlValue::Text(cid));
    }
    if let Some(t) = evt_type {
        where_clauses.push("type = ?".to_string());
        sql_params.push(SqlValue::Text(t));
    }

    if where_clauses.is_empty() && !delete_all {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng chọn sự kiện hoặc khoảng thời gian cần dọn dẹp" })),
        )
            .into_response();
    }

    let where_sql = if where_clauses.is_empty() {
        "1=1".to_string()
    } else {
        where_clauses.join(" AND ")
    };

    let snaps: Vec<String> = state.db.with_conn(|conn| {
        let mut list = Vec::new();
        let sql = format!(
            "SELECT snapshot_path FROM events WHERE {} AND snapshot_path IS NOT NULL",
            where_sql
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) =
                stmt.query_map(rusqlite::params_from_iter(sql_params.iter()), |r| {
                    r.get::<_, String>(0)
                })
            {
                for s in rows.flatten() {
                    list.push(s);
                }
            }
        }
        list
    });

    let mut files_removed = 0usize;
    for rel in snaps {
        if let Some(full) = resolve_safe_path(&state.config.snapshots_path, &rel) {
            if fs::remove_file(full).is_ok() {
                files_removed += 1;
            }
        }
    }

    let deleted = state.db.with_conn(|conn| {
        let sql = format!("DELETE FROM events WHERE {}", where_sql);
        conn.execute(&sql, rusqlite::params_from_iter(sql_params.iter()))
            .unwrap_or(0)
    });

    Json(json!({
        "deleted": deleted,
        "files_removed": files_removed
    }))
    .into_response()
}
