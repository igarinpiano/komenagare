#!/bin/sh
# SPDX-FileCopyrightText: 2026 Igarin
# SPDX-License-Identifier: Apache-2.0
# 署名のテストに使うファイルを作り直す（cli/src/sign.rs・web.rs・update.rs のテストが使う）。
# ここの鍵（test.key）はテスト専用。配る komenagare は cli/minisign.pub の鍵しか信じない。
# 取り決めの版数（protocol）を上げたら、PROTOCOL を合わせてこれを動かす。
# 使い方（リポジトリの直下で）: sh tests/fixtures/sign/make.sh
set -eu
d=tests/fixtures/sign
PROTOCOL=8
py() { python3 .github/minisign.py "$@"; }
if [ ! -f "$d/test.key" ]; then py keygen "$d/test.key" "$d/test.pub"; fi
if [ ! -f "$d/other.pub" ]; then py keygen "$d/other.key" "$d/other.pub" && rm "$d/other.key"; fi
export MINISIGN_SECRET_KEY="$(cat "$d/test.key")"

# リリース
printf '%s  komenagare-x86_64-unknown-linux-gnu.tar.gz\n%s  komenagare-x86_64-pc-windows-msvc.zip\n' \
  "$(printf a | sha256sum | cut -d' ' -f1)" "$(printf b | sha256sum | cut -d' ' -f1)" > "$d/SHA256SUMS"
py sign "$d/SHA256SUMS" "komenagare-release tag:v9.9.9"

# Web アプリ（index.html と js/app.js だけの小さなもの）
w="$d/web"
rm -rf "$w" && mkdir -p "$w/js"
printf '<!doctype html><title>t</title>\n' > "$w/index.html"
printf 'console.log(1);\n' > "$w/js/app.js"
printf '{"protocol":%s,"files":["index.html","js/app.js"]}\n' "$PROTOCOL" > "$w/web.json"
py web-sums "$w"
py sign "$w/web.sums" "komenagare-web protocol:$PROTOCOL time:1600000000"
mv "$w/web.sums.minisig" "$d/web.sums.minisig.older"
py sign "$w/web.sums" "komenagare-web protocol:$PROTOCOL time:1700000000"
