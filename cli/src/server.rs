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
//!   GET  /api/projects                   {"auth","me":{name,admin}|null,"projects":[{"id","name","peers":[名前]}],
//!                                         "manage":bool,"hidden":[フォルダの名前]}（manage はプロジェクトを作る・外すことができるか。
//!                                         まとめフォルダで起動したときだけ。--otp なら管理者、それ以外は入れる人みんな）
//!   POST /api/projects {"name","by"}     まとめフォルダにプロジェクトを作る（同じ名前の外したフォルダなら戻す）{"id","name"}
//!   POST /api/projects/remove {"id","by"} プロジェクトを外す（フォルダとコメントは残す。つながっている人は切る）
//!   POST /api/login {"code"}             {"token","name","admin"}（--otp のとき）
//!   GET  /api/me / POST /api/logout      セッションの確認・ログアウト
//!   GET  /api/admin/auth                 {"sessions":[...],"otps":[...]}（管理者のみ）
//!   POST /api/admin/otp {"name","kind":"numeric"|"random","ttl"(秒),"admin"} {"code","expires"}
//!   POST /api/admin/revoke {"id"}        セッションかワンタイムパスワードを取り消す（つながっていれば切る）
//!
//! WebSocket: クライアント → サーバー（hello を最初に送る。それまでほかは受け付けない）
//!   {"type":"hello","protocol":9,"name":"表示名","client_key":"ブラウザごとの秘密（16進 64 文字）","session":"…"(--otp のとき),
//!    "since":N,"epoch":"…"(つなぎ直しのとき)}
//!     ブラウザごとの id（client）はホストが client_key のハッシュから作る。秘密は配らないので、他人の id は名乗れない
//!     since・epoch は、前の接続で最後に受け取った通し番号と、そのときのホストの起動ごとの id。同じ起動のホストで、
//!     そこからの変更が最近の記録に全部残っていれば、snapshot に全体ではなくそれ以降の変更だけを入れて返す
//!   {"type":"change","change":{変更セット}}
//!   {"type":"history","limit":N}                             最近の変更を求める
//!   {"type":"presence","state":{...}}                        自分の再生位置・選択・カーソルなど（ほかの人に配るだけ）
//!   {"type":"call","state":{"t":秒,"sel":[...]}}             「ここ見て」（ほかの人に一度だけ配る。覚えない）
//!   {"type":"ping"}                                          生きているかの確認（pong が返る）。何も届かない接続は切る
//!   {"type":"conflict_add","conflicts":[{"key":..,...}]}     「あとで」にした衝突を全員に見せる
//!   {"type":"conflict_done","keys":[...]}                    衝突を解決した（一覧から外す）
//!   {"type":"run","id":"…","line":"git status"}              ホストの作業フォルダでコマンドを打つ（--remote。許された人だけ。1つずつ）
//!   {"type":"run_stop","id":"…"}                             動いているコマンドを止める
//!   {"type":"tm_log"}                                        タイムマシン: comments.jsonl を変えたコミットの一覧を求める（--remote で許された人だけ）
//!   {"type":"tm_show","commit":"…"}                          タイムマシン: そのコミットのときのコメントを求める
//!   {"type":"tm_restore","commit":"…"}                       タイムマシン: そのコミットのときの中身に戻す（今の中身からの変更として記録・コミットし、全員に配る）
//! サーバー → クライアント
//!   {"type":"snapshot","rev":N,"epoch":"…","you":接続id,"name":"名前","client":"自分のブラウザの id","comments":[...],"remote":"git"|"shell"|null}
//!                                                            接続直後の全体（name はホストが使う名前。client は peers・conflicts の client と比べて自分のものか見分ける。remote はコマンドを打てるときの種類。
//!                                                            epoch はホストの起動ごとの id）
//!     つなぎ直しで差分を返すときは comments の代わりに "changes":[{"rev","time","author","change"},...]（古い順）。
//!     自分の変更も入るが、当て直しても衝突して何も変わらない（同じ内容が二重になることはない）
//!   {"type":"presence","id":接続id,"state":{...}}            ほかの人の状態（接続直後は今いる全員の分）
//!   {"type":"call","id":接続id,"name":"名前","state":{...}}   ほかの人の「ここ見て」
//!   {"type":"pong"}                                          ping への返事
//!   {"type":"conflicts","list":[{"key",..,"author","client"}]} 保留中の衝突（変わるたびに全体）
//!   {"type":"change","rev":N,"time":ms,"author":"名前","change":{...}} 他の人の変更（適用できた op だけ）
//!   {"type":"history","entries":[{"rev","time","author","change"},...]} 最近の変更（新しい順）
//!   {"type":"ack","id":"変更セットid","rev":N,"dup":bool,"conflicts":[...],"fix":[{"id":..,"comment":..|null}]}
//!   {"type":"peers","names":[...],"peers":[{"id","name","client","color"}]} 参加者（color は色の番号。今いる人の中で空いている一番小さい番号）
//!   {"type":"run_out","id":"…","data":"出力","err":bool}       コマンドの出力（err は標準エラー出力）
//!   {"type":"run_end","id":"…","code":N|null,"message":"…"|null} コマンドが終わった（message は止めた理由・断った理由）
//!   {"type":"tm_log","commits":[{"id","time"(ミリ秒),"author","subject"},...]} コミットの一覧（新しい順）
//!   {"type":"tm_show","commit":"…","comments":[...],"edits":[{"commit","time","author","ids":[...]},...]}
//!                                                            そのコミットのときのコメントと、それぞれを最後に変えたコミット（git blame。新しい順）
//!   {"type":"tm_restore","commit":"…","rev":N|null,"count":N} 戻した（rev は記録した通し番号。変わらなければ null）。変更は change でも届く
//!     tm_* が失敗したときは "error":"理由" が付く
//!   {"type":"error","code":"protocol"|"auth"|"project","message":…} code があるものは送ったあと切る
//! 同じ変更セットを何度送っても1回だけ適用する（id で判定）ので、送り直しても安全。

use crate::auth::{self, Auth, Kind, SessionRec};
use crate::collection::Collection;
use crate::remote::{self, Remote};
use crate::store::{Change, Comment, Store};
use crate::workspace::{LogEntry, Workspace};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
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
pub const PROTOCOL: u32 = 9;

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
    /// 共有しているプロジェクト（まとめフォルダなら、画面から足したり外したりできる）
    projects: std::sync::RwLock<Vec<Arc<Project>>>,
    /// まとめフォルダ（komenagare <まとめフォルダ> で起動したとき）
    collection: Option<Arc<Collection>>,
    /// 書き込み担当の thread（終わるときに、書き込み終わるのを待つ）
    writers: std::sync::Mutex<Vec<(String, std::thread::JoinHandle<()>)>>,
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
        projects: Vec<(Project, std::thread::JoinHandle<()>)>,
        collection: Option<Collection>,
        access: Access,
        remote: Option<Remote>,
        web_dir: Option<PathBuf>,
    ) -> Arc<Server> {
        let (projects, writers): (Vec<_>, Vec<_>) = projects
            .into_iter()
            .map(|(p, w)| {
                let id = p.id.clone();
                (Arc::new(p), (id, w))
            })
            .unzip();
        Arc::new(Server {
            projects: std::sync::RwLock::new(projects),
            collection: collection.map(Arc::new),
            writers: std::sync::Mutex::new(writers),
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

    fn project(&self, id: Option<&str>) -> Option<Arc<Project>> {
        let projects = self.projects.read().unwrap();
        match id.filter(|s| !s.is_empty()) {
            Some(id) => projects.iter().find(|p| p.id == id).cloned(),
            None if projects.len() == 1 => projects.first().cloned(),
            None => None,
        }
    }

    pub fn projects(&self) -> Vec<Arc<Project>> {
        self.projects.read().unwrap().clone()
    }

    /// 終わるとき: プロジェクトを手放し、書き込み担当の thread を返す（Hub が全部捨てられると書き込み担当が終わる）
    pub fn finish(&self) -> Vec<std::thread::JoinHandle<()>> {
        let projects = std::mem::take(&mut *self.projects.write().unwrap());
        for p in &projects {
            p.hub.close();
        }
        drop(projects);
        std::mem::take(&mut *self.writers.lock().unwrap())
            .into_iter()
            .map(|(_, w)| w)
            .collect()
    }

    /// この人がプロジェクトを作る・外すことができるか。--otp なら管理者。合言葉・--no-token なら、
    /// このパソコンから（127.0.0.1 などで）開いた人だけ（合言葉を知っている人みんなが変えられないように）
    fn can_manage(&self, me: &Option<SessionRec>, local: bool) -> bool {
        self.collection.is_some()
            && match &self.access {
                Access::Otp(_) => me.as_ref().is_some_and(|s| s.admin),
                _ => local,
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
    writer: std::sync::mpsc::Sender<WriterMsg>,
    conflicts_file: PathBuf,
    /// 作業フォルダ（受け取った変更を .komenagare/log.jsonl に書き足す）
    dir: PathBuf,
    /// 起動ごとの id（つなぎ直しで差分を返してよいかを見分ける。起動し直したら、記録の外で変わったかもしれないので全体を返す）
    epoch: String,
    /// プロジェクトが外された（つながっている人を切る）
    closed: tokio::sync::watch::Sender<bool>,
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
/// これだけ何も届かない接続は切る（ブラウザは 20 秒ごとに ping を送る。裏のタブは 1 分に 1 回ほどに
/// 間引かれることがあるので余裕を持たせる）。回線が黙って切れた人を参加者の一覧に残さない
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// 「ここ見て」を送れる間隔の最短（ほかの人の画面をお知らせで埋めないように）
const CALL_GAP: Duration = Duration::from_secs(2);

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

/// 書き込み担当（comments.jsonl と git は受け取った順に処理する）への依頼。持つのは変更だけ
/// （書き込み担当が自分の控えに当てる。待ちが溜まってもコメント全体のコピーは増えない）
pub struct Job {
    pub message: String,
    pub author: String,
    pub email: String,
    pub log: LogEntry,
}

/// 一度にまとめて書き込む変更の数の上限
const WRITE_BATCH_MAX: usize = 1000;

/// 書き込み担当への知らせ
pub enum WriterMsg {
    /// 届いた変更（書き込んでコミットする）
    Job(Job),
    /// ホストの外で comments.jsonl が変わっていないか確かめる（リモートのコマンドが終わったとき）
    Check,
    /// ホストの外での変更を Hub が当て終えた（当てた分。何も当てられなかったら None）
    External(Option<LogEntry>),
}

/// これだけ何も届かなければ、ホストの外で comments.jsonl が変わっていないか確かめる
const EXTERNAL_CHECK: Duration = Duration::from_secs(2);

/// ホストの外での変更（git checkout・reset、手で直したなど）の作者
const EXTERNAL_AUTHOR: &str = "ホストの外での変更（git など）";

/// comments.jsonl の大きさと更新日時（変わったかを安く見分ける）
fn stamp(ws: &Workspace) -> Option<(u64, std::time::SystemTime)> {
    let m = std::fs::metadata(ws.dir.join(crate::workspace::COMMENTS_FILE)).ok()?;
    Some((m.len(), m.modified().ok()?))
}

/// ホストの外で comments.jsonl が変わっていたら、最後に書いた中身（written）からの変更を返す。
/// 読めない（git の衝突の印が入っているなど）ときは Err
fn external_change(
    ws: &Workspace,
    written: &Store,
    last: &mut Option<(u64, std::time::SystemTime)>,
) -> anyhow::Result<Option<(Store, Change)>> {
    let now = stamp(ws);
    if now == *last {
        return Ok(None);
    }
    let disk = Store::new(ws.load_comments()?);
    *last = now;
    if disk.same(written) {
        return Ok(None);
    }
    let ops = written.ops_to(&disk);
    Ok(Some((
        disk,
        Change {
            id: crate::store::uuid_v7(),
            ops,
        },
    )))
}

/// 書き込み担当を始める。store は今のコメント（ホストの Hub と同じ内容から始め、届いた変更を順に当てる）。
/// 待ちが溜まっていたら、まとめて1回で書き込んでコミットする（変更が速く届いても追いつけるように）。
/// external を渡すと、ホストの外で comments.jsonl が変わったとき（ブランチの切り替え・git reset など）に、その差分を
/// 送る（Hub が当てて全員に配り、External で返してくる）。返ってくるまでは書き込まない（外での変更を上書きしないように）
pub fn spawn_writer(
    ws: Workspace,
    mut store: Store,
    external: Option<tokio::sync::mpsc::UnboundedSender<Change>>,
) -> (
    std::sync::mpsc::Sender<WriterMsg>,
    std::thread::JoinHandle<()>,
) {
    let (tx, rx) = std::sync::mpsc::channel::<WriterMsg>();
    let handle = std::thread::spawn(move || {
        // 最後に書いた（読んだ）comments.jsonl の中身
        let mut written = store.clone();
        let mut last = stamp(&ws);
        let mut jobs: Vec<Job> = vec![];
        let mut saved_rev: Option<u64> = None;
        let mut waiting = false;
        let mut unreadable = false;
        loop {
            let first = match rx.recv_timeout(EXTERNAL_CHECK) {
                Ok(m) => Some(m),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let mut msgs: Vec<WriterMsg> = first.into_iter().collect();
            while msgs.len() < WRITE_BATCH_MAX {
                match rx.try_recv() {
                    Ok(m) => msgs.push(m),
                    Err(_) => break,
                }
            }
            for m in msgs {
                match m {
                    WriterMsg::Job(j) => {
                        store.apply(&j.log.change, false);
                        saved_rev = Some(j.log.rev);
                        jobs.push(j);
                    }
                    WriterMsg::Check => {}
                    WriterMsg::External(e) => {
                        if let Some(e) = e {
                            store.apply(&e.change, false);
                            saved_rev = Some(e.rev);
                        }
                        waiting = false;
                    }
                }
            }
            if let (Some(ext), false) = (&external, waiting) {
                match external_change(&ws, &written, &mut last) {
                    Ok(Some((disk, change))) => {
                        written = disk;
                        unreadable = false;
                        if ext.send(change).is_ok() {
                            waiting = true;
                        }
                    }
                    Ok(None) => unreadable = false,
                    Err(e) => {
                        if !unreadable {
                            eprintln!(
                                "{}: comments.jsonl を読めないため、直るまで書き込みを止めます（git の衝突などで）: {e:#}",
                                ws.dir.display()
                            );
                        }
                        unreadable = true;
                    }
                }
            }
            // 外での変更が戻ってくるまで・読めない間は書き込まない（変更は記録にあり、あとで書く）
            if waiting || unreadable {
                continue;
            }
            let Some(rev) = saved_rev.take() else {
                continue;
            };
            if store.same(&written) {
                // 書く中身が変わらない（外での変更を当てただけ）
                if let Err(e) = ws.set_saved_rev(rev) {
                    eprintln!("書き込んだ位置を残せませんでした: {e:#}");
                }
                jobs.clear();
                continue;
            }
            let (message, author, email) = if jobs.is_empty() {
                (
                    format!("{EXTERNAL_AUTHOR}に合わせる"),
                    "komenagare".to_string(),
                    "komenagare@localhost".to_string(),
                )
            } else {
                batch_message(&jobs)
            };
            let ids: Vec<(&str, &str)> = jobs
                .iter()
                .map(|j| ("Change-Id", j.log.change.id.as_str()))
                .collect();
            match ws.save(&store, &message, &author, &email, &ids) {
                Ok(()) => {
                    if let Err(e) = ws.set_saved_rev(rev) {
                        eprintln!("書き込んだ位置を残せませんでした: {e:#}");
                    }
                }
                // 書き込めなかった変更は記録（log.jsonl）に残っているので、次に起動したときに当て直す
                Err(e) => eprintln!("保存に失敗しました: {e:#}"),
            }
            written = store.clone();
            last = stamp(&ws);
            jobs.clear();
        }
    });
    (tx, handle)
}

/// まとめて書き込むときのコミットの説明と作者（1件ならその変更のもの。複数なら最初の人を作者にし、全員の名前を並べる）
fn batch_message(jobs: &[Job]) -> (String, String, String) {
    let first = &jobs[0];
    if jobs.len() == 1 {
        return (
            first.message.clone(),
            first.author.clone(),
            first.email.clone(),
        );
    }
    let mut names: Vec<&str> = vec![];
    for j in jobs {
        if !names.contains(&j.author.as_str()) {
            names.push(&j.author);
        }
    }
    let mut message = format!(
        "{} 件の変更をまとめて保存（{}）\n",
        jobs.len(),
        names.join("・")
    );
    for j in jobs {
        message.push('\n');
        message.push_str(&j.message);
    }
    (message, first.author.clone(), first.email.clone())
}

impl Hub {
    pub fn new(
        store: Store,
        rev: u64,
        seen: HashSet<String>,
        history: VecDeque<LogEntry>,
        writer: std::sync::mpsc::Sender<WriterMsg>,
        conflicts: Vec<Value>,
        conflicts_file: PathBuf,
        dir: PathBuf,
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
            dir,
            epoch: crate::auth::random_hex(8),
            closed: tokio::sync::watch::channel(false).0,
        })
    }

    /// 外したので、つながっている人を切る
    pub fn close(&self) {
        let _ = self.closed.send(true);
    }

    /// ホストの外で comments.jsonl が変わった（ブランチの切り替え・git reset など）ので、それに合わせる。
    /// 当てられた分を記録して全員に配り、書き込み担当に返す（まだ書いていない参加者の変更と重なったところは、
    /// 参加者の変更を残す）
    async fn apply_external(&self, change: Change) {
        let mut inner = self.inner.lock().await;
        let r = inner.store.apply(&change, false);
        inner.seen.insert(change.id.clone());
        let log = r.applied.map(|applied| {
            inner.rev += 1;
            let log = LogEntry {
                rev: inner.rev,
                time: now_ms(),
                author: EXTERNAL_AUTHOR.to_string(),
                change: applied,
            };
            inner.history.push_back(log.clone());
            if inner.history.len() > HISTORY_KEEP {
                inner.history.pop_front();
            }
            if let Err(e) = crate::workspace::append_log_in(&self.dir, &log) {
                eprintln!("変更の記録に失敗しました: {e:#}");
            }
            let msg = json!({ "type": "change", "rev": log.rev, "time": log.time, "author": log.author, "change": log.change })
                .to_string();
            let _ = self.tx.send((0, msg.into()));
            println!(
                "{}: ホストの外で comments.jsonl が変わったので合わせました（{} 件）",
                self.dir.display(),
                log.change.ops.len()
            );
            log
        });
        let _ = self.writer.send(WriterMsg::External(log));
    }

    /// 当てた変更を記録して（.komenagare/log.jsonl と最近の記録）、書き込み担当に渡し、ほかの人に配る
    /// （from の接続には配らない。0 なら全員に）。通し番号を返す
    fn record(
        &self,
        inner: &mut Inner,
        applied: &Change,
        name: &str,
        email: &str,
        message: String,
        from: u64,
    ) -> u64 {
        inner.rev += 1;
        let rev = inner.rev;
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
        // 受け取ったと返す前に記録へ書き足す（comments.jsonl と git への書き込みは後から。
        // その前にホストが止まっても、次に起動したときに記録から当て直す）
        if let Err(e) = crate::workspace::append_log_in(&self.dir, &log) {
            eprintln!("変更の記録に失敗しました: {e:#}");
        }
        let job = Job {
            message,
            author: name.to_string(),
            email: email.to_string(),
            log,
        };
        let _ = self.writer.send(WriterMsg::Job(job));
        let msg =
            json!({ "type": "change", "rev": rev, "time": job_time, "author": name, "change": applied }).to_string();
        let _ = self.tx.send((from, msg.into()));
        rev
    }

    /// タイムマシン: 今の中身を、コミット snap のときの中身（target）に戻す。git reset ではなく、今の中身からの
    /// 変更として記録してコミットし、全員に配る（頼んだ人にも）。通し番号と op の数を返す（同じなら None）
    async fn restore(
        &self,
        target: Vec<Comment>,
        snap: &crate::workspace::Snapshot,
        name: &str,
        email: &str,
    ) -> Option<(u64, usize)> {
        let mut inner = self.inner.lock().await;
        let ops = inner.store.ops_to(&Store::new(target));
        if ops.is_empty() {
            return None;
        }
        let change = Change {
            id: crate::store::uuid_v7(),
            ops,
        };
        let applied = inner.store.apply(&change, true).applied?;
        inner.seen.insert(change.id.clone());
        let message = format!(
            "{name}: {} の状態に復元（{}）\n\n復元元: {} {}",
            &snap.id[..7],
            summary(&applied),
            snap.id,
            snap.subject
        );
        let n = applied.ops.len();
        let rev = self.record(&mut inner, &applied, name, email, message, 0);
        Some((rev, n))
    }

    /// ホストの外で comments.jsonl が変わっていないか、書き込み担当に確かめさせる
    pub fn check_external(&self) {
        let _ = self.writer.send(WriterMsg::Check);
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
        .route(
            "/api/projects",
            get(projects_handler).post(project_add_handler),
        )
        .route("/api/projects/remove", post(project_remove_handler))
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

/// このパソコンから直接開いたか（つないできた先が 127.0.0.1 などで、Host もこのパソコンの名前で、
/// トンネルやリバースプロキシを通った印のヘッダーが無い）。トンネル（cloudflared など）はこのパソコンの
/// 中からつないでくるので、つないできた先だけでは見分けられない
fn local_request(peer: &std::net::SocketAddr, headers: &HeaderMap) -> bool {
    const PROXIED: [&str; 7] = [
        "forwarded",
        "x-forwarded-for",
        "x-forwarded-host",
        "x-real-ip",
        "cf-connecting-ip",
        "cf-ray",
        "tailscale-user-login",
    ];
    let host_local = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(host_name)
        .is_some_and(|n| {
            n == "localhost"
                || n.ends_with(".localhost")
                || n.parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
    peer.ip().is_loopback() && host_local && !PROXIED.iter().any(|h| headers.contains_key(*h))
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
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<KeyQuery>,
    headers: HeaderMap,
) -> Response {
    let me = match authorize(&server, &headers, q.k.as_deref()) {
        Ok(me) => me,
        Err(r) => return r,
    };
    let mut projects = vec![];
    for p in server.projects() {
        projects.push(json!({ "id": p.id, "name": p.name, "peers": p.hub.peer_names().await }));
    }
    let manage = server.can_manage(&me, local_request(&peer, &headers));
    let hidden = match (&server.collection, manage) {
        (Some(c), true) => {
            let c = c.clone();
            tokio::task::spawn_blocking(move || c.hidden())
                .await
                .unwrap_or_default()
        }
        _ => vec![],
    };
    Json(json!({
        "auth": server.access.label(),
        "me": me.map(|s| json!({ "name": s.name, "admin": s.admin })),
        "projects": projects,
        "manage": manage,
        "hidden": hidden,
    }))
    .into_response()
}

#[derive(Deserialize)]
struct ProjectBody {
    #[serde(default)]
    name: String,
    #[serde(default)]
    id: String,
    /// した人の名前（--otp ならセッションの名前を使う）。コミットの作者になる
    #[serde(default)]
    by: String,
}

/// プロジェクトを作る・外すことができるか確かめ、した人の名前を返す
#[allow(clippy::result_large_err)]
fn authorize_manage(
    server: &Server,
    peer: &std::net::SocketAddr,
    headers: &HeaderMap,
    k: Option<&str>,
    by: &str,
) -> Result<(Arc<Collection>, String), Response> {
    let me = authorize(server, headers, k)?;
    let Some(c) = server.collection.clone() else {
        return Err(api_error(
            StatusCode::NOT_FOUND,
            "プロジェクトを作る・外すのは、まとめフォルダで起動したときだけです（komenagare init --collection）",
        ));
    };
    if !server.can_manage(&me, local_request(peer, headers)) {
        return Err(api_error(
            StatusCode::FORBIDDEN,
            if server.auth().is_some() {
                "管理者だけが使えます"
            } else {
                "このパソコンから（127.0.0.1 で）開いたときだけ使えます"
            },
        ));
    }
    let name = match me {
        Some(s) => s.name,
        None => {
            let n: String = by.trim().chars().take(40).collect();
            if n.is_empty() {
                "名無し".to_string()
            } else {
                n
            }
        }
    };
    Ok((c, name))
}

async fn project_add_handler(
    State(server): State<Arc<Server>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<KeyQuery>,
    headers: HeaderMap,
    Json(body): Json<ProjectBody>,
) -> Response {
    let (c, by) = match authorize_manage(&server, &peer, &headers, q.k.as_deref(), &body.by) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let name = body.name.trim().to_string();
    let srv = server.clone();
    let r = tokio::task::spawn_blocking(move || -> anyhow::Result<(Arc<Project>, usize)> {
        let ws = c.add(&name, &by)?;
        let loaded = load(ws)?;
        let recovered = loaded.recovered;
        let mut projects = srv.projects.write().unwrap();
        let names: Vec<String> = projects.iter().map(|p| p.name.clone()).collect();
        let (project, writer) = start(loaded, unique_name(&name, &names));
        let project = Arc::new(project);
        projects.push(project.clone());
        srv.writers
            .lock()
            .unwrap()
            .push((project.id.clone(), writer));
        println!("プロジェクトを追加しました: {}（{by}）", project.name);
        Ok((project, recovered))
    })
    .await;
    match r {
        Ok(Ok((p, _))) => Json(json!({ "id": p.id, "name": p.name })).into_response(),
        Ok(Err(e)) => api_error(StatusCode::BAD_REQUEST, &format!("{e:#}")),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn project_remove_handler(
    State(server): State<Arc<Server>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    Query(q): Query<KeyQuery>,
    headers: HeaderMap,
    Json(body): Json<ProjectBody>,
) -> Response {
    let (c, by) = match authorize_manage(&server, &peer, &headers, q.k.as_deref(), &body.by) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let Some(project) = server.project(Some(&body.id)) else {
        return api_error(StatusCode::NOT_FOUND, "そのプロジェクトはありません");
    };
    let id = project.id.clone();
    let listed = {
        let c = c.clone();
        let id = id.clone();
        tokio::task::spawn_blocking(move || c.entries().map(|e| e.iter().any(|x| x.id == id)))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or(false)
    };
    // 先に共有をやめて、書き込み担当が書き終えるのを待つ（リポジトリから外したあとに書き込まないように）
    server.projects.write().unwrap().retain(|p| p.id != id);
    project.hub.close();
    let name = project.name.clone();
    drop(project);
    let writer = {
        let mut w = server.writers.lock().unwrap();
        w.iter().position(|(i, _)| *i == id).map(|i| w.remove(i).1)
    };
    if let Some(w) = writer {
        // つながっている人が切れると書き込み担当も終わる。終わらなければ待たずに進む（変更は記録にある）
        for _ in 0..100 {
            if w.is_finished() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if w.is_finished() {
            let _ = w.join();
        } else {
            server.writers.lock().unwrap().push((id.clone(), w));
        }
    }
    if listed {
        let (c, id, by) = (c.clone(), id.clone(), by.clone());
        match tokio::task::spawn_blocking(move || c.remove(&id, &by)).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return api_error(StatusCode::BAD_REQUEST, &format!("{e:#}")),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
        }
    }
    println!("プロジェクトを外しました: {name}（{by}）");
    Json(json!({})).into_response()
}

/// 開くプロジェクトの中身（コメント・記録）。読み込むときに、前回書き込めていなかった変更を当てて書き込む
pub struct Loaded {
    pub ws: Workspace,
    pub store: Store,
    seen: HashSet<String>,
    rev: u64,
    history: VecDeque<LogEntry>,
    /// 前回書き込めていなかったので書き込んだ変更の数
    pub recovered: usize,
}

pub fn load(ws: Workspace) -> anyhow::Result<Loaded> {
    let mut store = Store::new(ws.load_comments()?);
    let (seen, rev, history) = ws.load_log(HISTORY_KEEP)?;
    let recovered = ws.recover(&mut store, rev)?;
    Ok(Loaded {
        ws,
        store,
        seen,
        rev,
        history,
        recovered,
    })
}

/// 読み込んだプロジェクトを始める（書き込み担当を起こす）
pub fn start(l: Loaded, name: String) -> (Project, std::thread::JoinHandle<()>) {
    let Loaded {
        ws,
        store,
        seen,
        rev,
        history,
        ..
    } = l;
    let id = ws.id.clone();
    let (conflicts, conflicts_file) = (ws.load_conflicts(), ws.conflicts_path());
    let dir = ws.dir.clone();
    // 書き込み担当は自分の控え（今のコメントの写し）に届いた変更を当てていく
    let copy = Store::new(store.sorted().into_iter().cloned().collect());
    let (ext_tx, mut ext_rx) = tokio::sync::mpsc::unbounded_channel::<Change>();
    let (writer, writer_thread) = spawn_writer(ws, copy, Some(ext_tx));
    let hub = Hub::new(
        store,
        rev,
        seen,
        history,
        writer,
        conflicts,
        conflicts_file,
        dir.clone(),
    );
    // ホストの外での変更は Hub に当てる（Hub が無くなったら終わる。書き込み担当が終われば送り口も閉じる）
    let weak = Arc::downgrade(&hub);
    tokio::spawn(async move {
        while let Some(change) = ext_rx.recv().await {
            let Some(hub) = weak.upgrade() else { break };
            hub.apply_external(change).await;
        }
    });
    (Project { id, name, dir, hub }, writer_thread)
}

/// 同じ名前のプロジェクトがあれば番号を付けて見分ける
pub fn unique_name(base: &str, taken: &[String]) -> String {
    let mut name = base.to_string();
    let mut n = 2;
    while taken.iter().any(|t| t == &name) {
        name = format!("{base} ({n})");
        n += 1;
    }
    name
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
    // タイムマシン（tm_*）で git を動かすのは1つずつ
    let tm_gate = Arc::new(tokio::sync::Semaphore::new(TM_PARALLEL));
    let mut shutdown = server.shutdown.subscribe();
    let mut revoked = server.revoked.subscribe();
    let mut closed = hub.closed.subscribe();
    // 選んだあとに外されていたら、すぐに知らせて切る
    if *closed.borrow_and_update() {
        closed.mark_changed();
    }
    let mut check = tokio::time::interval(SESSION_CHECK);
    // つないでから hello が届くまで待つ（届かなければ切る）
    let hello_deadline = tokio::time::sleep(HELLO_TIMEOUT);
    tokio::pin!(hello_deadline);
    // 最後に何か届いてから IDLE_TIMEOUT たったら切る
    let idle = tokio::time::sleep(IDLE_TIMEOUT);
    tokio::pin!(idle);
    let mut last_call: Option<Instant> = None;
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
            _ = closed.changed() => {
                let _ = out_tx.send(json!({ "type": "error", "code": "project",
                    "message": "このプロジェクトはホストで外されました。ほかのプロジェクトを選んでください" }).to_string());
                break;
            }
            _ = &mut hello_deadline, if !joined => break,
            _ = &mut idle, if joined => break,
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
        idle.as_mut()
            .reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
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
                let remote = server
                    .remote
                    .as_ref()
                    .filter(|_| can_run)
                    .map(|r| r.mode.label());
                // つなぎ直しなら、前に受け取ったところからの変更だけを返す（記録に全部残っているとき）
                let since = (v["epoch"].as_str() == Some(hub.epoch.as_str()))
                    .then(|| v["since"].as_u64())
                    .flatten();
                let snapshot = match since.and_then(|n| changes_since(&inner, n)) {
                    Some(changes) => {
                        json!({ "type": "snapshot", "rev": inner.rev, "epoch": hub.epoch, "you": conn, "name": name, "client": client, "changes": changes, "remote": remote })
                    }
                    None => {
                        let comments: Vec<&Comment> = inner.store.sorted();
                        json!({ "type": "snapshot", "rev": inner.rev, "epoch": hub.epoch, "you": conn, "name": name, "client": client, "comments": comments, "remote": remote })
                    }
                };
                let _ = out_tx.send(snapshot.to_string());
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
            Some("ping") => {
                let _ = out_tx.send(r#"{"type":"pong"}"#.to_string());
            }
            Some("call") => {
                let state = &v["state"];
                if !state.is_object() || text.len() > PRESENCE_MAX {
                    continue;
                }
                if last_call.is_some_and(|t| t.elapsed() < CALL_GAP) {
                    continue;
                }
                last_call = Some(Instant::now());
                let msg = json!({ "type": "call", "id": conn, "name": name, "state": state });
                let _ = hub.tx.send((conn, msg.to_string().into()));
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
                let after = hub.clone();
                let task = tokio::spawn(async move {
                    let code = remote::run(cmd, rid, send, stop_rx).await;
                    // git checkout・reset などで comments.jsonl が変わっていれば、すぐに合わせる
                    after.check_external();
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
            Some(k @ ("tm_log" | "tm_show" | "tm_restore")) => {
                // コマンドを打てる人だけ（git の履歴を読む・戻す）
                if !can_run {
                    let _ = out_tx.send(
                        json!({ "type": k, "commit": v["commit"], "error": "このホストでは、あなたはタイムマシンを使えません" })
                            .to_string(),
                    );
                    continue;
                }
                time_machine(k, &v, &hub, &dir, &name, &email, &out_tx, &tm_gate);
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
        let message = format!("{name}: {}", summary(applied));
        hub.record(&mut inner, applied, name, email, message, conn);
    }
    json!({ "type": "ack", "id": change.id, "rev": inner.rev, "dup": false, "conflicts": r.conflicts, "fix": fix }).to_string()
}

/// 変更セットの中身の数（「追加 1・変更 2」）
fn summary(change: &Change) -> String {
    let (mut add, mut upd, mut del) = (0, 0, 0);
    for op in &change.ops {
        match op {
            crate::store::Op::Add { .. } => add += 1,
            crate::store::Op::Update { .. } => upd += 1,
            crate::store::Op::Delete { .. } => del += 1,
        }
    }
    [("追加", add), ("変更", upd), ("削除", del)]
        .iter()
        .filter(|(_, n)| *n > 0)
        .map(|(k, n)| format!("{k} {n}"))
        .collect::<Vec<_>>()
        .join("・")
}

/// タイムマシンの1つの接続から同時に動かす git の数
const TM_PARALLEL: usize = 1;
/// タイムマシンで返すコミットの数の上限（新しいものから）
const TM_LOG_MAX: usize = 5000;

/// タイムマシンの求め（tm_log・tm_show・tm_restore）に答える。git は別の thread で動かし、
/// 1つの接続からは1つずつ（速く動かしても、ホストで git がたくさん動かないように）
#[allow(clippy::too_many_arguments)]
fn time_machine(
    kind: &str,
    v: &Value,
    hub: &Arc<Hub>,
    dir: &std::path::Path,
    name: &str,
    email: &str,
    out_tx: &tokio::sync::mpsc::UnboundedSender<String>,
    gate: &Arc<tokio::sync::Semaphore>,
) {
    let kind = kind.to_string();
    let commit = v["commit"].as_str().unwrap_or("").to_string();
    let (hub, dir, name, email, out, gate) = (
        hub.clone(),
        dir.to_path_buf(),
        name.to_string(),
        email.to_string(),
        out_tx.clone(),
        gate.clone(),
    );
    tokio::spawn(async move {
        let Ok(_permit) = gate.acquire().await else {
            return;
        };
        let reply = match kind.as_str() {
            "tm_log" => {
                match tokio::task::spawn_blocking(move || {
                    crate::workspace::snapshots(&dir, TM_LOG_MAX)
                })
                .await
                {
                    Ok(Ok(list)) => json!({ "type": "tm_log", "commits": list }),
                    Ok(Err(e)) => json!({ "type": "tm_log", "error": format!("{e:#}") }),
                    Err(_) => json!({ "type": "tm_log", "error": "履歴を読めませんでした" }),
                }
            }
            _ => {
                let c = commit.clone();
                let show = kind == "tm_show";
                let read = tokio::task::spawn_blocking(move || {
                    crate::workspace::comments_at(&dir, &c).map(|(snap, comments)| {
                        // 見るときは、それぞれのコメントを最後に変えたコミットも付ける（読めなければ付けない）
                        let edits = if show {
                            crate::workspace::edits_at(&dir, &c).unwrap_or_default()
                        } else {
                            vec![]
                        };
                        (snap, comments, edits)
                    })
                })
                .await
                .map_err(|_| anyhow::anyhow!("履歴を読めませんでした"))
                .and_then(|r| r);
                match (kind.as_str(), read) {
                    (_, Err(e)) => {
                        json!({ "type": kind, "commit": commit, "error": format!("{e:#}") })
                    }
                    ("tm_show", Ok((_, comments, edits))) => {
                        json!({ "type": "tm_show", "commit": commit, "comments": comments, "edits": edits })
                    }
                    (_, Ok((snap, comments, _))) => {
                        let done = hub.restore(comments, &snap, &name, &email).await;
                        println!(
                            "[タイムマシン] {} が {} の状態に復元しました（{} 件）",
                            remote::printable(&name),
                            &snap.id[..7],
                            done.map_or(0, |d| d.1)
                        );
                        json!({ "type": "tm_restore", "commit": commit,
                            "rev": done.map(|d| d.0), "count": done.map_or(0, |d| d.1) })
                    }
                }
            }
        };
        let _ = out.send(reply.to_string());
    });
}

/// 通し番号 since より後の変更（古い順）。最近の記録に全部残っていなければ None（全体を送る）
fn changes_since(inner: &Inner, since: u64) -> Option<Vec<&LogEntry>> {
    if since > inner.rev {
        return None;
    }
    let changes: Vec<&LogEntry> = inner.history.iter().filter(|e| e.rev > since).collect();
    // 通し番号は1つずつ増えるので、数がそろっていれば抜けは無い
    (changes.len() as u64 == inner.rev - since).then_some(changes)
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
    fn writer_batches_changes() {
        use crate::store::{Change, Fields, Op};
        use crate::workspace::GitMode;
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(tmp.path(), GitMode::Off).unwrap();
        let dir = ws.dir.clone();
        let check = Workspace::open(tmp.path(), GitMode::Off).unwrap();
        let (tx, handle) = spawn_writer(ws, Store::default(), None);
        // 書き込み担当が処理するより先に、まとめて送る
        for i in 1..=5u64 {
            let change = Change {
                id: format!("ch{i}"),
                ops: vec![Op::Add {
                    id: format!("c{i}"),
                    after: Fields {
                        t: Some(i as f64),
                        cmd: Some("".into()),
                        text: Some(format!("コメント{i}")),
                    },
                }],
            };
            tx.send(WriterMsg::Job(Job {
                message: format!("たろう: 追加 1 ({i})"),
                author: "たろう".into(),
                email: "t@komenagare".into(),
                log: crate::workspace::LogEntry {
                    rev: i,
                    time: 0,
                    author: "たろう".into(),
                    change,
                },
            }))
            .unwrap();
        }
        drop(tx);
        handle.join().unwrap();
        assert_eq!(Store::new(check.load_comments().unwrap()).len(), 5);
        assert_eq!(check.saved_rev(), Some(5));
        assert!(dir.join("comments.jsonl").exists());
    }

    /// ホストの外で comments.jsonl が変わったら（ブランチの切り替えなど）その差分を送り、返ってくるまでは書かない。
    /// 返ってきたら、まだ書いていなかった参加者の変更と合わせて書く
    #[test]
    fn writer_follows_changes_outside_the_host() {
        use crate::store::{Fields, Op};
        use crate::workspace::GitMode;
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(tmp.path(), GitMode::Off).unwrap();
        let check = Workspace::open(tmp.path(), GitMode::Off).unwrap();
        let line = |id: &str, text: &str| {
            format!("{{\"id\":\"{id}\",\"t\":1.0,\"cmd\":\"\",\"text\":\"{text}\"}}\n")
        };
        let file = tmp.path().join("comments.jsonl");
        std::fs::write(&file, line("c1", "前")).unwrap();
        let store = Store::new(ws.load_comments().unwrap());
        let (ext_tx, mut ext_rx) = tokio::sync::mpsc::unbounded_channel::<Change>();
        let (tx, handle) = spawn_writer(ws, store, Some(ext_tx));
        // git checkout などで書き換わった
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(
            &file,
            format!("{}{}", line("c1", "後"), line("c2", "新しい")),
        )
        .unwrap();
        tx.send(WriterMsg::Check).unwrap();
        let change = (0..100)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(50));
                ext_rx.try_recv().ok()
            })
            .expect("外での変更が届かない");
        assert_eq!(change.ops.len(), 2, "{:?}", change.ops);
        // 返ってくる前に届いた参加者の変更は、まだ書かない（外での変更を上書きしない）
        tx.send(WriterMsg::Job(Job {
            message: "たろう: 追加 1".into(),
            author: "たろう".into(),
            email: "t@komenagare".into(),
            log: crate::workspace::LogEntry {
                rev: 1,
                time: 0,
                author: "たろう".into(),
                change: Change {
                    id: "ch3".into(),
                    ops: vec![Op::Add {
                        id: "c3".into(),
                        after: Fields {
                            t: Some(2.0),
                            cmd: Some("".into()),
                            text: Some("参加者".into()),
                        },
                    }],
                },
            },
        }))
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("後") && !text.contains("参加者"), "{text}");
        // Hub が当てて返す → 両方を合わせて書く
        tx.send(WriterMsg::External(Some(crate::workspace::LogEntry {
            rev: 2,
            time: 0,
            author: EXTERNAL_AUTHOR.into(),
            change,
        })))
        .unwrap();
        drop(tx);
        handle.join().unwrap();
        let got = Store::new(check.load_comments().unwrap());
        assert_eq!(got.len(), 3);
        assert_eq!(got.get("c1").unwrap().text, "後");
        assert_eq!(got.get("c3").unwrap().text, "参加者");
        assert_eq!(check.saved_rev(), Some(2));
    }

    #[test]
    fn batch_message_lists_everyone() {
        let job = |name: &str, msg: &str| Job {
            message: msg.into(),
            author: name.into(),
            email: format!("{name}@komenagare"),
            log: crate::workspace::LogEntry {
                rev: 1,
                time: 0,
                author: name.into(),
                change: crate::store::Change {
                    id: "x".into(),
                    ops: vec![],
                },
            },
        };
        let (m, a, _) = batch_message(&[job("たろう", "たろう: 追加 1")]);
        assert_eq!((m.as_str(), a.as_str()), ("たろう: 追加 1", "たろう"));
        let (m, a, _) = batch_message(&[
            job("たろう", "たろう: 追加 1"),
            job("はなこ", "はなこ: 変更 1"),
            job("たろう", "たろう: 削除 1"),
        ]);
        assert!(
            m.starts_with("3 件の変更をまとめて保存（たろう・はなこ）"),
            "{m}"
        );
        assert!(m.contains("はなこ: 変更 1"));
        assert_eq!(a, "たろう");
    }

    #[test]
    fn sends_only_missed_changes_when_history_has_them() {
        let entry = |rev| LogEntry {
            rev,
            time: 0,
            author: "たろう".into(),
            change: crate::store::Change {
                id: format!("ch{rev}"),
                ops: vec![],
            },
        };
        let mut inner = Inner {
            store: Store::default(),
            rev: 10,
            seen: HashSet::new(),
            peers: HashMap::new(),
            // 記録に残っているのは 6〜10（それより古いものは押し出された）
            history: (6..=10).map(entry).collect(),
            conflicts: vec![],
        };
        let revs =
            |v: Option<Vec<&LogEntry>>| v.map(|v| v.iter().map(|e| e.rev).collect::<Vec<_>>());
        assert_eq!(revs(changes_since(&inner, 10)), Some(vec![]));
        assert_eq!(revs(changes_since(&inner, 8)), Some(vec![9, 10]));
        assert_eq!(revs(changes_since(&inner, 5)), Some(vec![6, 7, 8, 9, 10]));
        // 記録から外れたところからは全体を送る
        assert_eq!(revs(changes_since(&inner, 4)), None);
        assert_eq!(revs(changes_since(&inner, 0)), None);
        // ホストより先の番号（ほかのホストのもの）も全体
        assert_eq!(revs(changes_since(&inner, 11)), None);
        // 取り込み（通し番号 0）が混ざっていても数え違えない
        inner.history.push_front(entry(0));
        assert_eq!(revs(changes_since(&inner, 7)), Some(vec![8, 9, 10]));
    }

    #[tokio::test]
    async fn time_machine_restores_as_a_new_commit() {
        use crate::store::{Fields, Op};
        use crate::workspace::GitMode;
        if !crate::workspace::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(tmp.path(), GitMode::Require).unwrap();
        let dir = ws.dir.clone();
        let (project, writer) = start(load(ws).unwrap(), "p".into());
        let hub = project.hub.clone();
        let mut rx = hub.tx.subscribe();
        let add = |id: &str, text: &str| Op::Add {
            id: id.into(),
            after: Fields {
                t: Some(1.0),
                cmd: Some("".into()),
                text: Some(text.into()),
            },
        };
        let ch = |id: &str, ops| Change { id: id.into(), ops };
        let wait_commits = |n: usize| {
            for _ in 0..100 {
                if crate::workspace::snapshots(&dir, 100).unwrap().len() >= n {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("コミットされません");
        };
        let base = crate::workspace::snapshots(&dir, 100).unwrap().len();
        apply_change(&hub, 1, "たろう", "t@k", ch("c1", vec![add("a", "あ")])).await;
        wait_commits(base + 1);
        let past = crate::workspace::snapshots(&dir, 100).unwrap()[0].clone();
        apply_change(&hub, 1, "たろう", "t@k", ch("c2", vec![add("b", "い")])).await;
        apply_change(
            &hub,
            1,
            "たろう",
            "t@k",
            ch(
                "c3",
                vec![Op::Update {
                    id: "a".into(),
                    before: Fields {
                        text: Some("あ".into()),
                        ..Default::default()
                    },
                    after: Fields {
                        text: Some("う".into()),
                        ..Default::default()
                    },
                }],
            ),
        )
        .await;
        wait_commits(base + 2);
        let (snap, comments) = crate::workspace::comments_at(&dir, &past.id).unwrap();
        let (rev, n) = hub
            .restore(comments.clone(), &snap, "はなこ", "h@k")
            .await
            .unwrap();
        assert_eq!(n, 2);
        // 頼んだ人も含めて全員に配る
        let mut got = None;
        while let Ok((from, m)) = rx.try_recv() {
            if m.contains("\"author\":\"はなこ\"") {
                got = Some((from, m));
            }
        }
        let (from, m) = got.expect("復元の変更が配られません");
        assert_eq!(from, 0);
        assert!(m.contains(&format!("\"rev\":{rev}")));
        // 同じ中身なら何もしない
        assert!(hub
            .restore(comments, &snap, "はなこ", "h@k")
            .await
            .is_none());
        drop(rx);
        drop(hub);
        drop(project);
        tokio::task::spawn_blocking(move || writer.join().unwrap())
            .await
            .unwrap();
        // 履歴は消さずに、戻したコミットを足す
        let list = crate::workspace::snapshots(&dir, 100).unwrap();
        assert!(list.iter().any(|c| c.id == past.id));
        assert!(
            list[0]
                .subject
                .starts_with(&format!("はなこ: {} の状態に復元", &past.id[..7])),
            "{list:?}"
        );
        let now = std::fs::read_to_string(dir.join(crate::workspace::COMMENTS_FILE)).unwrap();
        assert_eq!(
            now,
            "{\"id\":\"a\",\"t\":1.0,\"cmd\":\"\",\"text\":\"あ\"}\n"
        );
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
    fn manage_only_from_this_computer() {
        let h = |host: &str, extra: &[(&str, &str)]| {
            let mut m = HeaderMap::new();
            m.insert(header::HOST, host.parse().unwrap());
            for (k, v) in extra {
                m.insert(
                    axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                    v.parse().unwrap(),
                );
            }
            m
        };
        let local: std::net::SocketAddr = "127.0.0.1:50000".parse().unwrap();
        let v6: std::net::SocketAddr = "[::1]:50000".parse().unwrap();
        let lan: std::net::SocketAddr = "192.168.1.20:50000".parse().unwrap();
        assert!(local_request(&local, &h("127.0.0.1:8764", &[])));
        assert!(local_request(&local, &h("localhost:8764", &[])));
        assert!(local_request(&v6, &h("[::1]:8764", &[])));
        // 同じ LAN のほかのパソコン
        assert!(!local_request(&lan, &h("192.168.1.10:8764", &[])));
        assert!(!local_request(&lan, &h("127.0.0.1:8764", &[])));
        // トンネル（このパソコンの中からつないでくる）: Host が公開 URL、または転送の印のヘッダーがある
        assert!(!local_request(&local, &h("abc.trycloudflare.com", &[])));
        assert!(!local_request(
            &local,
            &h("localhost:8764", &[("cf-connecting-ip", "1.2.3.4")])
        ));
        assert!(!local_request(
            &local,
            &h("127.0.0.1:8764", &[("x-forwarded-for", "1.2.3.4")])
        ));
        assert!(!local_request(
            &local,
            &h("127.0.0.1:8764", &[("forwarded", "for=1.2.3.4")])
        ));
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
