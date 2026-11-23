mod ai;
mod auth;
mod config;
mod db;
mod routes;
mod security;
mod services;
mod ws;

use std::net::SocketAddr;
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Request, State},
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use serde_json::json;
use tokio::fs::File;
use tokio_util::io::ReaderStream;
use tower_http::services::{ServeDir, ServeFile};

use crate::{
    auth::{auth_middleware, now_ms, LoginRateLimiter},
    config::AppConfig,
    db::Database,
    security::resolve_safe_path,
    services::{
        detection::DetectionEngine, go2rtc::Go2RtcClient, recording::RecordingManager,
        storage::StorageManager,
    },
    ws::{ws_handler, WsHub},
};

pub struct AppState {
    pub config: AppConfig,
    pub db: Database,
    pub ws_hub: WsHub,
    pub go2rtc: Go2RtcClient,
    pub recording_mgr: RecordingManager,
    pub detection_engine: DetectionEngine,
    pub storage_mgr: StorageManager,
    pub rate_limiter: LoginRateLimiter,
    pub start_instant: Instant,
}

async fn security_headers_middleware(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("SAMEORIGIN"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    res
}

async fn serve_protected_snapshot(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(rel_path): axum::extract::Path<String>,
) -> Response {
    let Some(full_path) = resolve_safe_path(&state.config.snapshots_path, &rel_path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(file) = File::open(&full_path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let ct = if rel_path.ends_with(".png") {
        "image/png"
    } else if rel_path.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    let stream = ReaderStream::new(file);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, ct),
            (header::CACHE_CONTROL, "public, max-age=86400"),
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'none'; img-src 'self'",
            ),
        ],
        Body::from_stream(stream),
    )
        .into_response()
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({
        "status": "ok",
        "engine": "rust-ai-nvr",
        "timestamp": now_ms()
    }))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let config = AppConfig::from_env();

    // Check FFmpeg availability
    if Command::new("ffmpeg").arg("-version").output().is_err() {
        tracing::warn!(
            "[WARNING] FFmpeg was not found in system PATH! Continuous recording & audio RMS require FFmpeg installed."
        );
    }

    let db = Database::init(&config.db_path);
    let ws_hub = WsHub::new();
    let go2rtc = Go2RtcClient::new(&config.go2rtc_url);
    let recording_mgr = RecordingManager::new(
        db.clone(),
        config.recordings_path.clone(),
        ws_hub.clone(),
        config.go2rtc_rtsp_url.clone(),
    );
    let storage_mgr = StorageManager::new(
        db.clone(),
        config.recordings_path.clone(),
        config.snapshots_path.clone(),
    );
    let detection_engine = DetectionEngine::new(
        db.clone(),
        config.snapshots_path.clone(),
        config.models_path.clone(),
        go2rtc.clone(),
        ws_hub.clone(),
        config.go2rtc_rtsp_url.clone(),
        recording_mgr.clone(),
    );

    let state = Arc::new(AppState {
        config: config.clone(),
        db: db.clone(),
        ws_hub,
        go2rtc: go2rtc.clone(),
        recording_mgr: recording_mgr.clone(),
        detection_engine: detection_engine.clone(),
        storage_mgr: storage_mgr.clone(),
        rate_limiter: LoginRateLimiter::default(),
        start_instant: Instant::now(),
    });

    // Protected API routes requiring valid session cookie or Bearer JWT
    let protected_api = Router::new()
        .route("/api/auth/verify", get(routes::auth::verify_handler))
        .route(
            "/api/auth/password",
            put(routes::auth::change_password_handler),
        )
        // Cameras CRUD + Authenticated go2rtc Streaming Proxy
        .route(
            "/api/cameras",
            get(routes::cameras::list_cameras_handler).post(routes::cameras::create_camera_handler),
        )
        .route(
            "/api/cameras/:id",
            get(routes::cameras::get_camera_handler)
                .put(routes::cameras::update_camera_handler)
                .delete(routes::cameras::delete_camera_handler),
        )
        .route(
            "/api/cameras/:id/record/start",
            post(routes::cameras::start_record_handler),
        )
        .route(
            "/api/cameras/:id/record/stop",
            post(routes::cameras::stop_record_handler),
        )
        .route(
            "/api/cameras/:id/webrtc",
            post(routes::cameras::webrtc_proxy_handler),
        )
        .route(
            "/api/cameras/:id/snapshot",
            get(routes::cameras::snapshot_proxy_handler),
        )
        .route(
            "/api/cameras/:id/hls/*sub_path",
            get(routes::cameras::hls_proxy_handler),
        )
        // Recordings & Byte-Range Video Stream
        .route(
            "/api/recordings",
            get(routes::recordings::list_recordings_handler),
        )
        .route(
            "/api/recordings/timeline/:camera_id",
            get(routes::recordings::timeline_handler),
        )
        .route(
            "/api/recordings/dates/:camera_id",
            get(routes::recordings::recording_dates_handler),
        )
        .route(
            "/api/recordings/:id/stream",
            get(routes::recordings::stream_recording_handler),
        )
        .route(
            "/api/recordings/:id",
            delete(routes::recordings::delete_recording_handler),
        )
        // AI Detection Events
        .route(
            "/api/events",
            get(routes::events::list_events_handler)
                .delete(routes::events::bulk_delete_events_handler),
        )
        .route("/api/events/stats", get(routes::events::event_stats_handler))
        .route(
            "/api/events/:id",
            get(routes::events::get_event_handler).delete(routes::events::delete_event_handler),
        )
        // Face Recognition Library (512-D ArcFace Embeddings)
        .route(
            "/api/faces",
            get(routes::faces::list_faces_handler).post(routes::faces::create_face_handler),
        )
        .route(
            "/api/faces/:id",
            put(routes::faces::update_face_handler).delete(routes::faces::delete_face_handler),
        )
        // System Info, Hot-Reload Settings & ONNX AI Model Manager
        .route("/api/system/info", get(routes::system::system_info_handler))
        .route(
            "/api/system/settings",
            get(routes::system::get_settings_handler).put(routes::system::update_settings_handler),
        )
        .route(
            "/api/system/models",
            get(routes::system::list_ai_models_handler),
        )
        .route(
            "/api/system/models/:model_id/download",
            post(routes::system::download_ai_model_handler),
        )
        // Protected Snapshot Media Files
        .route("/media/snapshots/*rel_path", get(serve_protected_snapshot))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ));

    // Public routes + Static React SPA fallback
    let spa_index = config.web_dist_path.join("index.html");
    let serve_spa =
        ServeDir::new(&config.web_dist_path).not_found_service(ServeFile::new(spa_index));

    let app = Router::new()
        .route("/api/health", get(health_handler))
        .route("/api/auth/login", post(routes::auth::login_handler))
        .route("/api/auth/logout", post(routes::auth::logout_handler))
        .route("/ws", get(ws_handler))
        .merge(protected_api)
        .fallback_service(serve_spa)
        .layer(DefaultBodyLimit::max(6 * 1024 * 1024))
        .layer(middleware::from_fn(security_headers_middleware))
        .with_state(state.clone());

    // Recover orphaned recordings & boot active camera streams/AI workers
    recording_mgr.recover_orphaned_recordings();
    storage_mgr.start_scheduler();

    let boot_state = state.clone();
    tokio::spawn(async move {
        let cameras = boot_state.db.list_cameras();
        let sound_enabled =
            boot_state.db.get_setting("sound.detection_enabled", "0") == "1";

        for cam in cameras {
            if cam.enabled == 1 {
                boot_state
                    .go2rtc
                    .add_stream(&cam.stream_id, &cam.rtsp_url)
                    .await;
                if cam.record_enabled == 1 {
                    boot_state.recording_mgr.start_recording(cam.clone());
                }
                if cam.detection_enabled == 1 {
                    boot_state.detection_engine.start_detection(cam.clone());
                    if sound_enabled {
                        boot_state.detection_engine.start_sound_detection(cam);
                    }
                }
            }
        }
    });

    let addr: SocketAddr = format!("{}:{}", config.host, config.port)
        .parse()
        .expect("Invalid bind address");

    println!(
        r#"
  ╔══════════════════════════════════════════════════════╗
  ║     Smart CCTV Unified AI NVR Server (Rust 2.0)      ║
  ║     http://{}:{}                                ║
  ╚══════════════════════════════════════════════════════╝
        "#,
        if config.host == "0.0.0.0" {
            "localhost"
        } else {
            &config.host
        },
        config.port
    );

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind TCP port");

    let shutdown_state = state.clone();
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("[Server] Graceful shutdown initiated...");
        shutdown_state.recording_mgr.stop_all();
        shutdown_state.detection_engine.stop_all();
    })
    .await
    .expect("Server terminated with error");
}
