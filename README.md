# komenagare（コメナガレ）

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツールです。

- 動画を開いて再生しながらコメントを投稿・編集（タイムライン / Vim 風エディタ）
- コメントは JSON / CSV / ニコニコ形式 XML で読み書き
- コメント付き動画を MP4 / MOV / WebM / MKV で書き出し

## 使い方

`index.html` をブラウザで開きます（GitHub Pages での公開を想定。ファイルを直接開いても動きます）。
`css/`・`js/`・`lib/` フォルダも同じ場所に置いてください。

## みんなで編集する（komenagare CLI）

`komenagare` コマンドでホストすると、同じコメントを複数人で同時に編集できます。変更はすぐにほかの人の画面に反映され、
送られてくるたびに作業フォルダの `comments.jsonl` に書き込まれ、git のコミットとして残ります（作者は参加者の表示名）。

### インストール（Linux / macOS）

```sh
curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh
```

`~/.local/bin/komenagare` に入ります（`KOMENAGARE_INSTALL_DIR` で変更可）。履歴を残すには git が必要です。

### 使い方

```sh
mkdir my-comments && cd my-comments
komenagare                      # この PC だけで使う
komenagare --host 0.0.0.0       # 同じネットワークの人と共有する
komenagare --import comments.json   # 保存済みのコメントを取り込んでから始める
```

表示された URL（`?k=` の合言葉付き）を参加者に渡します。動画ファイルは各自の手元のものを開きます。

- 同じコメントの同じ項目を2人が別々に変えたときは、先にホストに届いた方が残り、もう一方には知らせが出ます（違う項目なら両方残ります）。
- ホストとの接続が切れても編集を続けられます。変更はブラウザに保存され、つながり直したときに送られます。
- 主なオプション: `--port`、`--no-git`（履歴なし）、`--require-git`（git が無ければ起動しない）、`--no-token`（合言葉なし）。一覧は `komenagare --help`。

## 開発

ビルド手順はありません。構成は `CLAUDE.md` を参照してください。

```sh
node --test 'tests/*.test.js'                 # Vim エンジンとコメントストアのテスト
cargo test --manifest-path cli/Cargo.toml      # CLI のテスト
cargo run --manifest-path cli/Cargo.toml -- /tmp/ws --web .   # CLI を動かす（Web アプリはこのフォルダから配信）
```

## ライセンス

Apache License 2.0（`LICENSE`）。
`lib/mediabunny-*.js` は [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0、`lib/mediabunny-LICENSE.txt`）です。
