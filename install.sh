#!/bin/sh
# komenagare（コメナガレのホスト）をインストールする
#
#   curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh
#
# 環境変数
#   KOMENAGARE_VERSION      入れるバージョン（例: v0.1.0。既定は最新）
#   KOMENAGARE_INSTALL_DIR  入れる場所（既定は ~/.local/bin）
#   KOMENAGARE_DOWNLOAD_URL ダウンロード元（既定は GitHub のリリース。ミラーやテスト用）
set -eu

REPO="igarinpiano/komenagare"
VERSION="${KOMENAGARE_VERSION:-latest}"
INSTALL_DIR="${KOMENAGARE_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os="unknown-linux-musl" ;;
  Darwin) os="apple-darwin" ;;
  MINGW* | MSYS* | CYGWIN*) fail "Windows では PowerShell で次を実行してください: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" ;;
  *) fail "この OS（$(uname -s)）には未対応です。Linux か macOS で実行してください" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) fail "この CPU（$(uname -m)）には未対応です" ;;
esac
asset="komenagare-${arch}-${os}.tar.gz"
if [ -n "${KOMENAGARE_DOWNLOAD_URL:-}" ]; then
  base="$KOMENAGARE_DOWNLOAD_URL"
elif [ "$VERSION" = "latest" ]; then
  base="https://github.com/${REPO}/releases/latest/download"
else
  base="https://github.com/${REPO}/releases/download/${VERSION}"
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "curl か wget が必要です"; fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "komenagare（${VERSION}・${arch}-${os}）をダウンロードしています…"
fetch "${base}/${asset}" "${tmp}/${asset}" || fail "ダウンロードできませんでした: ${base}/${asset}"
fetch "${base}/${asset}.sha256" "${tmp}/${asset}.sha256" || fail "チェックサムをダウンロードできませんでした"

expected="$(cut -d ' ' -f 1 < "${tmp}/${asset}.sha256")"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "${tmp}/${asset}" | cut -d ' ' -f 1)"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "${tmp}/${asset}" | cut -d ' ' -f 1)"
else fail "sha256sum か shasum が必要です"; fi
[ "$expected" = "$actual" ] || fail "ダウンロードしたファイルが壊れています（チェックサムが一致しません）"

tar -xzf "${tmp}/${asset}" -C "$tmp"
mkdir -p "$INSTALL_DIR"
install -m 755 "${tmp}/komenagare" "${INSTALL_DIR}/komenagare" 2>/dev/null \
  || { cp "${tmp}/komenagare" "${INSTALL_DIR}/komenagare" && chmod 755 "${INSTALL_DIR}/komenagare"; }
say "インストールしました: ${INSTALL_DIR}/komenagare（$("${INSTALL_DIR}/komenagare" --version)）"

if ! command -v git >/dev/null 2>&1; then
  say ""
  say "注意: git が見つかりません。git がないと変更の履歴は残りません。"
  say "      https://git-scm.com/downloads からインストールしてください。"
fi
case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    say ""
    say "${INSTALL_DIR} が PATH に入っていません。シェルの設定ファイル（~/.zshrc や ~/.bashrc）に次の行を足してください:"
    say "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac
say ""
say "使い方: 作業用のフォルダで komenagare を実行し、表示された URL をブラウザで開きます（komenagare --help で一覧）"
say "更新: komenagare update"
