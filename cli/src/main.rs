// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! komenagare: コメナガレを複数人で編集するためのホスト
//!
//!   komenagare [フォルダ...] [--host 0.0.0.0] [--port 8764] [--otp] ...
//!
//! フォルダ（1フォルダ1プロジェクト。複数渡すとまとめて共有する）の comments.jsonl を読み込み、
//! Web アプリを配信する。ブラウザから届いた変更は comments.jsonl に書き込み、git があれば変更ごとにコミットする。

mod auth;
mod awake;
mod collection;
mod files;
mod firewall;
mod output;
mod remote;
mod render;
mod server;
mod sign;
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
    /// ログインの有効期限（ログインしてからの時間。例 30d・12h。既定 30d）。none で無期限（--otp のとき）。
    /// 過ぎたらワンタイムパスワードでログインし直す
    #[arg(long, value_name = "TTL", requires = "otp")]
    session_ttl: Option<String>,
    /// ワンタイムパスワードとログインの記録を置く場所（既定は ~/.config/komenagare/auth など）
    #[arg(long, value_name = "DIR", env = "KOMENAGARE_AUTH_DIR")]
    auth_dir: Option<PathBuf>,
    /// トンネルを始めて、ローカルネットワークの外から入れるようにする（cloudflared / tailscale / ngrok が必要）
    #[arg(long, value_enum, value_name = "KIND")]
    tunnel: Option<tunnel::Kind>,
    /// 入れる人をメールアドレスで絞る（--tunnel cloudflare と --otp のとき。cloudflared 2026.9.3 以上）。
    /// 開いた人はまずメールに届く PIN で確認する（最長 4 時間）。「,」区切りか繰り返しで並べ、'*@example.com' でドメインごと
    #[arg(long, value_name = "EMAIL", requires = "tunnel")]
    allowed_mail: Vec<String>,
    /// 外から入るときの URL（自分で用意したトンネルやリバースプロキシのもの。共有・招待のリンクに使う）
    #[arg(
        long,
        value_name = "URL",
        env = "KOMENAGARE_PUBLIC_URL",
        conflicts_with = "tunnel"
    )]
    public_url: Option<String>,
    /// 許された参加者が、画面の「ターミナル」から作業フォルダでコマンドを打てるようにする（--otp が必要）。
    /// git: git の決まったサブコマンドだけ。shell: 何でも（このパソコンを預けるのと同じ。信頼できる人だけに）
    #[arg(long, value_enum, value_name = "KIND", requires = "otp")]
    remote: Option<remote::Mode>,
    /// リモートのコマンドを使える人。admin（管理者）・all（全員）・参加者の名前を「,」で区切って並べる
    #[arg(long, value_name = "WHO", default_value = "admin", requires = "remote")]
    remote_users: String,
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
    /// 画面に出す内容（起動時の URL・参加者の出入りなど）をこのファイルに書き足す（裏で動かすとき用）
    #[arg(long, value_name = "FILE", env = "KOMENAGARE_LOG")]
    log: Option<PathBuf>,
    /// ほかの人と共有している間も、このパソコンのスリープを止めない
    /// （既定では --host 0.0.0.0・--tunnel・--public-url のとき、終わるまでスリープさせない）
    #[arg(long)]
    allow_sleep: bool,
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
        /// 作業フォルダにする場所（複数並べられる）。無ければ作る。git で複製したフォルダ（comments.jsonl がある）なら、
        /// コメントはそのままで作業用の記録（.komenagare。git には入らない）だけを作る。
        /// まとめフォルダの中に作ると、その一覧（komenagare.json）にも載せる
        #[arg(default_value = ".")]
        dirs: Vec<PathBuf>,
        /// プロジェクトではなく、まとめフォルダ（いくつものプロジェクトを1つのフォルダ・1つの git リポジトリで持つ）を作る。
        /// 中のプロジェクトが自分の .git を持っていれば、その履歴をまとめフォルダのリポジトリに取り込む
        #[arg(long, conflicts_with = "import")]
        collection: bool,
        /// git の履歴を取り込むときに確かめない
        #[arg(short, long)]
        yes: bool,
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
    /// まとめフォルダを解除して、プロジェクトごとの git リポジトリに分ける（履歴はプロジェクトごとに切り出す。
    /// コメントとプロジェクトの id はそのまま）
    Split {
        /// まとめフォルダ
        #[arg(default_value = ".")]
        dir: PathBuf,
        /// 確かめずに分ける
        #[arg(short, long)]
        yes: bool,
    },
    /// まとめフォルダの一覧からプロジェクトを外す（フォルダとコメントは残す。komenagare init 名前 で戻せる）。
    /// 動いているホストには次の起動から効く（動いている間は画面の「外す」を使う）
    Remove {
        /// プロジェクトの名前（まとめフォルダの中のフォルダの名前。まとめフォルダ/名前 でも）
        #[arg(required = true)]
        names: Vec<PathBuf>,
        /// git を使わない（一覧の変更をコミットしない）
        #[arg(long)]
        no_git: bool,
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
        /// 高さ（ピクセル）。幅は元の動画と同じ縦横比（--wide なら 16:9）になる。
        /// 省略すると元の動画と同じ大きさ（8K なら 8K。--ass で動画を指定しないときは 1080）
        #[arg(long)]
        height: Option<u32>,
        /// コメントを流す範囲を 16:9 に固定する（ニコニコ動画と同じ。縦長の動画は左右に帯が付く）。
        /// 既定は元の動画と同じ縦横比で、縦長の動画なら縦長に書き出す
        #[arg(long)]
        wide: bool,
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
        /// 映像のビットレート（Mbps の数値か same＝元の動画と同じ）。指定すると CRF の代わりに使う
        #[arg(long, value_name = "MBPS|same", value_parser = render::parse_bitrate, conflicts_with = "crf")]
        bitrate: Option<render::Bitrate>,
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
        /// 有効期限（例 10m・1h・7d。既定は数字なら 10m、英数字なら 7d。数字は当てられやすいので長くても 1h）
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
        wide,
        fps,
        start,
        end,
        crf,
        bitrate,
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
        // 動画を指定したときは、その縦横比に合わせる
        let src = match video {
            Some(v) => Some(render::probe(v)?),
            None => None,
        };
        let (aspect, src_h) = render::output_shape(src.map(|s| (s.w, s.h)), *wide);
        let (w, h) = render::even_size(height.unwrap_or(src_h), aspect);
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
            wide: *wide,
            fps: *fps,
            start: *start,
            end: *end,
            crf: *crf,
            bitrate: *bitrate,
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
        dirs,
        no_git,
        require_git,
        import: file,
        collection,
        yes,
    }) = &args.cmd
    {
        let mode = git_mode(*no_git, *require_git);
        if *collection {
            if dirs.len() > 1 {
                bail!("まとめフォルダは1つずつ作ってください");
            }
            let nested = collection::own_git_projects(&dirs[0]);
            let absorb = !nested.is_empty() && mode != GitMode::Off && workspace::git_available();
            if absorb {
                println!(
                    "{} は、それぞれ自分の git リポジトリ（.git）を持っています。",
                    nested.join("・")
                );
                println!("その履歴をまとめフォルダのリポジトリに取り込みます（コメントとプロジェクトの id はそのまま。元の .git は .komenagare/git-backup/ に控えます）。");
                if !confirm("取り込みますか？", *yes)? {
                    println!("やめました（何も変えていません）");
                    return Ok(());
                }
            }
            let c = collection::Collection::create(&dirs[0], mode, absorb)?;
            let n = c.entries()?.len();
            println!(
                "まとめフォルダを作りました: {}（{}）",
                c.dir.display(),
                if n > 0 {
                    format!("中のプロジェクト {n} 件を載せました")
                } else {
                    "プロジェクトはまだありません".to_string()
                }
            );
            let shown = dirs[0].display().to_string();
            let cd = if dirs[0] == Path::new(".") {
                String::new()
            } else {
                format!("cd {shown} && ")
            };
            println!(
                "プロジェクトを作るには: {cd}komenagare init 名前（ホストの画面からも作れます）"
            );
            println!(
                "始めるには: komenagare{}",
                if cd.is_empty() {
                    String::new()
                } else {
                    format!(" {shown}")
                }
            );
            return Ok(());
        }
        if file.is_some() && dirs.len() > 1 {
            bail!("--import は作業フォルダを1つだけ指定したときに使えます");
        }
        return run_init(dirs, mode, file.as_deref(), *yes);
    }
    if let Some(Cmd::Split { dir, yes }) = &args.cmd {
        let c = collection::Collection::open(dir, GitMode::Auto)?;
        let targets = c.split_targets()?;
        println!(
            "まとめフォルダ {} を解除して、{} をそれぞれの git リポジトリに分けます。",
            c.dir.display(),
            targets.join("・")
        );
        println!("履歴はプロジェクトごとに切り出します（コメントとプロジェクトの id はそのまま。今のリポジトリ（.git）と komenagare.json は .komenagare/git-backup/ に控えます）。");
        if !confirm("分けますか？", *yes)? {
            println!("やめました（何も変えていません）");
            return Ok(());
        }
        let done = c.split()?;
        for (name, n) in &done {
            println!("  {name}: 分けました（コミット {n} 件）");
        }
        println!(
            "控え: {}（うまくいったら消して構いません）",
            c.dir.join(".komenagare").join("git-backup").display()
        );
        let names: Vec<String> = done.iter().map(|(n, _)| format!(" {n}")).collect();
        println!(
            "まとめて始めるには（まとめフォルダだった場所で）: komenagare{}",
            names.concat()
        );
        return Ok(());
    }
    if let Some(Cmd::Remove { names, no_git }) = &args.cmd {
        let mode = git_mode(*no_git, false);
        for path in names {
            let (dir, name) = match (path.parent(), path.file_name().and_then(|n| n.to_str())) {
                (Some(p), Some(n)) if !p.as_os_str().is_empty() => (p.to_path_buf(), n),
                (_, Some(n)) => (PathBuf::from("."), n),
                _ => bail!("{} を読めません", path.display()),
            };
            if !collection::Collection::is_collection(&dir) {
                bail!(
                    "{} はまとめフォルダではありません（まとめフォルダの中で komenagare remove 名前 とします）",
                    dir.canonicalize().unwrap_or(dir.clone()).display()
                );
            }
            let c = collection::Collection::open(&dir, mode)?;
            let Some(e) = c.entries()?.into_iter().find(|e| e.dir == name) else {
                bail!("「{name}」はまとめフォルダの一覧にありません");
            };
            c.remove(&e.id, "komenagare")?;
            println!(
                "「{name}」を一覧から外しました（フォルダとコメントは残っています。戻すには komenagare init {name}）"
            );
        }
        return Ok(());
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
    if let Some(path) = &args.log {
        output::to_file(path)?;
    }
    let mode = git_mode(args.no_git, args.require_git);
    // まとめフォルダ（komenagare.json がある）なら、一覧のプロジェクトを全部開く（画面から足したり外したりもできる）
    let mut coll: Option<collection::Collection> = None;
    let mut workspaces = vec![];
    for dir in &args.dirs {
        if !Workspace::is_workspace(dir) && collection::Collection::is_collection(dir) {
            if coll.is_some() {
                bail!("まとめフォルダは1つだけ指定できます");
            }
            if args.import.is_some() {
                bail!("--import はプロジェクト（作業フォルダ）を1つだけ指定したときに使えます");
            }
            let c = collection::Collection::open(dir, mode)?;
            workspaces.extend(c.open_projects()?);
            coll = Some(c);
        } else {
            workspaces.push(Workspace::open(dir, mode)?);
        }
    }
    let mut opened: Vec<server::Loaded> = vec![];
    for ws in workspaces {
        if let Some(other) = opened.iter().find(|o| o.ws.id == ws.id) {
            bail!(
                "{} と {} は同じ作業フォルダです（同じフォルダを2回指定したか、作業フォルダをコピーしています）",
                other.ws.dir.display(),
                ws.dir.display()
            );
        }
        // 前に止まったときに書き込めていなかった変更（記録にはある）を当てて書き込む
        let mut loaded = server::load(ws)?;
        if loaded.recovered > 0 {
            println!(
                "{}: 前回書き込めていなかった変更 {} 件を書き込みました",
                loaded.ws.dir.display(),
                loaded.recovered
            );
        }
        if let Some(file) = &args.import {
            let n = import(&loaded.ws, &mut loaded.store, file)?;
            println!("{} から {} 件のコメントを取り込みました", file.display(), n);
        }
        opened.push(loaded);
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
        let mut a = auth::Auth::open(&dir)?;
        a.set_session_ttl(match args.session_ttl.as_deref().map(str::trim) {
            None => Some(auth::SESSION_TTL_DEFAULT),
            Some("none") => None,
            Some(t) => Some(
                auth::parse_ttl(t)
                    .context("--session-ttl の指定が正しくありません（例 30d・12h・none）")?,
            ),
        });
        server::Access::Otp(a)
    } else if args.no_token {
        server::Access::None
    } else {
        server::Access::Token(args.token.clone().unwrap_or_else(random_token))
    };

    let mut projects: Vec<(server::Project, std::thread::JoinHandle<()>)> = vec![];
    let mut lines = vec![];
    for l in opened {
        let base =
            l.ws.dir
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| l.ws.dir.display().to_string());
        let taken: Vec<String> = projects.iter().map(|(p, _)| p.name.clone()).collect();
        let name = server::unique_name(&base, &taken);
        lines.push(format!(
            "{name}: {}（コメント {} 件、履歴: {}）",
            l.ws.dir.display(),
            l.store.len(),
            if l.ws.git { "git" } else { "なし" }
        ));
        projects.push(server::start(l, name));
    }
    let remote = args
        .remote
        .map(|mode| remote::Remote::new(mode, &args.remote_users));
    let coll_dir = coll.as_ref().map(|c| c.dir.clone());
    let server = server::Server::new(
        projects,
        coll,
        access,
        remote,
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
    let allowed_mail = if args.allowed_mail.is_empty() {
        vec![]
    } else {
        if args.tunnel != Some(tunnel::Kind::Cloudflare) {
            bail!("--allowed-mail は --tunnel cloudflare のときだけ使えます");
        }
        // メールの確認では誰なのかが komenagare に渡らないので、名前や管理者は --otp で決める
        if !matches!(server.access, server::Access::Otp(_)) {
            bail!("--allowed-mail は --otp と一緒に使ってください（メールの確認では、誰なのかが komenagare に渡らないため）");
        }
        tunnel::parse_allowed_mail(&args.allowed_mail)?
    };
    let mut tunnel = None;
    let public = match args.tunnel {
        Some(kind) => {
            println!("{} を始めています…", kind.label());
            let (t, url) = tunnel::start(kind, addr.port(), &allowed_mail).await?;
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
    server.set_email_gate(!allowed_mail.is_empty());
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
    if let Some(d) = &coll_dir {
        println!(
            "  まとめフォルダ: {}（画面の「プロジェクト」から作る・外すことができます: {}）",
            d.display(),
            if matches!(server.access, server::Access::Otp(_)) {
                "管理者"
            } else {
                "入れる人みんな"
            }
        );
    }
    if lines.len() == 1 && coll_dir.is_none() {
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
            println!(
                "  ログインの有効期限: {}",
                match &args.session_ttl {
                    Some(t) if t.trim() == "none" => "なし（--session-ttl none）".to_string(),
                    Some(t) => format!("ログインしてから {}（--session-ttl）", t.trim()),
                    None => "ログインしてから 30 日（--session-ttl で変えられます）".to_string(),
                }
            );
        }
        _ => println!("  開く: {local}"),
    }
    if let Some(r) = &server.remote {
        println!(
            "  リモートのコマンド: {}（画面の「ターミナル」から。記録: 作業フォルダの .komenagare/commands.log）",
            r.describe()
        );
        if r.mode == remote::Mode::Shell {
            println!("  ※ --remote shell では、使える人がこのパソコンで何でもできます（ファイルの削除や、ほかのプログラムの実行も）。信頼できる人だけにしてください");
        }
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
        if !allowed_mail.is_empty() {
            println!(
                "  メールの確認: 公開 URL を開いた人は、まずメールに届く PIN で確認します（入れるのは {}。最長 4 時間）",
                allowed_mail.join("・")
            );
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
    // ほかの人とつないでいる間に寝てしまうと、全員が編集を送れなくなる
    let shared = !addr.ip().is_loopback() || public.is_some();
    let _awake = if shared && !args.allow_sleep {
        match awake::start() {
            Ok(g) => {
                println!("  スリープ防止: 終わるまでこのパソコンをスリープさせません（--allow-sleep で止める）");
                #[cfg(target_os = "macos")]
                println!(
                    "  ※ ノートパソコンのふたを閉じるとスリープします（開いたままにしてください）"
                );
                Some(g)
            }
            Err(e) => {
                println!("  スリープ防止: {e}。省電力の設定でスリープしないようにしてください");
                None
            }
        }
    } else {
        None
    };
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
    let srv = server.clone();
    // 終わるときに公開 URL の控えを消すため、記録の置き場所を覚えておく
    let otp_dir = match &server.access {
        server::Access::Otp(a) => Some(a.dir().to_path_buf()),
        _ => None,
    };
    axum::serve(
        listener,
        server::router(server).into_make_service_with_connect_info::<SocketAddr>(),
    )
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
    let writers = srv.finish();
    drop(srv);
    tokio::task::spawn_blocking(move || {
        for w in writers {
            let _ = w.join();
        }
    })
    .await?;
    Ok(())
}

/// 終わる合図を待つ。Ctrl+C（SIGINT）、systemd などからの SIGTERM、端末が閉じられたとき（SIGHUP）、
/// Windows ではウィンドウを閉じたとき・ログオフ・シャットダウン（Ctrl+Break も）。
/// どれも、書き込み中の変更を保存してから終わる（Windows は閉じてから 5 秒ほどで OS に止められるが、
/// 変更は受け取った時点で記録に書いてあるので、間に合わなくても次の起動で当て直す）
async fn shutdown_signal() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let other = async {
        use tokio::signal::unix::{signal, SignalKind};
        let wait = |kind: SignalKind| async move {
            match signal(kind) {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        // nohup などで SIGHUP を無視するよう起動されたときは、そのまま無視する（受け取るようにすると、
        // 端末を閉じたときに終わってしまう）
        let hangup = async {
            if hangup_ignored() {
                std::future::pending::<()>().await
            }
            wait(SignalKind::hangup()).await;
            // 端末はもう無いので、端末への出力は捨てる（書くと失敗して、保存する前に落ちる）
            output::detach_terminal();
        };
        tokio::select! {
            _ = wait(SignalKind::terminate()) => {}
            _ = hangup => {}
        }
    };
    #[cfg(windows)]
    let other = async {
        use tokio::signal::windows;
        let wait = |s: std::io::Result<windows::CtrlBreak>| async move {
            match s {
                Ok(mut s) => {
                    s.recv().await;
                }
                Err(_) => std::future::pending::<()>().await,
            }
        };
        // 閉じる・ログオフ・シャットダウンは型が別なので、同じ形に包んで待つ
        macro_rules! closing {
            ($f:path) => {
                async {
                    match $f() {
                        Ok(mut s) => {
                            s.recv().await;
                            // コンソールはもう無いので、そこへの出力は捨てる
                            output::detach_terminal();
                        }
                        Err(_) => std::future::pending::<()>().await,
                    }
                }
            };
        }
        tokio::select! {
            _ = wait(windows::ctrl_break()) => {}
            _ = closing!(windows::ctrl_close) => {}
            _ = closing!(windows::ctrl_logoff) => {}
            _ = closing!(windows::ctrl_shutdown) => {}
        }
    };
    #[cfg(not(any(unix, windows)))]
    let other = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {}
        _ = other => {}
    }
}

/// 起動したときに SIGHUP を無視するよう言われていたか（nohup など）
#[cfg(unix)]
fn hangup_ignored() -> bool {
    // SAFETY: 今の設定を読むだけ（変えない）
    unsafe {
        let mut old: libc::sigaction = std::mem::zeroed();
        libc::sigaction(libc::SIGHUP, std::ptr::null(), &mut old) == 0
            && old.sa_sigaction == libc::SIG_IGN
    }
}

/// y/N で確かめる（yes なら聞かない）。端末でなければ、聞けないので止める
fn confirm(question: &str, yes: bool) -> Result<bool> {
    use std::io::{IsTerminal, Write};
    if yes {
        return Ok(true);
    }
    if !std::io::stdin().is_terminal() {
        bail!(
            "確かめられないので止めました（端末から実行するか、-y を付けると確かめずに進めます）"
        );
    }
    print!("{question} [y/N] ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(matches!(line.trim().to_lowercase().as_str(), "y" | "yes"))
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
fn run_init(dirs: &[PathBuf], git_mode: GitMode, file: Option<&Path>, yes: bool) -> Result<()> {
    let mut in_collection = None;
    for dir in dirs {
        if collection::Collection::is_collection(dir) {
            bail!(
                "{} はまとめフォルダです。プロジェクトは、その中に komenagare init 名前 で作ってください",
                dir.display()
            );
        }
        // まとめフォルダの直下に作るなら、まとめフォルダの一覧にも載せる
        let parent = {
            let abs = if dir.is_absolute() {
                dir.clone()
            } else {
                std::env::current_dir()?.join(dir)
            };
            let name = abs.components().next_back().and_then(|c| match c {
                std::path::Component::Normal(n) => n.to_str().map(str::to_string),
                _ => None,
            });
            abs.parent()
                .filter(|p| collection::Collection::is_collection(p))
                .zip(name)
                .map(|(p, n)| (p.to_path_buf(), n))
        };
        let ws = match &parent {
            Some((p, name)) => {
                let c = collection::Collection::open(p, git_mode)?;
                in_collection = Some(c.dir.clone());
                let d = c.dir.join(name);
                if collection::has_own_git(&d) && workspace::in_git(&c.dir) {
                    println!("{name} は自分の git リポジトリ（.git）を持っています。");
                    println!("その履歴をまとめフォルダのリポジトリに取り込みます（コメントとプロジェクトの id はそのまま。元の .git は .komenagare/git-backup/ に控えます）。");
                    if !confirm("取り込みますか？", yes)? {
                        println!("やめました（{name} は変えていません）");
                        continue;
                    }
                    c.absorb(name)?;
                }
                c.add(name, "komenagare")?
            }
            None => Workspace::init(dir, git_mode)?,
        };
        let n = ws.load_comments()?.len();
        println!(
            "作業フォルダを作りました: {}（履歴: {}{}{}）",
            ws.dir.display(),
            if ws.git { "git" } else { "なし" },
            if n > 0 {
                format!("・コメント {n} 件")
            } else {
                String::new()
            },
            if parent.is_some() {
                "・まとめフォルダの一覧に載せました"
            } else {
                ""
            }
        );
        if let Some(file) = file {
            let mut store = Store::new(ws.load_comments()?);
            let n = import(&ws, &mut store, file)?;
            println!("{} から {} 件のコメントを取り込みました", file.display(), n);
        }
    }
    if let Some(c) = in_collection {
        let here = std::env::current_dir()
            .ok()
            .and_then(|d| d.canonicalize().ok());
        if here.as_deref() == Some(c.as_path()) {
            println!("始めるには: komenagare");
        } else {
            println!("始めるには: komenagare {}", c.display());
        }
        return Ok(());
    }
    let args: Vec<String> = dirs
        .iter()
        .filter(|d| d.as_path() != Path::new("."))
        .map(|d| format!(" {}", d.display()))
        .collect();
    println!("始めるには: komenagare{}", args.concat());
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
