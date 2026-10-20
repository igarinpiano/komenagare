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

## 守ること

- ビルド手順なしで動かす。スクリプトは ES modules ではなく classic `<script>` にする（`file://` で直接開いても動かすため）。読み込み順は `index.html` の通り。
- `file://` ではワーカーが使えないので、書き出しはメインスレッドで行う（`fastExportInWorker()`）。
- localStorage のキー（`komenagare.settings` など）は変えない（保存済みデータを引き継ぐため）。
- コメントの追加・変更・削除は必ず `commitOps`（`js/app.js`）で変更セットとして行い、`state.comments` や各コメントを直接書き換えない（複数人編集で変更を送り合うため）。タイムラインのドラッグ中の一時的な見た目の変更だけは例外で、確定時に戻してから `commitOps` する。
- コメントの id は UUID v7。ファイル（JSON / CSV）に保存し、読み込み時に引き継ぐ。
- UI の文言・コメントは日本語。

## テスト

- `node --test 'tests/*.test.js'` — Vim エンジンとコメントストアのテスト
- 画面と書き出しは Chromium（Playwright）で、http 配信（`npx http-server -p 8124 -s -c-1 .`）と `file://` の両方で確かめる

## 今後の予定

- Rust 製 CLI（コメントファイルと動画の結合、ホストして複数人で編集）
