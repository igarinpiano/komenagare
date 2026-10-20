//! 作業フォルダ：コメント（comments.jsonl）、変更の記録（.komenagare/log.jsonl）、git の履歴。
//!
//! comments.jsonl は1行1コメント（時刻順）。git の差分やマージがコメント単位になる。
//! クライアントから変更が届くたびに書き込み、git が使えれば1回ずつコミットする。

use crate::store::{Change, Comment, Store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
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
#[derive(Serialize, Deserialize)]
pub struct LogEntry {
    pub rev: u64,
    pub time: u64,
    pub author: String,
    pub change: Change,
}

impl Workspace {
    pub fn open(dir: &Path, git_mode: GitMode) -> Result<Workspace> {
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
        let dir = dir.canonicalize()?;
        std::fs::create_dir_all(dir.join(META_DIR))?;
        let comments = dir.join(COMMENTS_FILE);
        if !comments.exists() {
            std::fs::write(&comments, "")?;
        }

        let id_file = dir.join(META_DIR).join("id");
        let id = match std::fs::read_to_string(&id_file) {
            Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => {
                let id = crate::store::uuid_v7();
                std::fs::write(&id_file, &id)?;
                id
            }
        };
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
        ws.git = true;
        ws.git_identity = git_out(&ws.dir, &["config", "user.email"])
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        if git_out(&ws.dir, &["rev-parse", "--is-inside-work-tree"]).is_err() {
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
        if git_out(&ws.dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
            ws.run_git(&["add", "--", COMMENTS_FILE, ".gitignore"])?;
            ws.commit(
                "komenagare: 作業フォルダを作成",
                "komenagare",
                "komenagare@localhost",
                &[],
            )?;
        }
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

    /// これまでに適用した変更セットの id と、最後の通し番号
    pub fn load_log(&self) -> Result<(HashSet<String>, u64)> {
        let (mut ids, mut rev) = (HashSet::new(), 0);
        if let Ok(text) = std::fs::read_to_string(self.dir.join(META_DIR).join(LOG_FILE)) {
            for line in text.lines() {
                if let Ok(e) = serde_json::from_str::<LogEntry>(line) {
                    ids.insert(e.change.id);
                    rev = rev.max(e.rev);
                }
            }
        }
        Ok((ids, rev))
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
    fn writes_jsonl_and_commits() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::open(tmp.path(), GitMode::Require).unwrap();
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
