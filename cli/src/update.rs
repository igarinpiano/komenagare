// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
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

fn agent(timeout: u64, base: &str) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        // https で始めたら、転送で http に落ちても取らない（http のミラー・テストはそのまま使える）
        .https_only(base.starts_with("https://"))
        // 接続を使い回さない（取るのは 3 つだけ）。HTTP/1.0 で答えて接続を閉じるサーバー（ミラーや
        // プロキシ）だと、閉じられた接続を使い回して「Peer disconnected」で失敗することがあるため
        .max_idle_connections(0)
        .build()
        .into()
}

/// 最新のリリースのタグ（v0.1.1 など）
pub fn latest_tag(base: &str, timeout: u64) -> Result<String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .https_only(base.starts_with("https://"))
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

/// 配布物を取ってきて、署名した SHA256SUMS と照らし合わせる
fn download(base: &str, tag: &str, asset: &str) -> Result<Vec<u8>> {
    let key = crate::sign::trusted_key()?;
    let agent = agent(300, base);
    let dir = format!("{base}/download/{tag}");
    let not_found = |e: anyhow::Error, what: &str| {
        if matches!(
            e.downcast_ref::<ureq::Error>(),
            Some(ureq::Error::StatusCode(404))
        ) {
            e.context(what.to_string())
        } else {
            e
        }
    };
    // 先に署名を確かめる（リリースのファイルが差し替えられても、署名の無いものは入れない）
    let unsigned = format!(
        "{tag} には署名（SHA256SUMS.minisig）がありません。署名の無い版は komenagare update では入れられません（install.sh / install.ps1 で入れてください）"
    );
    let sums = get(&agent, &format!("{dir}/SHA256SUMS")).map_err(|e| not_found(e, &unsigned))?;
    let sig =
        get(&agent, &format!("{dir}/SHA256SUMS.minisig")).map_err(|e| not_found(e, &unsigned))?;
    let expected = check_sums(&key, &sums, &sig, tag, asset)?;
    let url = format!("{dir}/{asset}");
    let body = get(&agent, &url).map_err(|e| {
        not_found(
            e,
            &format!("{tag} にはこの種類（{TARGET}）の配布物がありません。install.sh / install.ps1 で入れ直してください"),
        )
    })?;
    if expected != sha256_hex(&body) {
        bail!(
            "ダウンロードしたファイルが署名した内容と違います（チェックサムが一致しません）: {url}"
        );
    }
    Ok(body)
}

/// SHA256SUMS の署名（その版のものか）を確かめ、asset の SHA-256 を返す
fn check_sums(
    key: &minisign_verify::PublicKey,
    sums: &[u8],
    sig: &[u8],
    tag: &str,
    asset: &str,
) -> Result<String> {
    let comment = crate::sign::verify(key, sums, &String::from_utf8_lossy(sig))
        .with_context(|| format!("{tag} の署名を確かめられません"))?;
    // 別の版の署名（古い版の SHA256SUMS など）を混ぜられないよう、版も確かめる
    if comment != format!("komenagare-release tag:{tag}") {
        bail!("署名が {tag} のものではありません（{comment}）");
    }
    crate::sign::parse_sums(&String::from_utf8_lossy(sums))
        .remove(asset)
        .with_context(|| format!("{tag} の SHA256SUMS に {asset} がありません"))
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

    #[test]
    fn checks_signed_sums() {
        let key = crate::sign::tests::test_key();
        let sums = crate::sign::tests::fixture("SHA256SUMS");
        let sig = crate::sign::tests::fixture("SHA256SUMS.minisig");
        let a = "komenagare-x86_64-unknown-linux-gnu.tar.gz";
        // 署名が合えば、その配布物の SHA-256（中身は "a"）
        assert_eq!(
            check_sums(&key, &sums, &sig, "v9.9.9", a).unwrap(),
            sha256_hex(b"a")
        );
        // 別の版として渡された（古い版の SHA256SUMS を混ぜる）ら使わない
        assert!(check_sums(&key, &sums, &sig, "v9.9.8", a).is_err());
        // 一覧に無い配布物
        assert!(check_sums(&key, &sums, &sig, "v9.9.9", "komenagare-x.zip").is_err());
        // 一覧を書き換えたら署名が合わない
        let mut bad = sums.clone();
        bad[0] = if bad[0] == b'0' { b'1' } else { b'0' };
        assert!(check_sums(&key, &bad, &sig, "v9.9.9", a).is_err());
        // 別の鍵の署名
        let other =
            minisign_verify::PublicKey::decode(include_str!("../../tests/fixtures/sign/other.pub"))
                .unwrap();
        assert!(check_sums(&other, &sums, &sig, "v9.9.9", a).is_err());
    }

    #[test]
    fn agent_does_not_reuse_connections() {
        // 1つの接続で1回だけ答え、接続は閉じずに置いておくサーバー（使い回すと答えが来ない）
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let mut keep = vec![];
            for mut s in listener.incoming().flatten() {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let _ = s.write_all(b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok");
                keep.push(s);
            }
        });
        let base = format!("http://{addr}");
        let a = agent(3, &base);
        for _ in 0..3 {
            assert_eq!(get(&a, &format!("{base}/x")).unwrap(), b"ok");
        }
    }
}
