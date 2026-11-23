use std::fs;
use std::sync::Arc;

use axum::{
    extract::{Multipart, Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

use crate::{
    security::{detect_image_type, resolve_safe_path},
    AppState,
};

pub async fn list_faces_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.db.list_faces())
}

async fn parse_face_multipart(
    mut multipart: Multipart,
) -> Result<(Option<String>, Option<(String, Vec<u8>)>), String> {
    let mut name: Option<String> = None;
    let mut photo: Option<(String, Vec<u8>)> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| "Lỗi đọc dữ liệu biểu mẫu tải lên".to_string())?
    {
        let field_name = field.name().unwrap_or_default().to_string();
        if field_name == "name" {
            if let Ok(txt) = field.text().await {
                let trimmed = txt.trim().to_string();
                if !trimmed.is_empty() {
                    name = Some(trimmed.chars().take(100).collect());
                }
            }
        } else if field_name == "photo" {
            let bytes = field
                .bytes()
                .await
                .map_err(|_| "File ảnh vượt quá dung lượng cho phép (5MB)".to_string())?;
            if !bytes.is_empty() {
                if bytes.len() > 5 * 1024 * 1024 {
                    return Err("Ảnh tải lên không được vượt quá 5MB".to_string());
                }
                let Some((_, ext)) = detect_image_type(&bytes) else {
                    return Err(
                        "Định dạng ảnh không hợp lệ. Chỉ chấp nhận ảnh JPEG, PNG hoặc WebP."
                            .to_string(),
                    );
                };
                let filename = format!("face_{}{}", Uuid::new_v4(), ext);
                photo = Some((filename, bytes.to_vec()));
            }
        }
    }

    Ok((name, photo))
}

pub async fn create_face_handler(
    State(state): State<Arc<AppState>>,
    multipart: Multipart,
) -> Response {
    let (name_opt, photo_opt) = match parse_face_multipart(multipart).await {
        Ok(res) => res,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
        }
    };

    let Some(name) = name_opt else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng nhập tên khuôn mặt" })),
        )
            .into_response();
    };

    let mut photo_filename: Option<String> = None;
    let mut encoding_json: Option<String> = None;

    if let Some((filename, bytes)) = photo_opt {
        let Some(full_path) = resolve_safe_path(&state.config.snapshots_path, &filename) else {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Đường dẫn lưu ảnh không hợp lệ" })),
            )
                .into_response();
        };
        if fs::write(&full_path, &bytes).is_err() {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "Không thể lưu ảnh khuôn mặt xuống đĩa" })),
            )
                .into_response();
        }
        // Automatically extract 512-D facial embedding vector in Rust!
        encoding_json = state
            .detection_engine
            .face_engine
            .extract_embedding_from_bytes(&bytes);
        photo_filename = Some(filename);
    }

    let id = Uuid::new_v4().to_string();
    state.db.with_conn(|conn| {
        let _ = conn.execute(
            "INSERT INTO faces (id, name, photo_path, encoding) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, photo_filename, encoding_json],
        );
    });

    let created = state
        .db
        .list_faces()
        .into_iter()
        .find(|f| f.id == id);

    (StatusCode::CREATED, Json(json!(created))).into_response()
}

pub async fn update_face_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    multipart: Multipart,
) -> Response {
    let existing = state.db.list_faces().into_iter().find(|f| f.id == id);
    let Some(face) = existing else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy khuôn mặt" })),
        )
            .into_response();
    };

    let (name_opt, photo_opt) = match parse_face_multipart(multipart).await {
        Ok(res) => res,
        Err(msg) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
        }
    };

    let mut new_photo: Option<String> = None;
    let mut new_encoding: Option<String> = None;

    if let Some((filename, bytes)) = photo_opt {
        if let Some(full_path) = resolve_safe_path(&state.config.snapshots_path, &filename) {
            if fs::write(&full_path, &bytes).is_ok() {
                if let Some(old_rel) = face.photo_path {
                    if let Some(old_full) =
                        resolve_safe_path(&state.config.snapshots_path, &old_rel)
                    {
                        let _ = fs::remove_file(old_full);
                    }
                }
                new_encoding = state
                    .detection_engine
                    .face_engine
                    .extract_embedding_from_bytes(&bytes);
                new_photo = Some(filename);
            }
        }
    }

    state.db.with_conn(|conn| {
        let _ = conn.execute(
            "UPDATE faces SET name = COALESCE(?1, name), photo_path = COALESCE(?2, photo_path), encoding = COALESCE(?3, encoding), updated_at = datetime('now') WHERE id = ?4",
            params![name_opt, new_photo, new_encoding, id],
        );
    });

    let updated = state.db.list_faces().into_iter().find(|f| f.id == id);
    Json(json!(updated)).into_response()
}

pub async fn delete_face_handler(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let photo_opt: Option<Option<String>> = state.db.with_conn(|conn| {
        conn.query_row(
            "SELECT photo_path FROM faces WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .unwrap_or(None)
    });

    let Some(photo_path) = photo_opt else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Không tìm thấy khuôn mặt" })),
        )
            .into_response();
    };

    if let Some(rel) = photo_path {
        if let Some(full) = resolve_safe_path(&state.config.snapshots_path, &rel) {
            let _ = fs::remove_file(full);
        }
    }

    state.db.with_conn(|conn| {
        let _ = conn.execute("DELETE FROM faces WHERE id = ?1", params![id]);
    });

    Json(json!({ "message": "Đã xóa khuôn mặt" })).into_response()
}
