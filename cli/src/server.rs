//! Web アプリの配信と、WebSocket での変更のやりとり。
//!
//! クライアント → サーバー
//!   {"type":"hello","name":"表示名","client":"ブラウザごとの id"}
//!   {"type":"change","change":{変更セット}}
//! サーバー → クライアント
//!   {"type":"snapshot","rev":N,"comments":[...]}            接続直後の全体
//!   {"type":"change","rev":N,"author":"名前","change":{...}} 他の人の変更（適用できた op だけ）
//!   {"type":"ack","id":"変更セットid","rev":N,"dup":bool,"conflicts":[...],"fix":[{"id":..,"comment":..|null}]}
//!   {"type":"peers","names":[...]}                           参加者
//! 同じ変更セットを何度送っても1回だけ適用する（id で判定）ので、送り直しても安全。
//! hello の protocol が PROTOCOL と違えば {"type":"error","code":"protocol"} を返して切る。

use crate::store::{Change, Comment, Store};
use crate::workspace::{LogEntry, Workspace};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

/// やりとりの取り決めの版数（変えたら web.json と js/app.js の COLLAB_PROTOCOL も合わせる）
pub const PROTOCOL: u32 = 1;

#[derive(rust_embed::RustEmbed)]
#[folder = ".."]
#[include = "index.html"]
#[include = "css/*"]
#[include = "js/*"]
#[include = "lib/*"]
struct WebAssets;

pub struct Hub {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<(u64, Arc<str>)>,
    writer: std::sync::mpsc::Sender<Job>,
    token: Option<String>,
    web_dir: Option<PathBuf>,
    workspace_id: String,
    next_conn: AtomicU64,
    /// 終了するときに接続を閉じる合図
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

struct Inner {
    store: Store,
    rev: u64,
    seen: HashSet<String>,
    peers: HashMap<u64, String>,
}

/// 書き込み担当（ファイルと git は受け取った順に1件ずつ処理する）への依頼
pub struct Job {
    pub comments: Store,
    pub message: String,
    pub author: String,
    pub email: String,
    pub log: LogEntry,
}

pub fn spawn_writer(ws: Workspace) -> (std::sync::mpsc::Sender<Job>, std::thread::JoinHandle<()>) {
    let (tx, rx) = std::sync::mpsc::channel::<Job>();
    let handle = std::thread::spawn(move || {
        for job in rx {
            let id = job.log.change.id.clone();
            if let Err(e) = ws.save(
                &job.comments,
                &job.message,
                &job.author,
                &job.email,
                &[("Change-Id", &id)],
            ) {
                eprintln!("保存に失敗しました: {e:#}");
            }
            // 保存できたものだけ記録する（再起動後に同じ変更が届いたら、記録にあるものは適用済みとみなす）
            if let Err(e) = ws.append_log(&job.log) {
                eprintln!("記録に失敗しました: {e:#}");
            }
        }
    });
    (tx, handle)
}

impl Hub {
    pub fn new(
        store: Store,
        rev: u64,
        seen: HashSet<String>,
        writer: std::sync::mpsc::Sender<Job>,
        token: Option<String>,
        web_dir: Option<PathBuf>,
        workspace_id: String,
    ) -> Arc<Hub> {
        let (tx, _) = broadcast::channel(1024);
        Arc::new(Hub {
            inner: Mutex::new(Inner {
                store,
                rev,
                seen,
                peers: HashMap::new(),
            }),
            tx,
            writer,
            token,
            web_dir,
            workspace_id,
            next_conn: AtomicU64::new(1),
            shutdown: tokio::sync::watch::channel(false).0,
        })
    }
}

pub fn router(hub: Arc<Hub>) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route(
            "/api/info",
            get(|| async {
                axum::Json(json!({ "app": "komenagare", "version": env!("CARGO_PKG_VERSION") }))
            }),
        )
        .fallback(get(static_handler))
        .with_state(hub)
}

async fn static_handler(State(hub): State<Arc<Hub>>, uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.ends_with('/') {
        path.push_str("index.html");
    }
    if path.split('/').any(|p| p == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let data: Option<Vec<u8>> = match &hub.web_dir {
        Some(dir) => tokio::fs::read(dir.join(&path)).await.ok(),
        None => WebAssets::get(&path).map(|f| f.data.into_owned()),
    };
    let Some(mut data) = data else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path == "index.html" {
        // ホストから配信していることをページに知らせる（共同編集を有効にする）
        let html = String::from_utf8_lossy(&data).replacen(
            "</head>",
            &format!(
                "<meta name=\"komenagare-host\" content=\"{}\" data-workspace=\"{}\">\n</head>",
                env!("CARGO_PKG_VERSION"),
                hub.workspace_id
            ),
            1,
        );
        data = html.into_bytes();
    }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    (
        [
            (header::CONTENT_TYPE, mime.as_ref().to_string()),
            (header::CACHE_CONTROL, "no-cache".to_string()),
        ],
        data,
    )
        .into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    k: Option<String>,
}

async fn ws_handler(
    State(hub): State<Arc<Hub>>,
    Query(q): Query<WsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Some(token) = &hub.token {
        if q.k.as_deref() != Some(token.as_str()) {
            return (StatusCode::UNAUTHORIZED, "invalid key").into_response();
        }
    }
    ws.max_message_size(64 << 20)
        .on_upgrade(move |socket| connection(hub, socket))
}

async fn connection(hub: Arc<Hub>, socket: WebSocket) {
    let conn = hub.next_conn.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let mut rx = hub.tx.subscribe();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // 送信: 自分宛てのものと、他の人の変更（自分の分は除く）
    let send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(m) = out_rx.recv() => { if sink.send(Message::Text(m.into())).await.is_err() { break; } }
                r = rx.recv() => match r {
                    Ok((from, m)) => { if from != conn && sink.send(Message::Text(m.to_string().into())).await.is_err() { break; } }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // 取りこぼしたら接続を切る（クライアントは再接続して全体を取り直す）
                        break;
                    }
                    Err(_) => break,
                },
                else => break,
            }
        }
    });

    let mut name = String::from("名無し");
    let mut email = String::from("anonymous@komenagare");
    let mut shutdown = hub.shutdown.subscribe();
    loop {
        let msg = tokio::select! {
            m = stream.next() => match m { Some(Ok(m)) => m, _ => break },
            _ = shutdown.changed() => break,
        };
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        match v["type"].as_str() {
            Some("hello") => {
                if v["protocol"].as_u64() != Some(PROTOCOL as u64) {
                    let _ = out_tx.send(json!({ "type": "error", "code": "protocol",
                        "message": "このページはホストと版が合いません。ページを再読み込みしてください（直らなければ komenagare を更新してください）" }).to_string());
                    // 送り終えてから切る
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    break;
                }
                if let Some(n) = v["name"].as_str().map(str::trim).filter(|n| !n.is_empty()) {
                    name = n.chars().take(40).collect();
                }
                if let Some(c) = v["client"]
                    .as_str()
                    .filter(|c| c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))
                {
                    email = format!("{}@komenagare", c.chars().take(40).collect::<String>());
                }
                let mut inner = hub.inner.lock().await;
                inner.peers.insert(conn, name.clone());
                let comments: Vec<&Comment> = inner.store.sorted();
                let _ = out_tx.send(
                    json!({ "type": "snapshot", "rev": inner.rev, "comments": comments })
                        .to_string(),
                );
                broadcast_peers(&hub, &inner);
            }
            Some("change") => {
                let Ok(change) = serde_json::from_value::<Change>(v["change"].clone()) else {
                    let _ = out_tx.send(
                        json!({ "type": "error", "message": "変更セットの形式が正しくありません" })
                            .to_string(),
                    );
                    continue;
                };
                let reply = apply_change(&hub, conn, &name, &email, change).await;
                let _ = out_tx.send(reply);
            }
            _ => {}
        }
    }
    send_task.abort();
    let inner = &mut *hub.inner.lock().await;
    inner.peers.remove(&conn);
    broadcast_peers(&hub, inner);
}

async fn apply_change(hub: &Hub, conn: u64, name: &str, email: &str, change: Change) -> String {
    let mut inner = hub.inner.lock().await;
    if inner.seen.contains(&change.id) {
        return json!({ "type": "ack", "id": change.id, "rev": inner.rev, "dup": true, "conflicts": [], "fix": [] }).to_string();
    }
    let r = inner.store.apply(&change, false);
    inner.seen.insert(change.id.clone());
    // 衝突したコメントは、こちらの今の内容を返す（クライアントはそれに合わせる）
    let ids: HashSet<&str> = r.conflicts.iter().map(|c| c.id.as_str()).collect();
    let fix: Vec<Value> = ids
        .iter()
        .map(|id| json!({ "id": id, "comment": inner.store.get(id) }))
        .collect();
    if let Some(applied) = &r.applied {
        inner.rev += 1;
        let rev = inner.rev;
        let (mut add, mut upd, mut del) = (0, 0, 0);
        for op in &applied.ops {
            match op {
                crate::store::Op::Add { .. } => add += 1,
                crate::store::Op::Update { .. } => upd += 1,
                crate::store::Op::Delete { .. } => del += 1,
            }
        }
        let summary = [("追加", add), ("変更", upd), ("削除", del)]
            .iter()
            .filter(|(_, n)| *n > 0)
            .map(|(k, n)| format!("{k} {n}"))
            .collect::<Vec<_>>()
            .join("・");
        let job = Job {
            comments: Store::new(inner.store.sorted().into_iter().cloned().collect()),
            message: format!("{name}: {summary}"),
            author: name.to_string(),
            email: email.to_string(),
            log: LogEntry {
                rev,
                time: now_ms(),
                author: name.to_string(),
                change: applied.clone(),
            },
        };
        let _ = hub.writer.send(job);
        let msg =
            json!({ "type": "change", "rev": rev, "author": name, "change": applied }).to_string();
        let _ = hub.tx.send((conn, msg.into()));
    }
    json!({ "type": "ack", "id": change.id, "rev": inner.rev, "dup": false, "conflicts": r.conflicts, "fix": fix }).to_string()
}

fn broadcast_peers(hub: &Hub, inner: &Inner) {
    let mut names: Vec<&String> = inner.peers.values().collect();
    names.sort();
    let _ = hub.tx.send((
        0,
        json!({ "type": "peers", "names": names })
            .to_string()
            .into(),
    ));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
