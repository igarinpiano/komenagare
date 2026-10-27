// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! リモートのコマンド（--remote）。許された参加者が、画面の「ターミナル」からホストの作業フォルダで
//! コマンドを打てるようにする（SSH のように。ただし端末ではないので、入力を求めるコマンドは使えない）。
//!
//! 種類
//!   git:   git の決まったサブコマンドだけ。シェルは通さない。ほかのプログラムを動かせたり、
//!          設定を変えたり、作業フォルダの外のファイルを読み書きできたりするオプションは断る
//!   shell: 何でも（sh -c / cmd /C）。ホストのパソコンを預けるのと同じなので、信頼できる人だけに
//!
//! 使える人（--remote-users）: admin（管理者）・all（全員）・参加者の名前（個別）を「,」で区切って並べる。
//! 誰が打ったかを確かめるため、--otp のときだけ使える。打ったコマンドはホストの画面と
//! .komenagare/commands.log に残す。

use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
pub enum Mode {
    /// git の決まったサブコマンドだけ
    Git,
    /// 何でも（シェルを通す）
    Shell,
}

impl Mode {
    pub fn label(self) -> &'static str {
        match self {
            Mode::Git => "git",
            Mode::Shell => "shell",
        }
    }
}

pub struct Remote {
    pub mode: Mode,
    /// admin / all / 名前
    pub users: Vec<String>,
}

impl Remote {
    pub fn new(mode: Mode, users: &str) -> Remote {
        let users = users
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        Remote { mode, users }
    }

    /// この人が使えるか
    pub fn allows(&self, name: &str, admin: bool) -> bool {
        self.users
            .iter()
            .any(|u| u == "all" || (u == "admin" && admin) || u == name)
    }

    /// 起動時に出す説明
    pub fn describe(&self) -> String {
        let who: Vec<String> = self
            .users
            .iter()
            .map(|u| match u.as_str() {
                "admin" => "管理者".to_string(),
                "all" => "全員".to_string(),
                n => n.to_string(),
            })
            .collect();
        let what = match self.mode {
            Mode::Git => "git の決まったサブコマンドだけ",
            Mode::Shell => "何でも（シェル）",
        };
        format!("{what}、使える人: {}", who.join("・"))
    }
}

/// 1回に返す出力の上限（バイト）。超えたら止める
const OUTPUT_MAX: usize = 4 << 20;
/// 1つのコマンドを動かしておける時間
const TIME_LIMIT: Duration = Duration::from_secs(15 * 60);
/// 1行の長さの上限
const LINE_MAX: usize = 8 * 1024;

/// git で使えるサブコマンド
const GIT_COMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "shortlog",
    "describe",
    "reflog",
    "branch",
    "tag",
    "switch",
    "checkout",
    "restore",
    "reset",
    "add",
    "rm",
    "mv",
    "commit",
    "stash",
    "merge",
    "revert",
    "cherry-pick",
    "fetch",
    "pull",
    "push",
    "remote",
];

/// 断るオプション（長い名前。git は曖昧でなければ途中までの名前も受け付けるので、これの先頭部分も断る）
const GIT_DENY_LONG: &[&str] = &[
    // ほかのプログラムを動かす
    "--upload-pack",
    "--receive-pack",
    "--exec",
    "--ext-diff",
    "--open-files-in-pager",
    // 作業フォルダの外のファイルを読み書きする
    "--output",
    "--no-index",
    "--file",
    "--template",
    "--pathspec-from-file",
    "--contents",
    "--ignore-revs-file",
    "--git-dir",
    "--work-tree",
];

/// 断る短いオプション（サブコマンドごと）
fn git_deny_short(sub: &str) -> &'static [char] {
    match sub {
        // -F <ファイル>（メッセージをファイルから読む）、-t <ファイル>（テンプレート）
        "commit" => &['F', 't'],
        "tag" | "merge" => &['F'],
        // -S <ファイル>（無視するコミットの一覧）
        "blame" => &['S'],
        _ => &[],
    }
}

/// git のコマンドとして打ってよいか（args は git の後ろ）
pub fn check_git(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("git のサブコマンドを指定してください（例: git status）".into());
    };
    if sub.starts_with('-') {
        return Err(format!(
            "git の後ろには、すぐサブコマンドを書いてください（{sub} は使えません）"
        ));
    }
    if !GIT_COMMANDS.contains(&sub.as_str()) {
        return Err(format!(
            "git {sub} は使えません（使えるのは {}）",
            GIT_COMMANDS.join(" / ")
        ));
    }
    let deny_short = git_deny_short(sub);
    for a in &args[1..] {
        if a == "--" {
            break;
        }
        if let Some(long) = a.strip_prefix("--") {
            let name = format!("--{}", long.split('=').next().unwrap_or(""));
            if name.len() > 3 && GIT_DENY_LONG.iter().any(|d| d.starts_with(&name)) {
                return Err(format!("{name} は使えません"));
            }
        } else if let Some(short) = a.strip_prefix('-') {
            if let Some(c) = short.chars().find(|c| deny_short.contains(c)) {
                return Err(format!("git {sub} の -{c} は使えません"));
            }
        }
    }
    Ok(())
}

/// コマンドの行を語に分ける（'…' と "…" と \ を解釈する）
pub fn split_words(line: &str) -> Result<Vec<String>, String> {
    let mut words = vec![];
    let mut cur = String::new();
    let mut has = false;
    let mut it = line.chars();
    while let Some(c) = it.next() {
        match c {
            '\'' => {
                has = true;
                loop {
                    match it.next() {
                        Some('\'') => break,
                        Some(c) => cur.push(c),
                        None => return Err("' が閉じていません".into()),
                    }
                }
            }
            '"' => {
                has = true;
                loop {
                    match it.next() {
                        Some('"') => break,
                        Some('\\') => match it.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => cur.push(c),
                            Some(c) => {
                                cur.push('\\');
                                cur.push(c);
                            }
                            None => return Err("\" が閉じていません".into()),
                        },
                        Some(c) => cur.push(c),
                        None => return Err("\" が閉じていません".into()),
                    }
                }
            }
            '\\' => {
                has = true;
                if let Some(c) = it.next() {
                    cur.push(c);
                }
            }
            c if c.is_whitespace() => {
                if has {
                    words.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                has = true;
                cur.push(c);
            }
        }
    }
    if has {
        words.push(cur);
    }
    Ok(words)
}

/// 実行するコマンドを組み立てる（打ってよくなければ理由）
pub fn build(mode: Mode, line: &str, dir: &Path) -> Result<tokio::process::Command, String> {
    let line = line.trim();
    if line.is_empty() {
        return Err("コマンドを入れてください".into());
    }
    if line.len() > LINE_MAX {
        return Err("コマンドが長すぎます".into());
    }
    let mut cmd = match mode {
        Mode::Git => {
            let words = split_words(line)?;
            if words.first().map(String::as_str) != Some("git") {
                return Err("git のコマンドだけが使えます（例: git status）".into());
            }
            check_git(&words[1..])?;
            let mut c = tokio::process::Command::new("git");
            c.args(&words[1..]);
            c
        }
        Mode::Shell => {
            if cfg!(windows) {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C").arg(line);
                c
            } else {
                let mut c = tokio::process::Command::new("sh");
                c.arg("-c").arg(line);
                c
            }
        }
    };
    cmd.current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        // 入力を待って止まらないようにする（パスワードを聞かない・エディタを開かない・ページャーを使わない）
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_PAGER", "cat")
        .env("PAGER", "cat")
        .env("TERM", "dumb");
    // ホストの端末から切り離す（ssh などが端末でパスワードを聞いて止まらないように）。
    // 新しいセッションはプロセスグループも別になるので、子プロセスもまとめて止められる
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    Ok(cmd)
}

/// 出力を UTF-8 の文字の途中で切らないように区切る
#[derive(Default)]
struct Utf8Chunks {
    pending: Vec<u8>,
}

impl Utf8Chunks {
    fn push(&mut self, data: &[u8]) -> String {
        self.pending.extend_from_slice(data);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            // 末尾が文字の途中なら、そこまでを返して残りは次に回す
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => self.pending.len(),
        };
        let rest = self.pending.split_off(valid);
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending = rest;
        out
    }
    fn finish(&mut self) -> String {
        let out = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        out
    }
}

/// 子プロセスを（子の子も）止める
fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // setsid で作ったので、プロセスグループの id は pid と同じ
        unsafe {
            libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.start_kill();
}

/// 送るもの（run_out / run_end の JSON）
pub type Sender = Box<dyn Fn(String) + Send + Sync>;

/// コマンドを動かし、出力を send で返す。stop が届くか、時間・出力の上限を超えたら止める。終了コードを返す
pub async fn run(
    mut cmd: tokio::process::Command,
    id: String,
    send: Sender,
    mut stop: tokio::sync::oneshot::Receiver<()>,
) -> Option<i32> {
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            send(json!({ "type": "run_end", "id": id, "code": null, "message": format!("実行できません: {e}") }).to_string());
            return None;
        }
    };
    let mut out = child.stdout.take().expect("stdout");
    let mut err = child.stderr.take().expect("stderr");
    let (mut ob, mut eb) = ([0u8; 8192], [0u8; 8192]);
    let (mut od, mut ed) = (Utf8Chunks::default(), Utf8Chunks::default());
    let (mut out_open, mut err_open) = (true, true);
    let mut total = 0usize;
    let mut why: Option<&str> = None;
    let deadline = tokio::time::sleep(TIME_LIMIT);
    tokio::pin!(deadline);
    let chunk = |data: String, is_err: bool| {
        if !data.is_empty() {
            send(json!({ "type": "run_out", "id": id, "data": data, "err": is_err }).to_string());
        }
    };
    while out_open || err_open {
        tokio::select! {
            r = out.read(&mut ob), if out_open => match r {
                Ok(0) | Err(_) => { out_open = false; chunk(od.finish(), false); }
                Ok(n) => { total += n; chunk(od.push(&ob[..n]), false); }
            },
            r = err.read(&mut eb), if err_open => match r {
                Ok(0) | Err(_) => { err_open = false; chunk(ed.finish(), true); }
                Ok(n) => { total += n; chunk(ed.push(&eb[..n]), true); }
            },
            _ = &mut stop => { why = Some("止めました"); break; }
            _ = &mut deadline => { why = Some("時間がかかりすぎるため止めました"); break; }
        }
        if total > OUTPUT_MAX {
            why = Some("出力が多すぎるため止めました");
            break;
        }
    }
    if why.is_some() {
        kill_tree(&mut child);
    }
    let code = match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(s)) => s.code(),
        _ => {
            kill_tree(&mut child);
            None
        }
    };
    send(json!({ "type": "run_end", "id": id, "code": code, "message": why }).to_string());
    code
}

/// 打ったコマンドを .komenagare/commands.log に残す
pub fn log(dir: &Path, name: &str, line: &str, code: Option<i32>, time: u64) {
    let path: PathBuf = dir.join(".komenagare").join("commands.log");
    let rec = json!({ "time": time, "name": name, "line": line, "code": code }).to_string();
    let r = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, format!("{rec}\n").as_bytes()));
    if let Err(e) = r {
        eprintln!("コマンドの記録に失敗しました: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(s: &str) -> Vec<String> {
        split_words(s).unwrap()
    }

    #[test]
    fn splits_words_like_a_shell() {
        assert_eq!(w("git status"), ["git", "status"]);
        assert_eq!(
            w(r#"git commit -m "直した \"件\"" "#),
            ["git", "commit", "-m", "直した \"件\""]
        );
        assert_eq!(w("a 'b c' d\\ e ''"), ["a", "b c", "d e", ""]);
        assert!(split_words("git commit -m \"abc").is_err());
        assert!(w("   ").is_empty());
    }

    #[test]
    fn allows_only_safe_git() {
        let ok = |s: &str| check_git(&w(s)).is_ok();
        assert!(ok("status"));
        assert!(ok("log --oneline -n 20"));
        assert!(ok("commit -am 'メッセージ'"));
        assert!(ok("push -u origin main"));
        assert!(ok("diff --stat HEAD~1"));
        assert!(ok("diff --output-indicator-new=+"));
        assert!(ok("cherry-pick -x abc123"));
        // ファイル名として -- の後ろに書いたものは見ない
        assert!(ok("add -- --output"));
        // サブコマンドの前のオプション（-c で設定を変えるなど）
        assert!(!ok("-c core.pager=sh status"));
        assert!(!ok("--git-dir=/etc status"));
        assert!(!ok(""));
        // 使えないサブコマンド
        assert!(!ok("config core.fsmonitor 'rm -rf ~'"));
        assert!(!ok("submodule foreach ls"));
        assert!(!ok("difftool -x sh"));
        // ほかのプログラムを動かす・外のファイルを読み書きするオプション（途中までの名前も）
        assert!(!ok("fetch --upload-pack=sh"));
        assert!(!ok("fetch --upload=sh"));
        assert!(!ok("push --receive-pack sh origin"));
        assert!(!ok("push --exec=sh"));
        assert!(!ok("log --output=/tmp/x"));
        assert!(!ok("diff --no-index /etc/passwd /dev/null"));
        assert!(!ok("commit -F /etc/passwd"));
        assert!(!ok("commit -aF /etc/passwd"));
        assert!(!ok("commit --file=/etc/passwd"));
        assert!(!ok("blame --contents /etc/passwd README"));
        assert!(!ok("add --pathspec-from-file=/etc/passwd"));
    }

    #[test]
    fn checks_users() {
        let r = Remote::new(Mode::Git, "admin, たろう");
        assert!(r.allows("だれか", true));
        assert!(r.allows("たろう", false));
        assert!(!r.allows("はなこ", false));
        assert!(Remote::new(Mode::Git, "all").allows("はなこ", false));
        assert!(!Remote::new(Mode::Git, "").allows("はなこ", true));
    }

    #[test]
    fn keeps_utf8_characters_whole() {
        let mut d = Utf8Chunks::default();
        let s = "あい".as_bytes();
        assert_eq!(d.push(&s[..2]), "");
        assert_eq!(d.push(&s[2..4]), "あ");
        assert_eq!(d.push(&s[4..]), "い");
        assert_eq!(d.push(&[0xff, b'a']), "\u{fffd}a");
        assert_eq!(d.push(&s[..1]), "");
        assert_eq!(d.finish(), "\u{fffd}");
    }

    #[tokio::test]
    async fn runs_and_stops_commands() {
        let dir = tempfile::tempdir().unwrap();
        let got = std::sync::Arc::new(std::sync::Mutex::new(vec![]));
        let g = got.clone();
        let send: Sender = Box::new(move |m| g.lock().unwrap().push(m));
        let (_tx, rx) = tokio::sync::oneshot::channel();
        let cmd = build(Mode::Shell, "echo hello", dir.path()).unwrap();
        assert_eq!(run(cmd, "1".into(), send, rx).await, Some(0));
        let msgs = got.lock().unwrap().join("\n");
        assert!(msgs.contains("hello") && msgs.contains("run_end"));

        // 止めると子プロセスごと止まる
        let send: Sender = Box::new(|_| {});
        let (tx, rx) = tokio::sync::oneshot::channel();
        let line = if cfg!(windows) {
            "ping -n 30 127.0.0.1"
        } else {
            "sleep 30 | cat"
        };
        let cmd = build(Mode::Shell, line, dir.path()).unwrap();
        let h = tokio::spawn(run(cmd, "2".into(), send, rx));
        tokio::time::sleep(Duration::from_millis(300)).await;
        tx.send(()).unwrap();
        let r = tokio::time::timeout(Duration::from_secs(10), h).await;
        assert!(r.is_ok(), "止まらない");

        // git の種類では git 以外は断る
        assert!(build(Mode::Git, "ls", dir.path()).is_err());
        assert!(build(Mode::Git, "git config x y", dir.path()).is_err());
        assert!(build(Mode::Git, "git status", dir.path()).is_ok());
    }
}
