use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

use chrono::{Timelike, Utc};
use image::{imageops::FilterType, DynamicImage, RgbImage};
use rusqlite::params;
use serde_json::json;
use tokio::process::Command;
use tokio::sync::{watch, Semaphore};
use uuid::Uuid;

use crate::ai::{
    alpr::AlprEngine, audio_ai::classify_audio_signature, face::FaceEngine,
    model_manager::ModelManager, tracker::MultiCameraTracker, yolo::YoloDetector,
};
use crate::db::{CameraRow, Database};
use crate::security::{resolve_safe_path, DetectionZone, TripwireLine};
use crate::services::{go2rtc::Go2RtcClient, recording::RecordingManager};
use crate::ws::WsHub;

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiTestDetectionBox {
    pub r#type: String,
    pub label: String,
    pub confidence: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub lens: u8,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiTestFrameResult {
    pub frame_index: usize,
    pub inference_ms: u64,
    pub snapshot_path: Option<String>,
    pub detections: Vec<AiTestDetectionBox>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AiTestSummary {
    pub total_frames: usize,
    pub frames_with_detections: usize,
    pub elapsed_ms: u64,
    pub yolo_loaded: bool,
    pub face_loaded: bool,
    pub alpr_loaded: bool,
    pub conf_threshold: f32,
    pub counts: HashMap<String, usize>,
    pub frames: Vec<AiTestFrameResult>,
}

#[derive(Clone)]
pub struct DetectionEngine {
    db: Database,
    snapshots_path: PathBuf,
    go2rtc: Go2RtcClient,
    go2rtc_rtsp_url: String,
    ws_hub: WsHub,
    recording_mgr: RecordingManager,
    pub model_mgr: ModelManager,
    pub yolo: YoloDetector,
    pub face_engine: FaceEngine,
    pub alpr_engine: AlprEngine,
    pub tracker: Arc<MultiCameraTracker>,
    visual_workers: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    sound_workers: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    /// Serializes heavy CPU-bound ONNX inference & model compilation on blocking threads
    /// so Tokio async workers stay 100% responsive for WebRTC/HLS/WS live streams.
    ai_semaphore: Arc<Semaphore>,
    warned_yolo_missing: Arc<AtomicBool>,
}

impl DetectionEngine {
    pub fn new(
        db: Database,
        snapshots_path: PathBuf,
        models_path: PathBuf,
        go2rtc: Go2RtcClient,
        ws_hub: WsHub,
        go2rtc_rtsp_url: String,
        recording_mgr: RecordingManager,
    ) -> Self {
        let model_mgr = ModelManager::new(&models_path);
        let yolo = YoloDetector::new();
        let face_engine = FaceEngine::new();
        let alpr_engine = AlprEngine::new();

        Self {
            db,
            snapshots_path,
            go2rtc,
            go2rtc_rtsp_url: go2rtc_rtsp_url.trim_end_matches('/').to_string(),
            ws_hub,
            recording_mgr,
            model_mgr,
            yolo,
            face_engine,
            alpr_engine,
            tracker: Arc::new(MultiCameraTracker::new()),
            visual_workers: Arc::new(Mutex::new(HashMap::new())),
            sound_workers: Arc::new(Mutex::new(HashMap::new())),
            ai_semaphore: Arc::new(Semaphore::new(1)),
            warned_yolo_missing: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Load all already-downloaded ONNX models in a background blocking thread so HTTP/WebRTC/HLS
    /// binds and serves live streams immediately on startup without blocking Tokio workers.
    /// Each model acquires its own permit so YOLOv8n starts detecting immediately even while
    /// ArcFace/ALPR are still compiling.
    pub fn load_installed_models_in_background(&self) {
        let engine = self.clone();
        tokio::spawn(async move {
            // 1. Load YOLOv8n first (highest priority for Person/Vehicle/Animal detection)
            if let Some(p) = engine.model_mgr.model_path("yolov8n") {
                if let Ok(_permit) = engine.ai_semaphore.clone().acquire_owned().await {
                    let eng = engine.clone();
                    let _ = tokio::task::spawn_blocking(move || match eng.yolo.load_from_file(&p) {
                        Ok(()) => {
                            eng.model_mgr.mark_loaded("yolov8n", true);
                            eng.warned_yolo_missing.store(false, Ordering::Relaxed);
                            eng.ws_hub.push_log(
                                "INFO",
                                "YOLO",
                                "Đã nạp thành công model YOLOv8n ONNX vào bộ nhớ Rust",
                            );
                        }
                        Err(e) => {
                            eng.model_mgr.mark_loaded("yolov8n", false);
                            eng.ws_hub.push_log(
                                "ERROR",
                                "YOLO",
                                format!("Lỗi nạp model YOLOv8n: {}", e),
                            );
                        }
                    })
                    .await;
                }
            }

            // 2. Load SFace / ArcFace face embedding model
            if let Some(p) = engine.model_mgr.model_path("arcface_mbf") {
                if let Ok(_permit) = engine.ai_semaphore.clone().acquire_owned().await {
                    let eng = engine.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        match eng.face_engine.load_rec_model(&p) {
                            Ok(()) => {
                                eng.model_mgr.mark_loaded("arcface_mbf", true);
                                eng.ws_hub.push_log(
                                    "INFO",
                                    "FACE",
                                    "Đã nạp thành công model ArcFace/SFace 112x112",
                                );
                                eng.reindex_known_faces();
                            }
                            Err(e) => {
                                eng.model_mgr.mark_loaded("arcface_mbf", false);
                                eng.ws_hub.push_log(
                                    "ERROR",
                                    "FACE",
                                    format!("Lỗi nạp model ArcFace/SFace: {}", e),
                                );
                            }
                        }
                    })
                    .await;
                }
            }

            // 3. Load ALPR license plate detector
            if let Some(p) = engine.model_mgr.model_path("alpr_plate") {
                if let Ok(_permit) = engine.ai_semaphore.clone().acquire_owned().await {
                    let eng = engine.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        match eng.alpr_engine.load_from_file(&p) {
                            Ok(()) => {
                                eng.model_mgr.mark_loaded("alpr_plate", true);
                                eng.ws_hub.push_log(
                                    "INFO",
                                    "ALPR",
                                    "Đã nạp thành công model nhận diện biển số ALPR",
                                );
                            }
                            Err(e) => {
                                eng.model_mgr.mark_loaded("alpr_plate", false);
                                eng.ws_hub.push_log(
                                    "ERROR",
                                    "ALPR",
                                    format!("Lỗi nạp model ALPR: {}", e),
                                );
                            }
                        }
                    })
                    .await;
                }
            }

            if engine.model_mgr.model_path("yunet_face").is_some() {
                engine.model_mgr.mark_loaded("yunet_face", true);
            }
            if engine.model_mgr.model_path("yamnet_audio").is_some() {
                engine.model_mgr.mark_loaded("yamnet_audio", true);
            }
        });
    }

    /// Re-extract embeddings for registered faces from their saved photo files whenever the
    /// active face recognition ONNX model loads, ensuring vector dimensions and preprocessing
    /// match (e.g. upgrading old 512-D fallback vectors to 128-D SFace ONNX vectors).
    pub fn reindex_known_faces(&self) {
        let faces = self.db.list_faces();
        if faces.is_empty() {
            return;
        }
        let mut updated_count = 0usize;
        for face in faces {
            let Some(rel_photo) = face.photo_path.as_deref() else {
                continue;
            };
            let Some(full_path) = resolve_safe_path(&self.snapshots_path, rel_photo) else {
                continue;
            };
            let Ok(bytes) = fs::read(&full_path) else {
                continue;
            };
            if let Some(new_enc) = self.face_engine.extract_embedding_from_bytes(&bytes) {
                self.db.with_conn(|conn| {
                    let _ = conn.execute(
                        "UPDATE faces SET encoding = ?1, updated_at = datetime('now') WHERE id = ?2",
                        params![new_enc, face.id],
                    );
                });
                updated_count += 1;
            }
        }
        if updated_count > 0 {
            self.ws_hub.push_log(
                "INFO",
                "FACE",
                format!(
                    "Đã đồng bộ lại vector đặc trưng cho {} hồ sơ khuôn mặt theo model hiện tại",
                    updated_count
                ),
            );
        }
    }

    /// Run offline AI benchmark/test against an uploaded test video (MP4/MOV/MKV/AVI/WebM)
    /// or test image (JPEG/PNG/WebP), streaming step-by-step logs to the UI console and
    /// saving annotated preview frames with bounding boxes.
    pub async fn run_ai_test_media(
        &self,
        media_bytes: Vec<u8>,
        filename: String,
        is_image: bool,
        sample_fps: f32,
        max_frames: usize,
        conf_threshold: f32,
    ) -> Result<AiTestSummary, String> {
        let safe_fps = sample_fps.clamp(0.2, 2.0);
        let safe_max = max_frames.clamp(1, 30);
        let safe_conf = conf_threshold.clamp(0.15, 0.90);
        let yolo_loaded = self.yolo.is_loaded();
        let face_loaded = self.face_engine.is_loaded();
        let alpr_loaded = self.alpr_engine.is_loaded();

        self.ws_hub.push_log(
            "INFO",
            "TEST",
            format!(
                "Bắt đầu kiểm thử AI trên '{}' (YOLOv8n={}, ArcFace={}, ALPR={}, conf={:.2}, max_frames={})",
                filename, yolo_loaded, face_loaded, alpr_loaded, safe_conf, safe_max
            ),
        );

        if !yolo_loaded {
            let msg = "Model YOLOv8n chưa được nạp vào bộ nhớ! Hãy tải model 'yolov8n' trong tab Phát hiện AI trước.".to_string();
            self.ws_hub.push_log("ERROR", "TEST", msg.clone());
            return Err(msg);
        }

        let start_all = Instant::now();
        let raw_frames: Vec<Vec<u8>> = if is_image {
            vec![media_bytes]
        } else {
            let tmp_dir = self
                .snapshots_path
                .join("_ai_test_tmp")
                .join(Uuid::new_v4().to_string());
            fs::create_dir_all(&tmp_dir)
                .map_err(|e| format!("Không thể tạo thư mục tạm kiểm thử: {}", e))?;

            let ext = Path::new(&filename)
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_lowercase())
                .filter(|s| matches!(s.as_str(), "mp4" | "mkv" | "mov" | "avi" | "webm"))
                .unwrap_or_else(|| "mp4".to_string());
            let input_video = tmp_dir.join(format!("input.{}", ext));
            if let Err(e) = fs::write(&input_video, &media_bytes) {
                let _ = fs::remove_dir_all(&tmp_dir);
                return Err(format!("Không thể ghi file video tạm: {}", e));
            }

            let out_pattern = tmp_dir.join("frame_%03d.jpg");
            let vf_arg = format!("fps={:.2}", safe_fps);
            let mut cmd = Command::new("ffmpeg");
            cmd.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
            ])
            .arg(&input_video)
            .args([
                "-vf",
                &vf_arg,
                "-frames:v",
                &safe_max.to_string(),
                "-strict",
                "-1",
                "-pix_fmt",
                "yuvj420p",
                "-q:v",
                "3",
            ])
            .arg(&out_pattern)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

            let child = cmd.spawn().map_err(|e| {
                let _ = fs::remove_dir_all(&tmp_dir);
                format!("Không thể chạy FFmpeg để tách khung hình video: {}", e)
            })?;

            let out = match tokio::time::timeout(Duration::from_secs(35), child.wait_with_output())
                .await
            {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    return Err(format!("Lỗi FFmpeg khi đọc video test: {}", e));
                }
                Err(_) => {
                    let _ = fs::remove_dir_all(&tmp_dir);
                    return Err("Quá thời gian tách khung hình từ video test (35s)".to_string());
                }
            };

            if !out.status.success() {
                let err_txt = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let _ = fs::remove_dir_all(&tmp_dir);
                let msg = format!("FFmpeg không thể giải mã video test: {}", err_txt);
                self.ws_hub.push_log("ERROR", "TEST", msg.clone());
                return Err(msg);
            }

            let mut frame_paths: Vec<PathBuf> = fs::read_dir(&tmp_dir)
                .map_err(|e| format!("Không đọc được thư mục khung hình tạm: {}", e))?
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.starts_with("frame_") && s.ends_with(".jpg"))
                        .unwrap_or(false)
                })
                .collect();
            frame_paths.sort();

            let mut loaded_frames = Vec::with_capacity(frame_paths.len());
            for fp in frame_paths {
                if let Ok(b) = fs::read(&fp) {
                    if b.len() > 500 {
                        loaded_frames.push(b);
                    }
                }
            }
            let _ = fs::remove_dir_all(&tmp_dir);
            loaded_frames
        };

        if raw_frames.is_empty() {
            let msg = "Không trích xuất được khung hình nào từ file kiểm thử.".to_string();
            self.ws_hub.push_log("WARN", "TEST", msg.clone());
            return Err(msg);
        }

        self.ws_hub.push_log(
            "INFO",
            "TEST",
            format!(
                "Đã trích xuất {} khung hình — bắt đầu chạy suy luận YOLOv8n + ArcFace...",
                raw_frames.len()
            ),
        );

        let _permit = self
            .ai_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "AI engine semaphore closed".to_string())?;

        let engine = self.clone();
        let summary = tokio::task::spawn_blocking(move || {
            let known_faces = engine.db.list_faces();
            let face_thresh = engine.face_engine.recommended_threshold();
            let test_dir = engine.snapshots_path.join("ai_test");
            let _ = fs::create_dir_all(&test_dir);
            let run_ts = crate::auth::now_ms();

            let mut counts: HashMap<String, usize> = HashMap::new();
            let mut frames_out = Vec::with_capacity(raw_frames.len());
            let mut frames_with_detections = 0usize;
            let mut saved_previews = 0usize;

            for (i, jpeg) in raw_frames.iter().enumerate() {
                let frame_idx = i + 1;
                let t0 = Instant::now();
                let Ok(dyn_img) = image::load_from_memory(jpeg) else {
                    engine.ws_hub.push_log(
                        "WARN",
                        "TEST",
                        format!("Frame #{}: Không thể giải mã ảnh JPEG", frame_idx),
                    );
                    continue;
                };
                let mut rgb_img = dyn_img.to_rgb8();
                let raw_dets = engine.yolo.detect_dual_lens(&rgb_img, safe_conf);
                let mut frame_boxes = Vec::new();

                for det in &raw_dets {
                    let mut box_type = det.category.clone();
                    let mut box_label = det.label.clone();
                    let mut box_conf = det.confidence as f64;

                    if det.category == "person" && !known_faces.is_empty() {
                        if let Some(face_match) = engine.face_engine.match_person_crop(
                            &rgb_img,
                            det.x,
                            det.y,
                            det.w,
                            det.h,
                            &known_faces,
                            face_thresh,
                        ) {
                            box_type = "face".to_string();
                            box_label = face_match.name.clone();
                            box_conf = face_match.similarity as f64;
                        }
                    }

                    if det.category == "vehicle" && engine.alpr_engine.is_loaded() {
                        if let Some(plate) = engine.alpr_engine.recognize_from_vehicle_crop(
                            &rgb_img, det.x, det.y, det.w, det.h,
                        ) {
                            *counts.entry("plate".to_string()).or_insert(0) += 1;
                            frame_boxes.push(AiTestDetectionBox {
                                r#type: "plate".to_string(),
                                label: plate.plate_number,
                                confidence: plate.confidence as f64,
                                x: plate.x,
                                y: plate.y,
                                w: plate.w,
                                h: plate.h,
                                lens: det.lens,
                            });
                        }
                    }

                    *counts.entry(box_type.clone()).or_insert(0) += 1;
                    frame_boxes.push(AiTestDetectionBox {
                        r#type: box_type,
                        label: box_label,
                        confidence: box_conf,
                        x: det.x,
                        y: det.y,
                        w: det.w,
                        h: det.h,
                        lens: det.lens,
                    });
                }

                let inf_ms = t0.elapsed().as_millis() as u64;
                if !frame_boxes.is_empty() {
                    frames_with_detections += 1;
                }

                // Save annotated preview for detected frames (up to 12) or frame #1 so user can inspect visually
                let should_save = (!frame_boxes.is_empty() && saved_previews < 12) || frame_idx == 1;
                let mut rel_snap = None;
                if should_save {
                    for b in &frame_boxes {
                        let color = match b.r#type.as_str() {
                            "person" => [0, 212, 255],
                            "face" => [168, 85, 247],
                            "animal" => [0, 255, 136],
                            "vehicle" | "plate" => [255, 170, 0],
                            _ => [255, 59, 48],
                        };
                        draw_ai_bounding_box(&mut rgb_img, b.x, b.y, b.w, b.h, color);
                    }
                    let snap_name = format!("snap_test_{}_f{:02}.jpg", run_ts, frame_idx);
                    let snap_full = test_dir.join(&snap_name);
                    if rgb_img.save(&snap_full).is_ok() {
                        rel_snap = Some(format!("ai_test/{}", snap_name));
                        saved_previews += 1;
                    }
                }

                if frame_boxes.is_empty() {
                    engine.ws_hub.push_log(
                        "INFO",
                        "TEST",
                        format!("Frame #{}: 0 đối tượng ({}ms)", frame_idx, inf_ms),
                    );
                } else {
                    let desc: Vec<String> = frame_boxes
                        .iter()
                        .map(|b| format!("{} {:.0}%", b.label, b.confidence * 100.0))
                        .collect();
                    engine.ws_hub.push_log(
                        "EVENT",
                        "TEST",
                        format!(
                            "Frame #{}: {} đối tượng [{}] ({}ms)",
                            frame_idx,
                            frame_boxes.len(),
                            desc.join(", "),
                            inf_ms
                        ),
                    );
                }

                frames_out.push(AiTestFrameResult {
                    frame_index: frame_idx,
                    inference_ms: inf_ms,
                    snapshot_path: rel_snap,
                    detections: frame_boxes,
                });
            }

            cleanup_camera_snapshots(&test_dir, 40);
            let elapsed_ms = start_all.elapsed().as_millis() as u64;

            engine.ws_hub.push_log(
                "INFO",
                "TEST",
                format!(
                    "Hoàn tất kiểm thử: {}/{} khung hình có đối tượng ({}ms) — person={}, face={}, vehicle={}, animal={}",
                    frames_with_detections,
                    raw_frames.len(),
                    elapsed_ms,
                    counts.get("person").copied().unwrap_or(0),
                    counts.get("face").copied().unwrap_or(0),
                    counts.get("vehicle").copied().unwrap_or(0),
                    counts.get("animal").copied().unwrap_or(0),
                ),
            );

            AiTestSummary {
                total_frames: raw_frames.len(),
                frames_with_detections,
                elapsed_ms,
                yolo_loaded,
                face_loaded,
                alpr_loaded,
                conf_threshold: safe_conf,
                counts,
                frames: frames_out,
            }
        })
        .await
        .map_err(|e| format!("Lỗi luồng kiểm thử AI: {}", e))?;

        Ok(summary)
    }

    pub fn hot_load_model(&self, model_id: &str, path: &Path) -> Result<(), String> {
        let res = match model_id {
            "yolov8n" => {
                let r = self.yolo.load_from_file(path);
                if r.is_ok() {
                    self.warned_yolo_missing.store(false, Ordering::Relaxed);
                }
                r
            }
            "arcface_mbf" => {
                let r = self.face_engine.load_rec_model(path);
                if r.is_ok() {
                    self.reindex_known_faces();
                }
                r
            }
            "alpr_plate" => self.alpr_engine.load_from_file(path),
            _ => Ok(()),
        };
        self.model_mgr.mark_loaded(model_id, res.is_ok());
        res
    }

    /// Async wrapper for `hot_load_model` that compiles the ONNX graph on a blocking thread
    /// without stalling Tokio async workers or dropping live streams.
    pub async fn hot_load_model_async(&self, model_id: String, path: PathBuf) -> Result<(), String> {
        let _permit = self
            .ai_semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "AI engine semaphore closed".to_string())?;
        let engine = self.clone();
        tokio::task::spawn_blocking(move || engine.hot_load_model(&model_id, &path))
            .await
            .map_err(|e| format!("Model load task failed: {}", e))?
    }

    pub fn reload_settings(&self) {
        let sound_enabled = self.db.get_setting("sound.detection_enabled", "0") == "1";
        let cameras = self.db.list_cameras();

        for cam in cameras {
            if cam.enabled == 1 && cam.detection_enabled == 1 {
                self.start_detection(cam.clone());
                if sound_enabled {
                    self.start_sound_detection(cam);
                } else {
                    self.stop_sound_detection(&cam.id);
                }
            } else {
                self.stop_detection(&cam.id);
                self.stop_sound_detection(&cam.id);
            }
        }
    }

    pub fn start_detection(&self, camera: CameraRow) {
        {
            let guard = self.visual_workers.lock().unwrap_or_else(|e| e.into_inner());
            if guard.contains_key(&camera.id) {
                return;
            }
        }

        let (tx, mut rx) = watch::channel(false);
        self.visual_workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(camera.id.clone(), tx);

        let engine = self.clone();
        let cam_id = camera.id.clone();
        self.ws_hub.push_log(
            "INFO",
            "AI",
            format!("Bật worker giám sát AI cho camera '{}'", camera.name),
        );

        tokio::spawn(async move {
            let mut prev_gray_thumb: Option<Vec<u8>> = None;
            let mut last_event_time = Instant::now() - Duration::from_secs(60);
            let mut jpeg_api_backoff_until = Instant::now();
            let mut logged_first_frame = false;

            loop {
                let interval_ms = engine
                    .db
                    .get_setting("detection.interval_ms", "2500")
                    .parse::<u64>()
                    .unwrap_or(2500)
                    .clamp(500, 30000);

                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(interval_ms)) => {},
                    _ = rx.changed() => {
                        if *rx.borrow() {
                            break;
                        }
                    }
                }

                if *rx.borrow() {
                    break;
                }

                let Some(fresh_cam) = engine.db.get_camera(&cam_id) else {
                    break;
                };
                if fresh_cam.enabled == 0 || fresh_cam.detection_enabled == 0 {
                    break;
                }

                engine
                    .process_camera_frame(
                        &fresh_cam,
                        &mut prev_gray_thumb,
                        &mut last_event_time,
                        &mut jpeg_api_backoff_until,
                        &mut logged_first_frame,
                    )
                    .await;
            }

            engine
                .visual_workers
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&cam_id);
        });
    }

    pub fn stop_detection(&self, camera_id: &str) {
        if let Some(tx) = self
            .visual_workers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(camera_id)
        {
            let _ = tx.send(true);
            tracing::info!("[AI DET] Stopped vision worker for {}", camera_id);
        }
    }

    pub fn start_sound_detection(&self, camera: CameraRow) {
        {
            let guard = self.sound_workers.lock().unwrap();
            if guard.contains_key(&camera.id) {
                return;
            }
        }

        let (tx, mut rx) = watch::channel(false);
        self.sound_workers
            .lock()
            .unwrap()
            .insert(camera.id.clone(), tx);

        let engine = self.clone();
        let cam_id = camera.id.clone();
        tracing::info!("[AI SND] Started night sound classifier for {}", camera.name);

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {},
                    _ = rx.changed() => {
                        if *rx.borrow() {
                            break;
                        }
                    }
                }
                if *rx.borrow() {
                    break;
                }

                let Some(fresh_cam) = engine.db.get_camera(&cam_id) else {
                    break;
                };
                engine.process_camera_audio(&fresh_cam).await;
            }

            engine.sound_workers.lock().unwrap().remove(&cam_id);
        });
    }

    pub fn stop_sound_detection(&self, camera_id: &str) {
        if let Some(tx) = self.sound_workers.lock().unwrap().remove(camera_id) {
            let _ = tx.send(true);
        }
    }

    pub fn stop_all(&self) {
        let v_ids: Vec<String> = self
            .visual_workers
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for id in v_ids {
            self.stop_detection(&id);
        }
        let s_ids: Vec<String> = self.sound_workers.lock().unwrap().keys().cloned().collect();
        for id in s_ids {
            self.stop_sound_detection(&id);
        }
    }

    /// Pure AI & Pixel-Diff Vision Pipeline:
    /// 1. Pulls JPEG directly into RAM from go2rtc (with backoff to fast FFmpeg RTSP pipe)
    /// 2. Acquires the AI semaphore asynchronously and offloads ALL CPU-heavy decoding & ONNX
    ///    inference (Dual-Lens YOLOv8n, ByteTrack, SFace/ArcFace, ALPR) to `spawn_blocking`
    ///    so Tokio async workers NEVER stall WebRTC / HLS / WebSocket live streams.
    async fn process_camera_frame(
        &self,
        camera: &CameraRow,
        prev_gray_thumb: &mut Option<Vec<u8>>,
        last_event_time: &mut Instant,
        jpeg_api_backoff_until: &mut Instant,
        logged_first_frame: &mut bool,
    ) {
        let motion_enabled = self.db.get_setting("detection.motion_enabled", "0") == "1";
        let person_enabled = self.db.get_setting("detection.person_enabled", "1") != "0";
        let animal_enabled = self.db.get_setting("detection.animal_enabled", "1") != "0";
        let vehicle_enabled = self.db.get_setting("detection.vehicle_enabled", "1") != "0";

        if !motion_enabled && !person_enabled && !animal_enabled && !vehicle_enabled {
            return;
        }

        // 1. Fetch JPEG bytes directly into RAM without stalling go2rtc
        let now = Instant::now();
        let mut jpeg_bytes = if now >= *jpeg_api_backoff_until {
            match self.go2rtc.fetch_jpeg_frame(&camera.stream_id).await {
                Some(b) => Some(b),
                None => {
                    // Back off `/api/frame.jpeg` for 60s when stream has no MJPEG track
                    *jpeg_api_backoff_until = now + Duration::from_secs(60);
                    None
                }
            }
        } else {
            None
        };

        if jpeg_bytes.is_none() {
            let rtsp_url = format!("{}/{}", self.go2rtc_rtsp_url, camera.stream_id);
            jpeg_bytes = capture_rtsp_jpeg_in_memory(&rtsp_url).await;
        }

        let Some(jpeg_bytes) = jpeg_bytes else {
            return;
        };

        if !*logged_first_frame {
            *logged_first_frame = true;
            self.ws_hub.push_log(
                "INFO",
                "STREAM",
                format!(
                    "Đã tách khung hình đầu tiên cho '{}' ({:.1} KB) — AI đang quét",
                    camera.name,
                    jpeg_bytes.len() as f64 / 1024.0
                ),
            );
        }

        // Acquire single-permit AI semaphore asynchronously so multiple cameras never
        // spike CPU/RAM simultaneously or starve Axum live stream proxies.
        let Ok(Ok(_permit)) = tokio::time::timeout(
            Duration::from_secs(10),
            self.ai_semaphore.clone().acquire_owned(),
        )
        .await
        else {
            return;
        };

        let engine = self.clone();
        let cam_clone = camera.clone();
        let prev_gray_in = prev_gray_thumb.take();
        let can_save_event = last_event_time.elapsed() >= Duration::from_secs(4);

        let blocking_res = tokio::task::spawn_blocking(move || {
            engine.analyze_frame_blocking(&cam_clone, &jpeg_bytes, prev_gray_in, can_save_event)
        })
        .await;

        match blocking_res {
            Ok((next_prev_gray, saved_event, motion_rec_duration)) => {
                *prev_gray_thumb = next_prev_gray;
                if saved_event {
                    *last_event_time = Instant::now();
                }
                if let Some(dur) = motion_rec_duration {
                    self.recording_mgr
                        .start_motion_recording(camera.clone(), dur);
                }
            }
            Err(e) => {
                tracing::error!(
                    "[AI DET] Blocking AI worker panicked for {}: {}",
                    camera.name,
                    e
                );
            }
        }
    }

    /// Runs synchronously on Tokio's dedicated blocking thread pool (`spawn_blocking`).
    /// Returns `(next_prev_gray_thumb, saved_event, optional_motion_recording_duration)`.
    fn analyze_frame_blocking(
        &self,
        camera: &CameraRow,
        jpeg_bytes: &[u8],
        mut prev_gray_thumb: Option<Vec<u8>>,
        can_save_event: bool,
    ) -> (Option<Vec<u8>>, bool, Option<u64>) {
        let Ok(dyn_img) = image::load_from_memory(jpeg_bytes) else {
            return (prev_gray_thumb, false, None);
        };
        let rgb_img = dyn_img.to_rgb8();

        // Parse configured zones & tripwires
        let zones: Vec<DetectionZone> =
            serde_json::from_str(&camera.detection_zone).unwrap_or_default();
        let tripwires: Vec<TripwireLine> =
            serde_json::from_str(&camera.tripwire_config).unwrap_or_default();

        // 2. Fast Luma Frame-Differencing + Motion Centroid Bounding Box in RAM (< 0.15ms)
        let (motion_diff_score, motion_bbox) =
            compute_frame_motion_diff(&dyn_img, &mut prev_gray_thumb, &zones);

        let conf_thresh = self
            .db
            .get_setting("detection.confidence_threshold", "0.35")
            .parse::<f32>()
            .unwrap_or(0.35)
            .clamp(0.15, 0.90);

        let motion_enabled = self.db.get_setting("detection.motion_enabled", "0") == "1";
        let person_enabled = self.db.get_setting("detection.person_enabled", "1") != "0";
        let face_enabled = self.db.get_setting("detection.face_enabled", "1") != "0";
        let animal_enabled = self.db.get_setting("detection.animal_enabled", "1") != "0";
        let vehicle_enabled = self.db.get_setting("detection.vehicle_enabled", "1") != "0";
        let plate_enabled = self.db.get_setting("detection.plate_enabled", "1") != "0";
        let tripwire_enabled = self.db.get_setting("detection.tripwire_enabled", "1") != "0";

        let mut triggered_events: Vec<(
            String,
            String,
            f64,
            Option<String>,
            (f64, f64, f64, f64),
            String,
        )> = Vec::new();
        let mut live_boxes_json = Vec::new();

        let any_object_ai = person_enabled || animal_enabled || vehicle_enabled;

        // 3. YOLOv8n Dual-Lens Object Detection (Person / Vehicle / Animal)
        if any_object_ai {
            if self.yolo.is_loaded() {
                let raw_detections = self.yolo.detect_dual_lens(&rgb_img, conf_thresh);
                let detections: Vec<_> = raw_detections
                    .into_iter()
                    .filter(|d| match d.category.as_str() {
                        "person" => person_enabled,
                        "animal" => animal_enabled,
                        "vehicle" => vehicle_enabled,
                        _ => true,
                    })
                    .collect();

                // Evaluate ByteTrack Tripwire Line Crossing & Zone Intrusion / Loitering
                if tripwire_enabled && (!tripwires.is_empty() || !zones.is_empty()) {
                    let rule_alerts = self.tracker.update_and_evaluate(
                        &camera.id,
                        &detections,
                        &zones,
                        &tripwires,
                    );
                    for rule in rule_alerts {
                        triggered_events.push((
                            rule.event_type,
                            rule.label,
                            rule.confidence as f64,
                            None,
                            (rule.bbox_x, rule.bbox_y, rule.bbox_w, rule.bbox_h),
                            json!({ "track_id": rule.track_id }).to_string(),
                        ));
                    }
                }

                // Only query known faces from SQLite when Person + Face AI is enabled AND a person was detected
                let has_person = detections.iter().any(|d| d.category == "person");
                let known_faces = if person_enabled && face_enabled && has_person {
                    self.db.list_faces()
                } else {
                    Vec::new()
                };
                let face_threshold = self.face_engine.recommended_threshold();

                for det in &detections {
                    let foot_in = is_inside_zones(det.x + det.w * 0.5, det.y + det.h * 0.85, &zones);
                    let center_in =
                        is_inside_zones(det.x + det.w * 0.5, det.y + det.h * 0.5, &zones);
                    if !foot_in && !center_in {
                        continue;
                    }

                    let mut box_type = det.category.clone();
                    let mut box_label = det.label.clone();
                    let mut box_conf = det.confidence as f64;

                    // Tier 3A: If person detected -> Run Face Recognition (SFace/ArcFace Cosine Match)
                    if det.category == "person" && face_enabled && !known_faces.is_empty() {
                        if let Some(face_match) = self.face_engine.match_person_crop(
                            &rgb_img,
                            det.x,
                            det.y,
                            det.w,
                            det.h,
                            &known_faces,
                            face_threshold,
                        ) {
                            box_type = "face".to_string();
                            box_label = face_match.name.clone();
                            box_conf = face_match.similarity as f64;

                            triggered_events.push((
                                "face".to_string(),
                                face_match.name.clone(),
                                face_match.similarity as f64,
                                Some(face_match.face_id),
                                (det.x, det.y, det.w, det.h),
                                json!({ "lens": det.lens }).to_string(),
                            ));
                        }
                    }

                    // Tier 3B: If vehicle detected -> Run ALPR License Plate Recognition
                    if det.category == "vehicle" && plate_enabled && self.alpr_engine.is_loaded() {
                        if let Some(plate) = self.alpr_engine.recognize_from_vehicle_crop(
                            &rgb_img, det.x, det.y, det.w, det.h,
                        ) {
                            live_boxes_json.push(json!({
                                "type": "plate",
                                "label": plate.plate_number,
                                "confidence": plate.confidence,
                                "x": plate.x,
                                "y": plate.y,
                                "w": plate.w,
                                "h": plate.h,
                                "lens": det.lens
                            }));
                            triggered_events.push((
                                "plate".to_string(),
                                plate.plate_number.clone(),
                                plate.confidence as f64,
                                None,
                                (plate.x, plate.y, plate.w, plate.h),
                                json!({ "vehicle_type": det.label, "lens": det.lens }).to_string(),
                            ));
                        }
                    }

                    live_boxes_json.push(json!({
                        "type": box_type,
                        "label": box_label,
                        "confidence": box_conf,
                        "x": det.x,
                        "y": det.y,
                        "w": det.w,
                        "h": det.h,
                        "lens": det.lens
                    }));

                    if box_type != "face" {
                        let lens_label = if det.lens == 1 {
                            format!("{} (Mắt 1)", det.label)
                        } else if det.lens == 2 {
                            format!("{} (Mắt 2)", det.label)
                        } else {
                            det.label.clone()
                        };

                        triggered_events.push((
                            det.category.clone(),
                            lens_label,
                            det.confidence as f64,
                            None,
                            (det.x, det.y, det.w, det.h),
                            json!({ "lens": det.lens, "class": det.label }).to_string(),
                        ));
                    }
                }

                // Broadcast real-time AI Bounding Boxes to live stream VideoPlayer HUD!
                self.ws_hub.broadcast(json!({
                    "type": "ai_detections",
                    "camera_id": camera.id,
                    "timestamp": crate::auth::now_ms(),
                    "boxes": live_boxes_json
                }));
            } else if !self.warned_yolo_missing.swap(true, Ordering::Relaxed) {
                tracing::warn!(
                    "[AI DET] YOLOv8n model chưa được nạp vào bộ nhớ (hãy tải model 'yolov8n' trong Cài đặt -> Phát hiện AI hoặc kiểm tra log nạp ONNX)."
                );
            }
        }

        // 4. Optional Pixel-Motion Detection (ONLY runs if user explicitly enabled `detection.motion_enabled == "1"`)
        if motion_enabled && triggered_events.is_empty() && motion_diff_score >= 0.012 {
            if let Some((mx, my, mw, mh, lens_id)) = motion_bbox {
                // Reject full-screen exposure/lighting shifts (area > 40% of single lens)
                if mw * mh <= 0.22 {
                    let conf = (motion_diff_score * 18.0).clamp(0.55, 0.96);
                    let lens_tag = if lens_id == 1 {
                        "Chuyển động (Mắt 1)"
                    } else {
                        "Chuyển động (Mắt 2)"
                    };

                    live_boxes_json.push(json!({
                        "type": "motion",
                        "label": lens_tag,
                        "confidence": conf,
                        "x": mx,
                        "y": my,
                        "w": mw,
                        "h": mh,
                        "lens": lens_id
                    }));

                    self.ws_hub.broadcast(json!({
                        "type": "ai_detections",
                        "camera_id": camera.id,
                        "timestamp": crate::auth::now_ms(),
                        "boxes": live_boxes_json
                    }));

                    triggered_events.push((
                        "motion".to_string(),
                        lens_tag.to_string(),
                        conf,
                        None,
                        (mx, my, mw, mh),
                        json!({ "lens": lens_id, "diff": motion_diff_score }).to_string(),
                    ));
                }
            }
        }

        if triggered_events.is_empty() || !can_save_event {
            return (prev_gray_thumb, false, None);
        }

        // Draw vivid AI Bounding Boxes + Corner Brackets directly onto the snapshot image in RAM before saving!
        let mut annotated_img = rgb_img;
        for (evt_type, _, _, _, (bx, by, bw, bh), _) in &triggered_events {
            if *bw > 0.01 && *bh > 0.01 {
                let color = match evt_type.as_str() {
                    "person" => [0, 212, 255],            // Cyan for Person
                    "face" => [168, 85, 247],             // Purple for Known Face
                    "animal" => [0, 255, 136],            // Neon Green for Dog/Cat (Pet)
                    "vehicle" | "plate" => [255, 170, 0], // Amber for Vehicle/License Plate
                    _ => [255, 59, 48],                   // Red for Intrusion/Line Crossing
                };
                draw_ai_bounding_box(&mut annotated_img, *bx, *by, *bw, *bh, color);
            }
        }

        // Save annotated snapshot to disk ONLY when an actual AI/Motion event occurred
        let cam_snap_dir = self.snapshots_path.join(&camera.id);
        let _ = fs::create_dir_all(&cam_snap_dir);
        let snap_name = format!("snap_{}.jpg", crate::auth::now_ms());
        let snap_full_path = cam_snap_dir.join(&snap_name);
        let rel_snap_path = format!("{}/{}", camera.id, snap_name);

        if annotated_img.save(&snap_full_path).is_err() {
            // Fallback to raw JPEG bytes if encoding fails
            if fs::write(&snap_full_path, jpeg_bytes).is_err() {
                return (prev_gray_thumb, false, None);
            }
        }

        for (evt_type, label, conf, face_id, (bx, by, bw, bh), meta) in
            triggered_events.into_iter().take(2)
        {
            self.record_event(
                camera,
                &evt_type,
                &label,
                conf,
                Some(&rel_snap_path),
                face_id.as_deref(),
                (bx, by, bw, bh),
                &meta,
            );
        }

        let motion_rec_dur = if self.db.get_setting("recording.on_motion_enabled", "0") == "1" {
            Some(
                self.db
                    .get_setting("recording.on_motion_duration", "30")
                    .parse::<u64>()
                    .unwrap_or(30),
            )
        } else {
            None
        };

        cleanup_camera_snapshots(&cam_snap_dir, 150);
        (prev_gray_thumb, true, motion_rec_dur)
    }

    async fn process_camera_audio(&self, camera: &CameraRow) {
        if self.db.get_setting("sound.detection_enabled", "0") != "1" {
            return;
        }
        if !self.is_night_time() {
            return;
        }

        let threshold_db = self
            .db
            .get_setting("sound.threshold_db", "-20")
            .parse::<f64>()
            .unwrap_or(-20.0);

        let rtsp_url = format!("{}/{}", self.go2rtc_rtsp_url, camera.stream_id);
        let Some((rms_db, peak_db, zcr)) = measure_audio_signature(&rtsp_url).await else {
            return;
        };

        if let Some(alert) = classify_audio_signature(rms_db, peak_db, threshold_db, zcr) {
            let meta = json!({
                "sound_class": alert.class_code,
                "rms_db": alert.rms_db
            })
            .to_string();

            self.record_event(
                camera,
                "sound_alert",
                &alert.display_label,
                alert.confidence,
                None,
                None,
                (0.0, 0.0, 0.0, 0.0),
                &meta,
            );

            if self.db.get_setting("sound.recording_enabled", "1") == "1" {
                let dur = self
                    .db
                    .get_setting("sound.recording_duration", "30")
                    .parse::<u64>()
                    .unwrap_or(30);
                self.recording_mgr
                    .start_sound_recording(camera.clone(), dur);
            }
        }
    }

    fn is_night_time(&self) -> bool {
        let start = self
            .db
            .get_setting("sound.night_start", "22")
            .parse::<u32>()
            .unwrap_or(22);
        let end = self
            .db
            .get_setting("sound.night_end", "6")
            .parse::<u32>()
            .unwrap_or(6);

        let hour = chrono::Local::now().hour();
        if start < end {
            hour >= start && hour < end
        } else {
            hour >= start || hour < end
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn record_event(
        &self,
        camera: &CameraRow,
        evt_type: &str,
        label: &str,
        confidence: f64,
        snapshot_path: Option<&str>,
        face_id: Option<&str>,
        bbox: (f64, f64, f64, f64),
        metadata: &str,
    ) {
        let id = Uuid::new_v4().to_string();
        let ts_iso = Utc::now().to_rfc3339();
        let clamped_conf = confidence.clamp(0.0, 1.0);

        self.db.with_conn(|conn| {
            let _ = conn.execute(
                r#"
                INSERT INTO events (
                    id, camera_id, type, label, confidence, timestamp,
                    snapshot_path, bbox_x, bbox_y, bbox_w, bbox_h, face_id, metadata
                ) VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                "#,
                params![
                    id,
                    camera.id,
                    evt_type,
                    label,
                    clamped_conf,
                    snapshot_path,
                    bbox.0,
                    bbox.1,
                    bbox.2,
                    bbox.3,
                    face_id,
                    metadata
                ],
            );
        });

        let evt_json = json!({
            "id": id,
            "camera_id": camera.id,
            "camera_name": camera.name,
            "type": evt_type,
            "label": label,
            "confidence": clamped_conf,
            "timestamp": ts_iso,
            "snapshot_path": snapshot_path,
            "face_id": face_id,
            "bbox_x": bbox.0,
            "bbox_y": bbox.1,
            "bbox_w": bbox.2,
            "bbox_h": bbox.3,
            "metadata": metadata
        });

        self.ws_hub.broadcast(json!({
            "type": "detection_event",
            "event": evt_json
        }));

        self.ws_hub.push_log(
            "EVENT",
            "AI",
            format!(
                "{} -> [{}] {} ({:.0}%)",
                camera.name,
                evt_type,
                label,
                clamped_conf * 100.0
            ),
        );
    }
}

fn is_inside_zones(cx: f64, cy: f64, zones: &[DetectionZone]) -> bool {
    if zones.is_empty() {
        return true;
    }
    zones
        .iter()
        .any(|z| cx >= z.x && cx <= (z.x + z.w) && cy >= z.y && cy <= (z.y + z.h))
}

/// Draw a high-visibility 3px AI Bounding Box + 6px Corner Accents directly onto an RgbImage buffer
fn draw_ai_bounding_box(
    img: &mut RgbImage,
    nx: f64,
    ny: f64,
    nw: f64,
    nh: f64,
    color: [u8; 3],
) {
    let (img_w, img_h) = img.dimensions();
    if img_w < 16 || img_h < 16 {
        return;
    }

    let x1 = ((nx.clamp(0.0, 1.0) * img_w as f64).round() as i32).clamp(0, img_w as i32 - 2) as u32;
    let y1 = ((ny.clamp(0.0, 1.0) * img_h as f64).round() as i32).clamp(0, img_h as i32 - 2) as u32;
    let x2 = (((nx + nw).clamp(0.0, 1.0) * img_w as f64).round() as i32)
        .clamp(x1 as i32 + 1, img_w as i32 - 1) as u32;
    let y2 = (((ny + nh).clamp(0.0, 1.0) * img_h as f64).round() as i32)
        .clamp(y1 as i32 + 1, img_h as i32 - 1) as u32;

    let thickness = 3u32;
    let rgb_pixel = image::Rgb(color);

    // Top & Bottom horizontal edges
    for t in 0..thickness {
        let yt = (y1 + t).min(img_h - 1);
        let yb = y2.saturating_sub(t).min(img_h - 1);
        for x in x1..=x2 {
            img.put_pixel(x, yt, rgb_pixel);
            img.put_pixel(x, yb, rgb_pixel);
        }
    }

    // Left & Right vertical edges
    for t in 0..thickness {
        let xl = (x1 + t).min(img_w - 1);
        let xr = x2.saturating_sub(t).min(img_w - 1);
        for y in y1..=y2 {
            img.put_pixel(xl, y, rgb_pixel);
            img.put_pixel(xr, y, rgb_pixel);
        }
    }

    // Top-left Label Banner Bar (12px height accent)
    let banner_w = (x2 - x1).min(110);
    let banner_h = 8u32.min(y2 - y1);
    for dy in 0..banner_h {
        for dx in 0..banner_w {
            img.put_pixel((x1 + dx).min(img_w - 1), (y1 + dy).min(img_h - 1), rgb_pixel);
        }
    }
}

/// Fast Frame-Differencing motion energy & Dense Cluster Bounding Box in RAM (< 0.15ms)
/// Divides the 160x180 (8:9 Dual-Lens) frame into 16x18 macro-blocks (10x10 px each),
/// filters out isolated noise/wind/leaves, and extracts the tightest dominant cluster
/// within a single lens (Top Lens 0..9 or Bottom Lens 9..18) so the box never spans wide!
fn compute_frame_motion_diff(
    dyn_img: &DynamicImage,
    prev_gray: &mut Option<Vec<u8>>,
    zones: &[DetectionZone],
) -> (f64, Option<(f64, f64, f64, f64, u8)>) {
    let gw = 160usize;
    let gh = 180usize;
    let small = dyn_img
        .resize_exact(gw as u32, gh as u32, FilterType::Triangle)
        .to_luma8();
    let curr: Vec<u8> = small.into_raw();

    let bw_cells = 16usize; // 16 * 10 = 160
    let bh_cells = 18usize; // 18 * 10 = 180 (0..9 = Lens 1, 9..18 = Lens 2)
    let mut cell_hits = vec![0u16; bw_cells * bh_cells];
    let mut changed = 0usize;
    let mut total_checked = 0usize;

    if let Some(prev) = prev_gray.as_ref() {
        if prev.len() == curr.len() {
            for y in 0..gh {
                let ny = y as f64 / gh as f64;
                // Ignore camera OSD clock/title bars at top/bottom of each lens
                let in_osd_band = (ny < 0.06) || (ny > 0.45 && ny < 0.56) || (ny > 0.95);
                if in_osd_band {
                    continue;
                }

                for x in 0..gw {
                    let nx = x as f64 / gw as f64;
                    if !is_inside_zones(nx, ny, zones) {
                        continue;
                    }
                    total_checked += 1;
                    let idx = y * gw + x;
                    let diff = (curr[idx] as i32 - prev[idx] as i32).abs();
                    if diff > 26 {
                        changed += 1;
                        let cx = (x / 10).min(bw_cells - 1);
                        let cy = (y / 10).min(bh_cells - 1);
                        cell_hits[cy * bw_cells + cx] += 1;
                    }
                }
            }
        }
    }

    *prev_gray = Some(curr);
    if total_checked == 0 || changed < 25 {
        return (0.0, None);
    }

    let score = changed as f64 / total_checked as f64;

    // Find the hottest 10x10 macro-block (must have >= 30% of its 100 pixels changed)
    let mut best_cell = None;
    let mut best_val = 29u16;
    for cy in 0..bh_cells {
        for cx in 0..bw_cells {
            let v = cell_hits[cy * bw_cells + cx];
            if v > best_val {
                best_val = v;
                best_cell = Some((cx, cy));
            }
        }
    }

    let Some((seed_cx, seed_cy)) = best_cell else {
        return (score, None);
    };

    // Restrict cluster growth strictly to the same lens as the seed cell (0..9 or 9..18)
    // and within a localized 5x4 neighborhood around the core movement so the box is tight!
    let lens_id: u8 = if seed_cy < 9 { 1 } else { 2 };
    let (cy_min_bound, cy_max_bound) = if lens_id == 1 { (0, 8) } else { (9, 17) };

    let mut min_cx = seed_cx;
    let mut max_cx = seed_cx;
    let mut min_cy = seed_cy;
    let mut max_cy = seed_cy;

    for cy in cy_min_bound..=cy_max_bound {
        if (cy as i32 - seed_cy as i32).abs() > 3 {
            continue;
        }
        for cx in 0..bw_cells {
            if (cx as i32 - seed_cx as i32).abs() > 3 {
                continue;
            }
            if cell_hits[cy * bw_cells + cx] >= 22 {
                min_cx = min_cx.min(cx);
                max_cx = max_cx.max(cx);
                min_cy = min_cy.min(cy);
                max_cy = max_cy.max(cy);
            }
        }
    }

    let bx = (min_cx as f64 / bw_cells as f64).clamp(0.0, 0.94);
    let by = (min_cy as f64 / bh_cells as f64).clamp(0.0, 0.94);
    let bw = (((max_cx - min_cx + 1) as f64) / bw_cells as f64).clamp(0.06, (1.0 - bx).max(0.06));
    let bh = (((max_cy - min_cy + 1) as f64) / bh_cells as f64).clamp(0.06, 0.48);

    (score, Some((bx, by, bw, bh, lens_id)))
}

async fn capture_rtsp_jpeg_in_memory(rtsp_url: &str) -> Option<Vec<u8>> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url,
        "-frames:v",
        "1",
        "-strict",
        "-1",
        "-pix_fmt",
        "yuvj420p",
        "-q:v",
        "4",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("[AI DET] Failed to spawn ffmpeg for {}: {}", rtsp_url, e);
            return None;
        }
    };
    let out = match tokio::time::timeout(Duration::from_secs(10), child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => {
            tracing::warn!("[AI DET] ffmpeg wait error for {}: {}", rtsp_url, e);
            return None;
        }
        Err(_) => {
            tracing::warn!("[AI DET] ffmpeg frame capture timed out (10s) for {}", rtsp_url);
            return None;
        }
    };
    if out.status.success() && out.stdout.len() > 1000 {
        Some(out.stdout)
    } else {
        let err_msg = String::from_utf8_lossy(&out.stderr);
        let trimmed = err_msg.trim();
        if !trimmed.is_empty() {
            tracing::warn!(
                "[AI DET] ffmpeg frame capture failed for {}: {}",
                rtsp_url,
                trimmed
            );
        }
        None
    }
}

async fn measure_audio_signature(rtsp_url: &str) -> Option<(f64, f64, f64)> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args([
        "-hide_banner",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url,
        "-vn",
        "-af",
        "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level,ametadata=print:key=lavfi.astats.Overall.Peak_level",
        "-f",
        "null",
        "-t",
        "3",
        "-",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);

    let child = cmd.spawn().ok()?;
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(8), child.wait_with_output()).await
    else {
        return None;
    };
    let stderr = String::from_utf8_lossy(&out.stderr);

    let mut last_rms: Option<f64> = None;
    let mut last_peak: Option<f64> = None;

    for line in stderr.lines() {
        if let Some(idx) = line.find("lavfi.astats.Overall.RMS_level=") {
            let val_str = &line[idx + "lavfi.astats.Overall.RMS_level=".len()..];
            if let Ok(v) = val_str.trim().parse::<f64>() {
                if v.is_finite() {
                    last_rms = Some(v);
                }
            }
        }
        if let Some(idx) = line.find("lavfi.astats.Overall.Peak_level=") {
            let val_str = &line[idx + "lavfi.astats.Overall.Peak_level=".len()..];
            if let Ok(v) = val_str.trim().parse::<f64>() {
                if v.is_finite() {
                    last_peak = Some(v);
                }
            }
        }
    }

    let rms = last_rms?;
    let peak = last_peak.unwrap_or(rms + 6.0);
    Some((rms, peak, 0.16))
}

fn cleanup_camera_snapshots(dir: &std::path::Path, max_files: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.starts_with("snap_"))
                .unwrap_or(false)
        })
        .collect();

    if files.len() > max_files {
        files.sort();
        let to_remove = files.len() - max_files;
        for f in files.into_iter().take(to_remove) {
            let _ = fs::remove_file(f);
        }
    }
}
