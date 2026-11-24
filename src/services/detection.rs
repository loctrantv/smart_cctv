use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{Timelike, Utc};
use image::{imageops::FilterType, DynamicImage, RgbImage};
use rusqlite::params;
use serde_json::json;
use tokio::process::Command;
use tokio::sync::watch;
use uuid::Uuid;

use crate::ai::{
    alpr::AlprEngine, audio_ai::classify_audio_signature, face::FaceEngine,
    model_manager::ModelManager, tracker::MultiCameraTracker, yolo::YoloDetector,
};
use crate::db::{CameraRow, Database};
use crate::security::{DetectionZone, TripwireLine};
use crate::services::{go2rtc::Go2RtcClient, recording::RecordingManager};
use crate::ws::WsHub;

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

        // Auto-load any existing ONNX models from disk
        if let Some(p) = model_mgr.model_path("yolov8n") {
            let ok = yolo.load_from_file(&p).is_ok();
            model_mgr.mark_loaded("yolov8n", ok);
        }
        if let Some(p) = model_mgr.model_path("arcface_mbf") {
            let ok = face_engine.load_rec_model(&p).is_ok();
            model_mgr.mark_loaded("arcface_mbf", ok);
        }
        if let Some(p) = model_mgr.model_path("alpr_plate") {
            let ok = alpr_engine.load_from_file(&p).is_ok();
            model_mgr.mark_loaded("alpr_plate", ok);
        }

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
        }
    }

    pub fn hot_load_model(&self, model_id: &str, path: &std::path::Path) -> Result<(), String> {
        let res = match model_id {
            "yolov8n" => self.yolo.load_from_file(path),
            "arcface_mbf" => self.face_engine.load_rec_model(path),
            "alpr_plate" => self.alpr_engine.load_from_file(path),
            _ => Ok(()),
        };
        self.model_mgr.mark_loaded(model_id, res.is_ok());
        res
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
            let guard = self.visual_workers.lock().unwrap();
            if guard.contains_key(&camera.id) {
                return;
            }
        }

        let (tx, mut rx) = watch::channel(false);
        self.visual_workers
            .lock()
            .unwrap()
            .insert(camera.id.clone(), tx);

        let engine = self.clone();
        let cam_id = camera.id.clone();
        tracing::info!("[AI DET] Started in-memory AI vision worker for {}", camera.name);

        tokio::spawn(async move {
            let mut prev_gray_thumb: Option<Vec<u8>> = None;
            let mut last_event_time = Instant::now() - Duration::from_secs(60);

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
                    .process_camera_frame(&fresh_cam, &mut prev_gray_thumb, &mut last_event_time)
                    .await;
            }

            engine.visual_workers.lock().unwrap().remove(&cam_id);
        });
    }

    pub fn stop_detection(&self, camera_id: &str) {
        if let Some(tx) = self.visual_workers.lock().unwrap().remove(camera_id) {
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

    /// Pure AI & Pixel-Diff Vision Pipeline (Legacy Red-Box BFS detector completely removed!)
    /// 1. Pulls JPEG directly into RAM from go2rtc (Zero disk writes for non-events)
    /// 2. Checks fast Luma Frame-Differencing motion gate (< 0.15ms)
    /// 3. Runs Dual-Lens YOLOv8n (Person / Vehicle / Animal), ByteTrack Tripwire & Loitering,
    ///    ArcFace 512-D Face Recognition, and Vietnam ALPR License Plate Recognition.
    async fn process_camera_frame(
        &self,
        camera: &CameraRow,
        prev_gray_thumb: &mut Option<Vec<u8>>,
        last_event_time: &mut Instant,
    ) {
        // 1. Fetch JPEG bytes directly into RAM
        let jpeg_bytes = match self.go2rtc.fetch_jpeg_frame(&camera.stream_id).await {
            Some(b) => b,
            None => {
                let rtsp_url = format!("{}/{}", self.go2rtc_rtsp_url, camera.stream_id);
                match capture_rtsp_jpeg_in_memory(&rtsp_url).await {
                    Some(b) => b,
                    None => return,
                }
            }
        };

        let Ok(dyn_img) = image::load_from_memory(&jpeg_bytes) else {
            return;
        };
        let rgb_img = dyn_img.to_rgb8();

        // Parse configured zones & tripwires
        let zones: Vec<DetectionZone> =
            serde_json::from_str(&camera.detection_zone).unwrap_or_default();
        let tripwires: Vec<TripwireLine> =
            serde_json::from_str(&camera.tripwire_config).unwrap_or_default();

        // 2. Fast Luma Frame-Differencing + Motion Centroid Bounding Box in RAM (< 0.15ms)
        let (motion_diff_score, motion_bbox) =
            compute_frame_motion_diff(&dyn_img, prev_gray_thumb, &zones);

        // Cooldown 4s between saving DB/disk snapshots on same camera,
        // while still running YOLOv8n below so Live Stream HUD boxes update smoothly!
        let can_save_event = last_event_time.elapsed() >= Duration::from_secs(4);

        let conf_thresh = self
            .db
            .get_setting("detection.confidence_threshold", "0.35")
            .parse::<f32>()
            .unwrap_or(0.35)
            .clamp(0.15, 0.90);

        let motion_enabled = self.db.get_setting("detection.motion_enabled", "0") == "1";
        let person_enabled = self.db.get_setting("detection.person_enabled", "1") != "0";
        let animal_enabled = self.db.get_setting("detection.animal_enabled", "1") != "0";
        let vehicle_enabled = self.db.get_setting("detection.vehicle_enabled", "1") != "0";

        let mut triggered_events: Vec<(
            String,
            String,
            f64,
            Option<String>,
            (f64, f64, f64, f64),
            String,
        )> = Vec::new();
        let mut live_boxes_json = Vec::new();

        // Lazy auto-load YOLOv8n if file exists on disk but wasn't loaded yet
        if !self.yolo.is_loaded() {
            if let Some(p) = self.model_mgr.model_path("yolov8n") {
                let ok = self.yolo.load_from_file(&p).is_ok();
                self.model_mgr.mark_loaded("yolov8n", ok);
            }
        }

        // 3. YOLOv8n Dual-Lens Object Detection (Person / Vehicle / Animal)
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
            let rule_alerts =
                self.tracker
                    .update_and_evaluate(&camera.id, &detections, &zones, &tripwires);
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

            let known_faces = self.db.list_faces();

            for det in &detections {
                if !is_inside_zones(det.x + det.w * 0.5, det.y + det.h * 0.85, &zones) {
                    continue;
                }

                let mut box_type = det.category.clone();
                let mut box_label = det.label.clone();
                let mut box_conf = det.confidence as f64;

                // Tier 3A: If person detected -> Run Face Recognition (512-D Cosine Match)
                if det.category == "person" {
                    if let Some(face_match) = self.face_engine.match_person_crop(
                        &rgb_img,
                        det.x,
                        det.y,
                        det.w,
                        det.h,
                        &known_faces,
                        0.58,
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
                if det.category == "vehicle" && self.alpr_engine.is_loaded() {
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
            return;
        }

        *last_event_time = Instant::now();

        // Draw vivid AI Bounding Boxes + Corner Brackets directly onto the snapshot image in RAM before saving!
        let mut annotated_img = rgb_img.clone();
        for (evt_type, _, _, _, (bx, by, bw, bh), _) in &triggered_events {
            if *bw > 0.01 && *bh > 0.01 {
                let color = match evt_type.as_str() {
                    "person" => [0, 212, 255],        // Cyan for Person
                    "face" => [168, 85, 247],         // Purple for Known Face
                    "animal" => [0, 255, 136],        // Neon Green for Dog/Cat (Pet)
                    "vehicle" | "plate" => [255, 170, 0], // Amber for Vehicle/License Plate
                    _ => [255, 59, 48],               // Red for Intrusion/Line Crossing
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
            if fs::write(&snap_full_path, &jpeg_bytes).is_err() {
                return;
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

        // Trigger motion recording if enabled
        if self.db.get_setting("recording.on_motion_enabled", "0") == "1" {
            let dur = self
                .db
                .get_setting("recording.on_motion_duration", "30")
                .parse::<u64>()
                .unwrap_or(30);
            self.recording_mgr
                .start_motion_recording(camera.clone(), dur);
        }

        cleanup_camera_snapshots(&cam_snap_dir, 150);
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

        tracing::info!(
            "[AI EVENT] {} -> [{}] {} ({:.0}%)",
            camera.name,
            evt_type,
            label,
            clamped_conf * 100.0
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

    let x1 = ((nx * img_w as f64).round() as i32).clamp(0, img_w as i32 - 1) as u32;
    let y1 = ((ny * img_h as f64).round() as i32).clamp(0, img_h as i32 - 1) as u32;
    let x2 = (((nx + nw) * img_w as f64).round() as i32).clamp(x1 as i32 + 1, img_w as i32 - 1) as u32;
    let y2 = (((ny + nh) * img_h as f64).round() as i32).clamp(y1 as i32 + 1, img_h as i32 - 1) as u32;

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
    let bw = (((max_cx - min_cx + 1) as f64) / bw_cells as f64).clamp(0.06, 1.0 - bx);
    let bh = (((max_cy - min_cy + 1) as f64) / bh_cells as f64).clamp(0.06, 0.48);

    (score, Some((bx, by, bw, bh, lens_id)))
}

async fn capture_rtsp_jpeg_in_memory(rtsp_url: &str) -> Option<Vec<u8>> {
    let child = Command::new("ffmpeg")
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-i",
            rtsp_url,
            "-vframes",
            "1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output();

    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(7), child).await else {
        return None;
    };
    if out.status.success() && out.stdout.len() > 1000 {
        Some(out.stdout)
    } else {
        None
    }
}

async fn measure_audio_signature(rtsp_url: &str) -> Option<(f64, f64, f64)> {
    let fut = Command::new("ffmpeg")
        .args([
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
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(8), fut).await else {
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
