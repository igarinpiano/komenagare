#!/bin/sh
# SPDX-FileCopyrightText: 2026 Igarin
# SPDX-License-Identifier: Apache-2.0
# Cross.toml に書くイメージの digest を調べる（ghcr.io に問い合わせるだけ。何も書き換えない）。
# 使い方: sh .github/cross-digests.sh <target> <tag>   例: sh .github/cross-digests.sh x86_64-unknown-netbsd main
set -eu
t="$1"; tag="$2"
token="$(curl -fsS "https://ghcr.io/token?scope=repository:cross-rs/$t:pull" | sed -E 's/.*"token":"([^"]+)".*/\1/')"
curl -fsSI -H "Authorization: Bearer $token" \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json' \
  "https://ghcr.io/v2/cross-rs/$t/manifests/$tag" | tr -d '\r' | sed -n 's/^docker-content-digest: //Ip'
