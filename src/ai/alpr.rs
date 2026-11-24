use std::path::Path;
use std::sync::{Arc, Mutex};

use image::{GenericImageView, RgbImage};
use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

type OnnxModel = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LicensePlateResult {
    pub plate_number: String,
    pub confidence: f32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone)]
pub struct AlprEngine {
    session: Arc<Mutex<Option<OnnxModel>>>,
}

impl AlprEngine {
    pub fn new() -> Self {
        Self {
            session: Arc::new(Mutex::new(None)),
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
                tracing::error!("[AI ALPR] Failed to read ALPR ONNX model {:?}: {}", model_path, e);
                format!("Failed to read ALPR ONNX model: {}", e)
            })?
            .with_input_fact(0, f32::fact([1, 3, 640, 640]).into())
            .map_err(|e| format!("Failed to set ALPR input shape: {}", e))?
            .into_optimized()
        {
            Ok(m) => m,
            Err(opt_err) => {
                tracing::warn!(
                    "[AI ALPR] into_optimized() failed ({}), falling back to into_decluttered()",
                    opt_err
                );
                tract_onnx::onnx()
                    .model_for_path(model_path)
                    .map_err(|e| format!("Failed to read ALPR ONNX model: {}", e))?
                    .with_input_fact(0, f32::fact([1, 3, 640, 640]).into())
                    .map_err(|e| format!("Failed to set ALPR input shape: {}", e))?
                    .into_typed()
                    .map_err(|e| format!("Failed to type ALPR graph: {}", e))?
                    .into_decluttered()
                    .map_err(|e| format!("Failed to declutter ALPR graph: {}", e))?
            }
        };

        let model = typed
            .into_runnable()
            .map_err(|e| format!("Failed to compile runnable ALPR plan: {}", e))?;

        let mut guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(model);
        tracing::info!(
            "[AI ALPR] Loaded Vietnam License Plate Detector from {:?}",
            model_path
        );
        Ok(())
    }

    /// Inspect a detected vehicle region (car / motorcycle / truck) for a high-contrast rectangular license plate
    pub fn recognize_from_vehicle_crop(
        &self,
        frame: &RgbImage,
        veh_x: f64,
        veh_y: f64,
        veh_w: f64,
        veh_h: f64,
    ) -> Option<LicensePlateResult> {
        if !self.is_loaded() {
            return None;
        }

        let (fw, fh) = frame.dimensions();
        if fw < 24 || fh < 24 {
            return None;
        }
        let vx = ((veh_x.clamp(0.0, 1.0) * fw as f64) as u32).min(fw.saturating_sub(24));
        let vy = ((veh_y.clamp(0.0, 1.0) * fh as f64) as u32).min(fh.saturating_sub(24));
        let vw = ((veh_w.clamp(0.0, 1.0) * fw as f64) as u32).clamp(24, (fw - vx).max(24));
        let vh = ((veh_h.clamp(0.0, 1.0) * fh as f64) as u32).clamp(24, (fh - vy).max(24));

        let crop = image::DynamicImage::ImageRgb8(frame.view(vx, vy, vw, vh).to_image());
        let resized = crop
            .resize_exact(640, 640, image::imageops::FilterType::Triangle)
            .to_rgb8();

        let mut input = vec![0.0f32; 3 * 640 * 640];
        let plane = 640 * 640;
        for (y, x, p) in resized.enumerate_pixels() {
            let idx = (y as usize) * 640 + (x as usize);
            input[idx] = p[0] as f32 / 255.0;
            input[plane + idx] = p[1] as f32 / 255.0;
            input[2 * plane + idx] = p[2] as f32 / 255.0;
        }

        let tensor = tract_ndarray::Array4::from_shape_vec((1, 3, 640, 640), input).ok()?;
        let output = {
            let guard = self.session.lock().unwrap_or_else(|e| e.into_inner());
            let plan = guard.as_ref()?;
            let mut res = plan.run(tvec!(tensor.into_tensor().into())).ok()?;
            res.remove(0)
        };

        let view = output.to_array_view::<f32>().ok()?;
        let shape = view.shape();
        if shape.len() != 3 || shape[1] < 5 {
            return None;
        }

        let mut best_conf = 0.45f32;
        let mut best_box = None;

        for a in 0..shape[2] {
            let score = view[[0, 4, a]];
            if score.is_finite() && score > best_conf {
                best_conf = score;
                let cx = (view[[0, 0, a]] / 640.0) as f64;
                let cy = (view[[0, 1, a]] / 640.0) as f64;
                let bw = (view[[0, 2, a]] / 640.0) as f64;
                let bh = (view[[0, 3, a]] / 640.0) as f64;
                best_box = Some((
                    (veh_x + (cx - bw * 0.5).clamp(0.0, 1.0) * veh_w).clamp(0.0, 0.98),
                    (veh_y + (cy - bh * 0.5).clamp(0.0, 1.0) * veh_h).clamp(0.0, 0.98),
                    (bw * veh_w).clamp(0.01, 1.0),
                    (bh * veh_h).clamp(0.01, 1.0),
                ));
            }
        }

        let (px, py, pw, ph) = best_box?;
        let plate_label = self.decode_plate_characters(frame, px, py, pw, ph);

        Some(LicensePlateResult {
            plate_number: plate_label,
            confidence: best_conf,
            x: px,
            y: py,
            w: pw.min((1.0 - px).max(0.01)),
            h: ph.min((1.0 - py).max(0.01)),
        })
    }

    fn decode_plate_characters(
        &self,
        frame: &RgbImage,
        px: f64,
        py: f64,
        pw: f64,
        ph: f64,
    ) -> String {
        let (fw, fh) = frame.dimensions();
        if fw < 8 || fh < 8 {
            return "BIỂN SỐ (VN)".to_string();
        }
        let x0 = ((px.clamp(0.0, 1.0) * fw as f64) as u32).min(fw.saturating_sub(8));
        let y0 = ((py.clamp(0.0, 1.0) * fh as f64) as u32).min(fh.saturating_sub(8));
        let w = ((pw.clamp(0.0, 1.0) * fw as f64) as u32).clamp(8, (fw - x0).max(8));
        let h = ((ph.clamp(0.0, 1.0) * fh as f64) as u32).clamp(8, (fh - y0).max(8));

        let is_two_line = (w as f64 / h.max(1) as f64) < 2.2;
        if is_two_line {
            "BIỂN SỐ 2 DÒNG (VN)".to_string()
        } else {
            "BIỂN SỐ 1 DÒNG (VN)".to_string()
        }
    }
}
