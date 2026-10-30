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
//!   {"type":"hello","protocol":6,"name":"表示名","client_key":"ブラウザごとの秘密（16進 64 文字）","session":"…"(--otp のとき)}
//!     ブラウザごとの id（client）はホストが client_key のハッシュから作る。秘密は配らないので、他人の id は名乗れない
//!   {"type":"change","change":{変更セット}}
//!   {"type":"history","limit":N}                             最近の変更を求める
//!   {"type":"presence","state":{...}}                        自分の再生位置・選択・カーソルなど（ほかの人に配るだけ）
//!   {"type":"conflict_add","conflicts":[{"key":..,...}]}     「あとで」にした衝突を全員に見せる
//!   {"type":"conflict_done","keys":[...]}                    衝突を解決した（一覧から外す）
//!   {"type":"run","id":"…","line":"git status"}              ホストの作業フォルダでコマンドを打つ（--remote。許された人だけ。1つずつ）
//!   {"type":"run_stop","id":"…"}                             動いているコマンドを止める
//! サーバー → クライアント
//!   {"type":"snapshot","rev":N,"you":接続id,"name":"名前","client":"自分のブラウザの id","comments":[...],"remote":"git"|"shell"|null}
//!                                                            接続直後の全体（name はホストが使う名前。client は peers・conflicts の client と比べて自分のものか見分ける。remote はコマンドを打てるときの種類）
//!   {"type":"presence","id":接続id,"state":{...}}            ほかの人の状態（接続直後は今いる全員の分）
//!   {"type":"conflicts","list":[{"key",..,"author","client"}]} 保留中の衝突（変わるたびに全体）
//!   {"type":"change","rev":N,"time":ms,"author":"名前","change":{...}} 他の人の変更（適用できた op だけ）
//!   {"type":"history","entries":[{"rev","time","author","change"},...]} 最近の変更（新しい順）
//!   {"type":"ack","id":"変更セットid","rev":N,"dup":bool,"conflicts":[...],"fix":[{"id":..,"comment":..|null}]}
//!   {"type":"peers","names":[...],"peers":[{"id","name","client","color"}]} 参加者（color は色の番号。今いる人の中で空いている一番小さい番号）
//!   {"type":"run_out","id":"…","data":"出力","err":bool}       コマンドの出力（err は標準エラー出力）
//!   {"type":"run_end","id":"…","code":N|null,"message":"…"|null} コマンドが終わった（message は止めた理由・断った理由）
//!   {"type":"error","code":"protocol"|"auth"|"project","message":…} code があるものは送ったあと切る
//! 同じ変更セットを何度送っても1回だけ適用する（id で判定）ので、送り直しても安全。

use crate::auth::{self, Auth, Kind, SessionRec};
use crate::remote::{self, Remote};
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
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};

/// やりとりの取り決めの版数（変えたら web.json と js/app.js の COLLAB_PROTOCOL も合わせる）
pub const PROTOCOL: u32 = 6;

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
    /// 作業フォルダ（リモートのコマンドはここで動かす）
    pub dir: PathBuf,
    pub hub: Arc<Hub>,
}

pub struct Server {
    pub projects: Vec<Project>,
    pub access: Access,
    /// リモートのコマンド（--remote。--otp のときだけ）
    pub remote: Option<Remote>,
    web_dir: Option<PathBuf>,
    /// 外から入るときの URL（--tunnel / --public-url。招待のリンクに使う）
    public_url: std::sync::RwLock<Option<String>>,
    /// 公開 URL の手前でメールの確認（--allowed-mail。Cloudflare Access の PIN）をしているか
    email_gate: std::sync::atomic::AtomicBool,
    next_conn: AtomicU64,
    /// まだ hello（ログイン）を済ませていない接続の数
    pending: AtomicUsize,
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
    pub fn new(
        projects: Vec<Project>,
        access: Access,
        remote: Option<Remote>,
        web_dir: Option<PathBuf>,
    ) -> Arc<Server> {
        Arc::new(Server {
            projects,
            access,
            remote,
            web_dir,
            public_url: std::sync::RwLock::new(None),
            email_gate: std::sync::atomic::AtomicBool::new(false),
            next_conn: AtomicU64::new(1),
            pending: AtomicUsize::new(0),
            shutdown: tokio::sync::watch::channel(false).0,
            revoked: broadcast::channel(64).0,
            login_fails: std::sync::Mutex::new(VecDeque::new()),
        })
    }

    pub fn set_public_url(&self, url: Option<String>) {
        *self.public_url.write().unwrap() = url;
    }

    pub fn set_email_gate(&self, on: bool) {
        self.email_gate
            .store(on, std::sync::atomic::Ordering::Relaxed);
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

/// 1つの変更セットに入れてよい op の数の上限（ブラウザは大きな変更を 2000 op ずつに分けて送る）
const MAX_OPS_PER_CHANGE: usize = 10_000;
/// コメントの本文・コマンドの大きさの上限（バイト。ブラウザは本文を 10 万文字・コマンドを 1000 文字までにする）
const TEXT_MAX: usize = 400_000;
const CMD_MAX: usize = 4_000;
/// WebSocket の1通の大きさの上限（ブラウザは変更セットを 2MB ほどに分けて送る）
const MESSAGE_MAX: usize = 16 << 20;
/// hello（ログイン）より前に受け取る1通の大きさの上限。超えたら切る
const HELLO_MAX: usize = 64 * 1024;
/// つないでから hello が届くまで待つ時間（ブラウザはつながった直後に送る。ホストを始めてからの時間ではない）
const HELLO_TIMEOUT: Duration = Duration::from_secs(30);
/// hello を済ませていない接続をいくつまで受け付けるか（ログインせずに接続を開き続けてホストを埋めないように）
const PENDING_MAX: usize = 32;

/// 変更セットとして受け取ってよいか（id の形、op の数、コメントの id・本文・コマンドの大きさ）
fn change_ok(change: &Change) -> bool {
    let fields_ok = |f: &crate::store::Fields| {
        f.text.as_ref().is_none_or(|t| t.len() <= TEXT_MAX)
            && f.cmd.as_ref().is_none_or(|c| c.len() <= CMD_MAX)
    };
    change_id_ok(&change.id)
        && change.ops.len() <= MAX_OPS_PER_CHANGE
        && change.ops.iter().all(|op| {
            op.id().len() <= 64
                && match op {
                    crate::store::Op::Add { after, .. } => fields_ok(after),
                    crate::store::Op::Update { before, after, .. } => {
                        fields_ok(before) && fields_ok(after)
                    }
                    crate::store::Op::Delete { before, .. } => fields_ok(before),
                }
        })
}

/// hello を済ませていない接続を数える（hello が済むか、接続が終わると減る）
struct Pending(Arc<Server>);

impl Pending {
    fn new(server: &Arc<Server>) -> Pending {
        server.pending.fetch_add(1, Ordering::Relaxed);
        Pending(server.clone())
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.0.pending.fetch_sub(1, Ordering::Relaxed);
    }
}

/// 変更セットの id として受け取ってよいか（UUID v7 のほか、短い英数字も許す）。
/// 控え（seen）・コミットのトレーラーに使うので、長さと文字を絞る
fn change_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// ブラウザごとの id（ほかの人に配る）。ブラウザが持つ秘密（client_key。16進 64 文字）のハッシュで、
/// 秘密を知らなければ同じ id にはできない。秘密が無い・形が違うときは、この接続だけの id にする
fn client_id(key: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let hex = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    match key.filter(|k| k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit())) {
        Some(k) => {
            let d = Sha256::digest(format!("komenagare-client:{}", k.to_ascii_lowercase()));
            hex(&d[..16])
        }
        None => {
            use rand::Rng;
            let mut r = rand::rng();
            hex(&(0..16).map(|_| r.random::<u8>()).collect::<Vec<u8>>())
        }
    }
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
    if !web_path_ok(&path) {
        return StatusCode::NOT_FOUND.into_response();
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
        // メールの確認（--allowed-mail）の期限が切れると、公開 URL からはつながらなくなる。ページはそれを案内する
        let gate = if server.email_gate.load(std::sync::atomic::Ordering::Relaxed) {
            " data-email-gate=\"1\""
        } else {
            ""
        };
        let html = String::from_utf8_lossy(&data).replacen(
            "</head>",
            &format!(
                "<meta name=\"komenagare-host\" content=\"{}\" data-auth=\"{}\"{public}{gate}>\n</head>",
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
            // 万一ページに差し込みができても、外のスクリプトを読み込んだり（--remote で
            // ホストにコマンドを打たれる）、鍵を外に送られたりしないよう、読み込み先を絞る。
            // スクリプトは同じ出どころのファイルだけ・インラインは style 属性だけ・外への通信は同じ出どころだけ。
            // file:// で直接開くときはこのヘッダーが付かないので、ふだんの動きは変わらない
            (
                header::CONTENT_SECURITY_POLICY,
                "default-src 'self'; script-src 'self'; worker-src 'self'; \
                 style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; \
                 media-src 'self' blob:; connect-src 'self'; object-src 'none'; \
                 base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
                    .to_string(),
            ),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff".to_string()),
            (header::REFERRER_POLICY, "no-referrer".to_string()),
        ],
        data,
    )
        .into_response()
}

/// 配信してよいファイルか（index.html と css/・js/・lib/ の直下だけ）。
/// フォルダから配信するとき、\\ やドライブ名（C:）で作業フォルダの外を読まれないように、名前の文字も絞る。
/// web.rs が取ってきた web.json のファイル名を控えに書くときにも、同じ規則で確かめる（外に書かせない）
pub(crate) fn web_path_ok(path: &str) -> bool {
    if path == "index.html" {
        return true;
    }
    let mut parts = path.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some("css" | "js" | "lib"), Some(f), None) => {
            !f.is_empty()
                && !f.starts_with('.')
                && f.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        }
        _ => false,
    }
}

/// 長さ以外の時間で中身が分からないように比べる
fn same_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |acc, (x, y)| acc | (x ^ y))
            == 0
}

/// WebSocket をつないできたページが、このホストから配信したものか（ほかのサイトのページから勝手に
/// つながれないように）。Origin が無いのはブラウザ以外なので通す
fn same_origin(headers: &HeaderMap, public_url: Option<&str>) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let authority = |u: &str| {
        u.split_once("://")
            .map(|(_, r)| r.split('/').next().unwrap_or("").to_ascii_lowercase())
    };
    let Some(origin) = origin.to_str().ok().and_then(authority) else {
        return false;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(str::to_ascii_lowercase);
    host.as_deref() == Some(origin.as_str())
        || public_url.and_then(authority).as_deref() == Some(origin.as_str())
}

const HOST_NOT_ALLOWED: &str = "合言葉なし（--no-token）のときは、IP アドレスか localhost・このパソコンの名前で開いてください（ほかの名前で使うときは --public-url を付けてください）";

/// 合言葉なし（--no-token）のときに、つないできた先の名前（Host）がこのパソコンを指す名前か。
/// DNS リバインディング（悪意のあるサイトが自分のドメインの行き先をこのパソコンや LAN のアドレスに
/// 切り替える）では、ページの Origin と Host がどちらもそのドメインになり、same_origin を通ってしまう。
/// そのドメインはインターネットの名前（example.com など）なので、手元でしか使わない名前だけを通す:
/// IP アドレス・localhost・ドットの無い名前（mypc）・.local / .lan / .home.arpa / .internal、公開 URL の名前
fn local_host(headers: &HeaderMap, public_url: Option<&str>) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let name = host_name(host);
    if name.is_empty() {
        return false;
    }
    if public_url
        .and_then(|u| u.split_once("://"))
        .is_some_and(|(_, r)| host_name(r.split('/').next().unwrap_or("")) == name)
    {
        return true;
    }
    name.parse::<std::net::IpAddr>().is_ok()
        || !name.contains('.')
        || [".localhost", ".local", ".lan", ".home.arpa", ".internal"]
            .iter()
            .any(|s| name.ends_with(s))
}

/// Host の名前の部分（ポートを除き、小文字。IPv6 の [..] は外す。末尾の「.」も除く）
fn host_name(host: &str) -> String {
    let host = host.trim().to_ascii_lowercase();
    let name = if let Some(rest) = host.strip_prefix('[') {
        rest.split(']').next().unwrap_or("").to_string()
    } else {
        host.rsplit_once(':')
            .filter(|(_, port)| port.bytes().all(|b| b.is_ascii_digit()))
            .map_or(host.as_str(), |(n, _)| n)
            .to_string()
    };
    name.trim_end_matches('.').to_string()
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
        Access::None if !local_host(headers, server.public_url.read().unwrap().as_deref()) => {
            Err(api_error(StatusCode::FORBIDDEN, HOST_NOT_ALLOWED))
        }
        Access::None => Ok(None),
        Access::Token(t) if k.is_some_and(|k| same_secret(k, t)) => Ok(None),
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
        // 先に失敗として数えておく（同時にたくさん送られても、上限を超えて試せないように）。合っていたら外す
        fails.push_back(Instant::now());
    }
    let unreserve = || {
        let mut fails = server.login_fails.lock().unwrap();
        fails.pop_back();
    };
    match a.login(&body.code) {
        Ok(Some((token, s))) => {
            unreserve();
            Json(json!({ "token": token, "name": s.name, "admin": s.admin })).into_response()
        }
        Ok(None) => {
            // 続けざまに試せないよう少し待たせる
            tokio::time::sleep(Duration::from_millis(400)).await;
            api_error(
                StatusCode::UNAUTHORIZED,
                "ワンタイムパスワードが違うか、使用済み・期限切れです",
            )
        }
        Err(e) => {
            unreserve();
            eprintln!("ログインの処理に失敗しました: {e:#}");
            api_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "ログインの処理に失敗しました（ホストの画面を確かめてください）",
            )
        }
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
        .filter(|s| a.alive(&s.id))
        .map(|s| json!({ "id": s.id, "name": s.name, "admin": s.admin, "created": s.created, "expires": a.session_expires(&s), "you": s.id == me.id }))
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
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    match &server.access {
        Access::Token(token) if !q.k.as_deref().is_some_and(|k| same_secret(k, token)) => {
            return (StatusCode::UNAUTHORIZED, "invalid key").into_response();
        }
        // 合言葉もログインも無いときは、ほかのサイトのページからつながれないようにする
        Access::None if !same_origin(&headers, server.public_url.read().unwrap().as_deref()) => {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
        Access::None if !local_host(&headers, server.public_url.read().unwrap().as_deref()) => {
            return (StatusCode::FORBIDDEN, HOST_NOT_ALLOWED).into_response();
        }
        _ => {}
    }
    if server.pending.load(Ordering::Relaxed) >= PENDING_MAX {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "too many connections waiting for login",
        )
            .into_response();
    }
    let pending = Pending::new(&server);
    let project = server
        .project(q.p.as_deref())
        .map(|p| (p.hub.clone(), p.dir.clone(), p.name.clone()));
    ws.max_message_size(MESSAGE_MAX)
        .on_upgrade(move |socket| connection(server, project, socket, pending))
}

/// 動いているリモートのコマンド
struct Running {
    id: String,
    /// 送るか捨てると止まる
    stop: tokio::sync::oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

async fn connection(
    server: Arc<Server>,
    project: Option<(Arc<Hub>, PathBuf, String)>,
    socket: WebSocket,
    pending: Pending,
) {
    // hello が済むまで「ログイン待ち」として数える（済んだら外す）
    let mut waiting_login = Some(pending);
    let conn = server.next_conn.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let Some((hub, dir, project_name)) = project else {
        let _ = sink
            .send(Message::Text(
                json!({ "type": "error", "code": "project", "message": "プロジェクトが見つかりません。プロジェクトを選び直してください" })
                    .to_string()
                    .into(),
            ))
            .await;
        return;
    };
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    // 他の人の変更などは、hello で入れてから受け取る（ログインしていない接続には何も流さない）
    let (sub_tx, sub_rx) = tokio::sync::oneshot::channel::<broadcast::Receiver<(u64, Arc<str>)>>();
    let mut sub_tx = Some(sub_tx);
    // 送信: 自分宛てのものと、他の人の変更（自分の分は除く）
    let mut send_task = tokio::spawn(async move {
        let mut pending = Some(sub_rx);
        let mut rx: Option<broadcast::Receiver<(u64, Arc<str>)>> = None;
        loop {
            tokio::select! {
                m = out_rx.recv() => match m {
                    Some(m) => { if sink.send(Message::Text(m.into())).await.is_err() { break; } }
                    None => break,
                },
                r = async { pending.as_mut().unwrap().await }, if pending.is_some() => {
                    pending = None;
                    rx = r.ok();
                }
                r = async { rx.as_mut().unwrap().recv().await }, if rx.is_some() => match r {
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
    // リモートのコマンドを打てるか（hello で決める）と、動いているもの
    let mut can_run = false;
    let mut running: Option<Running> = None;
    let mut shutdown = server.shutdown.subscribe();
    let mut revoked = server.revoked.subscribe();
    let mut check = tokio::time::interval(SESSION_CHECK);
    // つないでから hello が届くまで待つ（届かなければ切る）
    let hello_deadline = tokio::time::sleep(HELLO_TIMEOUT);
    tokio::pin!(hello_deadline);
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
            _ = &mut hello_deadline, if !joined => break,
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
        let text = match msg {
            Message::Text(t) => t,
            // hello より前は、hello 以外（バイナリ）を送ってきたら切る
            Message::Binary(_) if !joined => break,
            _ => continue,
        };
        // hello より前の大きなメッセージは読まずに切る（ログインせずにホストのメモリを使わせない）
        if !joined && text.len() > HELLO_MAX {
            break;
        }
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
                            can_run = server
                                .remote
                                .as_ref()
                                .is_some_and(|r| r.allows(&s.name, s.admin));
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
                // ブラウザごとの id は、ブラウザだけが知る秘密（client_key）からホストが作る。
                // ほかの人に配るのは作った id だけなので、他人の id を名乗ることはできない
                client = client_id(v["client_key"].as_str());
                email = format!("{client}@komenagare");
                joined = true;
                drop(waiting_login.take());
                let mut inner = hub.inner.lock().await;
                // 全体（snapshot）を作るのと同じロックの中で受け取り始める（取りこぼさないように）
                if let Some(tx) = sub_tx.take() {
                    let _ = tx.send(hub.tx.subscribe());
                }
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
                let remote = server
                    .remote
                    .as_ref()
                    .filter(|_| can_run)
                    .map(|r| r.mode.label());
                let _ = out_tx.send(
                    json!({ "type": "snapshot", "rev": inner.rev, "you": conn, "name": name, "client": client, "comments": comments, "remote": remote })
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
            Some("run") => {
                let id: String = v["id"].as_str().unwrap_or("").chars().take(64).collect();
                let line = v["line"].as_str().unwrap_or("").trim().to_string();
                let refuse = |message: &str| {
                    let _ = out_tx.send(
                        json!({ "type": "run_end", "id": id, "code": null, "message": message })
                            .to_string(),
                    );
                };
                let Some(r) = server.remote.as_ref().filter(|_| can_run) else {
                    refuse("このホストでは、あなたはコマンドを打てません");
                    continue;
                };
                if running.as_ref().is_some_and(|r| !r.task.is_finished()) {
                    refuse("前のコマンドがまだ動いています（止めてから打ってください）");
                    continue;
                }
                let cmd = match remote::build(r.mode, &line, &dir) {
                    Ok(c) => c,
                    Err(e) => {
                        println!(
                            "[コマンド] {}（{}）: {}（断りました: {}）",
                            remote::printable(&name),
                            remote::printable(&project_name),
                            remote::printable(&line),
                            remote::printable(&e)
                        );
                        refuse(&e);
                        continue;
                    }
                };
                println!(
                    "[コマンド] {}（{}）: {}",
                    remote::printable(&name),
                    remote::printable(&project_name),
                    remote::printable(&line)
                );
                let out = out_tx.clone();
                let send: remote::Sender = Box::new(move |m| {
                    let _ = out.send(m);
                });
                let (stop, stop_rx) = tokio::sync::oneshot::channel();
                let (dir, who, rid) = (dir.clone(), name.clone(), id.clone());
                let task = tokio::spawn(async move {
                    let code = remote::run(cmd, rid, send, stop_rx).await;
                    let _ = tokio::task::spawn_blocking(move || {
                        remote::log(&dir, &who, &line, code, now_ms())
                    })
                    .await;
                });
                running = Some(Running { id, stop, task });
            }
            Some("run_stop") => {
                if running.as_ref().is_some_and(|r| v["id"] == r.id.as_str()) {
                    if let Some(r) = running.take() {
                        let _ = r.stop.send(());
                    }
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
                // 変更セットの id は控え（seen）やコミットのトレーラーに使うので、形と大きさを絞る。
                // op の数も上限を付ける（1件の巨大な変更セットでホストを埋めないように）
                if !change_ok(&change) {
                    let _ = out_tx.send(
                        json!({ "type": "error", "message": "変更セットが正しくないか、大きすぎます" })
                            .to_string(),
                    );
                    continue;
                }
                let reply = apply_change(&hub, conn, &name, &email, change).await;
                let _ = out_tx.send(reply);
            }
            _ => {}
        }
    }
    // 動いているコマンドは止める
    drop(running);
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
    // .komenagare がシンボリックリンクに置き換えられていたら書かない（作業フォルダの外に書かないように）
    let r = hub
        .conflicts_file
        .parent()
        .and_then(|d| d.parent())
        .map_or_else(
            || Err(std::io::Error::other("置き場所がありません")),
            |dir| crate::workspace::meta_dir(dir).map_err(std::io::Error::other),
        )
        .and_then(|_| serde_json::to_vec(&inner.conflicts).map_err(std::io::Error::other))
        .and_then(|body| crate::workspace::write_new(&tmp, &body))
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
    fn serves_only_web_app_files() {
        for ok in [
            "index.html",
            "css/komenagare.css",
            "js/app.js",
            "lib/mediabunny-1.61.6.min.js",
        ] {
            assert!(web_path_ok(ok), "{ok}");
        }
        for bad in [
            "../secret",
            "js/../../secret",
            "js/..\\..\\secret",
            "..\\..\\Windows\\win.ini",
            "C:/Windows/win.ini",
            "js/C:x",
            "js/.hidden",
            "js/a/b.js",
            "web.json",
            ".komenagare/id",
            "js/",
        ] {
            assert!(!web_path_ok(bad), "{bad}");
        }
    }

    #[test]
    fn compares_secrets() {
        assert!(same_secret("abc", "abc"));
        assert!(!same_secret("abc", "abd"));
        assert!(!same_secret("abc", "ab"));
        assert!(!same_secret("", "a"));
    }

    #[test]
    fn checks_websocket_origin() {
        let h = |origin: Option<&str>, host: &str| {
            let mut m = HeaderMap::new();
            m.insert(header::HOST, host.parse().unwrap());
            if let Some(o) = origin {
                m.insert(header::ORIGIN, o.parse().unwrap());
            }
            m
        };
        assert!(same_origin(&h(None, "127.0.0.1:8764"), None));
        assert!(same_origin(
            &h(Some("http://127.0.0.1:8764"), "127.0.0.1:8764"),
            None
        ));
        assert!(same_origin(
            &h(Some("http://LOCALHOST:8764"), "localhost:8764"),
            None
        ));
        assert!(!same_origin(
            &h(Some("https://evil.example"), "127.0.0.1:8764"),
            None
        ));
        assert!(!same_origin(&h(Some("null"), "127.0.0.1:8764"), None));
        // 公開 URL（Host を書き換えるトンネル）
        assert!(same_origin(
            &h(Some("https://a.example.com"), "127.0.0.1:8764"),
            Some("https://a.example.com/")
        ));
    }

    #[test]
    fn client_id_comes_from_the_secret() {
        let k = "a".repeat(64);
        // 同じ秘密なら同じ id（同じブラウザのほかのタブ）、大文字小文字は区別しない
        assert_eq!(client_id(Some(&k)), client_id(Some(&k.to_uppercase())));
        assert_eq!(client_id(Some(&k)).len(), 32);
        // 秘密そのものは id にならない
        assert_ne!(client_id(Some(&k)), k[..32]);
        assert_ne!(client_id(Some(&k)), client_id(Some(&"b".repeat(64))));
        // 秘密が無い・形が違う（他人の id をそのまま送る）ときは、毎回ちがう id
        let other = client_id(Some(&k));
        for bad in [
            None,
            Some(""),
            Some(other.as_str()),
            Some(&"g".repeat(64)[..]),
        ] {
            let a = client_id(bad);
            assert_ne!(a, other);
            assert_ne!(a, client_id(bad));
        }
    }

    #[test]
    fn rejects_dns_rebinding_hosts() {
        let h = |host: &str| {
            let mut m = HeaderMap::new();
            m.insert(header::HOST, host.parse().unwrap());
            m
        };
        for ok in [
            "127.0.0.1:8764",
            "localhost:8764",
            "LOCALHOST",
            "192.168.1.10:8764",
            "[::1]:8764",
            "[fe80::1]",
            "mypc:8764",
            "mypc.local:8764",
            "nas.lan",
            "box.home.arpa",
            "app.localhost",
            "host.internal.",
        ] {
            assert!(local_host(&h(ok), None), "{ok}");
        }
        for bad in [
            "evil.example:8764",
            "rebind.attacker.com",
            "127.0.0.1.nip.io",
            "local.evil.com",
            "localhost.evil.com:8764",
        ] {
            assert!(!local_host(&h(bad), None), "{bad}");
        }
        // 公開 URL（--public-url）の名前は通す
        assert!(local_host(
            &h("komenagare.example.com"),
            Some("https://komenagare.example.com/")
        ));
        assert!(!local_host(&HeaderMap::new(), None));
    }

    #[test]
    fn change_id_shape() {
        assert!(change_id_ok("01932b3c-4d5e-7f00-8a1b-2c3d4e5f6071"));
        assert!(change_id_ok("ch1"));
        assert!(!change_id_ok(""));
        assert!(!change_id_ok(&"a".repeat(65)));
        assert!(!change_id_ok("a\nb"));
        assert!(!change_id_ok("a b"));
        assert!(!change_id_ok("../x"));
    }

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
