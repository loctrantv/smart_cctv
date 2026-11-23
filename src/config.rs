use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub project_root: PathBuf,
    pub host: String,
    pub port: u16,
    pub node_env: String,
    pub db_path: PathBuf,
    pub recordings_path: PathBuf,
    pub snapshots_path: PathBuf,
    pub models_path: PathBuf,
    pub web_dist_path: PathBuf,
    pub go2rtc_url: String,
    pub go2rtc_rtsp_url: String,
    pub allowed_origins: Vec<String>,
}

pub fn load_dotenv(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Ok(content) = fs::read_to_string(path) {
        for raw_line in content.lines() {
            let line = raw_line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(eq_idx) = line.find('=') {
                let key = line[..eq_idx].trim();
                let mut val = line[eq_idx + 1..].trim().to_string();
                if (val.starts_with('"') && val.ends_with('"'))
                    || (val.starts_with('\'') && val.ends_with('\''))
                {
                    val = val[1..val.len() - 1].to_string();
                }
                if env::var_os(key).is_none() {
                    env::set_var(key, val);
                }
            }
        }
    }
}

fn resolve_data_path(root: &Path, env_val: Option<String>, default_rel: &str) -> PathBuf {
    match env_val {
        Some(v) if !v.trim().is_empty() => {
            let trimmed = v.trim();
            if let Some(stripped) = trimmed.strip_prefix("/app/data") {
                let rel = stripped.trim_start_matches('/');
                return root.join("data").join(rel);
            }
            let p = PathBuf::from(trimmed);
            if p.is_absolute() {
                p
            } else {
                root.join(p)
            }
        }
        _ => root.join(default_rel),
    }
}

impl AppConfig {
    pub fn from_env() -> Self {
        let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let project_root = if cwd.ends_with("server") {
            cwd.parent().unwrap_or(&cwd).to_path_buf()
        } else {
            cwd
        };

        load_dotenv(&project_root.join(".env"));
        load_dotenv(&project_root.join("server").join(".env"));

        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(3001);
        let node_env = env::var("NODE_ENV").unwrap_or_else(|_| "production".to_string());

        let db_path = resolve_data_path(&project_root, env::var("DB_PATH").ok(), "data/smart_cctv.db");
        let recordings_path = resolve_data_path(
            &project_root,
            env::var("RECORDINGS_PATH").ok(),
            "data/recordings",
        );
        let snapshots_path = resolve_data_path(
            &project_root,
            env::var("SNAPSHOTS_PATH").ok(),
            "data/snapshots",
        );
        let models_path = resolve_data_path(&project_root, env::var("MODELS_PATH").ok(), "data/models");
        let web_dist_path = project_root.join("web").join("dist");

        let go2rtc_url = env::var("GO2RTC_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:1984".to_string())
            .trim_end_matches('/')
            .to_string();
        let go2rtc_rtsp_url = env::var("GO2RTC_RTSP_URL")
            .unwrap_or_else(|_| "rtsp://127.0.0.1:8554".to_string())
            .trim_end_matches('/')
            .to_string();

        let allowed_origins = env::var("ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::create_dir_all(&recordings_path);
        let _ = fs::create_dir_all(&snapshots_path);
        let _ = fs::create_dir_all(&models_path);

        Self {
            project_root,
            host,
            port,
            node_env,
            db_path,
            recordings_path,
            snapshots_path,
            models_path,
            web_dist_path,
            go2rtc_url,
            go2rtc_rtsp_url,
            allowed_origins,
        }
    }
}
