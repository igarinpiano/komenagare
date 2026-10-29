// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// コメントの CSV（js/comment-csv.js）のテスト。実行: node --test tests/comment-csv.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CSV_HEADER, csvGuard, csvUnguard, csvCell, commentsToCSV, parseCSV, isKomenagareCsvHeader } = require('../js/comment-csv.js');

const FIX = path.join(__dirname, 'fixtures');
const CASES = JSON.parse(fs.readFileSync(path.join(FIX, 'csv-cases.json'), 'utf8'));
// 表計算ソフトが数式の始まりとみなす文字
const DANGER = /^[=+\-@\t\r]/;

// app.js の parseCommentText の CSV の読み方と同じ（コメナガレの見出しなら「'」を外す）
function readBack(csv){
  const rows = parseCSV(csv.replace(/^﻿/, ''));
  const un = isKomenagareCsvHeader(rows[0]) ? csvUnguard : (x => x);
  return rows.slice(1).map(r => ({ t: Number(r[0]), cmd: un(r[1] ?? ''), text: un(r[2] ?? ''), id: un(r[3] ?? '') }));
}
// CSV のセル（"…" を外したあとの中身）
const cells = (csv) => parseCSV(csv.replace(/^﻿/, '')).slice(1).flatMap(r => r.slice(1));

test('書き出したセルは数式の始まりの文字で始まらない', () => {
  for (const c of cells(commentsToCSV(CASES))) assert.ok(!DANGER.test(c), JSON.stringify(c));
  // id（共同編集で他人が細工したもの）も同じ
  assert.ok(!DANGER.test(cells(commentsToCSV([{ t: 0, cmd: '', text: '', id: '=1+1' }]))[2]));
});

test('書き出して読み込むと元に戻る（細工した値も含め、全部の項目）', () => {
  assert.deepEqual(readBack(commentsToCSV(CASES)), CASES.map(c => ({ ...c, t: Number(c.t.toFixed(2)) })));
});

test('同じ値は何度書き出し・読み込みを繰り返しても変わらない', () => {
  let items = CASES;
  for (let i = 0; i < 3; i++) items = readBack(commentsToCSV(items));
  assert.deepEqual(items.map(c => [c.cmd, c.text, c.id]), CASES.map(c => [c.cmd, c.text, c.id]));
});

test('ランダムな文字列でも元に戻り、数式にならない', () => {
  // 危ない文字・「'」・区切り・引用符・改行をよく混ぜる
  const alphabet = ["'", "'", '=', '+', '-', '@', '\t', '\r', '\n', ',', '"', 'a', 'あ', ' ', '😀'];
  let seed = 12345;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const items = [];
  for (let i = 0; i < 3000; i++){
    const s = Array.from({ length: rnd(7) }, () => alphabet[rnd(alphabet.length)]).join('');
    items.push({ t: i / 4, cmd: s, text: s.split('').reverse().join(''), id: s });
  }
  const csv = commentsToCSV(items);
  for (const c of cells(csv)) assert.ok(!DANGER.test(c), JSON.stringify(c));
  assert.deepEqual(readBack(csv).map(c => [c.cmd, c.text, c.id]), items.map(c => [c.cmd, c.text, c.id]));
});

test(`「'」を足すのは数式になりうる形だけ（ふつうのコメントやコマンドは変えない）`, () => {
  for (const s of ['', 'ue', 'big red shita', '普通のコメント', 'a=b', ' =1', '＝全角', "'abc", "'", "''", 'é😀', '1+1'])
    assert.equal(csvGuard(s), s, JSON.stringify(s));
  assert.equal(csvGuard('@5'), "'@5");
  assert.equal(csvGuard('-1'), "'-1");
  assert.equal(csvGuard("'=1"), "''=1");
  // 外すのは「'」の並び＋危ない文字の形だけ
  for (const s of ["'abc", "'", "''", 'abc', "'1"]) assert.equal(csvUnguard(s), s);
  assert.equal(csvUnguard("'@5"), '@5');
  assert.equal(csvUnguard("''=1"), "'=1");
});

test('書き出しの形は決まっている（cli/src/files.rs のテストと同じファイルを使う）', () => {
  assert.equal(commentsToCSV(CASES), fs.readFileSync(path.join(FIX, 'csv-guarded.csv'), 'utf8'));
  assert.ok(commentsToCSV([]).startsWith('﻿' + CSV_HEADER + '\r\n'));
});

test('ほかのツールの CSV（見出しが違う）は書かれたまま読む', () => {
  assert.ok(isKomenagareCsvHeader(['time', 'command', 'text', 'id']));
  assert.ok(isKomenagareCsvHeader([' Time ', 'COMMAND', 'text', 'id']));
  assert.ok(!isKomenagareCsvHeader(['vpos', 'mail', 'comment']));
  assert.ok(!isKomenagareCsvHeader(['time', 'command', 'text']));
  assert.ok(!isKomenagareCsvHeader(['1.00', 'ue', 'x', 'y']));
});

test(`以前のコメナガレの CSV（「'」を足していないもの）もそのまま読める`, () => {
  // 以前は数式の対策をしていなかった。「'」で始まらない値は、そのまま読む
  const old = '﻿time,command,text,id\r\n1.00,@5,=1+1,a\r\n2.00,ue,-----,b\r\n3.00,,\'abc,c\r\n';
  assert.deepEqual(readBack(old).map(c => [c.cmd, c.text, c.id]), [['@5', '=1+1', 'a'], ['ue', '-----', 'b'], ['', "'abc", 'c']]);
});

test('セルは必要なときだけ "…" で囲む', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('a"b'), '"a""b"');
  assert.equal(csvCell('=a,b'), '"\'=a,b"');
  assert.equal(csvCell('\r='), '"\'\r="');
  assert.equal(csvCell(null), '');
});
