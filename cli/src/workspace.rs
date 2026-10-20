//! 作業フォルダ：コメント（comments.jsonl）、変更の記録（.komenagare/log.jsonl）、git の履歴。
//!
//! comments.jsonl は1行1コメント（時刻順）。git の差分やマージがコメント単位になる。
//! クライアントから変更が届くたびに書き込み、git が使えれば1回ずつコミットする。

use crate::store::{Change, Comment, Store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const COMMENTS_FILE: &str = "comments.jsonl";
const META_DIR: &str = ".komenagare";
const LOG_FILE: &str = "log.jsonl";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GitMode {
    /// git があれば使い、なければ警告して履歴なしで動く
    Auto,
    /// git がなければ起動しない
    Require,
    /// 使わない
    Off,
}

pub struct Workspace {
    pub dir: PathBuf,
    /// 作業フォルダごとの id（ブラウザ側の控えを作業フォルダごとに分けるため）
    pub id: String,
    pub git: bool,
    /// git の user.name / user.email が未設定のときに補う
    git_identity: bool,
}

/// .komenagare/log.jsonl の1行
#[derive(Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub rev: u64,
    pub time: u64,
    pub author: String,
    pub change: Change,
}

impl Workspace {
    /// 作業フォルダか（komenagare init で作ったか）
    pub fn is_workspace(dir: &Path) -> bool {
        dir.join(META_DIR).join("id").is_file()
    }

    /// 作業フォルダを作る（komenagare init）。git が使えれば git の管理下にして、最初のコミットをする
    pub fn init(dir: &Path, git_mode: GitMode) -> Result<Workspace> {
        if git_mode == GitMode::Require && !git_available() {
            bail!("git が見つかりません（--require-git が指定されています）");
        }
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
        let dir = dir.canonicalize()?;
        if Self::is_workspace(&dir) {
            bail!(
                "{} は既に作業フォルダです（komenagare で始められます）",
                dir.display()
            );
        }
        std::fs::create_dir_all(dir.join(META_DIR))?;
        let comments = dir.join(COMMENTS_FILE);
        if !comments.exists() {
            std::fs::write(&comments, "")?;
        }
        std::fs::write(dir.join(META_DIR).join("id"), crate::store::uuid_v7())?;

        // （まだ git の管理下にないこともあるので、--require-git でも止めずに開く）
        let mut ws = Self::open(
            &dir,
            if git_mode == GitMode::Off {
                GitMode::Off
            } else {
                GitMode::Auto
            },
        )?;
        if git_mode == GitMode::Off || !git_available() {
            return Ok(ws);
        }
        if !ws.git {
            ws.git = true;
            ws.git_identity = needs_identity(&ws.dir);
            ws.run_git(&["init", "-q"])?;
        }
        // 作業用の記録は履歴に入れない
        let ignore = ws.dir.join(".gitignore");
        let cur = std::fs::read_to_string(&ignore).unwrap_or_default();
        if !cur
            .lines()
            .any(|l| l.trim() == "/.komenagare/" || l.trim() == ".komenagare/")
        {
            std::fs::write(
                &ignore,
                format!(
                    "{cur}{}/.komenagare/\n",
                    if cur.is_empty() || cur.ends_with('\n') {
                        ""
                    } else {
                        "\n"
                    }
                ),
            )?;
        }
        ws.run_git(&["add", "--", COMMENTS_FILE, ".gitignore"])?;
        ws.commit(
            "komenagare: 作業フォルダを作成",
            "komenagare",
            "komenagare@localhost",
            &[],
        )?;
        Ok(ws)
    }

    /// 作業フォルダを開く（komenagare）。作業フォルダでなければ何も作らずに止める
    pub fn open(dir: &Path, git_mode: GitMode) -> Result<Workspace> {
        if !Self::is_workspace(dir) {
            let shown = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
            let arg = if dir == Path::new(".") {
                String::new()
            } else {
                format!(" {}", dir.display())
            };
            bail!(
                "{} はコメナガレの作業フォルダではありません。\n\
                 作業フォルダを作るには: komenagare init{arg}",
                shown.display()
            );
        }
        let dir = dir.canonicalize()?;
        let id = std::fs::read_to_string(dir.join(META_DIR).join("id"))?
            .trim()
            .to_string();
        let comments = dir.join(COMMENTS_FILE);
        if !comments.exists() {
            std::fs::write(&comments, "")?;
        }
        let mut ws = Workspace {
            dir,
            id,
            git: false,
            git_identity: false,
        };
        if git_mode == GitMode::Off {
            return Ok(ws);
        }
        if !git_available() {
            if git_mode == GitMode::Require {
                bail!("git が見つかりません（--require-git が指定されています）");
            }
            eprintln!("警告: git が見つからないため、変更の履歴は残りません（comments.jsonl への書き込みだけ行います）");
            eprintln!("      履歴を残すには git をインストールしてください: https://git-scm.com/downloads");
            return Ok(ws);
        }
        // git の管理下でなければ（init --no-git で作ったときなど）履歴は残さない
        if git_out(&ws.dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
            if git_mode == GitMode::Require {
                bail!(
                    "{} は git の管理下にありません（--require-git が指定されています）",
                    ws.dir.display()
                );
            }
            return Ok(ws);
        }
        ws.git = true;
        ws.git_identity = needs_identity(&ws.dir);
        Ok(ws)
    }

    pub fn load_comments(&self) -> Result<Vec<Comment>> {
        let text = std::fs::read_to_string(self.dir.join(COMMENTS_FILE))?;
        let mut out = vec![];
        for (i, line) in text.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            out.push(
                serde_json::from_str(line)
                    .with_context(|| format!("{} の {} 行目を読めません", COMMENTS_FILE, i + 1))?,
            );
        }
        Ok(out)
    }

    /// これまでに適用した変更セットの id、最後の通し番号、最近の記録（古い順に最大 keep 件）
    pub fn load_log(&self, keep: usize) -> Result<(HashSet<String>, u64, VecDeque<LogEntry>)> {
        let (mut ids, mut rev, mut recent) = (HashSet::new(), 0, VecDeque::new());
        if let Ok(text) = std::fs::read_to_string(self.dir.join(META_DIR).join(LOG_FILE)) {
            for line in text.lines() {
                if let Ok(e) = serde_json::from_str::<LogEntry>(line) {
                    ids.insert(e.change.id.clone());
                    rev = rev.max(e.rev);
                    recent.push_back(e);
                    if recent.len() > keep {
                        recent.pop_front();
                    }
                }
            }
        }
        Ok((ids, rev, recent))
    }

    pub fn append_log(&self, e: &LogEntry) -> Result<()> {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join(META_DIR).join(LOG_FILE))?;
        writeln!(f, "{}", serde_json::to_string(e)?)?;
        Ok(())
    }

    /// comments.jsonl を書き換え（途中で止まっても壊れないよう、別名に書いてから置き換える）、git にコミットする
    pub fn save(
        &self,
        store: &Store,
        message: &str,
        author: &str,
        email: &str,
        trailers: &[(&str, &str)],
    ) -> Result<()> {
        let mut body = String::new();
        for c in store.sorted() {
            body.push_str(&serde_json::to_string(c)?);
            body.push('\n');
        }
        let tmp = self.dir.join(META_DIR).join("comments.jsonl.tmp");
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, self.dir.join(COMMENTS_FILE))?;
        if self.git {
            self.run_git(&["add", "--", COMMENTS_FILE])?;
            self.commit(message, author, email, trailers)?;
        }
        Ok(())
    }

    fn commit(
        &self,
        message: &str,
        author: &str,
        email: &str,
        trailers: &[(&str, &str)],
    ) -> Result<()> {
        let mut msg = message.to_string();
        if !trailers.is_empty() {
            msg.push_str("\n\n");
            for (k, v) in trailers {
                msg.push_str(&format!("{k}: {v}\n"));
            }
        }
        let author = format!("{} <{}>", clean(author), clean(email));
        self.run_git(&[
            "commit",
            "-q",
            "--no-verify",
            "--allow-empty",
            "-m",
            &msg,
            "--author",
            &author,
        ])
    }

    fn run_git(&self, args: &[&str]) -> Result<()> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(&self.dir);
        if self.git_identity {
            cmd.args([
                "-c",
                "user.name=komenagare",
                "-c",
                "user.email=komenagare@localhost",
            ]);
        }
        let out = cmd.args(args).output().context("git を実行できません")?;
        if !out.status.success() {
            bail!(
                "git {} に失敗しました: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        Ok(())
    }
}

fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '<' | '>' | '\n' | '\r'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// git の user.email が未設定か（未設定ならコミットのときに補う）
fn needs_identity(dir: &Path) -> bool {
    git_out(dir, &["config", "user.email"])
        .map(|s| s.trim().is_empty())
        .unwrap_or(true)
}

pub fn git_available() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn git_out(dir: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git").arg("-C").arg(dir).args(args).output()?;
    if !out.status.success() {
        bail!("git {} failed", args.join(" "));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Fields, Op};

    #[test]
    fn open_needs_init() {
        let tmp = tempfile::tempdir().unwrap();
        // 作業フォルダでなければ何も作らない
        let err = Workspace::open(tmp.path(), GitMode::Off).err().unwrap();
        assert!(err.to_string().contains("komenagare init"), "{err}");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
        // git なしで作ると、開いても git は使わない
        Workspace::init(tmp.path(), GitMode::Off).unwrap();
        assert!(!tmp.path().join(".git").exists());
        let ws = Workspace::open(tmp.path(), GitMode::Auto).unwrap();
        assert!(!ws.git);
        if git_available() {
            assert!(Workspace::open(tmp.path(), GitMode::Require).is_err());
        }
    }

    #[test]
    fn writes_jsonl_and_commits() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        assert!(Workspace::open(tmp.path(), GitMode::Require).is_err());
        let ws = Workspace::init(tmp.path(), GitMode::Require).unwrap();
        assert!(Workspace::init(tmp.path(), GitMode::Require).is_err());
        let mut store = Store::new(ws.load_comments().unwrap());
        let change = Change {
            id: "ch1".into(),
            ops: vec![
                Op::Add {
                    id: "b".into(),
                    after: Fields {
                        t: Some(2.0),
                        cmd: Some("".into()),
                        text: Some("後".into()),
                    },
                },
                Op::Add {
                    id: "a".into(),
                    after: Fields {
                        t: Some(1.0),
                        cmd: Some("ue".into()),
                        text: Some("先".into()),
                    },
                },
            ],
        };
        store.apply(&change, false);
        ws.save(
            &store,
            "たろう: 追加 2",
            "たろう",
            "c1@komenagare",
            &[("Change-Id", "ch1")],
        )
        .unwrap();
        let text = std::fs::read_to_string(tmp.path().join(COMMENTS_FILE)).unwrap();
        assert_eq!(text, "{\"id\":\"a\",\"t\":1.0,\"cmd\":\"ue\",\"text\":\"先\"}\n{\"id\":\"b\",\"t\":2.0,\"cmd\":\"\",\"text\":\"後\"}\n");
        let log = git_out(
            tmp.path(),
            &["log", "--format=%an|%s|%(trailers:key=Change-Id,valueonly)"],
        )
        .unwrap();
        assert!(log.starts_with("たろう|たろう: 追加 2|ch1"), "{log}");
        assert_eq!(
            Workspace::open(tmp.path(), GitMode::Require)
                .unwrap()
                .load_comments()
                .unwrap()
                .len(),
            2
        );
    }
}
