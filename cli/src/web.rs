//! 配信する Web アプリの用意。
//!
//! 起動時に GitHub Pages（--web-url）から最新の Web アプリを取ってきて、手元の保存場所
//! （~/.cache/komenagare/web など）に置き、そこから配信する。Web 版を更新すれば CLI を
//! 入れ直さなくても共同編集の画面が新しくなる。
//!
//! 取ってくるファイルは web.json の files に書いてある。web.json の protocol（ホストとの
//! やりとりの取り決めの版数）がこの CLI の対応外なら使わない（CLI の更新が必要）。
//! 取れないときは前回の控え、それも無ければ CLI に組み込んだ Web アプリを使う。

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
    let base = if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library/Caches"))
    } else {
        std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .or_else(|| home.map(|h| h.join(".cache")))
    };
    base.map(|b| b.join("komenagare").join("web"))
}

/// 手元の控えがこの CLI でそのまま使えるか
pub fn cached_usable(dir: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(dir.join("web.json")) else {
        return false;
    };
    let Ok(m) = serde_json::from_str::<Manifest>(&text) else {
        return false;
    };
    m.protocol == PROTOCOL && m.files.iter().all(|f| dir.join(f).is_file())
}

/// 最新の Web アプリを取ってきて控えを新しくする（変わっていないファイルは ETag で取り直さない）
pub fn update(base_url: &str, dir: &Path) -> Result<Outcome> {
    let base = if base_url.ends_with('/') {
        base_url.to_string()
    } else {
        format!("{base_url}/")
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15)))
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
        if f.starts_with('/') || f.split('/').any(|p| p == ".." || p.is_empty()) {
            bail!("web.json のファイル名が正しくありません: {f}");
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
        match body {
            Some(b) => {
                std::fs::write(&dest, b)?;
                changed += 1;
            }
            None => {
                std::fs::copy(&old, &dest)?;
            }
        }
        if let Some(e) = etag.or_else(|| known.cloned()) {
            etags.insert(f.clone(), e);
        }
    }
    std::fs::write(staging.join("web.json"), &manifest_bytes)?;
    std::fs::write(staging.join(ETAGS), serde_json::to_string(&etags)?)?;
    let same_manifest = std::fs::read(dir.join("web.json"))
        .map(|b| b == manifest_bytes)
        .unwrap_or(false);
    if changed == 0 && same_manifest {
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
