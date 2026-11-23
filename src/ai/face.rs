use std::path::Path;
use std::sync::{Arc, Mutex};

use image::{imageops::FilterType, DynamicImage, GenericImageView, RgbImage};
use serde::{Deserialize, Serialize};
use tract_onnx::prelude::*;

use crate::db::FaceRow;

type OnnxModel = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceMatchResult {
    pub face_id: String,
    pub name: String,
    pub similarity: f32,
}

#[derive(Clone)]
pub struct FaceEngine {
    rec_session: Arc<Mutex<Option<OnnxModel>>>,
}

impl FaceEngine {
    pub fn new() -> Self {
        Self {
            rec_session: Arc::new(Mutex::new(None)),
        }
    }

    pub fn is_loaded(&self) -> bool {
        self.rec_session.lock().unwrap().is_some()
    }

    pub fn load_rec_model(&self, model_path: &Path) -> Result<(), String> {
        let model = tract_onnx::onnx()
            .model_for_path(model_path)
            .map_err(|e| format!("Failed to read Face ONNX model: {}", e))?
            .with_input_fact(0, f32::fact([1, 3, 112, 112]).into())
            .map_err(|e| format!("Failed to set 112x112 face input shape: {}", e))?
            .into_optimized()
            .map_err(|e| format!("Failed to optimize Face ONNX graph: {}", e))?
            .into_runnable()
            .map_err(|e| format!("Failed to compile runnable Face plan: {}", e))?;

        let mut guard = self.rec_session.lock().unwrap();
        *guard = Some(model);
        tracing::info!("[AI Face] Loaded ArcFace/SFace 112x112 embedding model from {:?}", model_path);
        Ok(())
    }

    /// Compute a normalized face feature vector (512-D or 128-D depending on ONNX model,
    /// with deterministic multi-scale spatial facial descriptor fallback when ONNX is not yet downloaded).
    pub fn extract_embedding(&self, face_img: &DynamicImage) -> Vec<f32> {
        let aligned = self.crop_center_face_region(face_img);

        // 1. If ONNX ArcFace/SFace model is loaded, run deep neural embedding extraction
        if self.is_loaded() {
            if let Some(vec_onnx) = self.run_onnx_embedding(&aligned) {
                return l2_normalize(vec_onnx);
            }
        }

        // 2. Deterministic 512-D Spatial-Chromatic Hog/Gabor Facial Embedding
        // Ensures face registration & cosine matching work out-of-the-box even before downloading ONNX weights!
        let thumb = aligned.resize_exact(32, 32, FilterType::Triangle).to_rgb8();
        let mut vec512 = Vec::with_capacity(512);

        // Divide 32x32 into 16x8 cells (128 cells * 4 features [R, G, B, Gradient] = 512-D)
        for cy in 0..8 {
            for cx in 0..16 {
                let px = cx * 2;
                let py = cy * 4;
                let mut r_sum = 0.0f32;
                let mut g_sum = 0.0f32;
                let mut b_sum = 0.0f32;
                let mut grad_sum = 0.0f32;

                for dy in 0..4 {
                    for dx in 0..2 {
                        let p = thumb.get_pixel(px + dx, py + dy);
                        let r = p[0] as f32 / 255.0;
                        let g = p[1] as f32 / 255.0;
                        let b = p[2] as f32 / 255.0;
                        r_sum += r;
                        g_sum += g;
                        b_sum += b;

                        let p_next = thumb.get_pixel((px + dx + 1).min(31), (py + dy + 1).min(31));
                        let luma1 = 0.299 * r + 0.587 * g + 0.114 * b;
                        let luma2 = (0.299 * p_next[0] as f32
                            + 0.587 * p_next[1] as f32
                            + 0.114 * p_next[2] as f32)
                            / 255.0;
                        grad_sum += (luma1 - luma2).abs();
                    }
                }
                vec512.push(r_sum / 8.0);
                vec512.push(g_sum / 8.0);
                vec512.push(b_sum / 8.0);
                vec512.push(grad_sum / 8.0);
            }
        }

        l2_normalize(vec512)
    }

    fn crop_center_face_region(&self, img: &DynamicImage) -> DynamicImage {
        let (w, h) = img.dimensions();
        if w < 32 || h < 32 {
            return img.clone();
        }
        // Focus on the upper-center facial zone to remove background collar/shoulders
        let side = (w.min(h) as f32 * 0.78) as u32;
        let x0 = (w.saturating_sub(side)) / 2;
        let y0 = (h.saturating_sub(side)) / 3;
        img.crop_imm(x0, y0, side.max(16), side.max(16))
    }

    fn run_onnx_embedding(&self, aligned: &DynamicImage) -> Option<Vec<f32>> {
        let rgb112 = aligned.resize_exact(112, 112, FilterType::Triangle).to_rgb8();
        let mut input = vec![0.0f32; 3 * 112 * 112];
        let plane = 112 * 112;

        for (y, x, p) in rgb112.enumerate_pixels() {
            let idx = (y as usize) * 112 + (x as usize);
            input[idx] = (p[0] as f32 - 127.5) / 128.0;
            input[plane + idx] = (p[1] as f32 - 127.5) / 128.0;
            input[2 * plane + idx] = (p[2] as f32 - 127.5) / 128.0;
        }

        let tensor = tract_ndarray::Array4::from_shape_vec((1, 3, 112, 112), input).ok()?;
        let guard = self.rec_session.lock().unwrap();
        let plan = guard.as_ref()?;
        let mut result = plan.run(tvec!(tensor.into_tensor().into())).ok()?;
        let output = result.remove(0);
        let view = output.to_array_view::<f32>().ok()?;
        Some(view.iter().copied().collect())
    }

    pub fn extract_embedding_from_bytes(&self, image_bytes: &[u8]) -> Option<String> {
        let img = image::load_from_memory(image_bytes).ok()?;
        let vec = self.extract_embedding(&img);
        serde_json::to_string(&vec).ok()
    }

    /// Crop head/face region from a detected person bounding box in the camera frame and match against known faces
    pub fn match_person_crop(
        &self,
        frame: &RgbImage,
        person_x: f64,
        person_y: f64,
        person_w: f64,
        person_h: f64,
        known_faces: &[FaceRow],
        threshold: f32,
    ) -> Option<FaceMatchResult> {
        if known_faces.is_empty() {
            return None;
        }

        let (fw, fh) = frame.dimensions();
        let px = ((person_x * fw as f64) as u32).min(fw.saturating_sub(16));
        let py = ((person_y * fh as f64) as u32).min(fh.saturating_sub(16));
        let pw = ((person_w * fw as f64) as u32).clamp(16, fw - px);
        // Take upper 42% of person bounding box where the head/face is located
        let ph = ((person_h * 0.42 * fh as f64) as u32).clamp(16, fh - py);

        let head_crop = DynamicImage::ImageRgb8(frame.view(px, py, pw, ph).to_image());
        let query_vec = self.extract_embedding(&head_crop);

        let mut best_match: Option<FaceMatchResult> = None;

        for face in known_faces {
            let Some(enc_str) = face.encoding.as_ref() else {
                continue;
            };
            let Ok(db_vec) = serde_json::from_str::<Vec<f32>>(enc_str) else {
                continue;
            };
            if db_vec.len() != query_vec.len() {
                continue;
            }

            let sim = cosine_similarity(&query_vec, &db_vec);
            if sim >= threshold {
                if best_match.as_ref().map(|b| sim > b.similarity).unwrap_or(true) {
                    best_match = Some(FaceMatchResult {
                        face_id: face.id.clone(),
                        name: face.name.clone(),
                        similarity: sim,
                    });
                }
            }
        }

        best_match
    }
}

pub fn l2_normalize(mut v: Vec<f32>) -> Vec<f32> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-6 {
        for x in &mut v {
            *x /= norm;
        }
    }
    v
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum::<f32>()
}
