// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// 配布物の種類（リリースのファイル名の komenagare-<ここ>.tar.gz）を埋め込む。komenagare update が同じものを取る。
// ふつうはビルド先のターゲットで、macOS の universal 版はビルド時に KOMENAGARE_TARGET で指定する
fn main() {
    let target = std::env::var("KOMENAGARE_TARGET")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::var("TARGET").unwrap());
    println!("cargo:rustc-env=KOMENAGARE_TARGET={target}");
    println!("cargo:rerun-if-env-changed=KOMENAGARE_TARGET");
}
