# komenagare（コメナガレ）

動画にニコニコ風の流れるコメントを付けて編集・書き出しするブラウザ用ツールです。

- 動画を開いて再生しながらコメントを投稿・編集（タイムライン / Vim 風エディタ）
- コメントは JSON / CSV / ニコニコ形式 XML で読み書き
- コメント付き動画を MP4 / MOV / WebM / MKV で書き出し

## 使い方

`index.html` をブラウザで開きます（GitHub Pages での公開を想定。ファイルを直接開いても動きます）。
`css/`・`js/`・`lib/` フォルダも同じ場所に置いてください。

## 開発

ビルド手順はありません。構成は `CLAUDE.md` を参照してください。

```sh
node --test 'tests/*.test.js'   # Vim エンジンとコメントストアのテスト
```

## ライセンス

Apache License 2.0（`LICENSE`）。
`lib/mediabunny-*.js` は [Mediabunny](https://github.com/Vanilagy/mediabunny)（MPL-2.0、`lib/mediabunny-LICENSE.txt`）です。
