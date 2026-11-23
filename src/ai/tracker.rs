use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::ai::yolo::{iou, DetectedObject};
use crate::security::{DetectionZone, TripwireLine};

#[derive(Debug, Clone)]
pub struct TrackedObject {
    pub track_id: u64,
    pub category: String,
    pub label: String,
    pub last_box: DetectedObject,
    pub prev_center: (f64, f64),
    pub curr_center: (f64, f64),
    pub last_seen: Instant,
    pub zone_enter_times: HashMap<usize, Instant>,
    pub triggered_zones: HashMap<usize, Instant>,
    pub triggered_lines: HashMap<String, Instant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityRuleAlert {
    /// "line_crossing" | "intrusion"
    pub event_type: String,
    pub label: String,
    pub confidence: f32,
    pub track_id: u64,
    pub bbox_x: f64,
    pub bbox_y: f64,
    pub bbox_w: f64,
    pub bbox_h: f64,
}

pub struct MultiCameraTracker {
    next_id: Mutex<u64>,
    cameras: Mutex<HashMap<String, Vec<TrackedObject>>>,
}

impl MultiCameraTracker {
    pub fn new() -> Self {
        Self {
            next_id: Mutex::new(1),
            cameras: Mutex::new(HashMap::new()),
        }
    }

    fn alloc_id(&self) -> u64 {
        let mut g = self.next_id.lock().unwrap();
        let id = *g;
        *g += 1;
        id
    }

    /// Update tracks with new YOLO detections using ByteTrack IoU matching,
    /// then evaluate Virtual Tripwire (Line Crossing) and Zone Intrusion / Loitering rules!
    pub fn update_and_evaluate(
        &self,
        camera_id: &str,
        detections: &[DetectedObject],
        zones: &[DetectionZone],
        tripwires: &[TripwireLine],
    ) -> Vec<SecurityRuleAlert> {
        let now = Instant::now();
        let mut cam_map = self.cameras.lock().unwrap();
        let tracks = cam_map.entry(camera_id.to_string()).or_default();

        // Purge stale tracks older than 12 seconds
        tracks.retain(|t| now.duration_since(t.last_seen) < Duration::from_secs(12));

        let mut matched_det = vec![false; detections.len()];
        let mut alerts = Vec::new();

        // 1. Associate existing tracks via highest IoU
        for track in tracks.iter_mut() {
            let mut best_iou = 0.25;
            let mut best_idx = None;

            for (idx, det) in detections.iter().enumerate() {
                if matched_det[idx] || det.category != track.category {
                    continue;
                }
                let score = iou(&track.last_box, det);
                if score > best_iou {
                    best_iou = score;
                    best_idx = Some(idx);
                }
            }

            if let Some(idx) = best_idx {
                matched_det[idx] = true;
                let det = &detections[idx];
                let new_center = (det.x + det.w * 0.5, det.y + det.h * 0.85); // Bottom-center foot point
                track.prev_center = track.curr_center;
                track.curr_center = new_center;
                track.last_box = det.clone();
                track.last_seen = now;

                // Evaluate Virtual Tripwire Line Crossing
                for line in tripwires {
                    if let Some(direction_label) = check_line_crossing(
                        track.prev_center,
                        track.curr_center,
                        (line.x1, line.y1),
                        (line.x2, line.y2),
                        &line.direction,
                    ) {
                        let cooldown_ok = track
                            .triggered_lines
                            .get(&line.id)
                            .map(|t| now.duration_since(*t) > Duration::from_secs(10))
                            .unwrap_or(true);
                        if cooldown_ok {
                            track.triggered_lines.insert(line.id.clone(), now);
                            alerts.push(SecurityRuleAlert {
                                event_type: "line_crossing".to_string(),
                                label: format!("{}: {} ({})", line.name, direction_label, track.label),
                                confidence: det.confidence,
                                track_id: track.track_id,
                                bbox_x: det.x,
                                bbox_y: det.y,
                                bbox_w: det.w,
                                bbox_h: det.h,
                            });
                        }
                    }
                }
            }
        }

        // 2. Spawn new tracks for unmatched high-confidence detections
        for (idx, det) in detections.iter().enumerate() {
            if !matched_det[idx] && det.confidence >= 0.45 {
                let center = (det.x + det.w * 0.5, det.y + det.h * 0.85);
                tracks.push(TrackedObject {
                    track_id: self.alloc_id(),
                    category: det.category.clone(),
                    label: det.label.clone(),
                    last_box: det.clone(),
                    prev_center: center,
                    curr_center: center,
                    last_seen: now,
                    zone_enter_times: HashMap::new(),
                    triggered_zones: HashMap::new(),
                    triggered_lines: HashMap::new(),
                });
            }
        }

        // 3. Evaluate Zone Intrusion & Loitering Duration for all active tracks
        if !zones.is_empty() {
            for track in tracks.iter_mut() {
                if now.duration_since(track.last_seen) > Duration::from_millis(500) {
                    continue;
                }
                let (cx, cy) = track.curr_center;
                for (z_idx, z) in zones.iter().enumerate() {
                    let inside = cx >= z.x && cx <= (z.x + z.w) && cy >= z.y && cy <= (z.y + z.h);
                    if inside {
                        let enter_time = *track.zone_enter_times.entry(z_idx).or_insert(now);
                        let dwell_secs = now.duration_since(enter_time).as_secs();

                        if z.loitering_seconds > 0 && dwell_secs >= z.loitering_seconds {
                            let cooldown_ok = track
                                .triggered_zones
                                .get(&z_idx)
                                .map(|t| now.duration_since(*t) > Duration::from_secs(20))
                                .unwrap_or(true);

                            if cooldown_ok {
                                track.triggered_zones.insert(z_idx, now);
                                alerts.push(SecurityRuleAlert {
                                    event_type: "intrusion".to_string(),
                                    label: format!(
                                        "Xâm nhập Vùng #{} ({}s - {})",
                                        z_idx + 1,
                                        dwell_secs,
                                        track.label
                                    ),
                                    confidence: track.last_box.confidence,
                                    track_id: track.track_id,
                                    bbox_x: track.last_box.x,
                                    bbox_y: track.last_box.y,
                                    bbox_w: track.last_box.w,
                                    bbox_h: track.last_box.h,
                                });
                            }
                        }
                    } else {
                        track.zone_enter_times.remove(&z_idx);
                    }
                }
            }
        }

        alerts
    }
}

/// 2D Segment intersection & cross-product direction test between motion vector (p1 -> p2) and tripwire (a -> b)
fn check_line_crossing(
    p1: (f64, f64),
    p2: (f64, f64),
    a: (f64, f64),
    b: (f64, f64),
    allowed_dir: &str,
) -> Option<&'static str> {
    let cross = |o: (f64, f64), u: (f64, f64), v: (f64, f64)| -> f64 {
        (u.0 - o.0) * (v.1 - o.1) - (u.1 - o.1) * (v.0 - o.0)
    };

    let d1 = cross(a, b, p1);
    let d2 = cross(a, b, p2);
    let d3 = cross(p1, p2, a);
    let d4 = cross(p1, p2, b);

    if ((d1 > 0.0 && d2 < 0.0) || (d1 < 0.0 && d2 > 0.0))
        && ((d3 > 0.0 && d4 < 0.0) || (d3 < 0.0 && d4 > 0.0))
    {
        if d1 > 0.0 && d2 < 0.0 {
            if allowed_dir == "both" || allowed_dir == "a_to_b" {
                return Some("Hướng A → B");
            }
        } else if allowed_dir == "both" || allowed_dir == "b_to_a" {
            return Some("Hướng B → A");
        }
    }
    None
}
