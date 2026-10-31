// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! 配信する Web アプリの用意。
//!
//! 起動時に GitHub Pages（--web-url）から最新の Web アプリを取ってきて、手元の保存場所
//! （~/.cache/komenagare/web、Windows は %LOCALAPPDATA%\komenagare\web など）に置き、
//! そこから配信する。Web 版を更新すれば CLI を入れ直さなくても共同編集の画面が新しくなる。
//!
//! 取ってくるファイルは web.json の files に書いてある。web.json の protocol（ホストとの
//! やりとりの取り決めの版数）がこの CLI の対応外なら使わない（CLI の更新が必要）。
//! 取れないときは前回の控え、それも無ければ CLI に組み込んだ Web アプリを使う。
//!
//! 取ってきた Web アプリは、署名（web.sums と web.sums.minisig。sign.rs）を確かめてから使う。
//! 署名の秘密鍵は承認の要る environment にだけあるので、main に push したり GitHub Pages を
//! 書き換えたりできるだけでは、ホストが配信する Web アプリ（--remote ではコマンドを打てる）を差し替えられない。

use crate::server::PROTOCOL;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const DEFAULT_URL: &str = "https://igarinpiano.github.io/komenagare/";
const ETAGS: &str = ".etags.json";

#[derive(Deserialize, Serialize)]
pub struct Manifest {
    pub protocol: u32,
    pub files: Vec<String>,
}

/// 配信する Web アプリ
pub enum Source {
    /// CLI に組み込んだもの
    Bundled,
    /// フォルダから（取ってきた控え、または --web）
    Dir(PathBuf),
}

pub enum Outcome {
    /// 新しくなった（変わったファイルの数）
    Updated(usize),
    /// 手元の控えと同じだった
    UpToDate,
    /// Web 版の取り決めがこの CLI では使えない
    Incompatible(u32),
}

/// 取ってきた Web アプリを置く場所
pub fn cache_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("KOMENAGARE_CACHE_DIR") {
        return Some(PathBuf::from(d));
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".cache")))
    };
    base.map(|b| b.join("komenagare").join("web"))
}

/// 署名（web.sums と web.sums.minisig）
const SUMS: &str = "web.sums";
const SIG: &str = "web.sums.minisig";

/// 署名を確かめた Web アプリの中身の一覧（ファイル名 → SHA-256）と、署名した時刻
struct Signed {
    sums: HashMap<String, String>,
    time: u64,
}

impl Signed {
    /// web.sums と署名を確かめる（protocol は web.json のもの。署名にも同じ版数が入っている）
    fn check_signature(
        key: &minisign_verify::PublicKey,
        sums: &[u8],
        sig: &[u8],
        protocol: u32,
    ) -> Result<Signed> {
        let comment = crate::sign::verify(key, sums, &String::from_utf8_lossy(sig))?;
        if !comment.starts_with("komenagare-web ")
            || crate::sign::field(&comment, "protocol") != Some(protocol.to_string().as_str())
        {
            bail!("Web アプリの署名が、このファイルのものではありません（{comment}）");
        }
        let time = crate::sign::field(&comment, "time")
            .and_then(|t| t.parse().ok())
            .context("Web アプリの署名に時刻がありません")?;
        Ok(Signed {
            sums: crate::sign::parse_sums(&String::from_utf8_lossy(sums)),
            time,
        })
    }

    /// ファイルの中身が署名した一覧と同じか
    fn check(&self, name: &str, data: &[u8]) -> Result<()> {
        match self.sums.get(name) {
            Some(h) if *h == crate::sign::sha256_hex(data) => Ok(()),
            Some(_) => bail!("{name} が署名した内容と違います"),
            None => bail!("{name} が署名した一覧にありません"),
        }
    }
}

/// 控えのフォルダを確かめる（署名・web.json・書かれたファイル全部）。使えるなら署名した時刻
fn verify_dir(dir: &Path, key: &minisign_verify::PublicKey, protocol: u32) -> Result<u64> {
    let manifest_bytes = std::fs::read(dir.join("web.json"))?;
    let m: Manifest = serde_json::from_slice(&manifest_bytes)?;
    if m.protocol != protocol {
        bail!("取り決めの版数が違います（{}）", m.protocol);
    }
    let signed = Signed::check_signature(
        key,
        &std::fs::read(dir.join(SUMS))?,
        &std::fs::read(dir.join(SIG))?,
        m.protocol,
    )?;
    signed.check("web.json", &manifest_bytes)?;
    for f in &m.files {
        // 控えの外を指す名前は使わない（server.rs と同じ規則）
        if !crate::server::web_path_ok(f) {
            bail!("web.json のファイル名が正しくありません: {f}");
        }
        signed.check(f, &std::fs::read(dir.join(f))?)?;
    }
    Ok(signed.time)
}

/// 手元の控えがこの CLI でそのまま使えるか（署名が合い、どのファイルも署名したときのままか）。
/// 署名の無い控え（前の版の komenagare が取ってきたもの）や、書き換えられた控えは使わない
pub fn cached_usable(dir: &Path) -> bool {
    crate::sign::trusted_key().is_ok_and(|k| verify_dir(dir, &k, PROTOCOL).is_ok())
}

/// 最新の Web アプリを取ってきて控えを新しくする（変わっていないファイルは ETag で取り直さない）。
/// 署名を確かめ、どのファイルも署名した中身と同じときだけ控えにする
pub fn update(base_url: &str, dir: &Path) -> Result<Outcome> {
    update_with_key(base_url, dir, &crate::sign::trusted_key()?)
}

fn update_with_key(
    base_url: &str,
    dir: &Path,
    key: &minisign_verify::PublicKey,
) -> Result<Outcome> {
    let base = if base_url.ends_with('/') {
        base_url.to_string()
    } else {
        format!("{base_url}/")
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
        // https で始めたら、転送で http に落ちても取らない（http のミラーを指定したときはそのまま使える）
        .https_only(base.starts_with("https://"))
        .build()
        .into();
    let manifest_bytes =
        get(&agent, &format!("{base}web.json"), None)?.context("web.json が空です")?;
    let manifest: Manifest =
        serde_json::from_slice(&manifest_bytes).context("web.json を読めません")?;
    if manifest.protocol != PROTOCOL {
        return Ok(Outcome::Incompatible(manifest.protocol));
    }
    for f in &manifest.files {
        // 控えに書いてよい名前だけ（server.rs と同じ規則。\ やドライブ名で控えの外に書かせない）
        if !crate::server::web_path_ok(f) {
            bail!("web.json のファイル名が正しくありません: {f}");
        }
    }
    // 署名を確かめる（GitHub Pages や途中が差し替えられても、署名の無いものは使わない）
    let unsigned = "Web アプリの署名（web.sums・web.sums.minisig）を取れません";
    let sums_bytes = get(&agent, &format!("{base}{SUMS}"), None)
        .context(unsigned)?
        .context(unsigned)?;
    let sig_bytes = get(&agent, &format!("{base}{SIG}"), None)
        .context(unsigned)?
        .context(unsigned)?;
    let signed = Signed::check_signature(key, &sums_bytes, &sig_bytes, manifest.protocol)
        .context("Web アプリの署名を確かめられません")?;
    signed.check("web.json", &manifest_bytes)?;
    // 手元の控えより前に署名したものには戻さない（直す前の古い版に差し替えられないように）
    if let Ok(t) = verify_dir(dir, key, PROTOCOL) {
        if signed.time < t {
            bail!("取ってきた Web アプリが手元の控えより古いため使いません");
        }
    }

    let old_etags: HashMap<String, String> = std::fs::read_to_string(dir.join(ETAGS))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    // 新しい控えは別の場所に作り、全部そろってから入れ替える
    let staging = dir.with_extension("new");
    let _ = std::fs::remove_dir_all(&staging);
    let mut etags = HashMap::new();
    let mut changed = 0;
    for f in &manifest.files {
        let old = dir.join(f);
        let known = old.is_file().then(|| old_etags.get(f)).flatten();
        let (body, etag) = get_with_etag(&agent, &format!("{base}{f}"), known.map(String::as_str))?;
        let dest = staging.join(f);
        std::fs::create_dir_all(dest.parent().unwrap())?;
        // 取ってきたものも、変わっていない（304）ので手元から写すものも、署名した中身と同じか確かめる
        let data = match body {
            Some(b) => {
                changed += 1;
                b
            }
            None => std::fs::read(&old)?,
        };
        signed.check(f, &data)?;
        std::fs::write(&dest, data)?;
        if let Some(e) = etag.or_else(|| known.cloned()) {
            etags.insert(f.clone(), e);
        }
    }
    std::fs::write(staging.join("web.json"), &manifest_bytes)?;
    std::fs::write(staging.join(SUMS), &sums_bytes)?;
    std::fs::write(staging.join(SIG), &sig_bytes)?;
    std::fs::write(staging.join(ETAGS), serde_json::to_string(&etags)?)?;
    let same = |name: &str, new: &[u8]| {
        std::fs::read(dir.join(name))
            .map(|b| b == new)
            .unwrap_or(false)
    };
    if changed == 0
        && same("web.json", &manifest_bytes)
        && same(SUMS, &sums_bytes)
        && same(SIG, &sig_bytes)
    {
        let _ = std::fs::remove_dir_all(&staging);
        return Ok(Outcome::UpToDate);
    }
    let old = dir.with_extension("old");
    let _ = std::fs::remove_dir_all(&old);
    if dir.exists() {
        std::fs::rename(dir, &old)?;
    }
    std::fs::rename(&staging, dir)?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(Outcome::Updated(changed))
}

fn get(agent: &ureq::Agent, url: &str, etag: Option<&str>) -> Result<Option<Vec<u8>>> {
    Ok(get_with_etag(agent, url, etag)?.0)
}

/// 変わっていなければ（304）None を返す
fn get_with_etag(
    agent: &ureq::Agent,
    url: &str,
    etag: Option<&str>,
) -> Result<(Option<Vec<u8>>, Option<String>)> {
    let mut req = agent.get(url);
    if let Some(e) = etag {
        req = req.header("If-None-Match", e);
    }
    let mut resp = req
        .call()
        .with_context(|| format!("{url} を取得できません"))?;
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    if resp.status() == 304 {
        return Ok((None, etag));
    }
    let mut body = vec![];
    resp.body_mut()
        .as_reader()
        .take(64 << 20)
        .read_to_end(&mut body)?;
    Ok((Some(body), etag))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::sign::tests::test_key;

    fn fixture_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/sign/web")
    }

    /// フォルダの中身を写す（テスト用）
    fn copy_dir(from: &Path, to: &Path) {
        for e in std::fs::read_dir(from).unwrap().flatten() {
            let (src, dst) = (e.path(), to.join(e.file_name()));
            if src.is_dir() {
                std::fs::create_dir_all(&dst).unwrap();
                copy_dir(&src, &dst);
            } else {
                std::fs::copy(&src, &dst).unwrap();
            }
        }
    }

    #[test]
    fn verifies_signed_cache() {
        let key = test_key();
        assert_eq!(
            verify_dir(&fixture_dir(), &key, PROTOCOL).unwrap(),
            1_700_000_000
        );
        // 別の鍵・違う版数では使わない
        let other =
            minisign_verify::PublicKey::decode(include_str!("../../tests/fixtures/sign/other.pub"))
                .unwrap();
        assert!(verify_dir(&fixture_dir(), &other, PROTOCOL).is_err());
        assert!(verify_dir(&fixture_dir(), &key, PROTOCOL - 1).is_err());

        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path();
        copy_dir(&fixture_dir(), d);
        // ファイルを書き換えた控え
        std::fs::write(d.join("js/app.js"), "alert(1);\n").unwrap();
        assert!(verify_dir(d, &key, PROTOCOL).is_err());
        copy_dir(&fixture_dir(), d);
        assert!(verify_dir(d, &key, PROTOCOL).is_ok());
        // ファイルが欠けた控え・署名の無い控え（前の版の komenagare が取ってきたもの）
        std::fs::remove_file(d.join("index.html")).unwrap();
        assert!(verify_dir(d, &key, PROTOCOL).is_err());
        copy_dir(&fixture_dir(), d);
        std::fs::remove_file(d.join(SIG)).unwrap();
        assert!(verify_dir(d, &key, PROTOCOL).is_err());
        // 公開鍵がまだ置かれていなければ、控えは使わない（内蔵の Web アプリを使う）
        if crate::sign::trusted_key().is_err() {
            assert!(!cached_usable(&fixture_dir()));
        }
    }

    /// 決まったファイルを返すだけの HTTP サーバー（テスト用。ETag と 304 は GitHub Pages のように返す）
    fn serve(files: HashMap<String, Vec<u8>>) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for mut s in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let n = s.read(&mut buf).unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path = req.split(' ').nth(1).unwrap_or("/").trim_start_matches('/');
                let inm = req
                    .lines()
                    .find_map(|l| {
                        l.strip_prefix("if-none-match: ")
                            .or_else(|| l.strip_prefix("If-None-Match: "))
                    })
                    .map(str::to_string);
                let (status, body, etag) = match files.get(path) {
                    Some(b) => {
                        let etag = format!("\"{}\"", crate::sign::sha256_hex(b));
                        if inm.as_deref() == Some(etag.as_str()) {
                            ("304 Not Modified", vec![], etag)
                        } else {
                            ("200 OK", b.clone(), etag)
                        }
                    }
                    None => ("404 Not Found", vec![], String::new()),
                };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nETag: {etag}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(&body);
            }
        });
        format!("http://{addr}/")
    }

    fn fixture_files() -> HashMap<String, Vec<u8>> {
        ["web.json", "index.html", "js/app.js", SUMS, SIG]
            .iter()
            .map(|f| (f.to_string(), std::fs::read(fixture_dir().join(f)).unwrap()))
            .collect()
    }

    #[test]
    fn update_uses_only_signed_web_app() {
        let key = test_key();
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("web");

        // 署名の無いものは使わない
        let mut unsigned = fixture_files();
        unsigned.remove(SIG);
        assert!(update_with_key(&serve(unsigned), &cache, &key).is_err());
        assert!(!cache.exists());

        // 中身を差し替えたもの（署名した一覧と違う）は使わない
        let mut tampered = fixture_files();
        tampered.insert("js/app.js".into(), b"alert(1);\n".to_vec());
        assert!(update_with_key(&serve(tampered), &cache, &key).is_err());
        assert!(!cache.exists());

        // 署名の合うものは控えにする
        let url = serve(fixture_files());
        assert!(matches!(
            update_with_key(&url, &cache, &key).unwrap(),
            Outcome::Updated(2)
        ));
        assert_eq!(verify_dir(&cache, &key, PROTOCOL).unwrap(), 1_700_000_000);
        assert!(matches!(
            update_with_key(&url, &cache, &key).unwrap(),
            Outcome::UpToDate
        ));
        // 変わっていない（304）ので手元から写すファイルも確かめる（控えが書き換えられていたら使わない）
        std::fs::write(cache.join("js/app.js"), "alert(1);\n").unwrap();
        assert!(update_with_key(&url, &cache, &key).is_err());
        std::fs::remove_dir_all(&cache).unwrap();
        assert!(matches!(
            update_with_key(&url, &cache, &key).unwrap(),
            Outcome::Updated(2)
        ));

        // 手元の控えより古い署名のもの（直す前の版）には戻さない
        let mut older = fixture_files();
        older.insert(
            SIG.into(),
            std::fs::read(fixture_dir().join("../web.sums.minisig.older")).unwrap(),
        );
        let Err(e) = update_with_key(&serve(older), &cache, &key) else {
            panic!("古い署名のものを使ってしまう");
        };
        assert!(format!("{e:#}").contains("古い"), "{e:#}");
        assert_eq!(verify_dir(&cache, &key, PROTOCOL).unwrap(), 1_700_000_000);

        // 別の鍵の署名は使わない
        let other =
            minisign_verify::PublicKey::decode(include_str!("../../tests/fixtures/sign/other.pub"))
                .unwrap();
        let tmp2 = tempfile::tempdir().unwrap();
        assert!(update_with_key(&url, &tmp2.path().join("web"), &other).is_err());
    }

    #[test]
    fn web_json_matches_protocol_and_bundle() {
        // リポジトリの web.json がこの CLI の取り決めと一致し、書かれたファイルが全部あること
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let m: Manifest =
            serde_json::from_str(&std::fs::read_to_string(root.join("web.json")).unwrap()).unwrap();
        assert_eq!(
            m.protocol, PROTOCOL,
            "web.json の protocol と server.rs の PROTOCOL が違います"
        );
        for f in &m.files {
            assert!(root.join(f).is_file(), "{f} がありません");
        }
        // css/ js/ lib/ に足したファイルを web.json に書き忘れていないこと
        for d in ["css", "js", "lib"] {
            for e in std::fs::read_dir(root.join(d)).unwrap() {
                let f = format!("{d}/{}", e.unwrap().file_name().to_string_lossy());
                assert!(
                    m.files.contains(&f),
                    "{f} が web.json の files にありません"
                );
            }
        }
        let app = std::fs::read_to_string(root.join("js/app.js")).unwrap();
        assert!(
            app.contains(&format!("const COLLAB_PROTOCOL = {PROTOCOL};")),
            "js/app.js の COLLAB_PROTOCOL が違います"
        );
    }
}
