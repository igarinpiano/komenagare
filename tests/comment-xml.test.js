// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// コメントの XML（js/comment-xml.js）のテスト。実行: node --test tests/comment-xml.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { xmlClean, xmlText, xmlAttr, commentsToXML } = require('../js/comment-xml.js');

test('時刻は 1/100 秒の vpos、コマンドは mail、通し番号と id を付ける', () => {
  const xml = commentsToXML([
    { t: 1.5, cmd: 'ue red', text: 'こんにちは', id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' },
    { t: 12.34, cmd: '', text: 'wwww' },
  ]);
  assert.equal(xml,
    '<?xml version="1.0" encoding="UTF-8"?>\n<packet>\n' +
    '  <chat vpos="150" mail="ue red" no="1" id="0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b">こんにちは</chat>\n' +
    '  <chat vpos="1234" mail="" no="2">wwww</chat>\n' +
    '</packet>\n');
});

test('誤差のある時刻も 1/100 秒に丸める', () => {
  assert.match(commentsToXML([{ t: 0.1 + 0.2, cmd: '', text: 'a' }]), /vpos="30"/);
  assert.match(commentsToXML([{ t: 1.005 * 100 / 100, cmd: '', text: 'a' }]), /vpos="10[01]"/);
});

test('本文と属性の記号を置き換える', () => {
  assert.equal(xmlText('a<b>&"c\'\n次'), 'a&lt;b&gt;&amp;"c\'\n次');
  assert.equal(xmlAttr('a<b>&"c\n\t'), 'a&lt;b&gt;&amp;&quot;c&#10;&#9;');
  // 本文で要素を閉じたり、属性を足したりできない
  const xml = commentsToXML([{ t: 0, cmd: '" x="1', text: '</chat><chat vpos="0">x' }]);
  assert.equal((xml.match(/<chat /g) || []).length, 1);
  assert.match(xml, /mail="&quot; x=&quot;1"/);
});

test('XML に書けない文字を除く', () => {
  assert.equal(xmlClean('a\u0000b\u0008c\u000bd\u001fe\tf\ng'), 'abcde\tf\ng');
  assert.equal(xmlClean('x\ud83dy'), 'xy');
  assert.equal(xmlClean('x\ude00y'), 'xy');
  assert.equal(xmlClean('x😀y'), 'x😀y');
  assert.equal(xmlClean('a￿b￾c'), 'abc');
});

test('空なら chat の無い packet', () => {
  assert.equal(commentsToXML([]), '<?xml version="1.0" encoding="UTF-8"?>\n<packet>\n</packet>\n');
});
