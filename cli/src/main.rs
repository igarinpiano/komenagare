// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! komenagare: コメナガレを複数人で編集するためのホスト
//!
//!   komenagare [フォルダ...] [--host 0.0.0.0] [--port 8764] [--otp] ...
//!
//! フォルダ（1フォルダ1プロジェクト。複数渡すとまとめて共有する）の comments.jsonl を読み込み、
//! Web アプリを配信する。ブラウザから届いた変更は comments.jsonl に書き込み、git があれば変更ごとにコミットする。

mod auth;
mod files;
mod firewall;
mod render;
mod server;
mod store;
mod tunnel;
mod update;
mod web;
mod workspace;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use rand::Rng;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use store::{uuid_v7, Change, Fields, Op, Store};
use workspace::{GitMode, LogEntry, Workspace};

#[derive(Parser)]
#[command(
    name = "komenagare",
    version,
    about = "コメナガレを複数人で編集するためのホスト"
)]
#[command(args_conflicts_with_subcommands = true)]
struct Args {
    #[command(subcommand)]
    cmd: Option<Cmd>,
    /// 作業フォルダ（komenagare init で作ったもの）。複数渡すと、まとめて共有して画面で切り替えられる
    #[arg(default_value = ".")]
    dirs: Vec<PathBuf>,
    /// 待ち受けるアドレス。同じネットワークの人と共有するときは 0.0.0.0
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    /// 待ち受けるポート
    #[arg(long, short, default_value_t = 8764)]
    port: u16,
    /// 参加用の合言葉（URL の k=）を使わない。信頼できるネットワーク以外では付けないこと
    #[arg(long)]
    no_token: bool,
    /// 参加用の合言葉を指定する（指定しなければ起動ごとに作る）
    #[arg(long, conflicts_with = "no_token")]
    token: Option<String>,
    /// 合言葉の代わりに、参加者ごとのワンタイムパスワードで入る（komenagare otp new や画面の「招待」で発行する）
    #[arg(long, conflicts_with_all = ["no_token", "token"])]
    otp: bool,
    /// ワンタイムパスワードとログインの記録を置く場所（既定は ~/.config/komenagare/auth など）
    #[arg(long, value_name = "DIR", env = "KOMENAGARE_AUTH_DIR")]
    auth_dir: Option<PathBuf>,
    /// トンネルを始めて、ローカルネットワークの外から入れるようにする（cloudflared / tailscale / ngrok が必要）
    #[arg(long, value_enum, value_name = "KIND")]
    tunnel: Option<tunnel::Kind>,
    /// 外から入るときの URL（自分で用意したトンネルやリバースプロキシのもの。共有・招待のリンクに使う）
    #[arg(
        long,
        value_name = "URL",
        env = "KOMENAGARE_PUBLIC_URL",
        conflicts_with = "tunnel"
    )]
    public_url: Option<String>,
    /// 履歴（git）が残せなければ起動しない
    #[arg(long, conflicts_with = "no_git")]
    require_git: bool,
    /// 今回は git にコミットしない（履歴を残さない）
    #[arg(long)]
    no_git: bool,
    /// コメナガレで保存したファイル（.json / .jsonl / .csv）のコメントを取り込んでから始める
    #[arg(long, value_name = "FILE")]
    import: Option<PathBuf>,
    /// 起動したらブラウザで開く
    #[arg(long)]
    open: bool,
    /// 起動時に更新を確かめない（Web アプリは前回取ってきたもの、無ければ内蔵のものを使う）
    #[arg(long)]
    no_update: bool,
    /// CLI に内蔵した Web アプリを使う
    #[arg(long, conflicts_with = "no_update")]
    bundled_web: bool,
    /// Web アプリの取得元
    #[arg(long, value_name = "URL", env = "KOMENAGARE_WEB_URL", default_value = web::DEFAULT_URL)]
    web_url: String,
    /// Web アプリをこのフォルダから配信する（開発用）
    #[arg(long, value_name = "DIR", hide = true)]
    web: Option<PathBuf>,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Cmd {
    /// 作業フォルダを作る（comments.jsonl と履歴の置き場所。git があれば git の管理下にする）
    Init {
        /// 作業フォルダにする場所。無ければ作る
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// git を使わない（履歴を残さない）
        #[arg(long, conflicts_with = "require_git")]
        no_git: bool,
        /// git が無ければ作らない
        #[arg(long)]
        require_git: bool,
        /// コメナガレで保存したファイル（.json / .jsonl / .csv）のコメントを取り込む
        #[arg(long, value_name = "FILE")]
        import: Option<PathBuf>,
    },
    /// komenagare を最新版に更新する
    Update {
        /// 更新があるかを確かめるだけ
        #[arg(long)]
        check: bool,
        /// 入れるバージョン（例 v0.1.1。前の版に戻すときにも使える）
        #[arg(long, value_name = "VERSION")]
        version: Option<String>,
    },
    /// 参加者ごとのワンタイムパスワード（komenagare --otp で使う）を発行・一覧・取り消しする
    Otp {
        #[command(subcommand)]
        cmd: OtpCmd,
        /// ワンタイムパスワードとログインの記録を置く場所（ホストと同じにする）
        #[arg(long, value_name = "DIR", env = "KOMENAGARE_AUTH_DIR", global = true)]
        auth_dir: Option<PathBuf>,
    },
    /// Web アプリの最新版を取ってくる（起動時にも自動で確かめる）
    UpdateWeb {
        /// Web アプリの取得元
        #[arg(long, value_name = "URL", env = "KOMENAGARE_WEB_URL", default_value = web::DEFAULT_URL)]
        web_url: String,
    },
    /// コメントを動画に焼き込む（ffmpeg が必要）。--ass なら字幕ファイル（ASS）だけを書き出す
    Render {
        /// 元の動画
        video: Option<PathBuf>,
        /// コメントファイル（.json / .jsonl / .csv）。省略すると今のフォルダの comments.jsonl
        #[arg(short, long, value_name = "FILE")]
        comments: Option<PathBuf>,
        /// 書き出す動画（.mp4 / .mov / .mkv / .webm）。省略すると「元の名前_comments.mp4」
        #[arg(short, long, value_name = "FILE")]
        output: Option<PathBuf>,
        /// 動画ではなく字幕ファイル（ASS）を書き出す。mpv などで動画に重ねて再生できる
        #[arg(long, value_name = "FILE")]
        ass: Option<PathBuf>,
        /// 高さ（ピクセル）。幅は 16:9 になる。省略すると元の動画と同じ（--ass では 1080）
        #[arg(long)]
        height: Option<u32>,
        /// フレームレート。省略すると元の動画と同じ
        #[arg(long)]
        fps: Option<f64>,
        /// 書き出す範囲の始め（例 1:23.45）
        #[arg(long, value_parser = parse_time_arg)]
        start: Option<f64>,
        /// 書き出す範囲の終わり（例 2:00）
        #[arg(long, value_parser = parse_time_arg)]
        end: Option<f64>,
        /// 画質（x264 の CRF。小さいほど高画質）
        #[arg(long, default_value_t = 20)]
        crf: u32,
        /// ゴシック体（defont / gothic）に使うフォント
        #[arg(long, default_value = render::DEFAULT_FONT)]
        font: String,
        /// 明朝体（mincho）に使うフォント
        #[arg(long, default_value = render::DEFAULT_FONT_SERIF)]
        font_serif: String,
        /// 文字の大きさの補正（省略するとフォントから求める）
        #[arg(long)]
        font_scale: Option<f64>,
    },
}

#[derive(Subcommand)]
enum OtpCmd {
    /// ワンタイムパスワードを発行する（1回だけ使える。使うとその人の名前でログインした状態になる）
    New {
        /// 参加者の名前（変更履歴や git の作者になる）
        name: String,
        /// 数字 6 桁にする（既定は英数字 10 文字。数字は打ちやすいが、期限は短めに）
        #[arg(long)]
        numeric: bool,
        /// 有効期限（例 10m・1h・7d。既定は数字なら 10m、英数字なら 7d）
        #[arg(long, value_parser = auth::parse_ttl)]
        expires: Option<std::time::Duration>,
        /// 管理者にする（画面からワンタイムパスワードの発行・取り消しができる）
        #[arg(long)]
        admin: bool,
        /// ホストの URL（例 https://komenagare.example.com）。そのまま開けるリンクも出す。
        /// 省略すると、動いているホストの公開 URL（--tunnel / --public-url）を使う
        #[arg(long, env = "KOMENAGARE_PUBLIC_URL")]
        url: Option<String>,
    },
    /// ログイン中の人と、未使用のワンタイムパスワードの一覧
    List,
    /// 名前か id でセッションとワンタイムパスワードを取り消す（つながっていれば切れる）
    Revoke {
        /// 名前か id
        who: String,
    },
}

fn parse_time_arg(s: &str) -> Result<f64, String> {
    files::parse_time(s)
        .filter(|t| *t >= 0.0)
        .ok_or_else(|| format!("時刻「{s}」を読めません（例 1:23.45）"))
}

/// komenagare render
fn run_render(cmd: &Cmd) -> Result<()> {
    let Cmd::Render {
        video,
        comments,
        output,
        ass,
        height,
        fps,
        start,
        end,
        crf,
        font,
        font_serif,
        font_scale,
    } = cmd
    else {
        unreachable!()
    };
    let comments = comments
        .clone()
        .unwrap_or_else(|| PathBuf::from(workspace::COMMENTS_FILE));
    let items = files::read(&comments)?;
    if let Some(ass_path) = ass {
        let (w, h) = render::even_size(height.unwrap_or(1080));
        let opt = render::AssOptions {
            width: w,
            height: h,
            font: font.clone(),
            font_serif: font_serif.clone(),
            start: start.unwrap_or(0.0),
            size_scale: font_scale.unwrap_or_else(|| render::font_scale(font)),
            size_scale_serif: font_scale.unwrap_or_else(|| render::font_scale(font_serif)),
        };
        std::fs::write(ass_path, render::to_ass(&items, &opt))?;
        println!(
            "{} 件のコメントを字幕にしました: {}",
            items.len(),
            ass_path.display()
        );
        return Ok(());
    }
    let Some(video) = video else {
        bail!("元の動画を指定してください（字幕だけなら --ass）")
    };
    let output = output.clone().unwrap_or_else(|| {
        let stem = video.file_stem().unwrap_or_default().to_string_lossy();
        video.with_file_name(format!("{stem}_comments.mp4"))
    });
    if output.canonicalize().ok() == video.canonicalize().ok() && output.exists() {
        bail!("書き出し先が元の動画と同じです");
    }
    println!(
        "{} 件のコメントを {} に焼き込んでいます…",
        items.len(),
        output.display()
    );
    render::render(
        &items,
        &render::RenderOptions {
            video: video.clone(),
            output: output.clone(),
            height: *height,
            fps: *fps,
            start: *start,
            end: *end,
            crf: *crf,
            font: font.clone(),
            font_serif: font_serif.clone(),
            font_scale: *font_scale,
        },
    )?;
    println!("書き出しました: {}", output.display());
    Ok(())
}

#[tokio::main]
async fn main() {
    update::cleanup();
    if let Err(e) = run(Args::parse()).await {
        eprintln!("エラー: {e:#}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<()> {
    if let Some(cmd @ Cmd::Render { .. }) = &args.cmd {
        return run_render(cmd);
    }
    if let Some(Cmd::Init {
        dir,
        no_git,
        require_git,
        import: file,
    }) = &args.cmd
    {
        return run_init(dir, git_mode(*no_git, *require_git), file.as_deref());
    }
    if let Some(Cmd::Update { check, version }) = &args.cmd {
        let (check, version) = (*check, version.clone());
        return tokio::task::spawn_blocking(move || update::run(version.as_deref(), check)).await?;
    }
    if let Some(Cmd::UpdateWeb { web_url }) = &args.cmd {
        let dir = web::cache_dir().context("保存場所（ホームフォルダ）が分かりません")?;
        let url = web_url.clone();
        let d = dir.clone();
        match tokio::task::spawn_blocking(move || web::update(&url, &d)).await?? {
            web::Outcome::Updated(n) => println!(
                "Web アプリを更新しました（{n} ファイル）: {}",
                dir.display()
            ),
            web::Outcome::UpToDate => println!("Web アプリは最新です: {}", dir.display()),
            web::Outcome::Incompatible(p) => bail!("{}", incompatible_message(p)),
        }
        return Ok(());
    }
    if let Some(Cmd::Otp { cmd, auth_dir }) = &args.cmd {
        return run_otp(cmd, auth_dir.as_deref());
    }
    if args.import.is_some() && args.dirs.len() > 1 {
        bail!("--import は作業フォルダを1つだけ指定したときに使えます");
    }
    let mode = git_mode(args.no_git, args.require_git);
    let mut opened: Vec<Opened> = vec![];
    for dir in &args.dirs {
        let ws = Workspace::open(dir, mode)?;
        if let Some((other, ..)) = opened.iter().find(|(o, ..)| o.id == ws.id) {
            bail!(
                "{} と {} は同じ作業フォルダです（同じフォルダを2回指定したか、作業フォルダをコピーしています）",
                other.dir.display(),
                ws.dir.display()
            );
        }
        let mut store = Store::new(ws.load_comments()?);
        let (seen, rev, history) = ws.load_log(server::HISTORY_KEEP)?;
        if let Some(file) = &args.import {
            let n = import(&ws, &mut store, file)?;
            println!("{} から {} 件のコメントを取り込みました", file.display(), n);
        }
        opened.push((ws, store, seen, rev, history));
    }

    // komenagare 自身の新しい版があるか（Web アプリの用意と並べて確かめる）
    let newer = (!args.no_update && args.web.is_none())
        .then(|| tokio::task::spawn_blocking(update::check_newer));
    let (web_source, web_label) = prepare_web(&args).await;
    let newer = match newer {
        Some(h) => tokio::time::timeout(std::time::Duration::from_secs(3), h)
            .await
            .ok()
            .and_then(|r| r.ok())
            .flatten(),
        None => None,
    };
    let access = if args.otp {
        let dir = match &args.auth_dir {
            Some(d) => d.clone(),
            None => auth::Auth::default_dir().context("ログインの記録の置き場所（ホームフォルダ）が分かりません。--auth-dir で指定してください")?,
        };
        server::Access::Otp(auth::Auth::open(&dir)?)
    } else if args.no_token {
        server::Access::None
    } else {
        server::Access::Token(args.token.clone().unwrap_or_else(random_token))
    };

    let mut projects = vec![];
    let mut writers = vec![];
    let mut lines = vec![];
    for (ws, store, seen, rev, history) in opened {
        let base = ws
            .dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| ws.dir.display().to_string());
        // 同じ名前のフォルダがあれば番号を付けて見分ける
        let mut name = base.clone();
        let mut n = 2;
        while projects.iter().any(|p: &server::Project| p.name == name) {
            name = format!("{base} ({n})");
            n += 1;
        }
        lines.push(format!(
            "{name}: {}（コメント {} 件、履歴: {}）",
            ws.dir.display(),
            store.len(),
            if ws.git { "git" } else { "なし" }
        ));
        let id = ws.id.clone();
        let (conflicts, conflicts_file) = (ws.load_conflicts(), ws.conflicts_path());
        let (writer, writer_thread) = server::spawn_writer(ws);
        writers.push(writer_thread);
        let hub = server::Hub::new(store, rev, seen, history, writer, conflicts, conflicts_file);
        projects.push(server::Project { id, name, hub });
    }
    let server = server::Server::new(
        projects,
        access,
        match web_source {
            web::Source::Dir(d) => Some(d),
            web::Source::Bundled => None,
        },
    );

    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .context("--host / --port の指定が正しくありません")?;
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| {
        format!("{addr} で待ち受けできません（--port で別のポートを指定してください）")
    })?;

    // 外から入れるようにする（トンネルを始めるか、渡された公開 URL を使う）
    if args.tunnel.is_some() && matches!(server.access, server::Access::None) {
        bail!("トンネルでインターネットに公開するときは --no-token は使えません（--otp か合言葉で入るようにしてください）");
    }
    let mut tunnel = None;
    let public = match args.tunnel {
        Some(kind) => {
            println!("{} を始めています…", kind.label());
            let (t, url) = tunnel::start(kind, addr.port()).await?;
            tunnel = Some(t);
            Some(url)
        }
        None => args
            .public_url
            .as_deref()
            .map(tunnel::normalize_url)
            .transpose()?,
    };
    server.set_public_url(public.clone());
    if let (server::Access::Otp(a), Some(u)) = (&server.access, &public) {
        tunnel::write_url_file(a.dir(), Some(u))?;
    }

    // 開く URL に付けるもの（合言葉、または管理者用のワンタイムパスワード）
    let (share_query, open_query) = match &server.access {
        server::Access::Token(t) => (format!("?k={t}"), format!("?k={t}")),
        server::Access::Otp(a) => (String::new(), format!("?otp={}", a.issue_startup()?.code)),
        server::Access::None => (String::new(), String::new()),
    };
    let local = format!(
        "http://{}:{}/{}",
        if addr.ip().is_unspecified() {
            "127.0.0.1".into()
        } else {
            addr.ip().to_string()
        },
        addr.port(),
        open_query
    );
    println!("komenagare {}", env!("CARGO_PKG_VERSION"));
    if lines.len() == 1 {
        let l = &lines[0];
        println!(
            "  作業フォルダ: {}",
            &l[l.find(": ").map_or(0, |i| i + 2)..]
        );
    } else {
        println!(
            "  プロジェクト: {} 件（画面の「プロジェクト」で切り替えられます）",
            lines.len()
        );
        for l in &lines {
            println!("    - {l}");
        }
    }
    println!("  Web アプリ: {web_label}");
    match &server.access {
        server::Access::Otp(a) => {
            println!(
                "  入り方: 参加者ごとのワンタイムパスワード（記録: {}）",
                a.dir().display()
            );
            println!("  開く（管理者・この URL は1回だけ使えます）: {local}");
        }
        _ => println!("  開く: {local}"),
    }
    if let Some(u) = &public {
        let how = args.tunnel.map_or("--public-url", |k| k.label());
        println!("  公開 URL（{how}）: {u}{share_query}");
        if let server::Access::Otp(_) = &server.access {
            println!(
                "  公開 URL で管理者として開く（上の「開く」とどちらか1回だけ）: {u}{open_query}"
            );
        }
        if args.tunnel == Some(tunnel::Kind::Cloudflare) {
            println!("  ※ Quick Tunnel の URL は起動のたびに変わります（変わるとワンタイムパスワードでのログインもやり直しです）");
        }
    }
    if addr.ip().is_unspecified() {
        if let Some(ip) = lan_ip() {
            println!(
                "  共有（同じネットワーク）: http://{ip}:{}/{share_query}",
                addr.port()
            );
        }
    } else if addr.ip().is_loopback() && public.is_none() {
        println!("  ほかの人と共有するには --host 0.0.0.0（同じネットワーク）か --tunnel（インターネット越し）を付けて起動してください");
    }
    match &server.access {
        server::Access::None => {
            println!("  注意: 合言葉なしで起動しています。URL を知っている人は誰でも編集できます")
        }
        server::Access::Otp(_) => println!(
            "  参加者の招待: 画面の「プロジェクト」→「招待」、または komenagare otp new <名前>"
        ),
        server::Access::Token(_) => {}
    }
    if let Some(tag) = newer {
        println!("  新しい版: komenagare {tag} があります（komenagare update で更新できます）");
    }
    println!("  終了: Ctrl+C");
    if args.open {
        open_browser(&local);
    }
    // ほかの機械からつながるか（macOS のファイアウォールで止められていないか）を確かめる
    if let Some(ip) = if addr.ip().is_unspecified() {
        lan_ip()
    } else {
        Some(addr.ip())
    } {
        firewall::check_in_background(ip, addr.port());
    }

    let stop = server.shutdown.clone();
    // 終わるときに公開 URL の控えを消すため、記録の置き場所を覚えておく
    let otp_dir = match &server.access {
        server::Access::Otp(a) => Some(a.dir().to_path_buf()),
        _ => None,
    };
    axum::serve(listener, server::router(server))
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            // つながっている WebSocket を閉じないと終われない
            let _ = stop.send(true);
        })
        .await?;
    println!("終了しています（書き込み中の変更を保存します）…");
    if let Some(t) = tunnel {
        t.stop().await;
    }
    if let (Some(dir), Some(_)) = (&otp_dir, &public) {
        let _ = tunnel::write_url_file(dir, None);
    }
    // Hub が持つ送り口が全部閉じると書き込み担当が終わる
    tokio::task::spawn_blocking(move || {
        for w in writers {
            let _ = w.join();
        }
    })
    .await?;
    Ok(())
}

/// 読み込んだ作業フォルダ（作業フォルダ・コメント・適用済みの変更セット・通し番号・最近の変更）
type Opened = (
    Workspace,
    Store,
    std::collections::HashSet<String>,
    u64,
    std::collections::VecDeque<LogEntry>,
);

/// Ctrl+C（SIGINT）か、systemd などからの SIGTERM を待つ
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}

/// komenagare otp
fn run_otp(cmd: &OtpCmd, dir: Option<&Path>) -> Result<()> {
    let dir = match dir {
        Some(d) => d.to_path_buf(),
        None => auth::Auth::default_dir().context(
            "記録の置き場所（ホームフォルダ）が分かりません。--auth-dir で指定してください",
        )?,
    };
    let a = auth::Auth::open(&dir)?;
    let date = |ms: u64| {
        let secs = ms.saturating_sub(auth::now_ms()) / 1000;
        if secs >= 86400 {
            format!("あと {} 日", secs / 86400)
        } else if secs >= 3600 {
            format!("あと {} 時間", secs / 3600)
        } else {
            format!("あと {} 分", secs.div_ceil(60))
        }
    };
    match cmd {
        OtpCmd::New {
            name,
            numeric,
            expires,
            admin,
            url,
        } => {
            let kind = if *numeric {
                auth::Kind::Numeric
            } else {
                auth::Kind::Random
            };
            let i = a.issue(
                name,
                *admin,
                kind,
                expires.unwrap_or_else(|| kind.default_ttl()),
            )?;
            println!("{name} のワンタイムパスワード: {}", i.code);
            println!("  有効期限: {}（1回だけ使えます）", date(i.expires));
            // URL を渡されなければ、動いているホストの公開 URL（--tunnel / --public-url）を使う
            if let Some(u) = url.clone().or_else(|| tunnel::read_url_file(a.dir())) {
                println!("  リンク: {}/?otp={}", u.trim_end_matches('/'), i.code);
            }
        }
        OtpCmd::List => {
            let sessions = a.sessions();
            let otps: Vec<_> = a.otps().into_iter().filter(|o| !o.startup).collect();
            println!("ログイン中: {} 人", sessions.len());
            for s in &sessions {
                println!(
                    "  {}  {}{}",
                    s.id,
                    s.name,
                    if s.admin { "（管理者）" } else { "" }
                );
            }
            println!("未使用のワンタイムパスワード: {} 件", otps.len());
            for o in &otps {
                println!(
                    "  {}  {}{}  {}  {}",
                    o.id,
                    o.name,
                    if o.admin { "（管理者）" } else { "" },
                    if o.kind == auth::Kind::Numeric {
                        "数字"
                    } else {
                        "英数字"
                    },
                    date(o.expires)
                );
            }
            println!("記録の置き場所: {}", a.dir().display());
        }
        OtpCmd::Revoke { who } => {
            let (sessions, otps) = a.revoke(who);
            if sessions.is_empty() && otps == 0 {
                bail!("「{who}」に合うものはありません（komenagare otp list で確かめられます）");
            }
            println!(
                "取り消しました: ログイン {} 件、ワンタイムパスワード {} 件（つながっている人は 15 秒ほどで切れます）",
                sessions.len(),
                otps
            );
        }
    }
    Ok(())
}

fn git_mode(no_git: bool, require_git: bool) -> GitMode {
    if no_git {
        GitMode::Off
    } else if require_git {
        GitMode::Require
    } else {
        GitMode::Auto
    }
}

/// komenagare init
fn run_init(dir: &Path, git_mode: GitMode, file: Option<&Path>) -> Result<()> {
    let ws = Workspace::init(dir, git_mode)?;
    println!(
        "作業フォルダを作りました: {}（履歴: {}）",
        ws.dir.display(),
        if ws.git { "git" } else { "なし" }
    );
    if let Some(file) = file {
        let mut store = Store::new(ws.load_comments()?);
        let n = import(&ws, &mut store, file)?;
        println!("{} から {} 件のコメントを取り込みました", file.display(), n);
    }
    if dir == Path::new(".") {
        println!("始めるには: komenagare");
    } else {
        println!("始めるには: komenagare {}", dir.display());
    }
    Ok(())
}

/// コメナガレの JSON（{ "comments": [...] } または配列）か JSONL を取り込む。既にある id は飛ばす
fn import(ws: &Workspace, store: &mut Store, file: &Path) -> Result<usize> {
    let mut ops = vec![];
    for it in files::read(file)? {
        if it.text.trim().is_empty() {
            continue;
        }
        let id = it
            .id
            .filter(|s| is_uuid(s))
            .map(|s| s.to_lowercase())
            .unwrap_or_else(uuid_v7);
        if store.get(&id).is_some() {
            continue;
        }
        ops.push(Op::Add {
            id,
            after: Fields {
                t: Some((it.t.max(0.0) * 100.0).round() / 100.0),
                cmd: Some(it.cmd.split_whitespace().collect::<Vec<_>>().join(" ")),
                text: Some(it.text.replace("\r\n", "\n").replace('\r', "\n")),
            },
        });
    }
    let change = Change { id: uuid_v7(), ops };
    let r = store.apply(&change, false);
    let Some(applied) = r.applied else {
        return Ok(0);
    };
    let n = applied.ops.len();
    ws.save(
        store,
        &format!(
            "komenagare: {} から {n} 件取り込み",
            file.file_name().unwrap_or_default().to_string_lossy()
        ),
        "komenagare",
        "komenagare@localhost",
        &[("Change-Id", &change.id)],
    )?;
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    ws.append_log(&LogEntry {
        rev: 0,
        time,
        author: "komenagare".into(),
        change: applied,
    })?;
    Ok(n)
}

/// 配信する Web アプリを決める（必要なら最新版を取ってくる）
async fn prepare_web(args: &Args) -> (web::Source, String) {
    if let Some(d) = &args.web {
        return (
            web::Source::Dir(d.clone()),
            format!("{}（--web）", d.display()),
        );
    }
    let bundled = (
        web::Source::Bundled,
        format!("内蔵（komenagare {}）", env!("CARGO_PKG_VERSION")),
    );
    if args.bundled_web {
        return bundled;
    }
    let Some(dir) = web::cache_dir() else {
        return bundled;
    };
    let mut latest = false;
    if !args.no_update {
        let (url, d) = (args.web_url.clone(), dir.clone());
        match tokio::task::spawn_blocking(move || web::update(&url, &d)).await {
            Ok(Ok(web::Outcome::Updated(n))) => {
                latest = true;
                println!("Web アプリを最新版に更新しました（{n} ファイル）");
            }
            Ok(Ok(web::Outcome::UpToDate)) => latest = true,
            Ok(Ok(web::Outcome::Incompatible(p))) => eprintln!("注意: {}", incompatible_message(p)),
            Ok(Err(e)) => eprintln!("注意: Web アプリの更新を確かめられませんでした（{e:#}）"),
            Err(e) => eprintln!("注意: Web アプリの更新に失敗しました（{e}）"),
        }
    }
    if web::cached_usable(&dir) {
        let what = if latest {
            "最新版"
        } else {
            "前回取得した版"
        };
        (
            web::Source::Dir(dir.clone()),
            format!("{what}（{}）", dir.display()),
        )
    } else {
        bundled
    }
}

fn incompatible_message(protocol: u32) -> String {
    format!(
        "最新の Web アプリ（取り決め {protocol}）はこの komenagare（取り決め {}）では使えないため、前回のもの（無ければ内蔵のもの）を使います。\n\
         最新版を使うには komenagare を更新してください: komenagare update",
        server::PROTOCOL
    )
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn random_token() -> String {
    const CH: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
    let mut r = rand::rng();
    (0..10)
        .map(|_| CH[r.random_range(0..CH.len())] as char)
        .collect()
}

/// 同じネットワークの人に見せるアドレス（実際には通信しない）
fn lan_ip() -> Option<std::net::IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

fn open_browser(url: &str) {
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        "xdg-open"
    };
    if std::process::Command::new(cmd).arg(url).spawn().is_err() {
        eprintln!("ブラウザを開けませんでした。上の URL を開いてください");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uuid_v7_format() {
        let a = uuid_v7();
        assert!(is_uuid(&a));
        assert_eq!(&a[14..15], "7");
        assert!("89ab".contains(&a[19..20]));
    }
    #[test]
    fn token_length() {
        assert_eq!(random_token().len(), 10);
    }
}
