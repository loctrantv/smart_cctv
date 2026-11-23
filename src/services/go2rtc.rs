use std::time::Duration;
use serde_json::{json, Value};

#[derive(Clone)]
pub struct Go2RtcClient {
    base_url: String,
    http: reqwest::Client,
}

impl Go2RtcClient {
    pub fn new(base_url: &str) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .pool_max_idle_per_host(16)
            .build()
            .unwrap_or_default();

        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http,
        }
    }

    fn url(&self, api_path: &str) -> String {
        if api_path.starts_with('/') {
            format!("{}{}", self.base_url, api_path)
        } else {
            format!("{}/{}", self.base_url, api_path)
        }
    }

    pub async fn add_stream(&self, stream_id: &str, rtsp_url: &str) -> bool {
        let path = format!(
            "/api/streams?name={}&src={}",
            urlencoding::encode(stream_id),
            urlencoding::encode(rtsp_url)
        );
        match self.http.put(self.url(&path)).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("[go2rtc] Registered stream: {}", stream_id);
                true
            }
            Ok(resp) => {
                tracing::warn!(
                    "[go2rtc] Failed to add stream {}: HTTP {}",
                    stream_id,
                    resp.status()
                );
                false
            }
            Err(e) => {
                tracing::warn!("[go2rtc] Error adding stream {}: {}", stream_id, e);
                false
            }
        }
    }

    pub async fn remove_stream(&self, stream_id: &str) -> bool {
        let path = format!("/api/streams?name={}", urlencoding::encode(stream_id));
        match self.http.delete(self.url(&path)).send().await {
            Ok(resp) if resp.status().is_success() => {
                tracing::info!("[go2rtc] Removed stream: {}", stream_id);
                true
            }
            _ => false,
        }
    }

    pub async fn exchange_webrtc_offer(
        &self,
        stream_id: &str,
        sdp_offer: String,
    ) -> Result<String, String> {
        let path = format!("/api/webrtc?src={}", urlencoding::encode(stream_id));
        let resp = self
            .http
            .post(self.url(&path))
            .header("Content-Type", "application/sdp")
            .body(sdp_offer)
            .send()
            .await
            .map_err(|e| format!("go2rtc WebRTC request failed: {}", e))?;

        if !resp.status().is_success() {
            return Err(format!("go2rtc WebRTC status {}", resp.status()));
        }

        resp.text()
            .await
            .map_err(|e| format!("Failed reading SDP answer: {}", e))
    }

    pub async fn fetch_raw(&self, api_path: &str) -> Result<(u16, String, Vec<u8>), String> {
        let resp = self
            .http
            .get(self.url(api_path))
            .send()
            .await
            .map_err(|e| format!("go2rtc upstream error: {}", e))?;

        let status = resp.status().as_u16();
        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();

        let bytes = resp
            .bytes()
            .await
            .map_err(|e| format!("Failed reading upstream body: {}", e))?
            .to_vec();

        Ok((status, content_type, bytes))
    }

    /// Fetch a JPEG snapshot directly into RAM (Zero disk I/O!)
    pub async fn fetch_jpeg_frame(&self, stream_id: &str) -> Option<Vec<u8>> {
        let path = format!("/api/frame.jpeg?src={}", urlencoding::encode(stream_id));
        let (status, _, bytes) = self.fetch_raw(&path).await.ok()?;
        if status == 200 && bytes.len() > 1000 {
            Some(bytes)
        } else {
            None
        }
    }

    pub fn client_stream_urls(&self, camera_id: &str) -> Value {
        let id = urlencoding::encode(camera_id);
        json!({
            "webrtc": format!("/api/cameras/{}/webrtc", id),
            "hls": format!("/api/cameras/{}/hls/stream.m3u8", id),
            "snapshot": format!("/api/cameras/{}/snapshot", id)
        })
    }
}
