# komenagare（コメナガレ）

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツールです。

- 動画を開いて再生しながらコメントを投稿・編集（タイムライン / Vim 風エディタ）
  - PC では画面の配置を選べる（標準・右にリスト・右にタイムライン。プレビュー・リスト・タイムラインはそれぞれ出す・隠すを切り替えられる）
  - タイムラインにはタイムコード、イン点・アウト点（書き出しの範囲の初期値）、ループ再生、段の高さの切り替え
- 画面の言葉は日本語と英語（URL に `?lang=en` で英語、`?lang=ja` で日本語。このブラウザで覚える）
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
- 主なオプション: `--port`、`--no-git`（履歴なし）、`--require-git`（git が無ければ起動しない）、`--no-token`（合言葉なし。IP アドレス・`localhost`・このパソコンの名前（`mypc`・`mypc.local` など）で開いてください。悪意のあるサイトから名前を切り替えて入られないよう、ほかのドメインの名前では入れません。使うときは `--public-url` で指定）、`--otp`（参加者ごとのワンタイムパスワード）、`--tunnel` / `--public-url`（ローカルネットワークの外から使う）、`--remote`（画面からホストでコマンドを打つ）、`--log`（画面の表示をファイルにも書く。[裏で動かす](#裏で動かす)）。一覧は `komenagare --help`。
- 画面（Web アプリ）は起動のたびに GitHub Pages の最新版を確かめて使います（`komenagare update-web` で手動更新、`--no-update` で確かめない、`--bundled-web` で内蔵版）。
  取れないときは前回取得した版、それも無ければ CLI に内蔵した版を使います。最新版が新しい取り決めになっていて CLI が対応していないときは、`komenagare update` を促します。
  取ってきた Web アプリは署名（`web.sums`）を確かめてから使います。署名の合わないもの、手元の控えより古いものは使いません（GitHub Pages や途中の経路が差し替えられても、ホストが配信する画面は変わりません）。

### 複数のプロジェクト

1フォルダ1プロジェクトのまま、作業フォルダを複数渡すと1つのホストでまとめて共有できます（`komenagare ~/projects/*` でも可）。
画面右上の「📁」からプロジェクトの一覧を開き、このタブのまま切り替える（動画・再生位置・タイムラインの表示はプロジェクトごとに覚えていて、戻ってくると元に戻します）か、新しいタブで開けます。
一覧には、それぞれのプロジェクトに今いる人も出ます。同じプロジェクトや別のプロジェクトを複数のタブで並べて作業しても、変更・衝突はタブごとに正しく扱われます。

#### まとめフォルダ（いくつものプロジェクトを1つのリポジトリで）

プロジェクトごとにリポジトリを作らなくても、**まとめフォルダ**にすると、いくつものプロジェクトを1つのフォルダ・1つの git リポジトリで扱えます。
GitHub に push するのも、別のパソコンや GitHub Codespaces で `git clone` して使うのも、リポジトリ1つで済みます。

```sh
komenagare init --collection kome   # まとめフォルダを作る（git のリポジトリになる）
cd kome
komenagare init a b c               # プロジェクトを作る（まとめフォルダの一覧 komenagare.json に載る）
komenagare                          # 一覧のプロジェクトを全部まとめて共有する（komenagare kome でも可）
komenagare remove c                 # 一覧とリポジトリから外す（フォルダとコメントは残る。komenagare init c で戻る）
komenagare split                    # まとめフォルダを解除して、プロジェクトごとの git リポジトリに分ける
```

- 一覧（`komenagare.json`）にはプロジェクトのフォルダの名前と id が入っていて、git にも入ります。`git clone` した先でもそのまま `komenagare` で開け、プロジェクトの id も同じなので、共有のリンクも変わりません。
- 自動のコミットは、プロジェクトごとにそのプロジェクトの `comments.jsonl` だけを入れます（ほかのプロジェクトや、自分で `git add` しておいたファイルは入れません）。
- **動かしたまま、画面からプロジェクトを作る・外す・復元することができます**（「📁」の一覧の下の「作る」「プロジェクトを復元」と、各行の「外す」）。
  `--otp` なら管理者だけ、合言葉や `--no-token` ならこのパソコンから（`127.0.0.1` で）開いたときだけ使えます（トンネルや同じネットワークのほかのパソコンからは使えません）。
- 「外す」は、共有をやめて、まとめフォルダのリポジトリからも外します（`git rm --cached` と `.gitignore`。それまでの履歴には残ります）。ホストのフォルダとコメントはそのまま残り、外したプロジェクトを開いていた人は切断されてプロジェクトを選び直します。
  「プロジェクトを復元」で外したものを選んで戻すと、同じ id（共有のリンクもそのまま）で一覧とリポジトリに戻ります。別の場所で外したもの（手元にフォルダが無いもの）も、外す前の履歴から取り出して戻せます。作る・外す・復元するたびに git にコミットします。
- いまある作業フォルダ（それぞれ自分の `.git` を持つもの）は、そのまままとめフォルダにできます。それらを入れたフォルダで `komenagare init --collection` とすると、それぞれの git の履歴をまとめフォルダのリポジトリに取り込みます（コメントとプロジェクトの id はそのまま。元の `.git` は `.komenagare/git-backup/` に控えます）。
  あとから作業フォルダごとコピーして入れたときも、`komenagare init a` で同じように取り込んで一覧に載せます。どちらも git の履歴に手を入れるので、y/N で確かめます（`-y` で確かめずに進めます）。
- git なしで作ったまとめフォルダ（`komenagare init --collection --no-git` や、git が入っていないときに作ったもの。直下に `.git` が無く、中のプロジェクトがそれぞれ自分の `.git` を持っている）は、`komenagare.json` をいったん外へよけてから作り直すと、git のリポジトリになります（プロジェクトの id は各フォルダの `.komenagare/id` から読み直すので変わりません。それぞれの履歴も上と同じように取り込みます）:
  `mv komenagare.json ../komenagare.json.bak && komenagare init --collection . -y`（ホストを止めて、まとめフォルダの中で）
- 逆に、`komenagare split` でまとめフォルダを解除して、プロジェクトごとの git リポジトリ（「1つのプロジェクトに1つの `.git`」）に戻せます。
  それぞれの履歴は、まとめフォルダの履歴からそのプロジェクトの分だけを切り出します（取り込む前のコミットは元のまま）。今のリポジトリと `komenagare.json` は `.komenagare/git-backup/` に控えます。これも y/N で確かめます（`-y`）。
  分けたあとは `komenagare a b c` で今まで通りまとめて共有でき、もう一度 `komenagare init --collection` でまとめフォルダにも戻せます。
- 別のファイルのコメントだけを取り込むなら: `komenagare init a --import ~/old/a/comments.jsonl`（コメントの id は引き継ぎます）
- `--remote git` の参加者が打つ git は、リポジトリ全体に効きます（ほかのプロジェクトも含めて）。

##### GitHub に push する

GitHub で空のリポジトリ（README なし・非公開でよい）を作り、まとめフォルダの中で:

```sh
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin HEAD          # 今のブランチ（git の設定で main か master）と同じ名前で push する
```

- 手元とは違う名前のブランチに push したいときは、先に手元のブランチの名前を変えます（例: `git branch -m main master` のあと `git push -u origin master`）。
- リポジトリを作るときに README などを足したなら、GitHub 側に別の履歴があるので、そのままでは push できません（手元の履歴だけでよければ、そのブランチを GitHub で消してから push する）。
- `.DS_Store` などは自動のコミットには入りませんが、自分で `git add .` すると入るので、`.gitignore` に足しておくと安心です。

まとめフォルダにせず、リポジトリの中の作業フォルダを `komenagare a b c` と並べて開くこともできます（この場合は画面から作る・外すことはできず、`git clone` した先では初めに一度 `komenagare init a b c` が要ります）。

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

### ホストの外での変更（git のブランチの切り替えなど）

ホストを動かしたまま、ターミナルや `--remote` で `git checkout`・`git switch`・`git reset`・`git pull` などをして `comments.jsonl` が変わると（手で直したときも）、数秒のうちに全員の画面に反映します。そのあとの変更は、切り替えた先のブランチにコミットします。
まだ書き込んでいない参加者の変更と重なったところは、参加者の変更を残します。マージの途中などで読めない間は、直るまで書き込みを止めます（変更は記録に残っていて、あとで書き込みます）。
まとめフォルダの一覧（`komenagare.json`）の変化は、ホストを起動し直すと反映します。

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
- 使える人（`--remote-users`）は `admin`（管理者）・`all`（全員）・参加者の名前を `,` で区切って並べます（既定は `admin`）。名前は `komenagare otp new` で付けたものです（`admin`・`all` は紛らわしいので、参加者の名前には使えません）。名前で挙げた人のワンタイムパスワードを画面の「招待」から発行できるのは、自分もコマンドを打てる人と、ホストの人（起動時の管理者用の URL で入った人）だけです（ほかの管理者が、その名前で入り直してコマンドを打てないように）。
- 出力の色（ANSI のエスケープシーケンス）はそのまま色で出ます。`--remote git` では git がいつも色を付けます。`--remote shell` では端末ではないので、色を付けるには `ls --color=always`・`git -c color.ui=always status` のように指定します（`git diff > x.patch` のようにファイルへ書くときに色の記号が入らないよう、強制はしません）。
- 打ったコマンドはホストの画面と、作業フォルダの `.komenagare/commands.log` に残ります。止めるには「止める」（Ctrl+C）。接続が切れたときと 15 分たったときも止まります。
- `git reset` や `git checkout` で `comments.jsonl` が変わると、数秒のうちに全員の画面に反映します（[ホストの外での変更](#ホストの外での変更git-のブランチの切り替えなど)）。前の状態を見るだけなら、次の「タイムマシン」が手軽です。

### タイムマシン（履歴をさかのぼって見る・戻す）

`--remote` でコマンドを打てる人は、画面の「タイムマシン」から、git に残っている前のコメントを見られます。

- 右から目盛りが出て、画面がその分だけ縮みます。目盛り1本が `comments.jsonl` の1つのコミットで、上が古く、一番下（赤）が今です。最初と最後と、各日の最初の目盛りは長く、間が空いていれば日付も出ます。日ごとに薄い帯で区切り、ほかの目盛りの長さはそのコミットの変更の数で少し伸びます。
- マウスや指を近づけると、そのあたりの目盛りが拡大鏡のように伸びます。マウスを重ねるとその日時と変更の説明が出て、押すとそのときのコメントに切り替わります（押したまま上下になぞっても動きます）。スマホでは目盛りを指でなぞると、後ろをぼかして日付を大きく出し、離したところを選びます。
- コミットが多くて高さに入りきらないときは、目盛りをスクロールできます（1本ごとに 6px ほど空けます）。PC はホイールで、スマホは素早くスワイプするとスクロールし、押して少し止めてからなぞると選びます（タップでも選べます）。なぞっている指やマウスを上下の端に寄せると、その方向へスクロールし続けます。矢印などで見ている位置が見えないところへ移ると、滑らかにスクロールして追いかけます。
- 上下の矢印（目盛りの上下と、メニューバー）で1つずつ前後に動きます。メニューバーには見ている日時と変更の説明が出ます。
- そのコミットで追加・変更したコメントは、動画・タイムラインで枠に囲い、コメントリストでは色を付けます。メニューバーの「変更 n 件」と ◀ ▶ で順に飛べます（今を見ているときは、最新のコミットと、まだコミットしていない変更）。
- タイムラインのコメントは、最後に変えた時期が近いものほど明るく出します（そのコミットで変えたものが一番明るい）。コメントを選ぶと、最後に変えた日時と人も出ます（`git blame` で調べます）。
- 過去を見ている間も、再生・タイムライン・コメントリスト・Vim エディタ（読むだけ）・コメ付き書き出しはいつも通り使えます。コメントの追加・変更・削除はできません（「終了」で今に戻ります）。
- 「変更履歴」は見ている時点までの変更だけになり、その時点のコミットの変更に印が付きます（「取り消す」は出ません）。ホストが覚えている最近の変更（1000 件）より前は、git のコミットの一覧で出し、「見る」でその時点へ移れます。
- タイムマシンを開いている間もほかの人の変更は届き続けます。新しいコミットは数秒で目盛りの下に増え、今を見ていれば画面にもそのまま出ます（過去を見ていれば、その画面は変わりません）。復元は押したときの今の中身から戻すので、開いた後に増えた変更も含めて戻します（確認の画面の数も直ります）。
- 「この時点に復元…」は、`git reset` で履歴を巻き戻すのではなく、今のコメントからそのときのコメントに戻す変更を、新しいコミットとして記録します（`<名前>: <コミット> の状態に復元（追加 n・変更 n・削除 n）`）。参加者全員に届き、それまでの履歴も残るので、復元したこと自体もあとでタイムマシンで戻せます。
- まとめフォルダでは、そのプロジェクトのフォルダの `comments.jsonl` の履歴だけを出します（まとめフォルダに取り込む前の履歴は出ません）。

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

常駐させる方法は「[裏で動かす](#裏で動かす)」を見てください。
`komenagare otp new` は、動いているホストの公開 URL を使ってリンクを出します（別の URL にするなら `--url`）。
動画はサーバーから配らないので、今まで通り各自が手元の動画を開きます。

### 裏で動かす

`--log ファイル` を付けると、画面に出す内容（起動時の URL・参加者の出入りなど）をそのファイルに書き足します（起動のたびに日時の見出しを付けます）。
止めるとき（Ctrl+C・`kill`・systemd の停止・端末を閉じる・Windows でウィンドウを閉じる）は、書き込み中の変更を保存してから終わります。
強制終了や停電で止まっても、受け取った変更は記録してあるので、次に起動したときに書き込みます。

- 合言葉は起動のたびに変わるので、裏で動かすなら `--token 合言葉` で決めておくと同じリンクで入れます。`--otp` なら、動いているホストの管理者用のリンクを `komenagare otp new 名前 --admin` で出せます。
- Quick Tunnel（`--tunnel cloudflare`）の URL は起動のたびに変わります。ログで確かめてください。
- 止めるときは `kill`（`-9` は付けない）。`-9` で止めるとトンネル（cloudflared など）が残ります。

```sh
# Linux・macOS・Android（Termux）: 端末を閉じても動き続ける
nohup komenagare ~/projects/* --otp --tunnel cloudflare --log ~/komenagare.log &
grep URL ~/komenagare.log      # 公開 URL を見る
pkill -x komenagare            # 止める（保存してから終わる）
```

tmux（`tmux new -s kome` の中で起動し、Ctrl+B → D で抜ける。`tmux attach -t kome` で戻る）を使うと、画面の表示をあとから見に行けます。

Linux で常駐させる（ログインしていなくても動かし、落ちたら起動し直す）なら systemd のユーザーサービスにします。`~/.config/systemd/user/komenagare.service`:

```ini
[Unit]
Description=komenagare
After=network-online.target

[Service]
ExecStart=%h/.local/bin/komenagare %h/projects/kome --otp --no-update --public-url https://komenagare.example.com
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now komenagare
loginctl enable-linger $USER   # ログアウトしても動かし続ける
journalctl --user -u komenagare   # 画面の表示を見る
```

Windows（PowerShell）では、ウィンドウを出さずに起動できます。komenagare が止まると（強制終了でも）、`--tunnel` で始めたトンネルも止まります。

```powershell
Start-Process komenagare -ArgumentList 'C:\projects\kome','--otp','--tunnel','cloudflare','--log',"$env:USERPROFILE\komenagare.log" -WindowStyle Hidden
taskkill /IM komenagare.exe /F   # 止める（ウィンドウの無いプログラムは /F が要る。変更は次の起動で書き込む）
```

Android（Termux）では、共有している間は komenagare が `termux-wake-lock` をかけます。あわせて Android の設定で Termux の電池の最適化を外してください（画面を消したあとに止められないように）。
Android 12 以降は裏で動く子プロセス（`--tunnel` の cloudflared など）を OS が止めることがあります（Android 14 以降なら開発者向けオプションの「子プロセスの制限を無効にする」で止められます）。端末の起動時に動かすなら Termux:Boot を使います。

#### GitHub Codespaces で動かす

手元のパソコンを付けておかなくても、GitHub Codespaces（無料のアカウントで月 60 時間ほど）でホストできます。
操作しないでいるとしばらくして止まり、使わない codespace はいずれ消されるので、数時間の作業会に向いています。コメントは終わったら GitHub に push して残します。

1. [まとめフォルダ](#まとめフォルダいくつものプロジェクトを1つのリポジトリで)を作って、GitHub のリポジトリ（非公開でよい）に push する
2. そのリポジトリの「Code」→「Codespaces」から codespace を作り、ターミナルで:

```sh
curl -fsSL https://raw.githubusercontent.com/igarinpiano/komenagare/main/install.sh | sh
curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb && sudo dpkg -i /tmp/cloudflared.deb
komenagare --otp --tunnel cloudflare       # まとめフォルダのプロジェクトを全部共有する（画面から作る・外すこともできる）
```

3. 終わったら `git push`（自動のコミットが積まれています）

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
