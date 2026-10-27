# コントリビューションの手引き

コメナガレに興味を持ってくださってありがとうございます。不具合の報告・要望・プルリクエストを歓迎します。

参加するときは [行動規範](CODE_OF_CONDUCT.md) を守ってください。
セキュリティ上の問題は Issue に書かず、[SECURITY.md](SECURITY.md) の方法で知らせてください。

## Issue

- 不具合は、起きたこと・期待したこと・再現の手順と、ブラウザ（Web 版）または `komenagare --version` と OS（CLI）を書いてください。
- コメントファイルや動画が関わる場合は、再現できる最小のものを添えてもらえると助かります（人に見せられないものは不要です）。

## プルリクエスト

1. `main` からブランチを作って変更します。
2. 構成と守ること（ビルド手順なし・classic `<script>`・`commitOps` を通す・WebSocket の取り決めの版数など）は [`CLAUDE.md`](CLAUDE.md) にまとめてあります。先に目を通してください。
3. テストを通します。

   ```sh
   node --test 'tests/*.test.js'                   # Vim エンジンとコメントストア
   cargo fmt --manifest-path cli/Cargo.toml --check
   cargo test --manifest-path cli/Cargo.toml        # CLI
   ```

   画面や書き出しを変えたときは、Chromium で http 配信（`npx http-server -p 8124 -s -c-1 .`）と `file://` の両方で確かめてください。
4. 何を・なぜ変えたかを書いてプルリクエストを出します。UI の文言とコードのコメントは日本語です。

## ライセンス

- コメナガレは [Apache License 2.0](LICENSE) です。プルリクエストなどで送っていただいた変更は、Apache License 2.0 の第5条のとおり、同じライセンスで提供されるものとします。
- 送る変更は、自分で書いたもの、またはそのライセンスで提供してよいものに限ってください。
- 新しいソースファイルには、ほかのファイルと同じく冒頭に次の2行を入れてください（コメントの書き方はファイルの種類に合わせる）。

  ```
  SPDX-FileCopyrightText: 2026 Igarin
  SPDX-License-Identifier: Apache-2.0
  ```

- ほかのプロジェクトのコードやライブラリを取り込むときは、そのライセンスと著作権表示を残し、[`NOTICE`](NOTICE) と README の「ライセンス」に追記してください。`lib/` に足したファイルは `web.json` の files にも足します。

## コメナガレのコードを使う方へ

コメナガレの一部（タイムライン・ファイル形式の読み書き・Vim エンジンなど）を自分のプロジェクトに使うのは自由です。そのときは Apache License 2.0 に沿って次のことをしてください。

- `LICENSE`（Apache License 2.0 の本文）を一緒に配る
- [`NOTICE`](NOTICE) の内容（著作権表示）を残す。使ったファイルの冒頭の著作権表示（`SPDX-FileCopyrightText`）も消さない
- 手を加えたファイルには、変えたことがわかる記載を入れる

README などに「コメナガレ (https://github.com/igarinpiano/komenagare) のコードを使っています」と書いてもらえると嬉しいです。
