use std::collections::VecDeque;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    response::IntoResponse,
};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::{
    auth::{extract_token_from_request, now_ms, verify_token},
    AppState,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemLogEntry {
    pub id: u64,
    pub timestamp: String,
    /// "INFO" | "WARN" | "ERROR" | "EVENT"
    pub level: String,
    /// "AI" | "YOLO" | "FACE" | "TEST" | "STREAM" | "SYSTEM"
    pub module: String,
    pub message: String,
}

#[derive(Clone)]
pub struct WsHub {
    tx: broadcast::Sender<String>,
    logs: Arc<Mutex<VecDeque<SystemLogEntry>>>,
    next_log_id: Arc<AtomicU64>,
}

impl WsHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self {
            tx,
            logs: Arc::new(Mutex::new(VecDeque::with_capacity(320))),
            next_log_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub fn broadcast(&self, payload: Value) {
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = self.tx.send(text);
        }
    }

    pub fn push_log(&self, level: &str, module: &str, message: impl Into<String>) {
        let msg = message.into();
        match level {
            "ERROR" => tracing::error!("[{}] {}", module, msg),
            "WARN" => tracing::warn!("[{}] {}", module, msg),
            _ => tracing::info!("[{}] {}", module, msg),
        }

        let entry = SystemLogEntry {
            id: self.next_log_id.fetch_add(1, Ordering::Relaxed),
            timestamp: Utc::now().to_rfc3339(),
            level: level.to_string(),
            module: module.to_string(),
            message: msg,
        };

        {
            let mut guard = self.logs.lock().unwrap_or_else(|e| e.into_inner());
            if guard.len() >= 300 {
                guard.pop_front();
            }
            guard.push_back(entry.clone());
        }

        self.broadcast(json!({
            "type": "system_log",
            "log": entry
        }));
    }

    pub fn recent_logs(&self, limit: usize) -> Vec<SystemLogEntry> {
        let guard = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        let len = guard.len();
        let skip = len.saturating_sub(limit);
        guard.iter().skip(skip).cloned().collect()
    }

    pub fn clear_logs(&self) {
        let mut guard = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        guard.clear();
    }

    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.tx.subscribe()
    }
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    req: Request,
) -> impl IntoResponse {
    let query = req.uri().query();
    let token_opt = extract_token_from_request(req.headers(), query);

    let authorized = token_opt
        .and_then(|t| verify_token(&t))
        .and_then(|claims| {
            let user = state.db.get_user_by_username(&claims.username)?;
            if claims.v != 0 && claims.v != user.token_version {
                None
            } else {
                Some(user)
            }
        })
        .is_some();

    ws.on_upgrade(move |socket| handle_socket(socket, state, authorized))
}

async fn handle_socket(mut socket: WebSocket, state: Arc<AppState>, authorized: bool) {
    if !authorized {
        let _ = socket.send(Message::Close(None)).await;
        return;
    }

    let welcome = json!({
        "type": "connected",
        "timestamp": now_ms(),
        "engine": "rust-ai-nvr"
    });
    if let Ok(txt) = serde_json::to_string(&welcome) {
        let _ = socket.send(Message::Text(txt)).await;
    }

    let mut rx = state.ws_hub.subscribe();
    let (mut sender, mut receiver) = socket.split();

    let send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if sender.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
    });

    let recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
    }
}
