// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// ターミナルの色（js/term-ansi.js）のテスト。実行: node tests/term-ansi.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnsiParser, ansiColor256, ANSI_PALETTE, termLineKind } = require('../js/term-ansi.js');

const parse = (...chunks) => { const p = createAnsiParser(); return chunks.flatMap(c => p.push(c)); };

test('色のないものはそのまま', () => {
  assert.deepEqual(parse('hello\nworld'), [{ text: 'hello\nworld', style: '' }]);
});

test('前景・背景・太字・リセット', () => {
  assert.deepEqual(parse('a\x1b[31mb\x1b[1;42mc\x1b[0md\x1b[m'), [
    { text: 'a', style: '' },
    { text: 'b', style: 'color:' + ANSI_PALETTE[1] },
    { text: 'c', style: `color:${ANSI_PALETTE[1]};background:${ANSI_PALETTE[2]};font-weight:700` },
    { text: 'd', style: '' },
  ]);
  assert.deepEqual(parse('\x1b[92mx\x1b[39my'), [{ text: 'x', style: 'color:' + ANSI_PALETTE[10] }, { text: 'y', style: '' }]);
});

test('256 色と 24 ビット色', () => {
  assert.equal(ansiColor256(196), 'rgb(255,0,0)');
  assert.equal(ansiColor256(232), 'rgb(8,8,8)');
  assert.deepEqual(parse('\x1b[38;5;196mx'), [{ text: 'x', style: 'color:rgb(255,0,0)' }]);
  assert.deepEqual(parse('\x1b[48;2;1;2;3;4mx'), [{ text: 'x', style: 'background:rgb(1,2,3);text-decoration:underline' }]);
  assert.deepEqual(parse('\x1b[38:2::10:20:30mx'), [{ text: 'x', style: 'color:rgb(10,20,30)' }]);
  assert.deepEqual(parse('\x1b[38:5:21;1mx'), [{ text: 'x', style: 'color:rgb(0,0,255);font-weight:700' }]);
  assert.deepEqual(parse('\x1b[38;5;21;1mx'), [{ text: 'x', style: 'color:rgb(0,0,255);font-weight:700' }]);
});

test('かたまりの境目で切れたシーケンスは続きを待つ', () => {
  assert.deepEqual(parse('a\x1b[3', '2mb'), [{ text: 'a', style: '' }, { text: 'b', style: 'color:' + ANSI_PALETTE[2] }]);
  assert.deepEqual(parse('a\x1b', '[0mb'), [{ text: 'a', style: '' }, { text: 'b', style: '' }]);
});

test('色以外の制御は捨て、壊れた ESC で出力を止めない', () => {
  assert.deepEqual(parse('\x1b]0;title\x07a\x1b[2Kb\x1b(Bc'), [{ text: 'abc', style: '' }]);
  assert.deepEqual(parse('x\x1b\x01y', 'z'), [{ text: 'x\x01y', style: '' }, { text: 'z', style: '' }]);
});

test('git の色付きの出力', () => {
  const out = parse('\x1b[33mcommit abc\x1b[m\n\x1b[32m+add\x1b[m\n\x1b[31m-del\x1b[m\n');
  assert.deepEqual(out.map(o => o.text), ['commit abc', '\n', '+add', '\n', '-del', '\n']);
  assert.equal(out[2].style, 'color:' + ANSI_PALETTE[2]);
});

test('行の種類: 成功した git push の経過は色を付けない', () => {
  for (const l of ['To github.com:a/b.git\n', '   89fba9a..bab250a  main -> main\n', 'remote: Resolving deltas: 100% (3/3), done.\n',
    'Everything up-to-date\n', 'branch \'main\' set up to track \'origin/main\'.\n', ' * [new branch]      x -> x\n', '\n'])
    assert.equal(termLineKind(l, true), null, l);
});

test('行の種類: 失敗・警告・ヒント', () => {
  assert.equal(termLineKind(' ! [rejected]        main -> main (fetch first)\n', true), 'error');
  assert.equal(termLineKind(' ! [remote rejected] main -> main (protected branch hook declined)', true), 'error');
  assert.equal(termLineKind("error: failed to push some refs to 'x'\n", true), 'error');
  assert.equal(termLineKind('fatal: not a git repository\n', true), 'error');
  assert.equal(termLineKind('致命的なエラー: リポジトリではありません\n', true), 'error');
  assert.equal(termLineKind('remote: error: GH006: Protected branch update failed', true), 'error');
  assert.equal(termLineKind('error[E0425]: cannot find value', true), 'error');
  assert.equal(termLineKind('sh: 1: foo: not found\n', true), 'error');
  assert.equal(termLineKind('bash: foo: command not found', true), 'error');
  assert.equal(termLineKind('warning: LF will be replaced by CRLF', true), 'warn');
  assert.equal(termLineKind('hint: Updates were rejected because the remote contains work', true), 'hint');
  assert.equal(termLineKind('ヒント: …', true), 'hint');
});

test('行の種類: 標準出力はマージの衝突だけ', () => {
  assert.equal(termLineKind('error: x', false), null);
  assert.equal(termLineKind('CONFLICT (content): Merge conflict in a.txt\n', false), 'error');
  assert.equal(termLineKind('Automatic merge failed; fix conflicts and then commit the result.', false), 'error');
});
