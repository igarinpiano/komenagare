// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! Web アプリの配信と、WebSocket での変更のやりとり。
//!
//! 1つのホストで複数のプロジェクト（作業フォルダ）を共有できる。プロジェクトは /ws?p=<id> で選ぶ
//! （プロジェクトが1つなら省略できる）。プロジェクトごとに参加者・変更・衝突は別々。
//!
//! 入り方（どれか1つ）
//!   合言葉: URL の k=（/ws?k=…、/api/…?k=…）
//!   ワンタイムパスワード（--otp）: POST /api/login でセッションの鍵をもらい、hello の session と
//!     /api/… の Authorization: Bearer に付ける（auth.rs）
//!   なし（--no-token）
//!
//! HTTP
//!   GET  /api/info                       {"app":"komenagare","version"}（だれでも）
//!   GET  /api/projects                   {"auth","me":{name,admin}|null,"projects":[{"id","name","peers":[名前]}]}
//!   POST /api/login {"code"}             {"token","name","admin"}（--otp のとき）
//!   GET  /api/me / POST /api/logout      セッションの確認・ログアウト
//!   GET  /api/admin/auth                 {"sessions":[...],"otps":[...]}（管理者のみ）
//!   POST /api/admin/otp {"name","kind":"numeric"|"random","ttl"(秒),"admin"} {"code","expires"}
//!   POST /api/admin/revoke {"id"}        セッションかワンタイムパスワードを取り消す（つながっていれば切る）
//!
//! WebSocket: クライアント → サーバー（hello を最初に送る。それまでほかは受け付けない）
//!   {"type":"hello","protocol":4,"name":"表示名","client":"ブラウザごとの id","session":"…"(--otp のとき)}
//!   {"type":"change","change":{変更セット}}
//!   {"type":"history","limit":N}                             最近の変更を求める
//!   {"type":"presence","state":{...}}                        自分の再生位置・選択・カーソルなど（ほかの人に配るだけ）
//!   {"type":"conflict_add","conflicts":[{"key":..,...}]}     「あとで」にした衝突を全員に見せる
//!   {"type":"conflict_done","keys":[...]}                    衝突を解決した（一覧から外す）
//! サーバー → クライアント
//!   {"type":"snapshot","rev":N,"you":接続id,"name":"名前","comments":[...]} 接続直後の全体（name はホストが使う名前）
//!   {"type":"presence","id":接続id,"state":{...}}            ほかの人の状態（接続直後は今いる全員の分）
//!   {"type":"conflicts","list":[{"key",..,"author","client"}]} 保留中の衝突（変わるたびに全体）
//!   {"type":"change","rev":N,"time":ms,"author":"名前","change":{...}} 他の人の変更（適用できた op だけ）
//!   {"type":"history","entries":[{"rev","time","author","change"},...]} 最近の変更（新しい順）
//!   {"type":"ack","id":"変更セットid","rev":N,"dup":bool,"conflicts":[...],"fix":[{"id":..,"comment":..|null}]}
//!   {"type":"peers","names":[...],"peers":[{"id","name","client","color"}]} 参加者（color は色の番号。今いる人の中で空いている一番小さい番号）
//!   {"type":"error","code":"protocol"|"auth"|"project","message":…} code があるものは送ったあと切る
//! 同じ変更セットを何度送っても1回だけ適用する（id で判定）ので、送り直しても安全。

use crate::auth::{self, Auth, Kind, SessionRec};
use crate::store::{Change, Comment, Store};
use crate::workspace::{LogEntry, Workspace};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};

/// やりとりの取り決めの版数（変えたら web.json と js/app.js の COLLAB_PROTOCOL も合わせる）
pub const PROTOCOL: u32 = 4;

#[derive(rust_embed::RustEmbed)]
#[folder = ".."]
#[include = "index.html"]
#[include = "css/*"]
#[include = "js/*"]
#[include = "lib/*"]
struct WebAssets;

/// 入り方
pub enum Access {
    None,
    Token(String),
    Otp(Auth),
}

impl Access {
    fn label(&self) -> &'static str {
        match self {
            Access::None => "none",
            Access::Token(_) => "token",
            Access::Otp(_) => "otp",
        }
    }
}

pub struct Project {
    pub id: String,
    pub name: String,
    pub hub: Arc<Hub>,
}

pub struct Server {
    pub projects: Vec<Project>,
    pub access: Access,
    web_dir: Option<PathBuf>,
    /// 外から入るときの URL（--tunnel / --public-url。招待のリンクに使う）
    public_url: std::sync::RwLock<Option<String>>,
    next_conn: AtomicU64,
    /// 終了するときに接続を閉じる合図
    pub shutdown: tokio::sync::watch::Sender<bool>,
    /// 取り消したセッション（つながっている接続を切る）
    revoked: broadcast::Sender<String>,
    /// ログインに失敗した時刻（当てずっぽうを防ぐ）
    login_fails: std::sync::Mutex<VecDeque<Instant>>,
}

/// この時間のうちに LOGIN_FAILS_MAX 回失敗したら、しばらくログインを受け付けない
const LOGIN_FAIL_WINDOW: Duration = Duration::from_secs(10 * 60);
const LOGIN_FAILS_MAX: usize = 30;
/// 取り消されていないかを確かめる間隔（komenagare otp revoke で消されたときのため）
const SESSION_CHECK: Duration = Duration::from_secs(15);

impl Server {
    pub fn new(projects: Vec<Project>, access: Access, web_dir: Option<PathBuf>) -> Arc<Server> {
        Arc::new(Server {
            projects,
            access,
            web_dir,
            public_url: std::sync::RwLock::new(None),
            next_conn: AtomicU64::new(1),
            shutdown: tokio::sync::watch::channel(false).0,
            revoked: broadcast::channel(64).0,
            login_fails: std::sync::Mutex::new(VecDeque::new()),
        })
    }

    pub fn set_public_url(&self, url: Option<String>) {
        *self.public_url.write().unwrap() = url;
    }

    fn project(&self, id: Option<&str>) -> Option<&Project> {
        match id.filter(|s| !s.is_empty()) {
            Some(id) => self.projects.iter().find(|p| p.id == id),
            None if self.projects.len() == 1 => self.projects.first(),
            None => None,
        }
    }

    fn auth(&self) -> Option<&Auth> {
        match &self.access {
            Access::Otp(a) => Some(a),
            _ => None,
        }
    }
}

pub struct Hub {
    inner: Mutex<Inner>,
    tx: broadcast::Sender<(u64, Arc<str>)>,
    writer: std::sync::mpsc::Sender<Job>,
    conflicts_file: PathBuf,
}

struct Inner {
    store: Store,
    rev: u64,
    seen: HashSet<String>,
    peers: HashMap<u64, Peer>,
    /// 最近の変更（古い順。変更履歴の表示用）
    history: VecDeque<LogEntry>,
    /// 「あとで」にした衝突（全員に見せる）
    conflicts: Vec<Value>,
}

struct Peer {
    name: String,
    client: String,
    color: u32,
    /// 最後に届いた状態（後から入った人に渡す）
    presence: Option<Value>,
}

/// 保留中の衝突として覚えておく件数の上限
const CONFLICTS_KEEP: usize = 500;
/// presence 1件の大きさの上限（バイト）
const PRESENCE_MAX: usize = 16 * 1024;

/// 変更履歴として覚えておく件数
pub const HISTORY_KEEP: usize = 1000;

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
        history: VecDeque<LogEntry>,
        writer: std::sync::mpsc::Sender<Job>,
        conflicts: Vec<Value>,
        conflicts_file: PathBuf,
    ) -> Arc<Hub> {
        let (tx, _) = broadcast::channel(1024);
        Arc::new(Hub {
            inner: Mutex::new(Inner {
                store,
                rev,
                seen,
                peers: HashMap::new(),
                history,
                conflicts,
            }),
            tx,
            writer,
            conflicts_file,
        })
    }

    async fn peer_names(&self) -> Vec<String> {
        let inner = self.inner.lock().await;
        let mut names: Vec<String> = inner.peers.values().map(|p| p.name.clone()).collect();
        names.sort();
        names
    }
}

pub fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route(
            "/api/info",
            get(|| async {
                Json(json!({ "app": "komenagare", "version": env!("CARGO_PKG_VERSION") }))
            }),
        )
        .route("/api/projects", get(projects_handler))
        .route("/api/login", post(login_handler))
        .route("/api/me", get(me_handler))
        .route("/api/logout", post(logout_handler))
        .route("/api/admin/auth", get(admin_list_handler))
        .route("/api/admin/otp", post(admin_otp_handler))
        .route("/api/admin/revoke", post(admin_revoke_handler))
        .fallback(get(static_handler))
        .with_state(server)
}

async fn static_handler(State(server): State<Arc<Server>>, uri: Uri) -> Response {
    let mut path = uri.path().trim_start_matches('/').to_string();
    if path.is_empty() || path.ends_with('/') {
        path.push_str("index.html");
    }
    if path.split('/').any(|p| p == "..") {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let data: Option<Vec<u8>> = match &server.web_dir {
        Some(dir) => tokio::fs::read(dir.join(&path)).await.ok(),
        None => WebAssets::get(&path).map(|f| f.data.into_owned()),
    };
    let Some(mut data) = data else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path == "index.html" {
        // ホストから配信していることをページに知らせる（共同編集を有効にする）。公開 URL は招待のリンクに使う
        let public = server
            .public_url
            .read()
            .unwrap()
            .as_deref()
            .map(|u| format!(" data-public-url=\"{}\"", html_attr(u)))
            .unwrap_or_default();
        let html = String::from_utf8_lossy(&data).replacen(
            "</head>",
            &format!(
                "<meta name=\"komenagare-host\" content=\"{}\" data-auth=\"{}\"{public}>\n</head>",
                env!("CARGO_PKG_VERSION"),
                server.access.label()
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
struct KeyQuery {
    k: Option<String>,
    p: Option<String>,
}

fn html_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn api_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "message": message }))).into_response()
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}

/// /api/… を使ってよいか。--otp のときはセッションを返す
#[allow(clippy::result_large_err)]
fn authorize(
    server: &Server,
    headers: &HeaderMap,
    k: Option<&str>,
) -> Result<Option<SessionRec>, Response> {
    match &server.access {
        Access::None => Ok(None),
        Access::Token(t) if k == Some(t.as_str()) => Ok(None),
        Access::Token(_) => Err(api_error(
            StatusCode::UNAUTHORIZED,
            "合言葉（URL の k=）が違います",
        )),
        Access::Otp(a) => match bearer(headers).and_then(|t| a.verify(t)) {
            Some(s) => Ok(Some(s)),
            None => Err(api_error(StatusCode::UNAUTHORIZED, "ログインしてください")),
        },
    }
}

#[allow(clippy::result_large_err)]
fn authorize_admin<'a>(
    server: &'a Server,
    headers: &HeaderMap,
) -> Result<(&'a Auth, SessionRec), Response> {
    let Some(a) = server.auth() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "ワンタイムパスワードを使っていません（--otp で起動してください）",
        ));
    };
    match bearer(headers).and_then(|t| a.verify(t)) {
        Some(s) if s.admin => Ok((a, s)),
        Some(_) => Err(api_error(StatusCode::FORBIDDEN, "管理者だけが使えます")),
        None => Err(api_error(StatusCode::UNAUTHORIZED, "ログインしてください")),
    }
}

async fn projects_handler(
    State(server): State<Arc<Server>>,
    Query(q): Query<KeyQuery>,
    headers: HeaderMap,
) -> Response {
    let me = match authorize(&server, &headers, q.k.as_deref()) {
        Ok(me) => me,
        Err(r) => return r,
    };
    let mut projects = vec![];
    for p in &server.projects {
        projects.push(json!({ "id": p.id, "name": p.name, "peers": p.hub.peer_names().await }));
    }
    Json(json!({
        "auth": server.access.label(),
        "me": me.map(|s| json!({ "name": s.name, "admin": s.admin })),
        "projects": projects,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LoginBody {
    code: String,
}

async fn login_handler(State(server): State<Arc<Server>>, Json(body): Json<LoginBody>) -> Response {
    let Some(a) = server.auth() else {
        return api_error(
            StatusCode::NOT_FOUND,
            "ワンタイムパスワードを使っていません",
        );
    };
    {
        let mut fails = server.login_fails.lock().unwrap();
        while fails
            .front()
            .is_some_and(|t| t.elapsed() > LOGIN_FAIL_WINDOW)
        {
            fails.pop_front();
        }
        if fails.len() >= LOGIN_FAILS_MAX {
            return api_error(
                StatusCode::TOO_MANY_REQUESTS,
                "間違いが多いため、しばらくログインできません。10 分ほど待ってからやり直してください",
            );
        }
    }
    match a.login(&body.code) {
        Ok(Some((token, s))) => {
            Json(json!({ "token": token, "name": s.name, "admin": s.admin })).into_response()
        }
        Ok(None) => {
            server.login_fails.lock().unwrap().push_back(Instant::now());
            // 続けざまに試せないよう少し待たせる
            tokio::time::sleep(Duration::from_millis(400)).await;
            api_error(
                StatusCode::UNAUTHORIZED,
                "ワンタイムパスワードが違うか、使用済み・期限切れです",
            )
        }
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("{e:#}")),
    }
}

async fn me_handler(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    match server
        .auth()
        .zip(bearer(&headers))
        .and_then(|(a, t)| a.verify(t))
    {
        Some(s) => Json(json!({ "name": s.name, "admin": s.admin })).into_response(),
        None => api_error(StatusCode::UNAUTHORIZED, "ログインしてください"),
    }
}

async fn logout_handler(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    if let Some((a, s)) = server
        .auth()
        .zip(bearer(&headers))
        .and_then(|(a, t)| a.verify(t).map(|s| (a, s)))
    {
        a.revoke(&s.id);
        let _ = server.revoked.send(s.id);
    }
    Json(json!({})).into_response()
}

async fn admin_list_handler(State(server): State<Arc<Server>>, headers: HeaderMap) -> Response {
    let (a, me) = match authorize_admin(&server, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let sessions: Vec<Value> = a
        .sessions()
        .into_iter()
        .map(|s| json!({ "id": s.id, "name": s.name, "admin": s.admin, "created": s.created, "you": s.id == me.id }))
        .collect();
    let otps: Vec<Value> = a
        .otps()
        .into_iter()
        .filter(|o| !o.startup)
        .map(|o| json!({ "id": o.id, "name": o.name, "admin": o.admin, "kind": o.kind, "created": o.created, "expires": o.expires }))
        .collect();
    Json(json!({ "sessions": sessions, "otps": otps })).into_response()
}

#[derive(Deserialize)]
struct OtpBody {
    name: String,
    kind: String,
    ttl: Option<u64>,
    #[serde(default)]
    admin: bool,
}

async fn admin_otp_handler(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(body): Json<OtpBody>,
) -> Response {
    let (a, _) = match authorize_admin(&server, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(kind) = Kind::parse(&body.kind) else {
        return api_error(StatusCode::BAD_REQUEST, "種類は numeric か random です");
    };
    let ttl = body
        .ttl
        .map(|s| Duration::from_secs(s.clamp(60, 30 * 86400)))
        .unwrap_or_else(|| kind.default_ttl());
    match a.issue(&body.name, body.admin, kind, ttl) {
        Ok(i) => Json(json!({ "id": i.id, "code": i.code, "expires": i.expires })).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, &format!("{e:#}")),
    }
}

#[derive(Deserialize)]
struct RevokeBody {
    id: String,
}

async fn admin_revoke_handler(
    State(server): State<Arc<Server>>,
    headers: HeaderMap,
    Json(body): Json<RevokeBody>,
) -> Response {
    let (a, _) = match authorize_admin(&server, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let (sessions, otps) = a.revoke(&body.id);
    for id in &sessions {
        let _ = server.revoked.send(id.clone());
    }
    Json(json!({ "sessions": sessions.len(), "otps": otps })).into_response()
}

async fn ws_handler(
    State(server): State<Arc<Server>>,
    Query(q): Query<KeyQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Access::Token(token) = &server.access {
        if q.k.as_deref() != Some(token.as_str()) {
            return (StatusCode::UNAUTHORIZED, "invalid key").into_response();
        }
    }
    let hub = server.project(q.p.as_deref()).map(|p| p.hub.clone());
    ws.max_message_size(64 << 20)
        .on_upgrade(move |socket| connection(server, hub, socket))
}

async fn connection(server: Arc<Server>, hub: Option<Arc<Hub>>, socket: WebSocket) {
    let conn = server.next_conn.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let Some(hub) = hub else {
        let _ = sink
            .send(Message::Text(
                json!({ "type": "error", "code": "project", "message": "プロジェクトが見つかりません。プロジェクトを選び直してください" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    let mut rx = hub.tx.subscribe();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // 送信: 自分宛てのものと、他の人の変更（自分の分は除く）
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                m = out_rx.recv() => match m {
                    Some(m) => { if sink.send(Message::Text(m.into())).await.is_err() { break; } }
                    None => break,
                },
                r = rx.recv() => match r {
                    Ok((from, m)) => { if from != conn && sink.send(Message::Text(m.to_string().into())).await.is_err() { break; } }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // 取りこぼしたら接続を切る（クライアントは再接続して全体を取り直す）
                        break;
                    }
                    Err(_) => break,
                },
            }
        }
    });

    let mut name = String::from("名無し");
    let mut email = String::from("anonymous@komenagare");
    let mut client = String::new();
    let mut joined = false;
    let mut session: Option<String> = None;
    let mut shutdown = server.shutdown.subscribe();
    let mut revoked = server.revoked.subscribe();
    let mut check = tokio::time::interval(SESSION_CHECK);
    let kick = |out_tx: &tokio::sync::mpsc::UnboundedSender<String>| {
        let _ = out_tx.send(
            json!({ "type": "error", "code": "auth", "message": "ログインし直してください" })
                .to_string(),
        );
    };
    loop {
        let msg = tokio::select! {
            m = stream.next() => match m { Some(Ok(m)) => m, _ => break },
            _ = shutdown.changed() => break,
            r = revoked.recv() => {
                if matches!((&r, &session), (Ok(id), Some(s)) if id == s) { kick(&out_tx); break; }
                continue;
            }
            _ = check.tick() => {
                if let (Some(a), Some(s)) = (server.auth(), &session) {
                    if !a.alive(s) { kick(&out_tx); break; }
                }
                continue;
            }
        };
        let Message::Text(text) = msg else { continue };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let kind = v["type"].as_str();
        if !joined && kind != Some("hello") {
            continue;
        }
        match kind {
            Some("hello") => {
                if v["protocol"].as_u64() != Some(PROTOCOL as u64) {
                    let _ = out_tx.send(json!({ "type": "error", "code": "protocol",
                        "message": "このページはホストと版が合いません。ページを再読み込みしてください（直らなければ komenagare を更新してください）" }).to_string());
                    break;
                }
                if let Some(a) = server.auth() {
                    // 名前はセッションのもの（自分で名乗り直せない）
                    match v["session"].as_str().and_then(|t| a.verify(t)) {
                        Some(s) => {
                            name = s.name;
                            session = Some(s.id);
                        }
                        None => {
                            kick(&out_tx);
                            break;
                        }
                    }
                } else if let Some(n) = v["name"].as_str().and_then(auth::clean_name) {
                    name = n;
                }
                if let Some(c) = v["client"]
                    .as_str()
                    .filter(|c| c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'))
                {
                    client = c.chars().take(40).collect();
                    email = format!("{client}@komenagare");
                }
                joined = true;
                let mut inner = hub.inner.lock().await;
                let (presence, color) = match inner.peers.remove(&conn) {
                    Some(p) => (p.presence, p.color),
                    None => (None, free_color(&inner.peers)),
                };
                inner.peers.insert(
                    conn,
                    Peer {
                        name: name.clone(),
                        client: client.clone(),
                        color,
                        presence,
                    },
                );
                let comments: Vec<&Comment> = inner.store.sorted();
                let _ = out_tx.send(
                    json!({ "type": "snapshot", "rev": inner.rev, "you": conn, "name": name, "comments": comments })
                        .to_string(),
                );
                let _ = out_tx.send(conflicts_msg(&inner));
                for (id, p) in &inner.peers {
                    if let (true, Some(state)) = (*id != conn, &p.presence) {
                        let _ = out_tx.send(
                            json!({ "type": "presence", "id": id, "state": state }).to_string(),
                        );
                    }
                }
                broadcast_peers(&hub, &inner);
            }
            Some("presence") => {
                let state = &v["state"];
                if !state.is_object() || text.len() > PRESENCE_MAX {
                    continue;
                }
                let mut inner = hub.inner.lock().await;
                let Some(p) = inner.peers.get_mut(&conn) else {
                    continue;
                };
                p.presence = Some(state.clone());
                let msg = json!({ "type": "presence", "id": conn, "state": state }).to_string();
                let _ = hub.tx.send((conn, msg.into()));
            }
            Some("conflict_add") => {
                let mut inner = hub.inner.lock().await;
                let mut changed = false;
                for rec in v["conflicts"].as_array().into_iter().flatten() {
                    let Some(rec) = accept_conflict(rec, &name, &client) else {
                        continue;
                    };
                    if inner.conflicts.iter().any(|c| c["key"] == rec["key"]) {
                        continue;
                    }
                    inner.conflicts.push(rec);
                    changed = true;
                }
                if changed {
                    let n = inner.conflicts.len();
                    if n > CONFLICTS_KEEP {
                        inner.conflicts.drain(..n - CONFLICTS_KEEP);
                    }
                    conflicts_changed(&hub, &inner);
                }
            }
            Some("conflict_done") => {
                let keys: HashSet<&str> = v["keys"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect();
                let mut inner = hub.inner.lock().await;
                let n = inner.conflicts.len();
                inner
                    .conflicts
                    .retain(|c| !c["key"].as_str().is_some_and(|k| keys.contains(k)));
                if inner.conflicts.len() != n {
                    conflicts_changed(&hub, &inner);
                }
            }
            Some("history") => {
                let limit = v["limit"].as_u64().unwrap_or(200).min(HISTORY_KEEP as u64) as usize;
                let inner = hub.inner.lock().await;
                let entries: Vec<&LogEntry> = inner.history.iter().rev().take(limit).collect();
                let _ = out_tx.send(json!({ "type": "history", "entries": entries }).to_string());
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
    // 送り残し（エラーなど）を送り終えてから切る
    drop(out_tx);
    if tokio::time::timeout(Duration::from_millis(500), &mut send_task)
        .await
        .is_err()
    {
        send_task.abort();
    }
    let inner = &mut *hub.inner.lock().await;
    if inner.peers.remove(&conn).is_some() {
        broadcast_peers(&hub, inner);
    }
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
        let job_time = now_ms();
        let log = LogEntry {
            rev,
            time: job_time,
            author: name.to_string(),
            change: applied.clone(),
        };
        inner.history.push_back(log.clone());
        if inner.history.len() > HISTORY_KEEP {
            inner.history.pop_front();
        }
        let job = Job {
            comments: Store::new(inner.store.sorted().into_iter().cloned().collect()),
            message: format!("{name}: {summary}"),
            author: name.to_string(),
            email: email.to_string(),
            log,
        };
        let _ = hub.writer.send(job);
        let msg =
            json!({ "type": "change", "rev": rev, "time": job_time, "author": name, "change": applied }).to_string();
        let _ = hub.tx.send((conn, msg.into()));
    }
    json!({ "type": "ack", "id": change.id, "rev": inner.rev, "dup": false, "conflicts": r.conflicts, "fix": fix }).to_string()
}

fn broadcast_peers(hub: &Hub, inner: &Inner) {
    let mut names: Vec<&String> = inner.peers.values().map(|p| &p.name).collect();
    names.sort();
    let mut peers: Vec<Value> = inner
        .peers
        .iter()
        .map(|(id, p)| json!({ "id": id, "name": p.name, "client": p.client, "color": p.color }))
        .collect();
    peers.sort_by_key(|p| p["id"].as_u64());
    let _ = hub.tx.send((
        0,
        json!({ "type": "peers", "names": names, "peers": peers })
            .to_string()
            .into(),
    ));
}

/// 今いる人が使っていない一番小さい色の番号
fn free_color(peers: &HashMap<u64, Peer>) -> u32 {
    let used: HashSet<u32> = peers.values().map(|p| p.color).collect();
    (0..).find(|c| !used.contains(c)).unwrap_or(0)
}

/// 届いた衝突の記録を確かめ、誰のものかを書き足す（形がおかしければ None）
fn accept_conflict(rec: &Value, name: &str, client: &str) -> Option<Value> {
    let mut rec = rec.as_object()?.clone();
    let key = rec.get("key")?.as_str()?;
    if key.is_empty() || key.len() > 200 || serde_json::to_string(&rec).ok()?.len() > 64 * 1024 {
        return None;
    }
    rec.insert("author".into(), json!(name));
    rec.insert("client".into(), json!(client));
    Some(Value::Object(rec))
}

fn conflicts_msg(inner: &Inner) -> String {
    json!({ "type": "conflicts", "list": inner.conflicts }).to_string()
}

/// 保留中の衝突を書き残して、全員に配る
fn conflicts_changed(hub: &Hub, inner: &Inner) {
    let tmp = hub.conflicts_file.with_extension("json.tmp");
    let r = serde_json::to_vec(&inner.conflicts)
        .map_err(std::io::Error::other)
        .and_then(|body| std::fs::write(&tmp, body))
        .and_then(|_| std::fs::rename(&tmp, &hub.conflicts_file));
    if let Err(e) = r {
        eprintln!("衝突の記録に失敗しました: {e}");
    }
    let _ = hub.tx.send((0, conflicts_msg(inner).into()));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accept_conflict_checks_shape() {
        let rec = accept_conflict(
            &json!({ "key": "a:b", "id": "x", "author": "偽物" }),
            "Aさん",
            "c1",
        )
        .unwrap();
        assert_eq!(rec["author"], "Aさん");
        assert_eq!(rec["client"], "c1");
        assert_eq!(rec["id"], "x");
        assert!(accept_conflict(&json!({ "id": "x" }), "A", "c").is_none());
        assert!(accept_conflict(&json!({ "key": "" }), "A", "c").is_none());
        assert!(accept_conflict(&json!("key"), "A", "c").is_none());
        assert!(accept_conflict(&json!({ "key": "k".repeat(201) }), "A", "c").is_none());
    }
}
