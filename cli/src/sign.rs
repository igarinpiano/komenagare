// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! リリースの配布物と Web アプリの署名（minisign）を確かめる。
//!
//! 署名は .github/minisign.py で作る。秘密鍵は GitHub の environment「signing」の secret にだけ置き、
//! 承認しないと使えないようにする（main に push できるだけでは署名できない）。
//!   リリース: SHA256SUMS に「komenagare-release tag:v1.2.3」の署名（SHA256SUMS.minisig）
//!   Web アプリ: web.sums（web.json と各ファイルの SHA-256）に「komenagare-web protocol:7 time:…」の署名
//! 公開鍵は cli/minisign.pub（CLI に埋め込む）。鍵を作り直したら書き換えて、CLI をリリースする。

use anyhow::{anyhow, Context, Result};
use minisign_verify::{PublicKey, Signature};

/// 署名を確かめる公開鍵（minisign の公開鍵のファイルの中身）
const PUBLIC_KEY: &str = include_str!("../minisign.pub");

/// 信頼する公開鍵
pub fn trusted_key() -> Result<PublicKey> {
    // デバッグビルドだけ: テスト用の鍵（base64 の行）をビルド時の環境変数で渡せる（CI で手元のミラーを
    // 確かめるため）。リリースのビルドでは使わないので、配る komenagare が信じる鍵は cli/minisign.pub だけ
    #[cfg(debug_assertions)]
    if let Some(k) = option_env!("KOMENAGARE_TEST_SIGN_PUBKEY") {
        return PublicKey::from_base64(k.trim())
            .map_err(|e| anyhow!("KOMENAGARE_TEST_SIGN_PUBKEY を読めません（{e}）"));
    }
    PublicKey::decode(PUBLIC_KEY)
        .ok()
        .context("署名を確かめる公開鍵がまだ入っていません（cli/minisign.pub）")
}

/// data の署名（.minisig の中身）を確かめ、信頼できるコメント（署名と一緒に守られている）を返す
pub fn verify(key: &PublicKey, data: &[u8], sig: &str) -> Result<String> {
    let sig = Signature::decode(sig).map_err(|e| anyhow!("署名の形式が違います（{e}）"))?;
    key.verify(data, &sig, false)
        .map_err(|e| anyhow!("署名が合いません（{e}）"))?;
    Ok(sig.trusted_comment().to_string())
}

/// 信頼できるコメント（「名前 a:1 b:2」の形）から値を取る
pub fn field<'a>(comment: &'a str, name: &str) -> Option<&'a str> {
    comment
        .split(' ')
        .find_map(|w| w.strip_prefix(name)?.strip_prefix(':'))
}

/// SHA-256 の一覧（sha256sum の形。「<16進> <名前>」）を読む
pub fn parse_sums(text: &str) -> std::collections::HashMap<String, String> {
    text.lines()
        .filter_map(|l| {
            let (hash, name) = l.trim_end().split_once(' ')?;
            let name = name.trim_start().trim_start_matches('*');
            (hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()) && !name.is_empty())
                .then(|| (name.to_string(), hash.to_ascii_lowercase()))
        })
        .collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// テスト用の鍵（tests/fixtures/sign/ の署名はこの鍵で作った。秘密鍵もテスト専用）
    pub(crate) fn test_key() -> PublicKey {
        PublicKey::decode(include_str!("../../tests/fixtures/sign/test.pub")).unwrap()
    }

    pub(crate) fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../tests/fixtures/sign")
                .join(name),
        )
        .unwrap()
    }

    #[test]
    fn verifies_signatures_made_by_the_signing_script() {
        let key = test_key();
        let data = fixture("SHA256SUMS");
        let sig = String::from_utf8(fixture("SHA256SUMS.minisig")).unwrap();
        assert_eq!(
            verify(&key, &data, &sig).unwrap(),
            "komenagare-release tag:v9.9.9"
        );
        // 中身が1バイトでも違えば通らない
        let mut bad = data.clone();
        bad[0] ^= 1;
        assert!(verify(&key, &bad, &sig).is_err());
        // 信頼できるコメントを書き換えても通らない
        let forged = sig.replace("tag:v9.9.9", "tag:v9.9.8");
        assert!(verify(&key, &data, &forged).is_err());
        // 別の鍵では通らない
        let other = PublicKey::decode(include_str!("../../tests/fixtures/sign/other.pub")).unwrap();
        assert!(verify(&other, &data, &sig).is_err());
    }

    #[test]
    fn placeholder_key_is_not_trusted() {
        // 公開鍵がまだ置かれていなければ、何も信じない（署名が無いのと同じに扱う）
        if !PUBLIC_KEY
            .lines()
            .nth(1)
            .is_some_and(|l| !l.trim().is_empty())
        {
            assert!(PublicKey::decode(PUBLIC_KEY).is_err());
        }
    }

    #[test]
    fn reads_fields_and_sums() {
        let c = "komenagare-web protocol:6 time:1700000000";
        assert_eq!(field(c, "protocol"), Some("6"));
        assert_eq!(field(c, "time"), Some("1700000000"));
        assert_eq!(field(c, "tag"), None);
        let h = "a".repeat(64);
        let s = parse_sums(&format!(
            "{h}  web.json\n{h} *js/app.js\nbad line\n{}  x\n",
            "z".repeat(64)
        ));
        assert_eq!(s.len(), 2);
        assert_eq!(s["js/app.js"], h);
    }
}
