#!/usr/bin/env bash
# ビルドした実行ファイル（<binaries>/<target>/komenagare[.exe]）を配布物にまとめる。
#
#   bash .github/package.sh <binaries> <out>
#
# <out>/komenagare-<target>.tar.gz（Windows は .zip）と、それぞれの .sha256、全部の SHA256SUMS を作る。
# 中身は komenagare（.exe）・LICENSE・README.md をフォルダなしで入れる
# （install.sh・install.ps1・komenagare update がこの形を前提にしている）。
set -euo pipefail
bins="$1"
out="$2"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
for dir in "$bins"/*/; do
  dir="${dir%/}"
  target="$(basename "$dir")"
  name="komenagare-$target"
  pkg="$(mktemp -d)"
  cp LICENSE README.md "$pkg/"
  if [ -f "$dir/komenagare.exe" ]; then
    cp "$dir/komenagare.exe" "$pkg/"
    (cd "$pkg" && zip -q "$out/$name.zip" komenagare.exe LICENSE README.md)
    file="$name.zip"
  elif [ -f "$dir/komenagare" ]; then
    # （アーティファクトを通すと実行の権限が落ちる）
    install -m 755 "$dir/komenagare" "$pkg/komenagare"
    tar -czf "$out/$name.tar.gz" -C "$pkg" komenagare LICENSE README.md
    file="$name.tar.gz"
  else
    echo "$dir に komenagare がありません" >&2
    exit 1
  fi
  rm -rf "$pkg"
  (cd "$out" && sha256sum "$file" > "$file.sha256")
done
(cd "$out" && cat ./*.sha256 > SHA256SUMS)
