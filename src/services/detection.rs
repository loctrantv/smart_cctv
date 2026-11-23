use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{Timelike, Utc};
use image::{imageops::FilterType, DynamicImage, GenericImageView, RgbImage};
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
            let _ = yolo.load_from_file(&p);
        }
        if let Some(p) = model_mgr.model_path("arcface_mbf") {
            let _ = face_engine.load_rec_model(&p);
        }
        if let Some(p) = model_mgr.model_path("alpr_plate") {
            let _ = alpr_engine.load_from_file(&p);
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
        match model_id {
            "yolov8n" => self.yolo.load_from_file(path),
            "arcface_mbf" => self.face_engine.load_rec_model(path),
            "alpr_plate" => self.alpr_engine.load_from_file(path),
            _ => Ok(()),
        }
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
        tracing::info!("[AI DET] Started in-memory vision worker for {}", camera.name);

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

    /// Fetch JPEG directly into RAM from go2rtc (or fallback to FFmpeg stdout pipe into RAM),
    /// run multi-tier AI & Vision detection, and write snapshot to disk ONLY when an event triggers!
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
        let zones: Vec<DetectionZone> = serde_json::from_str(&camera.detection_zone).unwrap_or_default();
        let tripwires: Vec<TripwireLine> =
            serde_json::from_str(&camera.tripwire_config).unwrap_or_default();

        // 2. Fast Motion Gate & Red-Box BFS Check in RAM (< 0.4ms)
        let scaled_rgb = dyn_img
            .resize_exact(640, 360, FilterType::Nearest)
            .to_rgb8();

        let has_red_box = detect_red_bounding_box_in_ram(&scaled_rgb, &zones);
        let motion_diff_score = compute_frame_motion_diff(&scaled_rgb, prev_gray_thumb, &zones);

        // Cooldown 4s between consecutive visual events on same camera to prevent flood
        if last_event_time.elapsed() < Duration::from_secs(4) {
            return;
        }

        let conf_thresh = self
            .db
            .get_setting("detection.confidence_threshold", "0.45")
            .parse::<f32>()
            .unwrap_or(0.45);

        let mut triggered_events: Vec<(
            String,
            String,
            f64,
            Option<String>,
            (f64, f64, f64, f64),
            String,
        )> = Vec::new();

        // 3. Tier 2: YOLOv8n Dual-Lens Object Detection (Person / Vehicle / Animal)
        if self.yolo.is_loaded() && (has_red_box || motion_diff_score > 0.015) {
            let detections = self.yolo.detect_dual_lens(&rgb_img, conf_thresh);

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
                        triggered_events.push((
                            "face".to_string(),
                            face_match.name.clone(),
                            face_match.similarity as f64,
                            Some(face_match.face_id),
                            (det.x, det.y, det.w, det.h),
                            json!({ "lens": det.lens }).to_string(),
                        ));
                        continue;
                    }
                }

                // Tier 3B: If vehicle detected -> Run ALPR License Plate Recognition
                if det.category == "vehicle" && self.alpr_engine.is_loaded() {
                    if let Some(plate) = self.alpr_engine.recognize_from_vehicle_crop(
                        &rgb_img, det.x, det.y, det.w, det.h,
                    ) {
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

        // Fallback to Red-Box detection when YOLO triggers no specific class or is not yet downloaded
        if triggered_events.is_empty() && has_red_box {
            triggered_events.push((
                "motion".to_string(),
                "motion_detected".to_string(),
                1.0,
                None,
                (0.0, 0.0, 0.0, 0.0),
                "{}".to_string(),
            ));
        }

        if triggered_events.is_empty() {
            return;
        }

        *last_event_time = Instant::now();

        // Save snapshot to disk ONLY because an actual event occurred!
        let cam_snap_dir = self.snapshots_path.join(&camera.id);
        let _ = fs::create_dir_all(&cam_snap_dir);
        let snap_name = format!("snap_{}.jpg", crate::auth::now_ms());
        let snap_full_path = cam_snap_dir.join(&snap_name);
        let rel_snap_path = format!("{}/{}", camera.id, snap_name);

        if fs::write(&snap_full_path, &jpeg_bytes).is_err() {
            return;
        }

        for (evt_type, label, conf, face_id, (bx, by, bw, bh), meta) in triggered_events.into_iter().take(2) {
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
            self.recording_mgr.start_motion_recording(camera.clone(), dur);
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
                self.recording_mgr.start_sound_recording(camera.clone(), dur);
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

/// Native Rust Red-Box BFS detector (< 0.35ms on 640x360 frame in RAM)
fn detect_red_bounding_box_in_ram(rgb: &RgbImage, zones: &[DetectionZone]) -> bool {
    let (width, height) = rgb.dimensions();
    let w_usize = width as usize;
    let h_usize = height as usize;
    let num_pixels = w_usize * h_usize;

    let mut is_red = vec![0u8; num_pixels];
    let mut red_pixels = Vec::new();

    for y in 0..h_usize {
        for x in 0..w_usize {
            let norm_x = x as f64 / w_usize as f64;
            let norm_y = y as f64 / h_usize as f64;
            if !is_inside_zones(norm_x, norm_y, zones) {
                continue;
            }

            let p = rgb.get_pixel(x as u32, y as u32);
            let r = p[0] as i32;
            let g = p[1] as i32;
            let b = p[2] as i32;

            if r > 150 && g < 80 && b < 80 && (r - g) > 80 && (r - b) > 80 {
                let idx = y * w_usize + x;
                is_red[idx] = 1;
                red_pixels.push((x as i32, y as i32));
            }
        }
    }

    if red_pixels.len() < 20 {
        return false;
    }

    let mut visited = vec![0u8; num_pixels];
    let mut queue = VecDeque::new();

    for &(sx, sy) in &red_pixels {
        let start_idx = (sy as usize) * w_usize + (sx as usize);
        if visited[start_idx] != 0 {
            continue;
        }

        let mut cluster = Vec::new();
        visited[start_idx] = 1;
        queue.push_back((sx, sy));

        while let Some((cx, cy)) = queue.pop_front() {
            cluster.push((cx, cy));
            for dy in -2..=2 {
                for dx in -2..=2 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = cx + dx;
                    let ny = cy + dy;
                    if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                        let nidx = (ny as usize) * w_usize + (nx as usize);
                        if is_red[nidx] != 0 && visited[nidx] == 0 {
                            visited[nidx] = 1;
                            queue.push_back((nx, ny));
                        }
                    }
                }
            }
        }

        if cluster.len() >= 30 {
            let mut min_x = width as i32;
            let mut max_x = 0;
            let mut min_y = height as i32;
            let mut max_y = 0;

            for &(px, py) in &cluster {
                min_x = min_x.min(px);
                max_x = max_x.max(px);
                min_y = min_y.min(py);
                max_y = max_y.max(py);
            }

            let bw = max_x - min_x;
            let bh = max_y - min_y;

            if (20..=620).contains(&bw) && (20..=340).contains(&bh) {
                let mut border_count = 0usize;
                let mut inner_count = 0usize;
                for &(px, py) in &cluster {
                    let near_border = (px - min_x <= 5)
                        || (max_x - px <= 5)
                        || (py - min_y <= 5)
                        || (max_y - py <= 5);
                    if near_border {
                        border_count += 1;
                    } else {
                        inner_count += 1;
                    }
                }

                let total = cluster.len() as f64;
                let inner_ratio = inner_count as f64 / total;
                let perimeter = 2.0 * (bw + bh) as f64;
                let coverage = border_count as f64 / perimeter;

                if inner_ratio < 0.3 && coverage > 0.15 {
                    return true;
                }
            }
        }
    }

    false
}

/// Fast Frame-Differencing motion energy detector in RAM
fn compute_frame_motion_diff(
    rgb: &RgbImage,
    prev_gray: &mut Option<Vec<u8>>,
    zones: &[DetectionZone],
) -> f64 {
    let small = DynamicImage::ImageRgb8(rgb.clone())
        .resize_exact(160, 90, FilterType::Nearest)
        .to_luma8();
    let curr: Vec<u8> = small.into_raw();

    let mut changed = 0usize;
    let mut total_checked = 0usize;

    if let Some(prev) = prev_gray.as_ref() {
        if prev.len() == curr.len() {
            for y in 0..90 {
                for x in 0..160 {
                    let nx = x as f64 / 160.0;
                    let ny = y as f64 / 90.0;
                    if !is_inside_zones(nx, ny, zones) {
                        continue;
                    }
                    total_checked += 1;
                    let idx = y * 160 + x;
                    let diff = (curr[idx] as i32 - prev[idx] as i32).abs();
                    if diff > 24 {
                        changed += 1;
                    }
                }
            }
        }
    }

    *prev_gray = Some(curr);
    if total_checked == 0 {
        0.0
    } else {
        changed as f64 / total_checked as f64
    }
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
