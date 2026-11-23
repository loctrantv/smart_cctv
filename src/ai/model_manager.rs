use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelSpec {
    pub id: String,
    pub name: String,
    pub category: String,
    pub filename: String,
    pub download_url: String,
    pub size_mb: f64,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiModelStatus {
    pub id: String,
    pub name: String,
    pub category: String,
    pub filename: String,
    pub size_mb: f64,
    pub description: String,
    pub installed: bool,
    pub loaded: bool,
    pub downloading: bool,
    pub file_size_bytes: u64,
}

pub fn builtin_model_specs() -> Vec<AiModelSpec> {
    vec![
        AiModelSpec {
            id: "yolov8n".to_string(),
            name: "YOLOv8n Object Detector (Người / Xe / Động vật)".to_string(),
            category: "object".to_string(),
            filename: "yolov8n.onnx".to_string(),
            download_url: "https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx"
                .to_string(),
            size_mb: 12.3,
            description: "Phát hiện Người (person), Xe máy, Ô tô, Xe tải, Chó/Mèo trên cả 2 mắt camera (640x640)".to_string(),
        },
        AiModelSpec {
            id: "yunet_face".to_string(),
            name: "YuNet Face & 5-Landmark Detector".to_string(),
            category: "face_det".to_string(),
            filename: "face_detection_yunet_2023mar.onnx".to_string(),
            download_url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx".to_string(),
            size_mb: 0.23,
            description: "Phát hiện khuôn mặt tốc độ cực nhanh kèm 5 điểm mốc mắt-mũi-miệng".to_string(),
        },
        AiModelSpec {
            id: "arcface_mbf".to_string(),
            name: "ArcFace MobileFaceNet (512-D Face Embedding)".to_string(),
            category: "face_rec".to_string(),
            filename: "face_recognition_sface_2021dec.onnx".to_string(),
            download_url: "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx".to_string(),
            size_mb: 36.9,
            description: "Trích xuất Vector đặc trưng khuôn mặt để so khớp Cosine Similarity < 0.1ms".to_string(),
        },
        AiModelSpec {
            id: "alpr_plate".to_string(),
            name: "YOLO Vietnam License Plate & OCR".to_string(),
            category: "alpr".to_string(),
            filename: "license_plate_detector.onnx".to_string(),
            download_url: "https://huggingface.co/yasirfaizahmed/license-plate-object-detection/resolve/main/best.onnx".to_string(),
            size_mb: 11.8,
            description: "Phát hiện & đọc ký tự biển số xe Việt Nam (1 dòng & 2 dòng)".to_string(),
        },
        AiModelSpec {
            id: "yamnet_audio".to_string(),
            name: "YAMNet Smart Audio Classifier".to_string(),
            category: "audio".to_string(),
            filename: "yamnet.onnx".to_string(),
            download_url: "https://huggingface.co/qualcomm/YAMNet/resolve/main/YAMNet.onnx".to_string(),
            size_mb: 14.5,
            description: "Phân biệt Tiếng kính vỡ, Tiếng la hét, Trẻ em khóc, Chó sủa, Còi báo động".to_string(),
        },
    ]
}

#[derive(Clone)]
pub struct ModelManager {
    models_dir: PathBuf,
    specs: Vec<AiModelSpec>,
    downloading: Arc<RwLock<HashMap<String, bool>>>,
    loaded: Arc<RwLock<HashMap<String, bool>>>,
    http_client: reqwest::Client,
}

impl ModelManager {
    pub fn new(models_dir: &Path) -> Self {
        let _ = fs::create_dir_all(models_dir);
        let specs = builtin_model_specs();
        let mut loaded_map = HashMap::new();
        for spec in &specs {
            let path = models_dir.join(&spec.filename);
            if path.exists() && path.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
                loaded_map.insert(spec.id.clone(), true);
            }
        }

        let http_client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .user_agent("SmartCCTV-Rust-NVR/2.0")
            .build()
            .unwrap_or_default();

        Self {
            models_dir: models_dir.to_path_buf(),
            specs,
            downloading: Arc::new(RwLock::new(HashMap::new())),
            loaded: Arc::new(RwLock::new(loaded_map)),
            http_client,
        }
    }

    pub fn model_path(&self, model_id: &str) -> Option<PathBuf> {
        let spec = self.specs.iter().find(|s| s.id == model_id)?;
        let p = self.models_dir.join(&spec.filename);
        if p.exists() && p.metadata().map(|m| m.len() > 1024).unwrap_or(false) {
            Some(p)
        } else {
            None
        }
    }

    pub fn is_model_ready(&self, model_id: &str) -> bool {
        self.model_path(model_id).is_some()
    }

    pub fn mark_loaded(&self, model_id: &str, state: bool) {
        if let Ok(mut guard) = self.loaded.write() {
            guard.insert(model_id.to_string(), state);
        }
    }

    pub fn list_status(&self) -> Vec<AiModelStatus> {
        let dl_guard = self.downloading.read().unwrap();
        let ld_guard = self.loaded.read().unwrap();

        self.specs
            .iter()
            .map(|spec| {
                let path = self.models_dir.join(&spec.filename);
                let meta = path.metadata().ok();
                let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let installed = size_bytes > 1024;
                let downloading = *dl_guard.get(&spec.id).unwrap_or(&false);
                let loaded = installed && *ld_guard.get(&spec.id).unwrap_or(&installed);

                AiModelStatus {
                    id: spec.id.clone(),
                    name: spec.name.clone(),
                    category: spec.category.clone(),
                    filename: spec.filename.clone(),
                    size_mb: spec.size_mb,
                    description: spec.description.clone(),
                    installed,
                    loaded,
                    downloading,
                    file_size_bytes: size_bytes,
                }
            })
            .collect()
    }

    pub async fn download_model(&self, model_id: &str) -> Result<PathBuf, String> {
        let spec = self
            .specs
            .iter()
            .find(|s| s.id == model_id)
            .cloned()
            .ok_or_else(|| format!("Không tìm thấy cấu hình model '{}'", model_id))?;

        {
            let mut dl = self.downloading.write().unwrap();
            if *dl.get(model_id).unwrap_or(&false) {
                return Err("Model này đang được tải xuống".to_string());
            }
            dl.insert(model_id.to_string(), true);
        }

        let target_path = self.models_dir.join(&spec.filename);
        let temp_path = self.models_dir.join(format!("{}.part", spec.filename));

        let res = async {
            tracing::info!("[AI Model] Downloading {} from {}", spec.name, spec.download_url);
            let resp = self
                .http_client
                .get(&spec.download_url)
                .send()
                .await
                .map_err(|e| format!("Lỗi kết nối tải model: {}", e))?;

            if !resp.status().is_success() {
                return Err(format!("Máy chủ tải model trả về HTTP {}", resp.status()));
            }

            let bytes = resp
                .bytes()
                .await
                .map_err(|e| format!("Lỗi đọc dữ liệu model: {}", e))?;

            if bytes.len() < 1024 {
                return Err("File model tải về không hợp lệ (quá nhỏ)".to_string());
            }

            fs::write(&temp_path, &bytes)
                .map_err(|e| format!("Không thể ghi file model xuống đĩa: {}", e))?;
            fs::rename(&temp_path, &target_path)
                .map_err(|e| format!("Không thể hoàn tất lưu file model: {}", e))?;

            self.mark_loaded(model_id, true);
            tracing::info!(
                "[AI Model] Successfully installed {} ({:.2} MB)",
                spec.filename,
                bytes.len() as f64 / (1024.0 * 1024.0)
            );
            Ok(target_path)
        }
        .await;

        {
            let mut dl = self.downloading.write().unwrap();
            dl.insert(model_id.to_string(), false);
        }

        res
    }
}
