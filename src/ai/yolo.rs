use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use image::{imageops::FilterType, DynamicImage, GenericImageView, RgbImage};
use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

type OnnxModel = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectedObject {
    pub class_id: usize,
    /// "person" | "vehicle" | "animal"
    pub category: String,
    pub label: String,
    pub confidence: f32,
    /// Normalized [0.0 .. 1.0] in the full camera frame (accounting for Dual-Lens Top/Bottom offset)
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// 1 = Top Lens (0..50% Y), 2 = Bottom Lens (50..100% Y), 0 = Single lens
    pub lens: u8,
}

#[derive(Clone)]
pub struct YoloDetector {
    session: Arc<Mutex<Option<OnnxModel>>>,
    logged_shape: Arc<AtomicBool>,
}

impl YoloDetector {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
            logged_shape: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.session
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
    }

    pub fn load_from_file(&self, model_path: &Path) -> Result<(), String> {
        let typed = match tract_onnx::onnx()
            .model_for_path(model_path)
            .map_err(|e| {
                tracing::error!("[AI YOLO] Failed to read ONNX model {:?}: {}", model_path, e);
                format!("Failed to read ONNX model: {}", e)
            })?
            .with_input_fact(0, f32::fact([1, 3, 640, 640]).into())
            .map_err(|e| {
                tracing::error!("[AI YOLO] Failed to set input shape: {}", e);
                format!("Failed to set input shape: {}", e)
            })?
            .into_optimized()
        {
            Ok(m) => m,
            Err(opt_err) => {
                tracing::warn!(
                    "[AI YOLO] into_optimized() failed ({}), falling back to into_decluttered()",
                    opt_err
                );
                tract_onnx::onnx()
                    .model_for_path(model_path)
                    .map_err(|e| {
                        tracing::error!(
                            "[AI YOLO] Fallback read failed for {:?}: {}",
                            model_path,
                            e
                        );
                        format!("Failed to read ONNX model: {}", e)
                    })?
                    .with_input_fact(0, f32::fact([1, 3, 640, 640]).into())
                    .map_err(|e| format!("Failed to set input shape: {}", e))?
                    .into_typed()
                    .map_err(|e| {
                        tracing::error!("[AI YOLO] Failed to type ONNX graph: {}", e);
                        format!("Failed to type ONNX graph: {}", e)
                    })?
                    .into_decluttered()
                    .map_err(|e| {
                        tracing::error!("[AI YOLO] Failed to declutter ONNX graph: {}", e);
                        format!("Failed to declutter ONNX graph: {}", e)
                    })?
            }
        };

        let model = typed.into_runnable().map_err(|e| {
            tracing::error!("[AI YOLO] Failed to compile runnable plan: {}", e);
            format!("Failed to compile runnable plan: {}", e)
        })?;

        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(model);
        self.logged_shape.store(false, Ordering::Relaxed);
        tracing::info!(
            "[AI YOLO] Successfully loaded & compiled YOLOv8n ONNX model from {:?}",
            model_path
        );
        Ok(())
    }

    /// Automatically splits a Dual-Lens 8:9 frame into Top 16:9 (Lens 1) and Bottom 16:9 (Lens 2)
    /// in RAM (Zero-copy view) and runs YOLOv8 inference on each lens so aspect ratio is never distorted!
    pub fn detect_dual_lens(&self, img: &RgbImage, conf_threshold: f32) -> Vec<DetectedObject> {
        if !self.is_loaded() {
            return Vec::new();
        }

        let (width, height) = img.dimensions();
        if width < 64 || height < 64 {
            return Vec::new();
        }

        let ratio = width as f64 / height as f64;
        let is_vertical_dual = ratio < 1.15;
        let is_horizontal_dual = ratio > 2.6;
        let mut all_detections = Vec::new();

        if is_vertical_dual {
            let half_h = height / 2;
            // Lens 1: Top 16:9 (y: 0 .. half_h)
            let top_view = DynamicImage::ImageRgb8(img.view(0, 0, width, half_h).to_image());
            let mut top_dets = self.infer_single_view(&top_view, conf_threshold, 1);
            for d in &mut top_dets {
                d.y *= 0.5;
                d.h *= 0.5;
            }
            all_detections.extend(top_dets);

            // Lens 2: Bottom 16:9 (y: half_h .. height)
            let bot_view =
                DynamicImage::ImageRgb8(img.view(0, half_h, width, height - half_h).to_image());
            let mut bot_dets = self.infer_single_view(&bot_view, conf_threshold, 2);
            for d in &mut bot_dets {
                d.y = 0.5 + d.y * 0.5;
                d.h *= 0.5;
            }
            all_detections.extend(bot_dets);
        } else if is_horizontal_dual {
            let half_w = width / 2;
            // Lens 1: Left 16:9 (x: 0 .. half_w)
            let left_view = DynamicImage::ImageRgb8(img.view(0, 0, half_w, height).to_image());
            let mut left_dets = self.infer_single_view(&left_view, conf_threshold, 1);
            for d in &mut left_dets {
                d.x *= 0.5;
                d.w *= 0.5;
            }
            all_detections.extend(left_dets);

            // Lens 2: Right 16:9 (x: half_w .. width)
            let right_view =
                DynamicImage::ImageRgb8(img.view(half_w, 0, width - half_w, height).to_image());
            let mut right_dets = self.infer_single_view(&right_view, conf_threshold, 2);
            for d in &mut right_dets {
                d.x = 0.5 + d.x * 0.5;
                d.w *= 0.5;
            }
            all_detections.extend(right_dets);
        } else {
            let full_view = DynamicImage::ImageRgb8(img.clone());
            all_detections.extend(self.infer_single_view(&full_view, conf_threshold, 0));
        }

        all_detections
    }

    fn infer_single_view(
        &self,
        view: &DynamicImage,
        conf_threshold: f32,
        lens_id: u8,
    ) -> Vec<DetectedObject> {
        // Ultralytics YOLOv8 Letterbox (640x640 with 114/255 gray padding) to preserve true 16:9
        // aspect ratio so horizontal animals (dogs/cats) and vehicles are never squished vertically
        // into person-like shapes!
        let (src_w, src_h) = view.dimensions();
        if src_w < 16 || src_h < 16 {
            return Vec::new();
        }
        let scale = (640.0f32 / src_w as f32).min(640.0f32 / src_h as f32);
        let new_w = ((src_w as f32 * scale).round() as u32).clamp(1, 640);
        let new_h = ((src_h as f32 * scale).round() as u32).clamp(1, 640);
        let pad_x = (640 - new_w) / 2;
        let pad_y = (640 - new_h) / 2;

        let resized = view.resize_exact(new_w, new_h, FilterType::Triangle).to_rgb8();

        // Prepare NCHW tensor [1, 3, 640, 640] filled with standard YOLO gray padding (114/255)
        let pad_val = 114.0f32 / 255.0;
        let mut input_data = vec![pad_val; 3 * 640 * 640];
        let plane_size = 640 * 640;
        for (x, y, pixel) in resized.enumerate_pixels() {
            let dst_x = (x + pad_x) as usize;
            let dst_y = (y + pad_y) as usize;
            let idx = dst_y * 640 + dst_x;
            input_data[idx] = (pixel[0] as f32) / 255.0;
            input_data[plane_size + idx] = (pixel[1] as f32) / 255.0;
            input_data[2 * plane_size + idx] = (pixel[2] as f32) / 255.0;
        }

        let Ok(tensor) = tract_ndarray::Array4::from_shape_vec((1, 3, 640, 640), input_data) else {
            return Vec::new();
        };

        let output_tensor = {
            let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
            let Some(plan) = guard.as_ref() else {
                return Vec::new();
            };
            let mut result = match plan.run(tvec!(tensor.into_tensor().into())) {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!("[AI YOLO] Inference failed on lens {}: {}", lens_id, e);
                    return Vec::new();
                }
            };
            result.remove(0)
        };

        let view_arr = match output_tensor.to_array_view::<f32>() {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("[AI YOLO] Failed to read f32 output tensor: {}", e);
                return Vec::new();
            }
        };

        // Target COCO classes for CCTV Security:
        // 0: person, 1: bicycle, 2: car, 3: motorcycle, 5: bus, 7: truck,
        // 15: cat, 16: dog, 17: horse, 18: sheep, 19: cow
        let target_classes: &[(usize, &str, &str)] = &[
            (0, "person", "person"),
            (1, "vehicle", "bicycle"),
            (2, "vehicle", "car"),
            (3, "vehicle", "motorcycle"),
            (5, "vehicle", "bus"),
            (7, "vehicle", "truck"),
            (15, "animal", "cat"),
            (16, "animal", "dog"),
            (17, "animal", "animal"),
            (18, "animal", "animal"),
            (19, "animal", "animal"),
        ];

        let unpad_box = |mut x1: f32, mut y1: f32, mut x2: f32, mut y2: f32| -> (f64, f64, f64, f64) {
            if x1 <= 1.5 && y1 <= 1.5 && x2 <= 1.5 && y2 <= 1.5 {
                x1 *= 640.0;
                y1 *= 640.0;
                x2 *= 640.0;
                y2 *= 640.0;
            }
            let nx1 = ((x1 - pad_x as f32) / new_w as f32).clamp(0.0, 0.98) as f64;
            let ny1 = ((y1 - pad_y as f32) / new_h as f32).clamp(0.0, 0.98) as f64;
            let nx2 = ((x2 - pad_x as f32) / new_w as f32).clamp(nx1 as f32 + 0.01, 1.0) as f64;
            let ny2 = ((y2 - pad_y as f32) / new_h as f32).clamp(ny1 as f32 + 0.01, 1.0) as f64;
            let nw = (nx2 - nx1).clamp(0.01, (1.0 - nx1).max(0.01));
            let nh = (ny2 - ny1).clamp(0.01, (1.0 - ny1).max(0.01));
            (nx1, ny1, nw, nh)
        };

        let shape = view_arr.shape();
        let should_log_first = !self.logged_shape.swap(true, Ordering::Relaxed);
        let mut max_person_score = 0.0f32;
        let mut candidates = Vec::new();

        // Support BOTH standard YOLOv8 [1, 84, 8400] AND transposed [1, 8400, 84] OR end2end [1, 300, 6]
        if shape.len() == 3 && shape[1] >= 24 && shape[2] > shape[1] {
            // Format A: [1, 84, 8400]
            let num_anchors = shape[2];
            for a in 0..num_anchors {
                let mut best_conf = 0.0f32;
                let mut best_target: Option<(usize, &str, &str)> = None;

                for &(cid, cat, lbl) in target_classes {
                    if 4 + cid < shape[1] {
                        let score = view_arr[[0, 4 + cid, a]];
                        if cid == 0 && score.is_finite() && score > max_person_score {
                            max_person_score = score;
                        }
                        if score.is_finite() && score > best_conf {
                            best_conf = score;
                            best_target = Some((cid, cat, lbl));
                        }
                    }
                }

                if best_conf >= conf_threshold {
                    if let Some((cid, cat, lbl)) = best_target {
                        let cx = view_arr[[0, 0, a]];
                        let cy = view_arr[[0, 1, a]];
                        let bw = view_arr[[0, 2, a]];
                        let bh = view_arr[[0, 3, a]];
                        if !cx.is_finite() || !cy.is_finite() || !bw.is_finite() || !bh.is_finite()
                        {
                            continue;
                        }
                        let (x, y, w, h) =
                            unpad_box(cx - bw * 0.5, cy - bh * 0.5, cx + bw * 0.5, cy + bh * 0.5);

                        candidates.push(DetectedObject {
                            class_id: cid,
                            category: cat.to_string(),
                            label: lbl.to_string(),
                            confidence: best_conf.clamp(0.0, 1.0),
                            x,
                            y,
                            w,
                            h,
                            lens: lens_id,
                        });
                    }
                }
            }
        } else if shape.len() == 3 && shape[2] >= 24 && shape[1] > shape[2] {
            // Format B: Transposed [1, 8400, 84]
            let num_anchors = shape[1];
            for a in 0..num_anchors {
                let mut best_conf = 0.0f32;
                let mut best_target: Option<(usize, &str, &str)> = None;

                for &(cid, cat, lbl) in target_classes {
                    if 4 + cid < shape[2] {
                        let score = view_arr[[0, a, 4 + cid]];
                        if score.is_finite() && score > best_conf {
                            best_conf = score;
                            best_target = Some((cid, cat, lbl));
                        }
                    }
                }

                if best_conf >= conf_threshold {
                    if let Some((cid, cat, lbl)) = best_target {
                        let cx = view_arr[[0, a, 0]];
                        let cy = view_arr[[0, a, 1]];
                        let bw = view_arr[[0, a, 2]];
                        let bh = view_arr[[0, a, 3]];
                        if !cx.is_finite() || !cy.is_finite() || !bw.is_finite() || !bh.is_finite()
                        {
                            continue;
                        }
                        let (x, y, w, h) =
                            unpad_box(cx - bw * 0.5, cy - bh * 0.5, cx + bw * 0.5, cy + bh * 0.5);

                        candidates.push(DetectedObject {
                            class_id: cid,
                            category: cat.to_string(),
                            label: lbl.to_string(),
                            confidence: best_conf.clamp(0.0, 1.0),
                            x,
                            y,
                            w,
                            h,
                            lens: lens_id,
                        });
                    }
                }
            }
        } else if shape.len() == 3 && shape[2] == 6 {
            // Format C: End-to-End NMS [1, N, 6] -> [x1, y1, x2, y2, score, class_id]
            for a in 0..shape[1] {
                let score = view_arr[[0, a, 4]];
                if !score.is_finite() || score < conf_threshold {
                    continue;
                }
                let cid = view_arr[[0, a, 5]] as usize;
                if let Some(&(_, cat, lbl)) = target_classes.iter().find(|&&(c, _, _)| c == cid) {
                    let x1 = view_arr[[0, a, 0]];
                    let y1 = view_arr[[0, a, 1]];
                    let x2 = view_arr[[0, a, 2]];
                    let y2 = view_arr[[0, a, 3]];
                    if !x1.is_finite() || !y1.is_finite() || !x2.is_finite() || !y2.is_finite() {
                        continue;
                    }
                    let (x, y, w, h) = unpad_box(x1, y1, x2, y2);
                    candidates.push(DetectedObject {
                        class_id: cid,
                        category: cat.to_string(),
                        label: lbl.to_string(),
                        confidence: score.clamp(0.0, 1.0),
                        x,
                        y,
                        w,
                        h,
                        lens: lens_id,
                    });
                }
            }
        }

        if should_log_first {
            tracing::info!(
                "[AI YOLO] First inference succeeded; output shape = {:?}, max_person_score = {:.3}, kept_boxes = {}",
                shape,
                max_person_score,
                candidates.len()
            );
        }

        non_max_suppression(candidates, 0.45)
    }
}

pub fn iou(a: &DetectedObject, b: &DetectedObject) -> f64 {
    let x1 = a.x.max(b.x);
    let y1 = a.y.max(b.y);
    let x2 = (a.x + a.w).min(b.x + b.w);
    let y2 = (a.y + a.h).min(b.y + b.h);

    let inter_w = (x2 - x1).max(0.0);
    let inter_h = (y2 - y1).max(0.0);
    let inter_area = inter_w * inter_h;
    if inter_area <= 0.0 {
        return 0.0;
    }

    let union_area = a.w * a.h + b.w * b.h - inter_area;
    if union_area <= 0.0 {
        0.0
    } else {
        inter_area / union_area
    }
}

fn non_max_suppression(mut boxes: Vec<DetectedObject>, iou_thresh: f64) -> Vec<DetectedObject> {
    boxes.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut kept: Vec<DetectedObject> = Vec::new();

    for cand in boxes {
        let overlaps = kept
            .iter()
            .any(|k| k.category == cand.category && iou(k, &cand) > iou_thresh);
        if !overlaps {
            kept.push(cand);
        }
    }
    kept
}
