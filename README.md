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

Linux / macOS / Android（Termux）/ FreeBSD / NetBSD / illumos:

```sh
curl -fsSL https://igarinpiano.github.io/komenagare/install.sh | sh
```

`~/.local/bin/komenagare` に入ります（`KOMENAGARE_INSTALL_DIR` で変更可）。OS と CPU から配布物を選びます（`KOMENAGARE_TARGET` で指定も可）。

Windows（PowerShell）:

```powershell
irm https://raw.githubusercontent.com/igarinpiano/komenagare/main/install.ps1 | iex
```

`%LOCALAPPDATA%\komenagare\bin\komenagare.exe` に入り、ユーザーの PATH に足されます（新しく開いたターミナルから使えます）。

x64・Arm64・32 ビット（x86）の Windows に対応しています。

どちらも、履歴を残すには git が必要です。

配布物は [リリース](https://github.com/igarinpiano/komenagare/releases) にあります（`komenagare-<種類>.tar.gz`、Windows は `.zip`）。

| OS | CPU |
| --- | --- |
| macOS | Apple シリコン（aarch64）、Intel（x86_64）、両方入り（universal） |
| Windows | x86_64、aarch64、i686（MSVC）、x86_64（GNU） |
| Linux（musl・静的リンク） | x86_64、aarch64、i686、armv7、arm（armv6） |
| Linux（glibc） | x86_64・aarch64（glibc 2.28 以降）、i686、armv7、arm、riscv64、powerpc64le、s390x、loongarch64 |
| Android（Termux） | aarch64、armv7、x86_64、i686 |
| FreeBSD / NetBSD / illumos | x86_64 |

### 更新

```sh
komenagare update            # 最新版に更新する
komenagare update --check    # 更新があるかを確かめるだけ
komenagare update --version v0.1.0   # 指定した版にする（前の版に戻すときにも）
```

ホストを起動したときにも新しい版があるかを確かめ、あれば知らせます（`--no-update` で確かめない）。

### 使い方

```sh
mkdir my-comments && cd my-comments
komenagare init                 # 作業フォルダにする（最初に1回。git があれば git の管理下にする）
komenagare                      # 始める（この PC だけで使う）
komenagare --host 0.0.0.0       # 同じネットワークの人と共有する
komenagare --import comments.json   # 保存済みのコメントを取り込んでから始める
komenagare ~/projects/a ~/projects/b # 複数のプロジェクト（作業フォルダ）をまとめて共有する
```

作業フォルダ以外で `komenagare` を実行しても何も作らず、`komenagare init` を案内します。
`komenagare init` には `--no-git`（履歴を残さない）、`--import`（保存済みのコメントを取り込んで作る）も付けられます。

表示された URL（`?k=` の合言葉付き）を参加者に渡します。動画ファイルは各自の手元のものを開きます。

- 同じコメントの同じ項目を2人が別々に変えたときは、先にホストに届いた方が残ります（違う項目なら両方残ります）。
  反映されなかった側には「衝突」の知らせが出て、自分の変更にする・相手のままにする・両方残すを選べます。
- 「変更履歴」タブで、誰がいつ何を変えたかを見られます。どの変更も「取り消す」で打ち消せます（git revert と同じ）。
- ホストとの接続が切れても編集を続けられます。変更はブラウザに保存され、つながり直したときに送られます。
- 主なオプション: `--port`、`--no-git`（履歴なし）、`--require-git`（git が無ければ起動しない）、`--no-token`（合言葉なし）、`--otp`（参加者ごとのワンタイムパスワード）。一覧は `komenagare --help`。
- 画面（Web アプリ）は起動のたびに GitHub Pages の最新版を確かめて使います（`komenagare update-web` で手動更新、`--no-update` で確かめない、`--bundled-web` で内蔵版）。
  取れないときは前回取得した版、それも無ければ CLI に内蔵した版を使います。最新版が新しい取り決めになっていて CLI が対応していないときは、`komenagare update` を促します。

### 複数のプロジェクト

1フォルダ1プロジェクトのまま、作業フォルダを複数渡すと1つのホストでまとめて共有できます（`komenagare ~/projects/*` でも可）。
画面右上の「📁」からプロジェクトの一覧を開き、このタブのまま切り替える（動画・再生位置・タイムラインの表示はプロジェクトごとに覚えていて、戻ってくると元に戻します）か、新しいタブで開けます。
一覧には、それぞれのプロジェクトに今いる人も出ます。同じプロジェクトや別のプロジェクトを複数のタブで並べて作業しても、変更・衝突はタブごとに正しく扱われます。

### ワンタイムパスワード（--otp）

`--otp` を付けると、合言葉（`?k=`）の代わりに参加者ごとのワンタイムパスワードで入るようになります。
1回使うとそのブラウザがその人の名前でログインした状態になり（名前は自分で変えられません。git の作者にもなります）、取り消すとすぐに切れます。

```sh
komenagare --otp --host 0.0.0.0                 # 起動すると、管理者として入る URL（1回だけ使える）が出る
komenagare otp new 山田                          # 英数字 10 文字（既定の期限 7 日）
komenagare otp new 佐藤 --numeric --expires 30m  # 数字 6 桁（既定の期限 10 分）
komenagare otp new 鈴木 --admin --url https://komenagare.example.com   # 管理者にする・そのまま開けるリンクも出す
komenagare otp list                              # ログイン中の人と未使用のワンタイムパスワード
komenagare otp revoke 山田                       # 取り消す（つながっていれば切れる）
```

管理者は画面の「📁」→「招待・ログインの管理」からも発行・取り消しができます。
記録は `~/.config/komenagare/auth`（macOS は `~/Library/Application Support/komenagare/auth`、Windows は `%APPDATA%\komenagare\auth`）に置きます（`--auth-dir` で変更可。`komenagare otp` にも同じものを指定）。

### サーバーで動かす（ローカルネットワークの外から使う）

komenagare 自体は HTTPS を持たないので、前に HTTPS のリバースプロキシを置きます（WebSocket もそのまま通ります）。たとえば Caddy なら:

```
komenagare.example.com {
  reverse_proxy 127.0.0.1:8764
}
```

```sh
komenagare /srv/komenagare/* --otp --no-update   # 127.0.0.1 で待ち受けたまま、プロキシ経由で公開する
```

systemd などで常駐させる場合も、止めるとき（SIGTERM）は書き込み中の変更を保存してから終わります。
動画はサーバーから配らないので、今まで通り各自が手元の動画を開きます。
自分たちだけで使うなら、Tailscale などの仲間内ネットワークでつなぐのも手軽です。

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
