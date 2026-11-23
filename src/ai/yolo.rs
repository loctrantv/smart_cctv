use std::path::Path;
use std::sync::{Arc, Mutex};

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
}

impl YoloDetector {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    pub fn load_from_file(&self, model_path: &Path) -> Result<(), String> {
        let model = tract_onnx::onnx()
            .model_for_path(model_path)
            .map_err(|e| format!("Failed to read ONNX model: {}", e))?
            .with_input_fact(0, f32::fact([1, 3, 640, 640]).into())
            .map_err(|e| format!("Failed to set input shape: {}", e))?
            .into_optimized()
            .map_err(|e| format!("Failed to optimize ONNX graph: {}", e))?
            .into_runnable()
            .map_err(|e| format!("Failed to compile runnable plan: {}", e))?;

        let mut guard = self.session.lock().unwrap();
        *guard = Some(model);
        tracing::info!("[AI YOLO] Loaded YOLOv8n ONNX model from {:?}", model_path);
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

        let is_dual_lens = (width as f64 / height as f64) < 1.15;
        let mut all_detections = Vec::new();

        if is_dual_lens {
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
        let resized = view.resize_exact(640, 640, FilterType::Triangle).to_rgb8();

        // Prepare NCHW tensor [1, 3, 640, 640] normalized to [0..1]
        let mut input_data = vec![0.0f32; 3 * 640 * 640];
        let plane_size = 640 * 640;
        for (y, x, pixel) in resized.enumerate_pixels() {
            let idx = (y as usize) * 640 + (x as usize);
            input_data[idx] = (pixel[0] as f32) / 255.0;
            input_data[plane_size + idx] = (pixel[1] as f32) / 255.0;
            input_data[2 * plane_size + idx] = (pixel[2] as f32) / 255.0;
        }

        let Ok(tensor) = tract_ndarray::Array4::from_shape_vec((1, 3, 640, 640), input_data) else {
            return Vec::new();
        };

        let output_tensor = {
            let guard = self.session.lock().unwrap();
            let Some(plan) = guard.as_ref() else {
                return Vec::new();
            };
            let Ok(mut result) = plan.run(tvec!(tensor.into_tensor().into())) else {
                return Vec::new();
            };
            result.remove(0)
        };

        let Ok(view_arr) = output_tensor.to_array_view::<f32>() else {
            return Vec::new();
        };

        // YOLOv8 output shape: [1, 84, 8400]
        let shape = view_arr.shape();
        if shape.len() != 3 || shape[1] < 24 {
            return Vec::new();
        }
        let num_anchors = shape[2];

        // Target COCO classes for CCTV Security:
        // 0: person
        // 1: bicycle, 2: car, 3: motorcycle, 5: bus, 7: truck
        // 15: cat, 16: dog
        let target_classes: &[(usize, &str, &str)] = &[
            (0, "person", "person"),
            (1, "vehicle", "bicycle"),
            (2, "vehicle", "car"),
            (3, "vehicle", "motorcycle"),
            (5, "vehicle", "bus"),
            (7, "vehicle", "truck"),
            (15, "animal", "cat"),
            (16, "animal", "dog"),
        ];

        let mut candidates = Vec::new();

        for a in 0..num_anchors {
            let mut best_conf = 0.0f32;
            let mut best_target: Option<(usize, &str, &str)> = None;

            for &(cid, cat, lbl) in target_classes {
                if 4 + cid < shape[1] {
                    let score = view_arr[[0, 4 + cid, a]];
                    if score > best_conf {
                        best_conf = score;
                        best_target = Some((cid, cat, lbl));
                    }
                }
            }

            if best_conf >= conf_threshold {
                if let Some((cid, cat, lbl)) = best_target {
                    let cx = view_arr[[0, 0, a]] / 640.0;
                    let cy = view_arr[[0, 1, a]] / 640.0;
                    let bw = view_arr[[0, 2, a]] / 640.0;
                    let bh = view_arr[[0, 3, a]] / 640.0;

                    let x = (cx - bw * 0.5).clamp(0.0, 1.0) as f64;
                    let y = (cy - bh * 0.5).clamp(0.0, 1.0) as f64;
                    let w = (bw as f64).clamp(0.01, 1.0 - x);
                    let h = (bh as f64).clamp(0.01, 1.0 - y);

                    candidates.push(DetectedObject {
                        class_id: cid,
                        category: cat.to_string(),
                        label: lbl.to_string(),
                        confidence: best_conf,
                        x,
                        y,
                        w,
                        h,
                        lens: lens_id,
                    });
                }
            }
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
