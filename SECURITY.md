# セキュリティポリシー

## 対象

- `komenagare` コマンド（CLI）の最新のリリース
- GitHub Pages で公開している Web 版（https://igarinpiano.github.io/komenagare/）
- インストーラー（`install.sh` / `install.ps1`）

古いリリースは修正しません。`komenagare update` で最新にしてから確かめてください。

## 報告のしかた

脆弱性は **公開の Issue やプルリクエストに書かず**、GitHub の非公開の報告で知らせてください。

1. リポジトリの [Security タブ](https://github.com/igarinpiano/komenagare/security) を開く
2. 「Report a vulnerability」から報告する（[直接開く](https://github.com/igarinpiano/komenagare/security/advisories/new)）

次のことを書いてもらえると早く対応できます。

- 影響（何ができてしまうか）と、影響を受ける版
- 再現の手順（起動したときのオプション、送ったメッセージやリクエストなど）
- 考えられる直し方（あれば）

## 対応

個人で開発しているため、対応は可能な範囲で行います。目安として、1週間以内に受け取ったことを返信し、
修正できたらリリースしてから GitHub Security Advisory で公開します。報告してくださった方のお名前は、希望があればそこに載せます。

## 特に知らせてほしいもの

- ワンタイムパスワード（`--otp`）・合言葉（`?k=`）・セッションの迂回や推測
- WebSocket や HTTP の API から、作業フォルダの外のファイルを読み書きできる
- コメントの本文やファイルの読み込みから、ほかの参加者のブラウザでスクリプトを動かせる（XSS）
- `komenagare update` やインストーラーで、チェックサムを確かめずに別のものが入る
- `--remote git` で、ほかのプログラムを動かせたり、作業フォルダの外のファイルを読み書きできたりする
- `--remote-users` で許していない人が、リモートのコマンドを打てる

## 対象外のもの

- `--no-token` で起動したホストに、だれでも入れること（そのためのオプションです）
- `--remote shell` で許した人が、ホストの PC で何でもできること（そのためのオプションです）
- ホストを動かしている PC やアカウント自体が乗っ取られていることを前提にするもの
- `--tunnel` で使う cloudflared / tailscale / ngrok 自体の問題（それぞれの提供元に報告してください）
