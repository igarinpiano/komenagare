// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// コメントの XML（ニコニコ形式）の書き出し（DOM 非依存。Node からも require できる）。
//   <packet><chat vpos="1234" mail="ue red" no="1" id="UUID">本文</chat>…</packet>
// vpos は 1/100 秒（コメントの時刻は 1/100 秒に丸めてあるので、読み直すと同じ時刻に戻る）、mail はコマンド、
// no は時刻順の通し番号。id はコメナガレのコメントを見分ける番号で、ニコニコの XML には無い属性（ほかのツールは読み飛ばす）。
// 読み込みは js/app.js の parseCommentText（<chat> の vpos・mail・id と本文を読む）。

// XML 1.0 に書けない文字（タブ・改行以外の制御文字、対になっていないサロゲート、U+FFFE / U+FFFF）を除く
function xmlClean(s){
  return String(s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}
// 本文（要素の中身）。改行はそのまま書く（CR は読むときに LF になるので、数値参照にする）
function xmlText(s){
  return xmlClean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#13;');
}
// 属性の値。空白の類は読むときに空白1つに直されるので、数値参照にする
function xmlAttr(s){
  return xmlText(s).replace(/"/g, '&quot;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;');
}
function commentsToXML(items){
  const rows = items.map((c, i) => {
    const id = c.id ? ` id="${xmlAttr(c.id)}"` : '';
    return `  <chat vpos="${Math.round(Number(c.t) * 100)}" mail="${xmlAttr(c.cmd)}" no="${i + 1}"${id}>${xmlText(c.text)}</chat>\n`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<packet>\n${rows.join('')}</packet>\n`;
}

if (typeof module !== 'undefined') module.exports = { xmlClean, xmlText, xmlAttr, commentsToXML };
