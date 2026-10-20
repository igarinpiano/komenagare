#!/bin/sh
# komenagare（コメナガレのホスト）をインストールする
#
#   curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh
#
# 環境変数
#   KOMENAGARE_VERSION      入れるバージョン（例: v0.1.2。既定は最新）
#   KOMENAGARE_INSTALL_DIR  入れる場所（既定は ~/.local/bin）
#   KOMENAGARE_TARGET       配布物の種類（例: x86_64-unknown-linux-gnu、universal-apple-darwin。既定は自動で選ぶ）
#   KOMENAGARE_DOWNLOAD_URL ダウンロード元（既定は GitHub のリリース。ミラーやテスト用）
set -eu

REPO="igarinpiano/komenagare"
VERSION="${KOMENAGARE_VERSION:-latest}"
INSTALL_DIR="${KOMENAGARE_INSTALL_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'エラー: %s\n' "$*" >&2; exit 1; }

# この OS・CPU 向けの配布物の種類（.github/workflows/build-matrix.yml のターゲット）
detect_target() {
  sys="$(uname -s)"
  cpu="$(uname -m)"
  case "$sys" in
    Darwin)
      # Rosetta で動いているシェルでも、Apple シリコンなら arm64 版を入れる
      if [ "$cpu" = x86_64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then cpu=arm64; fi
      case "$cpu" in
        arm64 | aarch64) echo aarch64-apple-darwin ;;
        x86_64) echo x86_64-apple-darwin ;;
        *) return 1 ;;
      esac ;;
    Linux)
      if [ "$(uname -o 2>/dev/null || true)" = Android ]; then
        case "$cpu" in
          aarch64 | arm64) echo aarch64-linux-android ;;
          armv7* | armv8l) echo armv7-linux-androideabi ;;
          x86_64) echo x86_64-linux-android ;;
          i?86) echo i686-linux-android ;;
          *) return 1 ;;
        esac
        return 0
      fi
      # musl で静的にリンクした版があるものはそれを使う（どのディストリビューションでも動く）
      case "$cpu" in
        x86_64 | amd64) echo x86_64-unknown-linux-musl ;;
        aarch64 | arm64) echo aarch64-unknown-linux-musl ;;
        i?86 | x86) echo i686-unknown-linux-musl ;;
        armv7* | armv8l) echo armv7-unknown-linux-musleabihf ;;
        armv6*) echo arm-unknown-linux-musleabihf ;;
        riscv64) echo riscv64gc-unknown-linux-gnu ;;
        ppc64le) echo powerpc64le-unknown-linux-gnu ;;
        s390x) echo s390x-unknown-linux-gnu ;;
        loongarch64) echo loongarch64-unknown-linux-gnu ;;
        *) return 1 ;;
      esac ;;
    FreeBSD) case "$cpu" in amd64 | x86_64) echo x86_64-unknown-freebsd ;; *) return 1 ;; esac ;;
    NetBSD) case "$cpu" in amd64 | x86_64) echo x86_64-unknown-netbsd ;; *) return 1 ;; esac ;;
    SunOS)
      case "$(isainfo -k 2>/dev/null || echo "$cpu")" in amd64 | x86_64) echo x86_64-unknown-illumos ;; *) return 1 ;; esac ;;
    MINGW* | MSYS* | CYGWIN*)
      fail "Windows では PowerShell で次を実行してください: irm https://raw.githubusercontent.com/${REPO}/main/install.ps1 | iex" ;;
    *) return 1 ;;
  esac
}

target="${KOMENAGARE_TARGET:-}"
if [ -z "$target" ]; then
  target="$(detect_target)" || fail "この OS・CPU（$(uname -s) $(uname -m)）向けの配布物はありません。https://github.com/${REPO}/releases で一覧を見られます"
fi
asset="komenagare-${target}.tar.gz"
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

say "komenagare（${VERSION}・${target}）をダウンロードしています…"
fetch "${base}/${asset}" "${tmp}/${asset}" || fail "ダウンロードできませんでした: ${base}/${asset}"
fetch "${base}/${asset}.sha256" "${tmp}/${asset}.sha256" || fail "チェックサムをダウンロードできませんでした"

expected="$(cut -d ' ' -f 1 < "${tmp}/${asset}.sha256")"
f="${tmp}/${asset}"
if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$f" | cut -d ' ' -f 1)"
elif command -v shasum >/dev/null 2>&1; then actual="$(shasum -a 256 "$f" | cut -d ' ' -f 1)"
elif command -v sha256 >/dev/null 2>&1; then actual="$(sha256 -q "$f" 2>/dev/null || sha256 -n "$f" | cut -d ' ' -f 1)"
elif command -v digest >/dev/null 2>&1; then actual="$(digest -a sha256 "$f")"
elif command -v openssl >/dev/null 2>&1; then actual="$(openssl dgst -sha256 -r "$f" | cut -d ' ' -f 1)"
else fail "sha256sum・shasum・sha256・digest・openssl のどれかが必要です"; fi
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
say "使い方: 作業用のフォルダで komenagare init を実行してから komenagare で始め、表示された URL をブラウザで開きます（komenagare --help で一覧）"
say "更新: komenagare update"
