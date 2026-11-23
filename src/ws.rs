use std::sync::Arc;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Request, State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use crate::{
    auth::{extract_token_from_request, now_ms, verify_token},
    AppState,
};

#[derive(Clone)]
pub struct WsHub {
    tx: broadcast::Sender<String>,
}

impl WsHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self { tx }
    }

    pub fn broadcast(&self, payload: Value) {
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = self.tx.send(text);
        }
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
