// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! まとめフォルダ：いくつものプロジェクト（作業フォルダ）を1つのフォルダ（1つの git リポジトリ）で持つ。
//!
//!   まとめフォルダ/
//!     komenagare.json      プロジェクトの一覧（フォルダの名前と id）。git に入れる
//!     a/comments.jsonl     プロジェクト（作業フォルダ）
//!     b/comments.jsonl
//!
//! `komenagare <まとめフォルダ>` で一覧のプロジェクトを全部開く。作業用の記録（.komenagare/）は git に入れないので、
//! git で複製した直後は無いが、一覧の id で作り直して開く（どこで複製しても同じ id になり、共有のリンクが変わらない）。
//! 動いているホストの画面から、プロジェクトを作る・外す・外したものを戻すことができる（外してもフォルダは残す）。

use crate::workspace::{self, GitMode, Workspace};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const LIST_FILE: &str = "komenagare.json";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// まとめフォルダの直下のフォルダの名前
    pub dir: String,
    pub id: String,
}

#[derive(Serialize, Deserialize, Default)]
struct List {
    #[serde(default)]
    projects: Vec<Entry>,
}

pub struct Collection {
    pub dir: PathBuf,
    git_mode: GitMode,
    /// 一覧の読み書きを1つずつ行う（画面から同時に作る・外すことがあるので）
    lock: std::sync::Mutex<()>,
}

impl Collection {
    /// まとめフォルダか（komenagare.json がある）
    pub fn is_collection(dir: &Path) -> bool {
        std::fs::symlink_metadata(dir.join(LIST_FILE)).is_ok_and(|m| m.is_file())
    }

    /// まとめフォルダを作る（komenagare init --collection）。git の管理下でなければリポジトリを作る
    pub fn create(dir: &Path, git_mode: GitMode) -> Result<Collection> {
        if git_mode == GitMode::Require && !workspace::git_available() {
            bail!("git が見つかりません（--require-git が指定されています）");
        }
        std::fs::create_dir_all(dir).with_context(|| format!("{} を作れません", dir.display()))?;
        let dir = dir.canonicalize()?;
        if Self::is_collection(&dir) {
            bail!("{} は既にまとめフォルダです", dir.display());
        }
        if Workspace::is_workspace(&dir) {
            bail!(
                "{} はプロジェクト（作業フォルダ）です。まとめフォルダは別の場所に作ってください",
                dir.display()
            );
        }
        let c = Collection {
            dir,
            git_mode,
            lock: std::sync::Mutex::new(()),
        };
        if git_mode != GitMode::Off && workspace::git_available() && !workspace::in_git(&c.dir) {
            workspace::git_init(&c.dir)?;
        }
        // すでにあるプロジェクト（直下の作業フォルダ）は一覧に載せる
        let mut entries = vec![];
        for name in c.child_dirs() {
            let d = c.dir.join(&name);
            if Workspace::is_workspace(&d) {
                warn_nested_git(&d);
                let ws = Workspace::open(&d, GitMode::Off)?;
                entries.push(Entry {
                    dir: name,
                    id: ws.id,
                });
            }
        }
        c.save(&entries, "komenagare: まとめフォルダを作成", "komenagare")?;
        Ok(c)
    }

    pub fn open(dir: &Path, git_mode: GitMode) -> Result<Collection> {
        let dir = dir.canonicalize()?;
        if !Self::is_collection(&dir) {
            bail!("{} はまとめフォルダではありません", dir.display());
        }
        let c = Collection {
            dir,
            git_mode,
            lock: std::sync::Mutex::new(()),
        };
        c.entries()?;
        Ok(c)
    }

    /// 一覧（正しくないものは飛ばす）
    pub fn entries(&self) -> Result<Vec<Entry>> {
        let path = self.dir.join(LIST_FILE);
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("{} を読めません", path.display()))?;
        let list: List = serde_json::from_str(&text)
            .with_context(|| format!("{} の形が正しくありません", path.display()))?;
        let mut out: Vec<Entry> = vec![];
        for e in list.projects {
            if !name_ok(&e.dir) || !crate::is_uuid(&e.id) {
                eprintln!(
                    "警告: {LIST_FILE} の「{}」は正しくないので飛ばします",
                    e.dir
                );
                continue;
            }
            if out.iter().any(|o| o.dir == e.dir || o.id == e.id) {
                eprintln!(
                    "警告: {LIST_FILE} の「{}」は重なっているので飛ばします",
                    e.dir
                );
                continue;
            }
            out.push(Entry {
                dir: e.dir,
                id: e.id.to_lowercase(),
            });
        }
        Ok(out)
    }

    /// 一覧のプロジェクトを開く（作業用の記録が無ければ一覧の id で作る）。フォルダが無いものは警告して飛ばす
    pub fn open_projects(&self) -> Result<Vec<Workspace>> {
        let mut out = vec![];
        for e in self.entries()? {
            let d = self.dir.join(&e.dir);
            if !plain_dir(&d) {
                eprintln!(
                    "警告: {} が見つかりません（{LIST_FILE} には載っています）",
                    d.display()
                );
                continue;
            }
            out.push(Workspace::adopt(&d, self.git_mode, &e.id)?);
        }
        Ok(out)
    }

    /// プロジェクトを作って一覧に載せる。同じ名前のフォルダがあれば、それを載せる（外したものを戻すとき）
    pub fn add(&self, name: &str, author: &str) -> Result<Workspace> {
        let name = name.trim();
        if !name_ok(name) {
            bail!("「{name}」はプロジェクトの名前に使えません（/ \\ : * ? \" < > | や、先頭の「.」は使えません）");
        }
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries()?;
        if entries.iter().any(|e| e.dir == name) {
            bail!("「{name}」は既にあります");
        }
        let d = self.dir.join(name);
        if std::fs::symlink_metadata(&d).is_ok() && !plain_dir(&d) {
            bail!("「{name}」という名前のファイル（かリンク）があります");
        }
        warn_nested_git(&d);
        let ws = if Workspace::is_workspace(&d) {
            Workspace::open(&d, self.git_mode)?
        } else {
            Workspace::init(&d, self.git_mode)?
        };
        if entries.iter().any(|e| e.id == ws.id) {
            bail!("「{name}」はほかのプロジェクトを写したものです（id が同じ）");
        }
        entries.push(Entry {
            dir: name.to_string(),
            id: ws.id.clone(),
        });
        self.save(
            &entries,
            &format!("komenagare: プロジェクト「{name}」を追加"),
            author,
        )?;
        Ok(ws)
    }

    /// 一覧から外す（フォルダとコメントは残す）
    pub fn remove(&self, id: &str, author: &str) -> Result<String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries()?;
        let Some(i) = entries.iter().position(|e| e.id == id) else {
            bail!("そのプロジェクトはまとめフォルダの一覧にありません");
        };
        let e = entries.remove(i);
        self.save(
            &entries,
            &format!("komenagare: プロジェクト「{}」を外す", e.dir),
            author,
        )?;
        Ok(e.dir)
    }

    /// 一覧に無いプロジェクトのフォルダ（外したもの・コピーして入れたもの）
    pub fn hidden(&self) -> Vec<String> {
        let listed: Vec<String> = self
            .entries()
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.dir)
            .collect();
        self.child_dirs()
            .into_iter()
            .filter(|n| !listed.contains(n))
            .filter(|n| {
                let d = self.dir.join(n);
                Workspace::is_workspace(&d) || d.join(workspace::COMMENTS_FILE).is_file()
            })
            .collect()
    }

    /// 直下のフォルダ（名前に使えるもの・リンクでないもの）
    fn child_dirs(&self) -> Vec<String> {
        let mut out: Vec<String> = std::fs::read_dir(&self.dir)
            .map(|r| {
                r.flatten()
                    .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                    .filter_map(|e| e.file_name().into_string().ok())
                    .filter(|n| name_ok(n))
                    .collect()
            })
            .unwrap_or_default();
        out.sort();
        out
    }

    fn save(&self, entries: &[Entry], message: &str, author: &str) -> Result<()> {
        let list = List {
            projects: entries.to_vec(),
        };
        let mut text = serde_json::to_string_pretty(&list)?;
        text.push('\n');
        let path = self.dir.join(LIST_FILE);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            bail!("{} がファイルではありません", path.display());
        }
        let tmp = self.dir.join(format!(".{LIST_FILE}.tmp"));
        workspace::write_new(&tmp, text.as_bytes())?;
        std::fs::rename(&tmp, &path)?;
        if self.git_mode != GitMode::Off {
            workspace::commit_files(
                &self.dir,
                &[LIST_FILE],
                message,
                author,
                "komenagare@localhost",
            )?;
        }
        Ok(())
    }
}

/// プロジェクトのフォルダが自分の git リポジトリを持っていると、まとめフォルダの履歴に入らない
fn warn_nested_git(d: &Path) {
    if std::fs::symlink_metadata(d.join(".git")).is_ok() {
        eprintln!(
            "警告: {} は独自の git リポジトリです。まとめフォルダの履歴に入れるには {} を消してください（それまでの履歴はそちらに残ります）",
            d.display(),
            d.join(".git").display()
        );
    }
}

/// フォルダか（シンボリックリンクはたどらない。まとめフォルダの外のフォルダを開かないように）
fn plain_dir(d: &Path) -> bool {
    std::fs::symlink_metadata(d).is_ok_and(|m| m.is_dir())
}

/// プロジェクト（フォルダ）の名前に使えるか。直下の1つのフォルダだけを指すように、区切りや「.」で始まる名前を断る。
/// Windows で作れない名前（CON など、末尾の「.」や空白）も断る
pub fn name_ok(name: &str) -> bool {
    const RESERVED: [&str; 22] = [
        "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
        "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
    ];
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    !name.is_empty()
        && name.chars().count() <= 60
        && name.trim() == name
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        && !RESERVED.contains(&stem.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        for ok in ["a", "第1話", "my project", "ep.01"] {
            assert!(name_ok(ok), "{ok}");
        }
        for bad in [
            "", ".", "..", ".git", "a/b", "a\\b", "c:", "con", "NUL.txt", "a.", " a", "a ", "x\ny",
            "a|b",
        ] {
            assert!(!name_ok(bad), "{bad:?}");
        }
        assert!(!name_ok(&"あ".repeat(61)));
    }

    #[test]
    fn add_remove_and_clone() {
        if !workspace::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("kome");
        let c = Collection::create(&root, GitMode::Auto).unwrap();
        assert!(root.join(".git").exists());
        assert!(Collection::create(&root, GitMode::Auto).is_err());
        let a = c.add("a", "たろう").unwrap();
        let b = c.add("b", "たろう").unwrap();
        assert!(c.add("a", "たろう").is_err());
        assert!(c.add("../x", "たろう").is_err());
        assert_eq!(
            c.entries().unwrap(),
            vec![
                Entry {
                    dir: "a".into(),
                    id: a.id.clone()
                },
                Entry {
                    dir: "b".into(),
                    id: b.id.clone()
                },
            ]
        );
        // 外してもフォルダは残り、戻すと同じ id
        assert_eq!(c.remove(&b.id, "はなこ").unwrap(), "b");
        assert!(root.join("b/comments.jsonl").exists());
        assert_eq!(c.hidden(), vec!["b".to_string()]);
        let b2 = c.add("b", "はなこ").unwrap();
        assert_eq!(b2.id, b.id);
        assert!(c.hidden().is_empty());
        // 一覧はコミットしてある
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&status.stdout), "");

        // 複製した先では、作業用の記録が無くても一覧の id で開ける
        let clone = tmp.path().join("clone");
        let out = std::process::Command::new("git")
            .args(["clone", "-q"])
            .arg(&root)
            .arg(&clone)
            .output()
            .unwrap();
        assert!(out.status.success());
        assert!(!clone.join("a/.komenagare").exists());
        let c2 = Collection::open(&clone, GitMode::Auto).unwrap();
        let opened = c2.open_projects().unwrap();
        let ids: Vec<&str> = opened.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec![a.id.as_str(), b.id.as_str()]);
        assert!(opened.iter().all(|w| w.git));
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(&clone)
            .args(["status", "--porcelain"])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&status.stdout),
            "",
            "複製した先を汚さない"
        );
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("kome");
        let c = Collection::create(&root, GitMode::Off).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("x")).unwrap();
        assert!(c.add("x", "a").is_err());
        // 一覧に書き足されても、リンクの先は開かない
        std::fs::write(
            root.join(LIST_FILE),
            format!(
                "{{\"projects\":[{{\"dir\":\"x\",\"id\":\"{}\"}},{{\"dir\":\"../outside\",\"id\":\"{}\"}}]}}",
                crate::store::uuid_v7(),
                crate::store::uuid_v7()
            ),
        )
        .unwrap();
        assert!(c.open_projects().unwrap().is_empty());
        assert!(!outside.join(".komenagare").exists());
    }
}
