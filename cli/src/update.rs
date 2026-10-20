//! komenagare 自身の更新（komenagare update）。
//!
//! GitHub のリリースから、この OS・CPU 向けの配布物（install.sh / install.ps1 が入れるのと同じもの）を
//! 取ってきてチェックサムを確かめ、実行中の komenagare を置き換える。
//! 最新の版は /releases/latest の転送先（…/releases/tag/v0.1.1）から読む（GitHub API の回数制限を避けるため）。

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const RELEASES_URL: &str = "https://github.com/igarinpiano/komenagare/releases";
const CURRENT: &str = env!("CARGO_PKG_VERSION");

/// リリースの置き場所（環境変数 KOMENAGARE_RELEASES_URL で変えられる。ミラーやテスト用）
pub fn releases_url() -> String {
    std::env::var("KOMENAGARE_RELEASES_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| RELEASES_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// この komenagare の配布物の種類（x86_64-unknown-linux-musl など。cli/build.rs が埋め込む）
pub const TARGET: &str = env!("KOMENAGARE_TARGET");

/// この komenagare と同じ種類の配布物の名前（.github/workflows/release.yml でまとめるときと同じ）
pub fn asset_name() -> String {
    let ext = if TARGET.contains("windows") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("komenagare-{TARGET}.{ext}")
}

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .build()
        .into()
}

/// 最新のリリースのタグ（v0.1.1 など）
pub fn latest_tag(base: &str, timeout: u64) -> Result<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .max_redirects(0)
        .build()
        .into();
    let url = format!("{base}/latest");
    let resp = agent
        .get(&url)
        .call()
        .with_context(|| format!("{url} を取得できません"))?;
    let location = resp
        .headers()
        .get("location")
        .and_then(|v| v.to_str().ok())
        .context("最新のリリースが見つかりません")?;
    tag_from_location(location).context("最新のリリースが見つかりません")
}

fn tag_from_location(location: &str) -> Option<String> {
    let tag = location.split(['?', '#']).next()?.rsplit_once("/tag/")?.1;
    parse_version(tag).map(|_| tag.to_string())
}

/// v0.1.1 / 0.1.1 を (0, 1, 1) にする（-rc.1 などは無視する）
pub fn parse_version(s: &str) -> Option<(u64, u64, u64)> {
    let s = s.trim().trim_start_matches('v');
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.').map(|p| p.parse::<u64>().ok());
    let v = (it.next()??, it.next()??, it.next()??);
    it.next().is_none().then_some(v)
}

fn is_newer(tag: &str) -> bool {
    match (parse_version(tag), parse_version(CURRENT)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

/// 起動時のお知らせ用：新しい版があればそのタグ（確かめられなければ None）
pub fn check_newer() -> Option<String> {
    let tag = latest_tag(&releases_url(), 5).ok()?;
    is_newer(&tag).then_some(tag)
}

/// komenagare update
pub fn run(version: Option<&str>, check_only: bool) -> Result<()> {
    let base = releases_url();
    let tag = match version {
        Some(v) => {
            parse_version(v)
                .with_context(|| format!("バージョン「{v}」を読めません（例 v0.1.1）"))?;
            format!("v{}", v.trim().trim_start_matches('v'))
        }
        None => latest_tag(&base, 30)?,
    };
    if check_only {
        if is_newer(&tag) {
            println!(
                "新しい版があります: {tag}（今は v{CURRENT}）。komenagare update で更新できます"
            );
        } else {
            println!("komenagare v{CURRENT} は最新です（最新のリリース: {tag}）");
        }
        return Ok(());
    }
    if version.is_none() && !is_newer(&tag) {
        println!("komenagare v{CURRENT} は最新です（最新のリリース: {tag}）");
        return Ok(());
    }
    let asset = asset_name();
    println!("komenagare v{CURRENT} → {tag} に更新しています…");
    let archive = download(&base, &tag, &asset)?;
    let bin = extract(&archive)?;
    let exe = replace_exe(&bin, &tag)?;
    println!("更新しました: {}（{tag}）", exe.display());
    Ok(())
}

/// 配布物を取ってきて、.sha256 と照らし合わせる
fn download(base: &str, tag: &str, asset: &str) -> Result<Vec<u8>> {
    let agent = agent(300);
    let url = format!("{base}/download/{tag}/{asset}");
    let body = get(&agent, &url).map_err(|e| {
        if matches!(
            e.downcast_ref::<ureq::Error>(),
            Some(ureq::Error::StatusCode(404))
        ) {
            e.context(format!(
                "{tag} にはこの種類（{TARGET}）の配布物がありません。install.sh / install.ps1 で入れ直してください"
            ))
        } else {
            e
        }
    })?;
    let sums = get(&agent, &format!("{url}.sha256"))?;
    let expected = String::from_utf8_lossy(&sums)
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if expected != sha256_hex(&body) {
        bail!("ダウンロードしたファイルが壊れています（チェックサムが一致しません）: {url}");
    }
    Ok(body)
}

fn get(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>> {
    let mut resp = agent
        .get(url)
        .call()
        .with_context(|| format!("{url} を取得できません"))?;
    let mut body = vec![];
    resp.body_mut()
        .as_reader()
        .take(256 << 20)
        .read_to_end(&mut body)?;
    Ok(body)
}

fn sha256_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// 配布物から実行ファイルを取り出す
#[cfg(not(windows))]
fn extract(archive: &[u8]) -> Result<Vec<u8>> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(archive));
    for entry in tar.entries().context("配布物を展開できません")? {
        let mut entry = entry?;
        if entry.path()?.file_name().is_some_and(|n| n == "komenagare") {
            let mut bin = vec![];
            entry.read_to_end(&mut bin)?;
            return Ok(bin);
        }
    }
    bail!("配布物に komenagare が入っていません")
}

#[cfg(windows)]
fn extract(archive: &[u8]) -> Result<Vec<u8>> {
    let mut zip =
        zip::ZipArchive::new(std::io::Cursor::new(archive)).context("配布物を展開できません")?;
    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let name = file.name()?.replace('\\', "/");
        if name.rsplit('/').next() == Some("komenagare.exe") {
            let mut bin = vec![];
            file.read_to_end(&mut bin)?;
            return Ok(bin);
        }
    }
    bail!("配布物に komenagare.exe が入っていません")
}

/// Windows で置き換えた古い実行ファイル（実行中は消せないので、次に起動したときに消す）
fn old_path(exe: &Path) -> PathBuf {
    let mut name = exe.file_name().unwrap_or_default().to_os_string();
    name.push(".old");
    exe.with_file_name(name)
}

/// 前回の更新で残った古い実行ファイルを消す
pub fn cleanup() {
    if cfg!(windows) {
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::fs::remove_file(old_path(&exe));
        }
    }
}

/// 実行中の komenagare を置き換える。新しいものが動くことを確かめてから入れ替える
fn replace_exe(bin: &[u8], tag: &str) -> Result<PathBuf> {
    let mut exe = std::env::current_exe().context("実行中の komenagare の場所が分かりません")?;
    if !cfg!(windows) {
        // シンボリックリンクなら実体を置き換える
        exe = exe.canonicalize()?;
    }
    let dir = exe
        .parent()
        .context("実行中の komenagare の場所が分かりません")?;
    let tmp = dir.join(format!(
        ".komenagare-update{}",
        std::env::consts::EXE_SUFFIX
    ));
    let denied = |e: std::io::Error| {
        let hint = if e.kind() == std::io::ErrorKind::PermissionDenied {
            "（書き込む権限がありません。インストールした場所に合った権限で実行するか、インストールし直してください）"
        } else {
            ""
        };
        anyhow::anyhow!("{} に書き込めません{hint}: {e}", dir.display())
    };
    std::fs::write(&tmp, bin).map_err(denied)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    let out = std::process::Command::new(&tmp)
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let want = tag.trim_start_matches('v');
    let problem = match &out {
        None => Some(format!(
            "取ってきた komenagare（{tag}）をこの環境で実行できませんでした"
        )),
        Some(v) if !v.split_whitespace().any(|w| w == want) => Some(format!(
            "取ってきた komenagare の版が {tag} ではありません（{v}）"
        )),
        _ => None,
    };
    if let Some(p) = problem {
        let _ = std::fs::remove_file(&tmp);
        bail!("{p}");
    }
    if cfg!(windows) {
        // 実行中のファイルは上書きできないが、名前は変えられる
        let old = old_path(&exe);
        let _ = std::fs::remove_file(&old);
        std::fs::rename(&exe, &old).map_err(denied)?;
        if let Err(e) = std::fs::rename(&tmp, &exe) {
            let _ = std::fs::rename(&old, &exe);
            let _ = std::fs::remove_file(&tmp);
            return Err(denied(e));
        }
    } else if let Err(e) = std::fs::rename(&tmp, &exe) {
        let _ = std::fs::remove_file(&tmp);
        return Err(denied(e));
    }
    Ok(exe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("v0.1.1"), Some((0, 1, 1)));
        assert_eq!(parse_version("1.20.3-rc.1"), Some((1, 20, 3)));
        assert_eq!(parse_version("v1.2"), None);
        assert_eq!(parse_version("latest"), None);
        assert!(is_newer("v999.0.0"));
        assert!(!is_newer(&format!("v{CURRENT}")));
        assert!(!is_newer("v0.0.1"));
        assert_eq!(
            tag_from_location("https://github.com/igarinpiano/komenagare/releases/tag/v0.1.1")
                .as_deref(),
            Some("v0.1.1")
        );
        assert_eq!(
            tag_from_location("https://github.com/igarinpiano/komenagare/releases"),
            None
        );
    }

    #[test]
    fn asset_for_this_platform() {
        let name = asset_name();
        assert!(!TARGET.is_empty());
        assert!(name.starts_with(&format!("komenagare-{TARGET}.")));
        assert_eq!(name.ends_with(".zip"), cfg!(windows));
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
