// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// ターミナルの色（js/term-ansi.js）のテスト。実行: node tests/term-ansi.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnsiParser, ansiColor256, ANSI_PALETTE } = require('../js/term-ansi.js');

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
