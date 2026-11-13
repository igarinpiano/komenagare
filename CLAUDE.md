# komenagare

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツール。GitHub Pages（`https://igarinpiano.github.io/komenagare/`）で公開する。

## 構成

- `index.html` — 画面のマークアップとヘルプ
- `css/komenagare.css` — スタイル
- `js/vim-engine.js` — Vim エンジン（DOM 非依存。グローバル `createVimEngine`、Node からも `require` できる）
- `js/comment-store.js` — コメントの保管と変更（DOM 非依存）。UUID v7、変更セット、3-way マージによる衝突の検出、打ち消し（元に戻す）
- `js/comment-csv.js` — コメントの CSV の書き出しと読み取り（DOM 非依存）。表計算ソフトで数式にならないよう、先頭が `'*[=+\-@\t\r]` のセルに `'` を足し、コメナガレの CSV（見出しが `time,command,text,id`）を読むときに外す。`cli/src/files.rs` も同じ規則で読む（両方を同じに保つ）
- `js/comment-render.js` — コメント描画の定数と描画処理（画面・書き出し・ワーカーで共通）
- `js/export-core.js` — 高速書き出し（WebCodecs + Mediabunny）の本体。ワーカーとメインスレッドで共通。保存先のファイル（`showSaveFilePicker` が使えるブラウザ）があれば少しずつそこへ書き、無ければ今までどおり出力をメモリに持ってダウンロードする（4 GiB まで）。どちらの方式も残す。エンコーダーには書き出しのフレームレートを伝える（伝えないと 30fps と見なしてビットレートを配る。`exportRate`。「動画に合わせる」ではコマの間隔が一定のときだけ元動画の値）
- `js/export-worker.js` — 高速書き出し用 Web Worker
- `js/i18n.js` — 画面の言葉（日本語・英語）。`?lang=en` / `?lang=ja` で切り替え、このブラウザで覚える（localStorage の `komenagare.lang`）。JS の言葉は `T('…')` と ``T`…${x}…` ``（キーは `${}` を `{0}` `{1}` … にしたもの）で書き、英語は `EN` から引く。index.html の言葉は開いたときに置き換え、使い方は `HELP_EN` を出す。`js/vim-engine.js`・`js/export-core.js` は `KT`（Node のテストでは日本語のまま）。書き出しのワーカーには URL の `?lang=` で渡す
- `js/term-ansi.js` — ターミナル（`--remote`）の出力の色（ANSI のエスケープシーケンス）の読み取り（DOM 非依存。Node からも `require` できる）
- `js/app.js` — アプリ本体（1つの IIFE。上のファイルのグローバルを使う）
- `lib/` — 同梱ライブラリ（Mediabunny、MPL-2.0。classic スクリプト版でグローバル `Mediabunny`）
- `Cargo.toml` — CLI の workspace（cross がリポジトリの直下をコンテナに入れるよう、ここに置く。`Cargo.lock` と `target/` もここ）
- `cli/` — `komenagare` コマンド（Rust）。Web アプリを内蔵して配信し、WebSocket で変更を受け渡す
  - `build.rs` — 配布物の種類（ターゲット）を埋め込む（`komenagare update` が同じ種類を取る）
  - `store.rs` — `js/comment-store.js` と同じ規則の変更セット適用（両方を同じに保つこと）
  - `workspace.rs` — 作業フォルダ（`komenagare init` で作る。`.komenagare/id` があるものだけを `komenagare` で開く）、`comments.jsonl`（1行1コメント）、`.komenagare/`（作業用の記録。git には入れない）、git へのコミット。
    届いた変更は `log.jsonl` に書き足してから ack を返し、`comments.jsonl` とコミットは書き込み担当（`server.rs` の `spawn_writer`。変更だけを受け取って自分の控えに当てる。溜まっていればまとめて1回で）が後から行う。
    どこまで書いたかは `.komenagare/saved` に残し、起動時に `recover` でそれより新しい記録を当て直す（途中で止まっても受け取った変更を失わない）
  - `collection.rs` — まとめフォルダ（`komenagare init --collection`。直下のプロジェクトの一覧を `komenagare.json` に持ち、git に入れる）。`komenagare <まとめフォルダ>` で全部開き、作業用の記録が無い（複製した直後）なら一覧の id で作る。動いているホストの画面から作る・外す・復元する（`/api/projects`。`--otp` なら管理者だけ、合言葉・`--no-token` ならこのパソコンから開いたときだけ（`server.rs` の `local_request`。トンネルもこのパソコンの中からつないでくるので、Host と転送のヘッダーも見る））。外すと一覧とリポジトリから外し（`git rm --cached` を一時の index で。`.gitignore` に `/名前/`）、復元は手元に無ければ外す前のコミットから取り出す（id は外す前の `komenagare.json` から）。止めている間は `komenagare init 名前`（作る・戻す）と `komenagare remove 名前`（外す）。名前は直下の1つのフォルダだけを指すように確かめ（`name_ok`）、リンクはたどらない。
    プロジェクトが自分の `.git` を持っていれば、まとめフォルダにするとき（`init --collection`・`init 名前`）にその履歴を取り込む（`absorb`。`-s ours` のマージと `read-tree --prefix`。元の `.git` は `.komenagare/git-backup/` に控える）。`komenagare split` は逆に、プロジェクトごとの履歴を切り出して（`History::split`。git subtree split と同じ考え方で、取り込む前のコミットは元のまま使う）それぞれの `.git` を作り、まとめフォルダを解除する。どちらも git の履歴に手を入れるので y/N で確かめる（`-y` で確かめない。端末でなければ止める）。画面から作るときは、自分の `.git` を持つフォルダを断る
  - `server.rs` — 配信（`index.html` に `<meta name="komenagare-host">` を差し込む）、HTTP の API、WebSocket の取り決め（ファイル冒頭に記載）。1つのホストで複数のプロジェクト（作業フォルダ）を共有する（`/ws?p=<作業フォルダの id>`）
  - `remote.rs` — `--remote`（許された参加者が画面の「ターミナル」からホストの作業フォルダでコマンドを打つ。`git` は決まったサブコマンドだけで、ほかのプログラムを動かせるオプションや作業フォルダの外を読み書きするオプションは断る。`shell` は何でも。`--otp` のときだけ）
  - `auth.rs` — 参加者ごとのワンタイムパスワード（`--otp`、`komenagare otp`）。1件1ファイルで置き、動いているホストと `komenagare otp` が同時に書いても壊れないようにする
  - `mcp.rs` — `komenagare mcp`。AI などの自動の参加者を、ブラウザと同じ取り決めでホストにつなぐ（hello に `agent: true`）。道具は `Agent::call` の1か所で、MCP（標準入出力の JSON-RPC。標準出力にはそれ以外を書かない）と手動（`--manual`・`--script`）の両方から呼ぶ（道具を足したら `tools()`・`parse_manual`・README も）。動きは「カーソルを動かす → 変更を送る → 選ぶ」を間を空けて見せる（`act`）。動画は ffmpeg でコマ（`get_frames`）と範囲（`get_clip`）を切り出す。ログインと client_key は設定の置き場所の `agents/` に控える
  - `render.rs` — `komenagare render`。`js/app.js` の `relayout` と同じ規則で配置して ASS 字幕にし、ffmpeg（libass）で焼き込む（`relayout` やコメントの定数を変えたらこちらも合わせる）
  - `files.rs` — コメントファイル（JSON / JSONL / CSV）の読み込み
  - `tunnel.rs` — `--tunnel`（cloudflared / tailscale / ngrok を子プロセスで起動し、出力から公開 URL を読む）と `--public-url`。公開 URL は共有・招待のリンクに使い、ページには `<meta>` の `data-public-url` で渡す。`--allowed-mail`（Cloudflare のみ・`--otp` と一緒）は cloudflared に渡してメールの PIN で入る人を絞り、ページには `data-email-gate` で知らせる（確認が切れたら再読み込みを案内する）
  - `awake.rs` — ほかの人と共有している間（`--host` が手元以外・`--tunnel`・`--public-url`）ホストをスリープさせない（macOS は `caffeinate -w`、Linux は `systemd-inhibit`、Windows は `SetThreadExecutionState`、Android は `termux-wake-lock`。`--allow-sleep` で止める）
  - `output.rs` — 画面への出力の行き先（`--log` でファイルに書き足す。端末が閉じられた（SIGHUP・Windows のウィンドウを閉じた）ら端末への出力を捨てて、保存してから終わる）
  - `firewall.rs` — macOS のファイアウォールの検出と許可（LAN で待ち受けたら自分の LAN のアドレスにつないでみて、切られたら許可するコマンドを y/N で実行する。socketfilterfw の出力の文言には頼らない）
  - `web.rs` — 配信する Web アプリの用意（GitHub Pages から最新版を取って ~/.cache/komenagare/web（Windows は %LOCALAPPDATA%\komenagare\web）に控える。取れなければ前回の控えか内蔵版）。署名（`web.sums` と `web.sums.minisig`）が合い、手元の控えより新しいものだけを使う
  - `sign.rs` — 署名（minisign）を確かめる。公開鍵は `cli/minisign.pub`（CLI に埋め込む）。リリースは `SHA256SUMS` に `komenagare-release tag:vX.Y.Z`、Web アプリは `web.sums` に `komenagare-web protocol:N time:T` の署名
  - `update.rs` — `komenagare update`（GitHub のリリースから配布物を取って、署名した `SHA256SUMS` と照らし合わせて実行ファイルを置き換える）と、起動時の新しい版のお知らせ。配布物の名前は `.github/package.sh` と合わせる
- `web.json` — CLI が取ってくる Web アプリのファイル一覧と、ホストとのやりとりの取り決めの版数（protocol）
- `install.sh` — `curl … | sh` 用のインストーラー（Linux / macOS / Android / BSD など。OS と CPU から配布物を選ぶ。ターゲットを足したらここも合わせる）
- `install.ps1` — `irm … | iex` 用のインストーラー（Windows。raw.githubusercontent.com から配る。UTF-8・BOM なしのまま保つ）
- `.github/workflows/` — CI（Node と Rust のテスト）、リリース（`release.yml`）、全ターゲットのビルド（`build-matrix.yml`。ターゲットの一覧はここだけ）と、その確認（`build-check.yml`。依存やビルドの設定を変えた PR で走る）、GitHub Pages への公開（`pages.yml`。Web アプリに署名してから公開する）。アクションは SHA で固定する
- `.github/minisign.py` — 署名の鍵を作る・署名する・確かめる（minisign と同じ形式。cryptography が必要）。秘密鍵は environment「signing」の secret `MINISIGN_SECRET_KEY` にだけ置き、その environment は承認（Required reviewers）が要る設定にする
- `Cross.toml` — cross のイメージを digest で固定する（調べ方は `.github/cross-digests.sh`）
- `tests/fixtures/` — テストで使うファイル（中身のバイトをそのまま使うので `.gitattributes` で改行を変えさせない）。`tests/fixtures/sign/` はテスト専用の鍵で署名したもの（`make.sh` で作り直す。取り決めの版数を上げたら作り直す）
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
- ほかの参加者から届くもの（presence・共有された衝突・「ここ見て」）は、使う前に `cleanPresence` / `cleanConflict` / `cleanCall`（`js/app.js`）で型を確かめて取り出す。項目を足したらそこにも足す。
- ブラウザの id（client）はホストが `client_key`（ブラウザだけが知る秘密。localStorage の `komenagare.clientKey`）のハッシュから作る。自分のものかは snapshot の `client` と比べて見分ける（client_key は配らない）。
- CLI から git を動かすときは、フックを動かさない（`core.hooksPath` を `workspace::no_hooks_path()` にする）。
  ホストが動かす git は `workspace.rs` の `git_cmd` を通す: まとめフォルダの中のプロジェクトは自分の `.git` を持たないので、
  フォルダに HEAD・objects・refs の形のファイルを置かれると git がそこをリポジトリとして使い、その config でプログラムを動かせる。
  `check_git_dir` で断り、`safe.bareRepository=explicit` も渡す（`--remote git` の git にも。`remote.rs` の `build`）。
  パスは書いたとおりに読ませる（`GIT_LITERAL_PATHSPECS`。名前の `[ ]` を模様にしない）。
  1つのリポジトリに複数のプロジェクト（作業フォルダ）を入れられるよう、自動のコミットは自分のファイルだけを指定して行い（`commit` の paths）、git はプロセスの中で1つずつ動かす（`git_lock`）。
- ホストは Ctrl+C・SIGTERM・SIGHUP（nohup で無視されていればそのまま）・Windows の閉じる／ログオフ／シャットダウンで、保存してから終わる（`main.rs` の `shutdown_signal`）。Windows では `--tunnel` の子プロセスをジョブに入れ、強制終了されても残らないようにする。
- ホストの外で `comments.jsonl` が変わったら（git checkout・reset など）、書き込み担当が気づいて（2 秒ごとと `--remote` のコマンドのあと。`spawn_writer` の `external_change`）、最後に書いた中身からの差分を Hub に渡し（`Hub::apply_external`）、全員に配る。返ってくるまで・読めない間は書き込まない（外での変更を上書きしない）。
- 共同編集（`state.collab`）中は、`commitOps` などで適用した変更を `collabSend` でホストへ送る。送信待ちは IndexedDB に控える。
  ホストで衝突した自分の変更は `collab.conflicts` に控え、衝突の解決画面（`#conflictDlg`）で選ばせる。
  「あとで」にした衝突はホストに預け（`conflict_add`。ホストは `.komenagare/conflicts.json` に残す）、全員の `collab.shared` に出して誰でも解決できるようにする。
- 1つのホストに複数のプロジェクトがあるときは、ページの `?p=` で選ぶ（`collabOpen` / `collabClose` でタブのまま切り替える。控えの IndexedDB はプロジェクトごと）。
  まとめフォルダのときは、動いている間にプロジェクトが増えたり外されたりする（`Server` の `projects`。外したら `Hub::close` でつながっている人を切り、書き込み担当は書き終えてから終わる。終わるときは `Server::finish` で全部の書き込みを待つ）。画面は `/api/projects` の `manage` があるときだけ作る・外すを出す（古いホストは送らない）。
  同じプロジェクトを複数のタブで開けるよう、衝突の控えはタブごと（`collab.owner`）に置き、閉じたタブの分は次に開いたタブが引き継ぐ。
- `--otp` のときは `collab.session`（localStorage の `komenagare.session`）で入り、名前はホストが決める。
  ログインには有効期限がある（`auth.rs`。既定 30 日、`--session-ttl`。期限はホストだけが確かめる。`komenagare otp` は期限を知らないので消さない）。
- ホストに送る変更セットは `collabQueue`（`js/app.js`）で 2000 op・2MB ほどに分けて送る。ホストは 1 万 op・1 通 16MB・本文 40 万バイト・コマンド 4000 バイトまで（`server.rs` の `change_ok`）。どちらかを変えるときは、もう片方を超えないようにする。
  コメントの時刻は 0〜1000 万秒（`js/app.js` と `server.rs` の `TIME_MAX`。ホストは新しく入れる時刻だけを確かめる）、表示時間（`@秒`）は 100 万秒まで（`LONG_MAX`。`render.rs` も同じ）。
  画面は、それを超える値（前からあるもの・ホストの外で書かれたもの）が来ても描画が止まらないようにする（`tlDuration`・`rulerStep`・`TL_TICKS_MAX`）。
- hello（ログイン）より前の接続は、30 秒・64KB・同時に 32 まで（`server.rs`）。`--no-token` のときは、Host が手元の名前（IP・localhost・ドットの無い名前・.local など）か公開 URL のときだけ API と WebSocket を使わせる（DNS リバインディング対策）。
- 再生位置・選択・タイムラインの表示範囲・カーソルは `presence` メッセージで配り合う（`presenceDirty` で送る。ホストは中継するだけで保存しない）。
  参加者一覧（`#peersDlg`）から「追いかける」と `followApply` で相手に合わせ、自分で操作したらやめる。どちらかがつなぎ直しても、ブラウザの id（`collab.followClient`）で同じ人を追いかけ続ける。
  presence の `video`（動画の長さ）で、ほかの人と同じ動画かを確かめる（`videoCheckPeer`）。「ここ見て」は `call` メッセージ（ホストは中継するだけ）。
- つなぎ直したときは、hello に前の接続で最後に受け取った通し番号（`collab.rev`）とホストの起動ごとの id（`collab.epoch`）を付け、ホストは同じ起動で最近の記録（1000 件）に全部残っていれば snapshot に `changes`（それ以降の変更だけ）を入れて返す（`server.rs` の `changes_since`）。無ければ今まで通り全体（`comments`）。自分の変更が混ざっていても、当て直すと衝突して何も変わらない。ページを開き直したとき（タブが変わったとき）は全体を受け取る。
- ブラウザは 20 秒ごとに `ping` を送り、`pong`（か何か）が返らなければつなぎ直す（`collabPing`）。ホストは 2 分間何も届かない接続を切る（`server.rs` の `IDLE_TIMEOUT`。裏のタブの timer は 1 分に 1 回ほどに間引かれるので、これより短くしない）。
- ホストの `--remote` で許された人には、snapshot の `remote` が付き、「⌨ ターミナル」（`#termDlg`）から `run` / `run_stop` を送れる。出力は `run_out`、終わりは `run_end`（`term`）。
  許すかどうかはホストが決める（画面で隠すだけに頼らない）。`--remote-users` に名前で挙げた人のワンタイムパスワードは、自分も打てる人かホストの人（起動時の URL で入った人。セッションの `startup`）だけが画面から発行できる（`admin_otp_handler`）。git で使えるサブコマンドやオプションを増やすときは、ほかのプログラムを動かせないか・作業フォルダの外を読み書きできないかを確かめ、`remote.rs` のテストに足す。
- 自動の参加者（hello の `agent`。`komenagare mcp`）は peers に `agent` が付き、管理者だけが `hold` で一時停止・再開できる（参加者の一覧のボタン。管理者かは snapshot の `admin`。`--otp` なら管理者のセッション、それ以外はこのパソコンから開いた人（`local_request`）。自動の参加者は管理者にしない。ホストが確かめる）。止めている間、ホストはその参加者の変更を断り（`held` を返す。`Inner.held` に client で覚えるので、つなぎ直しても止めたまま）、peers の `held` に止めた人の名前を出す。人の編集は止められない。presence の `note` は、いましていることの短い説明。
- 変更履歴は、ひとりのときは `state.changeLog`（`recordChange`）、共同編集のときはホストの記録（`history` メッセージ）を出す。
- タイムマシン（`tm`・`tmOpen`。`--remote` で許された人だけ。ホストも `can_run` で確かめる）は `tm_log` / `tm_show` / `tm_restore` で git の履歴（`workspace::snapshots` / `comments_at`）を読む。
  過去を見ている間は `tm.view`（そのときのコメントの CommentStore）を画面に出す（`state.comments` と `shown()`。画面に出すものを `store` から直接読まない）。`store` は今のまま、ほかの人の変更も当て続ける。
  `tm_show` には `edits`（`workspace::edits_at`。comments.jsonl の git blame。1行1コメントなので、各コメントを最後に変えたコミット）も付け、`tmEdits` で見ている時点で変わったもの（`tm.changed`。動画・タイムラインで囲い、リストで色を付ける）と、タイムラインの明るさ（`tmAlpha`）を決める。
  変更履歴は `tmHistory` で見ている時点までに切り出す（`tm_log` の `changes`（コミットの Change-Id）で突き合わせ、無ければ時刻で。ホストの記録より前はコミットの一覧）。
  開いている間に届いた変更は `store` に当て、`tm_log` を取り直して目盛りを足す（過去を見ているときはスクロールを動かさない）。
  編集は `tmLocked` で止める（`commitOps` など、変更を作るところで）。復元はホストが今の中身からの変更として記録・コミットし（`Hub::restore`。git reset はしない）、全員に `change` で配る。
  目盛りは右から出して `body.tm-on` の `padding-right`（`--tm-w`）で画面を押し縮める。入りきらなければ `#tmTrack` をスクロールする（1本 `TM_GAP` px。スマホはスワイプでスクロール、押して止めてからなぞると選ぶ。見ている位置は `tmEnsureVisible` で滑らかに追う）。日ごとに帯（`.tm-day`）を敷き、目盛りの長さはコミットの変更の数で伸ばし、近づけたあたりを `tmLens` で拡大鏡のように伸ばす。メニューバーは `.tb-edit` を隠して `#tmBar` を出す。
- PC の画面の配置（`LAYOUTS`・`layoutApply`）: 標準・右にリスト・右にタイムラインの3つ。出すパネル（`settings.preview` / `side` / `timeline`）と合わせて、`.layout` の格子の列・行と各パネルの置き場所を決める。
  パネルの間のすき間（`#gutV` `#gutH` `#gutC`）で大きさを変え、配置ごとに覚える（標準は前からの `sideWidth`・`tlHeight`）。スマホは今まで通りタブで切り替える（格子は使わない）。
  プレビューの枠が低くなったら、CSS のコンテナークエリでプリセットをコメント欄の右に並べる。
- 設定は1つのダイアログ（`#settingsDlg`・`settingsOpen`。メニューバーの歯車）にまとめる。タイムライン・コメントリストの歯車は、その項目を開くだけ。設定を足すときは、ここの項目（`.set-sec`）に足す（ほかの場所に設定の置き場を作らない）。
- ほかの人のカーソルと再生位置は、届いた位置（`pr.state`）へ毎フレーム寄せて出す（`peerEase`・`pr.sm`。`settings.peerSmooth`、既定でオン）。追いかける（`followApply`）などは届いた値をそのまま使う。
- プリセットのキーは各プリセットの `key`（`presetKeyOf` の形。英字は大文字、Shift なら `Shift+`。null で無し）。前に保存した key の無いものは先頭10個を 1〜9, 0 にする。ほかの操作に使っているキー（`PRESET_KEY_RESERVED`）と Ctrl・⌘・Alt との組み合わせは割り当てない（ショートカットを足したらそこにも足す）。
- イン点・アウト点（`state.range`・`rangeSet`。キー I / O、Alt で消す）は書き出しの範囲の初期値とループ再生（`settings.tlLoop`・`loopFrame`）に使う。覚えない。
- コメントリストは既定で見えている行だけ作る（`settings.listVirtual`。設定でオフにすると全部の行を作る）。本文は折り返して 10 行まで出す（`.rc` の line-clamp と `LIST_LINES`）。行の高さは本文から見積もって置き、作った行を測って直す（`listPaint`）。行の色（再生位置の行・手で選んだ行 `listPick`・ほかの人の選択）は状態から決めて、作るときと変わったときに当てる（行の要素を直接持ち続けない）。タイムラインも見える範囲のコメントだけ描く（`firstAtOrAfter`）。
- `css/`・`js/`・`lib/` にファイルを足したら `web.json` の files にも足す（`cargo test` が確かめる）。
- WebSocket のやりとり（メッセージの形や意味）を変えるときは、取り決めの版数を上げる: `web.json` の protocol、`js/app.js` の `COLLAB_PROTOCOL`、`cli/src/server.rs` の `PROTOCOL` をそろえて上げ、CLI もリリースする。
  版数を変えない変更（画面の改善など）は Web 版（GitHub Pages）を更新するだけで、ホストしている CLI にも次の起動から届く。
  Pages への公開は `pages.yml` が署名してから行う（署名のジョブは承認が要る）。署名の無い Web アプリは CLI が使わない。
- UI の文言・コメントは日本語。画面に出す言葉は `T` で書き、英語の訳を `js/i18n.js` の `EN` に足す（index.html に足した言葉も。使い方を変えたら `HELP_EN` も合わせる）。
  比べたり読み取りに使ったりする言葉（CSV の見出しなど）は `T` で包まない。
- ソースファイル（`js/`・`css/`・`cli/` の .rs・`tests/`・`index.html`・インストーラー）の冒頭には `SPDX-FileCopyrightText: 2026 Igarin` と `SPDX-License-Identifier: Apache-2.0` の2行を置く。新しいファイルにも入れる。
- ほかのプロジェクトのコードやライブラリを取り込んだら、`NOTICE` と README の「ライセンス」に追記する。

## テスト

- `node --test 'tests/*.test.js'` — Vim エンジン・コメントストア・CSV・ターミナルの色・書き出しのフレームレートのテスト
- `cargo test --manifest-path cli/Cargo.toml` — CLI のテスト（`cargo fmt` も通す）。CI は Windows でも動かし、install.ps1 と komenagare update を手元のミラーで確かめる
- 共同編集は、CLI を `--web .` 付きで起動し、Playwright で2つのブラウザをつないで確かめる（複数プロジェクト・複数タブ・`--otp` も）
- 画面と書き出しは Chromium（Playwright）で、http 配信（`npx http-server -p 8124 -s -c-1 .`）と `file://` の両方で確かめる

## リリース

`cli/Cargo.toml` の version を上げて main に入れ、Release ワークフロー（`.github/workflows/release.yml`）を main で手動実行する
（Actions の画面、または GitHub API の workflow_dispatch）。ワークフローが同じ番号のタグ（`v0.1.2` など）を作り、
`build-matrix.yml` の全ターゲット（macOS・Windows・Linux の各 CPU、Android、FreeBSD / NetBSD / illumos）向けにビルドしてリリースに載せる。
1つでもビルドできなければ公開しない。ターゲットを足すときは build-check で先に確かめる。
`SHA256SUMS` への署名（sign ジョブ）は environment「signing」の承認が要る。下書きで作ってファイルを全部載せてから公開し、公開済みのリリースは変えない（Immutable releases）。
署名の鍵を作り直すときは `python3 .github/minisign.py keygen <秘密鍵> <公開鍵>` で作り、秘密鍵を secret に、公開鍵を `cli/minisign.pub` に置いて CLI をリリースする（古い CLI は新しい鍵の署名を信じないので、`komenagare update` では上がれなくなる。install.sh / install.ps1 で入れ直してもらう）。
タグを自分で push しても同じように動く。途中で失敗したら、同じ main のまま手動実行し直せば続きから作る。
利用者は `komenagare update` で更新する。
