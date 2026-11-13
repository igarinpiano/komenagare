// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! komenagare mcp — AI などの自動の参加者を、動いているホストに「参加者」としてつなぐ。
//!
//! ホストから見ると、ブラウザと同じ取り決め（server.rs の冒頭）でつないでくる1人の参加者
//! （hello に agent: true を付ける）。名前と色が付き、変更履歴・衝突にも人と同じように載る。
//!
//! 入口は2つで、どちらも同じ道具（`Agent::call`）を呼ぶ。AI にできることは手でも同じようにできる:
//!   MCP    標準入出力で JSON-RPC（1行1通）。AI のアプリ（Claude Code など）がこのコマンドを起動して道具を呼ぶ
//!   手動   --manual（標準入力から1行ずつ）と --script FILE。確認・デモ・デバッグ用
//!
//! 動きの見せ方: 道具は「カーソルを動かす → 変更を送る → 選ぶ」を少しずつ間を空けて行い、
//! ブラウザはその間をなめらかにつなぐ（js/app.js の peerEase）。--instant で間を空けない。
//!
//! 一時停止: 管理者が画面から止めると（hold）、ホストはこの参加者の変更を受け付けなくなる。
//! 書き込む道具は再開を待ち、待ちきれなければ「一時停止中」と返す（読む道具は使える）。

use crate::store::{uuid_v7, Change, Comment, Fields, Op, Store};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::Message;

/// 書き込む道具が、つながる・再開されるのを待つ時間（MCP のクライアントは 60 秒ほどで見切ることが多い）
const READY_WAIT: Duration = Duration::from_secs(45);
/// 変更を送ってから ack を待つ時間
const ACK_WAIT: Duration = Duration::from_secs(30);
/// 1回の道具で動きを見せるのにかける時間の目安（件数が多いときは、まとめて送って収める）
const ACT_BUDGET_MS: u64 = 8000;
/// 動きを見せるときの、1回に送るまとまりの数の上限
const ACT_STEPS: usize = 40;
/// 覚えておく出来事（ほかの人の変更・「ここ見て」など）の数
const EVENTS_KEEP: usize = 500;
/// 1回の道具で扱うコメントの数の上限（ホストは 1 つの変更セットに 1 万 op まで）
const ITEMS_MAX: usize = 2000;
/// コメントの時刻の上限（server.rs の TIME_MAX と同じ）
const TIME_MAX: f64 = 1e7;
/// 本文の上限（文字。画面と同じ）
const TEXT_MAX: usize = 100_000;
/// 一度に渡すコマ（画像）の数の上限
const FRAMES_MAX: u64 = 16;
/// 切り出す動画の長さの上限（秒）
const CLIP_MAX: f64 = 600.0;
/// 結果に埋め込む動画の大きさの上限（バイト。base64 にすると 4/3 倍になる）
const EMBED_MAX: u64 = 24 << 20;

/* ---------- つなぐ先 ---------- */

/// ホストの URL（起動時に出る「開く:」の URL や共有のリンク）から読み取ったもの
#[derive(Debug, PartialEq)]
pub struct Target {
    tls: bool,
    /// ホスト名とポート
    authority: String,
    /// 合言葉（k=）
    token: Option<String>,
    /// プロジェクトの id（p=）
    project: Option<String>,
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = (b[i] == b'%' && i + 2 < b.len())
            .then(|| std::str::from_utf8(&b[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|h| u8::from_str_radix(h, 16).ok());
        match hex {
            Some(c) => {
                out.push(c);
                i += 3;
            }
            None => {
                out.push(if b[i] == b'+' { b' ' } else { b[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn pct_encode(s: &str) -> String {
    s.bytes()
        .map(|c| {
            if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) {
                (c as char).to_string()
            } else {
                format!("%{c:02X}")
            }
        })
        .collect()
}

impl Target {
    pub fn parse(url: &str) -> Result<Target> {
        let (scheme, rest) = url
            .trim()
            .split_once("://")
            .context("ホストの URL（http://… か https://…）を指定してください")?;
        let tls = match scheme.to_ascii_lowercase().as_str() {
            "http" | "ws" => false,
            "https" | "wss" => true,
            _ => bail!("ホストの URL は http:// か https:// で始めてください"),
        };
        let rest = rest.split('#').next().unwrap_or("");
        let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
        let authority = path.split('/').next().unwrap_or("").to_string();
        if authority.is_empty() || authority.contains('@') {
            bail!("ホストの URL を読めません: {url}");
        }
        let (mut token, mut project) = (None, None);
        for kv in query.split('&') {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            match k {
                "k" if !v.is_empty() => token = Some(pct_decode(v)),
                "p" if !v.is_empty() => project = Some(pct_decode(v)),
                _ => {}
            }
        }
        Ok(Target {
            tls,
            authority,
            token,
            project,
        })
    }
    fn http(&self, path: &str) -> String {
        let key = self
            .token
            .as_ref()
            .map(|k| format!("?k={}", pct_encode(k)))
            .unwrap_or_default();
        let scheme = if self.tls { "https" } else { "http" };
        format!("{scheme}://{}{path}{key}", self.authority)
    }
    fn ws(&self) -> String {
        let mut q = vec![];
        if let Some(p) = &self.project {
            q.push(format!("p={}", pct_encode(p)));
        }
        if let Some(k) = &self.token {
            q.push(format!("k={}", pct_encode(k)));
        }
        let scheme = if self.tls { "wss" } else { "ws" };
        format!("{scheme}://{}/ws?{}", self.authority, q.join("&"))
    }
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        .max_idle_connections(0)
        .build()
        .into()
}

fn http_json(req: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value> {
    let text = req?.body_mut().read_to_string()?;
    Ok(serde_json::from_str(&text)?)
}

/// この参加者がホストに名乗るための控え（ブラウザの localStorage に当たるもの）。
/// client_key は色と「同じ参加者か」の見分けに、session は --otp のログインに使う
fn state_file(target: &Target, name: &str) -> Option<PathBuf> {
    let dir = crate::auth::Auth::default_dir()?.parent()?.join("agents");
    let host: String = target
        .authority
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    // 名前ごとに分ける（同じホストに何人もつなげるように）
    let h = name.bytes().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ b as u64).wrapping_mul(0x100000001b3)
    });
    Some(dir.join(format!("{host}-{h:016x}.json")))
}

fn write_private(path: &Path, text: &str) -> Result<()> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d)?;
    }
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(text.as_bytes())?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, text)?;
    Ok(())
}

/* ---------- 動画（コマと範囲の切り出し） ---------- */

pub struct Video {
    path: PathBuf,
    duration: Option<f64>,
    /// 切り出したファイルの置き場所
    out_dir: PathBuf,
}

impl Video {
    pub fn open(path: &Path, out_dir: Option<&Path>) -> Result<Video> {
        if !path.is_file() {
            bail!("動画が見つかりません: {}", path.display());
        }
        let out = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .stdin(std::process::Stdio::null())
            .output()
            .context("ffprobe を動かせません。動画を渡すには ffmpeg（ffprobe も一緒に入ります）が必要です")?;
        let duration = String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|d| d.is_finite() && *d > 0.0);
        let out_dir = match out_dir {
            Some(d) => d.to_path_buf(),
            None => std::env::temp_dir().join(format!("komenagare-mcp-{}", std::process::id())),
        };
        Ok(Video {
            path: path.to_path_buf(),
            duration,
            out_dir,
        })
    }

    async fn ffmpeg(args: Vec<std::ffi::OsString>) -> Result<Vec<u8>> {
        let out = tokio::process::Command::new("ffmpeg")
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y"])
            .args(args)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true)
            .output()
            .await
            .context("ffmpeg を動かせません")?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            bail!(
                "ffmpeg が失敗しました: {}",
                err.lines().last().unwrap_or("").trim()
            );
        }
        Ok(out.stdout)
    }

    /// その時刻のコマ（JPEG）
    async fn frame(&self, t: f64, width: u64) -> Result<Vec<u8>> {
        let mut a: Vec<std::ffi::OsString> =
            vec!["-ss".into(), format!("{t:.3}").into(), "-i".into()];
        a.push(self.path.clone().into());
        for s in [
            "-frames:v",
            "1",
            "-vf",
            &format!("scale='min({width},iw)':-2"),
            "-q:v",
            "5",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-",
        ] {
            a.push(s.into());
        }
        let data = Self::ffmpeg(a).await?;
        if data.is_empty() {
            bail!(
                "{} のコマを取り出せませんでした（動画の長さを超えていませんか）",
                fmt_time(t)
            );
        }
        Ok(data)
    }

    /// 範囲を切り出した動画（mp4。小さくして置く）
    async fn clip(&self, from: f64, to: f64, height: u64, audio: bool) -> Result<PathBuf> {
        tokio::fs::create_dir_all(&self.out_dir).await?;
        let name = format!(
            "clip-{}-{}-{}.mp4",
            (from * 100.0).round() as u64,
            (to * 100.0).round() as u64,
            height
        );
        let out = self.out_dir.join(name);
        let mut a: Vec<std::ffi::OsString> =
            vec!["-ss".into(), format!("{from:.3}").into(), "-i".into()];
        a.push(self.path.clone().into());
        for s in [
            "-t",
            &format!("{:.3}", to - from),
            "-vf",
            &format!("scale=-2:'min({height},ih)'"),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "28",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
        ] {
            a.push(s.into());
        }
        if audio {
            for s in ["-c:a", "aac", "-b:a", "64k", "-ac", "1"] {
                a.push(s.into());
            }
        } else {
            a.push("-an".into());
        }
        a.push(out.clone().into());
        Self::ffmpeg(a).await?;
        Ok(out)
    }
}

/* ---------- 参加者としての状態 ---------- */

pub struct Opts {
    pub name: String,
    /// 動きを見せる間を空けない
    pub instant: bool,
    pub video: Option<Video>,
}

struct PeerInfo {
    id: u64,
    name: String,
    agent: bool,
    held: Option<String>,
}

struct Pending {
    /// 送る文（つなぎ直したら送り直す。同じ id の変更セットは1回だけ適用される）
    text: String,
    change: Change,
    ack: Option<Value>,
}

#[derive(Default)]
struct State {
    connected: bool,
    /// つなぎ直しても直らない失敗（版が合わない・ログインが切れた・プロジェクトが無い）
    fatal: Option<String>,
    store: Store,
    me: u64,
    my_name: String,
    peers: Vec<PeerInfo>,
    presence: HashMap<u64, Value>,
    /// 一時停止中（止めた人の名前）
    held: Option<String>,
    pending: HashMap<String, Pending>,
    events: VecDeque<Value>,
    // 自分の様子（presence で配る）
    t: f64,
    sel: Vec<String>,
    cur: Option<Value>,
    note: String,
}

struct Shared {
    st: Mutex<State>,
    out: mpsc::UnboundedSender<String>,
    notify: Notify,
    opts: Opts,
    target: Target,
    hello: Value,
    project_name: String,
}

#[derive(Clone)]
pub struct Agent(Arc<Shared>);

/// 道具の結果
pub struct Out {
    pub text: String,
    pub error: bool,
    pub media: Vec<Media>,
}

pub enum Media {
    Jpeg(Vec<u8>),
    Video { path: PathBuf, embed: bool },
}

impl Out {
    fn ok(text: impl Into<String>) -> Out {
        Out {
            text: text.into(),
            error: false,
            media: vec![],
        }
    }
    fn err(text: impl Into<String>) -> Out {
        Out {
            text: text.into(),
            error: true,
            media: vec![],
        }
    }
}

fn fmt_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!("{}:{:02}.{:02}", cs / 6000, cs / 100 % 60, cs % 100)
}

/// 時刻（秒の数値か "1:23.45"）
fn time_arg(v: &Value) -> Option<f64> {
    let t = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => crate::files::parse_time(s),
        _ => None,
    }?;
    (t.is_finite() && (0.0..=TIME_MAX).contains(&t)).then(|| (t * 100.0).round() / 100.0)
}

fn norm_cmd(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn norm_text(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .take(TEXT_MAX)
        .collect()
}

/// タイムラインの段の組（上・流・下。js/app.js の TL_GROUPS の順）
fn lane_group(cmd: &str) -> u64 {
    let mut g = 1;
    for w in cmd.split_whitespace() {
        match w {
            "ue" => g = 0,
            "naka" => g = 1,
            "shita" => g = 2,
            _ => {}
        }
    }
    g
}

fn comment_json(c: &Comment) -> Value {
    json!({ "id": c.id, "t": c.t, "time": fmt_time(c.t), "cmd": c.cmd, "text": c.text })
}

fn clip_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

impl State {
    fn event(&mut self, v: Value) {
        if self.events.len() >= EVENTS_KEEP {
            self.events.pop_front();
        }
        self.events.push_back(v);
    }
    fn presence_msg(&self, video: Option<f64>) -> String {
        json!({ "type": "presence", "state": {
            "t": self.t, "playing": false, "rate": 1, "sel": self.sel, "view": null, "cur": self.cur,
            "video": video.map(|d| json!({ "d": d })), "note": self.note,
        } })
        .to_string()
    }
    /// id か、id の先頭の何文字か（1つに決まるとき）からコメントを探す
    fn find(&self, id: &str) -> Result<Comment, String> {
        let id = id.trim().to_ascii_lowercase();
        if let Some(c) = self.store.get(&id) {
            return Ok(c.clone());
        }
        let hits: Vec<&Comment> = if id.len() >= 4 {
            self.store
                .sorted()
                .into_iter()
                .filter(|c| c.id.starts_with(&id) || c.id.ends_with(&id))
                .collect()
        } else {
            vec![]
        };
        match hits.len() {
            1 => Ok(hits[0].clone()),
            0 => Err(format!("id「{id}」のコメントはありません")),
            n => Err(format!(
                "id「{id}」に当てはまるコメントが {n} 件あります（もっと長く指定してください）"
            )),
        }
    }
}

impl Shared {
    fn video_d(&self) -> Option<f64> {
        self.opts.video.as_ref().and_then(|v| v.duration)
    }
    fn send(&self, text: String) {
        let _ = self.out.send(text);
    }
    fn send_presence(&self) {
        let msg = self.st.lock().unwrap().presence_msg(self.video_d());
        self.send(msg);
    }

    /// ホストから届いた1通を当てる。すぐに送り返すものを返す
    fn on_message(&self, text: &str) -> Vec<String> {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return vec![];
        };
        let mut reply = vec![];
        let mut st = self.st.lock().unwrap();
        match v["type"].as_str() {
            Some("snapshot") => {
                let comments: Vec<Comment> =
                    serde_json::from_value(v["comments"].clone()).unwrap_or_default();
                st.store = Store::new(comments);
                st.me = v["you"].as_u64().unwrap_or(0);
                st.my_name = v["name"].as_str().unwrap_or("").to_string();
                st.connected = true;
                // 送ったまま返事の無い変更を送り直す
                reply.extend(
                    st.pending
                        .values()
                        .filter(|p| p.ack.is_none())
                        .map(|p| p.text.clone()),
                );
                reply.push(st.presence_msg(self.video_d()));
            }
            Some("change") => {
                if let Ok(change) = serde_json::from_value::<Change>(v["change"].clone()) {
                    let ev = change_event(&st.store, &change, v["author"].as_str().unwrap_or(""));
                    st.store.apply(&change, false);
                    st.event(ev);
                }
            }
            Some("ack") => {
                let id = v["id"].as_str().unwrap_or("").to_string();
                if let Some(change) = st.pending.get(&id).map(|p| p.change.clone()) {
                    // 自分の変更はホストから change では届かないので、ここで手元に当てる
                    st.store.apply(&change, false);
                    for f in v["fix"].as_array().into_iter().flatten() {
                        match serde_json::from_value::<Comment>(f["comment"].clone()) {
                            Ok(c) => st.store.put(c),
                            Err(_) => st.store.remove(f["id"].as_str().unwrap_or("")),
                        }
                    }
                    if let Some(p) = st.pending.get_mut(&id) {
                        p.ack = Some(v.clone());
                    }
                }
            }
            // 一時停止中で断られた（止められたことは peers で届く。再開されたら送り直す）
            Some("held") => {}
            Some("peers") => {
                st.peers = v["peers"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| PeerInfo {
                        id: p["id"].as_u64().unwrap_or(0),
                        name: p["name"].as_str().unwrap_or("").to_string(),
                        agent: p["agent"].as_bool() == Some(true),
                        held: p["held"].as_str().map(str::to_string),
                    })
                    .collect();
                let ids: Vec<u64> = st.peers.iter().map(|p| p.id).collect();
                st.presence.retain(|id, _| ids.contains(id));
                let me = st.me;
                let held = st
                    .peers
                    .iter()
                    .find(|p| p.id == me)
                    .and_then(|p| p.held.clone());
                if held != st.held {
                    match &held {
                        Some(by) => st.event(json!({ "kind": "paused", "by": by })),
                        None => {
                            st.event(json!({ "kind": "resumed" }));
                            // 止められていた間に断られた変更を送り直す
                            reply.extend(
                                st.pending
                                    .values()
                                    .filter(|p| p.ack.is_none())
                                    .map(|p| p.text.clone()),
                            );
                        }
                    }
                    st.held = held;
                    st.note = if st.held.is_some() {
                        "一時停止中".into()
                    } else {
                        String::new()
                    };
                    reply.push(st.presence_msg(self.video_d()));
                }
            }
            Some("presence") => {
                if let Some(id) = v["id"].as_u64() {
                    st.presence.insert(id, v["state"].clone());
                }
            }
            Some("call") => {
                let ev = json!({ "kind": "call", "name": v["name"], "t": v["state"]["t"], "sel": v["state"]["sel"] });
                st.event(ev);
            }
            Some("error") => {
                let msg = v["message"].as_str().unwrap_or("").to_string();
                if v["code"].is_string() {
                    st.fatal = Some(msg);
                    st.connected = false;
                } else {
                    eprintln!("ホスト: {msg}");
                }
            }
            _ => {}
        }
        drop(st);
        self.notify.notify_waiters();
        reply
    }
}

/// ほかの人の変更を、出来事として読みやすくする（当てる前の store で元の値を見る）
fn change_event(store: &Store, change: &Change, author: &str) -> Value {
    let (mut added, mut updated, mut deleted) = (vec![], vec![], vec![]);
    for op in &change.ops {
        match op {
            Op::Add { id, after } => {
                added.push(json!({ "id": id, "t": after.t, "cmd": after.cmd, "text": after.text }))
            }
            Op::Update { id, after, .. } => {
                let mut o = json!({ "id": id });
                if let Some(c) = store.get(id) {
                    o["was"] = json!({ "t": c.t, "cmd": c.cmd, "text": clip_chars(&c.text, 200) });
                }
                o["now"] = serde_json::to_value(after).unwrap_or(Value::Null);
                updated.push(o);
            }
            Op::Delete { id, .. } => deleted.push(json!({ "id": id,
                "text": store.get(id).map(|c| clip_chars(&c.text, 200)) })),
        }
    }
    json!({ "kind": "change", "author": author, "added": added, "updated": updated, "deleted": deleted })
}

fn tls_config() -> Result<Arc<rustls::ClientConfig>> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let cfg = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_root_certificates(roots)
    .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// つなぎ続ける（切れたらつなぎ直す）
async fn conn_loop(sh: Arc<Shared>, mut rx: mpsc::UnboundedReceiver<String>) {
    let mut retry = 0u32;
    let mut said = false;
    loop {
        let connector = match sh.target.tls {
            true => tls_config().ok().map(tokio_tungstenite::Connector::Rustls),
            false => Some(tokio_tungstenite::Connector::Plain),
        };
        let conn = tokio::time::timeout(
            Duration::from_secs(20),
            tokio_tungstenite::connect_async_tls_with_config(
                sh.target.ws(),
                None,
                false,
                connector,
            ),
        )
        .await;
        match conn {
            Ok(Ok((ws, _))) => {
                let (mut sink, mut stream) = ws.split();
                // つながる前に溜まったもの（古い presence など）は捨てる
                while rx.try_recv().is_ok() {}
                let mut alive = sink
                    .send(Message::Text(sh.hello.to_string().into()))
                    .await
                    .is_ok();
                let mut ping = tokio::time::interval(Duration::from_secs(20));
                let mut last_in = Instant::now();
                while alive {
                    tokio::select! {
                        m = stream.next() => match m {
                            Some(Ok(Message::Text(t))) => {
                                last_in = Instant::now();
                                retry = 0;
                                said = false;
                                for r in sh.on_message(t.as_str()) {
                                    alive &= sink.send(Message::Text(r.into())).await.is_ok();
                                }
                                if sh.st.lock().unwrap().fatal.is_some() { alive = false; }
                            }
                            Some(Ok(_)) => last_in = Instant::now(),
                            _ => alive = false,
                        },
                        m = rx.recv() => match m {
                            Some(m) => alive = sink.send(Message::Text(m.into())).await.is_ok(),
                            None => return,
                        },
                        _ = ping.tick() => {
                            // 返事が無ければ見切ってつなぎ直す
                            if last_in.elapsed() > Duration::from_secs(60) { alive = false; }
                            else { alive = sink.send(Message::Text(r#"{"type":"ping"}"#.into())).await.is_ok(); }
                        }
                    }
                }
            }
            Ok(Err(e)) => {
                if !said {
                    eprintln!("ホストにつなげません（つなぎ直します）: {e}");
                    said = true;
                }
            }
            Err(_) => {}
        }
        let fatal = {
            let mut st = sh.st.lock().unwrap();
            st.connected = false;
            st.peers.clear();
            st.presence.clear();
            st.fatal.clone()
        };
        sh.notify.notify_waiters();
        if let Some(f) = fatal {
            eprintln!("ホストとの接続を終わります: {f}");
            return;
        }
        tokio::time::sleep(Duration::from_millis(500 * 2u64.pow(retry.min(4)))).await;
        retry += 1;
    }
}

pub struct Connect {
    pub url: String,
    pub name: String,
    pub code: Option<String>,
    pub project: Option<String>,
    pub video: Option<PathBuf>,
    pub media_dir: Option<PathBuf>,
    pub instant: bool,
}

impl Agent {
    /// ホストを確かめて（入り方・プロジェクト）、つなぎ始める
    pub async fn connect(c: Connect) -> Result<Agent> {
        let mut target = Target::parse(&c.url)?;
        let name = crate::auth::clean_name(&c.name).context("名前（--name）が空です")?;
        let video = match &c.video {
            Some(p) => Some(Video::open(p, c.media_dir.as_deref())?),
            None => None,
        };
        let file = state_file(&target, &name);
        let mut saved: Value = file
            .as_ref()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_else(|| json!({}));
        if saved["client_key"].as_str().is_none_or(|k| k.len() != 64) {
            saved["client_key"] = json!(crate::auth::random_hex(32));
        }
        // ホストの入り方とプロジェクトを調べる（--otp ならログインする）
        let (t, code, mut session) = (
            Target {
                tls: target.tls,
                authority: target.authority.clone(),
                token: target.token.clone(),
                project: None,
            },
            c.code.clone(),
            saved["session"].as_str().map(str::to_string),
        );
        let (session, info) = tokio::task::spawn_blocking(move || -> Result<(Option<String>, Value)> {
            let agent = http_agent();
            if let Some(code) = code {
                let r = http_json(
                    agent
                        .post(t.http("/api/login"))
                        .header("Content-Type", "application/json")
                        .send(json!({ "code": code }).to_string()),
                )
                .context("ワンタイムパスワードでログインできませんでした（使用済みか、期限切れかもしれません）")?;
                session = r["token"].as_str().map(str::to_string);
            }
            let mut req = agent.get(t.http("/api/projects"));
            if let Some(s) = &session {
                req = req.header("Authorization", format!("Bearer {s}"));
            }
            let info = http_json(req.call()).with_context(|| {
                format!("ホスト（{}）につなげません。komenagare が動いているか、URL と合言葉（k=）を確かめてください", t.authority)
            })?;
            Ok((session, info))
        })
        .await??;
        if info["auth"].as_str() == Some("otp") && info["me"].is_null() {
            bail!("このホストはワンタイムパスワードで入ります。画面の「招待」か komenagare otp new で「{name}」用に発行し、--code で渡してください（1回ログインすれば、次からは要りません）");
        }
        saved["session"] = json!(session);
        if let Some(f) = &file {
            if let Err(e) = write_private(f, &saved.to_string()) {
                eprintln!(
                    "ログインの控えを保存できませんでした（{}）: {e}",
                    f.display()
                );
            }
        }
        let projects: Vec<(String, String)> = info["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|p| {
                Some((
                    p["id"].as_str()?.to_string(),
                    p["name"].as_str()?.to_string(),
                ))
            })
            .collect();
        let want = c.project.clone().or(target.project.clone());
        let chosen = match &want {
            Some(w) => projects.iter().find(|(id, n)| id == w || n == w),
            None if projects.len() == 1 => projects.first(),
            None => None,
        };
        let Some((pid, pname)) = chosen else {
            let names: Vec<&str> = projects.iter().map(|(_, n)| n.as_str()).collect();
            bail!(
                "プロジェクトを --project で選んでください（{}）",
                names.join("・")
            );
        };
        target.project = Some(pid.clone());
        let hello = json!({
            "type": "hello", "protocol": crate::server::PROTOCOL, "name": name, "agent": true,
            "client_key": saved["client_key"], "session": session,
        });
        let (out, rx) = mpsc::unbounded_channel();
        let sh = Arc::new(Shared {
            st: Mutex::new(State::default()),
            out,
            notify: Notify::new(),
            opts: Opts {
                name,
                instant: c.instant,
                video,
            },
            target,
            hello,
            project_name: pname.clone(),
        });
        tokio::spawn(conn_loop(sh.clone(), rx));
        Ok(Agent(sh))
    }

    /// 条件が成り立つまで待つ（成り立たなければ None）
    async fn wait_for<T>(
        &self,
        limit: Duration,
        mut f: impl FnMut(&mut State) -> Option<T>,
    ) -> Option<T> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let n = self.0.notify.notified();
            tokio::pin!(n);
            n.as_mut().enable();
            if let Some(v) = f(&mut self.0.st.lock().unwrap()) {
                return Some(v);
            }
            if tokio::time::timeout_at(deadline, n).await.is_err() {
                return f(&mut self.0.st.lock().unwrap());
            }
        }
    }

    /// つながっていて、止められていないのを待つ
    async fn ready(&self, limit: Duration) -> Result<(), String> {
        let r = self
            .wait_for(limit, |st| {
                if let Some(f) = &st.fatal {
                    return Some(Err(format!("ホストにつなげません: {f}")));
                }
                (st.connected && st.held.is_none()).then_some(Ok(()))
            })
            .await;
        match r {
            Some(r) => r,
            None => {
                let st = self.0.st.lock().unwrap();
                Err(match &st.held {
                    Some(by) => format!("一時停止中です（{by} さんが止めました）。再開されるまで書き込めません。wait_for_events で再開（resumed）を待つか、しばらくしてからやり直してください"),
                    None => "ホストにつながっていません（つなぎ直しています）。しばらくしてからやり直してください".into(),
                })
            }
        }
    }

    async fn pause(&self, ms: u64) {
        if !self.0.opts.instant && ms > 0 {
            tokio::time::sleep(Duration::from_millis(ms)).await;
        }
    }

    /// 自分の様子を変えて配る
    fn show(&self, f: impl FnOnce(&mut State)) {
        f(&mut self.0.st.lock().unwrap());
        self.0.send_presence();
    }

    /// 変更セットを送って、ホストの返事（ack）を待つ。衝突した op の説明を返す
    async fn commit(&self, ops: Vec<Op>) -> Result<Vec<String>, String> {
        self.ready(READY_WAIT).await?;
        let change = Change { id: uuid_v7(), ops };
        let id = change.id.clone();
        let text = json!({ "type": "change", "change": change }).to_string();
        self.0.st.lock().unwrap().pending.insert(
            id.clone(),
            Pending {
                text: text.clone(),
                change,
                ack: None,
            },
        );
        self.0.send(text);
        let ack = self
            .wait_for(ACK_WAIT, |st| {
                if st.fatal.is_some() {
                    return Some(None);
                }
                st.pending.get(&id).and_then(|p| p.ack.clone()).map(Some)
            })
            .await
            .flatten();
        // 返事が無かったものは取り下げる（あとから勝手に送られないように）
        let held = {
            let mut st = self.0.st.lock().unwrap();
            st.pending.remove(&id);
            st.held.clone()
        };
        let Some(ack) = ack else {
            return Err(match held {
                Some(by) => format!("一時停止中です（{by} さんが止めました）。この変更は入っていません"),
                None => "ホストから返事がありません。この変更は入っていないかもしれません（list_comments で確かめてください）".into(),
            });
        };
        Ok(ack["conflicts"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| {
                let why = match c["reason"].as_str() {
                    Some("modified") => "ほかの人が先に変更していました",
                    Some("deleted") => "ほかの人が先に削除していました",
                    Some("exists") => "同じ id のコメントが既にあります",
                    _ => "衝突しました",
                };
                format!(
                    "{}: {why}（入っていません）",
                    c["id"].as_str().unwrap_or("")
                )
            })
            .collect())
    }

    /// 1件ずつ（多ければまとめて）カーソルを動かしながら送る。items は（見せる位置のコメント、op）
    async fn act(
        &self,
        what: &str,
        items: Vec<(Comment, Op)>,
        select: bool,
    ) -> (usize, Vec<String>, Option<String>) {
        let n = items.len();
        let (chunk, wait) = if self.0.opts.instant {
            (n.max(1), 0)
        } else {
            let chunk = n.div_ceil(ACT_STEPS).max(1);
            (
                chunk,
                (ACT_BUDGET_MS / n.div_ceil(chunk).max(1) as u64).clamp(140, 700),
            )
        };
        let (mut done, mut conflicts) = (0, vec![]);
        for group in items.chunks(chunk) {
            if let Err(e) = self.ready(READY_WAIT).await {
                return (done, conflicts, Some(e));
            }
            let at = &group[0].0;
            self.show(|st| {
                st.t = at.t;
                st.cur = Some(
                    json!({ "a": "tl", "t": at.t, "y": { "g": lane_group(&at.cmd), "l": 0.5 } }),
                );
                st.note = format!("{what} {}/{n}", done + group.len());
                if !select {
                    st.sel = group.iter().map(|(c, _)| c.id.clone()).take(200).collect();
                }
            });
            self.pause(wait * 6 / 10).await;
            match self
                .commit(group.iter().map(|(_, op)| op.clone()).collect())
                .await
            {
                Ok(c) => conflicts.extend(c),
                Err(e) => return (done, conflicts, Some(e)),
            }
            done += group.len();
            self.show(|st| {
                st.sel = if select {
                    group.iter().map(|(c, _)| c.id.clone()).take(200).collect()
                } else {
                    vec![]
                };
            });
            self.pause(wait * 4 / 10).await;
        }
        self.show(|st| st.note.clear());
        (done, conflicts, None)
    }

    /// 道具を呼ぶ（MCP からも手動からも、ここを通る）
    pub async fn call(&self, name: &str, args: &Value) -> Out {
        match name {
            "status" => self.tool_status(),
            "list_comments" => self.tool_list(args),
            "add_comments" => self.tool_add(args).await,
            "update_comments" => self.tool_update(args).await,
            "delete_comments" => self.tool_delete(args).await,
            "look" => self.tool_look(args).await,
            "wait_for_events" => self.tool_wait(args).await,
            "get_frames" => self.tool_frames(args).await,
            "get_clip" => self.tool_clip(args).await,
            _ => Out::err(format!("道具「{name}」はありません")),
        }
    }

    fn tool_status(&self) -> Out {
        let st = self.0.st.lock().unwrap();
        let peers: Vec<Value> = st
            .peers
            .iter()
            .filter(|p| p.id != st.me)
            .map(|p| {
                let s = st.presence.get(&p.id);
                let sel: Vec<Value> = s
                    .and_then(|s| s["sel"].as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|id| st.store.get(id.as_str()?))
                    .take(50)
                    .map(comment_json)
                    .collect();
                json!({
                    "name": p.name, "agent": p.agent, "paused": p.held.is_some(),
                    "playhead": s.and_then(|s| s["t"].as_f64()), "playing": s.map(|s| s["playing"] == json!(true)),
                    "selected": sel, "video_duration": s.and_then(|s| s["video"]["d"].as_f64()),
                })
            })
            .collect();
        let v = &self.0.opts.video;
        Out::ok(
            json!({
                "connected": st.connected, "error": st.fatal,
                "you": if st.my_name.is_empty() { &self.0.opts.name } else { &st.my_name },
                "project": self.0.project_name,
                "paused_by": st.held,
                "comments": st.store.len(),
                "your_playhead": st.t, "your_selection": st.sel,
                "video": v.as_ref().map(|v| json!({ "file": v.path.file_name().map(|n| n.to_string_lossy()), "duration": v.duration })),
                "participants": peers,
            })
            .to_string(),
        )
    }

    fn tool_list(&self, args: &Value) -> Out {
        let st = self.0.st.lock().unwrap();
        let from = time_arg(&args["from"]).unwrap_or(0.0);
        let to = time_arg(&args["to"]).unwrap_or(f64::INFINITY);
        let q = args["query"].as_str().unwrap_or("").to_lowercase();
        let limit = args["limit"].as_u64().unwrap_or(300).clamp(1, 5000) as usize;
        let hits: Vec<&Comment> = st
            .store
            .sorted()
            .into_iter()
            .filter(|c| c.t >= from && c.t <= to)
            .filter(|c| {
                q.is_empty()
                    || c.text.to_lowercase().contains(&q)
                    || c.cmd.to_lowercase().contains(&q)
            })
            .collect();
        let mut out: Vec<String> = hits
            .iter()
            .take(limit)
            .map(|c| comment_json(c).to_string())
            .collect();
        if hits.len() > limit {
            out.push(format!("（{} 件のうち先頭の {limit} 件。from・to・query で絞るか、limit を増やしてください）", hits.len()));
        }
        if out.is_empty() {
            out.push("（当てはまるコメントはありません）".into());
        }
        Out::ok(out.join("\n"))
    }

    async fn tool_add(&self, args: &Value) -> Out {
        let Some(list) = args["comments"].as_array().filter(|l| !l.is_empty()) else {
            return Out::err("comments（[{t, text, cmd?}]）を指定してください");
        };
        if list.len() > ITEMS_MAX {
            return Out::err(format!("一度に足せるのは {ITEMS_MAX} 件までです"));
        }
        let mut items = vec![];
        for (i, c) in list.iter().enumerate() {
            let Some(t) = time_arg(&c["t"]) else {
                return Out::err(format!("{} 件目: t（秒か \"1:23.45\"）を読めません", i + 1));
            };
            let text = norm_text(c["text"].as_str().unwrap_or(""));
            if text.trim().is_empty() {
                return Out::err(format!("{} 件目: text が空です", i + 1));
            }
            let cmd = norm_cmd(c["cmd"].as_str().unwrap_or(""));
            if cmd.len() > 1000 {
                return Out::err(format!("{} 件目: cmd が長すぎます", i + 1));
            }
            let c = Comment {
                id: uuid_v7(),
                t,
                cmd,
                text,
            };
            let op = Op::Add {
                id: c.id.clone(),
                after: Fields::of(&c),
            };
            items.push((c, op));
        }
        let added: Vec<Value> = items
            .iter()
            .map(|(c, _)| json!({ "id": c.id, "t": c.t }))
            .collect();
        let (done, conflicts, stopped) = self.act("コメントを追加中", items, true).await;
        report(
            "追加",
            done,
            added.len(),
            &added[..done],
            conflicts,
            stopped,
        )
    }

    async fn tool_update(&self, args: &Value) -> Out {
        let Some(list) = args["updates"].as_array().filter(|l| !l.is_empty()) else {
            return Out::err("updates（[{id, t?, cmd?, text?}]）を指定してください");
        };
        if list.len() > ITEMS_MAX {
            return Out::err(format!("一度に変えられるのは {ITEMS_MAX} 件までです"));
        }
        let mut items = vec![];
        {
            let st = self.0.st.lock().unwrap();
            for (i, u) in list.iter().enumerate() {
                let cur = match st.find(u["id"].as_str().unwrap_or("")) {
                    Ok(c) => c,
                    Err(e) => return Out::err(format!("{} 件目: {e}", i + 1)),
                };
                let (mut before, mut after, mut next) =
                    (Fields::default(), Fields::default(), cur.clone());
                if !u["t"].is_null() {
                    let Some(t) = time_arg(&u["t"]) else {
                        return Out::err(format!("{} 件目: t を読めません", i + 1));
                    };
                    if t != cur.t {
                        (before.t, after.t, next.t) = (Some(cur.t), Some(t), t);
                    }
                }
                if let Some(cmd) = u["cmd"].as_str().map(norm_cmd) {
                    if cmd != cur.cmd {
                        (before.cmd, after.cmd, next.cmd) =
                            (Some(cur.cmd.clone()), Some(cmd.clone()), cmd);
                    }
                }
                if let Some(text) = u["text"].as_str().map(norm_text) {
                    if text.trim().is_empty() {
                        return Out::err(format!(
                            "{} 件目: text が空です（消すなら delete_comments）",
                            i + 1
                        ));
                    }
                    if text != cur.text {
                        (before.text, after.text, next.text) =
                            (Some(cur.text.clone()), Some(text.clone()), text);
                    }
                }
                if after != Fields::default() {
                    items.push((
                        next,
                        Op::Update {
                            id: cur.id.clone(),
                            before,
                            after,
                        },
                    ));
                }
            }
        }
        if items.is_empty() {
            return Out::ok("変わるところがありませんでした");
        }
        let ids: Vec<Value> = items
            .iter()
            .map(|(c, _)| json!({ "id": c.id, "t": c.t }))
            .collect();
        let (done, conflicts, stopped) = self.act("コメントを変更中", items, true).await;
        report("変更", done, ids.len(), &ids[..done], conflicts, stopped)
    }

    async fn tool_delete(&self, args: &Value) -> Out {
        let Some(list) = args["ids"].as_array().filter(|l| !l.is_empty()) else {
            return Out::err("ids（[id, …]）を指定してください");
        };
        if list.len() > ITEMS_MAX {
            return Out::err(format!("一度に消せるのは {ITEMS_MAX} 件までです"));
        }
        let mut items: Vec<(Comment, Op)> = vec![];
        {
            let st = self.0.st.lock().unwrap();
            for id in list {
                match st.find(id.as_str().unwrap_or("")) {
                    Ok(c) if items.iter().any(|(x, _)| x.id == c.id) => {}
                    Ok(c) => {
                        let op = Op::Delete {
                            id: c.id.clone(),
                            before: Fields::of(&c),
                        };
                        items.push((c, op));
                    }
                    Err(e) => return Out::err(e),
                }
            }
        }
        let ids: Vec<Value> = items
            .iter()
            .map(|(c, _)| json!({ "id": c.id, "t": c.t }))
            .collect();
        // 消す前に、消すものを選んで見せる
        let (done, conflicts, stopped) = self.act("コメントを削除中", items, false).await;
        report("削除", done, ids.len(), &ids[..done], conflicts, stopped)
    }

    async fn tool_look(&self, args: &Value) -> Out {
        let t = match &args["t"] {
            Value::Null => None,
            v => match time_arg(v) {
                Some(t) => Some(t),
                None => return Out::err("t（秒か \"1:23.45\"）を読めません"),
            },
        };
        let mut sel = vec![];
        {
            let st = self.0.st.lock().unwrap();
            for id in args["select"].as_array().into_iter().flatten() {
                match st.find(id.as_str().unwrap_or("")) {
                    Ok(c) => sel.push(c),
                    Err(e) => return Out::err(e),
                }
            }
        }
        // 時刻が無ければ、選んだコメントの先頭へ
        let t = t.or(sel.first().map(|c| c.t));
        let note = args["note"].as_str().map(|s| clip_chars(s.trim(), 60));
        let has_sel = !args["select"].is_null();
        self.show(|st| {
            if let Some(t) = t {
                st.t = t;
                let g = sel.first().map_or(1, |c| lane_group(&c.cmd));
                st.cur = Some(json!({ "a": "tl", "t": t, "y": { "g": g, "l": 0.5 } }));
            }
            if has_sel {
                st.sel = sel.iter().map(|c| c.id.clone()).take(200).collect();
            }
            if let Some(n) = note {
                st.note = n;
            }
        });
        let mut said = String::new();
        if args["call"].as_bool() == Some(true) {
            let st = self.0.st.lock().unwrap();
            self.0
                .send(json!({ "type": "call", "state": { "t": st.t, "sel": st.sel } }).to_string());
            said = "。ほかの参加者に「ここ見て」を送りました".into();
        }
        self.pause(350).await;
        let st = self.0.st.lock().unwrap();
        Out::ok(format!(
            "再生位置 {}・選択 {} 件{said}",
            fmt_time(st.t),
            st.sel.len()
        ))
    }

    async fn tool_wait(&self, args: &Value) -> Out {
        let limit = args["timeout"].as_f64().unwrap_or(30.0).clamp(0.0, 50.0);
        let got = self
            .wait_for(Duration::from_secs_f64(limit), |st| {
                (!st.events.is_empty()).then(|| st.events.drain(..).collect::<Vec<_>>())
            })
            .await;
        match got {
            Some(ev) => Out::ok(
                ev.iter()
                    .map(Value::to_string)
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            None => Out::ok("（何も起きませんでした）"),
        }
    }

    async fn tool_frames(&self, args: &Value) -> Out {
        let Some(video) = &self.0.opts.video else {
            return Out::err("動画が指定されていません（komenagare mcp を --video 動画ファイル 付きで起動してください）");
        };
        let Some(from) = time_arg(&args["from"]).or(time_arg(&args["t"])) else {
            return Out::err("from（秒か \"1:23.45\"）を指定してください");
        };
        let to = time_arg(&args["to"]).unwrap_or(from).max(from);
        let count = match args["count"].as_u64() {
            Some(n) => n.clamp(1, FRAMES_MAX),
            None if to > from => 6,
            None => 1,
        };
        let width = args["width"].as_u64().unwrap_or(640).clamp(64, 1920);
        self.show(|st| {
            st.t = from;
            st.note = "動画を見ています".into();
        });
        let mut out = Out::ok(String::new());
        let mut times = vec![];
        for i in 0..count {
            // 範囲なら等間隔に（両端を含む）
            let t = if count == 1 {
                from
            } else {
                from + (to - from) * i as f64 / (count - 1) as f64
            };
            match video.frame(t, width).await {
                Ok(data) => {
                    out.media.push(Media::Jpeg(data));
                    times.push(fmt_time(t));
                    self.show(|st| st.t = t);
                }
                Err(e) if out.media.is_empty() => return Out::err(format!("{e:#}")),
                Err(_) => break,
            }
        }
        self.show(|st| st.note.clear());
        out.text = format!("{} 枚のコマ（順に {}）", times.len(), times.join("、"));
        out
    }

    async fn tool_clip(&self, args: &Value) -> Out {
        let Some(video) = &self.0.opts.video else {
            return Out::err("動画が指定されていません（komenagare mcp を --video 動画ファイル 付きで起動してください）");
        };
        let (Some(from), Some(to)) = (time_arg(&args["from"]), time_arg(&args["to"])) else {
            return Out::err("from と to（秒か \"1:23.45\"）を指定してください");
        };
        if to <= from || to - from > CLIP_MAX {
            return Out::err(format!(
                "範囲は from < to で、{CLIP_MAX} 秒までにしてください"
            ));
        }
        let height = args["height"].as_u64().unwrap_or(360).clamp(120, 1080);
        let audio = args["audio"].as_bool() != Some(false);
        let embed = args["embed"].as_bool() == Some(true);
        self.show(|st| {
            st.t = from;
            st.note = "動画を見ています".into();
        });
        let r = video.clip(from, to, height, audio).await;
        self.show(|st| st.note.clear());
        let path = match r {
            Ok(p) => p,
            Err(e) => return Out::err(format!("{e:#}")),
        };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let mut out = Out::ok(format!(
            "{}〜{} を切り出しました: {}（{} kB、高さ {height}px まで、音声{}）",
            fmt_time(from),
            fmt_time(to),
            path.display(),
            size.div_ceil(1000),
            if audio { "あり" } else { "なし" }
        ));
        if embed && size > EMBED_MAX {
            out.text += "。大きいので結果には埋め込みませんでした（範囲を短くするか height を下げてください）";
        }
        out.media.push(Media::Video {
            path,
            embed: embed && size <= EMBED_MAX,
        });
        out
    }
}

fn report(
    what: &str,
    done: usize,
    total: usize,
    ids: &[Value],
    conflicts: Vec<String>,
    stopped: Option<String>,
) -> Out {
    let mut lines = vec![format!(
        "{what}: {} 件",
        done.saturating_sub(conflicts.len())
    )];
    lines.extend(ids.iter().map(Value::to_string));
    if !conflicts.is_empty() {
        lines.push(format!("衝突: {} 件", conflicts.len()));
        lines.extend(conflicts);
    }
    if let Some(e) = &stopped {
        lines.push(format!(
            "途中で止まりました（{done}/{total} 件まで送りました）: {e}"
        ));
    }
    Out {
        text: lines.join("\n"),
        error: stopped.is_some(),
        media: vec![],
    }
}

/* ---------- MCP（標準入出力の JSON-RPC） ---------- */

const INSTRUCTIONS: &str = "コメナガレ（動画に流れるコメントを付ける共同編集ツール）に、参加者の1人としてつながっています。\
あなたのカーソル・再生位置・選択は、ほかの参加者の画面に名前付きで出ます。\
まず status で様子（だれが何を選んでいるか）を見て、list_comments で今のコメントを読んでください。\
時刻は秒（小数可）か \"1:23.45\" の形です。コマンド（cmd）はニコニコ動画と同じで、位置 ue/naka/shita、大きさ big/medium/small、色 red・#RRGGBB など、表示時間 @秒 を空白で区切って並べます（省略すると白・流れる）。\
動画の中身は get_frames（画像）か get_clip（動画ファイル）で見られます（--video を付けて起動したとき）。\
管理者は、あなたを一時停止できます。その間は書き込めません（読むことはできます）。止められたら、無理に続けずに待ってください。";

fn tools() -> Value {
    let time =
        json!({ "type": ["number", "string"], "description": "時刻（秒。または \"1:23.45\"）" });
    json!([
        { "name": "status", "description": "つながっているプロジェクト、自分の名前、一時停止中か、ほかの参加者の様子（再生位置・選んでいるコメント）を返す。「いま選んでいるコメント」を知りたいときに使う",
          "inputSchema": { "type": "object", "properties": {} } },
        { "name": "list_comments", "description": "コメントを時刻の順に返す（1行1件の JSON: id, t, time, cmd, text）",
          "inputSchema": { "type": "object", "properties": {
            "from": time, "to": time,
            "query": { "type": "string", "description": "本文かコマンドに含まれる文字で絞る" },
            "limit": { "type": "integer", "description": "返す件数の上限（既定 300）" } } } },
        { "name": "add_comments", "description": "コメントを足す。足したコメントの id を返す。カーソルを動かしながら順に足すので、件数が多いと数秒かかる",
          "inputSchema": { "type": "object", "required": ["comments"], "properties": {
            "comments": { "type": "array", "items": { "type": "object", "required": ["t", "text"], "properties": {
              "t": time, "text": { "type": "string" },
              "cmd": { "type": "string", "description": "例: \"ue red big\"。省略すると白・流れる" } } } } } } },
        { "name": "update_comments", "description": "コメントの時刻・コマンド・本文を変える（変える項目だけ指定する）。ほかの人が先に同じ項目を変えていたら衝突として返り、その項目は変わらない",
          "inputSchema": { "type": "object", "required": ["updates"], "properties": {
            "updates": { "type": "array", "items": { "type": "object", "required": ["id"], "properties": {
              "id": { "type": "string" }, "t": time, "cmd": { "type": "string" }, "text": { "type": "string" } } } } } } },
        { "name": "delete_comments", "description": "コメントを消す",
          "inputSchema": { "type": "object", "required": ["ids"], "properties": {
            "ids": { "type": "array", "items": { "type": "string" } } } } },
        { "name": "look", "description": "自分の再生位置と選択を動かして、ほかの参加者に見せる（「追いかける」にしている人の画面はそこへ移る）。call を付けると「ここ見て」を全員に知らせる",
          "inputSchema": { "type": "object", "properties": {
            "t": time,
            "select": { "type": "array", "items": { "type": "string" }, "description": "選ぶコメントの id（空の配列で選択を外す）" },
            "call": { "type": "boolean", "description": "「ここ見て」を送る（多用しない）" },
            "note": { "type": "string", "description": "参加者の一覧に出す、いましていることの短い説明" } } } },
        { "name": "wait_for_events", "description": "ほかの参加者の変更（change）・「ここ見て」（call）・一時停止と再開（paused / resumed）を待って返す。前に呼んだあとに起きたものが溜まっていれば、すぐ返す",
          "inputSchema": { "type": "object", "properties": {
            "timeout": { "type": "number", "description": "待つ秒数（既定 30、最大 50）" } } } },
        { "name": "get_frames", "description": "動画のコマを画像で返す。from だけならその時刻の1枚、to も付けるとその範囲を等間隔に count 枚（既定 6、最大 16）",
          "inputSchema": { "type": "object", "required": ["from"], "properties": {
            "from": time, "to": time,
            "count": { "type": "integer" },
            "width": { "type": "integer", "description": "画像の幅（既定 640）" } } } },
        { "name": "get_clip", "description": "動画の範囲を切り出して、小さな mp4 ファイルにして場所（パス）を返す。動画を読める AI 向け。embed を付けると結果に動画そのものも入れる（大きいので短い範囲で）",
          "inputSchema": { "type": "object", "required": ["from", "to"], "properties": {
            "from": time, "to": time,
            "height": { "type": "integer", "description": "高さの上限（既定 360）" },
            "audio": { "type": "boolean", "description": "音声を入れる（既定 true）" },
            "embed": { "type": "boolean", "description": "結果に動画を埋め込む（既定 false）" } } } },
    ])
}

fn mcp_content(out: Out) -> Value {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut content = vec![];
    if !out.text.is_empty() {
        content.push(json!({ "type": "text", "text": out.text }));
    }
    for m in out.media {
        match m {
            Media::Jpeg(data) => content.push(
                json!({ "type": "image", "mimeType": "image/jpeg", "data": b64.encode(data) }),
            ),
            Media::Video { path, embed: true } => {
                if let Ok(data) = std::fs::read(&path) {
                    content.push(json!({ "type": "resource", "resource": {
                        "uri": format!("file://{}", path.display()), "mimeType": "video/mp4", "blob": b64.encode(data) } }));
                }
            }
            Media::Video { .. } => {}
        }
    }
    json!({ "content": content, "isError": out.error })
}

/// 標準入出力で MCP のサーバーとして動く（標準出力には JSON-RPC だけを書く）
pub async fn serve(agent: Agent) -> Result<()> {
    let stdout = Arc::new(tokio::sync::Mutex::new(tokio::io::stdout()));
    let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(req) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = req["id"].clone();
        let (agent, stdout) = (agent.clone(), stdout.clone());
        // 待つ道具（wait_for_events）の間もほかの呼び出しに答えられるよう、1通ずつ別に動かす
        tokio::spawn(async move {
            let result: Result<Value, (i64, String)> = match req["method"].as_str().unwrap_or("") {
                "initialize" => Ok(json!({
                    "protocolVersion": req["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "komenagare", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                })),
                "ping" => Ok(json!({})),
                "tools/list" => Ok(json!({ "tools": tools() })),
                "tools/call" => {
                    let name = req["params"]["name"].as_str().unwrap_or("").to_string();
                    let args = req["params"]["arguments"].clone();
                    Ok(mcp_content(agent.call(&name, &args).await))
                }
                m => Err((-32601, format!("method not found: {m}"))),
            };
            // id の無いもの（通知）には答えない
            if id.is_null() {
                return;
            }
            let msg = match result {
                Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
                Err((code, message)) => {
                    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
                }
            };
            let mut out = stdout.lock().await;
            let _ = out.write_all(format!("{msg}\n").as_bytes()).await;
            let _ = out.flush().await;
        });
    }
    Ok(())
}

/* ---------- 手動（--manual / --script） ---------- */

const MANUAL_HELP: &str = "\
AI と同じ道具を、1行ずつ手で呼びます。時刻は秒か 1:23.45。
  status                              様子（参加者・選択・一時停止）
  list [from] [to]                    コメントの一覧
  add <時刻> [コマンド…] | <本文>     コメントを足す（例: add 1:23 ue red | わこつ）
  edit <id> <時刻|-> [コマンド…] [| <本文>]  コメントを変える（- は時刻そのまま。コマンド・本文は書いたものだけ変える）
  del <id>…                           コメントを消す（id は先頭か末尾の数文字でもよい）
  look <時刻> [id…]                   再生位置と選択を動かす
  call <時刻> [id…]                   「ここ見て」を送る
  wait [秒]                           ほかの人の変更・「ここ見て」・一時停止を待つ
  frames <from> [to] [枚数]           動画のコマを画像で取り出す（--video）
  clip <from> <to>                    動画の範囲を切り出す（--video）
  sleep <秒>                          待つ（台本用）
  <道具の名前> <JSON>                 道具をそのまま呼ぶ（例: add_comments {\"comments\":[{\"t\":1,\"text\":\"a\"}]}）
  quit";

/// 手動の1行を、道具の名前と引数にする（AI が呼ぶのと同じ形）
pub fn parse_manual(line: &str) -> Result<(String, Value), String> {
    let line = line.trim();
    let (word, rest) = line.split_once(char::is_whitespace).unwrap_or((line, ""));
    let rest = rest.trim();
    let words: Vec<&str> = rest.split_whitespace().collect();
    let need = |i: usize, what: &str| {
        words
            .get(i)
            .copied()
            .ok_or(format!("{what}を指定してください（help で使い方）"))
    };
    // 「コマンド… | 本文」
    let cmd_text = |s: &str| -> (String, Option<String>) {
        match s.split_once('|') {
            Some((c, t)) => (norm_cmd(c), Some(t.trim().replace("\\n", "\n"))),
            None => (norm_cmd(s), None),
        }
    };
    Ok(match word {
        // 引数が JSON なら、道具をそのまま呼ぶ（look のように、短い書き方と同じ名前の道具がある）
        name if rest.starts_with('{') => {
            let args = serde_json::from_str::<Value>(rest)
                .map_err(|e| format!("引数の JSON を読めません: {e}"))?;
            (name.to_string(), args)
        }
        "status" => ("status".into(), json!({})),
        "list" => {
            let mut a = json!({});
            if let Some(f) = words.first() {
                a["from"] = json!(f);
            }
            if let Some(t) = words.get(1) {
                a["to"] = json!(t);
            }
            ("list_comments".into(), a)
        }
        "add" => {
            let t = need(0, "時刻")?;
            let (cmd, text) = cmd_text(rest[t.len()..].trim());
            let text = text
                .filter(|t| !t.is_empty())
                .ok_or("本文を「| 本文」の形で指定してください")?;
            (
                "add_comments".into(),
                json!({ "comments": [{ "t": t, "cmd": cmd, "text": text }] }),
            )
        }
        "edit" => {
            let (id, t) = (need(0, "id")?, need(1, "時刻（そのままなら -）")?);
            let tail = rest[id.len()..].trim()[t.len()..].trim();
            let (cmd, text) = cmd_text(tail);
            let mut u = json!({ "id": id });
            if t != "-" {
                u["t"] = json!(t);
            }
            if !cmd.is_empty() {
                u["cmd"] = json!(cmd);
            }
            if let Some(text) = text {
                u["text"] = json!(text);
            }
            ("update_comments".into(), json!({ "updates": [u] }))
        }
        "del" => {
            need(0, "id")?;
            ("delete_comments".into(), json!({ "ids": words }))
        }
        "look" | "call" => {
            let t = need(0, "時刻")?;
            let mut a = json!({ "t": t });
            if words.len() > 1 {
                a["select"] = json!(words[1..]);
            }
            if word == "call" {
                a["call"] = json!(true);
            }
            ("look".into(), a)
        }
        "wait" => {
            let mut a = json!({});
            if let Some(s) = words.first().and_then(|s| s.parse::<f64>().ok()) {
                a["timeout"] = json!(s);
            }
            ("wait_for_events".into(), a)
        }
        "frames" => {
            let mut a = json!({ "from": need(0, "時刻")? });
            if let Some(to) = words.get(1) {
                a["to"] = json!(to);
                if let Some(n) = words.get(2).and_then(|n| n.parse::<u64>().ok()) {
                    a["count"] = json!(n);
                }
            }
            ("get_frames".into(), a)
        }
        "clip" => (
            "get_clip".into(),
            json!({ "from": need(0, "from")?, "to": need(1, "to")? }),
        ),
        // 道具をそのまま呼ぶ
        name => {
            let args = if rest.is_empty() {
                json!({})
            } else {
                serde_json::from_str::<Value>(rest)
                    .map_err(|e| format!("引数の JSON を読めません: {e}"))?
            };
            (name.to_string(), args)
        }
    })
}

/// 標準入力（--manual）か台本（--script）から1行ずつ読んで道具を呼ぶ。台本は、失敗した行があればエラーで終わる
pub async fn manual(agent: Agent, script: Option<&Path>, media_dir: Option<&Path>) -> Result<()> {
    let mut lines: Box<dyn tokio::io::AsyncBufRead + Unpin + Send> = match script {
        Some(p) => Box::new(tokio::io::BufReader::new(
            tokio::fs::File::open(p)
                .await
                .with_context(|| format!("台本を開けません: {}", p.display()))?,
        )),
        None => Box::new(tokio::io::BufReader::new(tokio::io::stdin())),
    };
    let dir = media_dir.map(Path::to_path_buf).unwrap_or_else(|| {
        std::env::temp_dir().join(format!("komenagare-mcp-{}", std::process::id()))
    });
    // つながるのを待つ
    if let Err(e) = agent.ready(Duration::from_secs(20)).await {
        let held = agent.0.st.lock().unwrap().held.is_some();
        if !held {
            bail!("{e}");
        }
    }
    {
        let st = agent.0.st.lock().unwrap();
        eprintln!(
            "「{}」として {} につながりました（コメント {} 件）。help で使い方",
            st.my_name,
            agent.0.project_name,
            st.store.len()
        );
    }
    let (mut failed, mut frame_no) = (0, 0);
    let mut line = String::new();
    loop {
        line.clear();
        if lines.read_line(&mut line).await? == 0 {
            break;
        }
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        if script.is_some() {
            println!("> {l}");
        }
        match l.split_whitespace().next().unwrap_or("") {
            "quit" | "exit" => break,
            "help" | "?" => {
                println!("{MANUAL_HELP}");
                continue;
            }
            "sleep" => {
                let s = l
                    .split_whitespace()
                    .nth(1)
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(1.0);
                tokio::time::sleep(Duration::from_secs_f64(s.clamp(0.0, 3600.0))).await;
                continue;
            }
            _ => {}
        }
        let out = match parse_manual(l) {
            Ok((name, args)) => agent.call(&name, &args).await,
            Err(e) => Out::err(e),
        };
        if out.error {
            failed += 1;
            println!("エラー: {}", out.text);
        } else {
            println!("{}", out.text);
        }
        for m in out.media {
            if let Media::Jpeg(data) = m {
                frame_no += 1;
                let p = dir.join(format!("frame-{frame_no:03}.jpg"));
                match std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(&p, data)) {
                    Ok(()) => println!("  {}", p.display()),
                    Err(e) => println!("  画像を保存できませんでした: {e}"),
                }
            }
        }
    }
    // 送った presence などが届くのを少し待つ
    tokio::time::sleep(Duration::from_millis(200)).await;
    if script.is_some() && failed > 0 {
        return Err(anyhow!("{failed} 行が失敗しました"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_from_url() {
        let t = Target::parse("http://127.0.0.1:8764/?k=abc%2B1&p=0195-x#t=3").unwrap();
        assert_eq!(t.authority, "127.0.0.1:8764");
        assert_eq!(t.token.as_deref(), Some("abc+1"));
        assert_eq!(t.project.as_deref(), Some("0195-x"));
        assert_eq!(t.ws(), "ws://127.0.0.1:8764/ws?p=0195-x&k=abc%2B1");
        assert_eq!(
            t.http("/api/projects"),
            "http://127.0.0.1:8764/api/projects?k=abc%2B1"
        );
        let t = Target::parse("https://example.trycloudflare.com").unwrap();
        assert!(t.tls && t.token.is_none());
        assert_eq!(t.ws(), "wss://example.trycloudflare.com/ws?");
        assert!(Target::parse("example.com").is_err());
        assert!(Target::parse("ftp://example.com").is_err());
        assert!(Target::parse("http://user@example.com").is_err());
    }

    #[test]
    fn times_and_commands() {
        assert_eq!(time_arg(&json!(12.345)), Some(12.35));
        assert_eq!(time_arg(&json!("1:23.5")), Some(83.5));
        assert_eq!(time_arg(&json!(-1)), None);
        assert_eq!(time_arg(&json!(1e9)), None);
        assert_eq!(time_arg(&json!(null)), None);
        assert_eq!(norm_cmd("  ue   red "), "ue red");
        assert_eq!(norm_text("a\r\nb\rc"), "a\nb\nc");
        assert_eq!(
            (
                lane_group("ue red"),
                lane_group("big"),
                lane_group("red shita")
            ),
            (0, 1, 2)
        );
        assert_eq!(fmt_time(83.456), "1:23.46");
    }

    #[test]
    fn manual_lines() {
        let p = |l| parse_manual(l).unwrap();
        assert_eq!(
            p("add 1:23 ue red | わこつ | です"),
            (
                "add_comments".into(),
                json!({ "comments": [{ "t": "1:23", "cmd": "ue red", "text": "わこつ | です" }] })
            )
        );
        assert_eq!(p("add 5 | a\\nb").1["comments"][0]["text"], json!("a\nb"));
        assert!(parse_manual("add 5 ue").is_err() && parse_manual("add").is_err());
        assert_eq!(
            p("edit 0195 - shita | 直した").1,
            json!({ "updates": [{ "id": "0195", "cmd": "shita", "text": "直した" }] })
        );
        assert_eq!(
            p("edit 0195 12.5").1,
            json!({ "updates": [{ "id": "0195", "t": "12.5" }] })
        );
        assert_eq!(p("del a1b2 c3d4").1, json!({ "ids": ["a1b2", "c3d4"] }));
        assert_eq!(
            p("call 10 a1b2").1,
            json!({ "t": "10", "select": ["a1b2"], "call": true })
        );
        assert_eq!(
            p("frames 10 20 4").1,
            json!({ "from": "10", "to": "20", "count": 4 })
        );
        assert_eq!(p("look {\"t\":3}"), ("look".into(), json!({ "t": 3 })));
        assert!(parse_manual("look {oops").is_err());
    }

    /// ほかの人の変更・自分の変更の返事・一時停止が、手元の状態に正しく当たる
    #[test]
    fn messages_update_state() {
        let (out, _rx) = mpsc::unbounded_channel();
        let sh = Shared {
            st: Mutex::new(State::default()),
            out,
            notify: Notify::new(),
            opts: Opts {
                name: "AI".into(),
                instant: true,
                video: None,
            },
            target: Target::parse("http://localhost:1").unwrap(),
            hello: json!({}),
            project_name: "p".into(),
        };
        sh.on_message(&json!({ "type": "snapshot", "you": 7, "name": "AI", "comments": [{ "id": "a", "t": 1.0, "cmd": "", "text": "x" }] }).to_string());
        assert!(sh.st.lock().unwrap().connected);
        // ほかの人の変更
        sh.on_message(&json!({ "type": "change", "author": "たろう", "change": { "id": "c1", "ops": [
            { "type": "update", "id": "a", "before": { "text": "x" }, "after": { "text": "y" } }] } }).to_string());
        {
            let mut st = sh.st.lock().unwrap();
            assert_eq!(st.store.get("a").unwrap().text, "y");
            assert_eq!(
                st.events.pop_front().unwrap()["updated"][0]["was"]["text"],
                json!("x")
            );
        }
        // 自分の変更は ack で手元に入る。衝突したものは fix の値にそろえる
        let change = Change {
            id: "m1".into(),
            ops: vec![
                Op::Add {
                    id: "b".into(),
                    after: Fields {
                        t: Some(2.0),
                        cmd: Some(String::new()),
                        text: Some("z".into()),
                    },
                },
                Op::Delete {
                    id: "a".into(),
                    before: Fields {
                        t: Some(1.0),
                        cmd: Some(String::new()),
                        text: Some("y".into()),
                    },
                },
            ],
        };
        sh.st.lock().unwrap().pending.insert(
            "m1".into(),
            Pending {
                text: "T".into(),
                change,
                ack: None,
            },
        );
        // 一時停止: 断られた変更は、再開されたら送り直す
        sh.on_message(&json!({ "type": "held", "id": "m1", "by": "たろう" }).to_string());
        let r = sh.on_message(&json!({ "type": "peers", "peers": [{ "id": 7, "name": "AI", "agent": true, "held": "たろう" }] }).to_string());
        assert!(!r.contains(&"T".to_string()));
        assert_eq!(sh.st.lock().unwrap().held.as_deref(), Some("たろう"));
        let r = sh.on_message(&json!({ "type": "peers", "peers": [{ "id": 7, "name": "AI", "agent": true, "held": null }] }).to_string());
        assert!(r.contains(&"T".to_string()));
        sh.on_message(&json!({ "type": "ack", "id": "m1", "conflicts": [{ "id": "a", "reason": "modified", "fields": ["text"] }],
            "fix": [{ "id": "a", "comment": { "id": "a", "t": 1.0, "cmd": "", "text": "w" } }] }).to_string());
        let st = sh.st.lock().unwrap();
        assert!(st.held.is_none() && st.pending["m1"].ack.is_some());
        assert_eq!(st.store.get("b").unwrap().text, "z");
        assert_eq!(st.store.get("a").unwrap().text, "w");
        let kinds: Vec<&str> = st
            .events
            .iter()
            .filter_map(|e| e["kind"].as_str())
            .collect();
        assert_eq!(kinds, ["paused", "resumed"]);
    }
}
