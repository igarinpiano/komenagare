#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Igarin
# SPDX-License-Identifier: Apache-2.0
# ビルドした実行ファイル（<binaries>/<target>/komenagare[.exe]）を配布物にまとめる。
#
#   bash .github/package.sh <binaries> <out>
#
# <out>/komenagare-<target>.tar.gz（Windows は .zip）と、それぞれの .sha256、全部の SHA256SUMS を作る。
# 中身は komenagare（.exe）・LICENSE・NOTICE・THIRD-PARTY-LICENSES.html・README.md をフォルダなしで入れる
# （install.sh・install.ps1・komenagare update がこの形を前提にしている）。
# THIRD-PARTY-LICENSES.html（依存のクレートのライセンス）は先に cargo about generate で作っておく。
set -euo pipefail
bins="$1"
out="$2"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
docs=(LICENSE NOTICE THIRD-PARTY-LICENSES.html README.md)
for f in "${docs[@]}"; do
  [ -f "$f" ] || { echo "$f がありません（THIRD-PARTY-LICENSES.html は cargo about generate で作る）" >&2; exit 1; }
done
for dir in "$bins"/*/; do
  dir="${dir%/}"
  target="$(basename "$dir")"
  name="komenagare-$target"
  pkg="$(mktemp -d)"
  cp "${docs[@]}" "$pkg/"
  if [ -f "$dir/komenagare.exe" ]; then
    cp "$dir/komenagare.exe" "$pkg/"
    (cd "$pkg" && zip -q "$out/$name.zip" komenagare.exe "${docs[@]}")
    file="$name.zip"
  elif [ -f "$dir/komenagare" ]; then
    # （アーティファクトを通すと実行の権限が落ちる）
    install -m 755 "$dir/komenagare" "$pkg/komenagare"
    tar -czf "$out/$name.tar.gz" -C "$pkg" komenagare "${docs[@]}"
    file="$name.tar.gz"
  else
    echo "$dir に komenagare がありません" >&2
    exit 1
  fi
  rm -rf "$pkg"
  (cd "$out" && sha256sum "$file" > "$file.sha256")
done
(cd "$out" && cat ./*.sha256 > SHA256SUMS)
