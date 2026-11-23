use std::collections::{HashMap, HashSet};
use std::env;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use rand::RngCore;
use scrypt::{scrypt, Params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::AppState;

type HmacSha256 = Hmac<Sha256>;

static JWT_SECRET: OnceLock<Vec<u8>> = OnceLock::new();

fn get_jwt_secret() -> &'static [u8] {
    JWT_SECRET.get_or_init(|| {
        let insecure: HashSet<&str> = HashSet::from([
            "smart_cctv_secure_signing_key_2026",
            "your_custom_jwt_signing_key_here",
            "your_random_secret_key",
            "replace_with_a_secure_random_64_char_hex_string_before_deploying",
        ]);
        let env_secret = env::var("JWT_SECRET").unwrap_or_default();
        if env_secret.len() >= 16 && !insecure.contains(env_secret.as_str()) {
            env_secret.into_bytes()
        } else {
            tracing::warn!(
                "[SECURITY WARNING] JWT_SECRET is missing or uses a default placeholder. Generated a random 256-bit secret for this process."
            );
            let mut random_key = vec![0u8; 32];
            rand::thread_rng().fill_bytes(&mut random_key);
            random_key
        }
    })
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut s, "{:02x}", b);
    }
    s
}

fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok())
        .collect()
}

/// Hash password using exact Node.js `crypto.scryptSync(password, saltHex, 64)` parameters (N=16384, r=8, p=1)
/// Format: `scrypt$<salt_hex>$<derived_64_byte_hex>`
pub fn hash_password(password: &str) -> String {
    let mut salt_bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt_bytes);
    let salt_hex = hex_encode(&salt_bytes);

    // Node.js scryptSync passes the salt string UTF-8 bytes directly when given a hex string
    let params = Params::new(14, 8, 1, 64).expect("Valid scrypt params");
    let mut output = [0u8; 64];
    scrypt(password.as_bytes(), salt_hex.as_bytes(), &params, &mut output)
        .expect("scrypt computation succeeded");

    format!("scrypt${}${}", salt_hex, hex_encode(&output))
}

/// Constant-time verification compatible with existing Node.js `scrypt$salt$keyHex` passwords in SQLite
pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    let parts: Vec<&str> = stored_hash.split('$').collect();
    if parts.len() != 3 || parts[0] != "scrypt" {
        return false;
    }
    let salt_str = parts[1];
    let Some(expected_bytes) = hex_decode(parts[2]) else {
        return false;
    };
    if expected_bytes.len() != 64 {
        return false;
    }

    let Ok(params) = Params::new(14, 8, 1, 64) else {
        return false;
    };
    let mut derived = [0u8; 64];
    if scrypt(password.as_bytes(), salt_str.as_bytes(), &params, &mut derived).is_err() {
        return false;
    }

    derived.ct_eq(&expected_bytes).into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtClaims {
    pub username: String,
    #[serde(default = "default_version")]
    pub v: i64,
    #[serde(default)]
    pub iat: u64,
    pub exp: u64,
}

fn default_version() -> i64 {
    1
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn generate_token(username: &str, token_version: i64, ttl_ms: u64) -> String {
    let header_b64 = URL_SAFE_NO_PAD.encode(r#"{"alg":"HS256","typ":"JWT"}"#);
    let now = now_ms();
    let claims = JwtClaims {
        username: username.to_string(),
        v: token_version,
        iat: now,
        exp: now + ttl_ms,
    };
    let payload_json = serde_json::to_string(&claims).unwrap_or_default();
    let payload_b64 = URL_SAFE_NO_PAD.encode(payload_json.as_bytes());

    let signing_input = format!("{}.{}", header_b64, payload_b64);
    let mut mac =
        HmacSha256::new_from_slice(get_jwt_secret()).expect("HMAC can take key of any size");
    mac.update(signing_input.as_bytes());
    let sig_bytes = mac.finalize().into_bytes();
    let sig_b64 = URL_SAFE_NO_PAD.encode(sig_bytes);

    format!("{}.{}", signing_input, sig_b64)
}

pub fn verify_token(token: &str) -> Option<JwtClaims> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return None;
    }
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    let mut mac = HmacSha256::new_from_slice(get_jwt_secret()).ok()?;
    mac.update(signing_input.as_bytes());
    let expected_sig = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    if parts[2].len() != expected_sig.len()
        || !bool::from(parts[2].as_bytes().ct_eq(expected_sig.as_bytes()))
    {
        return None;
    }

    let payload_bytes = URL_SAFE_NO_PAD.decode(parts[1]).ok()?;
    let claims: JwtClaims = serde_json::from_slice(&payload_bytes).ok()?;
    if claims.exp < now_ms() {
        return None;
    }
    Some(claims)
}

pub fn parse_cookies(headers: &HeaderMap) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(val) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) else {
        return map;
    };
    for pair in val.split(';') {
        if let Some(eq) = pair.find('=') {
            let k = pair[..eq].trim();
            let v = pair[eq + 1..].trim();
            if !k.is_empty() {
                let decoded = urlencoding::decode(v)
                    .map(|c| c.into_owned())
                    .unwrap_or_else(|_| v.to_string());
                map.insert(k.to_string(), decoded);
            }
        }
    }
    map
}

pub fn extract_token_from_request(headers: &HeaderMap, query_str: Option<&str>) -> Option<String> {
    if let Some(auth_val) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(stripped) = auth_val.strip_prefix("Bearer ") {
            let tok = stripped.trim();
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }

    let cookies = parse_cookies(headers);
    if let Some(cookie_tok) = cookies.get("smart_cctv_session") {
        if !cookie_tok.is_empty() {
            return Some(cookie_tok.clone());
        }
    }

    if let Some(q) = query_str {
        for pair in q.split('&') {
            if let Some(val) = pair.strip_prefix("token=") {
                if !val.is_empty() {
                    let decoded = urlencoding::decode(val)
                        .map(|c| c.into_owned())
                        .unwrap_or_else(|_| val.to_string());
                    return Some(decoded);
                }
            }
        }
    }
    None
}

pub fn build_session_cookie(headers: &HeaderMap, token: &str, max_age_sec: u64) -> String {
    let is_secure = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    let encoded = urlencoding::encode(token);
    let mut cookie = format!(
        "smart_cctv_session={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        encoded, max_age_sec
    );
    if is_secure {
        cookie.push_str("; Secure");
    }
    cookie
}

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub username: String,
}

/// Axum middleware enforcing authentication & auto-healing missing HttpOnly cookies
pub async fn auth_middleware(
    State(state): State<Arc<AppState>>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let query = req.uri().query();
    let Some(token) = extract_token_from_request(req.headers(), query) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Truy cập bị từ chối. Vui lòng đăng nhập." })),
        )
            .into_response();
    };

    let Some(claims) = verify_token(&token) else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Phiên đăng nhập không hợp lệ hoặc đã hết hạn." })),
        )
            .into_response();
    };

    let user_opt = state.db.get_user_by_username(&claims.username);
    let Some(user) = user_opt else {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Tài khoản không tồn tại." })),
        )
            .into_response();
    };

    if claims.v != 0 && claims.v != user.token_version {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Phiên đăng nhập đã hết hiệu lực. Vui lòng đăng nhập lại." })),
        )
            .into_response();
    }

    let has_cookie = parse_cookies(req.headers()).contains_key("smart_cctv_session");
    let cookie_header = if !has_cookie {
        let fresh = generate_token(&user.username, user.token_version, 24 * 3600 * 1000);
        Some(build_session_cookie(req.headers(), &fresh, 24 * 3600))
    } else {
        None
    };

    req.extensions_mut().insert(AuthUser {
        username: user.username,
    });

    let mut res = next.run(req).await;
    if let Some(cookie_str) = cookie_header {
        if let Ok(hv) = HeaderValue::from_str(&cookie_str) {
            res.headers_mut().insert(header::SET_COOKIE, hv);
        }
    }
    res
}

// ============================================
// In-Memory Login Brute-Force Rate Limiter
// ============================================
struct RateEntry {
    count: u32,
    reset_at: Instant,
}

#[derive(Default)]
pub struct LoginRateLimiter {
    entries: Mutex<HashMap<String, RateEntry>>,
}

impl LoginRateLimiter {
    pub fn check(&self, ip: &str) -> Result<(), u64> {
        let mut guard = self.entries.lock().unwrap();
        let now = Instant::now();
        if let Some(entry) = guard.get(ip) {
            if now > entry.reset_at {
                guard.remove(ip);
                return Ok(());
            }
            if entry.count >= 5 {
                let remaining = entry.reset_at.duration_since(now).as_secs().max(1);
                return Err(remaining);
            }
        }
        Ok(())
    }

    pub fn record_failure(&self, ip: &str) {
        let mut guard = self.entries.lock().unwrap();
        let now = Instant::now();
        let window = Duration::from_secs(15 * 60);
        match guard.get_mut(ip) {
            Some(entry) if now <= entry.reset_at => {
                entry.count += 1;
            }
            _ => {
                guard.insert(
                    ip.to_string(),
                    RateEntry {
                        count: 1,
                        reset_at: now + window,
                    },
                );
            }
        }
    }

    pub fn clear(&self, ip: &str) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.remove(ip);
        }
    }
}

pub fn extract_client_ip(headers: &HeaderMap, addr: Option<ConnectInfo<SocketAddr>>) -> String {
    if let Some(xff) = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
        if let Some(first) = xff.split(',').next() {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    if let Some(real_ip) = headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
        let trimmed = real_ip.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    addr.map(|a| a.0.ip().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}
