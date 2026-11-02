// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// 高速書き出し（js/export-core.js）のうち DOM を使わない部分のテスト。実行: node tests/export-core.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// classic スクリプトなので、そのまま読み込んでグローバルの関数を使う
const ctx = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../js/export-core.js'), 'utf8'), ctx);
const { exportRateOf } = ctx;
const frames = (n, step, start = 0, round = (t) => t) => Array.from({ length: n }, (_, i) => round(start + i * step));

test('コマの間隔が一定なら、そのフレームレート', () => {
  assert.equal(exportRateOf(frames(240, 1 / 120)), 120);
  assert.equal(exportRateOf(frames(240, 1 / 60, 10)), 60);
  assert.equal(exportRateOf(frames(240, 1 / 30)), 30);
  assert.equal(exportRateOf(frames(240, 1 / 25)), 25);
});

test('NTSC の 1000/1001 倍は、そのまま', () => {
  assert.equal(exportRateOf(frames(240, 1001 / 30000)), 30000 / 1001);
  assert.equal(exportRateOf(frames(240, 1001 / 120000)), 120000 / 1001);
});

test('ミリ秒に丸めた時刻（WebM など）でも一定と見なす', () => {
  const ms = (t) => Math.round(t * 1000) / 1000;
  assert.equal(exportRateOf(frames(240, 1 / 120, 0, ms)), 120);
  assert.equal(exportRateOf(frames(240, 1001 / 60000, 0, ms)), 60000 / 1001);
});

test('B フレームで並びが前後していても（デコード順）、時刻の順に見る', () => {
  const t = frames(120, 1 / 60);
  for (let i = 1; i + 1 < t.length; i += 3) [t[i], t[i + 1]] = [t[i + 1], t[i]];
  assert.equal(exportRateOf(t), 60);
  // 先頭から数えたパケットだけでは、表示順の最後のほうのコマが欠ける
  const pts = frames(260, 1 / 120), dts = [];
  for (let i = 0; i < pts.length; i += 4) dts.push(pts[i], pts[i + 3], pts[i + 2], pts[i + 1]);
  assert.equal(exportRateOf(dts.slice(0, 239)), 120);
});

test('間隔がばらばら（VFR）や、コマが少ないときは決めない', () => {
  const vfr = frames(120, 1 / 60);
  vfr.splice(50, 20);
  assert.equal(exportRateOf(vfr), null);
  assert.equal(exportRateOf(frames(5, 1 / 30)), null);
  assert.equal(exportRateOf([]), null);
});
