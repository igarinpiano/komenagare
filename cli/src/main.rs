//! komenagare: コメナガレを複数人で編集するためのホスト
//!
//!   komenagare [フォルダ] [--host 0.0.0.0] [--port 8764] ...
//!
//! フォルダの comments.jsonl を読み込み、Web アプリを配信する。ブラウザから届いた変更は
//! comments.jsonl に書き込み、git があれば変更ごとにコミットする。

mod server;
mod store;
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
    /// 作業フォルダ（comments.jsonl と履歴を置く）。無ければ作る
    #[arg(default_value = ".")]
    dir: PathBuf,
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
    /// git が無ければ起動しない
    #[arg(long, conflicts_with = "no_git")]
    require_git: bool,
    /// git を使わない（履歴を残さない）
    #[arg(long)]
    no_git: bool,
    /// コメナガレで保存したファイル（.json / .jsonl）のコメントを取り込んでから始める
    #[arg(long, value_name = "FILE")]
    import: Option<PathBuf>,
    /// 起動したらブラウザで開く
    #[arg(long)]
    open: bool,
    /// 起動時に Web アプリの更新を確かめない（前回取ってきたもの、無ければ内蔵のものを使う）
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
enum Cmd {
    /// Web アプリの最新版を取ってくる（起動時にも自動で確かめる）
    UpdateWeb {
        /// Web アプリの取得元
        #[arg(long, value_name = "URL", env = "KOMENAGARE_WEB_URL", default_value = web::DEFAULT_URL)]
        web_url: String,
    },
}

#[tokio::main]
async fn main() {
    if let Err(e) = run(Args::parse()).await {
        eprintln!("エラー: {e:#}");
        std::process::exit(1);
    }
}

async fn run(args: Args) -> Result<()> {
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
    let git_mode = if args.no_git {
        GitMode::Off
    } else if args.require_git {
        GitMode::Require
    } else {
        GitMode::Auto
    };
    let ws = Workspace::open(&args.dir, git_mode)?;
    let mut store = Store::new(ws.load_comments()?);
    let (seen, rev) = ws.load_log()?;

    if let Some(file) = &args.import {
        let n = import(&ws, &mut store, file)?;
        println!("{} から {} 件のコメントを取り込みました", file.display(), n);
    }

    let (web_source, web_label) = prepare_web(&args).await;
    let token = if args.no_token {
        None
    } else {
        Some(args.token.clone().unwrap_or_else(random_token))
    };
    let dir = ws.dir.clone();
    let workspace_id = ws.id.clone();
    let git = ws.git;
    let (writer, writer_thread) = server::spawn_writer(ws);
    let count = store.len();
    let hub = server::Hub::new(
        store,
        rev,
        seen,
        writer,
        token.clone(),
        match web_source {
            web::Source::Dir(d) => Some(d),
            web::Source::Bundled => None,
        },
        workspace_id,
    );

    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .context("--host / --port の指定が正しくありません")?;
    let listener = tokio::net::TcpListener::bind(addr).await.with_context(|| {
        format!("{addr} で待ち受けできません（--port で別のポートを指定してください）")
    })?;

    let query = token
        .as_ref()
        .map(|t| format!("?k={t}"))
        .unwrap_or_default();
    let local = format!(
        "http://{}:{}/{}",
        if addr.ip().is_unspecified() {
            "127.0.0.1".into()
        } else {
            addr.ip().to_string()
        },
        addr.port(),
        query
    );
    println!("komenagare {}", env!("CARGO_PKG_VERSION"));
    println!(
        "  作業フォルダ: {}（履歴: {}）",
        dir.display(),
        if git { "git" } else { "なし" }
    );
    println!("  コメント: {count} 件");
    println!("  Web アプリ: {web_label}");
    println!("  開く: {local}");
    if addr.ip().is_unspecified() {
        if let Some(ip) = lan_ip() {
            println!("  共有: http://{ip}:{}/{query}", addr.port());
        }
    } else if addr.ip().is_loopback() {
        println!("  ほかの人と共有するには --host 0.0.0.0 を付けて起動してください");
    }
    if token.is_none() {
        println!("  注意: 合言葉なしで起動しています。URL を知っている人は誰でも編集できます");
    }
    println!("  終了: Ctrl+C");
    if args.open {
        open_browser(&local);
    }

    let stop = hub.shutdown.clone();
    axum::serve(listener, server::router(hub))
        .with_graceful_shutdown(async move {
            let _ = tokio::signal::ctrl_c().await;
            // つながっている WebSocket を閉じないと終われない
            let _ = stop.send(true);
        })
        .await?;
    println!("終了しています（書き込み中の変更を保存します）…");
    // Hub が持つ送り口が全部閉じると書き込み担当が終わる
    tokio::task::spawn_blocking(move || {
        let _ = writer_thread.join();
    })
    .await?;
    Ok(())
}

/// コメナガレの JSON（{ "comments": [...] } または配列）か JSONL を取り込む。既にある id は飛ばす
fn import(ws: &Workspace, store: &mut Store, file: &Path) -> Result<usize> {
    let text = std::fs::read_to_string(file)
        .with_context(|| format!("{} を読めません", file.display()))?;
    let text = text.trim_start_matches('\u{feff}');
    let items: Vec<serde_json::Value> = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Array(a)) => a,
        Ok(v) if v["comments"].is_array() => v["comments"].as_array().cloned().unwrap_or_default(),
        _ => text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .context("コメナガレの JSON / JSONL として読めません")?,
    };
    let mut ops = vec![];
    for it in items {
        let Some(t) = it["t"].as_f64() else { continue };
        let text = it["text"].as_str().unwrap_or_default().to_string();
        if text.trim().is_empty() {
            continue;
        }
        let id = it["id"]
            .as_str()
            .filter(|s| is_uuid(s))
            .map(str::to_lowercase)
            .unwrap_or_else(uuid_v7);
        if store.get(&id).is_some() {
            continue;
        }
        let cmd = it["cmd"].as_str().unwrap_or_default().to_string();
        ops.push(Op::Add {
            id,
            after: Fields {
                t: Some((t * 100.0).round() / 100.0),
                cmd: Some(cmd),
                text: Some(text),
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
    ws.append_log(&LogEntry {
        rev: 0,
        time: 0,
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
         最新版を使うには komenagare を更新してください: curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh",
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
