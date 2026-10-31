# komenagare（コメナガレ）

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツールです。

- 動画を開いて再生しながらコメントを投稿・編集（タイムライン / Vim 風エディタ）
- コメントは JSON / CSV / ニコニコ形式 XML で読み書き
- コメント付き動画を MP4 / MOV / WebM / MKV で書き出し（縦長の動画は縦長のまま、コメントも動画の範囲に流す）
  - 解像度は元動画と同じ（8K なども）か、それより小さい大きさ。ビットレートは元動画と同じ（既定）か、解像度に合わせるか、数値で選ぶ
  - Chrome / Edge などでは保存先を先に選び、そこへ少しずつ書き込む（長い動画もメモリをあまり使わない）。ほかのブラウザはダウンロードで、一度に 4 GB まで
  - 8K などの大きな動画は `komenagare render`（CLI）がおすすめ（ffmpeg で書き出すので、ブラウザのメモリやエンコーダーの制限を受けない）

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

`komenagare update` は、リリースの署名（`SHA256SUMS.minisig`）を komenagare に埋め込んだ公開鍵で確かめ、署名した一覧と同じ中身のときだけ入れ替えます。
署名を付け始める前の版（v0.4.x まで）には `komenagare update` では戻せません。戻すときは `KOMENAGARE_VERSION=v0.4.3` を付けて install.sh / install.ps1 で入れてください。

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
  ブラウザとホストは 20 秒ごとに確かめ合い、返事が無ければすぐにつなぎ直します（ネットワークが戻ったときやタブを前に出したときも、待たずに確かめます）。ホストも、2 分間何も届かない接続は切ります（回線が黙って切れた人を参加者の一覧に残さない）。
- 再生バーの 📣（ここ見て）で今の再生位置と選んでいるコメントをほかの人に知らせ、🔗 でその位置（コメント）へのリンク（`#t=秒&c=コメントの id`）をコピーできます。電話やメッセージで作業するときに便利です。
- 動画は各自の手元のものを使うので、ほかの人と動画の長さが違えば知らせます（違う動画だと、コメントの出る場面がずれます）。
- ほかの人と共有している間（`--host 0.0.0.0`・`--tunnel`・`--public-url`）は、終わるまでホストのパソコンをスリープさせません（macOS は `caffeinate`、Linux は `systemd-inhibit`、Windows は `SetThreadExecutionState`、Termux は `termux-wake-lock`）。止めるなら `--allow-sleep`。ノートパソコンはふたを閉じるとスリープすることがあります。
- 主なオプション: `--port`、`--no-git`（履歴なし）、`--require-git`（git が無ければ起動しない）、`--no-token`（合言葉なし。IP アドレス・`localhost`・このパソコンの名前（`mypc`・`mypc.local` など）で開いてください。悪意のあるサイトから名前を切り替えて入られないよう、ほかのドメインの名前では入れません。使うときは `--public-url` で指定）、`--otp`（参加者ごとのワンタイムパスワード）、`--tunnel` / `--public-url`（ローカルネットワークの外から使う）、`--remote`（画面からホストでコマンドを打つ）。一覧は `komenagare --help`。
- 画面（Web アプリ）は起動のたびに GitHub Pages の最新版を確かめて使います（`komenagare update-web` で手動更新、`--no-update` で確かめない、`--bundled-web` で内蔵版）。
  取れないときは前回取得した版、それも無ければ CLI に内蔵した版を使います。最新版が新しい取り決めになっていて CLI が対応していないときは、`komenagare update` を促します。
  取ってきた Web アプリは署名（`web.sums`）を確かめてから使います。署名の合わないもの、手元の控えより古いものは使いません（GitHub Pages や途中の経路が差し替えられても、ホストが配信する画面は変わりません）。

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
komenagare otp new 佐藤 --numeric --expires 30m  # 数字 6 桁（既定の期限 10 分。当てられやすいので長くても 1 時間）
komenagare otp new 鈴木 --admin --url https://komenagare.example.com   # 管理者にする・そのまま開けるリンクも出す
komenagare otp list                              # ログイン中の人と未使用のワンタイムパスワード
komenagare otp revoke 山田                       # 取り消す（つながっていれば切れる）
```

管理者は画面の「📁」→「招待・ログインの管理」からも発行・取り消しができます。

ログインには有効期限があります（既定はログインしてから 30 日）。過ぎたらワンタイムパスワードでログインし直します。`--session-ttl 7d` のように変えられ、`--session-ttl none` で無期限になります。
記録は `~/.config/komenagare/auth`（macOS は `~/Library/Application Support/komenagare/auth`、Windows は `%APPDATA%\komenagare\auth`）に置きます（`--auth-dir` で変更可。`komenagare otp` にも同じものを指定）。

### リモートでコマンドを打つ（--remote）

`--otp` と一緒に `--remote` を付けると、許された参加者が画面の「⌨ ターミナル」から、ホストの作業フォルダでコマンドを打てます（SSH のような使い方。ただし端末ではないので、エディタやパスワードなど入力を求めるコマンドは使えません）。

```sh
komenagare --otp --remote git                            # 管理者だけが git を使える
komenagare --otp --remote git --remote-users all         # 全員が git を使える
komenagare --otp --remote git --remote-users admin,山田  # 管理者と山田さん
komenagare --otp --remote shell                          # 管理者だけが何でも打てる（シェル）
```

- `--remote git` は git の決まったサブコマンド（status / log / diff / show / add / commit / push / pull / fetch / switch / restore / reset / stash / merge など）だけを、シェルを通さずに動かします。
  `git config` や `git -c …`、`--upload-pack` のようにほかのプログラムを動かせるもの、`--output` や `-F` のように作業フォルダの外のファイルを読み書きできるものは断ります。
  fetch / pull / push でつなげる先は https・http・ssh・git だけです（このパソコンの中のほかのリポジトリ（パスや `file://`）とはやりとりできません）。
  `git diff` に作業フォルダの外のパス（`/etc/passwd` や `../x`）は渡せません。git のフック（`core.hooksPath` が作業ツリーの中にある husky なども）は動かしません（コメントの変更を記録する自動のコミットも同じ）。
- `--remote shell` は何でも打てます。**このパソコンを預けるのと同じ**なので、信頼できる人だけに許してください。
- 使える人（`--remote-users`）は `admin`（管理者）・`all`（全員）・参加者の名前を `,` で区切って並べます（既定は `admin`）。名前は `komenagare otp new` で付けたものです（`admin`・`all` は紛らわしいので、参加者の名前には使えません）。
- 出力の色（ANSI のエスケープシーケンス）はそのまま色で出ます。`--remote git` では git がいつも色を付けます。`--remote shell` では端末ではないので、色を付けるには `ls --color=always`・`git -c color.ui=always status` のように指定します（`git diff > x.patch` のようにファイルへ書くときに色の記号が入らないよう、強制はしません）。
- 打ったコマンドはホストの画面と、作業フォルダの `.komenagare/commands.log` に残ります。止めるには「止める」（Ctrl+C）。接続が切れたときと 15 分たったときも止まります。
- ホストはコメントを覚えたまま動いているので、`git reset` や `git checkout` で `comments.jsonl` を書き換えても読み込み直しません（次に誰かがコメントを変えると、ホストの内容で上書きされます）。

### ローカルネットワークの外から使う

komenagare を自分の PC（またはサーバー）で動かしたまま、インターネット越しに入れるようにする方法はいくつかあります。どれも無料で始められます。
インターネットに出すときは、`--otp`（参加者ごとのワンタイムパスワード）か合言葉（`?k=`）で入るようにしてください（`--tunnel` と `--no-token` は一緒に使えません）。

| 方法 | URL | 参加者 | 向いているとき |
|---|---|---|---|
| `--tunnel tailscale`（Tailscale Funnel） | 固定（`https://<PC名>.<tailnet>.ts.net/`） | ブラウザだけ | **おすすめ**。URL が変わらないのでログインも保たれる |
| `--tunnel cloudflare`（Cloudflare Quick Tunnel） | 起動のたびに変わる | ブラウザだけ | アカウントなしでまず試す・一度きりの作業 |
| `--tunnel ngrok` | 固定（無料のアカウントで1つ） | ブラウザだけ（初回に ngrok の確認画面が出る） | ngrok を使い慣れている（無料は月 1GB まで） |
| Tailscale（仲間内ネットワーク） | 仲間内だけ | 各自 Tailscale を入れる | 外に一切出したくない |
| `--public-url`（自分で用意したもの） | 自由 | ブラウザだけ | 名前付きの Cloudflare Tunnel、VPS と Caddy、会社のリバースプロキシなど |

Firebase のような静的なホスティングには、komenagare（ずっと動いて変更を受け取るホスト）は置けません。

#### トンネルを komenagare から始める（--tunnel）

komenagare がトンネルのコマンドを起動し、公開 URL を読み取って表示します。止めればトンネルも止まります。
表示される「公開 URL」を参加者に渡します（画面の「招待」や `komenagare otp new` のリンクも公開 URL になります）。

```sh
# Tailscale Funnel（https://tailscale.com/download から入れてログイン。初回は表示される案内に従って Funnel を有効にする）
komenagare ~/projects/a --otp --tunnel tailscale

# Cloudflare Quick Tunnel（cloudflared を入れるだけ。アカウント不要）
komenagare ~/projects/a --tunnel cloudflare

# ngrok（入れたあと ngrok config add-authtoken <トークン>）
komenagare ~/projects/a --otp --tunnel ngrok
```

- Quick Tunnel の URL は起動のたびに変わります。`--otp` のログインはブラウザが URL ごとに覚えるので、URL が変わるとログインし直しになります（Quick Tunnel なら合言葉の方が手軽です）。
- Linux の Tailscale で権限のエラーが出たら、一度 `sudo tailscale set --operator=$USER` を実行してください。

##### メールアドレスで入れる人を絞る（--allowed-mail。Cloudflare Quick Tunnel）

```sh
komenagare ~/projects/a --otp --tunnel cloudflare --allowed-mail 'alice@example.com,bob@example.com'
komenagare ~/projects/a --otp --tunnel cloudflare --allowed-mail '*@example.com'   # ドメインごと
```

- 公開 URL を開いた人は、まず Cloudflare の画面でメールアドレスを入れ、届いた PIN で確認します。許可したアドレスの人だけが komenagare のページまで届きます（cloudflared 2026.9.3 以上が要ります）。
- 確認は最長 4 時間有効です。切れるとつながらなくなるので、画面の案内に従ってページを再読み込みし、確認し直してください（未送信の変更はブラウザに残ります）。
- 誰のアドレスかは komenagare には渡らないので、名前・管理者・`--remote` は今までどおり `--otp` で決めます（`--otp` と一緒に使います）。
- 許すアドレスを変えるには komenagare を起動し直します（URL も変わります）。

#### 自分で用意したトンネル・サーバー（--public-url）

トンネルやリバースプロキシを自分で動かすときは、その URL を `--public-url` で渡します（環境変数 `KOMENAGARE_PUBLIC_URL` でも可）。共有・招待のリンクがその URL になります。

```sh
# 名前付きの Cloudflare Tunnel（自分のドメインを Cloudflare に置いている場合）
cloudflared tunnel run --url http://127.0.0.1:8764 my-tunnel
komenagare ~/projects/* --otp --public-url https://komenagare.example.com

# ngrok で自分の決まったドメインを使う
ngrok http 8764 --url https://my-name.ngrok-free.app
komenagare ~/projects/* --otp --public-url https://my-name.ngrok-free.app
```

いつでも入れるようにしたいなら、無料の VPS（Oracle Cloud の Always Free など）で動かし、前に HTTPS のリバースプロキシを置きます（WebSocket もそのまま通ります）。たとえば Caddy なら:

```
komenagare.example.com {
  reverse_proxy 127.0.0.1:8764
}
```

```sh
komenagare /srv/komenagare/* --otp --no-update --public-url https://komenagare.example.com
```

systemd などで常駐させる場合も、止めるとき（SIGTERM）は書き込み中の変更を保存してから終わります。
`komenagare otp new` は、動いているホストの公開 URL を使ってリンクを出します（別の URL にするなら `--url`）。
動画はサーバーから配らないので、今まで通り各自が手元の動画を開きます。

### コメントを動画に焼き込む（komenagare render）

```sh
komenagare render video.mp4                      # 今のフォルダの comments.jsonl を焼き込んで video_comments.mp4 に
komenagare render video.mp4 -c comments.json -o out.mp4 --height 1080 --start 1:00 --end 2:30
komenagare render video.mp4 --bitrate same          # 映像のビットレートを元動画と同じに（既定は画質を一定にする CRF 20）
komenagare render --ass comments.ass -c comments.json   # 字幕ファイル（ASS）だけ。mpv などで動画に重ねて再生できる
```

Web アプリの書き出しと同じ規則で配置し、ffmpeg（libass 付き）で描きます。ffmpeg が必要です。
縦長の動画は縦長のまま書き出し、コメントも動画の範囲に流します（`--wide` で 16:9 に固定。Web アプリの設定「コメントを流す範囲」と同じ）。
既定の大きさは元動画と同じです（8K なら 8K。Web アプリの「元動画と同じ」と同じ）。小さくするには `--height`（例 `--height 1080`）を付けます。
画質は既定では x264 の CRF（`--crf`、既定 20。小さいほど高画質）で決めます。ビットレートで決めるなら `--bitrate`（Mbps の数値か、元動画と同じにする `same`）を付けます。
元動画の大きさ・回転・ビットレートは ffprobe で調べます（無ければ ffmpeg の出力から読みます）。
フォントは `--font` / `--font-serif` で変えられます（既定は Windows では MS PGothic / Yu Mincho、ほかは fontconfig の sans-serif / serif）。
文字の幅はフォントで測らず見積もるため、流れるコメントの重なり方は Web アプリの書き出しと少し違うことがあります。

## 開発

ビルド手順はありません。構成は `CLAUDE.md` を参照してください。

```sh
node --test 'tests/*.test.js'                 # Vim エンジン・コメントストア・CSV などのテスト
cargo test --manifest-path cli/Cargo.toml      # CLI のテスト
cargo run --manifest-path cli/Cargo.toml -- /tmp/ws --web .   # CLI を動かす（Web アプリはこのフォルダから配信）
```

## 参加する

不具合の報告やプルリクエストを歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) と [行動規範](CODE_OF_CONDUCT.md) を見てください。
脆弱性は公開の Issue にせず、[SECURITY.md](SECURITY.md) の方法で知らせてください。

## ライセンス

Copyright 2026 Igarin

[Apache License 2.0](LICENSE)。著作権などの表示は [NOTICE](NOTICE) にあります。

コメナガレのコード（一部だけでも）を自分のプロジェクトに使うときは、`LICENSE` と `NOTICE` の内容を一緒に配り、
各ファイル冒頭の著作権表示を残し、手を加えたファイルにはそのことを書いてください（詳しくは [CONTRIBUTING.md](CONTRIBUTING.md#コメナガレのコードを使う方へ)）。

同梱しているもの:

- `lib/mediabunny-*.js` は [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0、`lib/mediabunny-LICENSE.txt`）です。
- `komenagare` コマンドの配布物には、使っている Rust のクレートのライセンス（`THIRD-PARTY-LICENSES.html`）を入れています。
