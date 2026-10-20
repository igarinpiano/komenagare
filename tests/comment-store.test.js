// コメントストア（js/comment-store.js）のテスト。実行: node tests/comment-store.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { CommentStore, uuidv7, isUuid, invertChange } = require('../js/comment-store.js');

const add = (id, t, text, cmd = '') => ({ type: 'add', id, after: { t, cmd, text } });
const fields = (s, id) => { const c = s.get(id); return c && { t: c.t, cmd: c.cmd, text: c.text }; };
const change = (...ops) => ({ id: uuidv7(), ops });

test('uuidv7: 形式・バージョン・作った順に並ぶ・時刻', () => {
  const ids = Array.from({ length: 5000 }, uuidv7);
  for (const id of ids){
    assert.ok(isUuid(id), id);
    assert.equal(id[14], '7');
    assert.ok('89ab'.includes(id[19]));
  }
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(new Set(ids).size, ids.length);
  const ms = parseInt(ids[0].replace(/-/g, '').slice(0, 12), 16);
  assert.ok(Math.abs(ms - Date.now()) < 5000);
});

test('追加・変更・削除と、同じ内容のキー', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 2, 'あ'), add('b', 1, 'い')));
  assert.deepEqual(s.comments.map(c => c.id), ['b', 'a']);
  const key = s.get('a').key;
  assert.ok(s.hasKey(key));
  s.apply(change({ type: 'update', id: 'a', before: { t: 2 }, after: { t: 0.5 } }));
  assert.deepEqual(s.comments.map(c => c.id), ['a', 'b']);
  assert.ok(!s.hasKey(key) && s.deletedKeys.has(key));
  s.apply(change({ type: 'delete', id: 'b', before: { t: 1, cmd: '', text: 'い' } }));
  assert.equal(s.size, 1);
  assert.equal(s.log.length, 3);
});

test('打ち消す変更セットで元に戻る', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x'), add('b', 2, 'y')));
  const before = JSON.stringify(s.comments);
  const { applied } = s.apply(change(
    { type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'X' } },
    { type: 'delete', id: 'b', before: { t: 2, cmd: '', text: 'y' } },
    add('c', 3, 'z'),
  ));
  s.apply(invertChange(applied), { atomic: true });
  assert.equal(JSON.stringify(s.comments), before);
});

test('3-way マージ: 別々の項目の変更はどちらも入る', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x')));
  s.apply(change({ type: 'update', id: 'a', before: { t: 1 }, after: { t: 5 } }));          // 自分: 時刻を変更
  const r = s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'y' } })); // 相手: 本文を変更
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(fields(s, 'a'), { t: 5, cmd: '', text: 'y' });
});

test('3-way マージ: 同じ項目を別々の値にすると衝突し、その項目は変えない', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x')));
  s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'mine' } }));
  const r = s.apply(change({ type: 'update', id: 'a', before: { t: 1, text: 'x' }, after: { t: 2, text: 'theirs' } }));
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0].fields, ['text']);
  assert.deepEqual(r.conflicts[0].ours, { text: 'mine' });
  assert.deepEqual(r.conflicts[0].theirs, { text: 'theirs' });
  assert.deepEqual(fields(s, 'a'), { t: 2, cmd: '', text: 'mine' }); // 衝突していない時刻は入る
});

test('3-way マージ: 同じ値への変更は衝突にしない', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x')));
  s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'y' } }));
  const r = s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'y' } }));
  assert.equal(r.conflicts.length, 0);
  assert.equal(r.applied, null);
});

test('削除と変更の衝突', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x'), add('b', 2, 'y')));
  s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'X' } }));
  // 相手は変更前の a を削除しようとした
  const r1 = s.apply(change({ type: 'delete', id: 'a', before: { t: 1, cmd: '', text: 'x' } }));
  assert.equal(r1.conflicts[0].reason, 'modified');
  assert.ok(s.has('a'));
  // こちらが削除した b を相手が変更しようとした
  s.apply(change({ type: 'delete', id: 'b', before: { t: 2, cmd: '', text: 'y' } }));
  const r2 = s.apply(change({ type: 'update', id: 'b', before: { text: 'y' }, after: { text: 'Y' } }));
  assert.equal(r2.conflicts[0].reason, 'deleted');
  // 既に削除されたものをもう一度削除しても何も起きない
  assert.equal(s.apply(change({ type: 'delete', id: 'b', before: { t: 2, cmd: '', text: 'y' } })).conflicts.length, 0);
});

test('atomic: 衝突があれば何も変えない', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x')));
  s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'mine' } }));
  const r = s.apply(change(add('b', 2, 'y'), { type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'theirs' } }), { atomic: true });
  assert.equal(r.applied, null);
  assert.equal(r.conflicts.length, 1);
  assert.ok(!s.has('b'));
});

test('同じ id で内容が違うものを追加すると衝突、同じ内容なら何もしない', () => {
  const s = new CommentStore();
  s.apply(change(add('a', 1, 'x')));
  assert.equal(s.apply(change(add('a', 1, 'x'))).conflicts.length, 0);
  assert.equal(s.apply(change(add('a', 1, 'z'))).conflicts[0].reason, 'exists');
});

test('同じ変更セットの中で同じコメントを続けて操作できる', () => {
  const s = new CommentStore();
  const r = s.apply(change(add('a', 1, 'x'), { type: 'update', id: 'a', before: { t: 1 }, after: { t: 2 } }));
  assert.equal(r.conflicts.length, 0);
  assert.deepEqual(fields(s, 'a'), { t: 2, cmd: '', text: 'x' });
  const r2 = s.apply(change({ type: 'update', id: 'a', before: { text: 'x' }, after: { text: 'y' } }, { type: 'delete', id: 'a', before: { t: 2, cmd: '', text: 'y' } }));
  assert.equal(r2.conflicts.length, 0);
  assert.ok(!s.has('a'));
  // 打ち消すと元に戻る
  s.apply(invertChange(r2.applied), { atomic: true });
  assert.deepEqual(fields(s, 'a'), { t: 2, cmd: '', text: 'x' });
});
