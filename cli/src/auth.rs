// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! 参加者ごとのワンタイムパスワード（--otp）。
//!
//! ホストの人が参加者ごとにワンタイムパスワード（数字 6 桁か、ランダムな英数字）を発行し、参加者は
//! それを1回だけ使ってログインする。ログインするとブラウザにセッション（id.秘密）を渡し、以後はそれで入る。
//! 名前はセッションに結び付けるので、参加者が自分で名乗り直すことはできない。
//!
//! 置き場所（ふつうは ~/.config/komenagare/auth）には1件1ファイルで置く。
//!   otp/<id>.json       発行したワンタイムパスワード（ハッシュだけ）。使ったら消す
//!   sessions/<id>.json  ログイン中のセッション（秘密のハッシュだけ）。取り消したら消す
//! ファイルを分けておくと、動いているホストと `komenagare otp` が同時に書いても壊れない。

use anyhow::{bail, Context, Result};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// 数字 6 桁（打ちやすいが当てられやすいので、有効期限を短くする）
    Numeric,
    /// 英数字 10 文字（見間違えやすい文字は使わない）
    Random,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "numeric" => Some(Kind::Numeric),
            "random" => Some(Kind::Random),
            _ => None,
        }
    }
    /// 有効期限の既定
    pub fn default_ttl(self) -> Duration {
        match self {
            Kind::Numeric => Duration::from_secs(10 * 60),
            Kind::Random => Duration::from_secs(7 * 24 * 3600),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct OtpRec {
    pub id: String,
    pub name: String,
    pub admin: bool,
    pub kind: Kind,
    hash: String,
    pub created: u64,
    pub expires: u64,
    /// 起動のたびに作る管理者用（次の起動で消す）
    #[serde(default)]
    pub startup: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionRec {
    pub id: String,
    pub name: String,
    pub admin: bool,
    hash: String,
    pub created: u64,
}

pub struct Issued {
    pub id: String,
    pub code: String,
    pub expires: u64,
}

pub struct Auth {
    dir: PathBuf,
}

const RANDOM_CHARS: &[u8] = b"abcdefghjkmnpqrstuvwxyz23456789";
pub const NAME_MAX: usize = 40;

impl Auth {
    /// 置き場所の既定（KOMENAGARE_CONFIG_DIR、なければ OS の設定の置き場所）
    pub fn default_dir() -> Option<PathBuf> {
        let base = if let Some(d) = std::env::var_os("KOMENAGARE_CONFIG_DIR") {
            Some(PathBuf::from(d))
        } else {
            let home = std::env::var_os("HOME").map(PathBuf::from);
            if cfg!(windows) {
                std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("komenagare"))
            } else if cfg!(target_os = "macos") {
                home.map(|h| h.join("Library/Application Support/komenagare"))
            } else {
                std::env::var_os("XDG_CONFIG_HOME")
                    .map(PathBuf::from)
                    .or_else(|| home.map(|h| h.join(".config")))
                    .map(|d| d.join("komenagare"))
            }
        };
        base.map(|b| b.join("auth"))
    }

    pub fn open(dir: &Path) -> Result<Auth> {
        for sub in ["otp", "sessions"] {
            std::fs::create_dir_all(dir.join(sub))
                .with_context(|| format!("{} を作れません", dir.join(sub).display()))?;
        }
        private(dir, true);
        Ok(Auth {
            dir: dir.to_path_buf(),
        })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// ワンタイムパスワードを発行する
    pub fn issue(&self, name: &str, admin: bool, kind: Kind, ttl: Duration) -> Result<Issued> {
        let name = clean_name(name).context("名前を入れてください")?;
        let code = new_code(kind);
        let now = now_ms();
        let rec = OtpRec {
            id: random_hex(8),
            name,
            admin,
            kind,
            hash: hash(&normalize(&code)),
            created: now,
            expires: now + ttl.as_millis() as u64,
            startup: false,
        };
        self.write(&self.otp_path(&rec.id), &rec)?;
        Ok(Issued {
            id: rec.id,
            code,
            expires: rec.expires,
        })
    }

    /// 起動のたびに作る管理者用のワンタイムパスワード（前回の分は消す）
    pub fn issue_startup(&self) -> Result<Issued> {
        for o in self.otps() {
            if o.startup {
                let _ = std::fs::remove_file(self.otp_path(&o.id));
            }
        }
        let issued = self.issue("ホスト", true, Kind::Random, Duration::from_secs(24 * 3600))?;
        let path = self.otp_path(&issued.id);
        let mut rec: OtpRec = serde_json::from_str(&std::fs::read_to_string(&path)?)?;
        rec.startup = true;
        self.write(&path, &rec)?;
        Ok(issued)
    }

    /// ワンタイムパスワードでログインする（合えばそのワンタイムパスワードは消え、セッションの鍵を返す）
    pub fn login(&self, code: &str) -> Result<Option<(String, SessionRec)>> {
        let h = hash(&normalize(code));
        let now = now_ms();
        for o in self.otps() {
            if o.hash != h || o.expires < now {
                continue;
            }
            // 消せた人だけが使える（同時に使われても1回きり）
            if std::fs::remove_file(self.otp_path(&o.id)).is_err() {
                return Ok(None);
            }
            let secret = random_hex(32);
            let rec = SessionRec {
                id: random_hex(8),
                name: o.name,
                admin: o.admin,
                hash: hash(&secret),
                created: now,
            };
            self.write(&self.session_path(&rec.id), &rec)?;
            return Ok(Some((format!("{}.{}", rec.id, secret), rec)));
        }
        Ok(None)
    }

    /// セッションの鍵を確かめる
    pub fn verify(&self, token: &str) -> Option<SessionRec> {
        let (id, secret) = token.split_once('.')?;
        if !is_hex(id) {
            return None;
        }
        let rec = self.session(id)?;
        (rec.hash == hash(secret)).then_some(rec)
    }

    /// セッションがまだあるか（取り消されていないか）
    pub fn alive(&self, id: &str) -> bool {
        is_hex(id) && self.session_path(id).is_file()
    }

    pub fn sessions(&self) -> Vec<SessionRec> {
        let mut v: Vec<SessionRec> = read_all(&self.dir.join("sessions"));
        v.sort_by_key(|s| s.created);
        v
    }

    /// 未使用のワンタイムパスワード（期限切れは消す）
    pub fn otps(&self) -> Vec<OtpRec> {
        let now = now_ms();
        let mut v: Vec<OtpRec> = read_all(&self.dir.join("otp"));
        v.retain(|o| {
            let live = o.expires >= now;
            if !live {
                let _ = std::fs::remove_file(self.otp_path(&o.id));
            }
            live
        });
        v.sort_by_key(|o| o.created);
        v
    }

    /// id か名前に合うセッションとワンタイムパスワードを取り消す。取り消したセッションの id を返す
    pub fn revoke(&self, who: &str) -> (Vec<String>, usize) {
        let mut sessions = vec![];
        for s in self.sessions() {
            if (s.id == who || s.name == who)
                && std::fs::remove_file(self.session_path(&s.id)).is_ok()
            {
                sessions.push(s.id);
            }
        }
        let mut otps = 0;
        for o in self.otps() {
            if (o.id == who || o.name == who) && std::fs::remove_file(self.otp_path(&o.id)).is_ok()
            {
                otps += 1;
            }
        }
        (sessions, otps)
    }

    fn session(&self, id: &str) -> Option<SessionRec> {
        serde_json::from_str(&std::fs::read_to_string(self.session_path(id)).ok()?).ok()
    }
    fn otp_path(&self, id: &str) -> PathBuf {
        self.dir.join("otp").join(format!("{id}.json"))
    }
    fn session_path(&self, id: &str) -> PathBuf {
        self.dir.join("sessions").join(format!("{id}.json"))
    }
    fn write<T: Serialize>(&self, path: &Path, v: &T) -> Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(v)?)?;
        private(&tmp, false);
        std::fs::rename(&tmp, path)?;
        Ok(())
    }
}

/// 入力されたワンタイムパスワードをそろえる（大文字小文字・空白・ハイフンを区別しない）
pub fn normalize(code: &str) -> String {
    code.chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

pub fn clean_name(name: &str) -> Option<String> {
    let n: String = name.trim().chars().take(NAME_MAX).collect();
    (!n.is_empty()).then_some(n)
}

/// 「10m」「1h」「7d」「30s」などを読む
pub fn parse_ttl(s: &str) -> Result<Duration> {
    let s = s.trim();
    let (num, unit) = s.split_at(s.find(|c: char| !c.is_ascii_digit()).unwrap_or(s.len()));
    let n: u64 = num
        .parse()
        .with_context(|| format!("期限「{s}」を読めません（例 10m・1h・7d）"))?;
    let secs = match unit {
        "s" => n,
        "" | "m" => n * 60,
        "h" => n * 3600,
        "d" => n * 86400,
        _ => bail!("期限「{s}」を読めません（例 10m・1h・7d）"),
    };
    if secs == 0 {
        bail!("期限は 1 秒以上にしてください");
    }
    Ok(Duration::from_secs(secs))
}

fn new_code(kind: Kind) -> String {
    let mut r = rand::rng();
    match kind {
        Kind::Numeric => format!("{:06}", r.random_range(0..1_000_000)),
        Kind::Random => (0..10)
            .map(|_| RANDOM_CHARS[r.random_range(0..RANDOM_CHARS.len())] as char)
            .collect(),
    }
}

fn random_hex(bytes: usize) -> String {
    let mut r = rand::rng();
    (0..bytes)
        .map(|_| format!("{:02x}", r.random::<u8>()))
        .collect()
}

fn hash(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn read_all<T: for<'de> Deserialize<'de>>(dir: &Path) -> Vec<T> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return vec![];
    };
    rd.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str(&std::fs::read_to_string(e.path()).ok()?).ok())
        .collect()
}

/// 自分だけが読めるようにする（Unix のみ）
fn private(path: &Path, dir: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if dir { 0o700 } else { 0o600 };
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, dir);
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth() -> (tempfile::TempDir, Auth) {
        let d = tempfile::tempdir().unwrap();
        let a = Auth::open(d.path()).unwrap();
        (d, a)
    }

    #[test]
    fn codes_have_the_right_shape() {
        let n = new_code(Kind::Numeric);
        assert_eq!(n.len(), 6);
        assert!(n.chars().all(|c| c.is_ascii_digit()));
        let r = new_code(Kind::Random);
        assert_eq!(r.len(), 10);
        assert!(r.bytes().all(|c| RANDOM_CHARS.contains(&c)));
    }

    #[test]
    fn otp_is_used_only_once() {
        let (_d, a) = auth();
        let i = a
            .issue(" Aさん ", false, Kind::Random, Duration::from_secs(60))
            .unwrap();
        assert_eq!(a.otps().len(), 1);
        // 大文字・空白・ハイフンは区別しない
        let typed = format!("{}-{} ", &i.code[..5], &i.code[5..]).to_uppercase();
        let (token, s) = a.login(&typed).unwrap().unwrap();
        assert_eq!(s.name, "Aさん");
        assert!(!s.admin);
        assert!(a.login(&i.code).unwrap().is_none());
        assert!(a.otps().is_empty());
        let v = a.verify(&token).unwrap();
        assert_eq!(v.id, s.id);
        assert!(a.alive(&s.id));
        // 秘密が違えば入れない
        assert!(a.verify(&format!("{}.00", s.id)).is_none());
        assert!(a.verify("../x.y").is_none());
        assert!(a.verify("garbage").is_none());
    }

    #[test]
    fn expired_otp_is_rejected_and_removed() {
        let (_d, a) = auth();
        let i = a
            .issue("B", false, Kind::Numeric, Duration::from_secs(60))
            .unwrap();
        let p = a.otp_path(&i.id);
        let mut rec: OtpRec = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        rec.expires = 1;
        a.write(&p, &rec).unwrap();
        assert!(a.login(&i.code).unwrap().is_none());
        assert!(a.otps().is_empty());
        assert!(!p.exists());
    }

    #[test]
    fn revoke_by_name_or_id() {
        let (_d, a) = auth();
        let i = a
            .issue("C", true, Kind::Random, Duration::from_secs(60))
            .unwrap();
        let (token, s) = a.login(&i.code).unwrap().unwrap();
        a.issue("C", false, Kind::Numeric, Duration::from_secs(60))
            .unwrap();
        a.issue("D", false, Kind::Numeric, Duration::from_secs(60))
            .unwrap();
        let (sessions, otps) = a.revoke("C");
        assert_eq!(sessions, vec![s.id.clone()]);
        assert_eq!(otps, 1);
        assert!(a.verify(&token).is_none());
        assert!(!a.alive(&s.id));
        assert_eq!(a.otps().len(), 1);
    }

    #[test]
    fn startup_otp_replaces_the_previous_one() {
        let (_d, a) = auth();
        let first = a.issue_startup().unwrap();
        a.issue("E", false, Kind::Random, Duration::from_secs(60))
            .unwrap();
        let second = a.issue_startup().unwrap();
        let ids: Vec<String> = a.otps().into_iter().map(|o| o.id).collect();
        assert!(!ids.contains(&first.id));
        assert!(ids.contains(&second.id));
        assert_eq!(ids.len(), 2);
        let (_, s) = a.login(&second.code).unwrap().unwrap();
        assert!(s.admin);
    }

    #[test]
    fn ttl_parsing() {
        assert_eq!(parse_ttl("10m").unwrap(), Duration::from_secs(600));
        assert_eq!(parse_ttl("2h").unwrap(), Duration::from_secs(7200));
        assert_eq!(parse_ttl("7d").unwrap(), Duration::from_secs(7 * 86400));
        assert_eq!(parse_ttl("30").unwrap(), Duration::from_secs(1800));
        assert!(parse_ttl("x").is_err());
        assert!(parse_ttl("0m").is_err());
        assert!(parse_ttl("5w").is_err());
    }
}
