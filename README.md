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

### インストール

Linux / macOS:

```sh
curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh
```

`~/.local/bin/komenagare` に入ります（`KOMENAGARE_INSTALL_DIR` で変更可）。

Windows（PowerShell）:

```powershell
irm https://raw.githubusercontent.com/igarinpiano/komenagare/main/install.ps1 | iex
```

`%LOCALAPPDATA%\komenagare\bin\komenagare.exe` に入り、ユーザーの PATH に足されます（新しく開いたターミナルから使えます）。

どちらも、履歴を残すには git が必要です。

### 更新

```sh
komenagare self-update            # 最新版に更新する
komenagare self-update --check    # 更新があるかを確かめるだけ
komenagare self-update --version v0.1.0   # 指定した版にする（前の版に戻すときにも）
```

ホストを起動したときにも新しい版があるかを確かめ、あれば知らせます（`--no-update` で確かめない）。

### 使い方

```sh
mkdir my-comments && cd my-comments
komenagare                      # この PC だけで使う
komenagare --host 0.0.0.0       # 同じネットワークの人と共有する
komenagare --import comments.json   # 保存済みのコメントを取り込んでから始める
```

表示された URL（`?k=` の合言葉付き）を参加者に渡します。動画ファイルは各自の手元のものを開きます。

- 同じコメントの同じ項目を2人が別々に変えたときは、先にホストに届いた方が残ります（違う項目なら両方残ります）。
  反映されなかった側には「衝突」の知らせが出て、自分の変更にする・相手のままにする・両方残すを選べます。
- 「変更履歴」タブで、誰がいつ何を変えたかを見られます。どの変更も「取り消す」で打ち消せます（git revert と同じ）。
- ホストとの接続が切れても編集を続けられます。変更はブラウザに保存され、つながり直したときに送られます。
- 主なオプション: `--port`、`--no-git`（履歴なし）、`--require-git`（git が無ければ起動しない）、`--no-token`（合言葉なし）。一覧は `komenagare --help`。
- 画面（Web アプリ）は起動のたびに GitHub Pages の最新版を確かめて使います（`komenagare update-web` で手動更新、`--no-update` で確かめない、`--bundled-web` で内蔵版）。
  取れないときは前回取得した版、それも無ければ CLI に内蔵した版を使います。最新版が新しい取り決めになっていて CLI が対応していないときは、`komenagare self-update` を促します。

### コメントを動画に焼き込む（komenagare render）

```sh
komenagare render video.mp4                      # 今のフォルダの comments.jsonl を焼き込んで video_comments.mp4 に
komenagare render video.mp4 -c comments.json -o out.mp4 --height 1080 --start 1:00 --end 2:30
komenagare render --ass comments.ass -c comments.json   # 字幕ファイル（ASS）だけ。mpv などで動画に重ねて再生できる
```

Web アプリの書き出しと同じ規則で配置し、ffmpeg（libass 付き）で描きます。ffmpeg が必要です。
フォントは `--font` / `--font-serif` で変えられます（既定は Windows では MS PGothic / Yu Mincho、ほかは fontconfig の sans-serif / serif）。
文字の幅はフォントで測らず見積もるため、流れるコメントの重なり方は Web アプリの書き出しと少し違うことがあります。

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
