use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    extract::{ConnectInfo, Extension, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use rusqlite::params;
use serde::Deserialize;
use serde_json::json;

use crate::{
    auth::{
        build_session_cookie, extract_client_ip, generate_token, hash_password, verify_password,
        AuthUser,
    },
    AppState,
};

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Deserialize)]
pub struct PasswordChangeRequest {
    #[serde(rename = "currentPassword")]
    pub current_password: Option<String>,
    #[serde(rename = "newPassword")]
    pub new_password: Option<String>,
    #[serde(rename = "newUsername")]
    pub new_username: Option<String>,
}

pub async fn login_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    addr: Option<ConnectInfo<SocketAddr>>,
    Json(body): Json<LoginRequest>,
) -> Response {
    let ip = extract_client_ip(&headers, addr);
    if let Err(retry_secs) = state.rate_limiter.check(&ip) {
        let mut resp = (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": format!("Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau {} phút.", (retry_secs + 59) / 60)
            })),
        )
            .into_response();
        if let Ok(hv) = HeaderValue::from_str(&retry_secs.to_string()) {
            resp.headers_mut().insert(header::RETRY_AFTER, hv);
        }
        return resp;
    }

    let username = body.username.unwrap_or_default().trim().to_string();
    let password = body.password.unwrap_or_default();

    if username.is_empty() || password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng nhập tên đăng nhập và mật khẩu" })),
        )
            .into_response();
    }

    let Some(user) = state.db.get_user_by_username(&username) else {
        state.rate_limiter.record_failure(&ip);
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Tên đăng nhập hoặc mật khẩu không chính xác" })),
        )
            .into_response();
    };

    if !verify_password(&password, &user.password_hash) {
        state.rate_limiter.record_failure(&ip);
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Tên đăng nhập hoặc mật khẩu không chính xác" })),
        )
            .into_response();
    }

    state.rate_limiter.clear(&ip);
    let token = generate_token(&user.username, user.token_version, 24 * 3600 * 1000);
    let cookie = build_session_cookie(&headers, &token, 24 * 3600);

    let mut resp = (
        StatusCode::OK,
        Json(json!({
            "token": token,
            "user": { "username": user.username }
        })),
    )
        .into_response();

    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

pub async fn logout_handler() -> Response {
    let mut resp = (StatusCode::OK, Json(json!({ "message": "Đã đăng xuất" }))).into_response();
    if let Ok(hv) = HeaderValue::from_str(
        "smart_cctv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
    ) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}

pub async fn verify_handler(Extension(user): Extension<AuthUser>) -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "user": { "username": user.username }
    }))
}

pub async fn change_password_handler(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Extension(auth_user): Extension<AuthUser>,
    Json(body): Json<PasswordChangeRequest>,
) -> Response {
    let current_password = body.current_password.unwrap_or_default();
    let new_password = body.new_password.unwrap_or_default();

    if current_password.is_empty() || new_password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Vui lòng nhập mật khẩu hiện tại và mật khẩu mới" })),
        )
            .into_response();
    }

    if new_password.len() < 8 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Mật khẩu mới phải có ít nhất 8 ký tự" })),
        )
            .into_response();
    }

    let Some(db_user) = state.db.get_user_by_username(&auth_user.username) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Tài khoản không tồn tại" })),
        )
            .into_response();
    };

    if !verify_password(&current_password, &db_user.password_hash) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Mật khẩu hiện tại không chính xác" })),
        )
            .into_response();
    }

    let updated_username = body
        .new_username
        .map(|u| u.trim().to_string())
        .filter(|u| u.len() >= 3)
        .unwrap_or_else(|| db_user.username.clone());

    let next_version = db_user.token_version + 1;
    let new_hash = hash_password(&new_password);

    let update_res = state.db.with_conn(|conn| {
        conn.execute(
            "UPDATE users SET username = ?1, password_hash = ?2, token_version = ?3, updated_at = datetime('now') WHERE id = ?4",
            params![updated_username, new_hash, next_version, db_user.id],
        )
    });

    if update_res.is_err() {
        return (
            StatusCode::CONFLICT,
            Json(json!({ "error": "Tên đăng nhập đã tồn tại" })),
        )
            .into_response();
    }

    let new_token = generate_token(&updated_username, next_version, 24 * 3600 * 1000);
    let cookie = build_session_cookie(&headers, &new_token, 24 * 3600);

    let mut resp = (
        StatusCode::OK,
        Json(json!({
            "message": "Đổi mật khẩu thành công",
            "token": new_token,
            "user": { "username": updated_username }
        })),
    )
        .into_response();

    if let Ok(hv) = HeaderValue::from_str(&cookie) {
        resp.headers_mut().insert(header::SET_COOKIE, hv);
    }
    resp
}
