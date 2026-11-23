use std::path::{Component, Path, PathBuf};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionZone {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub loitering_seconds: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TripwireLine {
    pub id: String,
    pub name: String,
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    /// "both" | "a_to_b" | "b_to_a"
    #[serde(default = "default_direction")]
    pub direction: String,
}

fn default_direction() -> String {
    "both".to_string()
}

/// Validate RTSP URL to prevent SSRF or go2rtc command injection (exec:, echo:, ffmpeg:, file:, etc.)
pub fn validate_rtsp_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() {
        return Err("RTSP URL không hợp lệ".to_string());
    }
    if trimmed.len() > 512 {
        return Err("RTSP URL quá dài".to_string());
    }
    if trimmed.chars().any(|c| c == '\r' || c == '\n' || c == '\t' || c == '\0') {
        return Err("RTSP URL chứa ký tự điều khiển không hợp lệ".to_string());
    }

    let parsed = Url::parse(trimmed).map_err(|_| {
        "Định dạng RTSP URL không hợp lệ (ví dụ: rtsp://user:pass@ip:554/stream)".to_string()
    })?;

    let scheme = parsed.scheme();
    if scheme != "rtsp" && scheme != "rtsps" {
        return Err("Chỉ cho phép giao thức rtsp:// hoặc rtsps://".to_string());
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| "RTSP URL thiếu địa chỉ IP hoặc hostname của camera".to_string())?;

    let host_lower = host.to_lowercase();
    let allow_local = std::env::var("ALLOW_LOCAL_RTSP").unwrap_or_default() == "true";
    if !allow_local
        && (host_lower == "localhost" || host_lower == "127.0.0.1" || host_lower == "::1")
    {
        return Err("Không cho phép trỏ RTSP URL vào địa chỉ loopback của chính máy chủ".to_string());
    }

    Ok(trimmed.to_string())
}

/// Mask password inside RTSP URL before returning to client UI
pub fn mask_rtsp_url(raw_url: &str) -> String {
    if raw_url.is_empty() {
        return String::new();
    }
    if let Ok(mut parsed) = Url::parse(raw_url) {
        if parsed.password().is_some() {
            let _ = parsed.set_password(Some("******"));
        }
        return parsed.to_string();
    }
    raw_url.to_string()
}

/// Validate and normalize detection zones (JSON array of {x, y, w, h, loitering_seconds} in [0, 1])
pub fn validate_detection_zone(input: &serde_json::Value) -> Result<String, String> {
    if input.is_null() {
        return Ok(String::new());
    }

    let zones: Vec<DetectionZone> = if let Some(s) = input.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        if trimmed.starts_with('[') {
            serde_json::from_str(trimmed)
                .map_err(|_| "Dữ liệu detection_zone không phải JSON hợp lệ".to_string())?
        } else {
            let parts: Vec<f64> = trimmed
                .split(',')
                .filter_map(|p| p.trim().parse::<f64>().ok())
                .collect();
            if parts.len() == 4 {
                vec![DetectionZone {
                    x: parts[0],
                    y: parts[1],
                    w: parts[2],
                    h: parts[3],
                    loitering_seconds: 0,
                }]
            } else {
                return Err("Định dạng vùng phát hiện không hợp lệ".to_string());
            }
        }
    } else if input.is_array() {
        serde_json::from_value(input.clone())
            .map_err(|_| "Tọa độ vùng phát hiện không hợp lệ".to_string())?
    } else {
        return Err("detection_zone phải là mảng các vùng".to_string());
    };

    if zones.len() > 12 {
        return Err("Tối đa 12 vùng phát hiện trên mỗi camera".to_string());
    }

    let mut sanitized = Vec::with_capacity(zones.len());
    for z in zones {
        if !z.x.is_finite() || !z.y.is_finite() || !z.w.is_finite() || !z.h.is_finite() {
            return Err("Tọa độ vùng phát hiện phải là số thực".to_string());
        }
        if z.x < 0.0 || z.y < 0.0 || z.w <= 0.0 || z.h <= 0.0 || z.x + z.w > 1.05 || z.y + z.h > 1.05
        {
            return Err("Tọa độ vùng phát hiện vượt ngoài phạm vi [0..1]".to_string());
        }
        sanitized.push(DetectionZone {
            x: (z.x.clamp(0.0, 1.0) * 10000.0).round() / 10000.0,
            y: (z.y.clamp(0.0, 1.0) * 10000.0).round() / 10000.0,
            w: (z.w.clamp(0.01, 1.0) * 10000.0).round() / 10000.0,
            h: (z.h.clamp(0.01, 1.0) * 10000.0).round() / 10000.0,
            loitering_seconds: z.loitering_seconds.min(600),
        });
    }

    if sanitized.is_empty() {
        Ok(String::new())
    } else {
        serde_json::to_string(&sanitized).map_err(|_| "Lỗi tuần tự hóa vùng phát hiện".to_string())
    }
}

/// Validate tripwire lines configuration
pub fn validate_tripwire_config(input: &serde_json::Value) -> Result<String, String> {
    if input.is_null() {
        return Ok(String::new());
    }

    let lines: Vec<TripwireLine> = if let Some(s) = input.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            return Ok(String::new());
        }
        serde_json::from_str(trimmed)
            .map_err(|_| "Cấu hình hàng rào ảo không phải JSON hợp lệ".to_string())?
    } else if input.is_array() {
        serde_json::from_value(input.clone())
            .map_err(|_| "Cấu hình hàng rào ảo không hợp lệ".to_string())?
    } else {
        return Err("tripwire_config phải là mảng".to_string());
    };

    if lines.len() > 10 {
        return Err("Tối đa 10 hàng rào ảo trên mỗi camera".to_string());
    }

    let mut sanitized = Vec::with_capacity(lines.len());
    for l in lines {
        if ![l.x1, l.y1, l.x2, l.y2].iter().all(|v| v.is_finite() && *v >= 0.0 && *v <= 1.0) {
            return Err("Tọa độ hàng rào ảo phải nằm trong [0..1]".to_string());
        }
        let dir = match l.direction.as_str() {
            "a_to_b" | "b_to_a" | "both" => l.direction,
            _ => "both".to_string(),
        };
        sanitized.push(TripwireLine {
            id: if l.id.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                l.id
            },
            name: if l.name.is_empty() {
                "Rào ảo".to_string()
            } else {
                l.name.chars().take(60).collect()
            },
            x1: (l.x1 * 10000.0).round() / 10000.0,
            y1: (l.y1 * 10000.0).round() / 10000.0,
            x2: (l.x2 * 10000.0).round() / 10000.0,
            y2: (l.y2 * 10000.0).round() / 10000.0,
            direction: dir,
        });
    }

    if sanitized.is_empty() {
        Ok(String::new())
    } else {
        serde_json::to_string(&sanitized).map_err(|_| "Lỗi lưu hàng rào ảo".to_string())
    }
}

/// Safely resolve a relative path inside a base directory and prevent Path Traversal (../)
pub fn resolve_safe_path(base_dir: &Path, relative_target: &str) -> Option<PathBuf> {
    if relative_target.is_empty() {
        return None;
    }
    let normalized_rel = relative_target.replace('\\', "/");
    let rel_path = Path::new(&normalized_rel);
    if rel_path.is_absolute() {
        return None;
    }

    for comp in rel_path.components() {
        match comp {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
            _ => {}
        }
    }

    Some(base_dir.join(rel_path))
}

/// Verify image magic bytes (JPEG, PNG, WebP) from slice
pub fn detect_image_type(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() < 12 {
        return None;
    }
    // JPEG: FF D8 FF
    if bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some(("image/jpeg", ".jpg"));
    }
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(("image/png", ".png"));
    }
    // WebP: RIFF....WEBP
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some(("image/webp", ".webp"));
    }
    None
}
