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
use std::collections::{HashMap, HashSet};
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
    /// 履歴にだけ残っている（外した）プロジェクト。先頭のコミットが変わるまで覚えておく
    history_cache: std::sync::Mutex<Option<(String, Vec<String>)>>,
}

impl Collection {
    /// まとめフォルダか（komenagare.json がある）
    pub fn is_collection(dir: &Path) -> bool {
        std::fs::symlink_metadata(dir.join(LIST_FILE)).is_ok_and(|m| m.is_file())
    }

    /// まとめフォルダを作る（komenagare init --collection）。git の管理下でなければリポジトリを作る。
    /// 直下のプロジェクトが自分の .git を持っていれば、absorb のときだけその履歴を取り込む（でなければ断る）
    pub fn create(dir: &Path, git_mode: GitMode, absorb: bool) -> Result<Collection> {
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
            history_cache: std::sync::Mutex::new(None),
        };
        let use_git = git_mode != GitMode::Off && workspace::git_available();
        let nested = own_git_projects(&c.dir);
        if use_git && !nested.is_empty() && !absorb {
            bail!(
                "{} は自分の git リポジトリ（.git）を持っています。まとめフォルダの履歴に取り込むなら、確かめてから進めてください",
                nested.join("・")
            );
        }
        if use_git && !workspace::in_git(&c.dir) {
            workspace::git_init(&c.dir)?;
        }
        if use_git {
            for name in &nested {
                c.absorb(name)?;
            }
        }
        // すでにあるプロジェクト（直下の作業フォルダ）は一覧に載せる
        let mut entries = vec![];
        let mut files = vec![];
        for name in c.child_dirs() {
            let d = c.dir.join(&name);
            if Workspace::is_workspace(&d) {
                let ws = Workspace::open(&d, GitMode::Off)?;
                files.extend(project_files(&c.dir, &name));
                entries.push(Entry {
                    dir: name,
                    id: ws.id,
                });
            }
        }
        c.ensure_ignore()?;
        files.push(".gitignore".to_string());
        c.save(
            &entries,
            "komenagare: まとめフォルダを作成",
            "komenagare",
            &files,
        )?;
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
            history_cache: std::sync::Mutex::new(None),
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
        if has_own_git(&d) {
            bail!("「{name}」は自分の git リポジトリ（.git）を持っています。komenagare init {name} で、確かめてから取り込めます");
        }
        // 外したとき git に入れないようにしていたので、また入れるようにする
        self.set_ignored(name, false)?;
        let ws = if Workspace::is_workspace(&d) {
            Workspace::open(&d, self.git_mode)?
        } else if let Some(id) = self.restore_from_history(name)? {
            // 手元に無い（別の場所で複製した）ときは、外す前のコミットから取り出す。id も外す前のもの
            Workspace::adopt(&d, self.git_mode, &id)?
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
        // コピーして入れたフォルダ・戻したフォルダなら、そのコメントもここでコミットする
        let mut files = project_files(&self.dir, name);
        files.push(".gitignore".to_string());
        self.save(
            &entries,
            &format!("komenagare: プロジェクト「{name}」を追加"),
            author,
            &files,
        )?;
        Ok(ws)
    }

    /// 一覧から外し、リポジトリからも外す（git rm --cached。手元のフォルダとコメントは残し、.gitignore で
    /// git に入れないようにする。それまでの履歴には残るので、別の場所からでも戻せる）
    pub fn remove(&self, id: &str, author: &str) -> Result<String> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut entries = self.entries()?;
        let Some(i) = entries.iter().position(|e| e.id == id) else {
            bail!("そのプロジェクトはまとめフォルダの一覧にありません");
        };
        let e = entries.remove(i);
        self.write_list(&entries)?;
        self.set_ignored(&e.dir, true)?;
        if self.git_mode != GitMode::Off {
            workspace::commit_removal(
                &self.dir,
                &e.dir,
                &[LIST_FILE, ".gitignore"],
                &format!("komenagare: プロジェクト「{}」を外す", e.dir),
                author,
                "komenagare@localhost",
            )?;
        }
        Ok(e.dir)
    }

    /// 名前のフォルダを git に入れない（.gitignore の /名前/）・入れる
    fn set_ignored(&self, name: &str, ignored: bool) -> Result<()> {
        let path = self.dir.join(".gitignore");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            bail!("{} がファイルではありません", path.display());
        }
        let cur = std::fs::read_to_string(&path).unwrap_or_default();
        // 名前の [ は .gitignore では模様（[ab] は a か b）になるので、\[ と書く（そのまま書くと、
        // ほかのフォルダまで git に入らなくなる）。前の版がそのまま書いた行も、同じものとして扱う
        let line = format!("/{}/", name.replace('[', "\\["));
        let old_line = format!("/{name}/");
        let is_line = |l: &str| l.trim() == line || l.trim() == old_line;
        let has = cur.lines().any(|l| l.trim() == line);
        let has_any = cur.lines().any(is_line);
        if (ignored && has) || (!ignored && !has_any) {
            return Ok(());
        }
        let next = if ignored {
            // 前の版の行があれば、正しい書き方に置き換える
            let kept: String = cur
                .lines()
                .filter(|l| !is_line(l))
                .map(|l| format!("{l}\n"))
                .collect();
            format!("{kept}{line}\n")
        } else {
            cur.lines()
                .filter(|l| !is_line(l))
                .map(|l| format!("{l}\n"))
                .collect()
        };
        std::fs::write(&path, next)?;
        Ok(())
    }

    /// 外す前のコミットから、プロジェクトのファイルを取り出す。取り出せたら外す前の id を返す
    fn restore_from_history(&self, name: &str) -> Result<Option<String>> {
        if self.git_mode == GitMode::Off || !workspace::in_git(&self.dir) {
            return Ok(None);
        }
        let g = |args: &[&str]| workspace::git_with(&self.dir, false, args, &[], None);
        let file = format!("{name}/{}", workspace::COMMENTS_FILE);
        let Ok(gone) = g(&["log", "-1", "--format=%H", "--diff-filter=D", "--", &file]) else {
            return Ok(None);
        };
        let gone = gone.trim();
        if gone.is_empty() {
            return Ok(None);
        }
        let before = format!("{gone}^");
        g(&["checkout", &before, "--", name])?;
        // 外す前の一覧から id を探す（無ければ新しく作る）
        let rel = g(&["rev-parse", "--show-prefix"])?.trim().to_string();
        let id = g(&["show", &format!("{before}:{rel}{LIST_FILE}")])
            .ok()
            .and_then(|t| serde_json::from_str::<List>(&t).ok())
            .and_then(|l| l.projects.into_iter().find(|e| e.dir == name))
            .map(|e| e.id.to_lowercase())
            .filter(|id| crate::is_uuid(id))
            .unwrap_or_else(crate::store::uuid_v7);
        Ok(Some(id))
    }

    /// 一覧に無いプロジェクト（外したもの・コピーして入れたもの。手元に無くても、履歴に残っているもの）
    pub fn hidden(&self) -> Vec<String> {
        let listed: Vec<String> = self
            .entries()
            .unwrap_or_default()
            .into_iter()
            .map(|e| e.dir)
            .collect();
        let mut out: Vec<String> = self
            .child_dirs()
            .into_iter()
            .filter(|n| !listed.contains(n))
            .filter(|n| {
                let d = self.dir.join(n);
                Workspace::is_workspace(&d) || d.join(workspace::COMMENTS_FILE).is_file()
            })
            .collect();
        for n in self.removed_in_history() {
            if !listed.contains(&n) && !out.contains(&n) {
                out.push(n);
            }
        }
        out.sort();
        out
    }

    /// 履歴の中で外されたプロジェクト（comments.jsonl が消えたフォルダ）。先頭のコミットごとに覚えておく
    fn removed_in_history(&self) -> Vec<String> {
        if self.git_mode == GitMode::Off || !workspace::git_available() {
            return vec![];
        }
        let g = |args: &[&str]| workspace::git_with(&self.dir, false, args, &[], None);
        let Ok(head) = g(&["rev-parse", "--verify", "-q", "HEAD"]) else {
            return vec![];
        };
        let head = head.trim().to_string();
        let mut cache = self.history_cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((h, v)) = &*cache {
            if *h == head {
                return v.clone();
            }
        }
        let pattern = format!("*/{}", workspace::COMMENTS_FILE);
        // ここだけは * を模様として読ませる（ほかは書いたとおりのパスとして渡している）
        let out = workspace::git_with(
            &self.dir,
            false,
            &[
                // 日本語などの名前を "\346…" の形にして出させない（その形だと名前として読めず、一覧に出ない）
                "-c",
                "core.quotePath=false",
                "log",
                "--relative",
                "--diff-filter=D",
                "--name-only",
                "--format=",
                "--",
                &pattern,
            ],
            &[("GIT_LITERAL_PATHSPECS", "0")],
            None,
        )
        .unwrap_or_default();
        let mut names: Vec<String> = vec![];
        for line in out.lines() {
            let mut parts = line.split('/');
            if let (Some(n), Some(f), None) = (parts.next(), parts.next(), parts.next()) {
                if f == workspace::COMMENTS_FILE
                    && name_ok(n)
                    && !names.iter().any(|x| x == n)
                    && !self.dir.join(n).exists()
                {
                    names.push(n.to_string());
                }
            }
        }
        *cache = Some((head, names.clone()));
        names
    }

    /// 直下のフォルダ（名前に使えるもの・リンクでないもの）
    fn child_dirs(&self) -> Vec<String> {
        child_dirs_of(&self.dir)
    }

    /// extra（まとめフォルダからの相対）も一緒にコミットする
    fn save(&self, entries: &[Entry], message: &str, author: &str, extra: &[String]) -> Result<()> {
        self.write_list(entries)?;
        if self.git_mode != GitMode::Off {
            let mut files: Vec<&str> = vec![LIST_FILE];
            files.extend(
                extra
                    .iter()
                    .filter(|f| self.dir.join(f).is_file())
                    .map(String::as_str),
            );
            workspace::commit_files(&self.dir, &files, message, author, "komenagare@localhost")?;
        }
        Ok(())
    }

    fn write_list(&self, entries: &[Entry]) -> Result<()> {
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
        Ok(())
    }

    /// 作業用の記録（.komenagare/。取り込み・分けるときの控えを置く）を git に入れないようにする
    fn ensure_ignore(&self) -> Result<()> {
        let path = self.dir.join(".gitignore");
        if std::fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file()) {
            bail!("{} がファイルではありません", path.display());
        }
        let cur = std::fs::read_to_string(&path).unwrap_or_default();
        if cur
            .lines()
            .any(|l| l.trim() == "/.komenagare/" || l.trim() == ".komenagare/")
        {
            return Ok(());
        }
        let sep = if cur.is_empty() || cur.ends_with('\n') {
            ""
        } else {
            "\n"
        };
        std::fs::write(&path, format!("{cur}{sep}/.komenagare/\n"))?;
        Ok(())
    }

    /// 取り込み・分けるときの控えの置き場所（.komenagare/git-backup/name。同じ名前があれば番号を付ける）
    fn backup_path(&self, name: &str) -> Result<PathBuf> {
        self.ensure_ignore()?;
        let meta = self.dir.join(".komenagare");
        if std::fs::symlink_metadata(&meta).is_ok_and(|m| !m.is_dir()) {
            bail!("{} がフォルダではありません", meta.display());
        }
        let dir = meta.join("git-backup");
        std::fs::create_dir_all(&dir)?;
        let mut path = dir.join(name);
        let mut n = 2;
        while std::fs::symlink_metadata(&path).is_ok() {
            path = dir.join(format!("{name}-{n}"));
            n += 1;
        }
        Ok(path)
    }

    /// まとめフォルダのリポジトリの一番上
    fn top(&self) -> Result<PathBuf> {
        let t = workspace::git_with(
            &self.dir,
            false,
            &["rev-parse", "--show-toplevel"],
            &[],
            None,
        )?;
        Ok(PathBuf::from(t.trim()).canonicalize()?)
    }

    /// プロジェクトの自分の .git の履歴を、まとめフォルダのリポジトリに取り込む（元の .git は
    /// .komenagare/git-backup/ に控える）。プロジェクトのファイルはそのまま
    pub fn absorb(&self, name: &str) -> Result<()> {
        let d = self.dir.join(name);
        let git = d.join(".git");
        if !std::fs::symlink_metadata(&git).is_ok_and(|m| m.is_dir()) {
            bail!(
                "{} がフォルダではありません（サブモジュールや worktree は取り込めません）",
                git.display()
            );
        }
        let g = |args: &[&str]| workspace::git_with(&self.dir, false, args, &[], None);
        if g(&["diff", "--cached", "--quiet"]).is_err() {
            bail!("まとめフォルダのリポジトリに、git add してコミットしていない変更があります。先にコミットしてください");
        }
        let top = self.top()?;
        let prefix = d
            .strip_prefix(&top)
            .ok()
            .and_then(|r| r.to_str())
            .map(|r| format!("{}/", r.replace('\\', "/")))
            .context("プロジェクトの場所が分かりません")?;
        let has_history = workspace::git_with(
            &d,
            false,
            &["rev-parse", "--verify", "-q", "HEAD"],
            &[],
            None,
        )
        .is_ok();
        let backup = self.backup_path(&format!("{name}.git"))?;
        std::fs::rename(&git, &backup)?;
        if !has_history {
            return Ok(());
        }
        let identity = workspace::git_needs_identity(&self.dir);
        let gi = |args: &[&str]| workspace::git_with(&self.dir, identity, args, &[], None);
        let r = (|| -> Result<()> {
            if g(&["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
                gi(&[
                    "commit",
                    "-q",
                    "--no-verify",
                    "--allow-empty",
                    "-m",
                    "komenagare: まとめフォルダを用意",
                ])?;
            }
            let src = git_path(&backup)?;
            g(&["fetch", "-q", &src, "HEAD"])?;
            let theirs = g(&["rev-parse", "FETCH_HEAD"])?.trim().to_string();
            // name/ に元の中身を入れ、元の履歴を2つ目の親にしたマージを作る（git merge -s ours と同じ形。
            // 元の履歴が既に祖先にある（同じ時刻に作った中身の同じプロジェクト）ときも、親として残す）
            g(&["read-tree", &format!("--prefix={prefix}"), &theirs])?;
            let tree = g(&["write-tree"])?.trim().to_string();
            let msg = format!("komenagare: {name} の履歴を取り込む");
            let new = gi(&[
                "commit-tree",
                &tree,
                "-p",
                "HEAD",
                "-p",
                &theirs,
                "-m",
                &msg,
            ])?
            .trim()
            .to_string();
            g(&["update-ref", "-m", &msg, "HEAD", &new])?;
            Ok(())
        })();
        if let Err(e) = r {
            // 元に戻す（index を今の先頭に戻し、.git を戻す）
            let _ = g(&["reset", "-q"]);
            let _ = std::fs::rename(&backup, &git);
            return Err(e);
        }
        Ok(())
    }

    /// 分けるプロジェクト（一覧にあるもの。外したものは git に入っていないので分けない）
    pub fn split_targets(&self) -> Result<Vec<String>> {
        Ok(self
            .entries()?
            .into_iter()
            .map(|e| e.dir)
            .filter(|d| plain_dir(&self.dir.join(d)))
            .collect())
    }

    /// まとめフォルダを解除して、プロジェクトごとの git リポジトリに分ける。それぞれの履歴は、まとめフォルダの
    /// 履歴からそのフォルダの分だけを切り出す（取り込む前の元の履歴も含む）。今のリポジトリ（.git）と
    /// komenagare.json は .komenagare/git-backup/ に控える。返り値は（名前, 切り出したコミットの数）
    pub fn split(&self) -> Result<Vec<(String, usize)>> {
        if !workspace::git_available() || !workspace::in_git(&self.dir) {
            bail!("まとめフォルダが git のリポジトリではありません（分ける履歴がありません）");
        }
        let top = self.top()?;
        if top != self.dir {
            bail!(
                "まとめフォルダが {} のリポジトリの中にあるので分けられません（まとめフォルダがリポジトリの一番上のときだけ分けられます）",
                top.display()
            );
        }
        let targets = self.split_targets()?;
        if targets.is_empty() {
            bail!("分けるプロジェクトがありません");
        }
        for t in &targets {
            if has_own_git(&self.dir.join(t)) {
                bail!("「{t}」は既に自分の .git を持っています");
            }
        }
        let g = |args: &[&str]| workspace::git_with(&self.dir, false, args, &[], None);
        if g(&["diff", "--cached", "--quiet"]).is_err() {
            bail!("まとめフォルダのリポジトリに、git add してコミットしていない変更があります。先にコミットしてください");
        }
        // 分ける前に、コミットしていないコメントをコミットする
        let mut files: Vec<String> = vec![LIST_FILE.to_string(), ".gitignore".to_string()];
        for t in &targets {
            files.extend(project_files(&self.dir, t));
        }
        let files: Vec<&str> = files
            .iter()
            .filter(|f| self.dir.join(f).is_file())
            .map(String::as_str)
            .collect();
        workspace::commit_files(
            &self.dir,
            &files,
            "komenagare: 分ける前の変更を保存",
            "komenagare",
            "komenagare@localhost",
        )?;
        let head = g(&["rev-parse", "--verify", "-q", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string());
        let branch = g(&["symbolic-ref", "--short", "-q", "HEAD"])
            .map(|s| s.trim().to_string())
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "main".to_string());
        // 切り出す（まだ何も変えない）
        let heads: Vec<(String, Option<String>, usize)> = match &head {
            Some(h) => {
                let hist = History::read(&self.dir)?;
                let mut out = vec![];
                for t in &targets {
                    let (new, _) = hist.split(&self.dir, t, h)?;
                    // 切り出した履歴のコミットの数（元のまま使ったものも数える）
                    let n = match &new {
                        Some(n) => g(&["rev-list", "--count", n])?.trim().parse().unwrap_or(0),
                        None => 0,
                    };
                    out.push((t.clone(), new, n));
                }
                out
            }
            None => targets.iter().map(|t| (t.clone(), None, 0)).collect(),
        };
        // プロジェクトごとにリポジトリを作る（失敗したら作ったものを消して、元のままにする）
        let mut created: Vec<PathBuf> = vec![];
        let mut refs: Vec<String> = vec![];
        let src = git_path(&self.dir.join(".git"))?;
        let r = (|| -> Result<()> {
            for (i, (t, new, _)) in heads.iter().enumerate() {
                let d = self.dir.join(t);
                let pg = |args: &[&str]| workspace::git_with(&d, false, args, &[], None);
                pg(&["init", "-q"])?;
                created.push(d.join(".git"));
                pg(&["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
                match new {
                    Some(new) => {
                        let r = format!("refs/komenagare-split/{i}");
                        g(&["update-ref", &r, new])?;
                        refs.push(r.clone());
                        pg(&["fetch", "-q", &src, &r])?;
                        pg(&["update-ref", &format!("refs/heads/{branch}"), new])?;
                        pg(&["reset", "-q"])?;
                        // 切り出した最後の中身が、今のフォルダの中身と同じか
                        let want = g(&["rev-parse", &format!("HEAD:{t}")])?;
                        let got = pg(&["rev-parse", "HEAD^{tree}"])?;
                        if want.trim() != got.trim() {
                            bail!("「{t}」の履歴をうまく切り出せませんでした");
                        }
                    }
                    None => {
                        let files = project_files(&self.dir, t);
                        let files: Vec<String> = files
                            .iter()
                            .filter_map(|f| f.strip_prefix(&format!("{t}/")).map(str::to_string))
                            .filter(|f| d.join(f).is_file())
                            .collect();
                        let files: Vec<&str> = files.iter().map(String::as_str).collect();
                        workspace::commit_files(
                            &d,
                            &files,
                            "komenagare: 作業フォルダを作成",
                            "komenagare",
                            "komenagare@localhost",
                        )?;
                    }
                }
            }
            Ok(())
        })();
        for r in &refs {
            let _ = g(&["update-ref", "-d", r]);
        }
        if let Err(e) = r {
            for c in &created {
                let _ = std::fs::remove_dir_all(c);
            }
            return Err(e);
        }
        // まとめフォルダを解除する（リポジトリと一覧は控えに移す）
        let backup = self.backup_path("collection.git")?;
        std::fs::rename(self.dir.join(".git"), &backup)?;
        let list = self.backup_path(LIST_FILE)?;
        std::fs::rename(self.dir.join(LIST_FILE), list)?;
        Ok(heads.into_iter().map(|(t, _, n)| (t, n)).collect())
    }
}

/// まとめフォルダの履歴（分けるときに読む）
struct History {
    commits: Vec<Commit>,
    index: HashMap<String, usize>,
}

struct Commit {
    id: String,
    parents: Vec<String>,
    tree: String,
    /// 作者・コミットした人（名前・メール・日時）と説明
    env: [String; 6],
    message: String,
}

impl History {
    fn read(dir: &Path) -> Result<History> {
        let out = workspace::git_with(
            dir,
            false,
            &[
                "log",
                "--topo-order",
                "--reverse",
                "--date=raw",
                "--format=%H%x1f%P%x1f%T%x1f%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd%x1f%B%x1e",
                "HEAD",
            ],
            &[],
            None,
        )?;
        let mut commits = vec![];
        for rec in out.split('\u{1e}') {
            let rec = rec.trim_start_matches('\n');
            if rec.is_empty() {
                continue;
            }
            let f: Vec<&str> = rec.splitn(10, '\u{1f}').collect();
            if f.len() != 10 {
                bail!("git の履歴を読めません");
            }
            commits.push(Commit {
                id: f[0].to_string(),
                parents: f[1].split_whitespace().map(str::to_string).collect(),
                tree: f[2].to_string(),
                env: [f[3], f[4], f[5], f[6], f[7], f[8]].map(str::to_string),
                message: f[9].to_string(),
            });
        }
        let index = commits
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.clone(), i))
            .collect();
        Ok(History { commits, index })
    }

    /// プロジェクト name の分だけの履歴を作る（git subtree split と同じ考え方）。返り値は新しい先頭と、作ったコミットの数。
    /// 取り込む前の元の履歴（まとめフォルダの直下に入っていた形）は、取り込んだマージ（name/ の中身が、
    /// 片方の親の中身そのものになっている）から見つけて、その中身をそのまま使う
    fn split(&self, dir: &Path, name: &str, head: &str) -> Result<(Option<String>, usize)> {
        // それぞれのコミットでの name/ の中身（tree の id）
        let mut input = String::new();
        for c in &self.commits {
            input.push_str(&format!("{}:{name}\n", c.id));
        }
        let out = workspace::git_with(
            dir,
            false,
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            &[],
            Some(input.as_bytes()),
        )?;
        let sub: Vec<Option<String>> = out
            .lines()
            .map(|l| l.strip_suffix(" tree").map(str::to_string))
            .collect();
        if sub.len() != self.commits.len() {
            bail!("git の履歴を読めません");
        }
        // 取り込む前の元の履歴
        let mut root: HashSet<usize> = HashSet::new();
        let mut stack: Vec<usize> = vec![];
        for (i, c) in self.commits.iter().enumerate() {
            let Some(t) = &sub[i] else { continue };
            // name/ を初めて入れたマージだけ（ほかのプロジェクトを取り込んだマージは、中身がたまたま同じでも見ない）
            let introduces = c
                .parents
                .iter()
                .all(|p| self.index.get(p).is_none_or(|&j| sub[j].is_none()));
            if c.parents.len() < 2 || !introduces {
                continue;
            }
            for p in &c.parents {
                if let Some(&j) = self.index.get(p) {
                    if sub[j].is_none() && &self.commits[j].tree == t {
                        stack.push(j);
                    }
                }
            }
        }
        while let Some(j) = stack.pop() {
            if !root.insert(j) {
                continue;
            }
            for p in &self.commits[j].parents {
                if let Some(&k) = self.index.get(p) {
                    if sub[k].is_none() {
                        stack.push(k);
                    }
                }
            }
        }
        let mut map: Vec<Option<String>> = vec![None; self.commits.len()];
        let mut trees: HashMap<String, String> = HashMap::new();
        let mut made = 0;
        for (i, c) in self.commits.iter().enumerate() {
            let mut parents: Vec<String> = vec![];
            for p in &c.parents {
                if let Some(Some(n)) = self.index.get(p).map(|&j| &map[j]) {
                    if !parents.contains(n) {
                        parents.push(n.clone());
                    }
                }
            }
            // ほかの親の祖先になっている親は除く（同じ時刻に作った中身の同じプロジェクトは、最初のコミットが
            // 同じものになり、関係の無いマージからも同じ祖先が届くため）
            if parents.len() > 1 {
                let all = parents.clone();
                parents.retain(|p| {
                    !all.iter().any(|q| {
                        q != p
                            && workspace::git_with(
                                dir,
                                false,
                                &["merge-base", "--is-ancestor", p, q],
                                &[],
                                None,
                            )
                            .is_ok()
                    })
                });
            }
            let tree = sub[i]
                .clone()
                .or_else(|| root.contains(&i).then(|| c.tree.clone()));
            map[i] = match tree {
                None => parents.first().cloned(),
                Some(t) if parents.len() == 1 && trees.get(&parents[0]) == Some(&t) => {
                    Some(parents[0].clone())
                }
                // 中身も親も元のままなら、元のコミットをそのまま使う（取り込む前の履歴。id も署名も変わらない）
                Some(t) if t == c.tree && parents == c.parents => {
                    trees.insert(c.id.clone(), t);
                    Some(c.id.clone())
                }
                Some(t) => {
                    let mut args: Vec<String> = vec![
                        "-c".into(),
                        "commit.gpgsign=false".into(),
                        "commit-tree".into(),
                        t.clone(),
                    ];
                    for p in &parents {
                        args.push("-p".into());
                        args.push(p.clone());
                    }
                    args.push("-F".into());
                    args.push("-".into());
                    let args: Vec<&str> = args.iter().map(String::as_str).collect();
                    let date = |d: &str| format!("@{d}");
                    let (ad, cd) = (date(&c.env[2]), date(&c.env[5]));
                    let env = [
                        ("GIT_AUTHOR_NAME", c.env[0].as_str()),
                        ("GIT_AUTHOR_EMAIL", c.env[1].as_str()),
                        ("GIT_AUTHOR_DATE", ad.as_str()),
                        ("GIT_COMMITTER_NAME", c.env[3].as_str()),
                        ("GIT_COMMITTER_EMAIL", c.env[4].as_str()),
                        ("GIT_COMMITTER_DATE", cd.as_str()),
                    ];
                    let message = if c.message.trim().is_empty() {
                        "（説明なし）\n"
                    } else {
                        c.message.as_str()
                    };
                    let new =
                        workspace::git_with(dir, false, &args, &env, Some(message.as_bytes()))?
                            .trim()
                            .to_string();
                    trees.insert(new.clone(), t);
                    made += 1;
                    Some(new)
                }
            };
        }
        let last = self.index.get(head).and_then(|&i| map[i].clone());
        Ok((last, made))
    }
}

/// git に取り込み元として渡す場所。Windows の \\?\ で始まる形（canonicalize の結果）は、git が URL と取り違えるので外す
fn git_path(p: &Path) -> Result<String> {
    let s = p.to_str().context("場所の名前を読めません")?;
    Ok(if let Some(r) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{r}")
    } else {
        s.strip_prefix(r"\\?\").unwrap_or(s).to_string()
    })
}

/// 自分の .git を持つか（まとめフォルダの履歴に取り込む前のプロジェクト）
pub fn has_own_git(d: &Path) -> bool {
    std::fs::symlink_metadata(d.join(".git")).is_ok()
}

/// dir の直下の、自分の .git を持つプロジェクト（まとめフォルダにするときに取り込むもの）
pub fn own_git_projects(dir: &Path) -> Vec<String> {
    child_dirs_of(dir)
        .into_iter()
        .filter(|n| {
            let d = dir.join(n);
            Workspace::is_workspace(&d) && has_own_git(&d)
        })
        .collect()
}

/// プロジェクトのフォルダのうち git に入れるもの（まとめフォルダからの相対）
fn project_files(dir: &Path, name: &str) -> Vec<String> {
    [workspace::COMMENTS_FILE, ".gitignore"]
        .iter()
        .map(|f| format!("{name}/{f}"))
        .filter(|f| dir.join(f).is_file())
        .collect()
}

/// 直下のフォルダ（名前に使えるもの・リンクでないもの）
fn child_dirs_of(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(dir)
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
    fn git_paths_drop_verbatim_prefix() {
        assert_eq!(
            git_path(Path::new(r"\\?\D:\a\b.git")).unwrap(),
            r"D:\a\b.git"
        );
        assert_eq!(
            git_path(Path::new(r"\\?\UNC\srv\share\x")).unwrap(),
            r"\\srv\share\x"
        );
        assert_eq!(git_path(Path::new("/home/a/.git")).unwrap(), "/home/a/.git");
    }

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
        let c = Collection::create(&root, GitMode::Auto, false).unwrap();
        assert!(root.join(".git").exists());
        assert!(Collection::create(&root, GitMode::Auto, false).is_err());
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
        add_comment(&b, "bのコメント");
        // ほかに git add してあるものは、外すコミットに入れない
        std::fs::write(root.join("memo.txt"), "メモ").unwrap();
        git(&root, &["add", "memo.txt"]);
        assert_eq!(c.remove(&b.id, "はなこ").unwrap(), "b");
        assert!(root.join("b/comments.jsonl").exists());
        assert_eq!(c.hidden(), vec!["b".to_string()]);
        // リポジトリからは外れる（履歴には残る）
        assert_eq!(git(&root, &["ls-files", "b"]), "");
        assert!(git(&root, &["show", "--stat", "--format=%s", "HEAD"]).contains("b/comments.jsonl"));
        assert!(!git(&root, &["show", "--stat", "--format=", "HEAD"]).contains("memo.txt"));
        assert_eq!(git(&root, &["status", "--porcelain"]), "A  memo.txt\n");
        git(&root, &["reset", "-q", "memo.txt"]);
        std::fs::remove_file(root.join("memo.txt")).unwrap();
        // 外したまま複製した先では、手元に無くても履歴から同じ id で戻せる
        let cl = tmp.path().join("clone-removed");
        git(
            tmp.path(),
            &["clone", "-q", root.to_str().unwrap(), cl.to_str().unwrap()],
        );
        assert!(!cl.join("b").exists());
        let cc = Collection::open(&cl, GitMode::Auto).unwrap();
        assert_eq!(cc.open_projects().unwrap().len(), 1);
        assert_eq!(cc.hidden(), vec!["b".to_string()]);
        let rb = cc.add("b", "じろう").unwrap();
        assert_eq!(rb.id, b.id);
        assert!(rb
            .load_comments()
            .unwrap()
            .iter()
            .any(|x| x.text == "bのコメント"));
        assert_eq!(git(&cl, &["status", "--porcelain"]), "");
        assert!(cc.hidden().is_empty());
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

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn add_comment(ws: &Workspace, text: &str) {
        use crate::store::{Change, Fields, Op, Store};
        let mut store = Store::new(ws.load_comments().unwrap());
        let id = crate::store::uuid_v7();
        store.apply(
            &Change {
                id: crate::store::uuid_v7(),
                ops: vec![Op::Add {
                    id,
                    after: Fields {
                        t: Some(1.0),
                        cmd: Some(String::new()),
                        text: Some(text.into()),
                    },
                }],
            },
            false,
        );
        ws.save(
            &store,
            &format!("たろう: {text}"),
            "たろう",
            "t@komenagare",
            &[],
        )
        .unwrap();
    }

    /// プロジェクトごとの .git を取り込んでまとめフォルダにし、また分け、もう一度取り込む。
    /// コメント・id・それぞれの履歴が残る
    #[test]
    fn absorb_and_split() {
        if !workspace::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("komeme");
        let a = Workspace::init(&root.join("a"), GitMode::Require).unwrap();
        let b = Workspace::init(&root.join("b"), GitMode::Require).unwrap();
        // 中身が同じプロジェクト（コメントが無いもの）があっても、ほかのプロジェクトの履歴を混ぜない
        let e = Workspace::init(&root.join("e"), GitMode::Require).unwrap();
        add_comment(&a, "aの最初");
        add_comment(&b, "bの最初");
        let a_head = git(&root.join("a"), &["rev-parse", "HEAD"]);
        // コミットしていない変更も残す
        std::fs::OpenOptions::new()
            .append(true)
            .open(root.join("b/comments.jsonl"))
            .map(|mut f| {
                use std::io::Write;
                writeln!(
                    f,
                    "{{\"id\":\"{}\",\"t\":2.0,\"cmd\":\"\",\"text\":\"未コミット\"}}",
                    crate::store::uuid_v7()
                )
                .unwrap()
            })
            .unwrap();
        assert_eq!(own_git_projects(&root), vec!["a", "b", "e"]);
        // 確かめずには取り込まない
        assert!(Collection::create(&root, GitMode::Auto, false).is_err());
        assert!(!root.join(".git").exists() && root.join("a/.git").exists());

        let c = Collection::create(&root, GitMode::Auto, true).unwrap();
        assert!(
            !root.join("a/.git").exists() && root.join(".komenagare/git-backup/a.git").exists()
        );
        let ids: Vec<String> = c.entries().unwrap().into_iter().map(|e| e.id).collect();
        assert_eq!(ids, vec![a.id.clone(), b.id.clone(), e.id.clone()]);
        let log = git(&root, &["log", "--format=%s"]);
        assert!(
            log.contains("たろう: aの最初") && log.contains("たろう: bの最初"),
            "{log}"
        );
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
        assert!(git(&root, &["show", "HEAD:b/comments.jsonl"]).contains("未コミット"));
        // まとめフォルダになってからの変更
        let opened = c.open_projects().unwrap();
        add_comment(&opened[0], "aの2番目");
        let cc = c.add("c", "たろう").unwrap();
        add_comment(&cc, "cの最初");

        // 分ける
        let done = c.split().unwrap();
        assert_eq!(
            done.iter().map(|d| d.0.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "e", "c"]
        );
        assert!(!root.join(".git").exists() && !root.join(LIST_FILE).exists());
        assert!(root.join(".komenagare/git-backup/collection.git").exists());
        let la = git(&root.join("a"), &["log", "--format=%s"]);
        assert!(
            la.contains("aの最初") && la.contains("aの2番目") && !la.contains("bの最初"),
            "{la}"
        );
        assert!(git(&root.join("b"), &["log", "--format=%s"]).contains("bの最初"));
        // 取り込む前のコミットは、元と同じ id のまま
        assert!(git(&root.join("a"), &["rev-list", "HEAD"]).contains(a_head.trim()));
        let le = git(&root.join("e"), &["log", "--format=%s"]);
        assert_eq!(le.trim(), "komenagare: 作業フォルダを作成", "{le}");
        assert!(git(&root.join("c"), &["log", "--format=%s"]).contains("cの最初"));
        for p in ["a", "b", "c", "e"] {
            assert_eq!(git(&root.join(p), &["status", "--porcelain"]), "", "{p}");
        }
        assert!(git(&root.join("b"), &["show", "HEAD:comments.jsonl"]).contains("未コミット"));
        assert_eq!(
            Workspace::open(&root.join("a"), GitMode::Require)
                .unwrap()
                .id,
            a.id
        );
        // 作者と日時も引き継ぐ
        assert!(git(&root.join("a"), &["log", "--format=%an"]).contains("たろう"));

        // もう一度取り込める
        let c2 = Collection::create(&root, GitMode::Auto, true).unwrap();
        assert_eq!(c2.entries().unwrap().len(), 4);
        let log = git(&root, &["log", "--format=%s"]);
        assert!(log.contains("aの2番目") && log.contains("cの最初"), "{log}");
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_links() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("kome");
        let c = Collection::create(&root, GitMode::Off, false).unwrap();
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

    /// 名前に [ ] が入ったプロジェクトを外しても、ほかのプロジェクトを巻き込まない
    /// （git のパスの模様や .gitignore の模様として読ませない）
    #[test]
    fn brackets_in_names_are_not_patterns() {
        if !workspace::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("kome");
        let c = Collection::create(&root, GitMode::Auto, false).unwrap();
        let a = c.add("a", "たろう").unwrap();
        c.add("b", "たろう").unwrap();
        let x = c.add("[ab]", "たろう").unwrap();
        add_comment(&a, "aのコメント");
        assert_eq!(c.remove(&x.id, "たろう").unwrap(), "[ab]");
        assert!(git(&root, &["ls-files", "a"]).contains("a/comments.jsonl"));
        assert!(git(&root, &["ls-files", "b"]).contains("b/comments.jsonl"));
        assert_eq!(git(&root, &["--literal-pathspecs", "ls-files", "[ab]"]), "");
        let ignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(ignore.lines().any(|l| l == "/\\[ab]/"), "{ignore}");
        // 外したフォルダだけが git に入らなくなる（a・b に新しく置いたファイルは見える）
        for d in ["a", "b", "[ab]"] {
            std::fs::write(root.join(d).join("new.txt"), "x").unwrap();
        }
        let status = git(&root, &["status", "--porcelain", "-uall"]);
        assert!(status.contains("a/new.txt") && status.contains("b/new.txt"));
        assert!(!status.contains("[ab]"), "{status}");
        for d in ["a", "b", "[ab]"] {
            std::fs::remove_file(root.join(d).join("new.txt")).unwrap();
        }
        assert_eq!(c.hidden(), vec!["[ab]".to_string()]);
        // 戻すと同じ id で、.gitignore からも外れる（前の版がそのまま書いた行も外す）
        std::fs::write(root.join(".gitignore"), format!("{ignore}/[ab]/\n")).unwrap();
        assert_eq!(c.add("[ab]", "たろう").unwrap().id, x.id);
        let ignore = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(!ignore.contains("ab]"), "{ignore}");
        assert_eq!(git(&root, &["status", "--porcelain"]), "");
    }

    /// 日本語の名前のプロジェクトも、外したあと履歴から見つけて戻せる
    #[test]
    fn finds_removed_projects_with_japanese_names() {
        if !workspace::git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("kome");
        let c = Collection::create(&root, GitMode::Auto, false).unwrap();
        let p = c.add("第1話", "たろう").unwrap();
        c.remove(&p.id, "たろう").unwrap();
        let cl = tmp.path().join("clone");
        git(
            tmp.path(),
            &["clone", "-q", root.to_str().unwrap(), cl.to_str().unwrap()],
        );
        let cc = Collection::open(&cl, GitMode::Auto).unwrap();
        assert_eq!(cc.hidden(), vec!["第1話".to_string()]);
        assert_eq!(cc.add("第1話", "じろう").unwrap().id, p.id);
    }
}
