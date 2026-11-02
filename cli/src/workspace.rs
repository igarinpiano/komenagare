// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! 作業フォルダ：コメント（comments.jsonl）、変更の記録（.komenagare/log.jsonl）、git の履歴。
//!
//! comments.jsonl は1行1コメント（時刻順）。git の差分やマージがコメント単位になる。
//! クライアントから変更が届くと、まず log.jsonl に書き足してから受け取ったと返し、comments.jsonl の書き込みと
//! git のコミットは書き込み担当が順に行う（溜まっていればまとめて1回で）。どこまで書き込んだかは
//! .komenagare/saved に残し、起動したときにそれより新しい記録を当て直す（途中で止まっても変更を失わない）。

use crate::store::{Change, Comment, Store};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

pub const COMMENTS_FILE: &str = "comments.jsonl";
const META_DIR: &str = ".komenagare";
const LOG_FILE: &str = "log.jsonl";
/// comments.jsonl に書き込み終えた記録の通し番号（rev）
const SAVED_FILE: &str = "saved";
/// 「あとで」にした衝突（全員に見せる。解決するまで残す）
const CONFLICTS_FILE: &str = "conflicts.json";

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
        // シンボリックリンクもたどらずに「ある」とみなす（open で読むときに断る）
        std::fs::symlink_metadata(dir.join(META_DIR).join("id")).is_ok()
    }

    /// 作業フォルダを作る（komenagare init）。git が使えれば git の管理下にして、最初のコミットをする
    pub fn init(dir: &Path, git_mode: GitMode) -> Result<Workspace> {
        Self::init_inner(dir, git_mode, None)
    }

    /// まとめフォルダ（collection.rs）に載っているプロジェクトを開く。作業用の記録（.komenagare。git に入れない）が
    /// 無ければ（git で複製した直後など）、載っている id で作る。id が違っていれば載っている方に合わせる
    /// （複製したそれぞれの場所で同じ id になり、共有のリンクが変わらないように）
    pub fn adopt(dir: &Path, git_mode: GitMode, id: &str) -> Result<Workspace> {
        if !Self::is_workspace(dir) {
            return Self::init_inner(dir, git_mode, Some(id));
        }
        let ws = Self::open(dir, git_mode)?;
        if ws.id == id {
            return Ok(ws);
        }
        write_new(&meta_dir(&ws.dir)?.join("id"), id.as_bytes())?;
        Self::open(dir, git_mode)
    }

    fn init_inner(dir: &Path, git_mode: GitMode, id: Option<&str>) -> Result<Workspace> {
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
        // .komenagare がシンボリックリンクなら作業フォルダの外に書いてしまうので断る（meta_dir）
        let meta = meta_dir(&dir)?;
        let comments = dir.join(COMMENTS_FILE);
        if !comments.exists() {
            std::fs::write(&comments, "")?;
        }
        let id = id.map_or_else(crate::store::uuid_v7, str::to_string);
        write_new(&meta.join("id"), id.as_bytes())?;

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
        let _git = git_lock();
        ws.run_git(&["add", "--", COMMENTS_FILE, ".gitignore"])?;
        // git で複製したフォルダを init し直したとき（どちらのファイルも変わっていない）は、空のコミットを作らない
        let unchanged = git_out(&ws.dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
            && git_out(
                &ws.dir,
                &[
                    "diff",
                    "--cached",
                    "--quiet",
                    "--",
                    COMMENTS_FILE,
                    ".gitignore",
                ],
            )
            .is_ok();
        if !unchanged {
            ws.commit(
                &[COMMENTS_FILE, ".gitignore"],
                "komenagare: 作業フォルダを作成",
                "komenagare",
                "komenagare@localhost",
                &[],
            )?;
        }
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
            // git で複製したフォルダには、作業用の記録（.komenagare。git に入れない）が無い
            let cloned = dir.join(COMMENTS_FILE).is_file();
            bail!(
                "{} はコメナガレの作業フォルダではありません。\n\
                 作業フォルダを作るには: komenagare init{arg}{}",
                shown.display(),
                if cloned {
                    "\n（comments.jsonl はあるので、git で複製したフォルダなら init し直すとコメントはそのままで開けます）"
                } else {
                    ""
                }
            );
        }
        let dir = dir.canonicalize()?;
        let id = read_id(&dir)?;
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
        let path = self.dir.join(COMMENTS_FILE);
        if is_symlink(&path) {
            bail!(
                "{} がシンボリックリンクになっています（作業フォルダの外のファイルは読みません）",
                path.display()
            );
        }
        let text = std::fs::read_to_string(path)?;
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
        if let Some(text) = read_meta(&self.dir, LOG_FILE) {
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

    /// 保留中の衝突（読めなければ空）
    pub fn load_conflicts(&self) -> Vec<serde_json::Value> {
        read_meta(&self.dir, CONFLICTS_FILE)
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn conflicts_path(&self) -> PathBuf {
        self.dir.join(META_DIR).join(CONFLICTS_FILE)
    }

    pub fn append_log(&self, e: &LogEntry) -> Result<()> {
        append_log_in(&self.dir, e)
    }

    /// comments.jsonl に書き込み終えた記録の通し番号（無ければ None。古い版の作業フォルダ）
    pub fn saved_rev(&self) -> Option<u64> {
        read_meta(&self.dir, SAVED_FILE)?.trim().parse().ok()
    }

    pub fn set_saved_rev(&self, rev: u64) -> Result<()> {
        let dir = meta_dir(&self.dir)?;
        let tmp = dir.join("saved.tmp");
        write_new(&tmp, rev.to_string().as_bytes())?;
        std::fs::rename(&tmp, dir.join(SAVED_FILE))?;
        Ok(())
    }

    /// 記録にあるが comments.jsonl にまだ書き込んでいない変更（通し番号が saved より大きいもの。古い順）
    pub fn unsaved_log(&self, saved: u64) -> Vec<LogEntry> {
        read_meta(&self.dir, LOG_FILE)
            .map(|text| {
                text.lines()
                    .filter_map(|l| serde_json::from_str::<LogEntry>(l).ok())
                    .filter(|e| e.rev > saved)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 前に止まったときに書き込めていなかった変更を当てて書き込む（当てた件数を返す）。
    /// 古い版の作業フォルダ（.komenagare/saved が無い）は、記録を書き込んだ後に足していたので、全部書き込み済みとみなす。
    /// 書き込んだ後に止まって saved を更新できていなかったものも、当て直すと衝突して何も変わらない
    pub fn recover(&self, store: &mut Store, rev: u64) -> Result<usize> {
        let Some(saved) = self.saved_rev() else {
            self.set_saved_rev(rev)?;
            return Ok(0);
        };
        let pending = self.unsaved_log(saved);
        if pending.is_empty() {
            if saved != rev {
                self.set_saved_rev(rev)?;
            }
            return Ok(0);
        }
        let mut changed = 0;
        for e in &pending {
            if store.apply(&e.change, false).applied.is_some() {
                changed += 1;
            }
        }
        if changed > 0 {
            let ids: Vec<(&str, &str)> = pending
                .iter()
                .map(|e| ("Change-Id", e.change.id.as_str()))
                .collect();
            self.save(
                store,
                &format!("komenagare: 前回書き込めていなかった変更 {changed} 件を書き込み"),
                "komenagare",
                "komenagare@localhost",
                &ids,
            )?;
        }
        self.set_saved_rev(rev)?;
        Ok(changed)
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
        let tmp = meta_dir(&self.dir)?.join("comments.jsonl.tmp");
        write_new(&tmp, body.as_bytes())?;
        std::fs::rename(&tmp, self.dir.join(COMMENTS_FILE))?;
        if self.git {
            let _git = git_lock();
            self.run_git(&["add", "--", COMMENTS_FILE])?;
            self.commit(&[COMMENTS_FILE], message, author, email, trailers)?;
        }
        Ok(())
    }

    /// paths（作業フォルダからの相対）だけをコミットする。1つのリポジトリに複数のプロジェクト（作業フォルダ）を
    /// 入れたときに、ほかのプロジェクトや、人が git add しておいたファイルまで一緒にコミットしないように
    fn commit(
        &self,
        paths: &[&str],
        message: &str,
        author: &str,
        email: &str,
        trailers: &[(&str, &str)],
    ) -> Result<()> {
        let mut msg = message.to_string();
        if !trailers.is_empty() {
            msg.push_str("\n\n");
            for (k, v) in trailers {
                // 値は参加者が決める（Change-Id は変更セットの id）ので、改行で勝手に
                // 別の行（偽の Co-authored-by など）を足せないよう、clean で改行を落とす
                msg.push_str(&format!("{}: {}\n", clean(k), clean(v)));
            }
        }
        let author = format!("{} <{}>", clean(author), clean(email));
        let mut args = vec![
            "commit",
            "-q",
            "--no-verify",
            "--allow-empty",
            "-m",
            &msg,
            "--author",
            &author,
            "--",
        ];
        args.extend_from_slice(paths);
        self.run_git(&args)
    }

    fn run_git(&self, args: &[&str]) -> Result<()> {
        run_git(&self.dir, self.git_identity, args)
    }
}

fn run_git(dir: &Path, identity: bool, args: &[&str]) -> Result<()> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    // フックは動かさない（--no-verify では post-commit などは止まらない。フックの置き場所が作業ツリーの
    // 中（husky など）だと、--remote git の参加者が checkout で置いたフックが自動のコミットで動いてしまう）
    cmd.arg("-c")
        .arg(format!("core.hooksPath={}", no_hooks_path().display()));
    if identity {
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

/// git を動かして標準出力を返す（フックは動かさない）。identity なら名前とメールを補う。env と標準入力も渡せる。
/// まとめフォルダの取り込み・分けるときに使う
pub fn git_with(
    dir: &Path,
    identity: bool,
    args: &[&str],
    env: &[(&str, &str)],
    input: Option<&[u8]>,
) -> Result<String> {
    use std::io::Write;
    use std::process::Stdio;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir);
    cmd.arg("-c")
        .arg(format!("core.hooksPath={}", no_hooks_path().display()));
    if identity {
        cmd.args([
            "-c",
            "user.name=komenagare",
            "-c",
            "user.email=komenagare@localhost",
        ]);
    }
    cmd.args(args).envs(env.iter().copied());
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().context("git を実行できません")?;
    if let Some(data) = input {
        let mut stdin = child.stdin.take().context("git に渡せません")?;
        // 大きな入力でも詰まらないよう、書き込みは別の thread で行う
        let data = data.to_vec();
        let writer = std::thread::spawn(move || stdin.write_all(&data));
        let out = child.wait_with_output()?;
        let _ = writer.join();
        return git_result(args, out);
    }
    git_result(args, child.wait_with_output()?)
}

fn git_result(args: &[&str], out: std::process::Output) -> Result<String> {
    if !out.status.success() {
        bail!(
            "git {} に失敗しました: {}",
            args.first().copied().unwrap_or(""),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// タイムマシン（画面で comments.jsonl の履歴をさかのぼる）の1コミット
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Snapshot {
    /// コミットの id（16進）
    pub id: String,
    /// コミットした時刻（ミリ秒）
    pub time: u64,
    pub author: String,
    /// コミットの説明の1行目
    pub subject: String,
}

/// コミットの id として受け取ってよい形か（16進 40 文字か 64 文字。オプションや別の書き方を git に渡さない）
pub fn commit_id_ok(id: &str) -> bool {
    (id.len() == 40 || id.len() == 64)
        && id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// git log の出力（1コミット1行、項目は \x1f 区切り）を読む
fn parse_snapshots(text: &str) -> Vec<Snapshot> {
    text.lines()
        .filter_map(|l| {
            let mut f = l.split('\x1f');
            let id = f.next()?.to_string();
            let time = f.next()?.trim().parse::<u64>().ok()? * 1000;
            let author = f.next()?.to_string();
            let subject = f.next().unwrap_or("").to_string();
            commit_id_ok(&id).then_some(Snapshot {
                id,
                time,
                author,
                subject,
            })
        })
        .collect()
}

const SNAPSHOT_FORMAT: &str = "--format=%H%x1f%ct%x1f%an%x1f%s";

/// タイムマシン: dir の comments.jsonl を変えたコミット（新しい順に最大 limit 件）。
/// まだコミットが無ければ空。git の管理下でなければ Err
pub fn snapshots(dir: &Path, limit: usize) -> Result<Vec<Snapshot>> {
    if !in_git(dir) {
        bail!("このプロジェクトは git で記録していないため、さかのぼれません");
    }
    if git_out(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        return Ok(vec![]);
    }
    let n = format!("-n{limit}");
    // 署名の確かめ（gpg など）や色は使わない。パスは作業フォルダからの相対（まとめフォルダの中でも、そのプロジェクトの分だけ）
    let out = git_with(
        dir,
        false,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--no-color",
            "--no-show-signature",
            &n,
            SNAPSHOT_FORMAT,
            "--",
            COMMENTS_FILE,
        ],
        &[],
        None,
    )?;
    Ok(parse_snapshots(&out))
}

/// タイムマシン: コミット commit のときの dir の comments.jsonl（そのコミットの説明も返す）。
/// そのときファイルが無ければコメントなし
pub fn comments_at(dir: &Path, commit: &str) -> Result<(Snapshot, Vec<Comment>)> {
    if !commit_id_ok(commit) {
        bail!("コミットの指定が正しくありません");
    }
    if !in_git(dir) {
        bail!("このプロジェクトは git で記録していないため、さかのぼれません");
    }
    let info = git_with(
        dir,
        false,
        &[
            "-c",
            "log.showSignature=false",
            "log",
            "--no-color",
            "--no-show-signature",
            "-n1",
            SNAPSHOT_FORMAT,
            commit,
            "--",
        ],
        &[],
        None,
    )
    .context("そのコミットが見つかりません")?;
    let Some(info) = parse_snapshots(&info).into_iter().next() else {
        bail!("そのコミットが見つかりません");
    };
    // 「./」で作業フォルダからの相対にする（まとめフォルダなら、そのプロジェクトのフォルダの中）
    let path = format!("{commit}:./{COMMENTS_FILE}");
    if git_with(dir, false, &["cat-file", "-e", &path], &[], None).is_err() {
        return Ok((info, vec![]));
    }
    let text = git_with(dir, false, &["cat-file", "blob", &path], &[], None)?;
    let mut out = vec![];
    for (i, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(line).with_context(|| {
            format!(
                "{} の {} 行目を読めません（コミット {}）",
                COMMENTS_FILE,
                i + 1,
                &commit[..7]
            )
        })?);
    }
    Ok((info, out))
}

/// タイムマシン: あるコミットで最後に変えたコメント（git blame。comments.jsonl は1行1コメントなので、行を最後に変えたコミット）
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Edit {
    pub commit: String,
    /// コミットした時刻（ミリ秒）
    pub time: u64,
    pub author: String,
    /// そのコミットで最後に変えたコメントの id
    pub ids: Vec<String>,
}

/// git blame --porcelain の出力を、コミットごとにまとめる（新しい順）
fn parse_blame(text: &str) -> Vec<Edit> {
    let mut by: Vec<Edit> = vec![];
    let mut cur: Option<usize> = None;
    for line in text.lines() {
        if let Some(content) = line.strip_prefix('\t') {
            let id = serde_json::from_str::<serde_json::Value>(content)
                .ok()
                .and_then(|v| v["id"].as_str().map(str::to_string));
            if let (Some(i), Some(id)) = (cur, id) {
                by[i].ids.push(id);
            }
            continue;
        }
        let mut words = line.split(' ');
        let first = words.next().unwrap_or("");
        if commit_id_ok(first) && words.next().is_some() {
            cur = Some(match by.iter().position(|e| e.commit == first) {
                Some(i) => i,
                None => {
                    by.push(Edit {
                        commit: first.to_string(),
                        time: 0,
                        author: String::new(),
                        ids: vec![],
                    });
                    by.len() - 1
                }
            });
        } else if let (Some(i), Some(t)) = (cur, line.strip_prefix("committer-time ")) {
            by[i].time = t.trim().parse::<u64>().unwrap_or(0) * 1000;
        } else if let (Some(i), Some(a)) = (cur, line.strip_prefix("author ")) {
            by[i].author = a.to_string();
        }
    }
    by.retain(|e| !e.ids.is_empty());
    by.sort_by_key(|e| std::cmp::Reverse(e.time));
    by
}

/// タイムマシン: コミット commit のときの各コメントを、最後に変えたコミット（git blame）
pub fn edits_at(dir: &Path, commit: &str) -> Result<Vec<Edit>> {
    if !commit_id_ok(commit) {
        bail!("コミットの指定が正しくありません");
    }
    let out = git_with(
        dir,
        false,
        &[
            // リポジトリの設定で、ほかのファイルを読ませない
            "-c",
            "blame.ignoreRevsFile=",
            "blame",
            "--porcelain",
            commit,
            "--",
            COMMENTS_FILE,
        ],
        &[],
        None,
    )?;
    Ok(parse_blame(&out))
}

/// 名前とメールを補う必要があるか（git の user.email が未設定）
pub fn git_needs_identity(dir: &Path) -> bool {
    needs_identity(dir)
}

/// dir が git の管理下か
pub fn in_git(dir: &Path) -> bool {
    git_available() && git_out(dir, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

/// gone（dir からの相対のフォルダ）を git から外し（ファイルはそのまま）、files を足したコミットを作る。
/// ほかに git add してあるものは巻き込まない（一時の index でコミットを作り、今の index にも同じ変更だけを当てる）。
/// git の管理下でなければ何もしない
pub fn commit_removal(
    dir: &Path,
    gone: &str,
    files: &[&str],
    message: &str,
    author: &str,
    email: &str,
) -> Result<()> {
    if !in_git(dir) {
        return Ok(());
    }
    let identity = needs_identity(dir);
    let _git = git_lock();
    if git_out(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_err() {
        bail!("まだコミットがありません");
    }
    // git には git が返した形のまま（ふつうは dir からの相対）渡す。Windows の \\?\ で始まる形にすると読めないため
    let tmp_s = git_out(dir, &["rev-parse", "--git-path", "komenagare-index.tmp"])?
        .trim()
        .to_string();
    let tmp = {
        let p = PathBuf::from(&tmp_s);
        if p.is_absolute() {
            p
        } else {
            dir.join(p)
        }
    };
    let env = [("GIT_INDEX_FILE", tmp_s.as_str())];
    let r = (|| -> Result<()> {
        git_with(dir, false, &["read-tree", "HEAD"], &env, None)?;
        git_with(
            dir,
            false,
            &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", gone],
            &env,
            None,
        )?;
        let mut add = vec!["add", "-f", "--"];
        add.extend_from_slice(files);
        git_with(dir, false, &add, &env, None)?;
        let tree = git_with(dir, false, &["write-tree"], &env, None)?;
        let a_name = clean(author);
        let a_mail = clean(email);
        let new = git_with(
            dir,
            identity,
            &["commit-tree", tree.trim(), "-p", "HEAD", "-m", message],
            &[
                ("GIT_AUTHOR_NAME", a_name.as_str()),
                ("GIT_AUTHOR_EMAIL", a_mail.as_str()),
            ],
            None,
        )?;
        git_with(
            dir,
            false,
            &["update-ref", "-m", message, "HEAD", new.trim()],
            &[],
            None,
        )?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    r?;
    // 今の index にも同じ変更を当てる（git status をきれいにする）
    run_git(
        dir,
        false,
        &["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", gone],
    )?;
    let mut add = vec!["add", "-f", "--"];
    add.extend_from_slice(files);
    run_git(dir, false, &add)
}

/// dir にリポジトリを作る（git init）
pub fn git_init(dir: &Path) -> Result<()> {
    run_git(dir, false, &["init", "-q"])
}

/// files（dir からの相対）だけをコミットする（変わっていなければ何もしない）。git の管理下でなければ何もしない
pub fn commit_files(
    dir: &Path,
    files: &[&str],
    message: &str,
    author: &str,
    email: &str,
) -> Result<()> {
    if !in_git(dir) {
        return Ok(());
    }
    let identity = needs_identity(dir);
    let _git = git_lock();
    let mut add = vec!["add", "--"];
    add.extend_from_slice(files);
    run_git(dir, identity, &add)?;
    let mut diff = vec!["diff", "--cached", "--quiet", "--"];
    diff.extend_from_slice(files);
    if git_out(dir, &["rev-parse", "--verify", "-q", "HEAD"]).is_ok() && git_out(dir, &diff).is_ok()
    {
        return Ok(());
    }
    let author = format!("{} <{}>", clean(author), clean(email));
    let mut args = vec![
        "commit",
        "-q",
        "--no-verify",
        "-m",
        message,
        "--author",
        &author,
        "--",
    ];
    args.extend_from_slice(files);
    run_git(dir, identity, &args)
}

/// git を動かしている間持っておく。1つのリポジトリに複数のプロジェクトを入れると、プロジェクトごとの
/// 書き込み担当が同時に git を動かして index.lock を取り合うので、このプロセスの中では1つずつ動かす
fn git_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// .komenagare は git に入れない（ignore した）ので、git の checkout や reset で、追跡されたファイルや
// シンボリックリンクに置き換えられることがある（--remote git の参加者にもできる）。そのまま書くと
// 作業フォルダの外に書いてしまうので、シンボリックリンクはたどらない

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// .komenagare（作業用の記録の置き場所）。本物のフォルダでなければ断る
pub fn meta_dir(dir: &Path) -> Result<PathBuf> {
    let d = dir.join(META_DIR);
    let m =
        std::fs::symlink_metadata(&d).with_context(|| format!("{} がありません", d.display()))?;
    if !m.is_dir() {
        bail!(
            "{} がフォルダではありません（シンボリックリンクなどに置き換えられています）",
            d.display()
        );
    }
    Ok(d)
}

/// .komenagare のファイルを読む（シンボリックリンクなら読まない）
fn read_meta(dir: &Path, file: &str) -> Option<String> {
    let path = meta_dir(dir).ok()?.join(file);
    if is_symlink(&path) {
        eprintln!(
            "警告: {} がシンボリックリンクになっているため読みません",
            path.display()
        );
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// .komenagare/id（プロジェクトの id。参加者に配る）を読む。シンボリックリンクはたどらない
/// （--remote git の checkout などで作業フォルダの外のファイルへのリンクにされても、その中身を配らない）。
/// UUID の形でなければ使わない
fn read_id(dir: &Path) -> Result<String> {
    use std::io::Read;
    let path = meta_dir(dir)?.join("id");
    if is_symlink(&path) {
        bail!(
            "{} がシンボリックリンクになっています（作業フォルダの外のファイルは読みません）",
            path.display()
        );
    }
    let mut o = std::fs::OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let mut text = String::new();
    o.open(&path)
        .with_context(|| format!("{} を読めません", path.display()))?
        .take(128)
        .read_to_string(&mut text)
        .with_context(|| format!("{} を読めません", path.display()))?;
    let id = text.trim();
    if !crate::is_uuid(id) {
        bail!(
            "{} の中身が正しくありません（UUID ではありません）",
            path.display()
        );
    }
    Ok(id.to_string())
}

/// 変更の記録（.komenagare/log.jsonl）に1件書き足す
pub fn append_log_in(dir: &Path, e: &LogEntry) -> Result<()> {
    append_meta(dir, LOG_FILE, &format!("{}\n", serde_json::to_string(e)?))
}

/// .komenagare のファイルに書き足す（シンボリックリンクならたどらずに断る）
pub fn append_meta(dir: &Path, file: &str, text: &str) -> Result<()> {
    use std::io::Write;
    let path = meta_dir(dir)?.join(file);
    if is_symlink(&path) {
        bail!("{} がシンボリックリンクになっています", path.display());
    }
    let mut o = std::fs::OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NOFOLLOW);
    }
    let mut f = o
        .open(&path)
        .with_context(|| format!("{} に書けません", path.display()))?;
    f.write_all(text.as_bytes())?;
    Ok(())
}

/// 新しく作って書く（同じ名前のものがあれば先に消す。シンボリックリンクの先には書かない）
pub fn write_new(path: &Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    f.write_all(data)
}

fn clean(s: &str) -> String {
    s.chars()
        .filter(|c| !matches!(c, '<' | '>' | '\n' | '\r'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// git の user.email が未設定か（未設定ならコミットのときに補う）
/// git のフックを動かさないための core.hooksPath（フックが1つも無い場所）。
/// Unix は /dev/null（下にファイルを作れないので、ほかのユーザーが先回りしてフックを置くこともできない）。
/// Windows はユーザーごとの一時フォルダの中の、作らない名前（作業ツリーの外なので、git からは書けない）
pub fn no_hooks_path() -> PathBuf {
    if cfg!(unix) {
        PathBuf::from("/dev/null")
    } else {
        std::env::temp_dir().join("komenagare-no-hooks")
    }
}

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
pub(crate) mod tests {
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

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks_in_meta_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(&tmp.path().join("w"), GitMode::Off).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        // .komenagare の中のファイルがシンボリックリンク
        let target = outside.join("target.txt");
        std::fs::write(&target, "").unwrap();
        let meta = ws.dir.join(META_DIR);
        std::os::unix::fs::symlink(&target, meta.join(LOG_FILE)).unwrap();
        assert!(append_meta(&ws.dir, LOG_FILE, "x\n").is_err());
        std::os::unix::fs::symlink(&target, meta.join("comments.jsonl.tmp")).unwrap();
        ws.save(&Store::new(vec![]), "m", "a", "b", &[]).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "");
        assert!(!is_symlink(&ws.dir.join(COMMENTS_FILE)));
        // .komenagare そのものがシンボリックリンク
        std::fs::rename(&meta, tmp.path().join("old")).unwrap();
        std::os::unix::fs::symlink(&outside, &meta).unwrap();
        assert!(append_meta(&ws.dir, "commands.log", "x\n").is_err());
        assert!(!outside.join("commands.log").exists());
        assert!(ws.save(&Store::new(vec![]), "m", "a", "b", &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_read_id_through_symlink() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(&tmp.path().join("w"), GitMode::Off).unwrap();
        assert!(crate::is_uuid(&ws.id));
        // id が作業フォルダの外のファイルへのリンクにされた
        let secret = tmp.path().join("secret");
        std::fs::write(&secret, "ひみつ").unwrap();
        let id = ws.dir.join(META_DIR).join("id");
        std::fs::remove_file(&id).unwrap();
        std::os::unix::fs::symlink(&secret, &id).unwrap();
        let e = Workspace::open(&ws.dir, GitMode::Off).err().unwrap();
        assert!(e.to_string().contains("シンボリックリンク"), "{e}");
        // UUID でない中身も使わない
        std::fs::remove_file(&id).unwrap();
        std::fs::write(&id, "ひみつ\n").unwrap();
        assert!(Workspace::open(&ws.dir, GitMode::Off).is_err());
        std::fs::write(&id, format!("{}\n", ws.id)).unwrap();
        assert_eq!(Workspace::open(&ws.dir, GitMode::Off).unwrap().id, ws.id);
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

    /// 1つのリポジトリに複数のプロジェクトを入れても、それぞれ自分のファイルだけをコミットし、
    /// 同時に書き込んでも index.lock を取り合わない。複製したリポジトリでは init し直せば開ける
    #[test]
    fn several_projects_in_one_repo() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_out(&repo, &["init", "-q"]).unwrap();
        // 人が git add しておいたファイルは、自動のコミットに入れない
        std::fs::write(repo.join("memo.txt"), "メモ").unwrap();
        git_out(&repo, &["add", "memo.txt"]).unwrap();
        let a = Workspace::init(&repo.join("a"), GitMode::Require).unwrap();
        let b = Workspace::init(&repo.join("b"), GitMode::Require).unwrap();
        assert!(!repo.join("a/.git").exists() && !repo.join("b/.git").exists());
        std::thread::scope(|sc| {
            for (ws, name) in [(&a, "a"), (&b, "b")] {
                sc.spawn(move || {
                    for i in 0..10 {
                        let mut store = Store::new(ws.load_comments().unwrap());
                        store.apply(
                            &add(&format!("{name}{i}"), &format!("{name}{i}"), i as f64, name),
                            false,
                        );
                        ws.save(
                            &store,
                            &format!("{name}: 追加 {i}"),
                            name,
                            "x@komenagare",
                            &[],
                        )
                        .unwrap();
                    }
                });
            }
        });
        let files = |rev: &str| git_out(&repo, &["show", "--format=", "--name-only", rev]).unwrap();
        let log = git_out(&repo, &["log", "--format=%H|%s"]).unwrap();
        assert_eq!(log.lines().count(), 2 + 20, "{log}");
        for line in log.lines() {
            let (h, subject) = line.split_once('|').unwrap();
            let changed = files(h);
            assert!(!changed.contains("memo.txt"), "{subject}: {changed}");
            if let Some(name) = subject
                .strip_suffix(|c: char| c.is_ascii_digit())
                .and_then(|s| s.strip_suffix(": 追加 "))
            {
                assert_eq!(
                    changed.trim(),
                    format!("{name}/comments.jsonl"),
                    "{subject}"
                );
            }
        }
        assert!(git_out(&repo, &["diff", "--cached", "--name-only"])
            .unwrap()
            .contains("memo.txt"));
        assert_eq!(a.load_comments().unwrap().len(), 10);

        // 複製したリポジトリには .komenagare（git に入れない）が無いので、init し直してから開く
        let clone = tmp.path().join("clone");
        let out = Command::new("git")
            .args(["clone", "-q"])
            .arg(&repo)
            .arg(&clone)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(Workspace::open(&clone.join("a"), GitMode::Require).is_err());
        let commits = || git_out(&clone, &["rev-list", "--count", "HEAD"]).unwrap();
        let before = commits();
        let a2 = Workspace::init(&clone.join("a"), GitMode::Require).unwrap();
        assert_eq!(commits(), before, "init し直しても空のコミットは作らない");
        assert_eq!(a2.load_comments().unwrap().len(), 10);
        assert_ne!(a2.id, a.id);
        let ignore = std::fs::read_to_string(clone.join("a/.gitignore")).unwrap();
        assert_eq!(ignore.matches(".komenagare/").count(), 1, "{ignore}");
    }

    /// フックの置き場所を作業ツリーの中にし（husky など）、動いたら印のファイルを作るフックを置く
    #[cfg(unix)]
    pub(crate) fn plant_marker_hooks(repo: &Path, marker_dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let hooks = repo.join(".hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for h in [
            "pre-commit",
            "prepare-commit-msg",
            "commit-msg",
            "post-commit",
        ] {
            let p = hooks.join(h);
            let mark = marker_dir.join(format!("MARK-{h}"));
            std::fs::write(&p, format!("#!/bin/sh\ntouch '{}'\n", mark.display())).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let ok = Command::new("git")
            .args(["config", "core.hooksPath", ".hooks"])
            .current_dir(repo)
            .status()
            .unwrap()
            .success();
        assert!(ok);
    }

    #[cfg(unix)]
    #[test]
    fn auto_commit_does_not_run_hooks() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(&tmp.path().join("w"), GitMode::Require).unwrap();
        plant_marker_hooks(&ws.dir, tmp.path());
        ws.save(&Store::new(vec![]), "m", "a", "b@komenagare", &[])
            .unwrap();
        let marks: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("MARK-"))
            .map(|e| e.file_name())
            .collect();
        assert!(marks.is_empty(), "フックが動きました: {marks:?}");
    }

    #[test]
    fn trailer_value_cannot_inject_extra_lines() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(tmp.path(), GitMode::Require).unwrap();
        // 変更セットの id に改行と偽のトレーラーを仕込んでも、別の行にはならない
        ws.save(
            &Store::new(vec![]),
            "だれか: 追加 1",
            "だれか",
            "c1@komenagare",
            &[("Change-Id", "ch1\nCo-authored-by: 偽物 <evil@example.com>")],
        )
        .unwrap();
        // 改行が落ちるので、偽の行が独立した行にならない（Change-Id の値の一部になるだけ）
        let body = git_out(tmp.path(), &["log", "-1", "--format=%B"]).unwrap();
        assert!(
            !body.lines().any(|l| l.starts_with("Co-authored-by")),
            "{body}"
        );
        let co = git_out(
            tmp.path(),
            &[
                "log",
                "-1",
                "--format=%(trailers:key=Co-authored-by,valueonly)",
            ],
        )
        .unwrap();
        assert!(co.trim().is_empty(), "{co}");
    }

    #[test]
    fn time_machine_reads_past_comments() {
        if !git_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git_out(&repo, &["init", "-q"]).unwrap();
        // 同じリポジトリのほかのプロジェクトのコミットは出さない
        let a = Workspace::init(&repo.join("a"), GitMode::Require).unwrap();
        let b = Workspace::init(&repo.join("b"), GitMode::Require).unwrap();
        let first = snapshots(&a.dir, 100).unwrap();
        let mut store = Store::new(vec![]);
        for i in 0..3 {
            store.apply(
                &add(&format!("c{i}"), &format!("a{i}"), i as f64, "あ"),
                false,
            );
            a.save(
                &store,
                &format!("たろう: 追加 {i}"),
                "たろう",
                "x@komenagare",
                &[],
            )
            .unwrap();
            let other = Store::new(vec![]);
            b.save(&other, "はなこ: なし", "はなこ", "y@komenagare", &[])
                .unwrap();
        }
        let list = snapshots(&a.dir, 100).unwrap();
        assert_eq!(list.len(), first.len() + 3, "{list:?}");
        assert_eq!(list[0].subject, "たろう: 追加 2");
        assert_eq!(list[0].author, "たろう");
        assert!(list[0].time > 0 && commit_id_ok(&list[0].id));
        assert_eq!(snapshots(&a.dir, 2).unwrap().len(), 2);
        let (info, cs) = comments_at(&a.dir, &list[1].id).unwrap();
        assert_eq!(info, list[1]);
        let ids: Vec<&str> = cs.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["a0", "a1"]);
        // それぞれのコメントを最後に変えたコミット（新しい順）
        let edits = edits_at(&a.dir, &list[0].id).unwrap();
        // 同じ秒のコミットは順が決まらないので、一覧の順に並べて比べる
        let pos = |id: &str| list.iter().position(|c| c.id == id).unwrap();
        let mut got: Vec<(&str, Vec<&str>)> = edits
            .iter()
            .map(|e| {
                (
                    e.commit.as_str(),
                    e.ids.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        got.sort_by_key(|(c, _)| pos(c));
        assert_eq!(
            got,
            [
                (list[0].id.as_str(), vec!["a2"]),
                (list[1].id.as_str(), vec!["a1"]),
                (list[2].id.as_str(), vec!["a0"])
            ]
        );
        assert!(edits.iter().all(|e| e.author == "たろう"));
        assert_eq!(
            edits.iter().find(|e| e.commit == list[0].id).unwrap().time,
            list[0].time
        );
        assert!(edits_at(&a.dir, "HEAD").is_err());
        // 最初（コメントの無いとき）
        let (_, cs) = comments_at(&a.dir, &list.last().unwrap().id).unwrap();
        assert!(cs.is_empty());
        // 形の違う指定は git に渡さない
        for bad in [
            "HEAD",
            "--output=x",
            &list[0].id[..7],
            &list[0].id.to_uppercase(),
        ] {
            assert!(comments_at(&a.dir, bad).is_err(), "{bad}");
        }
        assert!(comments_at(&a.dir, &"0".repeat(40)).is_err());
        // git でなければ使えない
        let plain = tmp.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(snapshots(&plain, 10).is_err());
    }

    fn add(change: &str, id: &str, t: f64, text: &str) -> Change {
        Change {
            id: change.into(),
            ops: vec![Op::Add {
                id: id.into(),
                after: Fields {
                    t: Some(t),
                    cmd: Some("".into()),
                    text: Some(text.into()),
                },
            }],
        }
    }

    fn entry(rev: u64, change: Change) -> LogEntry {
        LogEntry {
            rev,
            time: 0,
            author: "たろう".into(),
            change,
        }
    }

    #[test]
    fn recovers_changes_not_yet_written() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = Workspace::init(tmp.path(), GitMode::Off).unwrap();
        // 古い版の作業フォルダ（saved が無い）は、記録を全部書き込み済みとみなす
        let mut store = Store::new(ws.load_comments().unwrap());
        let c1 = add("ch1", "a", 1.0, "書き込み済み");
        store.apply(&c1, false);
        ws.save(&store, "m", "たろう", "e", &[]).unwrap();
        ws.append_log(&entry(1, c1)).unwrap();
        assert_eq!(ws.saved_rev(), None);
        assert_eq!(ws.recover(&mut store, 1).unwrap(), 0);
        assert_eq!(ws.saved_rev(), Some(1));
        // 記録には足したが comments.jsonl に書き込む前に止まった（rev 2・3）
        ws.append_log(&entry(2, add("ch2", "b", 2.0, "未保存1")))
            .unwrap();
        ws.append_log(&entry(3, add("ch3", "c", 3.0, "未保存2")))
            .unwrap();
        let mut store = Store::new(ws.load_comments().unwrap());
        assert_eq!(store.len(), 1);
        let (_, rev, _) = ws.load_log(10).unwrap();
        assert_eq!(rev, 3);
        assert_eq!(ws.recover(&mut store, rev).unwrap(), 2);
        assert_eq!(store.len(), 3);
        assert_eq!(ws.saved_rev(), Some(3));
        assert_eq!(Store::new(ws.load_comments().unwrap()).len(), 3);
        // もう一度起動しても何もしない
        assert_eq!(ws.recover(&mut store, rev).unwrap(), 0);
        // 書き込んだ後に止まって saved を更新できなかったときは、当て直しても何も変わらない
        ws.set_saved_rev(1).unwrap();
        let mut store = Store::new(ws.load_comments().unwrap());
        assert_eq!(ws.recover(&mut store, 3).unwrap(), 0);
        assert_eq!(store.len(), 3);
        assert_eq!(ws.saved_rev(), Some(3));
    }
}
