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
- `cli/` — `komenagare` コマンド（Rust）。Web アプリを内蔵して配信し、WebSocket で変更を受け渡す
  - `store.rs` — `js/comment-store.js` と同じ規則の変更セット適用（両方を同じに保つこと）
  - `workspace.rs` — `comments.jsonl`（1行1コメント）、`.komenagare/`（作業用の記録。git には入れない）、git へのコミット
  - `server.rs` — 配信（`index.html` に `<meta name="komenagare-host">` を差し込む）と WebSocket の取り決め（ファイル冒頭に記載）
  - `web.rs` — 配信する Web アプリの用意（GitHub Pages から最新版を取って ~/.cache/komenagare/web に控える。取れなければ前回の控えか内蔵版）
- `web.json` — CLI が取ってくる Web アプリのファイル一覧と、ホストとのやりとりの取り決めの版数（protocol）
- `install.sh` — `curl … | sh` 用のインストーラー（GitHub リリースから取る）
- `.github/workflows/` — CI（Node と Rust のテスト）と、タグ `vX.Y.Z` でのリリース

## 守ること

- ビルド手順なしで動かす。スクリプトは ES modules ではなく classic `<script>` にする（`file://` で直接開いても動かすため）。読み込み順は `index.html` の通り。
- `file://` ではワーカーが使えないので、書き出しはメインスレッドで行う（`fastExportInWorker()`）。
- localStorage のキー（`komenagare.settings` など）は変えない（保存済みデータを引き継ぐため）。
- コメントの追加・変更・削除は必ず `commitOps`（`js/app.js`）で変更セットとして行い、`state.comments` や各コメントを直接書き換えない（複数人編集で変更を送り合うため）。タイムラインのドラッグ中の一時的な見た目の変更だけは例外で、確定時に戻してから `commitOps` する。
- コメントの id は UUID v7。ファイル（JSON / CSV）に保存し、読み込み時に引き継ぐ。
- 共同編集（`state.collab`）中は、`commitOps` などで適用した変更を `collabSend` でホストへ送る。送信待ちは IndexedDB に控える。
- `css/`・`js/`・`lib/` にファイルを足したら `web.json` の files にも足す（`cargo test` が確かめる）。
- WebSocket のやりとり（メッセージの形や意味）を変えるときは、取り決めの版数を上げる: `web.json` の protocol、`js/app.js` の `COLLAB_PROTOCOL`、`cli/src/server.rs` の `PROTOCOL` をそろえて上げ、CLI もリリースする。
  版数を変えない変更（画面の改善など）は Web 版（GitHub Pages）を更新するだけで、ホストしている CLI にも次の起動から届く。
- UI の文言・コメントは日本語。

## テスト

- `node --test 'tests/*.test.js'` — Vim エンジンとコメントストアのテスト
- `cargo test --manifest-path cli/Cargo.toml` — CLI のテスト（`cargo fmt` も通す）
- 共同編集は、CLI を `--web .` 付きで起動し、Playwright で2つのブラウザをつないで確かめる
- 画面と書き出しは Chromium（Playwright）で、http 配信（`npx http-server -p 8124 -s -c-1 .`）と `file://` の両方で確かめる

## リリース

`cli/Cargo.toml` の version を上げて main に入れ、同じ番号のタグ（`v0.1.0` など）を push すると、
GitHub Actions が Linux（x86_64 / aarch64、musl の静的リンク）と macOS（x86_64 / aarch64）向けにビルドしてリリースに載せる。

## 今後の予定

- 衝突の解決画面、変更履歴の表示
- CLI でコメントファイルと動画を結合する
