# komenagare

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツール。GitHub Pages（`https://igarinpiano.github.io/komenagare/`）で公開する。

## 構成

- `index.html` — 画面のマークアップとヘルプ
- `css/komenagare.css` — スタイル
- `js/vim-engine.js` — Vim エンジン（DOM 非依存。グローバル `createVimEngine`、Node からも `require` できる）
- `js/comment-store.js` — コメントの保管と変更（DOM 非依存）。UUID v7、変更セット、3-way マージによる衝突の検出、打ち消し（元に戻す）
- `js/comment-render.js` — コメント描画の定数と描画処理（画面・書き出し・ワーカーで共通）
- `js/export-core.js` — 高速書き出し（WebCodecs + Mediabunny）の本体。ワーカーとメインスレッドで共通
- `js/export-worker.js` — 高速書き出し用 Web Worker
- `js/app.js` — アプリ本体（1つの IIFE。上のファイルのグローバルを使う）
- `lib/` — 同梱ライブラリ（Mediabunny、MPL-2.0。classic スクリプト版でグローバル `Mediabunny`）
- `Cargo.toml` — CLI の workspace（cross がリポジトリの直下をコンテナに入れるよう、ここに置く。`Cargo.lock` と `target/` もここ）
- `cli/` — `komenagare` コマンド（Rust）。Web アプリを内蔵して配信し、WebSocket で変更を受け渡す
  - `build.rs` — 配布物の種類（ターゲット）を埋め込む（`komenagare update` が同じ種類を取る）
  - `store.rs` — `js/comment-store.js` と同じ規則の変更セット適用（両方を同じに保つこと）
  - `workspace.rs` — 作業フォルダ（`komenagare init` で作る。`.komenagare/id` があるものだけを `komenagare` で開く）、`comments.jsonl`（1行1コメント）、`.komenagare/`（作業用の記録。git には入れない）、git へのコミット
  - `server.rs` — 配信（`index.html` に `<meta name="komenagare-host">` を差し込む）、HTTP の API、WebSocket の取り決め（ファイル冒頭に記載）。1つのホストで複数のプロジェクト（作業フォルダ）を共有する（`/ws?p=<作業フォルダの id>`）
  - `auth.rs` — 参加者ごとのワンタイムパスワード（`--otp`、`komenagare otp`）。1件1ファイルで置き、動いているホストと `komenagare otp` が同時に書いても壊れないようにする
  - `render.rs` — `komenagare render`。`js/app.js` の `relayout` と同じ規則で配置して ASS 字幕にし、ffmpeg（libass）で焼き込む（`relayout` やコメントの定数を変えたらこちらも合わせる）
  - `files.rs` — コメントファイル（JSON / JSONL / CSV）の読み込み
  - `tunnel.rs` — `--tunnel`（cloudflared / tailscale / ngrok を子プロセスで起動し、出力から公開 URL を読む）と `--public-url`。公開 URL は共有・招待のリンクに使い、ページには `<meta>` の `data-public-url` で渡す
  - `firewall.rs` — macOS のファイアウォールの検出と許可（LAN で待ち受けたら自分の LAN のアドレスにつないでみて、切られたら許可するコマンドを y/N で実行する。socketfilterfw の出力の文言には頼らない）
  - `web.rs` — 配信する Web アプリの用意（GitHub Pages から最新版を取って ~/.cache/komenagare/web（Windows は %LOCALAPPDATA%\komenagare\web）に控える。取れなければ前回の控えか内蔵版）
  - `update.rs` — `komenagare update`（GitHub のリリースから配布物を取って、チェックサムを確かめて実行ファイルを置き換える）と、起動時の新しい版のお知らせ。配布物の名前は `.github/package.sh` と合わせる
- `web.json` — CLI が取ってくる Web アプリのファイル一覧と、ホストとのやりとりの取り決めの版数（protocol）
- `install.sh` — `curl … | sh` 用のインストーラー（Linux / macOS / Android / BSD など。OS と CPU から配布物を選ぶ。ターゲットを足したらここも合わせる）
- `install.ps1` — `irm … | iex` 用のインストーラー（Windows。raw.githubusercontent.com から配る。UTF-8・BOM なしのまま保つ）
- `.github/workflows/` — CI（Node と Rust のテスト）、リリース（`release.yml`）、全ターゲットのビルド（`build-matrix.yml`。ターゲットの一覧はここだけ）と、その確認（`build-check.yml`。依存やビルドの設定を変えた PR で走る）
- `.github/package.sh` — ビルドした実行ファイルを配布物（`komenagare-<target>.tar.gz` / `.zip` と `.sha256`）にまとめる。LICENSE・NOTICE・THIRD-PARTY-LICENSES.html・README.md も入れる
- `LICENSE`（Apache-2.0。付録のひな形は原文のまま）・`NOTICE`（著作権と同梱物の表示）
- `about.toml` / `about.hbs` — 配布物に入れる依存クレートのライセンス一覧（`cargo about generate` で THIRD-PARTY-LICENSES.html を作る。release と build-check で生成し、許可していないライセンスの依存が入ると止まる）
- `CONTRIBUTING.md`・`CODE_OF_CONDUCT.md`・`SECURITY.md`

## 守ること

- ビルド手順なしで動かす。スクリプトは ES modules ではなく classic `<script>` にする（`file://` で直接開いても動かすため）。読み込み順は `index.html` の通り。
- `file://` ではワーカーが使えないので、書き出しはメインスレッドで行う（`fastExportInWorker()`）。
- localStorage のキー（`komenagare.settings` など）は変えない（保存済みデータを引き継ぐため）。
- コメントの追加・変更・削除は必ず `commitOps`（`js/app.js`）で変更セットとして行い、`state.comments` や各コメントを直接書き換えない（複数人編集で変更を送り合うため）。タイムラインのドラッグ中の一時的な見た目の変更だけは例外で、確定時に戻してから `commitOps` する。
- コメントの id は UUID v7。ファイル（JSON / CSV）に保存し、読み込み時に引き継ぐ。
- 共同編集（`state.collab`）中は、`commitOps` などで適用した変更を `collabSend` でホストへ送る。送信待ちは IndexedDB に控える。
  ホストで衝突した自分の変更は `collab.conflicts` に控え、衝突の解決画面（`#conflictDlg`）で選ばせる。
  「あとで」にした衝突はホストに預け（`conflict_add`。ホストは `.komenagare/conflicts.json` に残す）、全員の `collab.shared` に出して誰でも解決できるようにする。
- 1つのホストに複数のプロジェクトがあるときは、ページの `?p=` で選ぶ（`collabOpen` / `collabClose` でタブのまま切り替える。控えの IndexedDB はプロジェクトごと）。
  同じプロジェクトを複数のタブで開けるよう、衝突の控えはタブごと（`collab.owner`）に置き、閉じたタブの分は次に開いたタブが引き継ぐ。
- `--otp` のときは `collab.session`（localStorage の `komenagare.session`）で入り、名前はホストが決める。
- 再生位置・選択・タイムラインの表示範囲・カーソルは `presence` メッセージで配り合う（`presenceDirty` で送る。ホストは中継するだけで保存しない）。
  参加者一覧（`#peersDlg`）から「追いかける」と `followApply` で相手に合わせ、自分で操作したらやめる。
- 変更履歴は、ひとりのときは `state.changeLog`（`recordChange`）、共同編集のときはホストの記録（`history` メッセージ）を出す。
- `css/`・`js/`・`lib/` にファイルを足したら `web.json` の files にも足す（`cargo test` が確かめる）。
- WebSocket のやりとり（メッセージの形や意味）を変えるときは、取り決めの版数を上げる: `web.json` の protocol、`js/app.js` の `COLLAB_PROTOCOL`、`cli/src/server.rs` の `PROTOCOL` をそろえて上げ、CLI もリリースする。
  版数を変えない変更（画面の改善など）は Web 版（GitHub Pages）を更新するだけで、ホストしている CLI にも次の起動から届く。
- UI の文言・コメントは日本語。
- ソースファイル（`js/`・`css/`・`cli/` の .rs・`tests/`・`index.html`・インストーラー）の冒頭には `SPDX-FileCopyrightText: 2026 Igarin` と `SPDX-License-Identifier: Apache-2.0` の2行を置く。新しいファイルにも入れる。
- ほかのプロジェクトのコードやライブラリを取り込んだら、`NOTICE` と README の「ライセンス」に追記する。

## テスト

- `node --test 'tests/*.test.js'` — Vim エンジンとコメントストアのテスト
- `cargo test --manifest-path cli/Cargo.toml` — CLI のテスト（`cargo fmt` も通す）。CI は Windows でも動かし、install.ps1 と komenagare update を手元のミラーで確かめる
- 共同編集は、CLI を `--web .` 付きで起動し、Playwright で2つのブラウザをつないで確かめる（複数プロジェクト・複数タブ・`--otp` も）
- 画面と書き出しは Chromium（Playwright）で、http 配信（`npx http-server -p 8124 -s -c-1 .`）と `file://` の両方で確かめる

## リリース

`cli/Cargo.toml` の version を上げて main に入れ、Release ワークフロー（`.github/workflows/release.yml`）を main で手動実行する
（Actions の画面、または GitHub API の workflow_dispatch）。ワークフローが同じ番号のタグ（`v0.1.2` など）を作り、
`build-matrix.yml` の全ターゲット（macOS・Windows・Linux の各 CPU、Android、FreeBSD / NetBSD / illumos）向けにビルドしてリリースに載せる。
1つでもビルドできなければ公開しない。ターゲットを足すときは build-check で先に確かめる。
タグを自分で push しても同じように動く。途中で失敗したら、同じ main のまま手動実行し直せば続きから作る。
利用者は `komenagare update` で更新する。
