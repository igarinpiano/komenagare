// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
(() => {
'use strict';


const $ = (s) => document.querySelector(s);
const video = $('#video'), stage = $('#stage'), canvas = $('#commentCanvas'), cctx = canvas.getContext('2d');
const list = $('#list'), textInput = $('#textInput'), cmdInput = $('#cmdInput');
const hasFS = typeof window.showOpenFilePicker === 'function' && typeof window.showSaveFilePicker === 'function';

/* ---------- 設定 ---------- */
const SIDE_W = 400; // 右のパネルの既定の幅（ドラッグで変えられる）
const TL_H = 270; // タイムラインの既定の高さ（PC）
const M_VIDEO = 0.32; // 縦向きのスマホで、動画の高さが画面の高さに占める割合の既定（タイムラインの上端をドラッグして変える）
// 画面の配置（PC）。標準: 上にプレビューと右のパネル、下にタイムライン（横いっぱい）。
// 右にリスト: 左にプレビューとタイムライン、右にパネル（縦いっぱい）。右にタイムライン: 左にプレビューとパネル、右にタイムライン。
// 大きさ（右の列の幅 w・左下の行の高さ h）は配置ごとに覚える（標準は前からの sideWidth・tlHeight）
const LAYOUTS = {
  std: { name: T('標準'), top: ['player', 'side'], bottom: 'tl', w: 'sideWidth', h: 'tlHeight', dw: SIDE_W, dh: TL_H },
  split: { name: T('右にリスト'), left: ['player', 'tl'], right: 'side', w: 'splitW', h: 'splitH', dw: SIDE_W, dh: 320 },
  splitTl: { name: T('右にタイムライン'), left: ['player', 'side'], right: 'tl', w: 'splitTlW', h: 'splitTlH', dw: 620, dh: 300 },
};
const settings = Object.assign(
  { show:true, opacity:1, pauseOnInput:false, mineBorder:true, autosave:true, saveFormat:'json', volume:1, muted:false,
    listVirtual:true, timeline:true, side:true, preview:true, layout:'std', tlHeight:TL_H, mVideo:M_VIDEO, sideWidth:SIDE_W,
    splitW:LAYOUTS.split.dw, splitH:LAYOUTS.split.dh, splitTlW:LAYOUTS.splitTl.dw, splitTlH:LAYOUTS.splitTl.dh,
    sidePane:'list', mobilePane:'timeline', tlSnap:true, tlFollow:true, tlLane:'m', tlLoop:false, presets:[], wheelMouse:'time', wheelPad:'auto', letterbox:'#000000', commentArea:'video', peerSmooth:true },
  (() => { try { return JSON.parse(localStorage.getItem('komenagare.settings') || '{}'); } catch { return {}; } })()
);
function saveSettings(){ try { localStorage.setItem('komenagare.settings', JSON.stringify(settings)); } catch {} }

/* ---------- 状態 ---------- */
// コメントの追加・変更・削除はすべて store（js/comment-store.js）の変更セットで行う
const store = new CommentStore();
// 共同編集で自分の様子（再生位置・選択・カーソル）を送るための状態（送る処理は「ほかの参加者の様子」）
const presence = { ready: false, timer: 0, last: 0, sent: '', cursor: null, dirty: false, dlgAt: 0, dlgRows: new Map() };
const state = {
  get comments(){ return shown().comments; }, layouts: [],
  changeLog: [], // この画面で行った変更（変更履歴の表示用。新しいものが後ろ）
  collab: !!document.querySelector('meta[name="komenagare-host"]'), // komenagare CLI から配信されているか（共同編集）
  fileHandle: null, fileName: null, dirty: false,
  videoName: null, videoUrl: null, videoLoaded: false, needsDraw: true, needsRelayout: false, version: 0,
  stage: STAGE, // コメントを描く範囲（基準ステージの単位。updateStage で動画に合わせる）
  range: { in: null, out: null }, // イン点・アウト点（秒。書き出しの範囲とループ再生に使う。覚えない）
};
// タイムマシン（共同編集で、ホストの --remote で許された人が、git の履歴をさかのぼって見る・戻す）。
// 過去を見ている間は view にそのときのコメントを入れて、画面（リスト・タイムライン・描画・書き出し）はそちらを出す。
// store は今のコメントのまま（ほかの人の変更も届き続ける）。編集はできない（tmLocked）
const tm = {
  on: false, list: [], idx: -1, // list: 古い順のコミット（{ id, time, author, subject }）。最後は「今」（id: null）。idx: 見ている位置
  view: null, cache: new Map(), want: null, timer: 0, refresh: 0, loading: false, restoring: false,
  hover: -1, scrub: null, h: 0, // h: 目盛りの並びの高さ（px）
  ticks: [], lensOn: [], // 描いた目盛り（{ el, y }。上から順）と、拡大鏡で伸ばしている目盛り
  // 見ている時点のコミット（今なら最新のコミット）で変わったコメントの id（時刻順。画面で目立たせて、順に飛べる）と、
  // 各コメントを最後に変えたコミット（id → { commit, time, author }）と明るさ（タイムラインで、最近変えたものほど明るい）
  changed: new Set(), changedList: [], chgPos: -1, edit: new Map(), alpha: new Map(), wantEdits: null,
};
// タイムマシンで見ている間のタイムラインの明るさ（最近変えたものほど明るい）
const tmAlpha = (id) => tm.on ? (tm.alpha.get(id) ?? 1) : 1;
// 画面に出しているコメント（タイムマシンで過去を見ているときはそのときのもの）
const shown = () => tm.view || store;
// タイムマシンで見ている間は編集させない（true なら止める）
function tmLocked(){
  if (!tm.on) return false;
  toast(T('タイムマシンで見ている間は編集できません（「終了」で今に戻ります）'), { type:'error' });
  return true;
}

/* =====================================================================
   ユーティリティ
   ===================================================================== */
function fmt(t){
  if (!isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t), h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtList(t){
  const s = Math.floor(t), h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60;
  return (h ? `${h}:` : '') + `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
}
function parseTime(str){
  if (typeof str === 'number') return str;
  str = String(str ?? '').trim(); if (!str) return NaN;
  const parts = str.split(':').map(Number);
  if (parts.some(p => !isFinite(p))) return NaN;
  return parts.reduce((acc, p) => acc*60 + p, 0);
}
function hashStr(s){ let h = 2166136261; for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function expandHex(h){ h = h.toUpperCase(); return h.length === 4 ? '#'+h[1]+h[1]+h[2]+h[2]+h[3]+h[3] : h; }
// コメントの本文・コマンドの長さの上限（ホストは本文 40 万バイト・コマンド 4000 バイトまで受け付ける）
const TEXT_MAX = 100000, CMD_MAX = 1000;
// コメントの時刻（秒）と、表示時間（@秒）の上限。けた外れの値（読み込んだファイルの書き間違いや、
// ほかの参加者が送ってきたもの）でタイムラインが延びきったり、描画が終わらなくなったりしないようにする。
// ホストも時刻は 1000 万秒までしか受け付けない（cli/src/server.rs の TIME_MAX。cli/src/render.rs の LONG_MAX も同じ値）
const TIME_MAX = 1e7, LONG_MAX = 1e6;
// 長すぎる文字列を切る（サロゲートペアの途中では切らない。半端な文字はホストが読めないため）
function clipStr(s, max){
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}
function normCmd(cmd){ return clipStr(String(cmd ?? '').trim().split(/\s+/).filter(Boolean).join(' '), CMD_MAX); }
function baseName(n){ return String(n || '').replace(/\.[^.]+$/, ''); }
function download(data, name, type){
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

function toast(msg, { action, type, timeout = 3800 } = {}){
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  const span = document.createElement('span'); span.textContent = msg; el.append(span);
  if (action){
    const b = document.createElement('button'); b.textContent = action.label;
    b.onclick = () => { action.fn(); el.remove(); };
    el.append(b); timeout = Math.max(timeout, 7000);
  }
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, timeout);
}

/* =====================================================================
   コマンド解析
   ===================================================================== */
function tokGroup(tok){
  const t = tok.toLowerCase();
  if (t === 'naka' || t === 'ue' || t === 'shita') return 'pos';
  if (t === 'big' || t === 'medium' || t === 'small') return 'size';
  if (COLOR_TABLE[t] || HEX_RE.test(t)) return 'color';
  if (t === 'defont' || t === 'gothic' || t === 'mincho') return 'font';
  if (/^@\d+(\.\d+)?$/.test(t)) return 'long';
  return 'flag:' + t;
}
const cmdCache = new Map();
function parseCmd(cmd){
  let o = cmdCache.get(cmd);
  if (o) return o;
  // コマンドの種類が増え続けても（1つずつ違う @秒 など）、覚えておく数は増やし続けない
  if (cmdCache.size >= 20000) cmdCache.clear();
  o = { pos:null, size:null, color:null, font:null, long:null, invisible:false, full:false, ender:false, live:false };
  for (const raw of cmd.split(' ')){
    if (!raw) continue;
    const t = raw.toLowerCase(), g = tokGroup(t);
    if (g === 'pos') o.pos ??= t;
    else if (g === 'size') o.size ??= t;
    else if (g === 'color') o.color ??= (COLOR_TABLE[t] || expandHex(t));
    else if (g === 'font') o.font ??= t;
    else if (g === 'long') o.long ??= clamp(parseFloat(t.slice(1)), 0.1, LONG_MAX);
    else if (t === 'invisible') o.invisible = true;
    else if (t === 'full') o.full = true;
    else if (t === 'ender') o.ender = true;
    else if (t === '_live') o.live = true;
  }
  o.pos ??= 'naka'; o.size ??= 'medium'; o.color ??= '#FFFFFF'; o.font ??= 'defont';
  cmdCache.set(cmd, o);
  return o;
}

/* =====================================================================
   コメントデータ
   ===================================================================== */
const normFields = (t, cmd, text) => ({
  t: Math.min(TIME_MAX, Math.max(0, Math.round(Number(t) * 100) / 100)), cmd: normCmd(cmd), text: clipStr(String(text ?? '').replace(/\r\n?/g, '\n'), TEXT_MAX),
});
// まだ store に入れていないコメント（id はファイルにあればそれを使う）
function makeComment(t, cmd, text, mine = false, id = null){
  const f = normFields(t, cmd, text);
  return { id: isUuid(id) ? id.toLowerCase() : uuidv7(), ...f, key: commentKey(f.t, f.cmd, f.text), mine };
}
const addOp = (c) => ({ type:'add', id: c.id, after: { t: c.t, cmd: c.cmd, text: c.text }, mine: c.mine });
const deleteOp = (c) => ({ type:'delete', id: c.id, before: { t: c.t, cmd: c.cmd, text: c.text } });
// c の時刻・コマンド・本文を変える op（変わらなければ null）
function updateOp(c, { t = c.t, cmd = c.cmd, text = c.text }){
  const f = normFields(t, cmd, text), before = {}, after = {};
  for (const k of COMMENT_FIELDS) if (f[k] !== c[k]){ before[k] = c[k]; after[k] = f[k]; }
  return Object.keys(after).length ? { type:'update', id: c.id, before, after } : null;
}
// まとめて変える op を作る。変更後に他のコメントと時刻・内容がまったく同じになるものは除く
function updateOps(changes){
  const count = new Map(store.keyCount), ops = [];
  const inc = (k, d) => count.set(k, (count.get(k) || 0) + d);
  for (const { c } of changes) inc(c.key, -1);
  let failed = 0;
  for (const ch of changes){
    const op = updateOp(ch.c, ch);
    const f = op ? { ...ch.c, ...op.after } : ch.c, key = commentKey(f.t, f.cmd, f.text);
    if (op && count.get(key) > 0){ failed++; inc(ch.c.key, 1); continue; }
    inc(key, 1);
    if (op) ops.push(op);
  }
  return { ops, failed };
}
// 変更セットを store に適用して画面に反映する。undoable なら「元に戻す」の対象にする
// 共同編集中は、ここで適用した変更をホストへ送る（send: false はホストから来た変更を反映するとき）
// conflicts に配列を渡すと、適用できなかった op（衝突）をそこに入れる
function commitOps(ops, { undoable = true, save = true, atomic = false, send = true, record = true, conflicts: out = null } = {}){
  if (!ops.length) return null;
  if (send && tmLocked()) return null;
  const { applied, conflicts } = store.apply({ id: uuidv7(), ops }, { atomic });
  if (conflicts.length){ if (out) out.push(...conflicts); else console.warn(T('変更の衝突'), conflicts); }
  if (!applied) return null;
  if (undoable) pushUndo(applied);
  if (record) recordChange(applied);
  commentsChanged();
  if (send) collabSend(applied);
  if (save){ markDirty(); autosave(); }
  return applied;
}
// 表示区間（流れるコメントは vpos の 1 秒前から）
function spanOf(c){ return spanFromVals(c.t, c.cmd); }
function spanFromVals(t, cmd){
  const o = parseCmd(cmd), dur = o.long ?? DEFAULT_DURATION, lead = o.pos === 'naka' ? NAKA_LEAD : 0;
  return { o, dur, lead, s: t - lead, e: t + dur };
}
function cmdTokensWithout(cmd, group){ return normCmd(cmd).split(' ').filter(x => x && tokGroup(x) !== group); }
function setCmdLong(cmd, dur){
  const toks = cmdTokensWithout(cmd, 'long');
  dur = Math.max(0.1, Math.round(dur * 100) / 100);
  if (Math.abs(dur - DEFAULT_DURATION) > 0.001) toks.push('@' + dur);
  return toks.join(' ');
}
function setCmdPos(cmd, pos){
  const toks = cmdTokensWithout(cmd, 'pos');
  if (pos && pos !== 'naka') toks.unshift(pos);
  return toks.join(' ');
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
// 時刻順に並んだコメントのうち、時刻が t 以上の最初の番号（無ければ長さ）
function firstAtOrAfter(cs, t){
  let lo = 0, hi = cs.length;
  while (lo < hi){ const mid = (lo + hi) >> 1; if (cs[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function fmtPrecise(t){
  const cs = Math.round(Math.max(0, t) * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, s = Math.floor(cs / 100) % 60, c = cs % 100;
  const p2 = (n) => String(n).padStart(2, '0');
  return (h ? h + ':' + p2(m) : p2(m)) + ':' + p2(s) + '.' + p2(c);
}
// まだ store にないコメントを選び出す（同じ内容は重複として除き、id がかぶれば振り直す）
function newComments(items, { skipDeleted = false } = {}){
  let dup = 0, skipped = 0;
  const out = [], keys = new Set(), ids = new Set();
  for (const c of items){
    if (!c.text.trim()) continue;
    if (skipDeleted && store.deletedKeys.has(c.key)){ skipped++; continue; }
    if (store.hasKey(c.key) || keys.has(c.key)){ dup++; continue; }
    if (store.has(c.id) || ids.has(c.id)) c.id = uuidv7();
    keys.add(c.key); ids.add(c.id); out.push(c);
  }
  return { items: out, dup, skipped };
}
function addComments(items, opts = {}){
  const r = newComments(items, opts);
  commitOps(r.items.map(addOp), opts);
  return { added: r.items.length, dup: r.dup, skipped: r.skipped };
}
function commentsChanged(){
  state.version++;
  // タイムマシンで今を見ているときは、届いた変更も「今の変更」として目立たせる。復元の確認を開いていれば数を直す
  if (tm.on && !tm.view && tm.idx >= 0) tmEdits();
  if (tm.on) tmRestoreFill();
  if (TL.sel.size) for (const id of [...TL.sel]) if (!shown().has(id)) TL.sel.delete(id);
  relayout();
  renderList();
  drawDensity();
  $('#commentCount').textContent = T`コメント ${state.comments.length}`;
  state.needsDraw = true;
  tlRelane();
  vimCommentsChanged();
}
// 共同編集中はホストが保存するので「未保存」にしない
function markDirty(){ if (state.collab) return; state.dirty = true; updateStatus(); }
function markClean(){ state.dirty = false; updateStatus(); }

/* =====================================================================
   計測とレイアウト（衝突判定）
   ===================================================================== */
const measureCtx = document.createElement('canvas').getContext('2d');
const metricCache = new Map();
function getMetrics(c){
  const mk = c.cmd + '\u0002' + c.text;
  let m = metricCache.get(mk);
  if (m) return m;
  const o = parseCmd(c.cmd);
  const lines = c.text.split('\n');
  const n = lines.length;
  const resized = !o.ender && n >= RESIZE_LINES[o.size];
  let fs = FONT_SIZE[o.size][resized ? 'r' : 'n'];
  let lh = fs * LINE_HEIGHT[o.size][resized ? 'r' : 'n'];
  measureCtx.font = `600 ${fs}px ${FONTS[o.font]}`;
  let w = 0;
  for (const ln of lines) w = Math.max(w, measureCtx.measureText(ln).width);
  let h = lh * n;
  const st = state.stage;
  if (o.pos !== 'naka'){
    const limit = o.full ? st.w : st.w * UESHITA_RANGE;
    if (w > limit){ const k = limit / w; fs *= k; lh *= k; w = limit; h *= k; }
  }
  if (h > st.h){ const k = st.h / h; fs *= k; lh *= k; w *= k; h = st.h; }
  m = { o, lines, fs, lh, w, h };
  metricCache.set(mk, m);
  return m;
}


function nakaCollide(A, B){
  if (A.end <= B.start || B.end <= A.start) return false;
  const t0 = Math.max(A.start, B.start), t1 = Math.min(A.end, B.end);
  // 位置差 d = bL - aL は時間に対して線形。重なり条件は -B.w < d < A.w。
  const d0 = nakaX(B, t0) - nakaX(A, t0), d1 = nakaX(B, t1) - nakaX(A, t1);
  return Math.min(d0, d1) < A.w && Math.max(d0, d1) > -B.w;
}
function findSlot(h, blockers){
  blockers.sort((a, b) => a.yy - b.yy);
  let y = 0;
  for (const b of blockers){
    if (y < b.yy + b.h && b.yy < y + h) y = b.yy + b.h;
  }
  return y + h <= state.stage.h + 0.01 ? y : null;
}
function relayout(){
  const out = [], st = state.stage;
  let naka = [], ue = [], shita = [];
  for (const c of state.comments){
    const m = getMetrics(c), o = m.o;
    const dur = o.long ?? DEFAULT_DURATION;
    const L = { c, o, lines:m.lines, fs:m.fs, lh:m.lh, w:m.w, h:m.h, y:0, yy:0, start:0, end:0, speed:0,
                color:o.color, font:FONTS[o.font], alpha:o.live ? 0.5 : 1, invisible:o.invisible };
    if (o.invisible){ out.push(L); continue; }
    let pool;
    if (o.pos === 'naka'){
      L.start = c.t - NAKA_LEAD; L.end = c.t + dur;
      L.speed = (st.w + L.w) / (L.end - L.start);
      naka = naka.filter(p => p.end > L.start);
      pool = naka;
    } else {
      L.start = c.t; L.end = c.t + dur;
      if (o.pos === 'ue') pool = ue = ue.filter(p => p.end > L.start);
      else pool = shita = shita.filter(p => p.end > L.start);
    }
    const blockers = o.pos === 'naka' ? pool.filter(p => nakaCollide(p, L)) : pool.slice();
    const yy = findSlot(L.h, blockers);
    if (yy === null){
      // 画面に収まらない → ランダムな高さ（キーから決定的に算出）
      L.yy = (hashStr(c.key) / 4294967296) * Math.max(0, st.h - L.h);
      L.overflow = true;
    } else {
      L.yy = yy;
      pool.push(L);
    }
    L.y = o.pos === 'shita' ? st.h - L.yy - L.h : L.yy;
    out.push(L);
  }
  state.layouts = out;
  state.needsDraw = true;
}

/* =====================================================================
   描画
   ===================================================================== */
const displayRenderer = new CommentRenderer();

// コメントを描く範囲の縦横比。既定は動画と同じ（縦長の動画なら縦長）。設定で 16:9 に固定もできる
function stageAspect(){
  const vw = video.videoWidth, vh = video.videoHeight;
  return settings.commentArea === 'wide' || !state.videoLoaded || !vw || !vh ? 16 / 9 : vw / vh;
}
function updateStage(){
  const st = stageSize(stageAspect());
  if (Math.abs(st.w - state.stage.w) < 1e-6 && Math.abs(st.h - state.stage.h) < 1e-6) return;
  state.stage = st;
  metricCache.clear();
  relayout();
  resizeCanvas();
}
function resizeCanvas(){
  // プレビュー枠の中に、書き出しと同じ範囲（動画の範囲。16:9 固定の設定なら 16:9）を収めてコメントを描く
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const a = state.stage.w / state.stage.h;
  const fw = Math.min(r.width, r.height * a), fh = fw / a;
  Object.assign(canvas.style, { left: (r.width - fw) / 2 + 'px', top: (r.height - fh) / 2 + 'px', width: fw + 'px', height: fh + 'px' });
  const w = Math.max(1, Math.round(fw * dpr)), h = Math.max(1, Math.round(fh * dpr));
  state.needsDraw = true;
  // 大きさを変えると canvas は消えるので、その場で描き直す（ResizeObserver は描画のループのあとに動くため、
  // 次のフレームまで待つと、つまみをドラッグしている間ずっと消えたままになる）
  if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; drawComments(); }
}
new ResizeObserver(() => { resizeCanvas(); drawDensity(); }).observe(stage);

function drawComments(t = video.currentTime || 0){
  if (state.needsRelayout){ state.needsRelayout = false; relayout(); }
  state.needsDraw = false;
  cctx.clearRect(0, 0, canvas.width, canvas.height);
  if (settings.show){
    displayRenderer.draw(cctx, canvas.width, canvas.height, t, state.layouts,
      { stage: state.stage, opacity: settings.opacity, mineBorder: settings.mineBorder, selected: TL.sel, highlight: tm.on ? tm.changed : null });
  }
  updateTimeUI(t);
}
function loop(){
  requestAnimationFrame(loop);
  const playing = !video.paused && !video.ended;
  const t = video.currentTime || 0;
  if (playing || state.needsDraw || state.needsRelayout) drawComments(t);
  loopFrame(playing, t);
  tlFrame(playing, t);
  vimFrame(playing, t);
  presenceFrame();
}

/* =====================================================================
   動画・コントロール
   ===================================================================== */
const ICON = {
  play:'<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause:'<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  vol:'<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  mute:'<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4z"/></svg>',
  full:'<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
  cmt:'<svg viewBox="0 0 24 24"><path d="M4 4h16v12H8.5L4 20zm3 4v2h10V8zm0 3v2h7v-2z" fill-rule="evenodd"/></svg>',
  cmtOff:'<svg viewBox="0 0 24 24"><path d="M4 4h16v12H8.5L4 20zm3 4v2h10V8zm0 3v2h7v-2z" fill-rule="evenodd"/><path d="M3 3l18 18" stroke="#eee" stroke-width="2"/></svg>',
  link:'<svg viewBox="0 0 24 24"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>',
  call:'<svg viewBox="0 0 24 24"><path d="M18 11v2h4v-2zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z"/></svg>',
};
$('#btnFull').innerHTML = ICON.full;
$('#btnLink').innerHTML = ICON.link;
$('#btnCall').innerHTML = ICON.call;
function updatePlayIcon(){
  $('#btnPlay').innerHTML = video.paused ? ICON.play : ICON.pause;
  $('#tlPlay use').setAttribute('href', video.paused ? '#i-play' : '#i-pause');
}
function updateVolIcon(){ $('#btnMute').innerHTML = (video.muted || video.volume === 0) ? ICON.mute : ICON.vol; }
function updateCommentIcon(){
  const b = $('#btnToggleComments');
  b.innerHTML = settings.show ? ICON.cmt : ICON.cmtOff;
  b.classList.toggle('off', !settings.show);
}
updatePlayIcon(); updateCommentIcon();
video.volume = settings.volume; video.muted = settings.muted;
$('#volume').value = settings.volume; updateVolIcon();

// at: 読み込んだらその位置へ（プロジェクトを切り替えて戻ってきたとき）
function loadVideo(file, { at = null } = {}){
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  state.videoUrl = URL.createObjectURL(file);
  state.videoName = file.name;
  state.videoFile = file;
  state.videoLoaded = false;
  state.videoRestoreAt = at;
  video.src = state.videoUrl;
  video.load();
  $('#emptyState').hidden = true;
  updateStatus();
  if (state.collab) collabVideoOpened(file);
}
// 動画を閉じる（共同編集でプロジェクトを切り替えたとき）
function unloadVideo(){
  if (!state.videoFile) return;
  video.pause();
  if (state.videoUrl) URL.revokeObjectURL(state.videoUrl);
  Object.assign(state, { videoUrl: null, videoName: null, videoFile: null, videoLoaded: false, videoRestoreAt: null, viewRestore: null, needsDraw: true });
  video.removeAttribute('src');
  video.load();
  updateStage();
  $('#emptyState').hidden = false;
  drawDensity(); updateTimeUI(0); updatePlayIcon(); updateStatus();
}
video.addEventListener('loadedmetadata', () => {
  state.videoLoaded = true; drawDensity(); state.needsDraw = true; updateStatus();
  updateStage();
  tlResetView();
  if (state.videoRestoreAt != null){ video.currentTime = Math.min(state.videoRestoreAt, video.duration || 0); state.videoRestoreAt = null; }
  if (state.viewRestore){ tlRestoreView(state.viewRestore); state.viewRestore = null; }
  presenceDirty(); videoCheck(); linkTry();
});
video.addEventListener('error', () => {
  if (!video.src) return;
  toast(T('この動画は再生できません（ブラウザが形式に対応していない可能性があります）'), { type:'error', timeout:6000 });
});
// 再生中に映像の大きさが変わる動画もある
video.addEventListener('resize', () => { if (state.videoLoaded) updateStage(); });
for (const ev of ['play','pause','ended']) video.addEventListener(ev, () => { updatePlayIcon(); state.needsDraw = true; });
for (const ev of ['seeked','timeupdate','loadeddata','ratechange']) video.addEventListener(ev, () => { state.needsDraw = true; });
video.addEventListener('volumechange', () => {
  updateVolIcon(); $('#volume').value = video.muted ? 0 : video.volume;
  if (!exportUsesPlayer()){ settings.volume = video.volume; settings.muted = video.muted; saveSettings(); }
});

function togglePlay(){
  if (!state.videoLoaded) return;
  if (video.paused || video.ended) video.play().catch(() => {}); else video.pause();
}
function seekTo(t){
  if (!state.videoLoaded) return;
  video.currentTime = Math.max(0, Math.min(t, video.duration || t));
  state.needsDraw = true;
}
function seekBy(d){ seekTo(video.currentTime + d); }
function toggleComments(){ settings.show = !settings.show; saveSettings(); updateCommentIcon(); state.needsDraw = true; }
function toggleFullscreen(){
  const p = $('#player');
  if (document.fullscreenElement || document.webkitFullscreenElement){
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else {
    (p.requestFullscreen || p.webkitRequestFullscreen)?.call(p);
  }
}
$('#btnPlay').onclick = togglePlay;
$('#btnMute').onclick = () => { video.muted = !video.muted; if (!video.muted && video.volume === 0) video.volume = 0.5; };
$('#volume').oninput = (e) => { video.volume = +e.target.value; video.muted = +e.target.value === 0; };
$('#rate').onchange = (e) => { video.playbackRate = +e.target.value; };
$('#btnToggleComments').onclick = toggleComments;
$('#btnFull').onclick = toggleFullscreen;
stage.addEventListener('click', togglePlay);
stage.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('fullscreenchange', resizeCanvas);

/* ---------- シークバー ---------- */
const seekEl = $('#seek'), seekFill = $('#seekFill'), seekKnob = $('#seekKnob'), seekTip = $('#seekTip');
let seekDragging = false;
function seekRatio(e){ const r = seekEl.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
seekEl.addEventListener('pointerdown', (e) => {
  if (!state.videoLoaded) return;
  seekDragging = true; seekEl.setPointerCapture(e.pointerId);
  seekTo(seekRatio(e) * video.duration);
});
seekEl.addEventListener('pointermove', (e) => {
  const r = seekRatio(e);
  seekTip.style.left = (r * 100) + '%';
  seekTip.textContent = fmt(r * (video.duration || 0));
  if (seekDragging) seekTo(r * video.duration);
});
seekEl.addEventListener('pointerup', () => { seekDragging = false; });
seekEl.addEventListener('pointercancel', () => { seekDragging = false; });

function updateTimeUI(t = video.currentTime){
  const d = video.duration, r = isFinite(d) && d > 0 ? Math.min(1, t / d) : 0;
  seekFill.style.width = (r * 100) + '%';
  seekKnob.style.left = (r * 100) + '%';
  $('#timeText').textContent = `${fmt(t)} / ${fmt(d)}`;
  // タイムラインの帯のタイムコード（打っている間は書き換えない）
  const tc = $('#tlTime'), s = fmtPrecise(t || 0);
  if (document.activeElement !== tc && tc.value !== s) tc.value = s;
  highlightCurrent(t);
}

/* ---------- イン点・アウト点とループ再生（動画編集ソフトの I / O と同じ） ----------
   範囲は書き出しの範囲の初期値と、ループ再生のくり返す範囲に使う。シークバーとタイムラインの目盛りに出す */
// 範囲（片方だけなら、もう片方は動画の始まり・終わり）。どちらも無ければ null
function rangeSpan(){
  const r = state.range, d = isFinite(video.duration) && video.duration > 0 ? video.duration : tlDuration();
  if (r.in == null && r.out == null) return null;
  const s = r.in ?? 0, e = r.out ?? d;
  return e > s + 0.05 ? { s, e } : null;
}
function rangeSet(which, t = video.currentTime || 0){
  t = Math.max(0, t);
  state.range[which] = t;
  // 逆になったら、もう片方を外す（Premiere と同じ）
  const r = state.range;
  if (r.in != null && r.out != null && r.out <= r.in + 0.05) r[which === 'in' ? 'out' : 'in'] = null;
  rangeUI();
  toast(`${which === 'in' ? T('イン点') : T('アウト点')}: ${fmtPrecise(t)}`, { timeout:1200 });
}
function rangeClear(which){
  if (which) state.range[which] = null; else state.range = { in: null, out: null };
  rangeUI();
}
function rangeUI(){
  const sp = rangeSpan(), d = video.duration, el = $('#seekRange');
  el.hidden = !sp || !(isFinite(d) && d > 0);
  if (!el.hidden){ el.style.left = (sp.s / d * 100) + '%'; el.style.width = ((sp.e - sp.s) / d * 100) + '%'; }
  $('#tlIn').classList.toggle('set', state.range.in != null);
  $('#tlOut').classList.toggle('set', state.range.out != null);
  $('#tlRangeClear').hidden = state.range.in == null && state.range.out == null;
  $('#tlLoop').classList.toggle('on', !!settings.tlLoop);
  TL.dirty = true;
}
// 再生中に範囲の終わりまで来たら始まりへ戻す（範囲が無ければ動画全体をくり返す）。リアルタイム録画の書き出し中はしない
function loopFrame(playing, t){
  const on = !!settings.tlLoop && !exportUsesPlayer(), sp = on ? rangeSpan() : null;
  const whole = on && !sp;
  if (video.loop !== whole) video.loop = whole;
  if (!playing || !sp) return;
  if (t >= sp.e - 0.03) seekTo(sp.s);
}
video.addEventListener('play', () => {
  // ループ再生で範囲の外から再生したら、範囲の始まりから
  const sp = settings.tlLoop && !exportUsesPlayer() ? rangeSpan() : null;
  if (sp && (video.currentTime < sp.s - 0.05 || video.currentTime >= sp.e - 0.03)) seekTo(sp.s);
});
video.addEventListener('loadedmetadata', rangeUI);

function drawDensity(){
  const cv = $('#density'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  cv.width = Math.max(1, Math.round(r.width * dpr)); cv.height = Math.max(1, Math.round(r.height * dpr));
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const dur = video.duration;
  if (!isFinite(dur) || dur <= 0 || !state.comments.length) return;
  const bins = Math.max(10, Math.floor(r.width / 3)), counts = new Array(bins).fill(0);
  for (const c of state.comments){ const i = Math.min(bins - 1, Math.floor(c.t / dur * bins)); if (i >= 0) counts[i]++; }
  const max = Math.max(...counts), bw = cv.width / bins;
  g.fillStyle = 'rgba(47,140,255,.55)';
  counts.forEach((n, i) => {
    if (!n) return;
    const h = Math.max(dpr, n / max * cv.height);
    g.fillRect(i * bw, cv.height - h, Math.max(1, bw - dpr * 0.5), h);
  });
}

/* =====================================================================
   コメント入力
   ===================================================================== */
let pausedForInput = false;
function autoGrow(){
  textInput.style.height = 'auto';
  textInput.style.height = Math.min(textInput.scrollHeight + 2, 110) + 'px';
  const n = [...textInput.value].length;
  const cc = $('#charCount'); cc.textContent = n; cc.classList.toggle('warn', n > 75);
}
textInput.addEventListener('input', autoGrow);
textInput.addEventListener('focus', () => {
  if (settings.pauseOnInput && state.videoLoaded && !video.paused){ video.pause(); pausedForInput = true; }
});
video.addEventListener('play', () => { pausedForInput = false; });
textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); postComment(); }
  else if (e.key === 'Escape'){ textInput.blur(); if (pausedForInput){ video.play().catch(() => {}); } }
});
cmdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); textInput.focus(); }
});
$('#btnPost').onclick = postComment;

// 再生位置にコメントを投稿する（成功したら true）
function postAtCurrentTime(text, cmd){
  if (tmLocked()) return false;
  if (!state.videoLoaded){ toast(T('先に動画を開いてください')); return false; }
  const c = makeComment(video.currentTime, cmd, text, true);
  if (store.hasKey(c.key)){ toast(T('同じ時刻に同じコメントが既にあります')); return false; }
  commitOps([addOp(c)]);
  return true;
}
function postComment(){
  const text = textInput.value.replace(/\s+$/, '');
  if (!text.trim()) return;
  if (!postAtCurrentTime(text, cmdInput.value)) return;
  textInput.value = ''; autoGrow();
  if (pausedForInput){ pausedForInput = false; video.play().catch(() => {}); }
}

/* ---------- コメントプリセット ---------- */
if (!Array.isArray(settings.presets)) settings.presets = [];
const presetBar = $('#presets');
function presetCmd(p){ return normCmd(p.cmd) || cmdInput.value; }
/* ---------- プリセットのキー ----------
   プリセットごとに好きなキーを1つ割り当てられる（p.key。null なら無し）。前は先頭10個が 1〜9, 0 に決まっていたので、
   key を持たないもの（前に保存したもの）はその割り当てにしておく。
   キーは e.key から作る: 英字は大文字にして、Shift を押していれば「Shift+」を付ける。数字・記号は Shift で文字が変わるのでそのまま。
   Ctrl・⌘・Alt との組み合わせ（ブラウザや OS が使う）と、ほかの操作に使っているキーは割り当てない */
const PRESET_KEY_RESERVED = new Set([' ', 'K', 'C', 'F', 'M', 'I', 'O', 'N', '=', '+', '-', '_', ',', '.', '<', '>', 'Shift+Z', 'Shift+A',
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab', 'Delete', 'Backspace', 'Home', 'End', 'PageUp', 'PageDown']);
function presetKeyOf(e){
  const k = e.key;
  if (!k || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Process', 'Dead', 'Unidentified', 'Compose'].includes(k) || e.isComposing) return null;
  if (k.length === 1) return /^[a-z]$/i.test(k) ? (e.shiftKey ? 'Shift+' : '') + k.toUpperCase() : k;
  return (e.shiftKey ? 'Shift+' : '') + k;
}
const presetKeyReserved = (key) => PRESET_KEY_RESERVED.has(key) || PRESET_KEY_RESERVED.has(key.replace(/^Shift\+/, ''));
// 画面に出す形（Shift は ⇧）
const presetKeyLabel = (key) => key == null ? '' : key.replace(/^Shift\+/, '⇧');
// 前に保存したプリセット（key を持たない）は、先頭10個を 1〜9, 0 にする
settings.presets.forEach((p, i) => { if (p && !('key' in p)) p.key = i < 10 ? String((i + 1) % 10) : null; });
function presetForKey(e){
  const key = presetKeyOf(e);
  return key ? settings.presets.find(p => p.key === key) : null;
}
function usePreset(p, insert){
  if (insert){
    const a = textInput.selectionStart ?? textInput.value.length, b = textInput.selectionEnd ?? a;
    textInput.value = textInput.value.slice(0, a) + p.text + textInput.value.slice(b);
    if (normCmd(p.cmd)) cmdInput.value = normCmd(p.cmd), syncPalette();
    autoGrow(); textInput.focus();
    textInput.selectionStart = textInput.selectionEnd = a + p.text.length;
    return;
  }
  if (postAtCurrentTime(p.text, presetCmd(p))) toast(T`「${p.text}」を投稿しました`, { timeout:1200 });
}
function renderPresets(){
  presetBar.replaceChildren();
  settings.presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset';
    b.title = T`${p.text}${normCmd(p.cmd) ? T`　[${normCmd(p.cmd)}]` : ''}\nクリックで投稿 / Shift+クリックで入力欄に挿入` + (p.key ? T`\nキー: ${presetKeyLabel(p.key)}` : '');
    const o = parseCmd(normCmd(p.cmd));
    if (normCmd(p.cmd) && o.color !== '#FFFFFF'){ const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color; b.append(sw); }
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = p.text.replace(/\n/g, ' ⏎ ');
    b.append(tx);
    if (p.key){ const k = document.createElement('kbd'); k.textContent = presetKeyLabel(p.key); b.append(k); }
    b.onclick = (e) => usePreset(p, e.shiftKey);
    presetBar.append(b);
  });
  if (!settings.presets.length){
    const h = document.createElement('span'); h.className = 'hint';
    h.textContent = T('よく使うコメント（888 など）を登録すると、ワンタップで投稿できます');
    presetBar.append(h);
  }
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'preset-tool';
  add.textContent = settings.presets.length ? T('⚙ 編集') : T('＋ プリセットを登録');
  add.title = T('コメントプリセットの追加・編集');
  add.onclick = openPresetDialog;
  presetBar.append(add);
}
const presetDlg = $('#presetDlg');
// 新しく足すプリセットのキー：1〜9, 0 のうち、まだ使っていないもの
function prFreeDigit(){
  const used = new Set([...$('#prList').querySelectorAll('.pr-key')].map(b => b.dataset.key));
  return ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].find(d => !used.has(d)) ?? null;
}
// キーの割り当てボタン：押してからキーを押すと割り当てる（Esc でやめる、Backspace・Delete で外す）
function prKeyButton(key){
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'pr-key';
  const show = () => {
    b.classList.remove('capturing');
    b.textContent = b.dataset.key ? presetKeyLabel(b.dataset.key) : T('キーなし');
    b.title = T('押してからキーを押すと、そのキーで投稿できます（Backspace で外す・Esc でやめる）');
  };
  if (key) b.dataset.key = key;
  show();
  b.onclick = () => { b.classList.add('capturing'); b.textContent = T('キーを押す…'); };
  b.addEventListener('blur', show);
  b.addEventListener('keydown', (e) => {
    if (!b.classList.contains('capturing')) return;
    if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape' || e.isComposing || e.keyCode === 229){ show(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete'){ delete b.dataset.key; show(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey){ toast(T('Ctrl・⌘・Alt との組み合わせは割り当てられません'), { timeout:2500 }); return; }
    const key = presetKeyOf(e);
    if (!key) return;
    if (presetKeyReserved(key)){ toast(T`${presetKeyLabel(key)} はほかの操作に使っているので割り当てられません`, { timeout:2800 }); return; }
    // ほかのプリセットに付いていたら、こちらへ付け替える
    for (const o of $('#prList').querySelectorAll('.pr-key')){
      if (o !== b && o.dataset.key === key){ delete o.dataset.key; o.textContent = T('キーなし'); toast(T`${presetKeyLabel(key)} をほかのプリセットから付け替えました`, { timeout:2200 }); }
    }
    b.dataset.key = key;
    show();
  });
  return b;
}
function prRow(p = { text:'', cmd:'', key: prFreeDigit() }){
  const row = document.createElement('div'); row.className = 'pr-row';
  const t = document.createElement('input'); t.className = 'pr-text'; t.placeholder = T('本文（例: 888）'); t.value = p.text.replace(/\n/g, '\\n');
  const c = document.createElement('input'); c.className = 'pr-cmd'; c.placeholder = T('コマンド（任意）'); c.value = p.cmd || ''; c.spellcheck = false;
  const mk = (label, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.onclick = fn; return b; };
  const up = mk('↑', T('上へ'), () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); });
  up.className = 'pr-up';
  row.append(t, c, prKeyButton(p.key), up,
    mk('↓', T('下へ'), () => { if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row); }),
    mk('✕', T('削除'), () => { row.remove(); prEmpty(); }));
  return row;
}
function prEmpty(){
  const list = $('#prList');
  list.querySelector('.pr-empty')?.remove();
  if (!list.querySelector('.pr-row')){ const e = document.createElement('div'); e.className = 'pr-empty'; e.textContent = T('まだ登録されていません。「＋ 追加」から登録してください。'); list.append(e); }
}
function openPresetDialog(){
  const list = $('#prList');
  list.replaceChildren(...settings.presets.map(p => prRow(p)));
  prEmpty();
  presetDlg.showModal();
}
$('#prAdd').onclick = () => { const r = prRow(); $('#prList').append(r); prEmpty(); r.querySelector('input').focus(); };
$('#prAddCurrent').onclick = () => {
  const text = textInput.value.replace(/\s+$/, '');
  if (!text.trim()){ toast(T('コメント入力欄が空です')); return; }
  const r = prRow({ text, cmd: normCmd(cmdInput.value), key: prFreeDigit() }); $('#prList').append(r); prEmpty();
};
$('#prCancel').onclick = () => presetDlg.close();
$('#prSave').onclick = () => {
  settings.presets = [...$('#prList').querySelectorAll('.pr-row')].map(r => ({
    text: r.querySelector('.pr-text').value.replace(/\\n/g, '\n').replace(/\s+$/, ''),
    cmd: normCmd(r.querySelector('.pr-cmd').value),
    key: r.querySelector('.pr-key').dataset.key || null,
  })).filter(p => p.text.trim());
  saveSettings(); renderPresets(); presetDlg.close();
  toast(T`プリセットを保存しました（${settings.presets.length} 件）`);
};
$('#prList').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); $('#prSave').click(); } });

/* ---------- コマンドパレット ---------- */
const PALETTE = [
  { label:T('位置'), tokens:['naka','ue','shita'] },
  { label:T('サイズ'), tokens:['medium','big','small'] },
  { label:T('色'), tokens:['white','red','pink','orange','yellow','green','cyan','blue','purple','black'] },
  { label:T('色2'), tokens:['white2','red2','pink2','orange2','yellow2','green2','cyan2','blue2','purple2','black2'] },
  { label:T('フォント'), tokens:['defont','gothic','mincho'] },
  { label:T('特殊'), tokens:['invisible','full','ender','_live'] },
];
const DEFAULT_TOKEN = { pos:'naka', size:'medium', color:'white', font:'defont' };
const palette = $('#palette');
(function buildPalette(){
  for (const grp of PALETTE){
    const lab = document.createElement('div'); lab.className = 'pl'; lab.textContent = grp.label;
    const chips = document.createElement('div'); chips.className = 'chips';
    for (const tok of grp.tokens){
      const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.dataset.tok = tok;
      if (COLOR_TABLE[tok]){
        b.classList.add('color');
        const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = COLOR_TABLE[tok];
        b.append(sw);
      }
      if (FONTS[tok]) b.style.fontFamily = FONTS[tok];
      b.append(tok);
      b.onclick = () => toggleToken(tok);
      chips.append(b);
    }
    if (grp.label === T('色2')){
      const picker = document.createElement('input'); picker.type = 'color'; picker.title = T('任意の色 (#RRGGBB)');
      picker.oninput = () => setGroupToken('color', picker.value.toUpperCase());
      chips.append(picker);
    }
    if (grp.label === T('特殊')){
      const num = document.createElement('input'); num.type = 'number'; num.min = '1'; num.max = '600'; num.step = '1';
      num.placeholder = T('@秒'); num.title = T('表示時間（秒）'); num.id = 'longInput';
      num.oninput = () => setGroupToken('long', +num.value > 0 ? '@' + (+num.value) : null);
      chips.append(num);
    }
    palette.append(lab, chips);
  }
})();
function cmdTokens(){ return cmdInput.value.trim().split(/\s+/).filter(Boolean); }
function setCmd(toks){ cmdInput.value = toks.join(' '); syncPalette(); }
function setGroupToken(group, tok){
  const toks = cmdTokens().filter(x => tokGroup(x) !== group);
  if (tok) toks.push(tok);
  setCmd(toks);
}
function toggleToken(tok){
  const g = tokGroup(tok);
  let toks = cmdTokens();
  const had = toks.some(x => x.toLowerCase() === tok);
  if (g.startsWith('flag:')) toks = had ? toks.filter(x => x.toLowerCase() !== tok) : [...toks, tok];
  else { toks = toks.filter(x => tokGroup(x) !== g); if (!had && DEFAULT_TOKEN[g] !== tok) toks.push(tok); }
  setCmd(toks);
}
function syncPalette(){
  const toks = cmdTokens().map(x => x.toLowerCase());
  const groups = new Set(toks.map(tokGroup));
  for (const b of palette.querySelectorAll('.chip')){
    const tok = b.dataset.tok, g = tokGroup(tok);
    b.classList.toggle('active', toks.includes(tok) || (!groups.has(g) && DEFAULT_TOKEN[g] === tok));
  }
  const lt = toks.find(x => tokGroup(x) === 'long');
  const li = $('#longInput'); if (li && document.activeElement !== li) li.value = lt ? lt.slice(1) : '';
}
cmdInput.addEventListener('input', syncPalette);
// コマンドパレットは画面サイズに関係なく見えるよう、入力欄の上（入らなければ下）に浮かせて表示する
function placePalette(){
  if (palette.hidden) return;
  const bar = $('.comment-bar').getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const w = Math.min(Math.max(bar.width, 340), vw - 16);
  Object.assign(palette.style, { width: w + 'px', left: Math.max(8, Math.min(bar.left, vw - w - 8)) + 'px', top: '', bottom: '', maxHeight: '' });
  const need = palette.scrollHeight;
  const above = bar.top - 8, below = vh - bar.bottom - 8;
  if (need <= above || above >= below){ palette.style.bottom = (vh - bar.top + 4) + 'px'; palette.style.maxHeight = Math.max(120, above) + 'px'; }
  else { palette.style.top = (bar.bottom + 4) + 'px'; palette.style.maxHeight = Math.max(120, below) + 'px'; }
}
function setPalette(open){
  palette.hidden = !open;
  $('#btnPalette').classList.toggle('on', open);
  if (open){ syncPalette(); placePalette(); }
}
$('#btnPalette').onclick = () => setPalette(palette.hidden);
for (const ev of ['resize', 'scroll']) window.addEventListener(ev, placePalette, { passive:true, capture: ev === 'scroll' });
document.addEventListener('fullscreenchange', () => requestAnimationFrame(placePalette));
document.addEventListener('pointerdown', (e) => {
  if (!palette.hidden && !palette.contains(e.target) && !e.target.closest('#btnPalette, #cmdInput')) setPalette(false);
});
palette.addEventListener('keydown', (e) => { if (e.key === 'Escape'){ setPalette(false); $('#btnPalette').focus(); } });

/* =====================================================================
   コメントリスト
   見えている行だけ作る（settings.listVirtual。既定でオン）。オフにすると今まで通り全部の行を作る。どちらも長い本文は折り返して出す。
   見えている行だけ作るときは、行の高さを本文から見積もって置く位置を決め、作った行は実際の高さを測って直す。
   色を付ける行（再生位置に合う行・手で選んだ行・ほかの人が選んでいる行）は状態から決め、作るときと変わったときに当てる
   ===================================================================== */
let listItems = [], currentRowIdx = -1, lastHL = NaN, listHover = false;
const listShown = new Map(); // 行の番号 → 作ってある行
const listIndex = new Map(); // コメントの id → 行の番号
let listPeerSel = new Map(); // ほかの人が選んでいるコメントの id → その人の色
// 見えている行だけ作るとき: 1行だけの行の高さ・本文の1行の高さ・本文の欄の幅・本文の文字の大きさ
let listRowH = 0, listLineH = 0, listTextW = 0, listFontPx = 12.5;
const LIST_LINES = 10; // 本文を出す行数の上限（css の .rc の line-clamp と同じ）
let listHeights = new Float64Array(0), listTops = new Float64Array(1); // 各行の高さと、上端の位置（n+1 個。最後は全体の高さ）
const listMeasured = new Map(); // コメントの id → 測った高さ（本文が同じで欄の幅も同じ間だけ使う）
let listMeasuredW = 0;
const listVirtual = () => settings.listVirtual !== false;
// 手で選んだ行（リストのクリック・「ここ見て」の「見る」・リンク）。{ ids, t: 移った時刻, until: 選んだコメントの時刻, shown }。
// 再生位置に合う行（代表の行）ではなく、選んだ行に色を付ける。ほかの場所へシークしたり、再生して選んだコメントを
// 過ぎたりしたら、今まで通り再生位置に合わせる
let listPick = null;
list.addEventListener('mouseenter', () => { listHover = true; });
list.addEventListener('mouseleave', () => { listHover = false; });
// この行に色を付けるか（手で選んだ行があればそちら、無ければ再生位置に合う行）
const listIsCurrent = (i) => listPick ? listPick.ids.has(listItems[i]?.id) : i === currentRowIdx;
function listMakeRow(i){
  const c = listItems[i];
  const o = parseCmd(c.cmd);
  const row = document.createElement('div');
  row.className = 'row' + (c.mine ? ' mine' : '') + (o.invisible ? ' inv' : '') + (listIsCurrent(i) ? ' current' : '') + (tm.on && tm.changed.has(c.id) ? ' tm-new' : '');
  row.dataset.i = i;
  const rt = document.createElement('span'); rt.className = 'rt'; rt.textContent = fmtList(c.t);
  const rc = document.createElement('span'); rc.className = 'rc'; rc.textContent = c.text;
  if (c.text.length > 300 || c.text.split('\n').length > 10) rc.title = c.text; // 10 行を超える分はマウスを重ねると出る
  const rm = document.createElement('span'); rm.className = 'rm'; rm.title = c.cmd;
  if (o.color !== '#FFFFFF'){ const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color; rm.append(sw); }
  rm.append(c.cmd);
  const del = document.createElement('button'); del.className = 'del'; del.title = T('削除'); del.textContent = '×';
  row.append(rt, rc, rm, del);
  const peer = listPeerSel.get(c.id);
  if (peer){ row.classList.add('peer-sel'); row.style.setProperty('--peer', peer); }
  if (listVirtual()) row.style.top = listTops[i] + 'px';
  return row;
}
function renderList(){
  const q = $('#search').value.trim().toLowerCase();
  listItems = q ? state.comments.filter(c => c.text.toLowerCase().includes(q) || c.cmd.toLowerCase().includes(q)) : state.comments.slice();
  listIndex.clear();
  listItems.forEach((c, i) => listIndex.set(c.id, i));
  listShown.clear();
  currentRowIdx = -1; lastHL = NaN;
  // 色を付ける行を先に決めてから行を作る
  const t = video.currentTime || 0;
  if (listPick) listPick.shown = true;
  else currentRowIdx = listIdxAt(t);
  list.classList.toggle('virtual', listVirtual());
  if (listVirtual()){
    if (!listRowH || list.clientWidth !== listMeasuredW) listMeasureRow();
    listHeights = new Float64Array(listItems.length);
    for (let i = 0; i < listItems.length; i++){ const c = listItems[i], m = listMeasured.get(c.id); listHeights[i] = m && m.text === c.text ? m.h : listEstimate(c.text); }
    listRecalc();
    const spacer = document.createElement('div'); spacer.className = 'list-spacer';
    spacer.style.height = listTops[listItems.length] + 'px';
    list.replaceChildren(spacer);
    listPaint();
  } else {
    const frag = document.createDocumentFragment();
    for (let i = 0; i < listItems.length; i++){ const row = listMakeRow(i); listShown.set(i, row); frag.append(row); }
    list.replaceChildren(frag);
  }
  if (!listItems.length){
    const em = document.createElement('div'); em.className = 'list-empty';
    em.textContent = q ? T('該当するコメントはありません') : T('コメントはまだありません。\n動画を再生しながら下の入力欄から書き込めます。');
    em.style.whiteSpace = 'pre-line';
    list.append(em);
  }
  $('#listCount').textContent = q ? T`${listItems.length} / ${state.comments.length}件` : T`${state.comments.length}件`;
  lastHL = Math.floor(t * 4);
  listMarkPeers();
}
// 行の高さの見積もりに使う大きさを測る（1行だけの行の高さ・本文の1行の高さ・本文の欄の幅）
function listMeasureRow(){
  const probe = document.createElement('div'); probe.className = 'row'; probe.style.visibility = 'hidden';
  probe.innerHTML = T('<span class="rt">00:00</span><span class="rc">あ</span><span class="rm">ue</span><button class="del">×</button>');
  list.classList.add('virtual'); list.append(probe);
  const rc = probe.querySelector('.rc');
  listRowH = probe.getBoundingClientRect().height || 25;
  listLineH = rc.getBoundingClientRect().height || 17;
  listTextW = rc.clientWidth || 200;
  listFontPx = parseFloat(getComputedStyle(rc).fontSize) || 12.5;
  probe.remove();
  // 欄の幅が変わったら、測った高さは使えない
  if (list.clientWidth !== listMeasuredW){ listMeasured.clear(); listMeasuredW = list.clientWidth; }
}
// 本文から行の高さを見積もる（折り返しの行数を文字の幅のおおよそで数える。本文は 10 行まで出す: .rc の line-clamp）
function listEstimate(text){
  let lines = 0;
  for (const seg of text.split('\n')){
    let w = 0;
    for (let k = 0; k < seg.length; k++) w += seg.charCodeAt(k) < 0x1100 ? 0.55 : 1;
    lines += Math.max(1, Math.ceil(w * listFontPx / listTextW));
    if (lines >= LIST_LINES) break;
  }
  return listRowH + listLineH * (Math.min(LIST_LINES, lines) - 1);
}
// 各行の上端の位置を計算し直す
function listRecalc(){
  const n = listHeights.length;
  listTops = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) listTops[i + 1] = listTops[i] + listHeights[i];
}
// 位置 y にある行の番号
function listIdxAtY(y){
  let lo = 0, hi = listHeights.length - 1;
  if (hi < 0) return 0;
  while (lo < hi){ const mid = (lo + hi + 1) >> 1; if (listTops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}
// 見えている範囲（と前後少し）の行だけを作り、外れた行は消す。作った行は高さを測り、見積もりと違えば位置を直す
// （見えている一番上の行が動かないようにスクロールの位置も合わせる）
function listPaint(){
  if (!listVirtual() || !listRowH) return;
  const n = listItems.length, overPx = list.clientHeight * 0.5 + 200;
  for (let pass = 0; pass < 3; pass++){
    const first = listIdxAtY(Math.max(0, list.scrollTop - overPx));
    const last = Math.min(n, listIdxAtY(list.scrollTop + list.clientHeight + overPx) + 1);
    for (const [i, row] of listShown) if (i < first || i >= last){ row.remove(); listShown.delete(i); }
    const frag = document.createDocumentFragment(), made = [];
    for (let i = first; i < last; i++) if (!listShown.has(i)){ const row = listMakeRow(i); listShown.set(i, row); frag.append(row); made.push(i); }
    list.append(frag);
    let changed = false;
    for (const i of made){
      const h = listShown.get(i).offsetHeight, c = listItems[i];
      listMeasured.set(c.id, { h, text: c.text });
      if (Math.abs(h - listHeights[i]) > 0.5){ listHeights[i] = h; changed = true; }
    }
    if (!changed) return;
    const anchor = listIdxAtY(list.scrollTop), offset = listTops[anchor] - list.scrollTop;
    listRecalc();
    for (const [i, row] of listShown) row.style.top = listTops[i] + 'px';
    const spacer = list.querySelector('.list-spacer');
    if (spacer) spacer.style.height = listTops[n] + 'px';
    if (list.scrollTop > 0) list.scrollTop = listTops[anchor] - offset;
  }
}
list.addEventListener('scroll', () => { if (listVirtual()) listPaint(); }, { passive: true });
// 欄の幅が変わったら折り返しが変わるので作り直す。高さだけなら作る行を足すだけ
let listLastW = 0;
new ResizeObserver(() => {
  if (!listVirtual() || !listItems.length) return;
  if (list.clientWidth !== listLastW){ listLastW = list.clientWidth; listRowH = 0; renderList(); }
  else listPaint();
}).observe(list);
// 行 i が見えるようにスクロールする（at: 見える範囲の上からの位置。0〜1）
function listScrollTo(i, at, always){
  const top = listVirtual() ? listTops[i] : listShown.get(i)?.offsetTop;
  if (top == null) return;
  const h = listVirtual() ? listHeights[i] : listShown.get(i).offsetHeight;
  if (!always && top >= list.scrollTop && top + h <= list.scrollTop + list.clientHeight) return;
  list.scrollTop = top - list.clientHeight * at;
  listPaint();
}
// 作ってある行の「色を付ける」を状態に合わせる
function listSyncCurrent(){
  for (const [i, row] of listShown) row.classList.toggle('current', listIsCurrent(i));
}
// 時刻 t に合う行（その時刻までに出た最後のコメント）
function listIdxAt(t){
  let lo = 0, hi = listItems.length - 1, idx = -1;
  while (lo <= hi){ const mid = (lo + hi) >> 1; if (listItems[mid].t <= t){ idx = mid; lo = mid + 1; } else hi = mid - 1; }
  return idx;
}
// cs のコメントを選んだ行として色を付ける（t はそのために移った時刻）
function listPickComments(cs, t, scroll){
  if (!cs.length) return;
  listPick = { ids: new Set(cs.map(c => c.id)), t, until: Math.max(...cs.map(c => c.t)), shown: false, scroll };
  lastHL = NaN;
  highlightCurrent(t);
}
function listUnpick(){
  if (!listPick) return;
  listPick = null;
  currentRowIdx = -1; lastHL = NaN;
  listSyncCurrent();
}
// 選んだ行のために移ったのではないシーク（シークバー・タイムライン・キー操作など）なら、再生位置に合わせる表示に戻す
video.addEventListener('seeking', () => {
  if (listPick && !(Math.abs(video.currentTime - listPick.t) < 0.05)){ listUnpick(); highlightCurrent(video.currentTime || 0); }
});
$('#search').addEventListener('input', renderList);
list.addEventListener('click', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  const c = listItems[+row.dataset.i]; if (!c) return;
  if (e.target.closest('.del')){ deleteComment(c); return; }
  seekTo(parseCmd(c.cmd).pos === 'naka' ? c.t - NAKA_LEAD : c.t);
  TL.sel = new Set([c.id]); tlSelChanged(); tlEnsureVisible(c);
  listPickComments([c], video.currentTime, false);
});
function highlightCurrent(t){
  // 再生して選んだコメントを過ぎたら、再生位置に合わせる表示に戻す
  if (listPick && t > Math.max(listPick.t, listPick.until) + 0.25) listUnpick();
  if (listPick){
    if (listPick.shown) return;
    listPick.shown = true;
    currentRowIdx = -1;
    listSyncCurrent();
    // 見えていなければ見えるところへ（「ここ見て」やリンクで移ったとき）
    if (listPick.scroll){
      const idx = Math.min(...[...listPick.ids].map(id => listIndex.get(id) ?? Infinity));
      if (isFinite(idx)) listScrollTo(idx, 0.35, false);
    }
    return;
  }
  const k = Math.floor(t * 4);
  if (k === lastHL) return;
  lastHL = k;
  const idx = listIdxAt(t);
  if (idx === currentRowIdx) return;
  listShown.get(currentRowIdx)?.classList.remove('current');
  currentRowIdx = idx;
  listShown.get(idx)?.classList.add('current');
  if (idx >= 0 && $('#autoScroll').checked && !listHover && !video.paused) listScrollTo(idx, 0.65, true);
}
function deleteComment(c){
  if (!store.has(c.id)) return;
  const ch = commitOps([deleteOp(c)]);
  if (ch) toast(T('コメントを削除しました'), { action:{ label:T('元に戻す'), fn:() => revertChange(ch) } });
}

/* =====================================================================
   ファイル入出力
   ===================================================================== */
function serialize(fmt){
  const items = state.comments.map(c => ({ t: c.t, cmd: c.cmd, text: c.text, id: c.id }));
  // CSV は表計算ソフトで数式にならないようにして書く（js/comment-csv.js）
  if (fmt === 'csv') return commentsToCSV(items);
  const body = items.length ? '[\n' + items.map(c => '    ' + JSON.stringify(c)).join(',\n') + '\n  ]' : '[]';
  return `{\n  "format": "komenagare",\n  "version": 2,\n  "comments": ${body}\n}\n`;
}
function parseCommentText(text, name = ''){
  text = text.replace(/^\ufeff/, '');
  const head = text.trimStart();
  if (/\.xml$/i.test(name) || head.startsWith('<')){
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error(T('XML の解析に失敗しました'));
    return [...doc.getElementsByTagName('chat')].map(ch => {
      const v = Number(ch.getAttribute('vpos'));
      return isFinite(v) ? makeComment(v / 100, ch.getAttribute('mail') || '', ch.textContent || '') : null;
    }).filter(Boolean);
  }
  if (/\.json$/i.test(name) || head.startsWith('{') || head.startsWith('[')){
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error(T('JSON の解析に失敗しました')); }
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.comments)) arr = data.comments;
    else if (data && (data.data?.threads || data.threads)) arr = (data.data?.threads || data.threads).flatMap(th => th.comments || []);
    if (!arr) throw new Error(T('コメントの配列が見つかりません'));
    return arr.map(it => (it && it.chat) ? it.chat : it).filter(it => it && typeof it === 'object').map(it => {
      let t = it.t ?? it.time ?? (it.vposMs != null ? it.vposMs / 1000 : (it.vpos != null ? it.vpos / 100 : null));
      if (typeof t === 'string') t = parseTime(t);
      if (t == null || !isFinite(t)) return null;
      const cmd = it.cmd ?? it.command ?? it.mail ?? (Array.isArray(it.commands) ? it.commands.join(' ') : '');
      const body = it.text ?? it.body ?? it.content ?? '';
      return makeComment(t, String(cmd), String(body), false, it.uuid ?? it.id);
    }).filter(Boolean);
  }
  // CSV
  const rows = parseCSV(text);
  if (!rows.length) return [];
  // コメナガレが書き出した CSV なら、数式にならないよう足した「'」を外す（js/comment-csv.js）
  const un = isKomenagareCsvHeader(rows[0]) ? csvUnguard : (x => x);
  let ti = 0, ci = 1, xi = 2, ii = -1, start = 0;
  if (!isFinite(parseTime(rows[0][0]))){
    const h = rows[0].map(x => x.trim().toLowerCase());
    const find = (names, def) => { const i = h.findIndex(x => names.includes(x)); return i >= 0 ? i : def; };
    ti = find(['time','t','vpos','秒','時間','時刻'], 0);
    ci = find(['command','cmd','mail','commands','コマンド'], 1);
    xi = find(['text','comment','content','body','コメント','本文'], 2);
    ii = find(['id','uuid'], -1);
    start = 1;
  }
  const out = [];
  for (let i = start; i < rows.length; i++){
    const r = rows[i], t = parseTime(r[ti]);
    if (!isFinite(t)) continue;
    out.push(makeComment(t, un(r[ci] ?? ''), un(r[xi] ?? ''), false, ii >= 0 && r[ii] != null ? un(r[ii]) : null));
  }
  return out;
}

function defaultFileName(ext){
  const b = state.fileName ? baseName(state.fileName) : (state.videoName ? baseName(state.videoName) + '.comments' : 'comments');
  return `${b}.${ext}`;
}
function updateStatus(){
  $('#videoStatus').textContent = T('動画: ') + (state.videoName || T('なし'));
  const fs = $('#fileStatus');
  fs.replaceChildren();
  const name = document.createElement('span');
  name.textContent = state.collab ? '' : T('コメント: ') + (state.fileName || T('新規'));
  fs.append(name, ' ');
  const st = document.createElement('span');
  if (state.dirty){ st.className = 'dirty'; st.textContent = T('● 未保存'); }
  else if (state.fileName){ st.className = 'clean'; st.textContent = T('✓ 保存済み'); }
  fs.append(st);
  if (state.fileHandle && settings.autosave){ fs.append(T(' · 自動保存')); }
  $('#btnSave').classList.toggle('dirty', !!state.dirty);
  $('#fsNote').textContent = hasFS
    ? T('このブラウザは開いたコメントファイルへの直接保存に対応しています。保存時にはファイル側に増えたコメントも取り込んでから書き込みます。')
    : T('このブラウザはファイルへの直接保存に非対応のため、保存はダウンロードになります（Chrome / Edge 推奨）。');
}

async function ensurePerm(h){
  const opt = { mode:'readwrite' };
  try {
    if (h.queryPermission && (await h.queryPermission(opt)) === 'granted') return true;
    if (h.requestPermission) return (await h.requestPermission(opt)) === 'granted';
  } catch {}
  return true;
}
async function writeHandle(h, mergeFirst){
  if (!(await ensurePerm(h))) throw new Error(T('ファイルへの書き込みが許可されませんでした'));
  if (mergeFirst){
    try {
      const f = await h.getFile();
      const txt = await f.text();
      if (txt.trim()){
        const r = addComments(parseCommentText(txt, f.name), { skipDeleted:true, undoable:false, save:false });
        if (r.added) toast(T`ファイル側にあった新しいコメント ${r.added} 件を取り込みました`);
      }
    } catch (e) { console.warn('re-read failed', e); }
  }
  const fmt = /\.csv$/i.test(h.name) ? 'csv' : 'json';
  const w = await h.createWritable();
  await w.write(serialize(fmt));
  await w.close();
  state.fileName = h.name;
  markClean();
}
async function save({ saveAs = false } = {}){
  if (!saveAs && state.fileHandle){ await writeHandle(state.fileHandle, true); return true; }
  if (hasFS){
    let h;
    try {
      h = await window.showSaveFilePicker({
        suggestedName: defaultFileName(settings.saveFormat),
        types: [
          { description:T('コメントファイル (JSON)'), accept:{ 'application/json':['.json'] } },
          { description:T('コメントファイル (CSV)'), accept:{ 'text/csv':['.csv'] } },
        ],
      });
    } catch (e) { if (e.name === 'AbortError') return false; throw e; }
    state.fileHandle = h;
    await writeHandle(h, false);
    toast(T`${h.name} に保存しました`);
    return true;
  }
  const fmt = settings.saveFormat;
  const name = defaultFileName(fmt);
  download(serialize(fmt), name, fmt === 'csv' ? 'text/csv' : 'application/json');
  state.fileName = name;
  markClean();
  toast(T`${name} をダウンロードしました`);
  return true;
}
function doSave(opts){ save(opts).catch(e => toast(T('保存に失敗しました: ') + e.message, { type:'error' })); }

let saving = null, savePending = false;
function autosave(){
  if (!settings.autosave || !state.fileHandle) return;
  if (saving){ savePending = true; return; }
  saving = writeHandle(state.fileHandle, true)
    .catch(e => toast(T('自動保存に失敗しました: ') + e.message, { type:'error' }))
    .finally(() => { saving = null; if (savePending){ savePending = false; autosave(); } });
}

function loadReplace(text, name, handle){
  let items;
  try { items = parseCommentText(text, name); }
  catch (e) { toast(`${name}: ${e.message}`, { type:'error' }); return; }
  if (state.collab){
    // 共同編集中は全体を入れ替えず、ほかの人のコメントを残したまま追加する
    const r = addComments(items);
    toast(T`${name} から ${r.added} 件のコメントを追加しました（共同編集中は置き換えずに追加します）` + (r.dup ? T`　重複 ${r.dup} 件は除外` : ''), { timeout:6000 });
    return;
  }
  store.reset();
  history.undo.length = 0; history.redo.length = 0; updateUndoUI();
  state.changeLog.length = 0; histChanged();
  TL.sel.clear();
  const n = newComments(items);
  store.reset(n.items);
  commentsChanged();
  const r = { added: n.items.length, dup: n.dup };
  const editable = handle && /\.(json|csv)$/i.test(name);
  state.fileHandle = editable ? handle : null;
  state.fileName = /\.(json|csv)$/i.test(name) ? name : null;
  markClean();
  if (!/\.(json|csv)$/i.test(name)) state.dirty = r.added > 0, updateStatus();
  toast(T`${name} から ${r.added} 件のコメントを読み込みました` + (r.dup ? T`（重複 ${r.dup} 件を除外）` : ''));
  vimReload(true);
}
async function mergeFiles(files){
  let ok = 0;
  const items = [];
  for (const f of files){
    try { items.push(...parseCommentText(await f.text(), f.name)); ok++; }
    catch (e) { toast(`${f.name}: ${e.message}`, { type:'error' }); }
  }
  if (!ok) return;
  const { added, dup, skipped } = addComments(items, { skipDeleted:true });
  let msg = T`${ok} ファイルをマージ: ${added} 件追加`;
  if (dup) msg += T` / 重複 ${dup} 件`;
  if (skipped) msg += T` / この作業中に削除したもの ${skipped} 件は除外`;
  toast(msg, { timeout:5000 });
}

const COMMENT_TYPES = [{ description:T('コメントファイル'), accept:{ 'application/json':['.json'], 'text/csv':['.csv'], 'text/xml':['.xml'] } }];
$('#btnOpenComments').onclick = async () => {
  if (state.dirty && state.comments.length &&
      !confirm(T('未保存のコメントがあります。破棄して別のファイルを開きますか？\n（今のコメントに追加したい場合は「マージ」を使ってください）'))) return;
  if (hasFS){
    try {
      const [h] = await window.showOpenFilePicker({ types: COMMENT_TYPES });
      const f = await h.getFile();
      loadReplace(await f.text(), f.name, h);
    } catch (e) { if (e.name !== 'AbortError') toast(T('開けませんでした: ') + e.message, { type:'error' }); }
  } else $('#fileComments').click();
};
$('#fileComments').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) loadReplace(await f.text(), f.name, null);
};
$('#btnMerge').onclick = async () => {
  if (hasFS){
    try {
      const hs = await window.showOpenFilePicker({ types: COMMENT_TYPES, multiple:true });
      mergeFiles(await Promise.all(hs.map(h => h.getFile())));
    } catch (e) { if (e.name !== 'AbortError') toast(T('開けませんでした: ') + e.message, { type:'error' }); }
  } else $('#fileMerge').click();
};
$('#fileMerge').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length) mergeFiles(fs); };
$('#btnSave').onclick = () => doSave();
$('#btnSaveAs').onclick = () => doSave({ saveAs:true });
$('#btnOpenVideo').onclick = () => $('#fileVideo').click();
$('#fileVideo').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadVideo(f); };

/* ---------- ドラッグ＆ドロップ ---------- */
const isVideoFile = (f) => /^video\//.test(f.type) || /\.(mp4|m4v|mov|qt|webm|mkv|ogv|avi|ts|m2ts|mts|3gp)$/i.test(f.name);
const isCommentFile = (f) => /\.(json|csv|xml)$/i.test(f.name) || /json|csv|xml/.test(f.type);
const dropOverlay = $('#dropOverlay');
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropOverlay.classList.add('show'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--dragDepth <= 0){ dragDepth = 0; dropOverlay.classList.remove('show'); } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove('show');
  // ハンドル取得（上書き保存に使う）はイベント中に同期的に開始する必要がある。
  // 安全でないページ（http の LAN のアドレスなど）で呼ぶと Chrome はタブごと落ちるので、https・localhost のときのコメントファイルだけにする
  const entries = [...e.dataTransfer.items].filter(i => i.kind === 'file').map(i => {
    const file = i.getAsFile();
    const want = window.isSecureContext && typeof i.getAsFileSystemHandle === 'function' && file && !isVideoFile(file) && isCommentFile(file);
    return { file, handleP: want ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null) };
  });
  handleDropped(entries);
});
async function handleDropped(entries){
  const vids = entries.filter(x => x.file && isVideoFile(x.file));
  const cmts = entries.filter(x => x.file && !isVideoFile(x.file) && isCommentFile(x.file));
  if (vids.length) loadVideo(vids[0].file);
  if (!cmts.length){ if (!vids.length) toast(T('対応していないファイルです'), { type:'error' }); return; }
  if (cmts.length === 1 && !state.comments.length){
    const h = await cmts[0].handleP;
    loadReplace(await cmts[0].file.text(), cmts[0].file.name, h && h.kind === 'file' ? h : null);
  } else {
    mergeFiles(cmts.map(x => x.file));
  }
}

/* =====================================================================
   書き出し（コメ付き動画）
   ===================================================================== */
const MB_URL = new URL('lib/mediabunny-1.61.6.min.js', location.href).href;
const CONTAINERS = {
  mp4:  { label:'MP4',  rec:['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'] },
  mov:  { label:'MOV',  rec:[] },
  webm: { label:'WebM', rec:['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'] },
  mkv:  { label:'MKV',  rec:['video/x-matroska;codecs=avc1,opus', 'video/x-matroska'] },
};
function pickMime(container){
  if (typeof MediaRecorder === 'undefined') return null;
  const list = container ? CONTAINERS[container].rec : Object.values(CONTAINERS).flatMap(c => c.rec);
  return list.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || null;
}
const canFastExport = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'
  && (location.protocol === 'file:' || (typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined'));
let audioGraph = null;
function ensureAudioGraph(){
  if (audioGraph) return audioGraph;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    const actx = new AC();
    const src = actx.createMediaElementSource(video);
    const speaker = actx.createGain();
    const dest = actx.createMediaStreamDestination();
    src.connect(speaker); speaker.connect(actx.destination); src.connect(dest);
    audioGraph = { actx, speaker, dest };
  } catch (e) { console.warn('audio graph failed', e); }
  return audioGraph;
}
function seekAndWait(t){
  return new Promise(res => {
    let done = false;
    const fin = () => { if (done) return; done = true; video.removeEventListener('seeked', fin); res(); };
    video.addEventListener('seeked', fin);
    video.currentTime = t;
    setTimeout(fin, 4000);
  });
}

const exportState = { running:false, cancel:false, mode:null, worker:null, progress:0, label:'' };
const exportDlg = $('#exportDlg');
// プレーヤーを使って書き出している間（リアルタイム録画・コマ送り）はダイアログを閉じられない
const exportUsesPlayer = () => exportState.running && exportState.mode !== 'fast';
function expSetBusy(on){
  exportState.running = on;
  $('#expProgressBox').hidden = !on && !$('#expText').textContent;
  $('#expStartBtn').hidden = on;
  $('#expClose').disabled = exportUsesPlayer();
  $('#expCancel').hidden = !on;
  $('#expBg').hidden = !(on && exportState.mode === 'fast');
  for (const el of $('#expForm').querySelectorAll('select,input')) el.disabled = on;
  $('#expForm').style.opacity = on ? .5 : 1;
  const b = $('#btnExport');
  b.classList.toggle('busy', on && exportState.mode === 'fast');
  if (!on) b.querySelector('.lbl').textContent = T('書き出し');
}
function expProgress(p, text){
  exportState.progress = p;
  $('#expBar').style.width = (p * 100).toFixed(1) + '%';
  $('#expText').textContent = text;
  if (exportState.running && exportState.mode === 'fast') $('#btnExport').querySelector('.lbl').textContent = T`書き出し中 ${Math.floor(p * 100)}%`;
}
// 解像度の選択肢（短い辺の長さ）。元動画と同じ大きさ・それより小さい標準の大きさ・1080p 以下
const EXP_RES = [[4320, '8K'], [2160, '4K'], [1440, '1440p'], [1080, '1080p'], [720, '720p'], [480, '480p']];
// ブラウザで書き出すには大きい目安（4K より画素が多い・長い辺が 4096 を超える。H.264 のハードウェアエンコーダーの多くはここまで）
const expLarge = (W, H) => W * H > 3840 * 2160 || Math.max(W, H) > 4096;
// 保存先へ直接書けないブラウザで、一度に持てる出力の大きさ（変換ライブラリの上限）
const EXP_MEM_MAX = 4 * 1024 ** 3;
const EXP_AUDIO_BPS = 192000;
const EXP_MIME = { mp4:'video/mp4', mov:'video/quicktime', webm:'video/webm', mkv:'video/x-matroska' };
// 保存先を先に選んでもらい、そこへ少しずつ書く（Chrome / Edge など）。大きな動画もメモリに持たずに書き出せる
const canSaveStream = () => typeof window.showSaveFilePicker === 'function';
// 元動画の映像のビットレートとフレームレート（書き出しの画面を開いたときに調べる）
const expSrc = { file: null, vbps: 0, fps: 0, done: false };
async function expProbeSource(){
  const file = state.videoFile;
  if (!file || expSrc.file === file) return;
  Object.assign(expSrc, { file, vbps: 0, fps: 0, done: false });
  try {
    const MB = await loadMediabunny();
    const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(file) });
    const [vt, at, dur] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack(), input.computeDuration()]);
    const fps = vt ? (await vt.computePacketStats(120)).averagePacketRate : 0;
    const abps = at ? (await at.computePacketStats(200)).averageBitrate : 0;
    if (expSrc.file !== file) return;
    expSrc.fps = fps > 0 && isFinite(fps) ? fps : 0;
    if (dur > 0) expSrc.vbps = Math.max(0, file.size * 8 / dur - (abps || 0));
  } catch (e){ console.warn(T('動画の情報を読めませんでした'), e); }
  if (expSrc.file === file) expSrc.done = true;
  if (expSrc.file === file && exportDlg.open && !exportState.running){ expFillBitrate(); expSyncForm(); }
}
const roundMbps = (bps) => { const m = bps / 1e6; return (m < 10 ? Math.round(m * 10) / 10 : Math.round(m)) * 1e6; };
const fmtMbps = (bps) => roundMbps(bps) / 1e6 + ' Mbps';
// 解像度とフレームレートに合ったビットレート（1080p 30fps で 8 Mbps。画素の数に合わせて増やし、30fps を超えるなら 1.5 倍、60fps を超えるなら 2 倍）
function expRecommendBps(W, H, fps){
  const r = W * H / (1920 * 1080);
  return roundMbps((r >= 1 ? 8 * r : 8 * r ** 0.75) * ((fps || 30) > 60 ? 2 : (fps || 30) > 30 ? 1.5 : 1) * 1e6);
}
const expFpsOf = () => +$('#expFps').value || expSrc.fps || 30;
function expFillBitrate(){
  const sel = $('#expBitrate'), keep = sel.value || 'src';
  const { W, H } = exportSize(+$('#expRes').value || 720);
  sel.replaceChildren();
  const add = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.append(o); };
  // 元動画と同じ（既定）。調べ終わるまでは「調べています」と出し、その間に始めたら解像度に合わせる。調べられなければ出さない
  if (expSrc.vbps > 0) add('src', T`元動画と同じ（約 ${fmtMbps(expSrc.vbps)}）`);
  else if (!(expSrc.done && expSrc.file === state.videoFile)) add('src', T('元動画と同じ（調べています…）'));
  add('auto', T`解像度に合わせる（${fmtMbps(expRecommendBps(W, H, expFpsOf()))}）`);
  for (const m of [2, 4, 8, 16, 30, 50, 80, 120]) add(m, `${m} Mbps`);
  sel.value = [...sel.options].some(o => o.value === keep) ? keep : 'auto';
}
function expBitrate(W, H){
  const v = $('#expBitrate').value;
  return v === 'src' && expSrc.vbps > 0 ? roundMbps(expSrc.vbps) : v === 'auto' || v === 'src' || !v ? expRecommendBps(W, H, expFpsOf()) : +v * 1e6;
}
// 大きな動画向けに CLI（komenagare render）のコマンドを作る
function expCliCmd(o){
  const q = (v) => /^[\w.\/:-]+$/.test(v) ? v : `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
  const parts = ['komenagare render', q(state.videoName || 'video.mp4')];
  if (!state.collab) parts.push('-c', q(state.fileName || defaultFileName('json')));
  parts.push('--height', o.H);
  if (settings.commentArea === 'wide') parts.push('--wide');
  if (o.start > 0) parts.push('--start', fmtPrecise(o.start));
  if (o.end < video.duration - 0.01) parts.push('--end', fmtPrecise(o.end));
  return parts.join(' ');
}
function expCliHint(o){
  const d = document.createElement('div'); d.className = 'exp-hint';
  const c = document.createElement('code'); c.textContent = expCliCmd(o);
  d.append(T('大きな動画は、CLI の komenagare render で書き出すのがおすすめです（ffmpeg で書き出すので、ブラウザのメモリやエンコーダーの制限を受けません）。')
    + (state.collab ? T('作業フォルダで: ') : T('コメントを JSON で保存してから、同じフォルダで: ')), c);
  return d;
}
const expWarn = (text) => { const d = document.createElement('div'); d.className = 'exp-hint'; d.textContent = text; return d; };
// 見込みの大きさ（バイト）
const expEstimate = (o) => (o.vbps + (o.audio ? EXP_AUDIO_BPS : 0)) * Math.max(0, o.end - o.start) / 8;
const fmtBytes = (n) => n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(1) + ' GB' : Math.max(0.1, n / 1024 ** 2).toFixed(1) + ' MB';
let expCheckSeq = 0;
function expSyncForm(){
  const fast = $('#expMode').value === 'fast';
  const cont = $('#expContainer');
  for (const o of cont.options) o.disabled = !fast && !pickMime(o.value);
  if (cont.selectedOptions[0]?.disabled) cont.value = [...cont.options].find(o => !o.disabled)?.value || 'mp4';
  $('#expMuteRow').hidden = fast;
  if (!fast && $('#expFps').value === '0') $('#expFps').value = '30';
  $('#expFps').options[0].disabled = !fast;
  const o = readExportOptions(), est = expEstimate(o);
  const notes = [];
  let ok = true, out;
  if (fast){
    out = T`${CONTAINERS[cont.value].label}（確かめています…）`;
    notes.push(T('動画ファイルを直接読み込んで変換するので、再生するより速く書き出せます。')
      + (fastExportInWorker() ? T('処理はバックグラウンドで行うため、書き出し中もほかの作業やタブの切り替えができます。') : T('ファイルを直接開いているため、このタブで処理します（書き出し中はタブを開いたままにしてください）。'))
      + T('フレームレートを動画より高くすると、映像は元のコマのまま、コメントだけが指定したフレームレートで滑らかに動きます。')
      + (canSaveStream() ? T('書き出し開始で保存先を選ぶと、そこへ少しずつ書き込みます（長い動画もメモリをあまり使いません）。') : ''));
  } else {
    const mime = pickMime(cont.value);
    const canCapture = typeof HTMLCanvasElement.prototype.captureStream === 'function';
    ok = !!(mime && canCapture);
    out = ok ? mime : T('このブラウザはこの形式での録画に対応していません');
    notes.push(T('動画を実際に等倍で再生しながら録画するため、動画の長さと同じ時間がかかります。録画中はこのタブを前面に表示したままにしてください。パソコンの処理が追いつかないと、指定したフレームレートより粗くなることがあります。高速書き出しが使えない動画や環境向けです。'));
    if (o.fps > 60) notes.push(T('等倍の録画は画面の描き換え（多くの画面で 1 秒に 60 回）に合わせて描くため、60 fps を超えるフレームレートにしても同じコマが続くことがあります。滑らかな 120 fps には高速書き出しを使ってください。'));
  }
  const nodes = notes.map(t => document.createTextNode(t));
  if (fast && !canSaveStream() && est > EXP_MEM_MAX * 0.9)
    nodes.push(expWarn(T`見込みの大きさ（約 ${fmtBytes(est)}）が、このブラウザで一度に書き出せる 4 GB を超えそうです。ビットレートを下げるか、範囲を分けて書き出してください（Chrome / Edge なら保存先へ直接書き出せるので、この制限はありません）。`));
  if (expLarge(o.W, o.H)){
    nodes.push(expWarn(T`この大きさ（${o.W}×${o.H}）はブラウザでの書き出しに時間がかかり、パソコンによっては途中で失敗することがあります。`));
    nodes.push(expCliHint(o));
  }
  $('#expNote').replaceChildren(...nodes);
  $('#expFormat').textContent = out;
  $('#expStartBtn').disabled = !ok;
  if (fast) expCheckCodec(o, est);
}
// この大きさ・形式でエンコードできるかを確かめて、使うコーデックを出す（できなければ書き出せる形式か CLI を案内する）
async function expCheckCodec(o, est){
  const seq = ++expCheckSeq;
  const CODEC = { avc:'H.264', hevc:'H.265', vp9:'VP9', vp8:'VP8', av1:'AV1' };
  const size = T`・見込み 約 ${fmtBytes(est)}`;
  let codec = null, others = [];
  try {
    const MB = await loadMediabunny();
    codec = await exportPickCodec(MB, o.container, o.W, o.H, o.vbps);
    if (!codec) for (const c of Object.keys(CONTAINERS)) if (c !== o.container && await exportPickCodec(MB, c, o.W, o.H, o.vbps)) others.push(CONTAINERS[c].label);
  } catch (e){ console.warn(e); if (seq === expCheckSeq) $('#expFormat').textContent = `${CONTAINERS[o.container].label}${size}`; return; }
  if (seq !== expCheckSeq || exportState.running) return;
  if (codec){
    $('#expFormat').textContent = T`${CONTAINERS[o.container].label}・${CODEC[codec] || codec}${size}`
      + ((o.container === 'mp4' || o.container === 'mkv') && codec !== 'avc' ? T`（この大きさ・環境では H.264 が使えないため ${CODEC[codec] || codec}。古いプレーヤーでは再生できないことがあります）` : '');
    // H.264 のソフトウェアエンコーダー（OpenH264）は 60fps までしか見込まないので、それより上ではビットレートが指定より大きくなる
    if (codec === 'avc' && (o.fps || expSrc.fps) > 60.5)
      $('#expNote').append(expWarn(T('60 fps を超える H.264 は、パソコンによっては（ソフトウェアで変換するとき）指定したビットレートの 2 倍ほどになり、見込みより大きくなることがあります。大きさを抑えたいときは、ビットレートを下げるか WebM（VP9）を選んでください。')));
    $('#expStartBtn').disabled = false;
    return;
  }
  $('#expFormat').textContent = T`このブラウザでは、この大きさ（${o.W}×${o.H}）を ${CONTAINERS[o.container].label} で書き出せません。`
    + (others.length ? T`${others.join(' / ')} なら書き出せます。` : T('解像度を下げてください。'));
  $('#expStartBtn').disabled = true;
  if (!expLarge(o.W, o.H)) $('#expNote').append(expCliHint(o));
}
$('#expMode').onchange = expSyncForm;
$('#expContainer').onchange = expSyncForm;
$('#expRes').onchange = () => { expFillBitrate(); expSyncForm(); };
$('#expFps').onchange = () => { expFillBitrate(); expSyncForm(); };
$('#expBitrate').onchange = expSyncForm;
for (const id of ['#expStart', '#expEnd']) $(id).addEventListener('change', expSyncForm);
$('#expAudio').addEventListener('change', expSyncForm);
$('#btnExport').onclick = () => {
  if (exportState.running){ exportDlg.showModal(); return; }
  if (!state.videoLoaded){ toast(T('先に動画を開いてください')); return; }
  // 解像度は短い辺の長さで選ぶ（縦長なら幅。1080p なら 1080×1920）
  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const same = state.stage.w >= state.stage.h ? vh : vw;
  const res = $('#expRes'); res.replaceChildren();
  const label = (v, name) => { const { W, H } = exportSize(v); return `${name} (${W}×${H})` + (expLarge(W, H) ? T(' ※大きい') : ''); };
  const opts = [[same, label(same, T('元動画と同じ'))]];
  for (const [v, name] of EXP_RES) if (v !== same && (v < same || v <= 1080)) opts.push([v, label(v, name)]);
  for (const [v, l] of opts){ const o = document.createElement('option'); o.value = v; o.textContent = l; res.append(o); }
  // 元動画が大きいときは、大きくない中でいちばん大きいものを選んでおく（元動画と同じも選べる）
  const fit = opts.find(([v]) => { const { W, H } = exportSize(v); return !expLarge(W, H); });
  res.value = fit ? fit[0] : same;
  // イン点・アウト点があれば、その範囲を書き出す
  const sp = rangeSpan();
  $('#expStart').value = sp ? fmtPrecise(sp.s) : '0:00';
  $('#expEnd').value = sp ? fmtPrecise(Math.min(sp.e, video.duration)) : fmt(video.duration);
  const fastOk = canFastExport();
  $('#expMode').options[0].disabled = !fastOk;
  $('#expMode').value = fastOk ? 'fast' : 'realtime';
  if (fastOk) $('#expFps').value = '0';
  $('#expText').textContent = ''; $('#expHint').replaceChildren(); $('#expBar').style.width = '0%';
  $('#expBitrate').replaceChildren();
  expFillBitrate();
  expSyncForm();
  expSetBusy(false);
  exportDlg.showModal();
  expProbeSource();
};
$('#expClose').onclick = () => { if (!exportUsesPlayer()) exportDlg.close(); };
$('#expBg').onclick = () => { exportDlg.close(); toast(T('書き出しをバックグラウンドで続けます（上の「書き出し中」ボタンで進み具合を確認できます）'), { timeout:5000 }); };
exportDlg.addEventListener('cancel', (e) => { if (exportUsesPlayer()) e.preventDefault(); });
$('#expCancel').onclick = () => {
  exportState.cancel = true;
  if (exportState.worker) exportState.worker.postMessage({ type:'cancel' });
  if (exportState.ctl){ exportState.ctl.canceled = true; exportState.ctl.conv?.cancel().catch(() => {}); }
};
// メモリが足りない・出力が大きすぎるときのエラー
const expMemError = (e) => /array ?buffer|allocation failed|out of memory|maximum size|RangeError|QuotaExceeded/i.test(`${e?.name} ${e?.message}`);
$('#expStartBtn').onclick = () => {
  const o = readExportOptions();
  const run = $('#expMode').value === 'fast' ? runFastExport : runRealtimeExport;
  $('#expHint').replaceChildren();
  run().catch(e => {
    console.error(e);
    expSetBusy(false);
    expProgress(0, T('失敗しました: ') + e.message);
    const hint = [];
    if (expMemError(e)) hint.push(expWarn(canSaveStream()
      ? T('メモリが足りなかったようです。ビットレートや解像度を下げるか、範囲を分けて書き出してください。')
      : T('メモリが足りないか、出力が大きすぎたようです（このブラウザでは一度に 4 GB まで）。ビットレートを下げるか範囲を分けるか、Chrome / Edge（保存先へ直接書き出せる）を使ってください。')));
    if (expMemError(e) || expLarge(o.W, o.H) || e.code === 'unencodable') hint.push(expCliHint(o));
    $('#expHint').replaceChildren(...hint);
    toast(T('書き出しに失敗しました: ') + e.message, { type:'error', timeout:8000 });
  });
};
// 書き出す大きさ（コメントを流す範囲と同じ縦横比。short は短い辺）
function exportSize(short){
  const even = (v) => Math.max(2, Math.round(v / 2) * 2);
  const a = state.stage.w / state.stage.h;
  return a >= 1 ? { W: even(short * a), H: even(short) } : { W: even(short), H: even(short / a) };
}
function readExportOptions(){
  const { W, H } = exportSize(+$('#expRes').value || 720);
  const dur = video.duration;
  let start = parseTime($('#expStart').value); if (!isFinite(start) || start < 0) start = 0;
  let end = parseTime($('#expEnd').value); if (!isFinite(end) || end > dur) end = dur;
  return { W, H, stage: state.stage, fps: +$('#expFps').value, vbps: expBitrate(W, H), start, end,
    audio: $('#expAudio').checked, container: $('#expContainer').value };
}
// 保存先を選んでもらう（選べないブラウザでは null。やめたら false）
async function expPickSaveFile(container){
  if (!canSaveStream()) return null;
  try {
    return await window.showSaveFilePicker({ suggestedName: exportFileName(container),
      types: [{ description: T`${CONTAINERS[container].label} 動画`, accept: { [EXP_MIME[container]]: ['.' + container] } }] });
  } catch (e){
    if (e.name === 'AbortError') return false;
    // 保存先の画面を開けない環境（埋め込み表示など）では、今までどおりダウンロードで書き出す
    console.warn(T('保存先を選べないため、ダウンロードで書き出します'), e);
    return null;
  }
}
// 書き出しに失敗・中止したとき、空のまま残った保存先のファイルを消す（上書きしようとした元のファイルはそのまま残る）
async function expDropEmpty(handle){
  try { if (handle && (await handle.getFile()).size === 0) await handle.remove?.(); } catch {}
}
function exportFileName(ext){ return `${baseName(state.videoName) || 'video'}_comments.${ext}`; }

/* ---------- 高速書き出し（WebCodecs。Web Worker で処理し、使えない環境ではこのタブで処理） ---------- */
let mediabunnyLoading = null;
function loadMediabunny(){
  if (window.Mediabunny) return Promise.resolve(window.Mediabunny);
  // 同時に呼ばれても1度だけ読み込む（失敗したら次に呼ばれたときに読み直す）
  return mediabunnyLoading = mediabunnyLoading || new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = MB_URL;
    sc.onload = () => window.Mediabunny ? resolve(window.Mediabunny) : reject(new Error(T('変換ライブラリを読み込めませんでした')));
    sc.onerror = () => reject(new Error(T('変換ライブラリ（lib/') + MB_URL.split('/').pop() + T('）が見つかりません。index.html と同じ場所に lib フォルダを置いてください')));
    document.head.append(sc);
  }).catch(e => { mediabunnyLoading = null; throw e; });
}
// 元動画の映像をこのブラウザの WebCodecs でデコードできないとき（Firefox で HEVC など）の書き出し。
// 映像は再生プレーヤーから元のコマを1つずつ取り込み（等倍で再生しながら取り込み、取りこぼしたコマはシークして取る）、
// エンコードと音声は高速書き出しと同じ仕組みで行う
async function exportViaPlayer(MB, d, ctl){
  const setup = await exportSetup(MB, d);
  try { return await exportViaPlayerWith(MB, d, ctl, setup); }
  catch (e){ await exportAbort(setup.sink); throw e; }
}
async function exportViaPlayerWith(MB, d, ctl, { input, format, output, vcodec, track, sink: fileSink }){
  // 範囲内の元のコマの時刻（表示順）
  const sink = new MB.EncodedPacketSink(track);
  const meta = { metadataOnly: true };
  const first = (await sink.getKeyPacket(d.start, meta)) || (await sink.getFirstPacket(meta));
  let times = [];
  if (first) for await (const p of sink.packets(first, undefined, meta)){
    if (ctl.canceled) throw new Error('canceled');
    if (p.timestamp >= d.end + 2) break; // B フレームの並べ替えに備えて少し先まで読む
    times.push(p.timestamp);
  }
  times = [...new Set(times)].sort((a, b) => a - b);
  let i0 = 0;
  while (i0 + 1 < times.length && times[i0 + 1] <= d.start) i0++;
  times = times.slice(i0).filter(t => t < d.end);
  if (!times.length) throw new Error(T('書き出し範囲に映像のコマが見つかりません'));
  const typical = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 1 / 30;
  const nextOf = (j) => j + 1 < times.length ? times[j + 1] : times[j] + typical;
  // 再生中の時刻 → コマ番号（その時刻に表示されているコマ）
  const indexAt = (mt) => {
    let lo = 0, hi = times.length - 1;
    if (mt + 0.002 < times[0]) return -1;
    while (lo < hi){ const mid = (lo + hi + 1) >> 1; if (times[mid] <= mt + 0.002) lo = mid; else hi = mid - 1; }
    return lo;
  };

  const src = new MB.VideoSampleSource({ codec: vcodec, quality: new MB.Quality({ bitrate: d.vbps }) });
  const rate = d.fps > 0 ? d.fps : exportRateOf(times);
  output.addVideoTrack(src, rate ? { frameRate: rate } : {});
  let conv = null, audioDropped = false;
  if (d.audio){
    conv = await MB.Conversion.init({ input, output, composable: true, tracks: 'primary',
      trim: { start: d.start, end: d.end }, video: { discard: true }, audio: {} });
    audioDropped = conv.discardedTracks.some(x => x.track.type === 'audio');
    ctl.conv = conv;
  }
  await output.start();

  const frames = exportFramer(MB, d);
  const vw = video.videoWidth, vh = video.videoHeight;
  const paint = (g, x, y, w, h) => g.drawImage(video, x, y, w, h);
  // 取り込んだフレームは順にエンコーダーへ渡す（音声もおおよそ足並みをそろえて書き込む）
  let chain = Promise.resolve(), pending = 0, failed = null, audioUntil = 0;
  const capture = (j) => {
    const a = Math.max(times[j], d.start), b = Math.min(nextOf(j), d.end);
    if (!(b > a)) return;
    for (const s of frames(paint, vw, vh, a - d.start, b - a, d.start)){
      pending++;
      chain = chain.then(async () => {
        try { if (!failed) await src.add(s); } finally { s.close(); pending--; }
      }).catch(e => { failed = failed || e; });
    }
    chain = chain.then(async () => {
      if (!failed && conv && b - d.start > audioUntil){ audioUntil = b - d.start + 1; await conv.execute({ until: audioUntil }); }
    }).catch(e => { failed = failed || e; });
    ctl.onProgress((b - d.start) / (d.end - d.start), b - d.start);
  };
  const settle = async (max) => { while (pending > max && !failed) await new Promise(r => setTimeout(r, 10)); };
  const check = () => { if (ctl.canceled) throw new Error('canceled'); if (failed) throw failed; };
  // コマの頭ちょうどだと丸めで前のコマになることがあるので、少し内側を指す
  const seekTo = (j) => seekAndWait(times[j] + Math.min((nextOf(j) - times[j]) / 4, 0.004));
  // 等倍で再生しながら、表示されたコマを順に取り込む。取りこぼし・停止・エンコード待ちで止まる
  const playFrom = (j) => new Promise((resolve) => {
    let stopped = false, watchdog = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true; clearTimeout(watchdog); video.pause(); video.removeEventListener('ended', stop); resolve(j);
    };
    const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(stop, 2000); };
    const onFrame = (now, m) => {
      if (stopped) return;
      if (ctl.canceled || failed) return stop();
      const k = indexAt(m.mediaTime);
      if (k > j) return stop();
      if (k === j){ capture(j); j++; }
      if (j >= times.length || pending > 30) return stop();
      arm();
      video.requestVideoFrameCallback(onFrame);
    };
    video.addEventListener('ended', stop);
    video.requestVideoFrameCallback(onFrame);
    arm();
    video.play().catch(stop);
  });

  const saved = { t: video.currentTime, rate: video.playbackRate, muted: video.muted };
  video.pause();
  video.muted = true; video.playbackRate = 1;
  const canPlay = typeof video.requestVideoFrameCallback === 'function';
  try {
    let j = 0;
    while (j < times.length){
      check();
      await seekTo(j);
      capture(j); j++;
      if (canPlay && j < times.length) j = await playFrom(j);
      await settle(8);
    }
    await chain;
    check();
    src.close();
    if (conv) await conv.execute();
    await output.finalize();
  } catch (e){
    if (conv) await conv.cancel().catch(() => {});
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    video.pause();
    video.playbackRate = saved.rate; video.muted = saved.muted;
    video.currentTime = saved.t;
  }
  const buffer = fileSink ? null : output.target.buffer;
  const size = fileSink ? await exportCommit(d, fileSink) : buffer.byteLength;
  return { buffer, size, mime: format.mimeType, ext: format.fileExtension.replace(/^\./, ''), codec: vcodec,
    audioDropped, viaPlayer: true };
}
function snapshotLayouts(start, end){
  return state.layouts.filter(L => !L.invisible && L.end > start - 1 && L.start < end + 1).map(L => ({
    c: { cmd: L.c.cmd, text: L.c.text, id: L.c.id }, o: { pos: L.o.pos },
    lines: L.lines, fs: L.fs, lh: L.lh, w: L.w, h: L.h, y: L.y, start: L.start, end: L.end, speed: L.speed,
    color: L.color, font: L.font, alpha: L.alpha, invisible: false,
  }));
}
// ローカルファイル（file://）ではワーカーからライブラリを読めないので、このタブで処理する
const fastExportInWorker = () => location.protocol !== 'file:';
async function runFastExport(){
  const o = readExportOptions();
  if (o.end - o.start < 0.5){ toast(T('書き出し範囲が短すぎます'), { type:'error' }); return; }
  if (!state.videoFile) throw new Error(T('動画ファイルが見つかりません'));
  const handle = await expPickSaveFile(o.container);
  if (handle === false) return;
  if (!handle && expEstimate(o) > EXP_MEM_MAX * 0.9
    && !confirm(T`見込みの大きさ（約 ${fmtBytes(expEstimate(o))}）が、このブラウザで一度に書き出せる 4 GB を超えそうです。途中で失敗することがありますが、書き出しますか？`)) return;
  const d = { type: 'start', lib: MB_URL, file: state.videoFile, layouts: snapshotLayouts(o.start, o.end), ...o, handle };
  exportState.mode = 'fast'; exportState.cancel = false;
  expSetBusy(true);
  expProgress(0, T('準備中…'));
  let t0 = performance.now();
  const span = o.end - o.start;
  const onProgress = (p, t) => {
    const el = (performance.now() - t0) / 1000;
    const speed = t > 0 ? (t / el) : 0;
    const left = p > 0.02 ? el * (1 - p) / p : NaN;
    expProgress(p, (exportState.mode === 'seek' ? T('プレーヤーから読み込みながら書き出し中（このタブを前面に表示したままにしてください）… ') : T('書き出し中… ')) + `${Math.floor(p * 100)}%` + (speed ? T`（再生速度の約 ${speed.toFixed(1)} 倍` + (isFinite(left) ? T`・残り約 ${fmt(left)}` : '') + T('）') : ''));
  };
  let done = false;
  const onDone = (m) => {
    done = true;
    const name = handle ? handle.name : exportFileName(m.ext);
    if (m.buffer) download(new Blob([m.buffer], { type: m.mime }), name);
    const el = (performance.now() - t0) / 1000;
    const CODEC = { avc:'H.264', hevc:'H.265', vp9:'VP9', vp8:'VP8', av1:'AV1' };
    expProgress(1, T`完了: ${name}（${CODEC[m.codec] || m.codec}・${o.fps ? o.fps + 'fps' : T('元動画と同じfps')}・${fmtBytes(m.size)}・${fmt(span)} 分を ${fmt(el)} で書き出し）`
      + ((o.container === 'mp4' || o.container === 'mkv') && m.codec !== 'avc' ? T('　※この環境では H.264 が使えないため ') + (CODEC[m.codec] || m.codec) + T(' で書き出しました（古いプレーヤーでは再生できないことがあります）') : '')
      + (m.audioDropped ? T('　※音声はこの形式に変換できなかったため含まれていません') : '')
      + (m.viaPlayer ? T('　※このブラウザでは元動画を直接デコードできないため、プレーヤーで1コマずつ読み込んで書き出しました') : ''));
    toast(handle ? T`${name} に書き出しました` : T`${name} を書き出しました`, { timeout:6000 });
  };
  // このタブで変換する（ファイルを直接開いているとき・プレーヤーから映像を取り出すとき）
  const inTab = async (convert) => {
    const ctl = { canceled: false, conv: null, onProgress };
    exportState.ctl = ctl;
    try {
      const MB = await loadMediabunny();
      onDone(await convert(MB, d, ctl));
    } catch (e){
      if (ctl.canceled) expProgress(0, T('中止しました')); else throw e;
    } finally { exportState.ctl = null; }
  };
  try {
    try {
      if (fastExportInWorker()){
        const worker = new Worker(new URL('js/export-worker.js?lang=' + I18N.lang, location.href));
        exportState.worker = worker;
        try {
          await new Promise((resolve, reject) => {
            worker.onerror = (e) => reject(new Error(e.message || T('ワーカーの起動に失敗しました')));
            worker.onmessage = (ev) => {
              const m = ev.data;
              if (m.type === 'progress') onProgress(m.p, m.t);
              else if (m.type === 'done'){ onDone(m); resolve(); }
              else if (m.type === 'canceled'){ expProgress(0, T('中止しました')); resolve(); }
              else if (m.type === 'error') reject(Object.assign(new Error(m.message), { code: m.code }));
            };
            worker.postMessage(d);
          });
        } finally { worker.terminate(); exportState.worker = null; }
      } else {
        await inTab(exportConvert);
      }
    } catch (e){
      // 元動画を直接デコードできないとき（できると答えたのに途中でデコードに失敗したときも）は、
      // 映像だけ再生プレーヤーから取り出して書き出し直す
      if (!(e.code === 'undecodable' || /decod/i.test(e.message)) || exportState.cancel) throw e;
      console.warn(e);
      exportState.mode = 'seek';
      t0 = performance.now();
      expSetBusy(true);
      if (!exportDlg.open) exportDlg.showModal();
      expProgress(0, e.message + T('。プレーヤーで1コマずつ読み込みながら書き出します…'));
      await inTab(exportViaPlayer);
    }
  } finally {
    expSetBusy(false);
    if (!done) await expDropEmpty(handle);
  }
}

/* ---------- リアルタイム録画（互換モード） ---------- */
async function runRealtimeExport(){
  const o = readExportOptions();
  const mime = pickMime(o.container); if (!mime) return;
  const { W, H, start, end } = o, fps = o.fps || 30, vbps = o.vbps;
  if (end - start < 0.5){ toast(T('書き出し範囲が短すぎます'), { type:'error' }); return; }
  // 保存先を選べるブラウザでは、録画したものを少しずつそこへ書く
  const handle = await expPickSaveFile(o.container);
  if (handle === false) return;

  const g = o.audio ? ensureAudioGraph() : null;
  if (g) await g.actx.resume().catch(() => {});
  const saved = { vol: video.volume, muted: video.muted, rate: video.playbackRate };

  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c2 = cv.getContext('2d');
  const renderer = new CommentRenderer();
  const draw = () => {
    c2.fillStyle = '#000'; c2.fillRect(0, 0, W, H);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (vw && vh){ const k = Math.min(W / vw, H / vh), dw = vw * k, dh = vh * k; c2.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh); }
    renderer.draw(c2, W, H, video.currentTime, state.layouts, { stage: o.stage, opacity:1 });
  };

  exportState.mode = 'realtime'; exportState.cancel = false;
  expSetBusy(true);
  expProgress(0, T('準備中…'));

  let rec = null, sink = null, done = false;
  try {
    if (handle) sink = await handle.createWritable();
    video.pause();
    video.playbackRate = 1;
    if (g){
      video.muted = false; video.volume = 1;
      g.speaker.gain.value = $('#expMute').checked ? 0 : (saved.muted ? 0 : saved.vol);
    }
    await seekAndWait(start);
    draw();
    const vs = cv.captureStream(fps);
    const tracks = [...vs.getVideoTracks()];
    if (g) tracks.push(...g.dest.stream.getAudioTracks());
    rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 192000 });
    const chunks = [];
    let writing = Promise.resolve(), writeError = null;
    rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      if (sink) writing = writing.then(() => sink.write(e.data)).catch(err => { writeError = writeError || err; exportState.cancel = true; });
      else chunks.push(e.data);
    };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);
    await video.play();
    await new Promise(resolve => {
      const tick = () => {
        const t = video.currentTime;
        if (exportState.cancel || video.ended || t >= end){ resolve(); return; }
        draw();
        expProgress((t - start) / (end - start), T`録画中… ${fmt(t - start)} / ${fmt(end - start)}（等倍で進みます）`);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    draw();
    video.pause();
    rec.stop();
    await stopped;
    await writing;
    if (writeError) throw writeError;
    if (!exportState.cancel){
      if (sink){
        await sink.close(); sink = null; done = true;
        expProgress(1, T`完了: ${handle.name} に書き出しました（${fmtBytes((await handle.getFile()).size)}）`);
        toast(T`${handle.name} に書き出しました`);
      } else {
        const name = exportFileName(o.container);
        download(new Blob(chunks, { type: mime.split(';')[0] }), name);
        done = true;
        expProgress(1, T`完了: ${name} をダウンロードしました`);
        toast(T`${name} を書き出しました`);
      }
    } else {
      expProgress(0, T('中止しました'));
    }
  } finally {
    if (rec && rec.state !== 'inactive') try { rec.stop(); } catch {}
    if (sink) await sink.abort().catch(() => {});
    if (!done) await expDropEmpty(handle);
    video.pause();
    video.playbackRate = saved.rate;
    if (g) g.speaker.gain.value = 1;
    video.volume = saved.vol; video.muted = saved.muted;
    expSetBusy(false);
  }
}

/* =====================================================================
   編集履歴（元に戻す / やり直す）
   ===================================================================== */
// 変更セットを積む。元に戻すときは打ち消す変更セットを当てる（その後に同じコメントが
// 別の変更で書き換わっていれば、git の revert と同じく衝突として止める）
const history = { undo: [], redo: [] };
function pushUndo(ch){
  history.undo.push(ch);
  if (history.undo.length > 100) history.undo.shift();
  history.redo.length = 0;
  updateUndoUI();
}
function applyHistory(ch){
  if (tmLocked()) return false;
  const { applied, conflicts } = store.apply(ch, { atomic: true });
  if (conflicts.length){ toast(T('その後の変更と重なるため元に戻せません'), { type:'error' }); return false; }
  if (applied){ recordChange(applied); commentsChanged(); collabSend(applied); markDirty(); autosave(); tlSelChanged(); }
  return true;
}
function undo(){
  if (!history.undo.length){ toast(T('これ以上元に戻せません')); return; }
  const ch = history.undo[history.undo.length - 1];
  if (!applyHistory(invertChange(ch))) return;
  history.redo.push(history.undo.pop());
  updateUndoUI();
}
function redo(){
  if (!history.redo.length){ toast(T('これ以上やり直せません')); return; }
  const ch = history.redo[history.redo.length - 1];
  if (!applyHistory({ ...ch, id: uuidv7() })) return;
  history.undo.push(history.redo.pop());
  updateUndoUI();
}
// 特定の変更を打ち消す変更を新しく積む（git revert）
function revertChange(ch){
  if (tmLocked()) return null;
  const { applied, conflicts } = store.apply(invertChange(ch), { atomic: true });
  if (conflicts.length){ toast(T('その後の変更と重なるため元に戻せません'), { type:'error' }); return null; }
  if (applied){ pushUndo(applied); recordChange(applied); commentsChanged(); collabSend(applied); markDirty(); autosave(); tlSelChanged(); }
  return applied;
}
function updateUndoUI(){
  $('#tlUndo').disabled = !history.undo.length;
  $('#tlRedo').disabled = !history.redo.length;
}

/* =====================================================================
   タイムライン
   ===================================================================== */
// 見出し列の幅は、英語の段の名前（Top・Flow・Btm）が入るよう少し広く
const TL_RULER = 22, TL_HEAD = I18N.lang === 'en' ? 40 : 30, TL_GAP = 6, TL_MIN_DUR = 0.1;
const TL_GROUPS = [
  { pos:'ue', label:T('上'), color:'#2fae78' },
  { pos:'naka', label:T('流'), color:'#3d7be0' },
  { pos:'shita', label:T('下'), color:'#d08a2a' },
];
const TL_GI = { ue:0, naka:1, shita:2 };
const coarse = matchMedia('(pointer: coarse)');
// 段の高さ（設定で 低い・ふつう・高い。指で触る画面では少し高く）
const LANE_H = { s: [20, 26], m: [24, 32], l: [34, 42] };
const laneH = () => (LANE_H[settings.tlLane] || LANE_H.m)[coarse.matches ? 1 : 0];
const TL = {
  main: $('#tlMain'), cv: $('#tlCanvas'), ovBox: $('#tlOv'), ov: $('#tlOvCanvas'),
  W: 1, H: 1, ovW: 1, ovH: 1, dpr: 1, t0: -1, pps: 40, scrollY: 0, inited: false,
  groups: [], laneOf: new Map(), contentH: 0,
  sel: new Set(), drag: null, ovDrag: null, pinch: null, pointers: new Map(), snapT: null,
  dirty: true, ovDirty: true, ovCache: null, lastTap: null, lastT: -1,
  snap: settings.tlSnap, follow: settings.tlFollow, followState: { lock: false, catchUp: null, x: null, t: null, ts: 0 },
};
TL.g = TL.cv.getContext('2d');
TL.og = TL.ov.getContext('2d');

function tlDuration(){
  const d = video.duration;
  if (isFinite(d) && d > 0) return d;
  let m = 0;
  for (const c of state.comments){ const e = spanOf(c).e; if (e > m) m = e; }
  // 前からあるけた外れの時刻のコメント（ホストの外で書かれたものなど）があっても、有限の長さにする
  return clamp(m + 5, 60, TIME_MAX + LONG_MAX + 5);
}
const tx = (t) => TL_HEAD + (t - TL.t0) * TL.pps;
const xt = (x) => TL.t0 + (x - TL_HEAD) / TL.pps;
const laneTop = (gi, lane) => TL_RULER + TL.groups[gi].y + lane * laneH() - TL.scrollY;
const tlShown = () => TL.main.clientWidth > 0 && TL.main.clientHeight > 0;

function tlRelane(){
  const groups = TL_GROUPS.map(g => ({ ...g, lanes: [] }));
  const items = state.comments.map(c => ({ c, sp: spanOf(c) })).sort((a, b) => a.sp.s - b.sp.s || a.c.t - b.c.t);
  TL.laneOf.clear();
  // いちばん長く出ているコメントの長さ（描くときに、見える範囲に掛かるコメントだけを探すため）
  TL.maxDur = items.reduce((m, it) => Math.max(m, it.sp.e - it.c.t), DEFAULT_DURATION);
  for (const it of items){
    const gi = TL_GI[it.sp.o.pos], G = groups[gi];
    let lane = G.lanes.findIndex(l => l.end <= it.sp.s + 1e-6);
    if (lane < 0){ lane = G.lanes.length; G.lanes.push({ end: -Infinity, items: [] }); }
    G.lanes[lane].end = it.sp.e;
    G.lanes[lane].items.push(it.c);
    TL.laneOf.set(it.c.id, { g: gi, lane });
  }
  let y = 0;
  for (const G of groups){ G.y = y; G.n = Math.max(1, G.lanes.length); y += G.n * laneH() + TL_GAP; }
  TL.groups = groups;
  TL.contentH = y;
  TL.ovDirty = true;
  tlClampView();
}
function tlBounds(){
  const W = Math.max(10, TL.W - TL_HEAD), D = tlDuration();
  const minPps = W / (D + 1), maxPps = Math.max(minPps, 600);
  return { W, D, minPps, maxPps };
}
function tlClampView(){
  const b = tlBounds();
  TL.pps = clamp(TL.pps, b.minPps, b.maxPps);
  TL.t0 = clamp(TL.t0, -1, Math.max(-1, b.D - b.W / TL.pps));
  TL.scrollY = clamp(TL.scrollY, 0, Math.max(0, TL.contentH - (TL.H - TL_RULER)));
  TL.dirty = true;
  const v = b.maxPps > b.minPps ? Math.log(TL.pps / b.minPps) / Math.log(b.maxPps / b.minPps) : 0;
  $('#tlZoom').value = Math.round(v * 1000);
  presenceDirty();
}
function tlZoomAt(factor, x){
  const t = xt(x);
  TL.pps *= factor;
  tlClampView();
  TL.t0 = t - (x - TL_HEAD) / TL.pps;
  tlClampView();
}
function tlZoomCenterX(){
  const px = tx(video.currentTime || 0);
  return px >= TL_HEAD && px <= TL.W ? px : TL_HEAD + (TL.W - TL_HEAD) / 2;
}
function tlFit(){ TL.pps = 0; TL.t0 = -1; tlClampView(); }
// 表示範囲の控え（幅が変わっても同じ範囲が見えるよう、拡大率ではなく見えている秒数で持つ）
function tlSaveView(){
  if (TL.pendingView || !TL.inited || TL.W <= 60) return TL.pendingView || null; // 隠れていて幅が分からないとき
  return { t0: TL.t0, span: (TL.W - TL_HEAD) / TL.pps, scrollY: TL.scrollY };
}
function tlRestoreView(v){
  if (TL.W <= 60){ TL.pendingView = v; return; }
  TL.pendingView = null;
  TL.pps = (TL.W - TL_HEAD) / Math.max(0.01, v.span);
  tlClampView();
  TL.t0 = v.t0; TL.scrollY = v.scrollY;
  tlClampView();
}
function tlResetView(){
  TL.t0 = -1;
  TL.pps = Math.max(10, TL.W - TL_HEAD) / (Math.min(tlDuration(), 60) + 1);
  TL.ovDirty = true;
  tlClampView();
}
function tlEnsureVisible(c){
  const sp = spanOf(c), vis = (TL.W - TL_HEAD) / TL.pps;
  if (sp.s < TL.t0 || sp.e > TL.t0 + vis) TL.t0 = sp.s - Math.max(0, (vis - (sp.e - sp.s)) * 0.3);
  const pos = TL.laneOf.get(c.id);
  if (pos){
    const y = TL.groups[pos.g].y + pos.lane * laneH();
    if (y < TL.scrollY || y + laneH() > TL.scrollY + TL.H - TL_RULER) TL.scrollY = y - (TL.H - TL_RULER) / 3;
  }
  tlClampView();
}
function tlResize(){
  const dpr = window.devicePixelRatio || 1;
  // 隠れる（スマホでほかのタブにするなど）ときは表示範囲を控え、また見えたら戻す
  if (TL.main.clientWidth <= 60 && TL.W > 60 && TL.inited && !TL.pendingView) TL.pendingView = tlSaveView();
  TL.W = Math.max(1, TL.main.clientWidth); TL.H = Math.max(1, TL.main.clientHeight);
  TL.ovW = Math.max(1, TL.ovBox.clientWidth); TL.ovH = Math.max(1, TL.ovBox.clientHeight);
  TL.dpr = dpr;
  let cleared = false;
  for (const [cv, w, h] of [[TL.cv, TL.W, TL.H], [TL.ov, TL.ovW, TL.ovH]]){
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph){ cv.width = pw; cv.height = ph; cleared = true; }
  }
  if (!TL.inited && TL.W > 60){ TL.inited = true; tlResetView(); }
  TL.ovDirty = true;
  tlClampView();
  // 隠れている間の表示範囲は、見えるようになってから戻す
  if (TL.pendingView && TL.W > 60){ const v = TL.pendingView; TL.pendingView = null; tlRestoreView(v); }
  // 大きさを変えると canvas は消えるので、その場で描き直す（ResizeObserver は描画のループのあとに動くため、
  // 次のフレームまで待つと、高さを変えるつまみをドラッグしている間ずっと消えたままになる）
  if (cleared && tlShown()){ TL.dirty = false; tlDraw(); tlDrawOverview(); }
}
new ResizeObserver(tlResize).observe(TL.main);
new ResizeObserver(tlResize).observe(TL.ovBox);
coarse.addEventListener?.('change', tlRelane);

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
// 1回に描く目盛りの数の上限（ふつうは数百本。表示範囲の値がおかしくなっても、描画が終わらなくならないように）
const TL_TICKS_MAX = 5000;
// 目盛りの刻み。1時間でも細かすぎるほど引いたとき（動画を開かず、遠い時刻にコメントがあるとき）は、
// 1時間の 10 倍・100 倍…にする（刻みが細かいままだと、目盛りを描く繰り返しが終わらなくなる）
function rulerStep(){
  let major = RULER_STEPS.find(s => s * TL.pps >= 70);
  if (major == null){
    major = 3600;
    while (major * TL.pps < 70 && major < 1e15) major *= 10;
  }
  const div = [0.2, 2, 120].includes(major) ? 4 : [15, 900].includes(major) ? 3 : [30, 300, 1800].includes(major) ? 6 : 5;
  return { major, div };
}
function fmtRuler(t, major){
  if (t < -1e-6) return '';
  if (major < 1){ const s = Math.round(t * 10) / 10, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; }
  return fmt(Math.round(t));
}
function rr(g, x, y, w, h, r){
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.beginPath(); g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function shade(hex, k){
  const n = parseInt(hex.slice(1), 16), f = (v) => Math.min(255, Math.round(v * k));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}
const TL_FONT = '12px system-ui,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",Meiryo,sans-serif';

function tlDrawClip(g, c, sp, y, lh, gi){
  const sel = TL.sel.has(c.id);
  const x0 = tx(sp.s), w = Math.max(3, tx(sp.e) - x0);
  const top = y + 2, h = lh - 4, colored = sp.o.color !== '#FFFFFF';
  const dim = tmAlpha(c.id), fresh = tm.on && tm.changed.has(c.id);
  g.globalAlpha = (sp.o.invisible ? 0.4 : 1) * dim;
  g.fillStyle = sel ? shade(TL_GROUPS[gi].color, 1.3) : TL_GROUPS[gi].color;
  rr(g, x0 + 0.5, top, w - 1, h, 4); g.fill();
  // 上の縁を少し明るく（立体に見せる）
  if (w > 6){ g.fillStyle = 'rgba(255,255,255,.16)'; g.fillRect(x0 + 3, top + 1, w - 6, 1); }
  if (colored && w > 6){ g.fillStyle = sp.o.color; g.fillRect(x0 + 2, top + 2, 3, h - 4); }
  if (sp.lead > 0){
    const xv = tx(c.t);
    if (xv > x0 + 3 && xv < x0 + w - 3){ g.fillStyle = 'rgba(255,255,255,.45)'; g.fillRect(Math.round(xv), top + 1, 1, h - 2); }
  }
  if (w > 16){
    g.save(); g.beginPath(); g.rect(x0 + 1, top, w - 2, h); g.clip();
    g.fillStyle = '#fff'; g.textAlign = 'left';
    g.fillText(c.text.replace(/\n/g, ' ⏎ '), Math.max(x0, TL_HEAD) + (colored ? 9 : 6), top + h / 2 + 0.5);
    g.restore();
  }
  // タイムマシン: 見ている時点のコミットで変わったものを囲う
  if (fresh && !sel){
    g.globalAlpha = 1; g.lineWidth = 2; g.strokeStyle = '#ffc233';
    rr(g, x0 + 1, top + 0.5, w - 2, h - 1, 4); g.stroke();
  }
  if (sel){
    g.globalAlpha = 1;
    g.lineWidth = 2; g.strokeStyle = '#fff';
    rr(g, x0 + 1, top + 0.5, w - 2, h - 1, 4); g.stroke();
    const hz = coarse.matches ? 10 : 6;
    if (w > hz * 2.5){
      g.fillStyle = 'rgba(0,0,0,.35)';
      g.fillRect(x0 + 1.5, top + 1.5, hz, h - 3); g.fillRect(x0 + w - 1.5 - hz, top + 1.5, hz, h - 3);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.fillRect(Math.round(x0 + 1.5 + hz / 2), top + h * 0.28, 1, h * 0.44);
      g.fillRect(Math.round(x0 + w - 1.5 - hz / 2), top + h * 0.28, 1, h * 0.44);
    }
  }
  g.globalAlpha = 1;
}
function tlDraw(){
  const g = TL.g, W = TL.W, H = TL.H, lh = laneH();
  g.setTransform(TL.dpr, 0, 0, TL.dpr, 0, 0);
  g.fillStyle = '#121417'; g.fillRect(0, 0, W, H);
  const t1 = xt(W), D = tlDuration(), hasDur = isFinite(video.duration) && video.duration > 0;
  const step = rulerStep(), minor = step.major / step.div;
  // トラック
  g.save(); g.beginPath(); g.rect(TL_HEAD, TL_RULER, W - TL_HEAD, H - TL_RULER); g.clip();
  TL.groups.forEach((G, gi) => {
    for (let ln = 0; ln < G.n; ln++){
      const y = laneTop(gi, ln);
      if (y > H || y + lh < TL_RULER) continue;
      g.fillStyle = ln % 2 ? '#181b1f' : '#1c1f23';
      g.fillRect(TL_HEAD, y, W - TL_HEAD, lh);
    }
  });
  g.fillStyle = 'rgba(255,255,255,.045)';
  for (let k = Math.ceil(TL.t0 / step.major), n = 0; k * step.major <= t1 && n < TL_TICKS_MAX; k++, n++) g.fillRect(Math.round(tx(k * step.major)), TL_RULER, 1, H - TL_RULER);
  g.fillStyle = 'rgba(0,0,0,.5)';
  if (tx(0) > TL_HEAD) g.fillRect(TL_HEAD, TL_RULER, tx(0) - TL_HEAD, H);
  if (hasDur && tx(D) < W) g.fillRect(tx(D), TL_RULER, W - tx(D), H);
  // イン点〜アウト点の範囲（外を少し暗く）
  const rg = rangeSpan();
  if (rg){
    g.fillStyle = 'rgba(0,0,0,.28)';
    if (tx(rg.s) > TL_HEAD) g.fillRect(TL_HEAD, TL_RULER, tx(rg.s) - TL_HEAD, H);
    if (tx(rg.e) < W) g.fillRect(tx(rg.e), TL_RULER, W - tx(rg.e), H);
    g.fillStyle = 'rgba(255,179,0,.5)';
    for (const x of [tx(rg.s), tx(rg.e)]) if (x >= TL_HEAD && x <= W) g.fillRect(Math.round(x) - 0.5, TL_RULER, 1, H);
  }
  g.font = TL_FONT; g.textBaseline = 'middle';
  const drawOne = (c) => {
    const pos = TL.laneOf.get(c.id);
    if (!pos) return;
    const sp = spanOf(c);
    if (sp.e < TL.t0 || sp.s > t1) return;
    const y = laneTop(pos.g, pos.lane);
    if (y > H || y + lh < TL_RULER) return;
    tlDrawClip(g, c, sp, y, lh, pos.g);
  };
  // state.comments は時刻順なので、見える範囲に掛かりうるコメントだけを見る（コメントが多くても軽く描く）
  const cs = state.comments, lo = firstAtOrAfter(cs, TL.t0 - (TL.maxDur || DEFAULT_DURATION)), hi = firstAtOrAfter(cs, t1 + NAKA_LEAD + 1e-6);
  const drawnSel = new Set();
  for (let i = lo; i < hi; i++){ const c = cs[i]; if (TL.sel.has(c.id)) drawnSel.add(c.id); drawOne(c); }
  // ドラッグ中は時刻だけ一時的に変えている（並び順はそのまま）ので、選んでいるものは必ず描く
  for (const id of TL.sel) if (!drawnSel.has(id)){ const c = shown().get(id); if (c) drawOne(c); }
  if (TL.snapT != null){ g.fillStyle = '#ffd400'; g.fillRect(Math.round(tx(TL.snapT)) - 0.5, TL_RULER, 1.5, H); }
  tlDrawPeerSel(g, t1);
  const md = TL.drag;
  // 複製中は、元の場所に点線の枠を描く（元はそこに残る）
  if (md && md.copy && md.started){
    g.strokeStyle = 'rgba(255,255,255,.75)'; g.lineWidth = 1; g.setLineDash([4, 3]);
    for (const [c, o] of md.orig){
      const pos = TL.laneOf.get(c.id); if (!pos) continue;
      const sp = spanFromVals(o.t, o.cmd), x0 = tx(sp.s), x1 = tx(sp.e), y = laneTop(pos.g, pos.lane);
      if (x1 < TL_HEAD || x0 > W || y > H || y + lh < TL_RULER) continue;
      g.strokeRect(Math.round(x0) + 0.5, y + 2.5, Math.round(x1 - x0), lh - 5);
    }
    g.setLineDash([]);
  }
  if (md && md.type === 'create' && md.started && md.lastX != null){
    const s = tlCreateSpan(md), x0 = tx(s.ta), x1 = tx(s.tb), y = laneTop(md.gi, md.lane);
    g.fillStyle = TL.groups[md.gi].color; g.globalAlpha = 0.35; g.fillRect(x0, y + 2, x1 - x0, lh - 4); g.globalAlpha = 1;
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.setLineDash([4, 3]); g.strokeRect(Math.round(x0) + 0.5, y + 2.5, Math.round(x1 - x0), lh - 5); g.setLineDash([]);
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(T`＋ ${fmtPrecise(s.t)}・${s.dur.toFixed(1)}秒`, Math.max(x0, TL_HEAD) + 6, y + lh / 2);
  }
  if (md && md.type === 'marquee' && md.started && md.lastX != null){
    const r = tlMarqueeRect(md), x0 = tx(r.ta), x1 = tx(r.tb), y0 = r.ya - TL.scrollY, y1 = r.yb - TL.scrollY;
    g.fillStyle = 'rgba(80,150,255,.14)'; g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.strokeStyle = 'rgba(120,180,255,.9)'; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(x1 - x0), Math.round(y1 - y0)); g.setLineDash([]);
  }
  g.restore();
  // 見出し列
  g.fillStyle = '#0f1114'; g.fillRect(0, TL_RULER, TL_HEAD, H);
  g.fillStyle = '#23262b'; g.fillRect(TL_HEAD - 1, TL_RULER, 1, H);
  g.save(); g.beginPath(); g.rect(0, TL_RULER, TL_HEAD, H - TL_RULER); g.clip();
  g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  TL.groups.forEach((G, gi) => {
    const y0 = laneTop(gi, 0), h = G.n * lh;
    if (y0 > H || y0 + h < TL_RULER) return;
    g.fillStyle = G.color; rr(g, 4, y0 + 3, 3, h - 6, 1.5); g.fill();
    const vy0 = Math.max(y0, TL_RULER), vy1 = Math.min(y0 + h, H);
    g.fillStyle = '#d4d2cc'; g.fillText(G.label, TL_HEAD / 2 + 3, (vy0 + vy1) / 2);
    g.fillStyle = '#25282d'; g.fillRect(0, y0 + h + TL_GAP / 2 - 0.5, W, 1);
  });
  g.restore();
  // 目盛り
  g.fillStyle = '#1a1d21'; g.fillRect(0, 0, W, TL_RULER);
  g.fillStyle = '#2c3036'; g.fillRect(0, TL_RULER - 1, W, 1);
  // 目盛りの上のイン点〜アウト点（琥珀の帯と、両端のかぎ）
  if (rg){
    const a = Math.max(TL_HEAD, tx(rg.s)), b = Math.min(W, tx(rg.e));
    if (b > a){
      g.fillStyle = 'rgba(255,179,0,.2)'; g.fillRect(a, 0, b - a, TL_RULER - 1);
      g.fillStyle = '#ffb300';
      const xa = tx(rg.s), xb = tx(rg.e);
      if (xa >= TL_HEAD - 1){ g.fillRect(Math.round(xa) - 1, 0, 2, TL_RULER - 1); g.fillRect(Math.round(xa) - 1, 0, 6, 2); g.fillRect(Math.round(xa) - 1, TL_RULER - 3, 6, 2); }
      if (xb <= W + 1){ g.fillRect(Math.round(xb) - 1, 0, 2, TL_RULER - 1); g.fillRect(Math.round(xb) - 5, 0, 6, 2); g.fillRect(Math.round(xb) - 5, TL_RULER - 3, 6, 2); }
    }
  }
  g.save(); g.beginPath(); g.rect(TL_HEAD, 0, W - TL_HEAD, TL_RULER); g.clip();
  g.font = '11px system-ui,sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  for (let k = Math.ceil(TL.t0 / minor), n = 0; k * minor <= t1 && n < TL_TICKS_MAX; k++, n++){
    const x = Math.round(tx(k * minor));
    if (k % step.div === 0){
      g.fillStyle = '#7d828a'; g.fillRect(x, TL_RULER - 9, 1, 8);
      g.fillStyle = '#b9bcc2'; g.fillText(fmtRuler(k * minor, step.major), x + 3, 11);
    } else { g.fillStyle = '#4a4f56'; g.fillRect(x, TL_RULER - 5, 1, 4); }
  }
  g.restore();
  // マウスを重ねている位置（Final Cut Pro のスキマーのように、細い線とその時刻を出す）と、目盛りをつまんで動かしている位置の時刻。
  // マウスが目盛りの上にあるときは、時刻をマウスの横にずらして出す（重なって読めないように）
  const hv = TL.hover, sd = TL.drag && TL.drag.type === 'scrub' ? TL.drag : null;
  const sx = sd ? sd.lastX : hv && !TL.drag ? hv.x : null;
  if (sx != null && sx >= TL_HEAD && sx <= W){
    const hx = Math.round(sx) + 0.5, onRuler = !!sd || hv.y < TL_RULER;
    if (!sd){ g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(hx - 0.5, TL_RULER, 1, H); }
    const label = fmtPrecise(Math.max(0, xt(sx)));
    g.font = '600 10.5px ' + 'ui-monospace,Menlo,Consolas,monospace'; g.textBaseline = 'middle';
    const tw = g.measureText(label).width + 10, gap = 16;
    const lx = !onRuler ? clamp(hx - tw / 2, TL_HEAD, W - tw)
      : hx + gap + tw <= W ? hx + gap : Math.max(TL_HEAD, hx - gap - tw);
    g.fillStyle = '#e8e6e1'; rr(g, lx, 2, tw, TL_RULER - 5, 3); g.fill();
    g.fillStyle = '#121417'; g.textAlign = 'center'; g.fillText(label, lx + tw / 2, TL_RULER / 2 - 0.5);
  }
  // 再生位置
  const px = tx(video.currentTime || 0);
  if (px >= TL_HEAD - 7 && px <= W + 7){
    g.fillStyle = '#ff4d5e';
    g.fillRect(Math.round(px) - 0.5, 0, 1.5, H);
    g.beginPath(); g.moveTo(px - 6, 0); g.lineTo(px + 6, 0); g.lineTo(px + 6, 8); g.lineTo(px, 14); g.lineTo(px - 6, 8); g.closePath(); g.fill();
  }
  tlDrawPeers(g);
  tlSyncVbar();
}
/* ---------- 縦スクロールバー ---------- */
const tlVbar = $('#tlVbar'), tlVthumb = $('#tlVthumb');
function tlVmetrics(){
  const viewH = TL.H - TL_RULER, track = tlVbar.clientHeight || viewH;
  const thumb = Math.max(24, track * Math.min(1, viewH / Math.max(1, TL.contentH)));
  return { viewH, track, thumb, max: Math.max(0, TL.contentH - viewH) };
}
function tlSyncVbar(){
  const m = tlVmetrics();
  const show = m.max > 0.5;
  if (tlVbar.hidden === show) tlVbar.hidden = !show;
  if (!show) return;
  tlVthumb.style.height = m.thumb + 'px';
  tlVthumb.style.transform = `translateY(${(TL.scrollY / m.max) * (m.track - m.thumb)}px)`;
}
tlVbar.addEventListener('pointerdown', (e) => {
  e.stopPropagation(); e.preventDefault();
  const m = tlVmetrics();
  try { tlVbar.setPointerCapture(e.pointerId); } catch {}
  if (e.target === tlVthumb){
    TL.vDrag = { id: e.pointerId, y: e.clientY, sy: TL.scrollY };
    tlVthumb.classList.add('drag');
  } else {
    // つまみの外を押したら1画面分移動
    const r = tlVthumb.getBoundingClientRect();
    TL.scrollY += (e.clientY < r.top ? -1 : 1) * m.viewH * 0.9;
    tlClampView();
  }
});
tlVbar.addEventListener('pointermove', (e) => {
  e.stopPropagation();
  const d = TL.vDrag;
  if (!d || d.id !== e.pointerId) return;
  const m = tlVmetrics();
  TL.scrollY = d.sy + (e.clientY - d.y) * (m.max / Math.max(1, m.track - m.thumb));
  tlClampView();
});
for (const ev of ['pointerup', 'pointercancel']) tlVbar.addEventListener(ev, (e) => { e.stopPropagation(); TL.vDrag = null; tlVthumb.classList.remove('drag'); });
tlVbar.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); TL.scrollY += (e.deltaMode === 1 ? 16 : 1) * (e.deltaY || e.deltaX); tlClampView(); }, { passive:false });
tlVbar.addEventListener('dblclick', (e) => e.stopPropagation());
const ovK = () => (TL.ovW - 2) / (tlDuration() + 1);
const ovX = (t) => 1 + (t + 1) * ovK();
const ovT = (x) => (x - 1) / ovK() - 1;
const ovWindow = () => [ovX(TL.t0), ovX(TL.t0 + (TL.W - TL_HEAD) / TL.pps)];
function tlDrawOverview(){
  const g = TL.og, W = TL.ovW, H = TL.ovH, dpr = TL.dpr;
  if (TL.ovDirty || !TL.ovCache || TL.ovCache.width !== TL.ov.width || TL.ovCache.height !== TL.ov.height){
    TL.ovDirty = false;
    const cv = TL.ovCache || document.createElement('canvas');
    cv.width = TL.ov.width; cv.height = TL.ov.height;
    const c2 = cv.getContext('2d');
    c2.setTransform(dpr, 0, 0, dpr, 0, 0);
    c2.fillStyle = '#0d0f12'; c2.fillRect(0, 0, W, H);
    const k = ovK(), rh = (H - 4) / 3;
    if (isFinite(video.duration)){ c2.fillStyle = '#181b20'; c2.fillRect(ovX(0), 0, video.duration * k, H); }
    c2.globalAlpha = 0.7;
    for (const c of state.comments){
      const sp = spanOf(c), gi = TL_GI[sp.o.pos];
      c2.fillStyle = TL_GROUPS[gi].color;
      c2.fillRect(ovX(sp.s), 2 + gi * rh, Math.max(1, (sp.e - sp.s) * k), rh - 1);
    }
    c2.globalAlpha = 1;
    TL.ovCache = cv;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(TL.ovCache, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const [a, b] = ovWindow();
  g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, a, H); g.fillRect(b, 0, W - b, H);
  g.strokeStyle = '#ffb300'; g.lineWidth = 1.5;
  rr(g, a + 0.75, 0.75, Math.max(3, b - a - 1.5), H - 1.5, 3); g.stroke();
  g.fillStyle = '#ffb300';
  g.fillRect(a, H / 2 - 7, 3, 14); g.fillRect(b - 3, H / 2 - 7, 3, 14);
  tlDrawOverviewPeers(g, H);
  g.fillStyle = '#ff4d4d'; g.fillRect(ovX(video.currentTime || 0) - 0.5, 0, 1.5, H);
}
function tlFrame(playing, t){
  if (!tlShown()) return;
  // 再生中は再生位置が中央に来たらそこで固定し、タイムラインの方を動かす。
  // 中央より右から再生したときは右端まで進ませ、そこからタイムラインごと滑らかに中央へ戻す
  const F = TL.followState;
  if (playing && TL.follow && !TL.drag && !TL.pinch && !TL.ovDrag && !TL.vDrag){
    const now = performance.now();
    const center = TL_HEAD + (TL.W - TL_HEAD) / 2, x = tx(t), at = (px) => t - (px - TL_HEAD) / TL.pps;
    // シークで飛んだら追従をやり直す
    if (F.t != null && (t < F.t - 0.05 || t > F.t + 1)){ F.lock = false; F.catchUp = null; F.x = null; }
    if (x < TL_HEAD || x > TL.W){ TL.t0 = at(center); F.lock = true; F.catchUp = null; } // 画面外なら中央へ
    else if (F.lock || (x > center && F.x != null && F.x <= center + 0.5)){ TL.t0 = at(center); F.lock = true; F.catchUp = null; }
    else if (F.catchUp || x > TL.W - Math.min(48, (TL.W - TL_HEAD) * 0.06)){
      // 再生位置と中央との差を、ゆっくり動き出してゆっくり止まるように縮める
      if (!F.catchUp) F.catchUp = { from: x - center, start: now, dur: Math.min(0.9, Math.max(0.4, (x - center) / 700)) };
      const c = F.catchUp, p = Math.min(1, (now - c.start) / 1000 / c.dur);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      TL.t0 = at(center + c.from * (1 - e));
      if (p >= 1){ F.lock = true; F.catchUp = null; }
    }
    tlClampView();
    F.x = tx(t); F.t = t; F.ts = now;
  } else if (F.ts){ F.lock = false; F.catchUp = null; F.x = F.t = null; F.ts = 0; }
  // コメントのドラッグ中に端へ寄せたら自動スクロール
  const d = TL.drag;
  if (d && d.orig && d.started && d.lastX != null){
    const edge = 28, v = d.lastX < TL_HEAD + edge ? -(TL_HEAD + edge - d.lastX) : d.lastX > TL.W - edge ? d.lastX - (TL.W - edge) : 0;
    if (v){ TL.t0 += v * 0.25 / TL.pps; tlClampView(); tlDragUpdate(d.lastX); }
  }
  // 範囲選択の途中で端へ寄せたら、横（時間）と縦（段）に自動スクロールして範囲を広げる
  if (d && d.type === 'create' && d.started && d.lastX != null){
    const edge = 28, vx = d.lastX < TL_HEAD + edge ? -(TL_HEAD + edge - d.lastX) : d.lastX > TL.W - edge ? d.lastX - (TL.W - edge) : 0;
    if (vx){ TL.t0 += vx * 0.25 / TL.pps; tlClampView(); TL.dirty = true; }
  }
  if (d && d.type === 'marquee' && d.started && d.lastX != null){
    const edge = 28;
    const vx = d.lastX < TL_HEAD + edge ? -(TL_HEAD + edge - d.lastX) : d.lastX > TL.W - edge ? d.lastX - (TL.W - edge) : 0;
    const vy = d.lastY < TL_RULER + edge ? -(TL_RULER + edge - d.lastY) : d.lastY > TL.H - edge ? d.lastY - (TL.H - edge) : 0;
    if (vx || vy){ TL.t0 += vx * 0.25 / TL.pps; TL.scrollY += vy * 0.25; tlClampView(); tlMarqueeUpdate(d); }
  }
  if (t !== TL.lastT){ TL.lastT = t; TL.dirty = true; }
  if (TL.dirty){ TL.dirty = false; tlDraw(); tlDrawOverview(); }
}

/* ---------- 選択と情報表示 ---------- */
function tlSelected(){ return state.comments.filter(c => TL.sel.has(c.id)); }
function tlSelChanged(){
  const n = TL.sel.size;
  // リストで選んだ行と違うものを選んだら、リストの色は再生位置に合わせる表示に戻す
  if (listPick && (n !== listPick.ids.size || [...TL.sel].some(id => !listPick.ids.has(id)))){ listUnpick(); highlightCurrent(video.currentTime || 0); }
  $('#tlEdit').disabled = n !== 1;
  $('#tlDelete').disabled = !n;
  TL.dirty = true; state.needsDraw = true;
  presenceDirty();
  if (n === 1) tlShowInfo(tlSelected()[0]);
  else $('#tlInfo').textContent = n ? T`${n} 件選択中` : (tm.on ? '' : T('ダブルクリックで作成・編集'));
}
function tlShowInfo(c){
  if (!c){ $('#tlInfo').textContent = ''; return; }
  const sp = spanOf(c);
  const speed = sp.lead ? T`　速さ <b>×${((DEFAULT_DURATION + NAKA_LEAD) / (sp.dur + NAKA_LEAD)).toFixed(2)}</b>` : '';
  $('#tlInfo').innerHTML = T`開始 <b>${fmtPrecise(c.t)}</b>　表示 <b>${sp.dur.toFixed(2)}秒</b>${speed}`;
  // タイムマシンでは、最後に変えた日時と人も出す
  const e = tm.on && tm.edit.get(c.id);
  if (e) $('#tlInfo').append(T('　'), e.commit === 'now' ? T('最後の変更: 今（まだコミット前）') : T`最後の変更: ${tmDate(e.time)}・${e.author}`);
}
function deleteSelected(){
  const list = tlSelected();
  if (!list.length) return;
  TL.sel.clear();
  const ch = commitOps(list.map(deleteOp));
  tlSelChanged();
  if (ch) toast(T`${list.length} 件のコメントを削除しました`, { action:{ label:T('元に戻す'), fn:() => revertChange(ch) } });
}
function nudgeSelected(dt){
  const list = tlSelected();
  if (!list.length) return;
  dt = Math.max(dt, -Math.min(...list.map(c => c.t)));
  if (!dt) return;
  const { ops, failed } = updateOps(list.map(c => ({ c, t: c.t + dt })));
  if (failed) toast(T('同じ時刻・内容のコメントがあるため一部を動かせませんでした'));
  commitOps(ops);
  tlSelChanged();
}

/* ---------- ドラッグ編集 ---------- */
function tlLocal(e, el = TL.main){ const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function tlHit(x, y, touch){
  if (y < TL_RULER || x < TL_HEAD) return null;
  const lh = laneH(), zone = touch ? 16 : 6;
  for (let gi = 0; gi < TL.groups.length; gi++){
    const G = TL.groups[gi], yy = y - laneTop(gi, 0);
    if (yy < 0 || yy >= G.n * lh) continue;
    const lane = G.lanes[Math.floor(yy / lh)];
    if (!lane) return null;
    let best = null;
    for (const c of lane.items){
      const sp = spanOf(c), x0 = tx(sp.s), x1 = tx(sp.e), sel = TL.sel.has(c.id);
      const ext = sel ? zone / 2 : 0;
      if (x < x0 - ext || x > x1 + ext) continue;
      const z = Math.min(zone, Math.max(3, (x1 - x0) / 3));
      const cand = { c, zone: x <= x0 + z ? 'trimL' : x >= x1 - z ? 'trimR' : 'move' };
      if (!best || sel) best = cand;
    }
    return best;
  }
  return null;
}
function tlGroupAt(y){
  const lh = laneH();
  for (let gi = 0; gi < TL.groups.length; gi++){
    const yy = y - laneTop(gi, 0);
    if (yy >= 0 && yy < TL.groups[gi].n * lh + TL_GAP) return gi;
  }
  return null;
}
function tlDragBegin(d){
  const edges = [video.currentTime || 0];
  for (const c of state.comments){ if (d.orig.has(c)) continue; const sp = spanOf(c); edges.push(sp.s, sp.e); }
  edges.sort((a, b) => a - b);
  d.edges = edges;
  d.tStart = xt(d.x0);
}
function tlSnapFind(edges, cands, thr){
  let best = null;
  for (const v of cands){
    let lo = 0, hi = edges.length - 1;
    while (lo < hi){ const mid = (lo + hi) >> 1; if (edges[mid] < v) lo = mid + 1; else hi = mid; }
    for (const i of [lo - 1, lo]){
      if (i < 0 || i >= edges.length) continue;
      const delta = edges[i] - v;
      if (Math.abs(delta) <= thr && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, t: edges[i] };
    }
  }
  return best;
}
function tlDragUpdate(x){
  const d = TL.drag;
  let dt = xt(x) - d.tStart, snapT = null;
  const thr = 8 / TL.pps;
  const o0 = d.orig.get(d.c), sp0 = spanFromVals(o0.t, o0.cmd);
  const r2 = (v) => Math.round(v * 100) / 100;
  if (d.type === 'move'){
    let minT = Infinity;
    for (const o of d.orig.values()) minT = Math.min(minT, o.t);
    if (TL.snap){ const r = tlSnapFind(d.edges, [sp0.s + dt, sp0.e + dt], thr); if (r){ dt += r.delta; snapT = r.t; } }
    dt = Math.max(dt, -minT);
    for (const [c, o] of d.orig) c.t = r2(o.t + dt);
  } else if (d.type === 'trimL'){
    let s = sp0.s + dt;
    if (TL.snap){ const r = tlSnapFind(d.edges, [s], thr); if (r){ s += r.delta; snapT = r.t; } }
    s = clamp(s, -sp0.lead, sp0.e - sp0.lead - TL_MIN_DUR);
    const t = r2(s + sp0.lead);
    d.c.t = t; d.c.cmd = setCmdLong(o0.cmd, sp0.e - t);
  } else {
    let e = sp0.e + dt;
    if (TL.snap){ const r = tlSnapFind(d.edges, [e], thr); if (r){ e += r.delta; snapT = r.t; } }
    e = Math.max(e, o0.t + TL_MIN_DUR);
    d.c.cmd = setCmdLong(o0.cmd, e - o0.t);
  }
  TL.snapT = snapT;
  state.comments.sort(cmpComments);
  state.needsRelayout = true;
  TL.dirty = true;
  tlShowInfo(d.c);
}
function tlDragRestore(d){
  for (const [c, o] of d.orig){ c.t = o.t; c.cmd = o.cmd; }
  state.comments.sort(cmpComments);
}
function tlDragCommit(d){
  if (d.copy){ tlDragCommitCopy(d); return; }
  const changes = [];
  for (const [c, o] of d.orig) if (c.t !== o.t || c.cmd !== o.cmd) changes.push({ c, t: c.t, cmd: c.cmd });
  tlDragRestore(d);
  TL.snapT = null;
  if (!changes.length){ relayout(); return; }
  const { ops, failed } = updateOps(changes);
  if (failed) toast(T('同じ時刻・内容のコメントがあるため一部を変更できませんでした'));
  if (!commitOps(ops)) relayout();
  tlSelChanged();
}
// Option＋ドラッグで複製: 動かした先に同じ本文・コマンドのコメントを作り、元は戻す。作ったものを選ぶ
function tlDragCommitCopy(d){
  const copies = [];
  for (const [c, o] of d.orig) if (c.t !== o.t) copies.push(makeComment(c.t, c.cmd, c.text, true));
  tlDragRestore(d);
  TL.snapT = null;
  if (!copies.length){ relayout(); return; }
  const r = newComments(copies);
  const ch = r.items.length ? commitOps(r.items.map(addOp)) : null;
  if (!ch){ relayout(); toast(T('同じ時刻・内容のコメントがあるため複製できませんでした')); return; }
  TL.sel = new Set(r.items.map(c => c.id));
  tlSelChanged();
  toast(T`${r.items.length} 件を複製しました` + (r.dup ? T`（同じ時刻・内容のものがある ${r.dup} 件は除きました）` : ''), { action: { label: T('元に戻す'), fn: () => revertChange(ch) } });
}
function tlCancelDrag(){
  const d = TL.drag;
  TL.drag = null; TL.snapT = null;
  if (d && d.orig && d.started){ tlDragRestore(d); relayout(); tlSelChanged(); }
  if (d && d.type === 'marquee' && d.started){ TL.sel = new Set(d.base); tlSelChanged(); }
}
// 範囲選択: 囲んだ範囲（時刻と段。ドラッグを始めた所は時刻と全体の中の高さで覚え、スクロールしてもずれない）に掛かるコメントを選ぶ
function tlMarqueeRect(d){
  const t1 = xt(d.lastX), y1 = d.lastY + TL.scrollY;
  return { ta: Math.min(d.at, t1), tb: Math.max(d.at, t1), ya: Math.min(d.ay, y1), yb: Math.max(d.ay, y1) };
}
function tlMarqueeUpdate(d){
  if (d.lastX == null) return;
  const r = tlMarqueeRect(d), lh = laneH(), sel = new Set(d.base);
  const cs = state.comments, lo = firstAtOrAfter(cs, r.ta - (TL.maxDur || DEFAULT_DURATION)), hi = firstAtOrAfter(cs, r.tb + NAKA_LEAD + 1e-6);
  for (let i = lo; i < hi; i++){
    const c = cs[i], pos = TL.laneOf.get(c.id);
    if (!pos) continue;
    const sp = spanOf(c);
    if (sp.e < r.ta || sp.s > r.tb) continue;
    const top = TL_RULER + TL.groups[pos.g].y + pos.lane * lh; // スクロールしていないときの位置（全体の中の高さ）
    if (top + lh < r.ya || top > r.yb) continue;
    sel.add(c.id);
  }
  if (sel.size !== TL.sel.size || [...sel].some(id => !TL.sel.has(id))){ TL.sel = sel; tlSelChanged(); }
  TL.dirty = true;
}
function tlStartPinch(){
  const [a, b] = [...TL.pointers.values()];
  TL.pinch = { d0: Math.max(10, Math.abs(a.x - b.x)), pps0: TL.pps, tc: xt((a.x + b.x) / 2), cy: (a.y + b.y) / 2, sy0: TL.scrollY };
}
function tlPinchMove(){
  const [a, b] = [...TL.pointers.values()];
  if (!a || !b) return;
  const p = TL.pinch;
  TL.pps = p.pps0 * Math.max(10, Math.abs(a.x - b.x)) / p.d0;
  tlClampView();
  TL.t0 = p.tc - ((a.x + b.x) / 2 - TL_HEAD) / TL.pps;
  TL.scrollY = p.sy0 - ((a.y + b.y) / 2 - p.cy);
  tlClampView();
}
TL.main.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  TL.main.focus({ preventScroll: true });
  const p = tlLocal(e);
  TL.pointers.set(e.pointerId, p);
  try { TL.main.setPointerCapture(e.pointerId); } catch {}
  if (TL.pointers.size === 2){ tlCancelDrag(); tlStartPinch(); return; }
  if (TL.pointers.size > 2) return;
  const touch = e.pointerType !== 'mouse';
  const base = { x0: p.x, y0: p.y, started: false, touch, id: e.pointerId };
  if (p.y < TL_RULER){
    TL.drag = { ...base, type:'scrub', lastX: p.x };
    if (state.videoLoaded) seekTo(Math.max(0, xt(p.x)));
    return;
  }
  const hit = tlHit(p.x, p.y, touch);
  // 再生位置の赤い線をつかむ（コメントの無い所で、線の近く）: 目盛りの上と同じく、動かすと再生位置が動く
  if (!hit && !e.shiftKey && !e.ctrlKey && !e.metaKey && tlNearPlayhead(p.x, touch)){
    TL.drag = { ...base, type:'scrub', lastX: p.x, track: true };
    return;
  }
  // 複数選択: ⌘（Windows・Linux は Ctrl）＋ドラッグで範囲を囲み、今の選択に足す（コメントの上から始めてもよい。
  // 動かさずに離したら、今まで通りそのコメントを足す・外す）。「範囲選択」ボタンがオンのときは、空いている所のドラッグで囲む
  const multi = e.ctrlKey || e.metaKey;
  const empty = !hit || touch && !TL.sel.has(hit.c.id);
  if (p.x >= TL_HEAD && (multi || empty && TL.marqueeMode)){
    TL.drag = { ...base, type:'marquee', at: xt(p.x), ay: p.y + TL.scrollY, base: multi ? new Set(TL.sel) : new Set(), toggle: multi && hit ? hit.c.id : null, multi };
    return;
  }
  // Shift＋横にドラッグ（空いている所から）: その長さのコメントを、その段（上・流・下）に作る
  if (e.shiftKey && !hit && p.x >= TL_HEAD && !tm.on){
    const gi = tlGroupAt(p.y);
    if (gi != null){ TL.drag = { ...base, type:'create', ta: xt(p.x), gi, lane: Math.max(0, Math.floor((p.y - laneTop(gi, 0)) / laneH())) }; return; }
  }
  if (hit && (!touch || TL.sel.has(hit.c.id))){
    const c = hit.c;
    if (e.shiftKey || e.ctrlKey || e.metaKey){
      if (TL.sel.has(c.id)) TL.sel.delete(c.id); else TL.sel.add(c.id);
      TL.drag = { ...base, type:'none' };
      tlSelChanged();
      return;
    }
    if (!TL.sel.has(c.id)){ TL.sel.clear(); TL.sel.add(c.id); tlSelChanged(); }
    const moving = hit.zone === 'move' ? tlSelected() : [c];
    // Option（Alt）＋ドラッグ: 選んでいるコメントを複製して、ドラッグした所に置く（元はそのまま）
    const copy = e.altKey && hit.zone === 'move';
    // タイムマシンで見ている間は選ぶだけ（動かさない）
    TL.drag = tm.on ? { ...base, type:'none' } : { ...base, type: hit.zone, c, orig: new Map(moving.map(x => [x, { t: x.t, cmd: x.cmd }])), copy };
    return;
  }
  TL.drag = { ...base, type:'pan', t0: TL.t0, sy: TL.scrollY };
});
TL.main.addEventListener('pointermove', (e) => {
  const p = tlLocal(e);
  if (TL.pointers.has(e.pointerId)) TL.pointers.set(e.pointerId, p);
  if (TL.pinch){ tlPinchMove(); return; }
  const d = TL.drag;
  if (!d){
    if (e.pointerType === 'mouse'){ TL.hover = p; tlCursor(e); TL.dirty = true; }
    return;
  }
  if (d.id !== e.pointerId) return;
  const dx = p.x - d.x0, dy = p.y - d.y0;
  if (!d.started){
    if (Math.hypot(dx, dy) < (d.touch ? 8 : 3)) return;
    d.started = true;
    if (d.orig) tlDragBegin(d);
    if (d.type === 'move') TL.main.style.cursor = d.copy ? 'copy' : 'grabbing';
  }
  if (d.type === 'scrub'){ d.lastX = p.x; if (state.videoLoaded) seekTo(Math.max(0, xt(p.x))); }
  else if (d.type === 'marquee'){ d.lastX = p.x; d.lastY = p.y; tlMarqueeUpdate(d); }
  else if (d.type === 'create'){ d.lastX = p.x; }
  else if (d.type === 'pan'){ TL.t0 = d.t0 - dx / TL.pps; TL.scrollY = d.sy - dy; tlClampView(); }
  else if (d.orig){ d.lastX = p.x; tlDragUpdate(p.x); }
  TL.dirty = true;
});
// マウスを重ねているときのカーソル（⌘・Ctrl を押していれば複数選択の十字、Shift なら空いている所でコメントを作る印、
// Option ならコメントの上で複製の印）
// 再生位置の赤い線の近くか（線の左右この px 以内。指なら広く）
function tlNearPlayhead(x, touch){
  const px = tx(video.currentTime || 0);
  return state.videoLoaded && px >= TL_HEAD && Math.abs(x - px) <= (touch ? 12 : 5);
}
function tlCursor(mods){
  const p = TL.hover;
  if (!p || TL.drag) return;
  const hit = p.y < TL_RULER ? null : tlHit(p.x, p.y, false);
  TL.main.style.cursor = p.y < TL_RULER || !hit && !mods.shiftKey && !mods.ctrlKey && !mods.metaKey && tlNearPlayhead(p.x, false) ? 'col-resize'
    : mods.altKey && hit && hit.zone === 'move' && !mods.ctrlKey && !mods.metaKey ? 'copy'
    : p.x >= TL_HEAD && (mods.ctrlKey || mods.metaKey || !hit && TL.marqueeMode) ? 'crosshair'
    : p.x >= TL_HEAD && mods.shiftKey && !hit && tlGroupAt(p.y) != null ? 'copy'
    : !hit ? 'default' : hit.zone === 'move' ? 'grab' : 'ew-resize';
}
TL.main.addEventListener('pointerleave', () => { TL.hover = null; TL.dirty = true; });
// 押しているキーが変わったら、マウスを動かさなくてもカーソルを変える
for (const ev of ['keydown', 'keyup']) window.addEventListener(ev, (e) => { if (['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) tlCursor(e); });
window.addEventListener('blur', () => tlCursor({}));
// Shift＋ドラッグで作るコメント: ドラッグした範囲が見えている間になるように、時刻と表示時間を決めて新規の画面を開く
// （流れるコメントは 1 秒前から見えるので、始まりを 1 秒後ろにする）
function tlCreateSpan(d){
  const t1 = xt(d.lastX ?? d.x0), ta = Math.max(0, Math.min(d.ta, t1)), tb = Math.max(d.ta, t1);
  const pos = TL_GROUPS[d.gi].pos, lead = pos === 'naka' ? NAKA_LEAD : 0;
  return { ta, tb, pos, t: ta + lead, dur: Math.max(0.5, tb - ta - lead) };
}
function tlCreateCommit(d){
  const s = tlCreateSpan(d);
  openNewDialog(s.t, s.pos, s.dur);
}
function tlPointerEnd(e, cancel){
  TL.pointers.delete(e.pointerId);
  if (TL.pinch){ if (TL.pointers.size < 2) TL.pinch = null; TL.drag = null; return; }
  const d = TL.drag;
  if (!d || d.id !== e.pointerId) return;
  if (cancel){ tlCancelDrag(); return; }
  TL.drag = null;
  if (d.started){
    if (d.orig) tlDragCommit(d);
    if (d.type === 'create'){ TL.dirty = true; tlCreateCommit(d); return; }
    TL.snapT = null; TL.dirty = true;
    return;
  }
  // タップ／クリック
  const p = tlLocal(e), now = performance.now();
  const dbl = !!TL.lastTap && now - TL.lastTap.time < 380 && Math.hypot(p.x - TL.lastTap.x, p.y - TL.lastTap.y) < 24;
  TL.lastTap = dbl ? null : { time: now, x: p.x, y: p.y };
  // 目盛りの上のクリックは再生位置を動かすだけ。線の近くのクリック（動かさずに離した）は、空いている所のクリックと同じ（ダブルクリックで作成など）
  if (d.type === 'scrub' && !d.track) return;
  // ⌘（Ctrl）＋クリック: そのコメントを選択に足す・外す（空いている所なら何もしない。選択はそのまま）
  if (d.type === 'marquee' && d.multi){
    if (d.toggle){ if (TL.sel.has(d.toggle)) TL.sel.delete(d.toggle); else TL.sel.add(d.toggle); tlSelChanged(); TL.dirty = true; }
    return;
  }
  const hit = tlHit(p.x, p.y, d.touch);
  if (hit){
    if (d.type !== 'none' && !(TL.sel.size === 1 && TL.sel.has(hit.c.id))){ TL.sel.clear(); TL.sel.add(hit.c.id); tlSelChanged(); }
    if (dbl) openEditDialog(hit.c);
  } else {
    if (TL.sel.size){ TL.sel.clear(); tlSelChanged(); }
    if (dbl){
      const gi = tlGroupAt(p.y);
      const pos = gi != null ? TL_GROUPS[gi].pos : null;
      openNewDialog(Math.max(0, xt(p.x) + (pos === 'naka' || pos == null && !/\b(ue|shita)\b/.test(cmdInput.value) ? NAKA_LEAD : 0)), pos);
    } else if (state.videoLoaded) seekTo(Math.max(0, xt(p.x)));
  }
  TL.dirty = true;
}
TL.main.addEventListener('pointerup', (e) => tlPointerEnd(e, false));
TL.main.addEventListener('pointercancel', (e) => tlPointerEnd(e, true));
TL.main.addEventListener('lostpointercapture', (e) => { if (TL.pointers.has(e.pointerId)) tlPointerEnd(e, true); });
TL.main.addEventListener('contextmenu', (e) => e.preventDefault());
// トラックパッド / Magic Mouse かどうかを推定する（1回のジェスチャー中は判定を固定）
const wheelGesture = { t: -1e9, pad: false };
function isTrackpadWheel(e){
  if (settings.wheelPad === 'always') return true;
  if (settings.wheelPad === 'never') return false;
  const now = performance.now();
  if (now - wheelGesture.t < 150){ wheelGesture.t = now; return wheelGesture.pad; }
  let pad;
  if (e.deltaMode !== 0) pad = false;                       // 行・ページ単位はマウスホイール
  else if (e.deltaX !== 0) pad = true;                      // 横成分がある
  else if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0)
    pad = e.wheelDeltaY === -3 * e.deltaY || Math.abs(e.wheelDeltaY) % 120 !== 0; // マウスは 120 刻み
  else pad = !Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 16;
  wheelGesture.t = now; wheelGesture.pad = pad;
  return pad;
}
function tlWheel(e, centerX){
  e.preventDefault();
  let dx = e.deltaX, dy = e.deltaY;
  if (e.deltaMode === 1){ dx *= 16; dy *= 16; } else if (e.deltaMode === 2){ dx *= TL.W; dy *= TL.H; }
  if (e.ctrlKey || e.metaKey){ tlZoomAt(Math.exp(-dy * 0.0025), centerX); return; }
  const pad = isTrackpadWheel(e);
  const kind = $('#tlWheelKind'); if (kind) kind.textContent = pad ? T('トラックパッド（360°）') : T('マウスホイール');
  const onHead = e.currentTarget === TL.main && tlLocal(e).x < TL_HEAD;
  if (pad && !onHead){
    // 360°: 横成分は時間、縦成分は段。Shift で入れ替え
    if (e.shiftKey){ const t = dx; dx = dy; dy = t; }
    TL.t0 += dx / TL.pps;
    TL.scrollY += dy;
  } else {
    // マウスホイール: 設定した軸へ。Shift で縦横を入れ替え、横ホイール（チルト）は常に時間
    const amt = dy || dx;
    let mode = onHead ? 'tracks' : settings.wheelMouse;
    if (e.shiftKey && !onHead) mode = mode === 'tracks' ? 'time' : 'tracks';
    if (!dy && dx) mode = 'time';
    if (mode === 'zoom'){ tlZoomAt(Math.exp(-amt * 0.0025), centerX); return; }
    if (mode === 'tracks') TL.scrollY += amt; else TL.t0 += amt / TL.pps;
  }
  tlClampView();
}
TL.main.addEventListener('wheel', (e) => tlWheel(e, Math.max(TL_HEAD, tlLocal(e).x)), { passive:false });
TL.ovBox.addEventListener('wheel', (e) => { const [a, b] = ovWindow(); tlWheel(e, TL_HEAD + (TL.W - TL_HEAD) * clamp((tlLocal(e, TL.ovBox).x - a) / Math.max(1, b - a), 0, 1)); }, { passive:false });
TL.main.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  let handled = true;
  switch (e.key){
    case 'Delete': case 'Backspace': deleteSelected(); break;
    case 'Enter': { const s = tlSelected(); if (s.length === 1) openEditDialog(s[0]); else openNewDialog(video.currentTime || 0); break; }
    case 'Escape': TL.sel.clear(); tlSelChanged(); break;
    case 'n': case 'N': toggleSnap(); break;
    case '=': case '+': tlZoomAt(1.5, tlZoomCenterX()); break;
    case '-': case '_': tlZoomAt(1 / 1.5, tlZoomCenterX()); break;
    case 'Z': tlFit(); break;
    case ',': nudgeSelected(-0.1); break;
    case '.': nudgeSelected(0.1); break;
    case '<': nudgeSelected(-1); break;
    case '>': nudgeSelected(1); break;
    case 'a': case 'A': if (e.shiftKey){ TL.sel = new Set(state.comments.map(c => c.id)); tlSelChanged(); } else handled = false; break;
    default: handled = false;
  }
  if (handled){ e.preventDefault(); e.stopPropagation(); }
});

/* ---------- 全体表示（オーバービュー） ---------- */
TL.ovBox.addEventListener('pointerdown', (e) => {
  if (e.button > 0) return;
  const p = tlLocal(e, TL.ovBox), [a, b] = ovWindow();
  const z = e.pointerType === 'mouse' ? 7 : 14;
  const vis = (TL.W - TL_HEAD) / TL.pps;
  let type;
  if (Math.abs(p.x - a) <= z && p.x <= (a + b) / 2) type = 'L';
  else if (Math.abs(p.x - b) <= z) type = 'R';
  else if (p.x > a && p.x < b) type = 'pan';
  else { TL.t0 = ovT(p.x) - vis / 2; tlClampView(); type = 'pan'; }
  try { TL.ovBox.setPointerCapture(e.pointerId); } catch {}
  TL.ovDrag = { type, id: e.pointerId, x0: p.x, t0: TL.t0, t1: TL.t0 + vis };
});
TL.ovBox.addEventListener('pointermove', (e) => {
  const p = tlLocal(e, TL.ovBox), d = TL.ovDrag;
  if (!d){
    if (e.pointerType === 'mouse'){ const [a, b] = ovWindow(); TL.ovBox.style.cursor = (Math.abs(p.x - a) <= 7 || Math.abs(p.x - b) <= 7) ? 'ew-resize' : (p.x > a && p.x < b) ? 'grab' : 'pointer'; }
    return;
  }
  if (d.id !== e.pointerId) return;
  const W = TL.W - TL_HEAD;
  if (d.type === 'pan') TL.t0 = d.t0 + (ovT(p.x) - ovT(d.x0));
  else if (d.type === 'L'){ const t0 = Math.min(ovT(p.x), d.t1 - 0.5); TL.pps = W / (d.t1 - t0); TL.t0 = t0; }
  else { const t1 = Math.max(ovT(p.x), d.t0 + 0.5); TL.pps = W / (t1 - d.t0); TL.t0 = d.t0; }
  tlClampView();
});
for (const ev of ['pointerup', 'pointercancel']) TL.ovBox.addEventListener(ev, (e) => { if (TL.ovDrag && TL.ovDrag.id === e.pointerId) TL.ovDrag = null; });

/* ---------- ツールバー ---------- */
function toggleSnap(){ TL.snap = settings.tlSnap = !TL.snap; saveSettings(); $('#tlSnap').classList.toggle('on', TL.snap); toast(TL.snap ? T('スナップ オン') : T('スナップ オフ'), { timeout:1200 }); }
$('#tlSnap').classList.toggle('on', TL.snap);
$('#tlFollow').classList.toggle('on', TL.follow);
$('#tlSnap').onclick = toggleSnap;
// 範囲選択ボタン（オンの間は、空いている所のドラッグで範囲を囲んで選ぶ。スマホ・タブレット向け。覚えない）
$('#tlMarquee').onclick = () => { TL.marqueeMode = !TL.marqueeMode; $('#tlMarquee').classList.toggle('on', TL.marqueeMode); tlCursor({}); };
$('#tlFollow').onclick = () => { TL.follow = settings.tlFollow = !TL.follow; saveSettings(); $('#tlFollow').classList.toggle('on', TL.follow); };
$('#tlNew').onclick = () => openNewDialog(video.currentTime || 0);
$('#tlEdit').onclick = () => { const s = tlSelected(); if (s.length === 1) openEditDialog(s[0]); };
$('#tlDelete').onclick = deleteSelected;
$('#tlUndo').onclick = undo;
$('#tlRedo').onclick = redo;
$('#tlPlay').onclick = () => { if (!state.videoLoaded){ toast(T('先に動画を開いてください')); return; } togglePlay(); };
$('#tlIn').onclick = () => rangeSet('in');
$('#tlOut').onclick = () => rangeSet('out');
$('#tlRangeClear').onclick = () => rangeClear();
$('#tlLoop').onclick = () => { settings.tlLoop = !settings.tlLoop; saveSettings(); rangeUI(); toast(settings.tlLoop ? (rangeSpan() ? T('ループ再生 オン（イン点〜アウト点）') : T('ループ再生 オン（全体）')) : T('ループ再生 オフ'), { timeout:1400 }); };
// タイムコード：押して時刻を打ち、Enter でそこへ移る（Esc でやめる）
(() => {
  const tc = $('#tlTime');
  tc.addEventListener('focus', () => setTimeout(() => tc.select(), 0));
  tc.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing){
      e.preventDefault();
      const t = parseTime(tc.value);
      if (isFinite(t) && t >= 0) seekTo(t); else toast(T('時刻は 1:23.5 や 83.5 のように打ってください'), { timeout:2500 });
      tc.blur();
    } else if (e.key === 'Escape'){ e.preventDefault(); tc.blur(); }
    e.stopPropagation();
  });
  tc.addEventListener('blur', () => { tc.value = fmtPrecise(video.currentTime || 0); });
})();
$('#setLane').value = LANE_H[settings.tlLane] ? settings.tlLane : 'm';
$('#setLane').onchange = (e) => { settings.tlLane = e.target.value; saveSettings(); tlRelane(); };
rangeUI();
$('#tlZoomIn').onclick = () => tlZoomAt(1.5, tlZoomCenterX());
$('#tlZoomOut').onclick = () => tlZoomAt(1 / 1.5, tlZoomCenterX());
$('#tlFit').onclick = tlFit;
$('#setWheelMouse').value = settings.wheelMouse;
$('#setWheelPad').value = settings.wheelPad;
$('#setWheelMouse').onchange = (e) => { settings.wheelMouse = e.target.value; saveSettings(); };
$('#setWheelPad').onchange = (e) => { settings.wheelPad = e.target.value; saveSettings(); };
$('#tlSettings').onclick = () => settingsOpen('tl');
$('#tlZoom').oninput = (e) => {
  const b = tlBounds();
  tlZoomAt(b.minPps * Math.pow(b.maxPps / b.minPps, e.target.value / 1000) / TL.pps, tlZoomCenterX());
};
// 縦向きのスマホ：タブの上のつまみで動画の大きさを変え、下の画面（タイムライン・リスト・Vim・履歴）がその残りに広がる（ダブルタップで元に戻す）
(() => {
  const h = $('#mResize');
  let st = null;
  // 動画をどこまで大きくできるか（枠の横幅いっぱいまで）
  const mVideoMax = () => Math.max(0.12, Math.min(0.6, $('#player').clientWidth * 9 / 16 / stableH));
  h.addEventListener('pointerdown', (e) => {
    st = { y: e.clientY, f: Math.min(settings.mVideo, mVideoMax()) };
    h.setPointerCapture(e.pointerId); h.classList.add('on');
  });
  h.addEventListener('pointermove', (e) => {
    if (!st) return;
    settings.mVideo = Math.round(clamp(st.f + (e.clientY - st.y) / stableH, 0.12, mVideoMax()) * 1000) / 1000;
    applyLayoutVars();
  });
  const end = () => { if (st){ st = null; h.classList.remove('on'); saveSettings(); } };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { settings.mVideo = M_VIDEO; applyLayoutVars(); saveSettings(); });
})();
// PC：パネルの境目のつまみ。縦のすき間（gutV）で右の列の幅、横のすき間（gutH）で下の行の高さ、
// 2本が交わる所（gutC）で両方を変える。ダブルクリックで、その配置の元の大きさに戻す
(() => {
  const V = $('#gutV'), H = $('#gutH'), C = $('#gutC');
  for (const [h, dw, dh] of [[V, 1, 0], [H, 0, 1], [C, 1, 1]]){
    let st = null;
    const marks = h === C ? [C, V, H] : [h];
    const mark = (on) => { for (const m of marks) m.classList.toggle('on', on); };
    if (h === C){
      h.addEventListener('pointerenter', () => mark(true));
      h.addEventListener('pointerleave', () => { if (!st) mark(false); });
    }
    h.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const L = layoutCur(), sz = layoutSize();
      st = { x: e.clientX, y: e.clientY, w: sz.w, h: sz.h, L };
      h.setPointerCapture(e.pointerId); mark(true);
      e.preventDefault();
    });
    h.addEventListener('pointermove', (e) => {
      if (!st) return;
      if (dw) settings[st.L.w] = Math.round(st.w - (e.clientX - st.x));
      if (dh) settings[st.L.h] = Math.round(st.h - (e.clientY - st.y));
      const sz = layoutSize(); // 範囲に収めた大きさで覚える
      settings[st.L.w] = sz.w; settings[st.L.h] = sz.h;
      applyLayoutVars();
    });
    const end = (e) => { if (st){ st = null; saveSettings(); if (e.type === 'pointercancel' || !h.matches(':hover') || h !== C) mark(false); } };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => {
      const L = layoutCur();
      if (dw) settings[L.w] = L.dw;
      if (dh) settings[L.h] = L.dh;
      applyLayoutVars(); saveSettings();
    });
  }
})();

/* =====================================================================
   コメント編集ダイアログ
   ===================================================================== */
const editDlg = $('#editDlg');
let editTarget = null;
// 編集画面を開いたときの値（保存するときの「変更前の値」。開いている間にほかの人が変えても、これと比べて 3-way マージする）
let editBase = null;
function edSync(){
  const o = parseCmd(normCmd($('#edCmd').value));
  $('#edPos').value = o.pos;
  if (document.activeElement !== $('#edDur')) $('#edDur').value = o.long ?? DEFAULT_DURATION;
  const d = o.long ?? DEFAULT_DURATION;
  $('#edSpeed').textContent = o.pos === 'naka' ? T`流れる速さ ×${((DEFAULT_DURATION + NAKA_LEAD) / (d + NAKA_LEAD)).toFixed(2)}` : '';
}
function openEditDialog(c){
  if (tmLocked()) return;
  editTarget = c;
  editBase = pickFields(c);
  $('#edTitle').textContent = T('コメントを編集');
  $('#edText').value = c.text;
  $('#edTime').value = fmtPrecise(c.t);
  $('#edCmd').value = c.cmd;
  $('#edDelete').hidden = false;
  edSync();
  editDlg.showModal();
  $('#edText').focus();
}
function openNewDialog(t, pos, dur){
  if (tmLocked()) return;
  editTarget = null;
  $('#edTitle').textContent = T('新しいコメント');
  $('#edText').value = '';
  $('#edTime').value = fmtPrecise(t);
  $('#edCmd').value = pos ? setCmdPos(cmdInput.value, pos) : normCmd(cmdInput.value);
  if (dur > 0) $('#edCmd').value = setCmdLong($('#edCmd').value, dur); // 表示時間（Shift＋ドラッグで作ったとき）
  $('#edDelete').hidden = true;
  edSync();
  editDlg.showModal();
  $('#edText').focus();
}
$('#edCmd').addEventListener('input', edSync);
$('#edPos').onchange = () => { $('#edCmd').value = setCmdPos($('#edCmd').value, $('#edPos').value); edSync(); };
$('#edDur').oninput = () => { const v = parseFloat($('#edDur').value); if (v > 0){ $('#edCmd').value = setCmdLong($('#edCmd').value, v); edSync(); } };
$('#edNow').onclick = () => { $('#edTime').value = fmtPrecise(video.currentTime || 0); };
$('#edCancel').onclick = () => editDlg.close();
$('#edDelete').onclick = () => { const c = editTarget; editDlg.close(); if (c){ TL.sel.delete(c.id); deleteComment(c); tlSelChanged(); } };
$('#edText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); edCommit(); }
});
$('#edOk').onclick = edCommit;
function edCommit(){
  const t = parseTime($('#edTime').value);
  if (!isFinite(t) || t < 0){ toast(T('開始時刻を 1:23.45 のような形式で入力してください'), { type:'error' }); $('#edTime').focus(); return; }
  const text = $('#edText').value.replace(/\s+$/, '');
  if (!text.trim()){ toast(T('本文を入力してください'), { type:'error' }); $('#edText').focus(); return; }
  const cmd = normCmd($('#edCmd').value);
  let conflict = null;
  if (editTarget){
    // 開いたときの値（editBase）から自分が変えた項目だけを、その値からの変更として適用する。
    // ほかの人が同じ項目を変えていたり、コメントを削除していたりしたら衝突として選んでもらう（3-way マージ）
    const id = editTarget.id, base = editBase, f = normFields(t, cmd, text);
    const changed = COMMENT_FIELDS.filter(k => f[k] !== base[k]);
    const cur = store.get(id);
    if (changed.length){
      if (cur){
        const m = { ...pickFields(cur), ...pickFields(f, changed) }, key = commentKey(m.t, m.cmd, m.text);
        if (key !== cur.key && store.hasKey(key)){ toast(T('同じ時刻・内容のコメントが既にあります'), { type:'error' }); return; }
      }
      const conflicts = [];
      commitOps([{ type:'update', id, before: pickFields(base, changed), after: pickFields(f, changed) }], { conflicts });
      if (conflicts.length) conflict = { reason: conflicts[0].reason, id, base, mine: pickFields(f, changed) };
    }
    if (store.has(id)) TL.sel = new Set([id]);
  } else {
    const c = makeComment(t, cmd, text, true);
    if (store.hasKey(c.key)){ toast(T('同じ時刻・内容のコメントが既にあります'), { type:'error' }); return; }
    commitOps([addOp(c)]);
    TL.sel = new Set([c.id]);
    tlEnsureVisible(c);
  }
  editDlg.close();
  tlSelChanged();
  if (conflict) addEditConflict(conflict);
}
// 編集画面で保存した変更がほかの人の変更と重なったとき、衝突の解決画面に出す
function addEditConflict({ reason, id, base, mine }){
  const cur = store.get(id), theirs = cur ? pickFields(cur) : null;
  collab.conflicts.push({ key: 'edit:' + uuidv7(), id, reason, opType: 'update', base: { ...base },
    mine: { ...(theirs || base), ...mine }, theirs, at: Date.now() });
  conflictsChanged();
  conflictOpen();
}
editDlg.addEventListener('close', () => { editTarget = null; TL.main.focus({ preventScroll:true }); });

/* =====================================================================
   Vim エディタ（画面）
   ===================================================================== */
const VIM_HEADER = [
  T('" コメナガレ ― 1行 = 1コメント   書式: 時刻 コマンド | 本文   （本文中の改行は \\n）'),
  T('" :w 反映  :q 閉じる  :e! 読み直し  :seek 再生位置へ  :now 再生位置に追加  :help ヘルプ'),
];
const VIM_TIME_RE = /^\d+(?::\d+){0,2}(?:\.\d+)?$/;
const KNOWN_FLAGS = new Set(['invisible', 'full', 'ender', '_live']);
const vimEl = $('#vim'), vimScreen = $('#vimScreen'), vimInput = $('#vimInput');
const vim = { E: null, synced: -1, needsRender: false, lastPlayRender: 0, lineH: 0, ctrl: false, comp: 0, composing: false, touch: null, mouse: null, writing: false };

function commentToLine(c){
  return `${fmtPrecise(c.t)} ${c.cmd ? c.cmd + ' ' : ''}| ${c.text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}`;
}
function vimBufferText(){ return VIM_HEADER.concat(state.comments.map(commentToLine)).join('\n'); }
function parseVimLine(ln){
  if (!ln.trim() || /^\s*"/.test(ln)) return null;
  const m = /^\s*([0-9][0-9:.]*)(?=\s|\||$)(.*)$/.exec(ln);
  if (!m) return { error:T('行頭に時刻（例 01:23.45）が必要です') };
  const t = parseTime(m[1]);
  if (!VIM_TIME_RE.test(m[1]) || !isFinite(t)) return { error:T`時刻「${m[1]}」を解釈できません` };
  const rest = m[2], bar = rest.indexOf('|');
  let cmd = '', text;
  if (bar >= 0){ cmd = rest.slice(0, bar).trim(); text = rest.slice(bar + 1); if (text.startsWith(' ')) text = text.slice(1); }
  else text = rest.trim();
  text = text.replace(/\\(.)/g, (x, ch) => ch === 'n' ? '\n' : ch === 't' ? '\t' : ch);
  if (!text.trim()) return { error:T('本文が空です') };
  return { t, cmd, text };
}
function vimWrite(text, force){
  if (tm.on) return { ok:false, err:T('E21: タイムマシンで見ている間は書き込めません（「終了」で今に戻ります）') };
  if (!force && vim.synced !== state.version) return { ok:false, err:T('E949: コメントは読み込み後に他の場所で変更されています（:w! で上書き、:e! で読み直し）') };
  const parsed = [], errors = [];
  text.split('\n').forEach((ln, i) => {
    const r = parseVimLine(ln);
    if (!r) return;
    if (r.error) errors.push({ line: i + 1, msg: r.error });
    else parsed.push(r);
  });
  if (errors.length) return { ok:false, err:T`E: ${errors[0].line} 行目: ${errors[0].msg}` + (errors.length > 1 ? T`（ほか ${errors.length - 1} 件）` : '') };
  const oldByKey = new Map(state.comments.map(c => [c.key, c]));
  const next = [], seen = new Set();
  let added = 0, dup = 0;
  for (const p of parsed){
    const c0 = makeComment(p.t, p.cmd, p.text, true);
    if (seen.has(c0.key)){ dup++; continue; }
    seen.add(c0.key);
    const old = oldByKey.get(c0.key);
    next.push(old || c0);
    if (!old) added++;
  }
  const removed = state.comments.filter(c => !seen.has(c.key));
  if (added || removed.length){
    vim.writing = true;
    try { commitOps([...removed.map(deleteOp), ...next.filter(c => !store.has(c.id)).map(addOp)]); }
    finally { vim.writing = false; }
  }
  vim.synced = state.version;
  return { ok:true, msg:T`"コメント" ${next.length}件 反映しました（追加 ${added} / 削除 ${removed.length}${dup ? T` / 重複 ${dup}` : ''}）` };
}
function vimReload(force){
  const E = vim.E;
  if (!E || (E.modified && !force)) return;
  const line = E.cur.line, top = E.top;
  E.load(vimBufferText());
  E.setCursor(Math.min(line, E.lines.length - 1), E.cur.col);
  E.top = Math.min(top, E.lines.length - 1);
  vim.synced = state.version;
  vimScheduleRender();
}
function vimCommentsChanged(){ if (vim.E && !vim.writing) vimReload(false); }
function vimQuit(){
  if (vim.E && vim.E.modified) vimReload(true);
  if (mq.matches) settings.mobilePane = 'timeline'; else settings.sidePane = 'list';
  saveSettings();
  vimInput.blur();
  applyPanes();
}
function vimEx(name, args, ctx){
  const n = name.toLowerCase();
  if (n === 'seek'){
    if (!state.videoLoaded) return T('E: 動画が開かれていません');
    let t;
    if (args){ t = parseTime(args); if (!isFinite(t)) return T`E: 時刻「${args}」を解釈できません`; }
    else {
      const r = parseVimLine(ctx.line);
      if (!r || r.error) return T('E: この行には時刻がありません');
      t = parseCmd(normCmd(r.cmd)).pos === 'naka' ? r.t - NAKA_LEAD : r.t;
    }
    seekTo(Math.max(0, t));
    return `▶ ${fmtPrecise(Math.max(0, t))}`;
  }
  if (n === 'now'){
    const cmd = normCmd(cmdInput.value);
    ctx.api.openLineBelow(`${fmtPrecise(video.currentTime || 0)} ${cmd ? cmd + ' ' : ''}| `);
    return true;
  }
  if (n === 'play'){ togglePlay(); return true; }
  return false;
}
function vimHelp(){
  return [
    T('コメナガレ Vim エディタ                                   （Enter / q で閉じる）'),
    '',
    T('書式        時刻 コマンド | 本文       例) 01:23.45 ue red @5 | こんにちは'),
    T('            本文の改行は \\n 、\\ 自体は \\\\ 。" で始まる行と空行は無視されます。'),
    T('            表示時間はコマンドの @秒数。時刻の数字は Ctrl-a / Ctrl-x で増減できます。'),
    T('反映        :w（:w! 他所での変更を上書き） :wq :x ZZ   閉じる :q :q! ZQ   読み直し :e!'),
    T('独自        :seek [時刻] 動画をシーク   :now 再生位置で行を追加   :play 再生/一時停止'),
    '',
    T('モード      i a I A o O gi gI R s S C   v V Ctrl-v gv   :   / ?'),
    T('移動        h j k l  w b e ge W B E gE  0 ^ $ g_ |  f F t T ; ,  gg G H M L  % { } ( )'),
    '            Ctrl-d u f b e y  zz zt zb  n N * # g* g#  m{a-z} `{a-z} \'{a-z}  Ctrl-o Ctrl-i',
    T('オペレータ  d c y > < g~ gu gU g? = ＋ モーション／テキストオブジェクト（dd cc yy >> など）'),
    '            iw aw iW aW is as ip ap i( a( ib i{ iB i[ i< i" i\' i`',
    T('編集        x X D C Y p P gp gP ]p J gJ r ~ u U Ctrl-r . Ctrl-a Ctrl-x'),
    T('レジスタ    "a-z "A-Z "0-9 "- "_ "+ ". ": "/ "%    マクロ q{reg} … q  @{reg} @@ @:'),
    T('挿入モード  Ctrl-w Ctrl-u Ctrl-h Ctrl-r{reg} Ctrl-o Ctrl-a Ctrl-e Ctrl-y Ctrl-t Ctrl-d'),
    '            Ctrl-v Ctrl-n Ctrl-p Insert',
    T('ビジュアル  o O d x c s r y p P > < ~ u U J gJ I A : Ctrl-a Ctrl-x g Ctrl-a'),
    'Ex          :s :& :&& :g :v :d :y :m :t :co :j :> :< :normal :sort :pu :k :mark',
    '            :noh :set :reg :marks :jumps :delm :p :nu := :undo :redo :retab',
    T('            範囲  % . $ 数字 \'a \'<,\'> /pat/ ?pat? +n -n ;   区切り |'),
    ':set        number relativenumber wrap linebreak ignorecase smartcase hlsearch incsearch',
    '            wrapscan shiftwidth expandtab tabstop joinspaces report',
    T('            例) :set nowrap 折り返さない  :set linebreak 単語の区切りで折り返す'),
    T('            変えた設定は次に開いたときも使われます（:set {名前}& / :set all& で既定に戻す）'),
    '',
    T('注意        Ctrl-w / Ctrl-n / Ctrl-t などブラウザ予約キーは効かないことがあります。'),
    T('            ノーマルモードでは IME をオフにしてください（挿入モードの日本語入力は可）。'),
  ];
}
function vimEnsure(){
  if (vim.E) return vim.E;
  const E = vim.E = createVimEngine({
    write: vimWrite, quit: vimQuit,
    reload: () => { vim.synced = state.version; return vimBufferText(); },
    ex: vimEx, exNames: ['seek', 'now', 'play'], help: vimHelp,
    clipboardWrite: (t) => { try { navigator.clipboard?.writeText(t).catch(() => {}); } catch {} },
    clipboardRead: navigator.clipboard?.readText ? () => navigator.clipboard.readText() : null,
    bell: () => { vimEl.classList.add('bell'); setTimeout(() => vimEl.classList.remove('bell'), 90); },
    onChange: vimScheduleRender, onOption: vimSaveOpts,
  });
  // :set で変えた設定（既定値と違うものだけ）を settings.vimOpts に控え、次に開いたときにも使う
  const saved = settings.vimOpts && typeof settings.vimOpts === 'object' ? settings.vimOpts : {};
  for (const [k, v] of Object.entries(saved)){
    const d = E.optDefaults[k];
    if (typeof d === 'boolean' ? typeof v === 'boolean' : typeof d === 'number' && Number.isInteger(v) && v >= 0) E.opts[k] = v;
  }
  E.fileName = T('コメント');
  E.load(vimBufferText());
  E.setCursor(VIM_HEADER.length, 0);
  vim.synced = state.version;
  return E;
}
function vimSaveOpts(){
  const E = vim.E;
  settings.vimOpts = Object.fromEntries(Object.keys(E.opts).filter(k => E.opts[k] !== E.optDefaults[k]).map(k => [k, E.opts[k]]));
  saveSettings();
  vimScheduleRender();
}
function vimScheduleRender(){ vim.needsRender = true; }
function vimFrame(playing, t){
  if (!vim.E || $('#paneVim').hidden || !vimScreen.clientHeight) return;
  if (playing && performance.now() - vim.lastPlayRender > 250){ vim.lastPlayRender = performance.now(); vim.needsRender = true; }
  if (vim.needsRender) vimRender();
}
const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
const nextIdx = (s, i) => { const c = s.charCodeAt(i); return c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length ? i + 2 : i + 1; };
function vimLineHtml(li, ctx){
  const s = ctx.L[li], n = s.length;
  const cls = new Array(n).fill(''), sty = new Array(n).fill('');
  if (/^\s*"/.test(s)) cls.fill('k-com');
  else if (s.trim()){
    const m = /^(\s*)([0-9][0-9:.]*)?(.*)$/.exec(s);
    let i = m[1].length;
    if (m[2] && (m[3] === '' || /^[\s|]/.test(m[3]))){
      const c = VIM_TIME_RE.test(m[2]) ? 'k-time' : 'k-err';
      for (let k = i; k < i + m[2].length; k++) cls[k] = c;
      i += m[2].length;
    } else {
      const tok = /^[^\s|]+/.exec(s.slice(i));
      if (tok){ for (let k = i; k < i + tok[0].length; k++) cls[k] = 'k-err'; i += tok[0].length; }
    }
    const bar = s.indexOf('|', i);
    if (bar >= 0){
      const re = /\S+/g, seg = s.slice(i, bar);
      let t;
      while ((t = re.exec(seg))){
        const tok = t[0], a = i + t.index, g = tokGroup(tok);
        const color = g === 'color' ? (COLOR_TABLE[tok.toLowerCase()] || expandHex(tok)) : '';
        const c = g === 'long' ? 'k-dur' : g === 'pos' ? 'k-pos' : (g.startsWith('flag:') && !KNOWN_FLAGS.has(tok.toLowerCase())) ? 'k-err' : 'k-cmd';
        for (let k = a; k < a + tok.length; k++){ cls[k] = c; if (color) sty[k] = color; }
      }
      cls[bar] = 'k-sep';
      for (let k = bar + 1; k < n; k++){
        if (s[k] === '\\' && k + 1 < n){ cls[k] = cls[k + 1] = 'k-esc'; k++; }
        else cls[k] = '';
      }
    }
  }
  const ov = new Uint8Array(n + 1);
  if (ctx.re) for (const [a, len] of ctx.E.matchesIn(ctx.re, s)) for (let k = a; k < a + Math.max(1, len) && k <= n; k++) ov[k] |= 2;
  if (ctx.inc && ctx.inc.line === li) for (let k = ctx.inc.col; k < ctx.inc.col + Math.max(1, ctx.inc.len) && k <= n; k++) ov[k] |= 8;
  const r = ctx.vr;
  if (r && li >= r.start.line && li <= r.end.line){
    let a, b;
    if (r.type === 'line'){ a = 0; b = n + 1; }
    else if (r.type === 'block'){ a = Math.min(r.c1, n); b = r.toEol ? n + 1 : Math.min(r.c2 < n ? nextIdx(s, r.c2) : r.c2 + 1, n + 1); }
    else { a = li === r.start.line ? r.start.col : 0; b = li === r.end.line ? r.end.col : n + 1; }
    for (let k = a; k < b && k <= n; k++) ov[k] |= 1;
  }
  if (ctx.cur && ctx.cur.line === li){
    const c = Math.min(ctx.cur.col, n), e = c < n ? nextIdx(s, c) : c + 1;
    for (let k = c; k < e; k++) ov[k] |= 4;
  }
  const N = ov[n] ? n + 1 : n;
  const keyAt = (x) => x < n ? cls[x] + '|' + sty[x] + '|' + ov[x] : '||' + ov[x];
  let html = '';
  for (let k = 0; k < N;){
    const kk = keyAt(k);
    let j = k + 1;
    while (j < N && j < n && keyAt(j) === kk) j++;
    const text = k >= n ? ' ' : s.slice(k, j);
    let c = k < n ? cls[k] : '';
    const o = ov[k];
    if (o & 1) c += ' o-vis';
    if (o & 2) c += ' o-srch';
    if (o & 8) c += ' o-inc';
    if (o & 4) c += ' ' + ctx.curCls;
    html += `<span class="${c.trim()}" data-c="${k}"${k < n && sty[k] ? ` style="color:${sty[k]}"` : ''}>${escHtml(text)}</span>`;
    k = j;
  }
  return html;
}
function vimRender(){
  vim.needsRender = false;
  const E = vim.E;
  if (!E || !vimScreen.clientHeight) return;
  if (!vim.lineH){ const p = document.createElement('div'); p.className = 'vl'; p.innerHTML = '<span class="lt">X</span>'; vimScreen.append(p); vim.lineH = p.getBoundingClientRect().height || 19; p.remove(); }
  const rows = Math.max(1, Math.floor(vimScreen.clientHeight / vim.lineH));
  E.rows = rows;
  const L = E.lines;
  const focusLine = E.incMatch ? E.incMatch.line : E.cur.line;
  if (focusLine < E.top) E.top = E.top - focusLine > rows ? Math.max(0, focusLine - (rows >> 1)) : focusLine;
  else if (focusLine >= E.top + rows) E.top = focusLine - (E.top + rows) > rows ? Math.max(0, focusLine - (rows >> 1)) : focusLine - rows + 1;
  E.top = clamp(E.top, 0, Math.max(0, L.length - 1));
  vimEl.classList.toggle('nonu', !E.opts.number && !E.opts.relativenumber);
  vimEl.classList.toggle('nowrap', !E.opts.wrap);
  vimEl.classList.toggle('lbr', E.opts.linebreak);
  const nw = Math.max(3, String(L.length).length);
  const nowT = video.currentTime || 0, playingNow = state.videoLoaded;
  const ctx = {
    E, L, re: E.searchRe(), inc: E.incMatch, vr: E.visualRange(),
    cur: E.mode === 'cmdline' ? null : E.cur,
    curCls: E.mode === 'insert' ? 'o-bar' : E.mode === 'replace' ? 'o-und' : 'o-cur',
  };
  const draw = () => {
    let html = '';
    for (let i = 0; i <= rows; i++){
      const li = E.top + i;
      if (li >= L.length){ html += `<div class="vl tilde"><span class="ln">${' '.repeat(nw)}</span><span class="lt">~</span></div>`; continue; }
      let num;
      if (E.opts.relativenumber){ const d = Math.abs(li - E.cur.line); num = d === 0 && E.opts.number ? String(li + 1).padEnd(nw) : String(d).padStart(nw); }
      else num = String(li + 1).padStart(nw);
      let lnCls = li === E.cur.line ? ' cur' : '';
      if (playingNow && /^\s*\d/.test(L[li])){
        const p = parseVimLine(L[li]);
        if (p && !p.error){ const sp = spanFromVals(p.t, normCmd(p.cmd)); if (nowT >= sp.s && nowT < sp.e) lnCls += ' now'; }
      }
      html += `<div class="vl" data-l="${li}"><span class="ln${lnCls}">${num}</span><span class="lt">${vimLineHtml(li, ctx)}</span></div>`;
    }
    vimScreen.innerHTML = html;
  };
  draw();
  for (let guard = 0; guard < 400; guard++){
    const el = vimScreen.children[focusLine - E.top];
    if (!el || E.top >= focusLine || el.offsetTop + el.offsetHeight <= vimScreen.clientHeight + 0.5) break;
    E.top++; draw();
  }
  // 横スクロール（nowrap）
  const curEl = vimScreen.querySelector('.o-cur,.o-bar,.o-und');
  if (!E.opts.wrap && curEl){
    const lnW = vimScreen.querySelector('.ln')?.offsetWidth || 0;
    const x = curEl.offsetLeft, w = curEl.offsetWidth || 8;
    if (x - lnW < vimScreen.scrollLeft) vimScreen.scrollLeft = Math.max(0, x - lnW - 20);
    else if (x + w > vimScreen.scrollLeft + vimScreen.clientWidth) vimScreen.scrollLeft = x + w - vimScreen.clientWidth + 20;
  } else if (E.opts.wrap) vimScreen.scrollLeft = 0;
  // ステータス行
  const pct = E.top === 0 && E.top + rows >= L.length ? 'All' : E.top === 0 ? 'Top' : E.top + rows >= L.length ? 'Bot' : Math.round(E.top * 100 / Math.max(1, L.length - rows)) + '%';
  const stale = vim.synced !== state.version;
  const ch = [...L[E.cur.line].slice(0, E.cur.col)].length + 1;
  $('#vimStatus').innerHTML = `<span class="grow">"${escHtml(E.fileName)}"${E.modified ? ' <span class="mod">[+]</span>' : ''}${stale ? T(' <span class="stale">[他所で変更あり]</span>') : ''}</span>`
    + `<span>${state.videoLoaded ? '▶ ' + fmtPrecise(nowT) : ''}</span><span>${E.cur.line + 1},${ch}</span><span>${pct}</span>`;
  // コマンド行
  let left;
  if (E.mode === 'cmdline' && E.cmd){
    const t = E.cmd.text, p = E.cmd.pos;
    const at = t.slice(p, nextIdx(t, p)) || ' ';
    left = `<span class="grow">${escHtml(E.cmd.type + t.slice(0, p))}<span class="cc">${escHtml(at)}</span>${escHtml(t.slice(p + (at === ' ' && p >= t.length ? 0 : at.length)))}</span>`;
  } else if (E.msg){
    left = `<span class="grow${E.msgErr ? ' err' : ''}">${escHtml(E.msg)}</span>`;
  } else {
    const modes = { insert:'-- INSERT --', replace:'-- REPLACE --' };
    let m = modes[E.mode] || '';
    if (E.mode === 'visual') m = { v:'-- VISUAL --', V:'-- VISUAL LINE --', '<C-v>':'-- VISUAL BLOCK --' }[E.vmode];
    if (E.mode === 'normal' && E.oneShot) m = '-- (insert) --';
    left = `<span class="grow"><span class="mode">${m}</span>${E.recording ? `<span class="rec">${m ? ' ' : ''}recording @${E.recording}</span>` : ''}</span>`;
  }
  $('#vimCmd').innerHTML = left + `<span>${escHtml(E.showcmd || '')}</span>`;
  // ページャ
  const more = $('#vimMore');
  if (E.more){ more.hidden = false; more.innerHTML = escHtml(E.more.join('\n')) + '\n<span class="prompt">Press ENTER or type command to continue</span>'; }
  else more.hidden = true;
  // IME 候補位置のため入力欄をカーソル位置へ
  const anchor = E.mode === 'cmdline' ? $('#vimCmd .cc') : curEl;
  if (anchor){
    const r = anchor.getBoundingClientRect(), base = vimEl.getBoundingClientRect();
    vimInput.style.left = Math.round(r.left - base.left) + 'px';
    vimInput.style.top = Math.round(r.top - base.top) + 'px';
  }
}
function vimPosFromPoint(x, y){
  const E = vim.E;
  let node = null, off = 0;
  if (document.caretPositionFromPoint){ const p = document.caretPositionFromPoint(x, y); if (p){ node = p.offsetNode; off = p.offset; } }
  else if (document.caretRangeFromPoint){ const r = document.caretRangeFromPoint(x, y); if (r){ node = r.startContainer; off = r.startOffset; } }
  let lineEl = null, col = null;
  if (node && vimScreen.contains(node)){
    const span = node.nodeType === 3 ? node.parentElement : node;
    lineEl = span.closest('.vl');
    if (span.dataset && span.dataset.c != null && span.closest('.lt')){
      col = +span.dataset.c + off;
      if (node.nodeType === 3 && off > 0){
        const rg = document.createRange(); rg.setStart(node, off - 1); rg.setEnd(node, off);
        const rc = rg.getBoundingClientRect();
        if (x < rc.right && x >= rc.left - 0.5) col -= 1;
      }
    }
  }
  if (!lineEl){
    for (const el of vimScreen.children){ if (y < el.getBoundingClientRect().bottom){ lineEl = el; break; } }
    lineEl = lineEl || vimScreen.lastElementChild;
  }
  if (!lineEl || lineEl.dataset.l == null) return { line: E.lines.length - 1, col: Infinity };
  const line = +lineEl.dataset.l;
  return { line, col: Math.min(col ?? Infinity, E.lines[line].length) };
}
function vimFeed(k){
  if (!vim.E) return;
  if (vim.ctrl && typeof k === 'string' && k.length === 1){
    if (k === '[') k = '<Esc>';
    else if (/^[a-z]$/i.test(k)) k = '<C-' + k.toLowerCase() + '>';
    vimSetCtrl(false);
  }
  vim.E.feed(k);
}
function vimSetCtrl(on){ vim.ctrl = on; $('#vimCtrl').classList.toggle('on', on); }
const VIM_SPECIAL = { Escape:'Esc', Enter:'CR', Backspace:'BS', Delete:'Del', Tab:'Tab', ArrowLeft:'Left', ArrowRight:'Right', ArrowUp:'Up', ArrowDown:'Down', Home:'Home', End:'End', PageUp:'PageUp', PageDown:'PageDown', Insert:'Insert' };
function vimKeyToken(e){
  const k = e.key;
  if (!k || k === 'Unidentified' || k === 'Process' || e.isComposing || e.keyCode === 229) return null;
  if (VIM_SPECIAL[k]){
    let n = VIM_SPECIAL[k];
    if (e.ctrlKey && n !== 'Esc' && n !== 'CR' && n !== 'BS') n = 'C-' + n;
    else if (e.shiftKey && /^(Left|Right|Up|Down|Tab)$/.test(n)) n = 'S-' + n;
    return '<' + n + '>';
  }
  if (e.metaKey) return null;
  if (e.ctrlKey && !e.altKey){
    const c = k.length === 1 ? k.toLowerCase() : '';
    if (c === '[') return '<Esc>';
    if (/^[a-z]$/.test(c)) return '<C-' + c + '>';
    if (c === ']' || c === '^' || c === '6') return c === '6' ? '<C-^>' : '<C-' + c + '>';
    return null;
  }
  if ([...k].length !== 1) return null;
  return k === ' ' ? ' ' : k;
}
// IME で確定した文字を受け取るか（挿入・コマンドラインと、r・f・t などが次の1文字を待っているとき）
const vimTakesIme = () => ['insert', 'replace', 'cmdline'].includes(vim.E.mode) || vim.E.wantsChar();
vimInput.addEventListener('keydown', (e) => {
  if (!vim.E) return;
  if (e.isComposing || e.keyCode === 229){
    if (e.key === 'Process' && !vimTakesIme()){ vim.E.msg = T('IME がオンになっています（ノーマルモードではオフにしてください）'); vim.E.msgErr = true; vimScheduleRender(); }
    return;
  }
  let tok = vimKeyToken(e);
  if (!tok) return;
  if (tok === '<C-s>') return;
  e.stopPropagation();
  // ふつうの文字は入力（beforeinput）で受け取る。iPhone のキーボードは文字も keydown で知らせるが、
  // ここで止めると変換が始まらず、12 キーの「a/A」で g を G にするといった置き換えができなくなるため
  if ([...tok].length === 1 && !e.ctrlKey) return;
  e.preventDefault();
  vimFeed(tok);
});
function vimFlush(){
  const v = vimInput.value;
  vimInput.value = '';
  if (!v || !vim.E) return;
  const text = v.slice(vim.comp);
  vim.comp = 0;
  if (!text) return;
  if (['insert', 'replace', 'cmdline'].includes(vim.E.mode)) vimFeed({ text });
  else for (const ch of text){ const c = ch.charCodeAt(0); vimFeed(c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch); }
}
vimInput.addEventListener('beforeinput', (e) => {
  if (!vim.E || e.isComposing || e.inputType === 'insertCompositionText') return;
  const map = { insertLineBreak:'<CR>', insertParagraph:'<CR>', deleteContentBackward:'<BS>', deleteContentForward:'<Del>', deleteWordBackward:'<C-w>' };
  if (map[e.inputType]){ e.preventDefault(); vimFeed(map[e.inputType]); return; }
  if ((e.inputType === 'insertText' || e.inputType === 'insertReplacementText') && e.data){
    e.preventDefault();
    if (['insert', 'replace', 'cmdline'].includes(vim.E.mode)) vimFeed({ text: e.data });
    else for (const ch of e.data){ const c = ch.charCodeAt(0); vimFeed(c >= 0xff01 && c <= 0xff5e ? String.fromCharCode(c - 0xfee0) : ch); }
  }
});
vimInput.addEventListener('compositionstart', () => { vim.composing = true; vim.comp = 0; vim.compFed = []; vim.skipComp = false; });
// 変換中の文字をノーマルモードのキーとして渡す（確定を待たない。Android のキーボード対策）。
// 渡した文字があとで置き換わったり消えたりしたら（Gboard の 12 キーで g を打ってから「大⇔小」で G にするなど）、
// 打つ前に戻してから新しい文字を渡す。r・f・t の後はローマ字の途中（「か」の k など）を渡さないよう、確定を待つ
function vimComposeInput(){
  const fed = vim.compFed, chars = [...vimInput.value];
  let same = 0;
  while (same < fed.length && same < chars.length && fed[same].ch === chars[same]) same++;
  if (same < fed.length){
    const first = fed.slice(same).find((f) => f.cp);
    if (first){ vim.E.rewind(first.cp); vimSetCtrl(first.ctrl); }
    fed.length = same;
  }
  for (const ch of chars.slice(same)){
    if (vimTakesIme()) break;
    const key = /^[\x21-\x7e]$/.test(ch);
    fed.push({ ch, cp: key ? vim.E.checkpoint() : null, ctrl: vim.ctrl });
    if (key) vimFeed(ch);
  }
  vim.comp = fed.map((f) => f.ch).join('').length;
}
vimInput.addEventListener('input', (e) => {
  if (!vim.E) return;
  if (vim.skipComp) return;
  if (vim.composing){ vimComposeInput(); return; }
  vimFlush();
});
vimInput.addEventListener('compositionend', () => {
  vim.composing = false;
  if (vim.skipComp){ vim.skipComp = false; vim.comp = 0; vimInput.value = ''; return; }
  if (vim.E && !vimTakesIme()){ vim.comp = vimInput.value.length; }
  setTimeout(vimFlush, 0);
});
vimInput.addEventListener('paste', (e) => {
  const t = e.clipboardData?.getData('text');
  e.preventDefault();
  if (t && vim.E) vim.E.pasteText(t);
});
vimInput.addEventListener('focus', () => { vimEl.classList.add('focus'); vimScheduleRender(); });
vimInput.addEventListener('blur', () => { vimEl.classList.remove('focus'); vimScheduleRender(); });
vimScreen.addEventListener('pointerdown', (e) => {
  if (!vim.E || e.button > 0) return;
  e.preventDefault();
  vimInput.focus({ preventScroll:true });
  try { vimScreen.setPointerCapture(e.pointerId); } catch {}
  if (e.pointerType !== 'mouse'){ vim.touch = { id: e.pointerId, x: e.clientX, y: e.clientY, top: vim.E.top, moved: false }; return; }
  if (vim.E.more){ vim.E.feed('<CR>'); return; }
  const pos = vimPosFromPoint(e.clientX, e.clientY);
  if (vim.E.mode === 'visual' && !e.shiftKey) vim.E.feed('<Esc>');
  vim.E.setCursor(pos.line, pos.col);
  vim.mouse = { id: e.pointerId, start: pos, active: false };
  vimScheduleRender();
});
// iPhone では、タップのあとに来る mousedown で入力欄からフォーカスが外れ、キーボードが出てすぐ閉じてしまう
// （長押しだと mousedown が来ないので開いたままになる）。フォーカスを動かさず、click でも入力欄に戻す
vimEl.addEventListener('mousedown', (e) => { if (e.target !== vimInput) e.preventDefault(); });
vimScreen.addEventListener('click', () => { if (vim.E && document.activeElement !== vimInput) vimInput.focus({ preventScroll:true }); });
vimScreen.addEventListener('pointermove', (e) => {
  const E = vim.E;
  if (!E) return;
  if (vim.touch && vim.touch.id === e.pointerId){
    const dy = e.clientY - vim.touch.y;
    if (Math.abs(dy) > 6 || Math.abs(e.clientX - vim.touch.x) > 6) vim.touch.moved = true;
    const target = clamp(vim.touch.top - Math.round(dy / (vim.lineH || 19)), 0, Math.max(0, E.lines.length - 1));
    if (target !== E.top) E.scrollBy(target - E.top);
    return;
  }
  if (vim.mouse && vim.mouse.id === e.pointerId && E.mode !== 'cmdline'){
    const pos = vimPosFromPoint(e.clientX, e.clientY);
    if (!vim.mouse.active && (pos.line !== vim.mouse.start.line || Math.min(pos.col, 1e9) !== Math.min(vim.mouse.start.col, 1e9))){
      vim.mouse.active = true;
      if (E.mode === 'normal') E.startVisualAt(vim.mouse.start.line, Math.min(vim.mouse.start.col, Math.max(0, E.lines[vim.mouse.start.line].length - 1)));
    }
    if (vim.mouse.active){ E.setCursor(pos.line, pos.col); vimScheduleRender(); }
  }
});
for (const ev of ['pointerup', 'pointercancel']){
  vimScreen.addEventListener(ev, (e) => {
    if (vim.touch && vim.touch.id === e.pointerId){
      const t = vim.touch; vim.touch = null;
      if (!t.moved && ev === 'pointerup' && vim.E){
        if (vim.E.more){ vim.E.feed('<CR>'); return; }
        const pos = vimPosFromPoint(e.clientX, e.clientY);
        vim.E.setCursor(pos.line, pos.col); vimScheduleRender();
      }
    }
    if (vim.mouse && vim.mouse.id === e.pointerId) vim.mouse = null;
  });
}
vimScreen.addEventListener('wheel', (e) => {
  if (!vim.E) return;
  e.preventDefault();
  const n = Math.sign(e.deltaY) * (Math.abs(e.deltaY) > 40 || e.deltaMode ? 3 : 1);
  if (n) vim.E.scrollBy(n);
}, { passive:false });
$('#vimMore').addEventListener('pointerdown', (e) => { e.preventDefault(); vimInput.focus({ preventScroll:true }); vim.E?.feed('<CR>'); });
// キーのボタン（スマホのキーバーと上の Esc）。押してもフォーカスを奪わず、キーボードを閉じない
function vimKeyButton(b) {
  vimInput.focus({ preventScroll:true });
  const k = b.dataset.k;
  // IME の変換中なら、そこまでの文字を確定してから押す（変換が終わったときにもう一度渡さない）
  if (vim.composing && vim.E){
    const text = vimInput.value.slice(vim.comp);
    if (text && ['insert', 'replace', 'cmdline'].includes(vim.E.mode)) vimFeed({ text });
    vimInput.value = '';
    vim.comp = 0;
    vim.skipComp = true;
  }
  if (k === 'ctrl') vimSetCtrl(!vim.ctrl);
  else { vimSetCtrl(false); vimEnsure().feed(k); }
}
for (const bar of [$('#vimKeys'), $('.vim-head')]) {
  bar.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    e.preventDefault();
    vimKeyButton(b);
  });
  // キーボードで押したとき（pointerdown が来ない）
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (b && e.detail === 0) vimKeyButton(b);
  });
}
for (const b of document.querySelectorAll('[data-ex]')) b.onclick = () => { vimEnsure().ex(b.dataset.ex); vimInput.focus({ preventScroll:true }); };
$('#vim').addEventListener('pointerdown', (e) => { if (e.target === vimEl) vimInput.focus({ preventScroll:true }); });

/* =====================================================================
   パネル切り替え（PC: サイドのタブ / スマホ: 下部のタブ）
   ===================================================================== */
const mq = matchMedia('(max-width: 980px)');
// 横向きのスマホか。縦持ちでもキーボードが出ると表示領域が横長になるので、表示領域ではなく端末の向きと画面の大きさで決める
function applyPhoneLandscape(){
  const o = screen.orientation?.type;
  const land = o ? o.startsWith('landscape')
    : typeof window.orientation === 'number' ? Math.abs(window.orientation) === 90
    : innerWidth > innerHeight;
  document.documentElement.classList.toggle('phone-landscape', land && Math.min(screen.width, screen.height) <= 540);
}
// 表示領域の高さ（スマホの縦持ちで動画の大きさを決める）。
// キーボードの開け閉めでは測り直さない（縮んだ高さを使うと動画が細くなり、開く途中で配置が動くとキーボードが閉じてしまう）。
// 測り直すのは、最初・向きが変わったとき・幅が変わったときと、入力中でないときに広がったとき（ツールバーが隠れたときなど）だけ
let stableH = 0, stableW = 0;
const isTyping = () => { const el = document.activeElement; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
// 測るのはページの表示枠（documentElement.clientWidth/Height）。window.innerWidth/Height は iPhone では拡大
// （入力欄に触れたときの自動の拡大を含む）で変わり、コメントの編集画面を開け閉めしたあとに動画が細くなっていた
function applyStableHeight(reset){
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  if (!(reset || !stableH || w !== stableW || (h > stableH && !isTyping()))) return;
  stableH = h; stableW = w;
  document.documentElement.style.setProperty('--stable-h', stableH + 'px');
}
function onViewportChange(e){
  applyPhoneLandscape();
  // 向きが変わったら測り直す
  applyStableHeight(e && e.type !== 'resize');
}
onViewportChange();
screen.orientation?.addEventListener('change', onViewportChange);
window.addEventListener('orientationchange', onViewportChange);
window.addEventListener('resize', onViewportChange);
// iOS などでは、キーボードが閉じたあともページが上にずれたまま（画面の下が空白）になることがある。
// ページがスクロールしない配置（PC・横向きのスマホ）なら元に戻す
function resetStrayScroll(){
  if (isTyping()) return;
  const se = document.scrollingElement;
  if (se && se.scrollTop > 0 && se.scrollHeight <= innerHeight + 1) window.scrollTo(0, 0);
}
document.addEventListener('focusout', () => setTimeout(resetStrayScroll, 300));
window.visualViewport?.addEventListener('resize', () => setTimeout(resetStrayScroll, 300));
/* ---------- 画面の配置（PC） ---------- */
const layoutCur = () => LAYOUTS[settings.layout] || LAYOUTS.std;
// 出すパネル（どれも隠したらプレビューを出す）
function layoutVis(){
  const v = { player: settings.preview !== false, side: !!settings.side, tl: !!settings.timeline };
  if (!v.player && !v.side && !v.tl) v.player = true;
  return v;
}
// 右の列の幅・下の行の高さ（パネルが潰れないよう、今の画面に収める）
const LAY_MIN = { player: 320, side: 280, tl: 360 }, LAY_MIN_H = { player: 220, side: 160, tl: 150 };
function layoutSize(){
  const L = layoutCur(), box = $('#layout'), cs = getComputedStyle(box);
  const W = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const Hh = box.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const G = 8;
  // 右の列: 標準なら右のパネル（左はプレビュー）、ほかは right（左は left の2つ）
  const rightKey = L.right || 'side', leftKey = L.left ? L.left[0] : 'player';
  const wMin = LAY_MIN[rightKey], wMax = Math.max(wMin, W - G - LAY_MIN[leftKey]);
  // 下の行: 標準ならタイムライン（上はプレビューと右のパネル）、ほかは left の下（上は left の上）
  const botKey = L.bottom || L.left[1], topKey = L.bottom ? 'player' : L.left[0];
  const hMin = LAY_MIN_H[botKey], hMax = Math.max(hMin, Hh - G - LAY_MIN_H[topKey]);
  return { w: Math.round(clamp(+settings[L.w] || L.dw, wMin, wMax)), h: Math.round(clamp(+settings[L.h] || L.dh, hMin, hMax)) };
}
// 格子の列・行と、各パネル・つまみの置き場所を決める
function layoutApply(){
  const els = { player: $('.player-col'), side: $('#side'), tl: $('#timeline') };
  const guts = { v: $('#gutV'), h: $('#gutH'), c: $('#gutC') };
  const box = $('#layout');
  const all = [...Object.values(els), ...Object.values(guts)];
  if (mq.matches){
    // スマホはタブで切り替える（格子は使わない）
    box.style.gridTemplateColumns = box.style.gridTemplateRows = '';
    for (const el of all){ el.style.gridArea = ''; el.classList.remove('lay-off'); }
    return;
  }
  const L = layoutCur(), vis = layoutVis(), sz = layoutSize(), G = '8px';
  const area = {}; // key → [行の始まり, 列の始まり, 行の終わり, 列の終わり]
  let cols = ['minmax(0,1fr)'], rows = ['minmax(0,1fr)'];
  let gv = null, gh = null;
  if (L.top){
    const top = L.top.filter(k => vis[k]), bot = vis[L.bottom];
    if (top.length === 2){ cols = ['minmax(0,1fr)', G, sz.w + 'px']; area[top[0]] = [1, 1, 2, 2]; area[top[1]] = [1, 3, 2, 4]; gv = [1, 2, 2, 3]; }
    else if (top.length === 1) area[top[0]] = [1, 1, 2, -1];
    if (bot){
      if (top.length){ rows = ['minmax(0,1fr)', G, sz.h + 'px']; area[L.bottom] = [3, 1, 4, -1]; gh = [2, 1, 3, -1]; }
      else area[L.bottom] = [1, 1, 2, -1];
    }
  } else {
    const left = L.left.filter(k => vis[k]), right = vis[L.right];
    const lc = right && left.length ? [1, 2] : [1, -1];
    if (right && left.length){ cols = ['minmax(0,1fr)', G, sz.w + 'px']; area[L.right] = [1, 3, -1, 4]; gv = [1, 2, -1, 3]; }
    else if (right) area[L.right] = [1, 1, -1, -1];
    if (left.length === 2){ rows = ['minmax(0,1fr)', G, sz.h + 'px']; area[left[0]] = [1, lc[0], 2, lc[1]]; area[left[1]] = [3, lc[0], 4, lc[1]]; gh = [2, lc[0], 3, lc[1]]; }
    else if (left.length === 1) area[left[0]] = [1, lc[0], -1, lc[1]];
  }
  box.style.gridTemplateColumns = cols.join(' ');
  box.style.gridTemplateRows = rows.join(' ');
  const put = (el, a) => { el.classList.toggle('lay-off', !a); el.style.gridArea = a ? a.join(' / ') : ''; };
  for (const k in els) put(els[k], area[k]);
  put(guts.v, gv); put(guts.h, gh);
  put(guts.c, gv && gh ? [gh[0], gv[1], gh[2], gv[3]] : null);
}
// 配置の小さな図（メニューのカードとボタンで使う）
function layoutGlyph(key){
  const L = LAYOUTS[key], NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 44 32');
  const r = (x, y, w, h, cls, rx = 1.5) => { const e = document.createElementNS(NS, 'rect'); Object.entries({ x, y, width: w, height: h, rx, class: cls }).forEach(([k, v]) => e.setAttribute(k, v)); svg.append(e); };
  const part = (k, x, y, w, h) => {
    if (k === 'player') r(x, y, w, h, 'lg-p');
    else if (k === 'side'){ r(x, y, w, h, 'lg-s'); for (let yy = y + 3; yy + 1.2 <= y + h - 2; yy += 3.4) r(x + 2, yy, Math.max(2, w - 4), 1.2, 'lg-row', .6); }
    else { r(x, y, w, h, 'lg-t'); r(x + 2, y + h * .3, w * .35, 2.2, 'lg-clip', .8); r(x + w * .45, y + h * .62, w * .4, 2.2, 'lg-clip', .8); }
  };
  r(.75, .75, 42.5, 30.5, 'lg-frame', 3);
  if (L.top){ part('player', 3, 3, 25, 15); part('side', 30, 3, 11, 15); part('tl', 3, 20, 38, 9); }
  else { part(L.left[0], 3, 3, 25, 15); part(L.left[1], 3, 20, 25, 9); part(L.right, 30, 3, 11, 26); }
  return svg;
}
function layoutMenuRender(){
  const box = $('#layCards');
  box.replaceChildren();
  for (const key of Object.keys(LAYOUTS)){
    const b = mkEl('button', 'lay-card');
    b.type = 'button'; b.setAttribute('role', 'menuitemradio');
    b.setAttribute('aria-checked', String(settings.layout === key || (!LAYOUTS[settings.layout] && key === 'std')));
    b.append(layoutGlyph(key), mkEl('span', null, LAYOUTS[key].name));
    b.onclick = () => { settings.layout = key; saveSettings(); applyPanes(); layoutMenu(false); };
    box.append(b);
  }
  const vis = layoutVis();
  for (const cb of $('#layoutMenu').querySelectorAll('[data-panel]')){
    cb.checked = { preview: vis.player, side: vis.side, timeline: vis.tl }[cb.dataset.panel];
  }
  $('#layGlyph').replaceChildren(layoutGlyph(LAYOUTS[settings.layout] ? settings.layout : 'std'));
}
function layoutMenu(open){
  const m = $('#layoutMenu'), b = $('#btnLayout');
  if (open == null) open = m.hidden;
  m.hidden = !open;
  b.setAttribute('aria-expanded', String(open));
  if (!open) return;
  layoutMenuRender();
  const r = b.getBoundingClientRect();
  m.style.top = (r.bottom + 6) + 'px';
  m.style.left = Math.max(8, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 8)) + 'px';
  m.querySelector('[aria-checked="true"]')?.focus();
}
$('#btnLayout').onclick = (e) => { e.stopPropagation(); layoutMenu(); };
document.addEventListener('pointerdown', (e) => { if (!$('#layoutMenu').hidden && !e.target.closest('#layoutMenu,#btnLayout')) layoutMenu(false); });
$('#layoutMenu').addEventListener('keydown', (e) => { if (e.key === 'Escape'){ layoutMenu(false); $('#btnLayout').focus(); } });
window.addEventListener('resize', () => { if (!$('#layoutMenu').hidden) layoutMenu(false); });
// パネルを出す・隠す（最後の1つは隠せない）
function panelToggle(key, on){
  const name = { preview: 'preview', side: 'side', timeline: 'timeline' }[key];
  const next = { preview: settings.preview !== false, side: !!settings.side, timeline: !!settings.timeline, [name]: on ?? !(name === 'preview' ? settings.preview !== false : settings[name]) };
  if (!next.preview && !next.side && !next.timeline){ toast(T('どれか1つは出しておく必要があります'), { timeout:1800 }); layoutMenuRender(); return; }
  settings.preview = next.preview; settings.side = next.side; settings.timeline = next.timeline;
  saveSettings(); applyPanes(); layoutMenuRender();
}
for (const cb of $('#layoutMenu').querySelectorAll('[data-panel]')) cb.onchange = () => panelToggle(cb.dataset.panel, cb.checked);
function applyLayoutVars(){
  const root = document.documentElement.style;
  root.setProperty('--m-video', settings.mVideo);
  layoutApply();
}
window.addEventListener('resize', applyLayoutVars);
function applyPanes(){
  const mobile = mq.matches;
  const pane = mobile ? (settings.mobilePane === 'timeline' ? 'list' : settings.mobilePane) : settings.sidePane;
  $('#paneList').hidden = pane !== 'list';
  $('#paneVim').hidden = pane !== 'vim';
  $('#paneHistory').hidden = pane !== 'history';
  document.body.dataset.mpane = settings.mobilePane;
  const vis = layoutVis();
  $('#btnPreview').classList.toggle('on', vis.player);
  $('#btnTimeline').classList.toggle('on', vis.tl);
  $('#btnSide').classList.toggle('on', vis.side);
  for (const [b, on] of [[$('#btnPreview'), vis.player], [$('#btnTimeline'), vis.tl], [$('#btnSide'), vis.side]]) b.setAttribute('aria-pressed', String(on));
  if (!mobile && !vis.side && $('#side').contains(document.activeElement)) document.activeElement.blur();
  for (const b of document.querySelectorAll('.stab')) b.classList.toggle('on', b.dataset.pane === settings.sidePane);
  for (const b of document.querySelectorAll('.mtab')) b.classList.toggle('on', b.dataset.mpane === settings.mobilePane);
  $('#layGlyph').replaceChildren(layoutGlyph(LAYOUTS[settings.layout] ? settings.layout : 'std'));
  applyLayoutVars();
  const vimShown = pane === 'vim' && (mobile ? settings.mobilePane === 'vim' : vis.side);
  if (vimShown){ vimEnsure(); if (!vim.E.modified && vim.synced !== state.version) vimReload(false); }
  if (pane === 'history') histRefresh();
  requestAnimationFrame(() => {
    resizeCanvas(); tlResize();
    if (vimShown){ vim.lineH = 0; vimRender(); }
  });
}
for (const b of document.querySelectorAll('.stab')) b.onclick = () => {
  settings.sidePane = b.dataset.pane; saveSettings(); applyPanes();
  if (b.dataset.pane === 'vim') setTimeout(() => vimInput.focus({ preventScroll:true }), 0);
};
for (const b of document.querySelectorAll('.mtab')) b.onclick = () => {
  settings.mobilePane = b.dataset.mpane; saveSettings(); applyPanes();
};
$('#btnPreview').onclick = () => panelToggle('preview');
$('#btnTimeline').onclick = () => panelToggle('timeline');
$('#btnSide').onclick = () => panelToggle('side');
mq.addEventListener('change', applyPanes);
// ウィンドウや右のパネルの幅が変わったら描き直す
new ResizeObserver(() => { if (vim.E && !$('#paneVim').hidden) vimScheduleRender(); }).observe($('#vimScreen'));

/* =====================================================================
   共同編集（komenagare CLI から配信されているとき）
   - 変更は送る前にこのブラウザの IndexedDB に控え（送信待ち）、ホストの受け取り確認で消す
   - 接続が切れても編集を続けられ、つながり直したら送信待ちを送り直す
     （同じ変更を二度送ってもホストは1回だけ適用する）
   - ホスト側で他の人の変更と重なった分は反映されないので、ホストの内容に合わせて知らせる
   ===================================================================== */
// ホストとのやりとりの取り決めの版数（変えたら web.json と cli/src/server.rs の PROTOCOL も合わせる）
const COLLAB_PROTOCOL = 10;
const collab = {
  ws: null, connected: false, retry: 0, timer: 0, peers: [], outbox: [], db: null, saveTimer: 0, failed: 0,
  // ホストから最後に受け取った変更の通し番号と、ホストの起動ごとの id（つなぎ直したとき、それ以降の変更だけを受け取るため）
  rev: 0, epoch: null,
  conflicts: [], // ほかの人の変更と重なって反映されなかった自分の変更（衝突の解決画面で選ぶ）
  shared: [], // 「あとで」にされてホストに預けられた衝突（全員のもの。author・client 付き）
  me: null, peerList: [], // 自分の接続 id と、参加者（{ id, name, client }）
  presence: new Map(), // 接続 id → { state, at }（ほかの人の再生位置・選択・カーソル）
  follow: null, // 追いかけている人の接続 id
  // 追いかけている人のブラウザの id と名前（どちらかがつなぎ直して接続 id が変わっても、同じ人を追いかけ続ける）
  followClient: null, followName: '', followWait: 0,
  synced: false, // このプロジェクトでホストから全体（snapshot）を受け取ったか
  pingAt: 0, pongTimer: 0, // 返事を待っている ping を送った時刻と、待つのをやめる timer
  // 入退室のお知らせ（つないで最初の peers では入った人を知らせない）・抜けたお知らせの保留・切れる前にいた人
  peersReady: false, leaving: new Map(), lastPeers: [],
  // 入り方（token: URL の k= / otp: 参加者ごとのワンタイムパスワード / none）
  auth: document.querySelector('meta[name="komenagare-host"]')?.dataset.auth || 'token',
  // 外から入るときの URL（ホストの --tunnel / --public-url。招待のリンクに使う。localhost で開いていても外の人に渡せるように）
  publicUrl: document.querySelector('meta[name="komenagare-host"]')?.dataset.publicUrl || '',
  // 公開 URL の手前でメールの確認（ホストの --allowed-mail。Cloudflare Access の PIN）をしているか
  emailGate: document.querySelector('meta[name="komenagare-host"]')?.dataset.emailGate === '1',
  session: null, // --otp のときのログイン（{ token, name, admin }。localStorage に控える）
  project: null, projects: [], projectsLoaded: false, projectsManage: false, projectsHidden: [], // 開いているプロジェクト（{ id, name }）と、ホストにあるプロジェクトの一覧
  workspace: 'default', // 控え（IndexedDB）の名前に使う。プロジェクトの id
  owner: null, // このタブがこのプロジェクトを開いている間の id（衝突の控えをタブごとに分ける）
  serverName: null, // ホストが使っている自分の名前
  remote: null, // ホストでコマンドを打てるときの種類（'git' / 'shell'。ホストの --remote で、許された人だけ）
  key: (() => {
    const k = new URLSearchParams(location.search).get('k');
    try { if (k) sessionStorage.setItem('komenagare.key', k); return k || sessionStorage.getItem('komenagare.key'); } catch { return k; }
  })(),
};
const collabLS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
function collabName(){ return collab.session?.name || collabLS('komenagare.name') || ''; }
// ブラウザごとの秘密（16進 64 文字）。ホストはこれのハッシュをブラウザの id にしてほかの人に配る。
// 秘密そのものはホストにしか送らないので、ほかの人はこのブラウザの id を名乗れない
function collabClientKey(){
  let k = collabLS('komenagare.clientKey');
  if (!/^[0-9a-f]{64}$/.test(k || '')){
    k = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    collabLS('komenagare.clientKey', k);
  }
  return k;
}

// IndexedDB（送信待ちと、最後に見たコメント一覧の控え）
function collabIdb(){
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('komenagare-collab-' + collab.workspace, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('outbox', { keyPath: 'id' }); r.result.createObjectStore('meta'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function collabTx(name, mode, fn){
  if (!collab.db) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const tx = collab.db.transaction(name, mode), req = fn(tx.objectStore(name));
    tx.oncomplete = () => resolve(req ? req.result : null);
    tx.onerror = () => reject(tx.error);
  });
}
function collabSaveSoon(){
  clearTimeout(collab.saveTimer);
  collab.saveTimer = setTimeout(() => {
    const comments = store.comments.map(c => ({ id: c.id, t: c.t, cmd: c.cmd, text: c.text, mine: c.mine }));
    collabTx('meta', 'readwrite', s => s.put({ comments, savedAt: Date.now() }, 'snapshot')).catch(e => console.warn(e));
  }, 400);
}

// 自分の変更をホストへ送る（送信待ちに控えてから）
// ホストに送る1つの変更セットの大きさ。大きな読み込みなどは分けて送る
// （ホストは 1 万 op・1 通 16MB まで。超えると受け付けないか切られて、送信待ちから出られなくなる）
const COLLAB_CHUNK_OPS = 2000, COLLAB_CHUNK_BYTES = 2 << 20;
function collabSplitOps(ops){
  const parts = []; let cur = [], size = 0;
  for (const op of ops){
    const n = JSON.stringify(op).length;
    if (cur.length && (cur.length >= COLLAB_CHUNK_OPS || size + n > COLLAB_CHUNK_BYTES)){ parts.push(cur); cur = []; size = 0; }
    cur.push(op); size += n;
  }
  if (cur.length) parts.push(cur);
  return parts;
}
// 変更セットを送信待ちに入れて送る（大きければ分ける。最初の分は元の id のまま）
function collabQueue(id, ops, seq){
  collabSplitOps(ops).forEach((part, i) => {
    const cid = i ? uuidv7() : id;
    const e = { id: cid, seq: seq + i / 1000, change: { id: cid, ops: part } };
    collab.outbox.push(e);
    collabTx('outbox', 'readwrite', s => s.put(e)).catch(err => console.warn(err));
    if (collab.connected) collab.ws.send(JSON.stringify({ type: 'change', change: e.change }));
  });
}
function collabSend(change){
  if (!state.collab || !change) return;
  collabQueue(change.id, change.ops.map(({ mine, ...op }) => op), Date.now());
  collabSaveSoon();
  collabUI();
}
// 前の版で送信待ちに入った大きな変更セットを分け直す（そのまま送るとホストに受け付けられない）
async function collabResplitOutbox(){
  const big = collab.outbox.filter(e => collabSplitOps(e.change.ops).length > 1);
  if (!big.length) return;
  collab.outbox = collab.outbox.filter(e => !big.includes(e));
  for (const e of big){
    await collabTx('outbox', 'readwrite', s => s.delete(e.id)).catch(err => console.warn(err));
    collabQueue(e.id, e.change.ops, e.seq);
  }
  collab.outbox.sort((a, b) => a.seq - b.seq);
}

function collabHello(){
  const h = { type: 'hello', protocol: COLLAB_PROTOCOL, name: collabName() || T('ゲスト'), client_key: collabClientKey(), session: collab.session?.token };
  // このタブでつながっていたなら、前に受け取ったところからの変更だけを求める（ホストが覚えていなければ全体が来る）
  if (collab.epoch){ h.since = collab.rev; h.epoch = collab.epoch; }
  return h;
}
function collabConnect(){
  clearTimeout(collab.timer);
  const q = new URLSearchParams();
  if (collab.project) q.set('p', collab.project.id);
  if (collab.key) q.set('k', collab.key);
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?' + q;
  const ws = new WebSocket(url);
  collab.ws = ws;
  ws.onopen = () => { ws.send(JSON.stringify(collabHello())); };
  ws.onmessage = (ev) => {
    // 何か届けば生きている
    collab.pingAt = 0; clearTimeout(collab.pongTimer);
    let m; try { m = JSON.parse(ev.data); } catch { return; } collabHandle(m);
  };
  ws.onclose = () => collabClosed(ws);
}
function collabClosed(ws){
  if (collab.ws !== ws) return;
  collab.pingAt = 0; clearTimeout(collab.pongTimer);
  if (collab.blocked){ collab.connected = false; collabUI(); return; }
  const was = collab.connected;
  if (collab.peersReady) collab.lastPeers = collab.peerList;
  collab.connected = false; collab.peers = []; collab.peerList = []; collab.presence.clear(); collab.peersReady = false;
  termDropped(T('接続が切れたため'));
  followLost();
  presenceChanged();
  if (!was) collab.failed++;
  collabUI();
  collab.timer = setTimeout(collabConnect, Math.min(10000, 1000 * 2 ** Math.min(collab.retry++, 4)));
  if (collab.emailGate && collab.failed === 2) collabCheckEmailGate();
}
// 返事の無い接続を見切ってつなぎ直す（回線が黙って切れると、ブラウザが気づくまで何分もかかる）
function collabLost(ws){
  if (collab.ws !== ws) return;
  ws.onclose = ws.onmessage = null;
  try { ws.close(); } catch {}
  collabClosed(ws);
}
// 生きているかを確かめる（返事が timeout ミリ秒のうちに無ければ、つなぎ直す）。
// 定期的に送るのは、何も流れない接続をトンネルなどの途中で切られないようにするためでもある
const COLLAB_PING_MS = 20000, COLLAB_PONG_MS = 10000;
function collabPing(timeout = COLLAB_PONG_MS){
  if (!collab.connected || collab.pingAt) return;
  const ws = collab.ws;
  collab.pingAt = performance.now();
  try { ws.send('{"type":"ping"}'); } catch {}
  clearTimeout(collab.pongTimer);
  collab.pongTimer = setTimeout(() => { if (collab.pingAt) collabLost(ws); }, timeout);
}
setInterval(collabPing, COLLAB_PING_MS);
// ネットワークが戻ったとき・タブが前に出たときは、待たずにつなぎ直す（つながっているなら確かめる）
function collabWake(){
  if (!state.collab || !collab.project || collab.blocked) return;
  if (collab.connected){ collabPing(5000); return; }
  // つなぎかけ・ログイン待ちの接続があれば、それに任せる
  if (collab.ws && collab.ws.readyState <= WebSocket.OPEN) return;
  collab.retry = 0;
  collabConnect();
}
window.addEventListener('online', collabWake);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') collabWake(); });
// メールの確認（--allowed-mail）の期限が切れると、ページの読み込みが確認の画面へ転送され、つながらなくなる。
// そうなっていたら、つなぎ直すのをやめて再読み込み（確認のやり直し）を案内する
async function collabCheckEmailGate(){
  let r;
  try { r = await fetch(location.pathname + '?gate=' + Date.now(), { redirect: 'manual', cache: 'no-store', credentials: 'same-origin' }); }
  catch { return; } // ネットワークが切れている・ホストが止まっているなど（いつもどおりつなぎ直す）
  if (!(r.type === 'opaqueredirect' || r.status === 401 || r.status === 403) || collab.connected) return;
  clearTimeout(collab.timer);
  collab.blocked = 'email';
  if (collab.ws) collab.ws.close();
  collabUI();
  toast(T('メールでの確認の期限が切れました。ページを再読み込みして、もう一度確認してください（未送信の変更はこのブラウザに残っています）'), { type:'error', timeout:15000, action:{ label:T('再読み込み'), fn: () => location.reload() } });
}

function collabHandle(m){
  if (m.type === 'snapshot'){
    if (Array.isArray(m.changes)){
      // つなぎ直し: 切れていた間の変更だけが届く（古い順）。手元にはまだ受け取り確認のない自分の変更も入っているが、
      // 届いた変更を当てるだけでよい（自分の変更が入っていても、当て直すと衝突して何も変わらない）
      let changed = false;
      for (const e of m.changes) if (e && e.change && store.apply(e.change).applied) changed = true;
      if (changed) commentsChanged();
    } else {
      // ホストの内容に、まだ受け取り確認のない自分の変更を重ねてから送り直す
      const mine = new Set(store.comments.filter(c => c.mine).map(c => c.id));
      store.reset((m.comments || []).map(c => ({ ...c, mine: mine.has(c.id) })));
      for (const e of collab.outbox) store.apply(e.change);
      commentsChanged();
    }
    collab.rev = typeof m.rev === 'number' ? m.rev : 0;
    collab.epoch = typeof m.epoch === 'string' ? m.epoch : null;
    collab.connected = true; collab.retry = 0; collab.failed = 0; collab.me = m.you ?? null; collab.serverName = m.name ?? null; collab.myClient = typeof m.client === 'string' ? m.client : null;
    collab.remote = m.remote || null;
    collab.admin = m.admin === true;
    if (!collab.remote) tmClose();
    collab.synced = true; collab.peersReady = false;
    termDropped(T('接続し直したため'));
    for (const e of collab.outbox) collab.ws.send(JSON.stringify({ type: 'change', change: e.change }));
    collabShareConflicts();
    presence.sent = ''; presenceDirty();
    collabSaveSoon();
    collabUI();
    histChanged();
    linkTry();
  } else if (m.type === 'change'){
    if (typeof m.rev === 'number' && m.rev > collab.rev) collab.rev = m.rev;
    const r = store.apply(m.change);
    if (r.applied){ commentsChanged(); collabSaveSoon(); }
    if (hist.entries){ hist.entries.unshift({ rev: m.rev, time: m.time, author: m.author, change: m.change }); histRender(); }
    tmRefreshSoon();
  } else if (m.type === 'ack'){
    const entry = collab.outbox.find(e => e.id === m.id);
    collab.outbox = collab.outbox.filter(e => e.id !== m.id);
    collabTx('outbox', 'readwrite', s => s.delete(m.id)).catch(e => console.warn(e));
    if (m.fix && m.fix.length){
      // ホストの内容に合わせる前に、自分の側の内容を控えておく（衝突の解決画面で「あなた」として出す）
      const local = new Map(m.fix.map(f => [f.id, store.get(f.id) ? { ...store.get(f.id) } : null]));
      collabFix(m.fix);
      collabAddConflicts(entry, m.conflicts || [], m.fix, local);
    }
    collabUI();
    histChanged();
  } else if (m.type === 'tm_log' || m.type === 'tm_show' || m.type === 'tm_restore'){
    tmHandle(m);
  } else if (m.type === 'run_out'){
    if (m.id === term.running) for (const c of term.ansi[m.err ? 'err' : 'out'].push(m.data)) termAppend(c.text, m.err ? 'err' : '', c.style);
  } else if (m.type === 'run_end'){
    if (m.id === term.running) termEnd(m);
  } else if (m.type === 'history'){
    hist.entries = m.entries || [];
    histRender();
  } else if (m.type === 'peers'){
    const before = collab.peerList;
    collab.peers = m.names || [];
    collab.peerList = m.peers || [];
    const ids = new Set(collab.peerList.map(p => p.id));
    for (const id of [...collab.presence.keys()]) if (!ids.has(id)) collab.presence.delete(id);
    peersAnnounce(collab.peersReady ? before : collab.lastPeers, collab.peerList, !collab.peersReady);
    collab.peersReady = true;
    if (collab.follow != null && !ids.has(collab.follow)) followLost();
    followRebind();
    collabUI(); presenceChanged();
    // 一覧を開いていれば名前も書き換える（表示名を変えた直後など）
    if ($('#peersDlg').open) peersRender();
  } else if (m.type === 'call'){
    callReceived(m);
  } else if (m.type === 'presence'){
    if (m.id === collab.me) return;
    // sm は画面に出している位置（peerEase。届いた位置へなめらかに寄せる）。前のものを引き継ぐ
    const pr = { state: cleanPresence(m.state), at: performance.now(), sm: collab.presence.get(m.id)?.sm };
    collab.presence.set(m.id, pr);
    videoCheckPeer(m.id, pr);
    presenceChanged();
    if (m.id === collab.follow) followApply(true);
  } else if (m.type === 'conflicts'){
    collab.shared = (Array.isArray(m.list) ? m.list : []).map(cleanConflict).filter(Boolean);
    // ホストに預けられたものは手元の控えから外す
    const keys = new Set(collab.shared.map(r => r.key));
    collab.conflicts = collab.conflicts.filter(r => !keys.has(r.key));
    conflictsChanged();
  } else if (m.type === 'error'){
    if (m.code === 'auth'){ collab.ws.close(); collabRelogin(); return; }
    if (m.code === 'project'){
      collab.blocked = 'project'; collab.ws.close();
      toast(T('ホスト: ') + m.message, { type:'error', timeout:6000 });
      projectsOpen();
      return;
    }
    toast(T('ホスト: ') + m.message, { type:'error', timeout: m.code === 'protocol' ? 20000 : 3800 });
    if (m.code === 'protocol'){ collab.blocked = 'protocol'; collab.ws.close(); }
  }
}

// 他の人の変更と重なったコメントを、ホストの内容に合わせる
function collabFix(fix){
  const ops = [];
  for (const { id, comment } of fix){
    const cur = store.get(id);
    if (!comment){ if (cur) ops.push(deleteOp(cur)); }
    else if (!cur) ops.push({ type:'add', id, after: { t: comment.t, cmd: comment.cmd, text: comment.text } });
    else { const op = updateOp(cur, comment); if (op) ops.push(op); }
  }
  commitOps(ops, { undoable: false, save: false, send: false, record: false });
}
// 衝突した自分の変更を、あとで選べるように控える
function collabAddConflicts(entry, conflicts, fix, local){
  const theirsOf = new Map(fix.map(f => [f.id, f.comment ? { t: f.comment.t, cmd: f.comment.cmd, text: f.comment.text } : null]));
  let added = 0;
  for (const c of conflicts){
    const op = entry && entry.change.ops.filter(o => o.id === c.id).pop();
    if (!op) continue;
    const theirs = theirsOf.get(c.id) ?? null, mineNow = local.get(c.id);
    const mine = op.type === 'delete' ? null
      : op.type === 'add' ? { ...op.after }
      : { ...(theirs || {}), ...(mineNow ? { t: mineNow.t, cmd: mineNow.cmd, text: mineNow.text } : {}), ...op.after };
    // 元の値（3-way の共通の祖先）。update の before は変えた項目だけなので、ほかの項目は自分の側の値で補う
    const base = op.type === 'add' ? null
      : { ...(mineNow ? pickFields(mineNow) : theirs || {}), ...op.before };
    const key = entry.id + ':' + c.id;
    if (collab.conflicts.some(x => x.key === key)) continue;
    collab.conflicts.push({ key, id: c.id, reason: c.reason, opType: op.type, base, mine, theirs, at: Date.now() });
    added++;
  }
  if (!added) return;
  conflictsChanged();
  toast(T`${added} 件の変更がほかの人の変更と重なったため、まだ反映していません`, { type:'error', timeout:10000, action:{ label:T('確認する'), fn: conflictOpen } });
}

function collabUI(){
  const el = $('#collabStatus');
  if (!el) return;
  termUI();
  tmUI();
  el.hidden = !state.collab;
  $('#btnCall').hidden = !state.collab;
  $('#btnCall').disabled = !collab.connected;
  const pending = collab.outbox.length;
  if (collab.connected){
    el.className = 'collab on';
    el.textContent = T`● 共同編集 ${collab.peers.length}人` + (pending ? T`（送信中 ${pending}）` : '');
    el.title = T`参加者: ${collab.peers.join(T('、')) || '—'}\nクリックで参加者の一覧（追いかける・表示名の変更）`;
  } else {
    el.className = 'collab off';
    const blocked = { protocol: T('○ ページを再読み込みしてください'), auth: T('○ ログインしてください'), project: T('○ プロジェクトを選んでください'), email: T('○ メールでの確認の期限切れ（再読み込み）') }[collab.blocked];
    el.textContent = (blocked || (collab.failed >= 3 ? T('○ ホストに接続できません') : T('○ オフライン'))) + (pending ? T`（未送信 ${pending}）` : '');
    el.title = (collab.failed >= 3 ? T('ホストが起動しているか、URL の k= が正しいか確認してください。') : T('ホストとの接続が切れています。')) + T('\n変更はこのブラウザに保存され、つながり直したら送られます。');
  }
}

/* ---------- ターミナル（ホストの --remote。許された人だけがホストの作業フォルダでコマンドを打てる） ---------- */
const TERM_HISTORY_KEY = 'komenagare.termHistory';
// ansi: 出力と標準エラーの色の状態（コマンドごとに戻す）
const term = { running: null, seq: 0, history: [], hpos: 0, draft: '', ansi: { out: createAnsiParser(), err: createAnsiParser() } };
try { term.history = JSON.parse(localStorage.getItem(TERM_HISTORY_KEY) || '[]').filter(h => typeof h === 'string').slice(-100); } catch {}
term.hpos = term.history.length;
// style は色（ANSI のエスケープシーケンスを js/term-ansi.js で読んだもの）
function termAppend(text, cls, style){
  if (!text) return;
  const out = $('#termOut'), stick = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
  const last = out.lastChild, key = (cls || '') + '|' + (style || '');
  if (last && last.dataset.k === key && last.textContent.length < 4096) last.textContent += text;
  else {
    const sp = document.createElement('span');
    sp.dataset.k = key;
    if (cls) sp.className = cls;
    if (style) sp.style.cssText = style;
    sp.textContent = text;
    out.append(sp);
  }
  // 表示が重くならないよう、古いものから消す
  while (out.childNodes.length > 2000) out.firstChild.remove();
  if (stick) out.scrollTop = out.scrollHeight;
}
function termUI(){
  const btn = $('#termBtn');
  btn.hidden = !(state.collab && collab.remote);
  btn.classList.toggle('busy', !!term.running);
  btn.textContent = term.running ? T('実行中…') : T('ターミナル');
  const ready = collab.connected && !!collab.remote;
  $('#termRun').disabled = !ready || !!term.running;
  $('#termStop').disabled = !term.running;
  $('#termNote').textContent = !ready ? T('ホストにつながっていません。')
    : (collab.remote === 'shell'
      ? T('ホストのパソコンで、作業フォルダ（') + (collab.project?.name || T('このプロジェクト')) + T('）を今の場所としてコマンドを打てます。端末ではないので、色を付けるには ls --color=always や git -c color.ui=always のように指定してください。')
      : T('作業フォルダ（') + (collab.project?.name || T('このプロジェクト')) + T('）で git の決まったサブコマンドを打てます（status / log / diff / show / add / commit / push / pull / fetch / switch / restore / stash など）。'))
      + T(' 入力を求めるコマンド（エディタ・パスワードなど）は使えません。打ったコマンドはホストに記録されます。');
}
function termRun(line){
  line = line.trim();
  if (!line || term.running || !collab.connected || !collab.remote) return;
  const id = 'r' + Date.now().toString(36) + (term.seq++);
  term.running = id;
  term.ansi.out.reset(); term.ansi.err.reset();
  term.history = term.history.filter(h => h !== line);
  term.history.push(line);
  term.hpos = term.history.length; term.draft = '';
  try { localStorage.setItem(TERM_HISTORY_KEY, JSON.stringify(term.history.slice(-100))); } catch {}
  termAppend('$ ' + line + '\n', 'cmd');
  collab.ws.send(JSON.stringify({ type: 'run', id, line }));
  termUI();
}
function termEnd(m){
  term.running = null;
  const out = $('#termOut');
  if (out.textContent && !out.textContent.endsWith('\n')) termAppend('\n', '');
  if (m.message) termAppend(m.message + '\n', 'err');
  if (m.code != null) termAppend(T`（終了コード ${m.code}）\n`, 'info');
  termUI();
}
// 接続が切れると、ホストは動いているコマンドを止める
function termDropped(why){
  if (!term.running) return;
  termEnd({ code: null, message: why + T('、コマンドは止まりました') });
}
function termStop(){
  if (term.running && collab.connected) collab.ws.send(JSON.stringify({ type: 'run_stop', id: term.running }));
}
// 見えている範囲（スマホのキーボードを除いた部分）に合わせる
function termFit(){
  const vv = window.visualViewport, s = $('#termDlg').style;
  if (!vv) return;
  s.setProperty('--vv-h', vv.height + 'px');
  s.setProperty('--vv-top', vv.offsetTop + 'px');
}
window.visualViewport?.addEventListener('resize', () => { if ($('#termDlg').open) termFit(); });
window.visualViewport?.addEventListener('scroll', () => { if ($('#termDlg').open) termFit(); });
$('#termBtn').onclick = () => { termUI(); termFit(); if (!$('#termDlg').open) $('#termDlg').showModal(); $('#termInput').focus(); };
$('#termClose').onclick = $('#termX').onclick = () => $('#termDlg').close();
$('#termClear').onclick = () => { $('#termOut').replaceChildren(); $('#termInput').focus(); };
$('#termStop').onclick = () => { termStop(); $('#termInput').focus(); };
$('#termForm').onsubmit = (e) => {
  e.preventDefault();
  const inp = $('#termInput');
  if (term.running || !inp.value.trim()) return;
  termRun(inp.value);
  inp.value = '';
};
$('#termInput').addEventListener('keydown', (e) => {
  const inp = e.target;
  if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'c' && term.running && inp.selectionStart === inp.selectionEnd){ e.preventDefault(); termStop(); return; }
  if (e.ctrlKey && e.key.toLowerCase() === 'l'){ e.preventDefault(); $('#termOut').replaceChildren(); return; }
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown'){
    if (!term.history.length) return;
    e.preventDefault();
    if (term.hpos === term.history.length) term.draft = inp.value;
    term.hpos = Math.max(0, Math.min(term.history.length, term.hpos + (e.key === 'ArrowUp' ? -1 : 1)));
    inp.value = term.hpos === term.history.length ? term.draft : term.history[term.hpos];
    inp.setSelectionRange(inp.value.length, inp.value.length);
  }
});

/* ---------- タイムマシン（ホストの --remote で許された人が、git の履歴をさかのぼって見る・戻す） ----------
   右から目盛り（1本が1コミット。上が古く、一番下が今）を出して、画面をその分だけ押し縮める。
   目盛りを選ぶと、そのときのコメントを画面に出す（再生・タイムライン・リスト・書き出しはそのまま使える。編集はできない）。
   「復元」は git reset ではなく、今の中身からそのときの中身に戻す変更として、ホストが記録・コミットして全員に配る */
const TM_WD = '日月火水木金土';
const TM_WD_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], TM_MON_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const tmWd = (day) => I18N.lang === 'en' ? TM_WD_EN[day] : TM_WD[day];
const tmPad = (n) => String(n).padStart(2, '0');
function tmDayKey(ms){ const d = new Date(ms); return d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate(); }
function tmDate(ms){
  const d = new Date(ms);
  const hm = `${tmPad(d.getHours())}:${tmPad(d.getMinutes())}`;
  if (I18N.lang === 'en') return `${tmWd(d.getDay())}, ${TM_MON_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${TM_WD[d.getDay()]}) ${hm}`;
}
function tmDayLabel(ms){
  const d = new Date(ms), y = d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '/';
  return `${y}${d.getMonth() + 1}/${d.getDate()}`;
}
const tmIsNow = (i) => i === tm.list.length - 1;
// その位置の説明（日時と、だれのどの変更か）
function tmTitle(i){
  const p = tm.list[i];
  if (!p) return { date: '', sub: '' };
  if (tmIsNow(i)) return { date: T('今'), sub: T('今のコメント（最新）') };
  return { date: tmDate(p.time), sub: p.subject || p.author || '' };
}
function tmUI(){
  const btn = $('#tmBtn');
  btn.hidden = !(state.collab && collab.remote);
  btn.disabled = !collab.connected;
  btn.classList.toggle('on', tm.on);
  if (!tm.on) return;
  const n = tm.list.length, i = tm.idx, t = tmTitle(i);
  $('#tmUp').disabled = !n || i <= 0;
  $('#tmDown').disabled = !n || i >= n - 1;
  $('#tmWhen').textContent = n ? t.date : (tm.loading ? T('履歴を読んでいます…') : '');
  $('#tmWhat').textContent = n ? (tm.want ? T('読み込み中…') : t.sub) : '';
  $('#tmWhen').title = $('#tmWhat').title = n && !tmIsNow(i) ? T`${t.date}\n${t.sub}\nコミット ${tm.list[i].id.slice(0, 7)}（${tm.list[i].author}）` : '';
  $('#tmPos').textContent = n ? (tmIsNow(i) ? '' : T`${n - 1 - i} 個前`) : '';
  $('#tmRestore').disabled = !n || tmIsNow(i) || !!tm.want || !tm.view || tm.restoring || !collab.connected;
  const nc = tm.changedList.length;
  $('#tmChg').hidden = !n || !!tm.want || !nc;
  $('#tmChgBtn').textContent = tm.chgPos >= 0 ? T`変更 ${tm.chgPos + 1} / ${nc}` : T`変更 ${nc} 件`;
  $('#tmChgBtn').title = tmIsNow(i) ? T('最新のコミット（と、まだコミットしていない変更）で変わったコメントへ順に飛ぶ') : T('このコミットで追加・変更したコメントへ順に飛ぶ（枠で囲っています）');
  tmMarks();
}
// 目盛りの並べ方。全部が高さに入りきらなければ、1本ごとに TM_GAP px 空けてスクロールする（入りきるなら高さいっぱいに並べる）
const TM_GAP = 6, TM_PAD = 10;
const tmTrack = () => $('#tmTrack');
// 目盛りの位置（並びの上端からの px。上が古く、下が今）
function tmY(i){ const n = tm.list.length, h = tm.h || 0; return n <= 1 ? h - TM_PAD : TM_PAD + i / (n - 1) * (h - TM_PAD * 2); }
function tmIndexAt(y){ const n = tm.list.length, h = tm.h || 0; return n <= 1 ? 0 : clamp(Math.round((y - TM_PAD) / (h - TM_PAD * 2) * (n - 1)), 0, n - 1); }
// 目盛りを描く。最初と最後と、各日の最初は長くし、間が空いていれば日付も出す（近すぎるものは間引く。どれも選べる）。
// 日ごとに薄い帯を敷き、1本の長さはそのコミットでまとめた変更の数で少し伸ばす（活発だった所が分かるように）
// follow: 見ている位置が見えるところまでスクロールする（'smooth' なら滑らかに。false なら今のスクロールのまま）
function tmRender(follow = 'jump'){
  const box = $('#tmTicks'), track = tmTrack(), n = tm.list.length, vh = track.clientHeight;
  tm.h = Math.max(vh, (n - 1) * TM_GAP + TM_PAD * 2);
  box.style.height = tm.h + 'px';
  track.classList.toggle('scroll', tm.h > vh + 1);
  const frag = document.createDocumentFragment();
  const ticks = [];
  let lastY = -1e9, lastLong = -1e9, lastLabel = -1e9, prevDay = null, dayTop = null, dayN = 0;
  const endY = tmY(n - 1);
  const band = (y0, y1) => {
    const d = mkEl('div', 'tm-day' + (dayN++ % 2 ? ' alt' : ''));
    d.style.top = y0 + 'px'; d.style.height = Math.max(1, y1 - y0) + 'px';
    frag.append(d);
  };
  for (let i = 0; i < n; i++){
    const p = tm.list[i], y = tmY(i), day = tmIsNow(i) ? null : tmDayKey(p.time);
    const dayFirst = day != null && day !== prevDay;
    // 日の帯（その日の最初の目盛りの少し上から、次の日の最初の目盛りの少し上まで）
    if (dayFirst){ const top = i === 0 ? 0 : y - TM_GAP / 2; if (dayTop != null) band(dayTop, top); dayTop = top; }
    prevDay = day ?? prevDay;
    const edge = i === 0 || i === n - 1, long = edge || dayFirst;
    if (long ? (y - lastLong < 2 && !edge) : (y - lastY < 3)) continue;
    const tk = mkEl('div', 'tm-tick' + (long ? ' long' : '') + (tmIsNow(i) ? ' now' : ''));
    tk.style.top = y + 'px';
    const k = (p.changes || []).length;
    tk.style.setProperty('--len', (long ? 20 : 8 + Math.min(9, Math.log2(1 + k) * 3)).toFixed(1) + 'px');
    frag.append(tk);
    ticks.push({ el: tk, y });
    lastY = y; if (long) lastLong = y;
    // 日付（その日の最初の目盛りに。前の日付や「今」と重なるときは出さない）
    const isNow = tmIsNow(i);
    if ((isNow || dayFirst) && y - lastLabel >= 14 && (isNow || endY - y >= 14)){
      const lb = mkEl('div', 'tm-label' + (isNow ? ' now' : ''), isNow ? T('今') : tmDayLabel(p.time));
      if (!isNow) lb.append(mkEl('small', null, tmWd(new Date(p.time).getDay())));
      lb.style.top = y + 'px';
      frag.append(lb);
      lastLabel = y;
    }
  }
  if (dayTop != null) band(dayTop, tm.h);
  box.replaceChildren(frag);
  tm.ticks = ticks;
  tm.lensOn = [];
  tmMarks();
  if (follow) tmEnsureVisible(follow === 'smooth');
}
// 拡大鏡：マウスや指の近く（TM_LENS px 以内）の目盛りを、近いほど長く・明るくする（Mac の Time Machine の目盛りのように）。
// y は目盛りの並びの上端からの位置。null で元に戻す
const TM_LENS = 56;
function tmLens(y){
  const ticks = tm.ticks || [];
  for (const t of tm.lensOn || []) t.el.style.removeProperty('--m');
  tm.lensOn = [];
  if (y == null || !ticks.length || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  // 近くの目盛りだけを二分探索で探す
  let lo = 0, hi = ticks.length;
  while (lo < hi){ const mid = (lo + hi) >> 1; if (ticks[mid].y < y - TM_LENS) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < ticks.length && ticks[i].y <= y + TM_LENS; i++){
    const f = 1 - Math.abs(ticks[i].y - y) / TM_LENS;
    if (f <= 0) continue;
    ticks[i].el.style.setProperty('--m', (1 + 1.6 * f * f).toFixed(3));
    tm.lensOn.push(ticks[i]);
  }
}
// 見ている位置が目盛りの見えている範囲から出ていれば、見えるところまでスクロールする（smooth なら滑らかに）
function tmEnsureVisible(smooth){
  const track = tmTrack(), vh = track.clientHeight;
  if (tm.idx < 0 || tm.h <= vh + 1) return;
  const y = tmY(tm.idx), m = Math.min(48, vh / 4), top = track.scrollTop;
  let to = null;
  if (y < top + m) to = y - m;
  else if (y > top + vh - m) to = y - vh + m;
  if (to == null) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  track.scrollTo({ top: clamp(to, 0, tm.h - vh), behavior: smooth && !reduce ? 'smooth' : 'auto' });
}
// 見ている位置・指している位置の印
function tmMarks(){
  const n = tm.list.length;
  const cur = $('#tmCur'), hov = $('#tmHov');
  cur.hidden = !n || tm.idx < 0;
  if (!cur.hidden) cur.style.top = tmY(tm.idx) + 'px';
  hov.hidden = !n || tm.hover < 0 || tm.hover === tm.idx;
  if (!hov.hidden) hov.style.top = tmY(tm.hover) + 'px';
}
// マウスを重ねた目盛りの日付（PC）と、指でなぞっている間の大きな日付（スマホ。右から左へ薄くなるぼかしの上に出す）
function tmTip(i, touch){
  const tip = $('#tmTip'), sc = $('#tmScrub');
  if (i < 0){ tip.hidden = true; sc.classList.remove('on'); return; }
  const t = tmTitle(i), track = tmTrack(), r = track.getBoundingClientRect();
  // 画面の上からの位置（目盛りの見えている範囲に収める）
  const vy = clamp(r.top + tmY(i) - track.scrollTop, r.top, r.bottom);
  if (touch){
    tip.hidden = true;
    sc.classList.add('on');
    $('#tmScrubDate').textContent = t.date;
    $('#tmScrubSub').textContent = t.sub;
    // 指で隠れないよう、指より少し上に出す
    $('#tmScrubText').style.top = clamp(vy - 64, 8, window.innerHeight - 90) + 'px';
    return;
  }
  tip.hidden = false;
  tip.replaceChildren(mkEl('b', null, t.date), mkEl('span', null, t.sub));
  tip.style.top = (vy - $('#tmRail').getBoundingClientRect().top) + 'px';
}
// 位置を選ぶ（そのときのコメントを出す。読み込みは少し待ってから。続けて動かしても最後のものだけ取る）
function tmSelect(i){
  const n = tm.list.length;
  if (!n) return;
  i = clamp(i, 0, n - 1);
  if (i === tm.idx && !tm.want) return;
  tm.idx = i;
  clearTimeout(tm.timer);
  // 矢印などで動かしたら、見えるところまで滑らかにスクロールする（なぞっている間は、指やマウスのある所なので動かさない）
  if (!tm.scrub){ tmMarks(); tmEnsureVisible(true); }
  const p = tm.list[i];
  if (tmIsNow(i)){
    tm.want = null;
    tmShow(null);
    // 今のときは、最新のコミットの「最後に変えたコミット」を使う（まだコミットしていない変更は、今の変更として扱う）
    const last = tm.list[i - 1];
    if (last && !tm.cache.has(last.id)) tmRequest(last.id, true);
    return;
  }
  const got = tm.cache.get(p.id);
  if (got){ tm.want = null; tmShow(got); return; }
  tm.want = p.id;
  tmUI();
  histRender();
  tmRequest(p.id, false);
}
// そのときのコメントを求める（少し待ってから。続けて動かしても最後のものだけ取る）
function tmRequest(id, edits){
  clearTimeout(tm.timer);
  if (edits) tm.wantEdits = id;
  tm.timer = setTimeout(() => {
    if ((tm.want === id || tm.wantEdits === id) && collab.connected) collab.ws.send(JSON.stringify({ type: 'tm_show', commit: id }));
  }, 150);
}
// そのときのコメントを画面に出す（entry はホストから届いたもの { comments, edits }。null なら今）
function tmShow(entry){
  if (!tm.on) return;
  if (entry == null) tm.view = null;
  else {
    const v = new CommentStore(), ids = new Set(), items = [];
    for (const c of entry.comments){
      if (!c || typeof c !== 'object' || !isUuid(c.id) || ids.has(c.id)) continue;
      ids.add(c.id);
      items.push(makeComment(c.t, c.cmd, c.text, !!store.get(c.id)?.mine, c.id));
    }
    v.reset(items);
    tm.view = v;
  }
  tmEdits();
  commentsChanged();
  vimReload(true);
  tmUI();
  histRender();
  tmRestoreFill();
}
// 見ている時点で、それぞれのコメントを最後に変えたコミットから、その時点で変わったものと明るさを決める
function tmEdits(){
  const i = tm.idx, now = tmIsNow(i);
  const commit = now ? tm.list[i - 1]?.id : tm.list[i]?.id;
  const entry = commit ? tm.cache.get(commit) : null;
  tm.edit = new Map(); tm.alpha = new Map(); tm.changed = new Set(); tm.changedList = []; tm.chgPos = -1;
  // 最新のコミットの分がまだ届いていない（今を見ているとき）・履歴が無いときは、何も目立たせない
  if (!entry) return;
  for (const e of entry?.edits || []) for (const id of e.ids) tm.edit.set(id, e);
  if (now){
    // 最新のコミットと中身が違う（まだコミットしていない）ものは、今の変更
    const base = new Map((entry?.comments || []).map(c => [c.id, c]));
    const NOW = { commit: 'now', time: Infinity, author: '' };
    for (const c of store.comments){
      const b = base.get(c.id);
      if (!b || b.t !== c.t || b.cmd !== c.cmd || b.text !== c.text) tm.edit.set(c.id, NOW);
    }
  }
  const cs = state.comments, others = new Map();
  for (const c of cs){
    const e = tm.edit.get(c.id);
    if (!e) continue;
    if (e.commit === commit || e.commit === 'now'){ tm.changed.add(c.id); tm.changedList.push(c); }
    else others.set(e.commit, e.time);
  }
  // それより前に変えたものは、最近のものほど明るく（変えたコミットの新しい順に、0.8 から 0.3 まで）
  const order = [...others].sort((a, b) => b[1] - a[1]).map(x => x[0]), rank = new Map(order.map((c, k) => [c, k]));
  const k = order.length;
  for (const c of cs){
    const e = tm.edit.get(c.id);
    if (!e || tm.changed.has(c.id)) continue;
    tm.alpha.set(c.id, k <= 1 ? 0.75 : 0.8 - 0.5 * rank.get(e.commit) / (k - 1));
  }
}
// 変更履歴を見ている時点までに切り出す。ホストの記録（変更セット）はコミットの Change-Id で突き合わせ、
// 無ければ（古いホスト・ホストの外での変更）時刻で比べる。記録より前は、コミットの一覧（説明だけ）で出す
function tmHistory(items){
  const i = tm.idx, now = tmIsNow(i), commits = tm.list.slice(0, -1);
  const at = now ? commits.length - 1 : i;
  const upto = new Set(), after = new Set();
  commits.forEach((c, k) => { for (const id of c.changes) (k <= at ? upto : after).add(id); });
  const p = commits[at], bound = p ? p.time + 999 : Infinity;
  const hasIds = commits.some(c => c.changes.length);
  const keep = now ? items : items.filter(e => !e.pending && (upto.has(e.change.id) || (!after.has(e.change.id) && e.time <= bound)));
  // この時点（今なら最新のコミットと、まだコミットしていない変更）の変更
  const curIds = new Set(p?.changes || []), prev = commits[at - 1], from = prev ? prev.time + 999 : -Infinity;
  const cur = new Set(keep.filter(e => curIds.has(e.change.id) || (now && !upto.has(e.change.id) && !after.has(e.change.id) && (e.pending || e.time > bound))
    || (!hasIds && e.time > from && e.time <= bound)));
  // ホストの記録より前のコミット
  const oldest = keep.length ? Math.min(...keep.filter(e => !e.pending).map(e => e.time)) : Infinity;
  const older = [];
  for (let k = at; k >= 0; k--) if (commits[k].time + 999 < oldest) older.push({ commit: commits[k], index: k });
  return { items: keep.concat(older), cur, older: older.length };
}
// 見ている時点で変わったコメントへ順に飛ぶ（d: 1 で次、-1 で前）
function tmJump(d){
  const L = tm.changedList;
  if (!L.length) return;
  tm.chgPos = tm.chgPos < 0 ? (d > 0 ? 0 : L.length - 1) : (tm.chgPos + d + L.length) % L.length;
  jumpTo(null, [L[tm.chgPos].id]);
  tmUI();
}
function tmOpen(){
  if (tm.on || !collab.connected || !collab.remote) return;
  if (vim.E?.modified && !confirm(T('Vim エディタに書き込んでいない変更があります。捨ててタイムマシンを開きますか？'))) return;
  tmCancelEdits();
  Object.assign(tm, { on: true, list: [], idx: -1, view: null, want: null, loading: true, restoring: false, hover: -1 });
  tm.cache.clear();
  document.body.classList.add('tm-on');
  $('#tmRail').inert = false;
  $('#tmBar').hidden = false;
  // スマホではメニューバーが横にスクロールするので、タイムマシンの操作が左端に来るまでスクロールする
  const tb = $('.topbar');
  tb.scrollLeft += $('#tmBar').getBoundingClientRect().left - tb.getBoundingClientRect().left - 8;
  collab.ws.send(JSON.stringify({ type: 'tm_log' }));
  tmRender();
  tmUI();
  tlSelChanged();
  histChanged();
  // 押し縮めるのが終わってから、目盛りを今の高さで描き直す
  setTimeout(tmRender, 400);
  $('#tmRail').focus({ preventScroll: true });
}
function tmClose(){
  if (!tm.on) return;
  clearTimeout(tm.timer); clearTimeout(tm.refresh);
  const had = !!tm.view;
  Object.assign(tm, { on: false, list: [], idx: -1, view: null, want: null, loading: false, restoring: false, hover: -1, scrub: null,
    changed: new Set(), changedList: [], chgPos: -1, edit: new Map(), alpha: new Map(), wantEdits: null });
  tm.cache.clear();
  document.body.classList.remove('tm-on');
  $('#tmRail').inert = true;
  $('#tmBar').hidden = true;
  tmTip(-1);
  if ($('#tmRestoreDlg').open) $('#tmRestoreDlg').close();
  commentsChanged();
  tlSelChanged();
  if (had) vimReload(true);
  tmUI();
  histChanged();
}
// 入力中の文字や書きかけの Vim は、過去を見ている間は使わないので片付ける
function tmCancelEdits(){
  if (document.activeElement && (document.activeElement === textInput || document.activeElement === cmdInput)) document.activeElement.blur();
}
// 一覧を取り直す（新しいコミットができたとき）。見ている位置は同じコミット（今なら今）のまま
function tmRefreshSoon(){
  if (!tm.on) return;
  clearTimeout(tm.refresh);
  tm.refresh = setTimeout(() => { if (tm.on && collab.connected) collab.ws.send(JSON.stringify({ type: 'tm_log' })); }, 2500);
}
function tmHandle(m){
  if (!tm.on) return;
  if (m.type === 'tm_log'){
    tm.loading = false;
    if (m.error){ toast(T('タイムマシン: ') + m.error, { type:'error', timeout:6000 }); tmClose(); return; }
    const keep = tm.idx >= 0 && !tmIsNow(tm.idx) ? tm.list[tm.idx]?.id : null, first = !tm.list.length;
    const commits = (Array.isArray(m.commits) ? m.commits : []).filter(c => c && typeof c.id === 'string' && /^[0-9a-f]{40,64}$/.test(c.id) && typeof c.time === 'number')
      .map(c => ({ id: c.id, time: c.time, author: String(c.author ?? ''), subject: String(c.subject ?? ''),
        changes: Array.isArray(c.changes) ? c.changes.filter(x => typeof x === 'string') : [] }));
    tm.list = commits.reverse().concat([{ id: null, time: Date.now(), author: '', subject: '' }]);
    const at = keep ? tm.list.findIndex(p => p.id === keep) : -1;
    tm.idx = at >= 0 ? at : tm.list.length - 1;
    if (tm.list.length === 1) toast(T('このプロジェクトには、まださかのぼれる履歴がありません'), { timeout:5000 });
    // 今を見ているなら、最新のコミットで変わったものを目立たせる
    if (tmIsNow(tm.idx) && tm.list.length > 1){
      const last = tm.list[tm.idx - 1].id;
      if (tm.cache.has(last)){ tmEdits(); commentsChanged(); } else tmRequest(last, true);
    }
    // 開いたときは見ている位置（今）までスクロールする。新しいコミットが増えたときは、今を見ていれば滑らかに追いかけ、
    // 過去を見ているなら目盛りを見て回っているところかもしれないので、スクロールはそのまま（目盛りは下に増えるだけ）
    tmRender(first ? 'jump' : tmIsNow(tm.idx) ? 'smooth' : false);
    tmUI();
    histRender();
  } else if (m.type === 'tm_show'){
    if (m.error){
      toast(T('タイムマシン: ') + m.error, { type:'error', timeout:6000 });
      if (m.commit === tm.want){ tm.want = null; tmUI(); }
      return;
    }
    if (typeof m.commit !== 'string' || !Array.isArray(m.comments)) return;
    const edits = (Array.isArray(m.edits) ? m.edits : []).filter(e => e && typeof e.commit === 'string' && typeof e.time === 'number' && Array.isArray(e.ids))
      .map(e => ({ commit: e.commit, time: e.time, author: String(e.author ?? ''), ids: e.ids.filter(id => typeof id === 'string') }));
    const entry = { comments: m.comments, edits };
    tm.cache.set(m.commit, entry);
    // 覚えておくのは最近の 12 個まで
    while (tm.cache.size > 12) tm.cache.delete(tm.cache.keys().next().value);
    if (m.commit === tm.want){ tm.want = null; tmShow(entry); }
    else if (m.commit === tm.wantEdits){
      tm.wantEdits = null;
      if (tmIsNow(tm.idx) && tm.list[tm.idx - 1]?.id === m.commit){ tmEdits(); commentsChanged(); tmUI(); }
    }
  } else if (m.type === 'tm_restore'){
    tm.restoring = false;
    if (m.error){ toast(T('復元できませんでした: ') + m.error, { type:'error', timeout:8000 }); tmUI(); return; }
    toast(m.rev == null ? T('今と同じ内容だったため、何も変わりませんでした') : T`復元しました（${m.count} 件の変更として記録しました）`, { timeout:5000 });
    tmClose();
  }
}
// 今の中身からそのときの中身にする変更の数
function tmDiff(){
  const now = store, then = tm.view, r = { add: 0, upd: 0, del: 0 };
  if (!then) return r;
  for (const c of now.comments){
    const o = then.get(c.id);
    if (!o) r.del++;
    else if (o.t !== c.t || o.cmd !== c.cmd || o.text !== c.text) r.upd++;
  }
  for (const c of then.comments) if (!now.has(c.id)) r.add++;
  return r;
}
function tmRestoreAsk(){
  if (!tm.on || !tm.view || tmIsNow(tm.idx) || tm.want) return;
  tmRestoreFill(true);
  $('#tmRestoreDlg').showModal();
}
// 復元の確認の中身（開いている間にほかの人の変更が届いたら、数を直す）
function tmRestoreFill(force = false){
  if (!force && !$('#tmRestoreDlg').open) return;
  if (!tm.on || !tm.view || tmIsNow(tm.idx)) return;
  const p = tm.list[tm.idx], d = tmDiff(), t = tmTitle(tm.idx);
  $('#tmRestoreWhen').textContent = t.date;
  $('#tmRestoreWhat').textContent = T`${t.sub}（${p.author}・コミット ${p.id.slice(0, 7)}）`;
  const parts = [[T('追加'), d.add], [T('変更'), d.upd], [T('削除'), d.del]].filter(x => x[1]).map(([k, n]) => T`${k} ${n} 件`);
  $('#tmRestoreDiff').textContent = parts.length
    ? T`今のコメント（${store.size} 件）から、${parts.join(T('・'))}をして、このときのコメント（${tm.view.size} 件）に戻します。`
    : T('今のコメントと同じ内容です（戻しても何も変わりません）。');
  $('#tmRestoreOk').disabled = !parts.length || !collab.connected;
}
function tmRestore(){
  const p = tm.list[tm.idx];
  $('#tmRestoreDlg').close();
  if (!tm.on || !p?.id || !collab.connected) return;
  tm.restoring = true;
  collab.ws.send(JSON.stringify({ type: 'tm_restore', commit: p.id }));
  tmUI();
}
$('#tmBtn').onclick = () => tm.on ? tmClose() : tmOpen();
$('#tmExit').onclick = tmClose;
$('#tmUp').onclick = $('#tmRailUp').onclick = () => tmSelect(tm.idx - 1);
$('#tmDown').onclick = $('#tmRailDown').onclick = () => tmSelect(tm.idx + 1);
$('#tmRestore').onclick = tmRestoreAsk;
$('#tmChgBtn').onclick = $('#tmNextChg').onclick = () => tmJump(1);
$('#tmPrevChg').onclick = () => tmJump(-1);
$('#tmRestoreCancel').onclick = () => $('#tmRestoreDlg').close();
$('#tmRestoreOk').onclick = tmRestore;
// 目盛り：マウスを重ねると日付、押すかなぞって選ぶ（指でなぞっている間は大きな日付を出す）。
// 入りきらないときはスクロールする。PC はホイール、スマホは素早くスワイプでスクロールし、押して少し止めてからなぞると選ぶ
(() => {
  const box = $('#tmTicks'), rail = $('#tmRail'), track = tmTrack();
  const HOLD_MS = 280, SLOP = 8, EDGE = 32;
  const scrollable = () => tm.h > track.clientHeight + 1;
  // 画面の y から目盛りの番号
  const indexAt = (clientY) => tmIndexAt(clientY - box.getBoundingClientRect().top);
  let mouseY = null; // マウスが目盛りの上にあるときの y（ホイールでスクロールしたら指している目盛りを直す）
  let pending = null; // 指で押してから、スクロールか選ぶかが決まるまで（{ id, x, y, timer }）
  let lastY = 0, edgeRaf = 0;
  const point = (clientY, touch) => {
    if (!tm.list.length) return -1;
    const i = indexAt(clientY);
    tm.hover = i;
    tmTip(i, touch);
    tmMarks();
    tmLens(clientY - box.getBoundingClientRect().top);
    return i;
  };
  const hideSoon = (ms) => setTimeout(() => { if (!tm.scrub && !pending && mouseY == null){ tm.hover = -1; tmTip(-1); tmMarks(); tmLens(null); } }, ms);
  // なぞっている指やマウスが目盛りの上端・下端に近づいたら、その方向へスクロールし続ける
  const edgeScroll = () => {
    edgeRaf = 0;
    if (!tm.scrub || !scrollable()) return;
    const r = track.getBoundingClientRect();
    const v = lastY < r.top + EDGE ? -(r.top + EDGE - lastY) / EDGE : lastY > r.bottom - EDGE ? (lastY - (r.bottom - EDGE)) / EDGE : 0;
    if (!v) return;
    track.scrollTop += clamp(v, -1, 1) * 14;
    const i = point(lastY, tm.scrub.touch);
    if (!tm.scrub.touch) tmSelect(i);
    edgeRaf = requestAnimationFrame(edgeScroll);
  };
  const startScrub = (id, touch, clientY) => {
    tm.scrub = { id, touch };
    try { box.setPointerCapture(id); } catch {}
    lastY = clientY;
    const i = point(clientY, touch);
    if (!touch) tmSelect(i);
    if (touch && navigator.vibrate) try { navigator.vibrate(8); } catch {}
  };
  box.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || !tm.list.length) return;
    const touch = e.pointerType !== 'mouse';
    // 入りきっていれば、指でもすぐになぞって選ぶ。スクロールするときは、少し止めてから
    if (!touch || !scrollable()){ e.preventDefault(); startScrub(e.pointerId, touch, e.clientY); return; }
    clearTimeout(pending?.timer);
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
      const p = pending;
      pending = null;
      if (p) startScrub(p.id, true, p.y);
    }, HOLD_MS) };
  });
  box.addEventListener('pointermove', (e) => {
    if (pending && pending.id === e.pointerId){
      // 止まらずに動かしたら、スクロール（ブラウザに任せる）
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) > SLOP){ clearTimeout(pending.timer); pending = null; }
      else pending.y = e.clientY;
      return;
    }
    if (tm.scrub && tm.scrub.id !== e.pointerId) return;
    if (!tm.scrub){
      if (e.pointerType === 'mouse'){ mouseY = e.clientY; point(e.clientY, false); }
      return;
    }
    lastY = e.clientY;
    const i = point(e.clientY, tm.scrub.touch);
    // マウスで押したままなぞると、そのまま見ていく（指は離したときに選ぶ。なぞっている間に読み込みを重ねない）
    if (!tm.scrub.touch) tmSelect(i);
    if (!edgeRaf) edgeRaf = requestAnimationFrame(edgeScroll);
  });
  const end = (e, cancel) => {
    if (pending && pending.id === e.pointerId){
      // 動かさずにすぐ離した（タップ）: その目盛りを選んで、日付を少しだけ見せる
      clearTimeout(pending.timer);
      pending = null;
      if (!cancel){ const i = point(e.clientY, true); tmSelect(i); hideSoon(700); }
      return;
    }
    if (!tm.scrub || tm.scrub.id !== e.pointerId) return;
    const s = tm.scrub;
    tm.scrub = null;
    cancelAnimationFrame(edgeRaf); edgeRaf = 0;
    if (s.touch){
      if (!cancel && tm.hover >= 0) tmSelect(tm.hover);
      // 選んだ日付を少しだけ見せてから消す
      hideSoon(cancel ? 0 : 700);
    }
    tmEnsureVisible(true);
  };
  box.addEventListener('pointerup', (e) => end(e, false));
  box.addEventListener('pointercancel', (e) => end(e, true));
  box.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse'){ mouseY = null; if (!tm.scrub){ tm.hover = -1; tmTip(-1); tmMarks(); tmLens(null); } } });
  // 選んでいる間（指で少し止めてからなぞっている間）は、ページや目盛りをスクロールさせない
  track.addEventListener('touchmove', (e) => { if (tm.scrub?.touch && e.cancelable) e.preventDefault(); }, { passive: false });
  // スクロールしたら、指している目盛りを直す
  track.addEventListener('scroll', () => {
    if (tm.scrub) point(lastY, tm.scrub.touch);
    else if (mouseY != null) point(mouseY, false);
  }, { passive: true });
  // ホイール: スクロールできるならスクロール（ブラウザに任せる）、入りきっていれば1つずつ動く
  let acc = 0;
  rail.addEventListener('wheel', (e) => {
    if (!tm.on) return;
    if (scrollable() && track.contains(e.target)) return;
    e.preventDefault();
    acc += e.deltaY;
    if (Math.abs(acc) >= 40){ tmSelect(tm.idx + Math.sign(acc)); acc = 0; }
  }, { passive: false });
  rail.addEventListener('keydown', (e) => {
    if (!tm.on) return;
    const k = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10, Home: -1e9, End: 1e9 }[e.key];
    if (k == null) return;
    e.preventDefault(); e.stopPropagation();
    tmSelect(tm.idx + k);
  });
  new ResizeObserver(() => { if (tm.on) tmRender(); }).observe(track);
})();

/* ---------- ホストへの問い合わせ（合言葉・ログインを付ける） ---------- */
async function collabApi(path, body){
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (collab.session) headers.Authorization = 'Bearer ' + collab.session.token;
  const url = path + (collab.key ? (path.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(collab.key) : '');
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || T`ホストがエラーを返しました（${r.status}）`), { status: r.status });
  return j;
}
// URL の検索部分を書き換える（ページは読み込み直さない）
function collabSetQuery(fn){
  const q = new URLSearchParams(location.search);
  fn(q);
  const s = q.toString();
  window.history.replaceState(null, '', location.pathname + (s ? '?' + s : '') + location.hash);
}

/* ---------- ログイン（--otp） ---------- */
const SESSION_KEY = 'komenagare.session';
function sessionLoad(){ try { const v = JSON.parse(collabLS(SESSION_KEY) || 'null'); return v && v.token ? v : null; } catch { return null; } }
function sessionSave(v){ collab.session = v; try { if (v) localStorage.setItem(SESSION_KEY, JSON.stringify(v)); else localStorage.removeItem(SESSION_KEY); } catch {} }
async function collabLogin(code){
  const r = await collabApi('/api/login', { code });
  sessionSave({ token: r.token, name: r.name, admin: r.admin });
  return r;
}
// ログインできるまで待つ（URL の otp= があれば使い、なければ入力してもらう）
async function ensureLogin(){
  const code = new URLSearchParams(location.search).get('otp');
  if (code) collabSetQuery(q => q.delete('otp'));
  collab.session = sessionLoad();
  if (collab.session){
    try { const me = await collabApi('/api/me'); sessionSave({ ...collab.session, ...me }); return; }
    catch (e) { if (e.status === 401) sessionSave(null); else return; } // ホストにつながらなければ控えのまま進める
  }
  if (code){
    try { await collabLogin(code); return; } catch (e) { $('#loginErr').textContent = e.message; }
  }
  await loginOpen();
}
let loginWait = null;
function loginOpen(){
  const dlg = $('#loginDlg');
  if (!dlg.open){ dlg.showModal(); setTimeout(() => $('#loginCode').focus(), 0); }
  return loginWait || (loginWait = new Promise(r => { dlg._done = r; }));
}
$('#loginDlg').addEventListener('cancel', (e) => e.preventDefault()); // ログインするまで閉じない
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#loginCode').value.trim();
  if (!code) return;
  $('#loginOk').disabled = true; $('#loginErr').textContent = '';
  try {
    await collabLogin(code);
    $('#loginCode').value = '';
    $('#loginDlg').close();
    const done = $('#loginDlg')._done; loginWait = null;
    done?.();
  } catch (err) { $('#loginErr').textContent = err.message; }
  finally { $('#loginOk').disabled = false; }
});
// ホストにログインし直すよう言われたとき（取り消された・期限切れ）
async function collabRelogin(){
  sessionSave(null);
  collab.blocked = 'auth';
  collabUI();
  $('#loginErr').textContent = T('ログインし直してください（ホストの人に新しいワンタイムパスワードをもらってください）');
  await loginOpen();
  collab.blocked = false; collab.retry = 0;
  peersUI();
  collabConnect();
}

/* ---------- タブごとの控え ----------
   同じプロジェクトを複数のタブで開けるように、衝突の控えはタブ（owner）ごとに分けて置く。
   タブは数秒おきに localStorage へ生きている印を書き、印が古いタブ（閉じたタブ）の控えは次に開いたタブが引き継ぐ */
const ALIVE_PREFIX = 'komenagare.alive.', ALIVE_MS = 5000, ALIVE_STALE = 20000;
function ownerAlive(id){ const t = +collabLS(ALIVE_PREFIX + id); return t > 0 && Date.now() - t < ALIVE_STALE; }
function ownerBeat(){ if (collab.owner) collabLS(ALIVE_PREFIX + collab.owner, String(Date.now())); }
function ownerRelease(){ if (collab.owner){ try { localStorage.removeItem(ALIVE_PREFIX + collab.owner); } catch {} } }
setInterval(ownerBeat, ALIVE_MS);
window.addEventListener('pagehide', ownerRelease);
window.addEventListener('pageshow', (e) => { if (e.persisted) ownerBeat(); });
// 自分の衝突の控えと、閉じたタブの分を読み込む
async function loadConflicts(){
  const keys = (await collabTx('meta', 'readonly', s => s.getAllKeys())) || [];
  const mine = [], adopted = [];
  for (const k of keys){
    if (typeof k !== 'string' || !(k === 'conflicts' || k.startsWith('conflicts:'))) continue;
    const owner = k.slice('conflicts:'.length);
    if (k !== 'conflicts' && (owner === collab.owner || ownerAlive(owner))) continue;
    const list = await collabTx('meta', 'readonly', s => s.get(k));
    if (Array.isArray(list)) mine.push(...list.filter(r => !mine.some(x => x.key === r.key)));
    adopted.push(k);
  }
  for (const k of adopted) await collabTx('meta', 'readwrite', s => s.delete(k));
  // 古い生存印を片付ける
  try { for (const k of Object.keys(localStorage)) if (k.startsWith(ALIVE_PREFIX) && Date.now() - +localStorage.getItem(k) > 86400000) localStorage.removeItem(k); } catch {}
  return mine;
}

/* ---------- プロジェクト ---------- */
async function collabInit(){
  if (!state.collab) return;
  $('#collabStatus').onclick = () => { if (collab.blocked === 'email') location.reload(); else peersOpen(); };
  $('#projectBtn').onclick = () => projectsOpen();
  $('#projectBtn').hidden = false;
  $('#projectBtn').textContent = T('プロジェクト');
  $('#peersRename').onclick = () => {
    const n = prompt(T('共同編集で表示する名前'), collabName());
    if (n == null) return;
    collabLS('komenagare.name', n.trim().slice(0, 40));
    if (collab.connected) collab.ws.send(JSON.stringify(collabHello()));
  };
  presence.ready = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (collab.auth === 'otp') await ensureLogin();
  else if (!collabName()){
    const n = prompt(T('共同編集で表示する名前を入力してください（コミットの作者名になります）'), '');
    if (n && n.trim()) collabLS('komenagare.name', n.trim().slice(0, 40));
  }
  peersUI();
  collabUI();
  let list = null;
  try { list = await projectsFetch(); } catch (e) { toast(T('ホスト: ') + e.message, { type:'error', timeout:8000 }); }
  const want = new URLSearchParams(location.search).get('p');
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem('komenagare.project') || 'null'); } catch { return null; } })();
  let p = list ? list.find(x => x.id === want) || (list.length === 1 ? list[0] : null)
    // ホストにつながらないときは、このタブで前に開いていたプロジェクトの控えで作業を続ける
    : saved && (!want || saved.id === want) ? saved : null;
  if (!p && list) p = await projectsOpen(true);
  if (p) await collabOpen(p);
}
async function projectsFetch(){
  const r = await collabApi('/api/projects');
  collab.projects = r.projects || [];
  collab.projectsLoaded = true;
  // プロジェクトを作る・外すことができるか（まとめフォルダで起動したホストだけ。古いホストは送ってこない）
  collab.projectsManage = r.manage === true;
  collab.projectsHidden = Array.isArray(r.hidden) ? r.hidden.filter(x => typeof x === 'string').slice(0, 200) : [];
  if (r.me && collab.session) sessionSave({ ...collab.session, ...r.me });
  return collab.projects;
}

// プロジェクトを開く（開いていたものは閉じる）。動画・再生位置・タイムラインの表示はプロジェクトごとに覚えておき、戻ってきたら戻す
async function collabOpen(p){
  if (collab.project) collabClose();
  collab.project = { id: p.id, name: p.name };
  collab.workspace = p.id;
  collab.owner = uuidv7(); ownerBeat();
  try { sessionStorage.setItem('komenagare.project', JSON.stringify(collab.project)); } catch {}
  collabSetQuery(q => q.set('p', p.id));
  document.title = T`${p.name} - コメナガレ`;
  $('#projectBtn').textContent = p.name;
  store.reset([]);
  try {
    collab.db = await collabIdb();
    const [snap, outbox] = await Promise.all([collabTx('meta', 'readonly', s => s.get('snapshot')), collabTx('outbox', 'readonly', s => s.getAll())]);
    collab.outbox = (outbox || []).sort((a, b) => a.seq - b.seq);
    await collabResplitOutbox();
    collab.conflicts = await loadConflicts();
    conflictsChanged();
    // 前回の控えをすぐに表示する（ホストにつながる前やオフラインでも作業できるように）
    if (snap && snap.comments) store.reset(snap.comments);
    for (const e of collab.outbox) store.apply(e.change);
  } catch (e) {
    console.warn(T('IndexedDB を使えません'), e);
    toast(T('このブラウザに控えを保存できないため、オフラインの間の変更は失われることがあります'), { type:'error', timeout:8000 });
  }
  commentsChanged();
  // このタブで前に開いていたなら、動画（再生位置）とタイムラインの表示（位置・拡大縮小・縦の位置）を戻す
  const v = projectVideos.get(p.id);
  if (v?.file){ state.viewRestore = v.view; loadVideo(v.file, { at: v.t }); } // 表示は動画の長さが分かってから戻す
  else {
    if (v?.view) tlRestoreView(v.view); else { TL.pendingView = null; tlResetView(); }
    const name = collabLS(VIDEO_HINT + p.id);
    if (name) toast(T`このプロジェクトでは前に「${name}」を開いていました。動画を開き直してください`, { timeout: 6000 });
  }
  updateStatus();
  collabUI();
  collabConnect();
}
// プロジェクトごとの動画・再生位置・タイムラインの表示（このタブで開いたもの）と、前に開いた動画の名前（localStorage）
const projectVideos = new Map();
const VIDEO_HINT = 'komenagare.video.';
function collabVideoOpened(file){ if (collab.project) collabLS(VIDEO_HINT + collab.project.id, file.name); }
// 開いているプロジェクトを閉じて、そのプロジェクトのものを片付ける
function collabClose(){
  tmClose();
  // このプロジェクトで開いていた動画とタイムラインの表示を覚えて閉じる（このタブで戻ってきたら戻す）
  if (collab.project) projectVideos.set(collab.project.id, { file: state.videoFile, t: video.currentTime || 0, view: tlSaveView() });
  unloadVideo();
  const ws = collab.ws;
  collab.ws = null;
  clearTimeout(collab.timer); clearTimeout(collab.saveTimer); clearTimeout(presence.timer); presence.timer = 0;
  clearTimeout(collab.pongTimer); clearTimeout(collab.followWait);
  for (const t of collab.leaving.values()) clearTimeout(t);
  collab.leaving.clear();
  if (ws){ try { ws.close(); } catch {} }
  if (collab.db){ collabTx('meta', 'readwrite', s => s.put(collab.conflicts, 'conflicts:' + collab.owner)).catch(() => {}); }
  ownerRelease();
  const db = collab.db;
  setTimeout(() => db?.close(), 1000); // 書きかけの控えを書き終えてから閉じる
  Object.assign(collab, { db: null, connected: false, blocked: false, retry: 0, failed: 0, me: null, serverName: null, rev: 0, epoch: null,
    outbox: [], conflicts: [], shared: [], peers: [], peerList: [], follow: null, followClient: null, project: null,
    synced: false, pingAt: 0, peersReady: false, lastPeers: [] });
  collab.presence.clear();
  presence.sent = '';
  followUI();
  hist.entries = null;
  history.undo = []; history.redo = []; updateUndoUI();
  TL.sel = new Set(); tlSelChanged();
  if ($('#conflictDlg').open) $('#conflictDlg').close();
  conflictsChanged();
}

/* ---------- プロジェクトの一覧 ---------- */
// required: 起動時に選んでもらうとき（選ぶまで閉じられない。選んだプロジェクトを返す）
let projectsWait = null, projectsTimer = 0;
function projectsOpen(required = false){
  const dlg = $('#projectsDlg');
  dlg.dataset.required = required ? '1' : '';
  $('#projectsClose').hidden = required;
  $('#projectsAuth').hidden = !(collab.auth === 'otp' && collab.session?.admin);
  $('#projectsLogout').hidden = collab.auth !== 'otp' || !collab.session;
  projectsRender();
  projectsFetch().then(projectsRender).catch(e => { $('#projectsList').replaceChildren(mkEl('p', 'muted', T('ホスト: ') + e.message)); });
  clearInterval(projectsTimer);
  projectsTimer = setInterval(() => { if (dlg.open) projectsFetch().then(projectsRender).catch(() => {}); else clearInterval(projectsTimer); }, 4000);
  if (!dlg.open) dlg.showModal();
  if (!required) return null;
  return projectsWait || (projectsWait = new Promise(r => { dlg._done = r; }));
}
// 新しいタブで開く URL（合言葉はタブごとに持つので付けて渡す）
function projectUrl(p){
  const q = new URLSearchParams();
  q.set('p', p.id);
  if (collab.key) q.set('k', collab.key);
  return location.pathname + '?' + q;
}
function projectsRender(){
  const frag = document.createDocumentFragment();
  if (!collab.projects.length) frag.append(mkEl('p', 'muted', !collab.projectsLoaded ? T('読み込んでいます…')
    : T('プロジェクトがありません。') + (collab.projectsManage ? T('下で名前を入れて「作る」と作れます。') : T('ホストの管理者に作ってもらってください。'))));
  for (const p of collab.projects){
    const cur = collab.project?.id === p.id;
    const row = mkEl('div', 'proj-row' + (cur ? ' on' : ''));
    const info = mkEl('div', 'proj-info');
    info.append(mkEl('div', 'proj-name', p.name + (cur ? T('（このタブで開いています）') : '')));
    info.append(mkEl('div', 'proj-peers', p.peers?.length ? T`${p.peers.length}人: ${p.peers.join(T('、'))}` : T('だれもいません')));
    row.append(info);
    if (!cur){
      const b = mkEl('button', 'primary', T('開く'));
      b.onclick = () => {
        if (exportState.running){ toast(T('書き出し中はプロジェクトを切り替えられません'), { type:'error' }); return; }
        const dlg = $('#projectsDlg'), done = dlg._done;
        dlg._done = null; projectsWait = null; dlg.dataset.required = '';
        dlg.close();
        if (done) done(p); else collabOpen(p); // 起動時の選択なら collabInit が開く
      };
      row.append(b);
    }
    const a = mkEl('a', 'btn', T('新しいタブ'));
    a.href = projectUrl(p); a.target = '_blank'; a.rel = 'noopener';
    row.append(a);
    if (collab.projectsManage){
      const rm = mkEl('button', null, T('外す'));
      rm.title = T('このホストでの共有をやめます（フォルダとコメントは残り、あとで戻せます）');
      rm.onclick = () => projectRemove(p);
      row.append(rm);
    }
    frag.append(row);
  }
  $('#projectsList').replaceChildren(frag);
  $('#projectsManage').hidden = !collab.projectsManage;
  const n = collab.projectsHidden.length;
  $('#projectsRestoreBtn').disabled = !n;
  $('#projectsRestoreBtn').textContent = n ? T`プロジェクトを復元…（${n}）` : T('プロジェクトを復元…（外したものはありません）');
  if ($('#restoreDlg').open) restoreRender();
}
/* ---------- 外したプロジェクトを復元する ---------- */
const restorePicked = new Set();
function restoreOpen(){
  restorePicked.clear();
  restoreRender();
  if (!$('#restoreDlg').open) $('#restoreDlg').showModal();
}
function restoreRender(){
  for (const name of [...restorePicked]) if (!collab.projectsHidden.includes(name)) restorePicked.delete(name);
  const frag = document.createDocumentFragment();
  if (!collab.projectsHidden.length) frag.append(mkEl('p', 'muted', T('外したプロジェクトはありません。')));
  for (const name of collab.projectsHidden){
    const row = mkEl('label', 'restore-row');
    const cb = mkEl('input');
    cb.type = 'checkbox'; cb.checked = restorePicked.has(name);
    cb.onchange = () => { if (cb.checked) restorePicked.add(name); else restorePicked.delete(name); $('#restoreOk').disabled = !restorePicked.size; };
    row.append(cb, mkEl('span', null, name));
    frag.append(row);
  }
  $('#restoreList').replaceChildren(frag);
  $('#restoreOk').disabled = !restorePicked.size;
}
$('#projectsRestoreBtn').onclick = restoreOpen;
$('#restoreCancel').onclick = () => $('#restoreDlg').close();
$('#restoreOk').onclick = async () => {
  const names = collab.projectsHidden.filter(n => restorePicked.has(n));
  if (!names.length) return;
  $('#restoreOk').disabled = true;
  const done = [];
  for (const name of names){
    try {
      await collabApi('/api/projects', { name, by: collabName() });
      done.push(name);
    } catch (e) {
      toast(T`ホスト:「${name}」を復元できませんでした: ${e.message}`, { type:'error', timeout:6000 });
    }
  }
  if (done.length) toast(T`${done.map(n => T`「${n}」`).join('')}を復元しました`);
  $('#restoreDlg').close();
  try { await projectsFetch(); } catch {}
  projectsRender();
};
// まとめフォルダにプロジェクトを作る（同じ名前の外したフォルダなら戻す）
async function projectAdd(name, done){
  name = (name || '').trim();
  if (!name){ $('#projectsNewName').focus(); return; }
  $('#projectsNewBtn').disabled = true;
  try {
    const r = await collabApi('/api/projects', { name, by: collabName() });
    toast(done || T`「${r.name}」を作りました`);
    if (!done) $('#projectsNewName').value = '';
    await projectsFetch();
    projectsRender();
  } catch (e) {
    toast(T('ホスト: ') + e.message, { type:'error', timeout:6000 });
  } finally {
    $('#projectsNewBtn').disabled = false;
  }
}
async function projectRemove(p){
  if (!confirm(T`「${p.name}」を外しますか？\nこのホストでの共有をやめて、まとめフォルダのリポジトリからも外します（それまでの履歴には残ります）。\nホストのフォルダとコメントはそのままで、「プロジェクトを復元」で戻せます。開いている人は切断されます。`)) return;
  try {
    await collabApi('/api/projects/remove', { id: p.id, by: collabName() });
    toast(T`「${p.name}」を外しました`);
    await projectsFetch();
    projectsRender();
  } catch (e) {
    toast(T('ホスト: ') + e.message, { type:'error', timeout:6000 });
  }
}
$('#projectsNewBtn').onclick = () => projectAdd($('#projectsNewName').value);
$('#projectsNewName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing){ e.preventDefault(); projectAdd($('#projectsNewName').value); }
});
$('#projectsDlg').addEventListener('cancel', (e) => { if ($('#projectsDlg').dataset.required) e.preventDefault(); });
$('#projectsDlg').addEventListener('close', () => clearInterval(projectsTimer));
$('#projectsClose').onclick = () => $('#projectsDlg').close();
$('#projectsLogout').onclick = async () => {
  if (!confirm(T('ログアウトしますか？（もう一度入るには新しいワンタイムパスワードが要ります）'))) return;
  try { await collabApi('/api/logout', {}); } catch {}
  sessionSave(null);
  location.reload();
};
$('#projectsAuth').onclick = authOpen;

/* ---------- 招待とログインの管理（管理者） ---------- */
function authOpen(){ authRender(); $('#authResult').hidden = true; if (!$('#authDlg').open) $('#authDlg').showModal(); setTimeout(() => $('#authName').focus(), 0); }
const fmtDate = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
async function authRender(){
  let r;
  try { r = await collabApi('/api/admin/auth'); } catch (e) { $('#authLists').replaceChildren(mkEl('p', 'muted', e.message)); return; }
  const frag = document.createDocumentFragment();
  const revoke = (id, label) => {
    const b = mkEl('button', null, T('取り消す'));
    b.onclick = async () => {
      if (!confirm(T`${label} を取り消しますか？`)) return;
      try { await collabApi('/api/admin/revoke', { id }); } catch (e) { toast(e.message, { type:'error' }); }
      authRender();
    };
    return b;
  };
  frag.append(mkEl('h4', null, T`ログイン中（${r.sessions.length}）`));
  for (const x of r.sessions){
    const row = mkEl('div', 'auth-row');
    row.append(mkEl('span', 'auth-name', x.name + (x.admin ? T('（管理者）') : '') + (x.you ? T('（あなた）') : '')), mkEl('span', 'muted', fmtDate(x.created) + T(' から') + (x.expires ? T('・') + fmtDate(x.expires) + T(' まで') : '')));
    if (!x.you) row.append(revoke(x.id, T`${x.name} のログイン`));
    frag.append(row);
  }
  frag.append(mkEl('h4', null, T`未使用のワンタイムパスワード（${r.otps.length}）`));
  if (!r.otps.length) frag.append(mkEl('p', 'muted', T('ありません')));
  for (const x of r.otps){
    const row = mkEl('div', 'auth-row');
    row.append(mkEl('span', 'auth-name', x.name + (x.admin ? T('（管理者）') : '')), mkEl('span', 'muted', (x.kind === 'numeric' ? T('数字') : T('英数字')) + T('・') + fmtDate(x.expires) + T(' まで')), revoke(x.id, T`${x.name} のワンタイムパスワード`));
    frag.append(row);
  }
  $('#authLists').replaceChildren(frag);
}
$('#authKind').onchange = () => { $('#authTtl').value = $('#authKind').value === 'numeric' ? '600' : '604800'; };
$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#authName').value.trim();
  if (!name) return;
  try {
    const r = await collabApi('/api/admin/otp', { name, kind: $('#authKind').value, ttl: +$('#authTtl').value, admin: $('#authAdmin').checked });
    const link = (collab.publicUrl || location.origin + location.pathname) + '?otp=' + r.code;
    $('#authCode').textContent = r.code;
    $('#authLink').value = link;
    $('#authExpires').textContent = T`${name} 用・${fmtDate(r.expires)} まで・1回だけ使えます`;
    $('#authResult').hidden = false;
    $('#authName').value = '';
    authRender();
  } catch (err) { toast(err.message, { type:'error' }); }
});
$('#authCopy').onclick = () => { const v = $('#authLink').value; (navigator.clipboard?.writeText(v) || Promise.reject()).then(() => toast(T('リンクをコピーしました'), { timeout:1500 }), () => { $('#authLink').select(); document.execCommand('copy'); }); };
$('#authClose').onclick = () => $('#authDlg').close();

// 表示名の変更（--otp のときはホストが決めるので出さない）
function peersUI(){ $('#peersRename').hidden = collab.auth === 'otp'; }

/* =====================================================================
   変更履歴
   - ひとりのとき: この画面で行った変更（state.changeLog）
   - 共同編集のとき: ホストに記録された全員の変更（まだ送れていない自分の変更も上に出す）
   どの変更も「取り消す」で打ち消す変更を新しく積める（git revert と同じ。その後に同じコメントが
   変わっていれば止める）
   ===================================================================== */
const hist = { entries: null, timer: 0 };
function recordChange(ch){
  state.changeLog.push({ time: Date.now(), author: state.collab ? (collabName() || T('ゲスト')) : T('あなた'), change: ch });
  if (state.changeLog.length > 1000) state.changeLog.splice(0, state.changeLog.length - 1000);
  histChanged();
}
const histShown = () => !$('#paneHistory').hidden;
function histChanged(){ if (histShown()){ clearTimeout(hist.timer); hist.timer = setTimeout(histRefresh, 120); } }
function histRefresh(){
  // タイムマシンでは過去の時点まで切り出すので、ホストが覚えている分（1000 件）を全部もらう
  if (state.collab && collab.connected) collab.ws.send(JSON.stringify({ type: 'history', limit: tm.on ? 1000 : 300 }));
  histRender();
}
const mkEl = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const clip = (s, n = 40) => { s = String(s ?? '').replace(/\n/g, '⏎'); return s.length > n ? s.slice(0, n) + '…' : s; };
function histTime(ms){
  if (!ms) return '';
  const d = new Date(ms), p2 = (n) => String(n).padStart(2, '0');
  const hm = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return d.toDateString() === new Date().toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
// 1つの op を「追加 「本文」 01:23.45」のような1行にする
function histOpLine(op){
  const line = mkEl('div', 'hist-op');
  const kind = { add: T('追加'), update: T('変更'), delete: T('削除') }[op.type];
  line.append(mkEl('span', 'k ' + op.type, kind));
  if (op.type === 'add' || op.type === 'delete'){
    const f = op.type === 'add' ? op.after : op.before;
    line.append(T`「${clip(f.text)}」 ${fmtPrecise(f.t ?? 0)}` + (f.cmd ? ` [${f.cmd}]` : ''));
    return line;
  }
  const name = op.after.text ?? op.before.text ?? store.get(op.id)?.text;
  line.append(name != null ? T`「${clip(name, 24)}」 ` : '');
  const label = { t: T('時刻'), cmd: T('コマンド'), text: T('本文') };
  const show = (k, v) => k === 't' ? fmtPrecise(v ?? 0) : k === 'text' ? T`「${clip(v, 24)}」` : (v || T('（なし）'));
  for (const k of ['t', 'cmd', 'text']){
    if (!(k in op.after)) continue;
    line.append(` ${label[k]} `);
    if (k in op.before) line.append(mkEl('span', 'from', show(k, op.before[k])), ' → ');
    line.append(show(k, op.after[k]));
  }
  return line;
}
function histRender(){
  const list = $('#histList');
  if (!list || !histShown()) return;
  let items, note, cur = null;
  if (state.collab){
    const me = collabName() || T('ゲスト');
    items = [...collab.outbox.slice().reverse().map(e => ({ change: e.change, author: me, time: e.seq, pending: true })), ...(hist.entries || [])];
    note = collab.connected ? T('ホストに記録された全員の変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。')
      : T('ホストにつながっていないため、前回取得した履歴を表示しています。');
    // タイムマシン: 見ている時点までの変更だけにする（その時点のコミットの変更は印を付ける）
    if (tm.on && tm.list.length){
      const r = tmHistory(items);
      items = r.items; cur = r.cur;
      note = tmIsNow(tm.idx) ? T('タイムマシン: 今までの変更です（新しい順）。印は最新のコミットとまだコミットしていない変更です。')
        : T`タイムマシン: ${tmDate(tm.list[tm.idx].time)} の時点までの変更です（新しい順）。印はこの時点のコミットの変更です。`
          + (r.older ? T(' それより前はホストの最近の記録に無いので、git のコミットの一覧で出します（「見る」でその時点へ）。') : '');
    }
  } else {
    items = state.changeLog.slice().reverse();
    note = T('この画面を開いてからの変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。komenagare でホストすると全員の変更が記録されます。');
  }
  $('#histNote').textContent = note;
  $('#histCount').textContent = items.length ? T`${items.length}件` : '';
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 300)){
    // タイムマシン: ホストの記録より前は git のコミット（説明だけ）で出す
    if (it.commit){
      const box = mkEl('div', 'hist-item commit' + (it.index === tm.idx ? ' tm-cur' : ''));
      const meta = mkEl('div', 'hist-meta');
      meta.append(mkEl('span', null, histTime(it.commit.time)), mkEl('b', null, it.commit.author), mkEl('span', null, it.commit.id.slice(0, 7)), mkEl('span', 'spacer'));
      if (it.index !== tm.idx){
        const go = mkEl('button', null, T('見る'));
        go.title = T('タイムマシンでこの時点を見る');
        go.onclick = () => tmSelect(it.index);
        meta.append(go);
      }
      box.append(meta, mkEl('div', 'hist-op', it.commit.subject));
      frag.append(box);
      continue;
    }
    const box = mkEl('div', 'hist-item' + (it.pending ? ' pending' : '') + (cur && cur.has(it) ? ' tm-cur' : ''));
    const meta = mkEl('div', 'hist-meta');
    meta.append(mkEl('span', null, histTime(it.time)), mkEl('b', null, it.author || ''));
    if (it.rev) meta.append(mkEl('span', null, '#' + it.rev));
    if (it.pending) meta.append(mkEl('span', null, T('未送信')));
    meta.append(mkEl('span', 'spacer'));
    const target = it.change.ops.map(op => shown().get(op.id)).find(Boolean);
    if (target){
      const go = mkEl('button', null, T('移動'));
      go.title = T('このコメントの時刻へ移動して選ぶ');
      go.onclick = () => { seekTo(target.t); TL.sel = new Set([target.id]); tlEnsureVisible(target); tlSelChanged(); };
      meta.append(go);
    }
    if (!it.pending && !tm.on){
      const undo = mkEl('button', null, T('取り消す'));
      undo.title = T('この変更を打ち消す変更を加える');
      undo.onclick = () => { if (revertChange(it.change)) toast(T('変更を取り消しました')); };
      meta.append(undo);
    }
    box.append(meta);
    for (const op of it.change.ops.slice(0, 5)) box.append(histOpLine(op));
    if (it.change.ops.length > 5) box.append(mkEl('div', 'hist-op muted', T`ほか ${it.change.ops.length - 5} 件`));
    frag.append(box);
  }
  if (!items.length) frag.append(mkEl('p', 'muted hist-note', T('まだ変更はありません。')));
  list.replaceChildren(frag);
}

/* ---------- ほかの参加者から届いたものの確かめ ---------- */
// presence と共有された衝突は、ホストが形を確かめずに中継する（ほかの参加者が書いたまま）。
// 形の違う値で描画や再生が止まらないよう、使う項目だけを型を確かめて取り出す
const finiteOr = (v, d = null) => typeof v === 'number' && isFinite(v) ? v : d;
// タイムラインの段（{ g: 段の組, l: 組の中の位置 }）
const cleanLane = (y) => y && typeof y === 'object' && Number.isInteger(y.g) && y.g >= 0 && y.g < TL_GROUPS.length
  ? { g: y.g, l: clamp(finiteOr(y.l, 0), 0, 10000) } : null;
function cleanPresence(s){
  if (!s || typeof s !== 'object') return {};
  const v = s.view, c = s.cur, vd = s.video;
  const t = finiteOr(s.t);
  return {
    t: t == null ? undefined : Math.max(0, t),
    playing: s.playing === true,
    // video.playbackRate に入れられる範囲（外れると例外になる）
    rate: clamp(finiteOr(s.rate, 1), 0.0625, 16),
    sel: Array.isArray(s.sel) ? s.sel.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 200) : [],
    view: v && typeof v === 'object' && finiteOr(v.t0) != null && finiteOr(v.span, 0) > 0
      ? { t0: v.t0, span: v.span, y: cleanLane(v.y) } : null,
    cur: !c || typeof c !== 'object' ? null
      : c.a === 'st' ? (finiteOr(c.x) != null && finiteOr(c.y) != null ? { a: 'st', x: clamp(c.x, 0, 1), y: clamp(c.y, 0, 1) } : null)
      : c.a === 'tl' && finiteOr(c.t) != null ? { a: 'tl', t: c.t, y: cleanLane(c.y) } : null,
    // 動画の長さだけを取り出す（古い版が送ってくるファイル名は使わない）
    video: vd && typeof vd === 'object' && finiteOr(vd.d, 0) > 0 ? { d: vd.d } : null,
    // いましていることの短い説明（自動の参加者が付ける。komenagare mcp）
    note: typeof s.note === 'string' ? clip(s.note.trim(), 60) : '',
  };
}
// 「ここ見て」（{ t: 秒, sel: [コメントの id] }。形が違えば null）
function cleanCall(s){
  if (!s || typeof s !== 'object' || finiteOr(s.t) == null) return null;
  return { t: Math.max(0, s.t), sel: Array.isArray(s.sel) ? s.sel.filter(x => typeof x === 'string' && x.length <= 64).slice(0, 200) : [] };
}
// 衝突の記録の時刻・コマンド・本文（形が違えば null）
const cleanConflictFields = (v) => v && typeof v === 'object' && finiteOr(v.t) != null ? normFields(v.t, v.cmd, v.text) : null;
function cleanConflict(r){
  if (!r || typeof r !== 'object' || typeof r.key !== 'string' || typeof r.id !== 'string' || !['add', 'update', 'delete'].includes(r.opType)) return null;
  const mine = cleanConflictFields(r.mine);
  if (r.opType !== 'delete' && !mine) return null;
  return {
    key: r.key, id: r.id, reason: String(r.reason ?? ''), opType: r.opType,
    base: cleanConflictFields(r.base), mine, theirs: cleanConflictFields(r.theirs),
    author: String(r.author ?? ''), client: String(r.client ?? ''), at: finiteOr(r.at, 0),
  };
}

/* ---------- 衝突の解決（共同編集） ---------- */
const CONFLICT_WHY = {
  'modified:update': T('ほかの人が先に同じ項目を変更していました'),
  'deleted:update': T('ほかの人が先に削除していました'),
  'modified:delete': T('あなたは削除しようとしましたが、ほかの人が先に変更していました'),
  'exists:add': T('同じ id のコメントが既にありました'),
};
const allConflicts = () => [...collab.conflicts, ...collab.shared];
// 自分の変更か（ホストに預けたものも、同じブラウザから出したものなら自分の分）
const conflictOwn = (rec) => !rec.author || (!!collab.myClient && rec.client === collab.myClient);
// 今の内容（ホストに預けた衝突はあとから変わっていることがあるので、いつも今の値を見る）
const conflictNow = (rec) => { const c = store.get(rec.id); return c ? pickFields(c) : null; };
function conflictActions(rec){
  const own = conflictOwn(rec), who = own ? T('あなた') : rec.author;
  if (rec.opType === 'update' && conflictNow(rec)) return [['mine', T`${who}の変更にする`], ['keep', own ? T('相手のままにする') : T('今のままにする')], ['both', T('両方残す')]];
  if (rec.opType === 'update') return [['mine', T`${who}の内容で復活させる`], ['keep', T('削除のままにする')]];
  if (rec.opType === 'delete') return [['mine', T('それでも削除する')], ['keep', T('残す')]];
  return [['both', T('新しいコメントとして追加する')], ['keep', T('追加しない')]];
}
// 衝突を一覧から外す（ホストに預けたものは全員の一覧から外す）
function conflictDrop(recs){
  const shared = recs.filter(r => collab.shared.includes(r)).map(r => r.key);
  if (shared.length && collab.connected) collab.ws.send(JSON.stringify({ type: 'conflict_done', keys: shared }));
  collab.conflicts = collab.conflicts.filter(r => !recs.includes(r));
  collab.shared = collab.shared.filter(r => !recs.includes(r));
  conflictsChanged();
}
// 「あとで」にした衝突をホストに預けて、ほかの参加者にも見せる（つながっていなければ、つながったときに送る）
function collabShareConflicts(){
  const recs = collab.conflicts.filter(r => r.share);
  if (!recs.length || !collab.connected) return;
  // 1通が大きくなりすぎないよう、100 件ずつ送る
  const list = recs.map(({ share, ...r }) => r);
  for (let i = 0; i < list.length; i += 100) collab.ws.send(JSON.stringify({ type: 'conflict_add', conflicts: list.slice(i, i + 100) }));
}
function conflictLater(){
  if (!state.collab || !collab.conflicts.some(r => !r.share)) return;
  for (const r of collab.conflicts) r.share = true;
  conflictsChanged();
  collabShareConflicts();
}
function conflictResolve(rec, action){
  const cur = store.get(rec.id);
  let ops = [];
  if (action === 'mine'){
    if (rec.opType === 'delete'){ if (cur) ops = [deleteOp(cur)]; }
    else if (cur){
      const r = updateOps([{ c: cur, t: rec.mine.t, cmd: rec.mine.cmd, text: rec.mine.text }]);
      if (r.failed){ toast(T('同じ時刻・内容のコメントが既にあるため変更できません'), { type:'error' }); return; }
      ops = r.ops;
    } else ops = [{ type:'add', id: rec.id, after: normFields(rec.mine.t, rec.mine.cmd, rec.mine.text), mine: true }];
  } else if (action === 'both'){
    const c = makeComment(rec.mine.t, rec.mine.cmd, rec.mine.text, true);
    if (store.hasKey(c.key)){ toast(T('同じ時刻・内容のコメントが既にあります'), { type:'error' }); return; }
    ops = [addOp(c)];
  }
  if (ops.length) commitOps(ops);
  conflictDrop([rec]);
}
function conflictsChanged(){
  if (collab.owner) collabTx('meta', 'readwrite', s => s.put(collab.conflicts, 'conflicts:' + collab.owner)).catch(e => console.warn(e));
  const n = allConflicts().length;
  for (const b of [$('#conflictBtn'), $('#histConflicts')]){ b.hidden = !n; b.textContent = T`⚠ 衝突 ${n}`; }
  if ($('#conflictDlg').open){ if (n) conflictRender(); else $('#conflictDlg').close(); }
}
function conflictRender(){
  const label = { t: T('時刻'), cmd: T('コマンド'), text: T('本文') };
  const show = (k, v) => k === 't' ? fmtPrecise(v ?? 0) : (v || T('（なし）'));
  const frag = document.createDocumentFragment();
  for (const rec of allConflicts()){
    const box = mkEl('div', 'cf-item');
    const own = conflictOwn(rec), now = conflictNow(rec);
    const base = now || rec.mine || {};
    box.append(mkEl('div', 'cf-title', T`「${clip(base.text, 60)}」 ${fmtPrecise(base.t ?? 0)}`));
    const why = CONFLICT_WHY[`${rec.reason}:${rec.opType}`] || T('ほかの人の変更と重なりました');
    box.append(mkEl('div', 'cf-why', own ? why : T`${rec.author} の変更：${why.replace(/^あなたは/, '')}`));
    if (rec.author || rec.share) box.append(mkEl('div', 'cf-shared', own ? T('ほかの参加者にも表示しています') : T`${rec.author} が「あとで」にしたものです。誰が選んでもかまいません`));
    // 3-way：元の値（共通の祖先）・あなた・相手（今の内容）を並べ、どれかが違う項目だけ出す
    const table = mkEl('table', 'cf-table');
    const cols = [];
    if (rec.base) cols.push([T('元の値'), rec.base, T('（なし）')]);
    cols.push([own ? T('あなた') : rec.author, rec.mine, T('（削除）')], [own ? T('相手（今の内容）') : T('今の内容'), now, T('（削除済み）')]);
    const head = mkEl('tr'); head.append(mkEl('th'), ...cols.map(([name]) => mkEl('th', null, name))); table.append(head);
    const vals = cols.map(([, v]) => v).filter(Boolean);
    let keys = COMMENT_FIELDS.filter(k => vals.some(v => v[k] !== vals[0][k]));
    if (!keys.length) keys = ['text'];
    for (const k of keys){
      const tr = mkEl('tr');
      tr.append(mkEl('th', null, label[k]), ...cols.map(([, v, none]) => {
        const td = mkEl('td', null, v ? show(k, v[k]) : none);
        // 元の値から変わったところを目立たせる
        if (rec.base && v && v !== rec.base && v[k] !== rec.base[k]) td.className = 'cf-changed';
        return td;
      }));
      table.append(tr);
    }
    box.append(table);
    const acts = mkEl('div', 'cf-actions');
    for (const [a, text] of conflictActions(rec)){
      const b = mkEl('button', a === 'mine' ? 'primary' : null, text);
      b.onclick = () => conflictResolve(rec, a);
      acts.append(b);
    }
    box.append(acts);
    frag.append(box);
  }
  $('#conflictList').replaceChildren(frag);
}
function conflictOpen(){ if (!allConflicts().length) return; conflictRender(); if (!$('#conflictDlg').open) $('#conflictDlg').showModal(); }
$('#conflictBtn').onclick = conflictOpen;
$('#histConflicts').onclick = conflictOpen;
$('#conflictLater').onclick = () => $('#conflictDlg').close();
// 閉じたら（「あとで」・Esc）残っている衝突をほかの参加者にも見せる
$('#conflictDlg').addEventListener('close', conflictLater);
$('#conflictKeepAll').onclick = () => conflictDrop(allConflicts());

/* =====================================================================
   ほかの参加者の様子（共同編集）
   - 再生位置・選択中のコメント・タイムラインの表示範囲・マウスカーソルをホスト経由で配り合い、
     シークバー・タイムライン・リスト・プレビューに相手の色で薄く出す
   - 参加者の一覧で「追いかける」を選ぶと、その人の再生位置とタイムラインの表示に合わせ続ける
     （自分で操作したらやめる）
   ===================================================================== */
const PRESENCE_MS = 100; // 送る間隔の最短
// 人ごとの色（番号はホストが今いる人の中で重ならないように決める）
const PEER_HUES = [140, 205, 25, 290, 50, 330, 175, 0, 245, 90];
const peerColor = (p, a = 1) => `hsla(${PEER_HUES[(p.color ?? hashStr(String(p.client))) % PEER_HUES.length]}, 85%, 62%, ${a})`;
const peerOf = (id) => collab.peerList.find(p => p.id === id);
// カーソルに添える名前（一時停止中の自動の参加者には ‖ を付ける）
const peerLabel = (p, n = 40) => (p.agent && p.held ? '‖ ' : '') + clip(p.name, n);
// ほかの人の今の再生位置（再生中なら、届いてからの時間だけ進める）
function peerTime(pr){
  const s = pr.state;
  if (typeof s.t !== 'number') return null;
  return s.playing ? s.t + (performance.now() - pr.at) / 1000 * (s.rate || 1) : s.t;
}
// ほかの人の動きをつなぐ（settings.peerSmooth。設定でオフにすると、届いた位置にすぐ移す）。
// presence は 100ms ごと（AI などはもっとまばら）にしか届かないので、画面に出す位置（pr.sm）を毎フレーム、届いた位置へ寄せる。
// 追いかける（followApply）などの処理は、届いた値（pr.state）をそのまま使う
const PEER_EASE_MS = 110;
const peerShownTime = (pr) => pr.sm && pr.sm.t != null ? pr.sm.t : peerTime(pr);
// 動いている途中のものがあれば true
function peerEase(now){
  let moving = false;
  for (const pr of collab.presence.values()){
    const sm = pr.sm || (pr.sm = { at: now, t: null, cur: null });
    const k = settings.peerSmooth === false ? 1 : 1 - Math.exp(-Math.min(100, now - sm.at) / PEER_EASE_MS);
    sm.at = now;
    const t = peerTime(pr);
    if (t == null || sm.t == null || k === 1) sm.t = t;
    else {
      sm.t += (t - sm.t) * k;
      if (Math.abs(t - sm.t) < 0.004) sm.t = t; else moving = true;
    }
    const cur = pr.state.cur;
    // タイムラインのカーソルは、時刻と（自分の段の高さでの）縦位置で持つ
    const to = !cur ? null : cur.a === 'st' ? { a: 'st', x: cur.x, y: cur.y } : { a: 'tl', x: cur.t, y: tlLaneToY(cur.y) };
    const c = sm.cur;
    if (!to || !c || c.a !== to.a || k === 1) sm.cur = to;
    else {
      c.x += (to.x - c.x) * k; c.y += (to.y - c.y) * k;
      const ex = to.a === 'st' ? 0.0004 : 0.3 / (TL.pps || 1), ey = to.a === 'st' ? 0.0004 : 0.3;
      if (Math.abs(to.x - c.x) < ex && Math.abs(to.y - c.y) < ey) sm.cur = to; else moving = true;
    }
  }
  return moving;
}
// タイムラインの縦位置は、段の高さが人によって違う（タッチ端末は高い）ので「グループと段」で表す
function tlYToLane(cy){
  for (let gi = 0; gi < TL.groups.length; gi++){
    const G = TL.groups[gi];
    if (cy < G.y + G.n * laneH() + TL_GAP || gi === TL.groups.length - 1) return { g: gi, l: +((cy - G.y) / laneH()).toFixed(3) };
  }
  return { g: 0, l: 0 };
}
function tlLaneToY(p){ const G = p && TL.groups[p.g]; return G ? G.y + p.l * laneH() : 0; }

function presenceState(){
  return {
    t: +(video.currentTime || 0).toFixed(3), playing: state.videoLoaded && !video.paused && !video.ended, rate: video.playbackRate,
    sel: [...TL.sel].slice(0, 200),
    view: TL.inited && tlShown() ? { t0: +TL.t0.toFixed(3), span: +((TL.W - TL_HEAD) / TL.pps).toFixed(3), y: tlYToLane(TL.scrollY) } : null,
    cur: presence.cursor,
    // 開いている動画の長さ（ほかの人と同じ動画かを確かめる。ファイル名は手元の情報なので送らない）
    video: state.videoLoaded && isFinite(video.duration) ? { d: +video.duration.toFixed(3) } : null,
  };
}
function presenceDirty(){
  if (!presence.ready || !collab.connected || presence.timer) return;
  presence.timer = setTimeout(presenceSend, Math.max(0, PRESENCE_MS - (performance.now() - presence.last)));
}
function presenceSend(){
  presence.timer = 0;
  if (!collab.connected) return;
  const json = JSON.stringify(presenceState());
  if (json === presence.sent) return;
  presence.sent = json; presence.last = performance.now();
  collab.ws.send(`{"type":"presence","state":${json}}`);
}
for (const ev of ['play', 'pause', 'seeked', 'ratechange']) video.addEventListener(ev, presenceDirty);
setInterval(() => { if (!video.paused) presenceDirty(); }, 1000);
function presenceCursor(cur){ presence.cursor = cur; presenceDirty(); }
TL.main.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const { x, y } = tlLocal(e);
  presenceCursor(x > TL_HEAD && y > TL_RULER ? { a:'tl', t: +xt(x).toFixed(3), y: tlYToLane(y - TL_RULER + TL.scrollY) } : null);
});
stage.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
  presenceCursor(x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { a:'st', x: +x.toFixed(4), y: +y.toFixed(4) } : null);
});
for (const el of [TL.main, stage]) el.addEventListener('pointerleave', () => presenceCursor(null));

/* ---------- ほかの人の様子を出す ---------- */
function presenceChanged(){ TL.dirty = true; presence.dirty = true; }
function presenceFrame(){
  if (!state.collab) return;
  let moving = false;
  for (const pr of collab.presence.values()) if (pr.state.playing) moving = true;
  if (peerEase(performance.now())) moving = true;
  if (moving) TL.dirty = true;
  const changed = presence.dirty;
  if (changed || moving){ presence.dirty = false; seekMarks(); stageCursors(); }
  if (changed) listMarkPeers();
  if ($('#peersDlg').open && (changed || performance.now() - presence.dlgAt > 300)) peersUpdate();
}
// box の子要素を n 個にそろえて返す
function syncEls(box, n, make){
  while (box.children.length < n) box.append(make());
  while (box.children.length > n) box.lastChild.remove();
  return [...box.children];
}
function seekMarks(){
  const d = video.duration, items = [];
  if (isFinite(d) && d > 0) for (const [id, pr] of collab.presence){
    const p = peerOf(id), t = peerShownTime(pr);
    if (p && t != null) items.push([p, t]);
  }
  const els = syncEls($('#peerMarks'), items.length, () => mkEl('div', 'peer-mark'));
  items.forEach(([p, t], i) => {
    els[i].style.left = (clamp(t / d, 0, 1) * 100) + '%';
    els[i].style.background = peerColor(p);
    els[i].title = `${p.name} ${fmt(t)}`;
  });
}
function stageCursors(){
  const items = [];
  for (const [id, pr] of collab.presence){
    const p = peerOf(id), cur = pr.sm ? pr.sm.cur : pr.state.cur;
    if (p && cur && cur.a === 'st') items.push([p, cur]);
  }
  const els = syncEls($('#peerCursors'), items.length, () => {
    const el = mkEl('div', 'peer-cursor');
    el.innerHTML = '<svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1v14l4-4h7z" fill="currentColor" stroke="rgba(0,0,0,.6)"/></svg><span></span>';
    return el;
  });
  items.forEach(([p, cur], i) => {
    const el = els[i];
    el.style.transform = `translate(${(canvas.offsetLeft + cur.x * canvas.offsetWidth).toFixed(1)}px,${(canvas.offsetTop + cur.y * canvas.offsetHeight).toFixed(1)}px)`;
    el.style.setProperty('--peer', peerColor(p));
    el.lastChild.textContent = peerLabel(p);
  });
}
function listMarkPeers(){
  const sel = new Map();
  if (state.collab){
    for (const [id, pr] of collab.presence){
      const p = peerOf(id);
      if (!p) continue;
      for (const cid of pr.state.sel || []) sel.set(cid, peerColor(p));
    }
  }
  listPeerSel = sel;
  // 作ってある行だけ書き換える（見えていない行は、作るときに付ける）
  for (const [i, row] of listShown){
    const color = sel.get(listItems[i]?.id);
    row.classList.toggle('peer-sel', !!color);
    if (color) row.style.setProperty('--peer', color);
  }
}
// タイムライン：ほかの人が選んでいるコメントを、その人の色の点線で囲む
function tlDrawPeerSel(g, t1){
  if (!state.collab || !collab.presence.size) return;
  const lh = laneH();
  g.save(); g.lineWidth = 2; g.setLineDash([5, 3]);
  for (const [id, pr] of collab.presence){
    const p = peerOf(id);
    if (!p || !pr.state.sel || !pr.state.sel.length) continue;
    g.strokeStyle = peerColor(p, 0.95); g.fillStyle = peerColor(p, 0.18);
    for (const cid of pr.state.sel){
      const c = shown().get(cid), pos = c && TL.laneOf.get(cid);
      if (!pos) continue;
      const sp = spanOf(c);
      if (sp.e < TL.t0 || sp.s > t1) continue;
      const y = laneTop(pos.g, pos.lane), x0 = tx(sp.s), w = Math.max(3, tx(sp.e) - x0);
      rr(g, x0 + 0.5, y + 2, w - 1, lh - 4, 4); g.fill();
      rr(g, x0 - 0.5, y + 1, w + 1, lh - 2, 5); g.stroke();
    }
  }
  g.restore();
}
// タイムライン：ほかの人の再生位置とマウスカーソル
function tlDrawPeers(g){
  if (!state.collab || !collab.presence.size) return;
  const W = TL.W, H = TL.H;
  g.save(); g.beginPath(); g.rect(TL_HEAD, 0, W - TL_HEAD, H); g.clip();
  g.font = '600 10px system-ui,sans-serif'; g.textAlign = 'left'; g.textBaseline = 'middle';
  for (const [id, pr] of collab.presence){
    const p = peerOf(id);
    if (!p) continue;
    const t = peerShownTime(pr);
    if (t != null){
      const x = tx(t);
      if (x >= TL_HEAD - 5 && x <= W + 5){
        g.fillStyle = peerColor(p, 0.5); g.fillRect(Math.round(x) - 0.5, TL_RULER, 1.5, H);
        g.fillStyle = peerColor(p, 0.9);
        g.beginPath(); g.moveTo(x - 4, TL_RULER - 9); g.lineTo(x + 4, TL_RULER - 9); g.lineTo(x, TL_RULER - 1); g.closePath(); g.fill();
      }
    }
    const cur = pr.sm ? pr.sm.cur : pr.state.cur && { a: pr.state.cur.a, x: pr.state.cur.t, y: tlLaneToY(pr.state.cur.y) };
    if (cur && cur.a === 'tl'){
      const x = tx(cur.x), y = TL_RULER + cur.y - TL.scrollY;
      if (x >= TL_HEAD && x <= W && y >= TL_RULER && y <= H) tlDrawCursor(g, x, y, p);
    }
  }
  g.restore();
}
// 全体表示：ほかの人の再生位置（自分の再生位置より下に、その人の色で）
function tlDrawOverviewPeers(g, H){
  if (!state.collab || !collab.presence.size) return;
  for (const [id, pr] of collab.presence){
    const p = peerOf(id), t = p && peerShownTime(pr);
    if (t == null) continue;
    const x = ovX(t);
    g.fillStyle = peerColor(p, 0.9); g.fillRect(x - 1, 0, 2, H);
    g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5); g.closePath(); g.fill();
  }
}
function tlDrawCursor(g, x, y, p){
  g.fillStyle = peerColor(p); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 14); g.lineTo(x + 4, y + 10); g.lineTo(x + 10, y + 10); g.closePath(); g.fill(); g.stroke();
  const label = peerLabel(p, 12), w = g.measureText(label).width + 8;
  g.fillStyle = peerColor(p, 0.9); rr(g, x + 8, y + 12, w, 14, 3); g.fill();
  g.fillStyle = '#111'; g.fillText(label, x + 12, y + 19.5);
}

/* ---------- 参加者の一覧と追いかける ---------- */
// p は参加者（自動の参加者なら、止めた人と、いましていることも出す）
function presenceText(s, t = s.t, p = null){
  const held = p && p.agent && p.held ? T`一時停止中（${clip(p.held, 20)}さんが止めました）` : '';
  if (typeof t !== 'number') return held || '—';
  const parts = [(s.playing ? T('再生中 ') : p && p.agent ? '' : T('停止中 ')) + fmt(t)];
  if (held) parts.unshift(held);
  else if (s.note) parts.push(s.note);
  if (s.sel && s.sel.length) parts.push(T`${s.sel.length} 件選択中`);
  if (!s.video){ if (!(p && p.agent)) parts.push(T('動画を開いていません')); }
  else if (videoDiffers(s.video)) parts.push(T`⚠ 動画の長さが違います（${fmtPrecise(s.video.d)}）`);
  return parts.join(T('　'));
}
function peersRender(){
  const frag = document.createDocumentFragment();
  presence.dlgRows.clear();
  if (!collab.connected) frag.append(mkEl('p', 'muted', T('ホストにつながっていません')));
  for (const p of collab.peerList){
    const me = p.id === collab.me, on = collab.follow === p.id;
    const row = mkEl('div', 'peer-row' + (on ? ' on' : ''));
    row.style.setProperty('--peer', peerColor(p));
    const info = mkEl('div', 'peer-info'), st = mkEl('div', 'peer-state');
    const nm = mkEl('div', 'peer-name', p.name + (me ? T('（あなた）') : collab.myClient && p.client === collab.myClient ? T('（あなた・別のタブ）') : ''));
    // 自動の参加者（AI など。komenagare mcp）には印を付け、管理者は一時停止・再開できる（ホストが確かめ、止めている間の変更を断る）
    if (p.agent) nm.append(mkEl('span', 'peer-tag', 'AI'));
    info.append(nm, st);
    row.append(mkEl('span', 'peer-dot'), info);
    if (p.agent && !me && collab.admin){
      const h = mkEl('button', p.held ? 'primary' : null, p.held ? T('再開') : T('一時停止'));
      h.title = p.held ? T('この参加者の書き込みを再開します') : T('この参加者の書き込みを止めます（再開するまで、コメントを変えられなくなります）');
      h.onclick = () => { if (collab.connected) collab.ws.send(JSON.stringify({ type: 'hold', id: p.id, on: !p.held })); };
      row.append(h);
    }
    if (!me){
      const b = mkEl('button', on ? 'primary' : null, on ? T('追いかけるのをやめる') : T('追いかける'));
      b.onclick = () => { if (on) collabUnfollow(); else { collabFollow(p.id); $('#peersDlg').close(); } };
      row.append(b);
    }
    presence.dlgRows.set(p.id, st);
    frag.append(row);
  }
  $('#peersList').replaceChildren(frag);
  peersUpdate();
}
// 一覧の再生位置などだけを書き換える（ボタンは作り直さない）
function peersUpdate(){
  presence.dlgAt = performance.now();
  for (const [id, el] of presence.dlgRows){
    const pr = collab.presence.get(id);
    el.textContent = id === collab.me ? presenceText(presenceState()) : pr ? presenceText(pr.state, peerTime(pr), peerOf(id)) : presenceText({}, null, peerOf(id));
  }
}
function peersOpen(){ peersRender(); if (!$('#peersDlg').open) $('#peersDlg').showModal(); }
$('#peersClose').onclick = () => $('#peersDlg').close();

// 追いかけている人か自分の接続が切れてから、つなぎ直してくるのを待つ時間
const FOLLOW_WAIT_MS = 20000;
const following = () => collab.follow != null || collab.followClient != null;
function collabFollow(id){
  if (id == null || id === collab.me) return collabUnfollow();
  const p = peerOf(id);
  clearTimeout(collab.followWait);
  collab.follow = id; collab.followClient = p?.client || null; collab.followName = p?.name || '';
  followUI();
  followApply();
}
function collabUnfollow(msg){
  if (!following()) return;
  clearTimeout(collab.followWait);
  collab.follow = null; collab.followClient = null;
  followUI();
  if (msg) toast(msg, { timeout: 2500 });
}
// 追いかけている人（か自分）の接続が切れた。しばらくは、同じブラウザでつなぎ直してくるのを待つ
function followLost(){
  if (collab.follow == null) return;
  collab.follow = null;
  if (!collab.followClient) return collabUnfollow(T('追いかけていた人が抜けました'));
  clearTimeout(collab.followWait);
  collab.followWait = setTimeout(() => collabUnfollow(T('追いかけていた人が抜けました')), FOLLOW_WAIT_MS);
  followUI();
}
// 追いかけていた人（のブラウザ）がまた一覧にいれば、その接続を追いかける
function followRebind(){
  if (collab.follow != null || !collab.followClient) return;
  const p = collab.peerList.find(p => p.client === collab.followClient && p.id !== collab.me);
  if (!p) return;
  clearTimeout(collab.followWait);
  collab.follow = p.id; collab.followName = p.name;
  followUI();
  followApply();
}
function followUI(){
  const p = collab.follow != null ? peerOf(collab.follow) : null, waiting = !p && collab.followClient != null;
  $('#followBar').hidden = !p && !waiting;
  $('#player').classList.toggle('following', !!p || waiting);
  if (p) $('#player').style.setProperty('--peer', peerColor(p));
  $('#followName').textContent = p ? p.name : collab.followName;
  $('#followWaiting').hidden = !waiting;
  if ($('#peersDlg').open) peersRender();
}
// 追いかけている人の再生位置・速さ・タイムラインの表示に合わせる（その人の様子が届くたび）
function followApply(){
  const pr = collab.presence.get(collab.follow);
  if (!pr) return;
  const s = pr.state;
  if (state.videoLoaded && typeof s.t === 'number'){
    if (s.rate && video.playbackRate !== s.rate){ video.playbackRate = s.rate; $('#rate').value = String(s.rate); }
    const playing = !video.paused && !video.ended;
    if (!!s.playing !== playing){ if (s.playing) video.play().catch(() => {}); else video.pause(); }
    const t = peerTime(pr);
    if (Math.abs(video.currentTime - t) > (s.playing ? 0.4 : 0.02)) seekTo(t);
  }
  if (s.view && tlShown()){
    TL.pps = (TL.W - TL_HEAD) / Math.max(0.01, s.view.span);
    // 再生中の横位置は、自分の再生位置への追従（⇥ 追従）に任せる（届く間隔ごとにがたつかないように）
    if (!(s.playing && TL.follow)) TL.t0 = s.view.t0;
    TL.scrollY = tlLaneToY(s.view.y);
    tlClampView();
  }
}
$('#followStop').onclick = (e) => { e.stopPropagation(); collabUnfollow(); };
for (const ev of ['pointerdown', 'click', 'dblclick']) $('#followBar').addEventListener(ev, (e) => e.stopPropagation());
// 自分で操作したら追いかけるのをやめる
for (const el of [TL.main, TL.ovBox, tlVbar, seekEl, stage, list, $('#btnPlay'), $('#rate'), $('#tlZoom'), $('#tlZoomIn'), $('#tlZoomOut'), $('#tlFit')]){
  el.addEventListener('pointerdown', () => collabUnfollow(), true);
}
for (const el of [TL.main, TL.ovBox]) el.addEventListener('wheel', () => collabUnfollow(), { capture: true, passive: true });
document.addEventListener('keydown', (e) => {
  if (!following() || e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
  collabUnfollow();
}, true);

/* ---------- 同じ動画を開いているか ----------
   動画は各自が手元のファイルを開くので、長さを presence で配り合い、違えば知らせる
   （再エンコードや切り出しで長さが違うと、同じ時刻のコメントが違う場面に出る） */
const VIDEO_DIFF = 0.5; // これより長さが違えば別の動画とみなす（秒）
const videoWarned = new Set();
function videoDiffers(v){
  return !!(v && state.videoLoaded && isFinite(video.duration) && Math.abs(v.d - video.duration) > VIDEO_DIFF);
}
function videoCheckPeer(id, pr){
  const p = peerOf(id), v = pr.state.video;
  if (!p || !videoDiffers(v) || (collab.myClient && p.client === collab.myClient)) return;
  const key = `${p.client}|${v.d}|${video.duration}`;
  if (videoWarned.has(key)) return;
  videoWarned.add(key);
  const name = clip(p.name, 20);
  toast(T`${name}さんの動画と長さが違います（${name}さん: ${fmtPrecise(v.d)}、あなた: ${fmtPrecise(video.duration)}）。同じ動画ファイルか確かめてください（違うと、コメントの出る場面がずれます）`, { type:'error', timeout:15000 });
}
function videoCheck(){
  if (!state.collab) return;
  for (const [id, pr] of collab.presence) videoCheckPeer(id, pr);
  if ($('#peersDlg').open) peersUpdate();
}

/* ---------- 入退室のお知らせ ---------- */
// 抜けたお知らせは少し待ってから出す（回線が切れてつなぎ直しただけなら出さない）
const LEAVE_WAIT_MS = 8000;
// before: 前の参加者の一覧（つないで最初の一覧なら、切れる前の一覧）。
// first: つないで最初の一覧（入った人は知らせない。切れる前にいて今いない人は、つなぎ直してくるのを待つ）
function peersAnnounce(before, after, first){
  const others = (list) => {
    const m = new Map();
    for (const p of list) if (p.id !== collab.me && !(collab.myClient && p.client === collab.myClient)) m.set(p.client, p.name);
    return m;
  };
  const a = others(before), b = others(after), joined = [];
  for (const [client, name] of b){
    const w = collab.leaving.get(client);
    if (w){ clearTimeout(w); collab.leaving.delete(client); continue; } // つなぎ直しただけ
    if (!first && !a.has(client)) joined.push(clip(name, 20));
  }
  for (const [client, name] of a){
    if (b.has(client) || collab.leaving.has(client)) continue;
    collab.leaving.set(client, setTimeout(() => {
      collab.leaving.delete(client);
      if (collab.connected) toast(T`${clip(name, 20)}さんが抜けました`, { timeout: 3000 });
    }, LEAVE_WAIT_MS));
  }
  if (joined.length) toast(T`${joined.join(T('、'))}さんが入りました`, { timeout: 3000 });
}

/* ---------- 「ここ見て」（ほかの人を呼ぶ） ---------- */
const CALL_GAP_MS = 2000; // ホストも 2 秒に 1 回までしか配らない
let callLast = -Infinity;
function callSend(){
  if (!collab.connected) return toast(T('ホストにつながっていません'), { type:'error' });
  if (!state.videoLoaded) return toast(T('動画を開いてから使ってください'));
  if (performance.now() - callLast < CALL_GAP_MS) return;
  if (collab.peerList.every(p => p.id === collab.me)) return toast(T('ほかに参加している人がいません'));
  callLast = performance.now();
  const t = video.currentTime || 0, sel = [...TL.sel].slice(0, 200);
  collab.ws.send(JSON.stringify({ type: 'call', state: { t: +t.toFixed(3), sel } }));
  toast(T`ほかの人に ${fmt(t)}${sel.length ? T`（コメント ${sel.length} 件）` : ''} を見てもらうよう知らせました`, { timeout: 2500 });
}
function callReceived(m){
  const c = cleanCall(m.state);
  if (!c) return;
  const p = peerOf(m.id);
  if (p && collab.myClient && p.client === collab.myClient) return; // 自分の別のタブ
  const name = clip(typeof m.name === 'string' && m.name ? m.name : p?.name || T('誰か'), 20);
  const what = fmt(c.t) + (c.sel.length ? T`（コメント ${c.sel.length} 件）` : '');
  toast(T`📣 ${name}さんが ${what} を見てほしいそうです`, { timeout: 15000, action: { label: T('見る'), fn: () => jumpTo(c.t, c.sel) } });
}
// その時刻へ移り、コメントを選ぶ（t が無ければ最初のコメントの時刻へ）
function jumpTo(t, ids = []){
  collabUnfollow();
  const cs = ids.map(id => shown().get(id)).filter(Boolean);
  if (t == null && cs.length) t = parseCmd(cs[0].cmd).pos === 'naka' ? cs[0].t - NAKA_LEAD : cs[0].t;
  if (t != null){
    seekTo(t);
    // タイムラインの見えている範囲の外なら、その時刻が見えるようにする
    const vis = (TL.W - TL_HEAD) / TL.pps;
    if (TL.inited && (t < TL.t0 || t > TL.t0 + vis)){ TL.t0 = t - vis * 0.3; tlClampView(); }
  }
  if (cs.length){ TL.sel = new Set(cs.map(c => c.id)); tlSelChanged(); tlEnsureVisible(cs[0]); listPickComments(cs, video.currentTime, true); }
  TL.dirty = true;
}

/* ---------- 位置・コメントへのリンク ----------
   #t=秒&c=コメントの id を付けた URL。電話やメッセージで送り、開いた人がその位置へ移れるように */
const link = { pending: null };
function linkUrl(){
  const t = video.currentTime || 0, one = TL.sel.size === 1 ? [...TL.sel][0] : null;
  let u;
  if (state.collab){
    // 外の人にも渡せるよう、公開 URL があればそちらにする。入るのに要るもの（プロジェクト・合言葉）だけ付ける
    u = new URL(collab.publicUrl || location.origin + location.pathname, location.href);
    u.search = '';
    if (collab.project) u.searchParams.set('p', collab.project.id);
    if (collab.auth === 'token' && collab.key) u.searchParams.set('k', collab.key);
  } else {
    u = new URL(location.href);
  }
  const h = new URLSearchParams();
  h.set('t', String(+t.toFixed(2)));
  if (one) h.set('c', one);
  u.hash = h.toString();
  return { url: u.href, t, comment: one };
}
function copyText(text){
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok ? Promise.resolve() : Promise.reject(new Error('copy'));
  };
  // http（LAN の IP アドレスなど）では navigator.clipboard が無い
  return navigator.clipboard?.writeText ? navigator.clipboard.writeText(text).catch(fallback) : fallback();
}
function linkCopy(){
  if (!state.videoLoaded) return toast(T('動画を開いてから使ってください'));
  const { url, t, comment } = linkUrl();
  copyText(url).then(
    () => toast(T`${fmt(t)}${comment ? T('のコメント') : ''}へのリンクをコピーしました（メッセージに貼って送れます）`, { timeout: 3000 }),
    () => prompt(T('このリンクをコピーしてください'), url));
}
// 開いた URL の #t= / #c= を読む（読んだら URL から外す。同じリンクをもう一度開いても動くように）
function linkParse(){
  const h = new URLSearchParams(location.hash.slice(1));
  const t = parseFloat(h.get('t')), c = h.get('c');
  if (!(isFinite(t) && t >= 0) && !c) return;
  link.pending = { t: isFinite(t) && t >= 0 ? t : null, c: c && c.length <= 64 ? c : null, told: false };
  window.history.replaceState(null, '', location.pathname + location.search);
  linkTry();
}
// 動画とコメントがそろったら移る
function linkTry(){
  const p = link.pending;
  if (!p) return;
  if (!state.videoLoaded){
    if (!p.told && p.t != null) toast(T`動画を開くと ${fmt(p.t)} に移ります`, { timeout: 5000 });
    p.told = true;
    return;
  }
  if (p.c && state.collab && !collab.synced) return; // ホストからコメントが届くのを待つ
  link.pending = null;
  if (p.c && !shown().has(p.c)) toast(T('リンクのコメントが見つかりません（消されたか、別のコメントかもしれません）'), { type:'error' });
  jumpTo(p.t, p.c ? [p.c] : []);
}
window.addEventListener('hashchange', linkParse);
$('#btnLink').onclick = linkCopy;
$('#btnCall').onclick = callSend;

/* =====================================================================
   設定UI・ショートカット・その他
   ===================================================================== */
// 設定は1つのダイアログ（#settingsDlg）にまとめる。左の見出しで項目へ移り、スクロールに合わせて今いる項目に印を付ける
const setBody = $('#setBody'), setNav = $('#setNav');
let settingsSec = 'play', settingsLock = 0;
function settingsMark(sec){
  settingsSec = sec;
  for (const b of setNav.children){
    const on = b.dataset.sec === sec;
    b.classList.toggle('on', on);
    if (on){ b.setAttribute('aria-current', 'true'); setNav.scrollLeft = Math.max(0, b.offsetLeft - 24); } else b.removeAttribute('aria-current');
  }
}
function settingsGo(sec, smooth){
  const el = setBody.querySelector(`.set-sec[data-sec="${sec}"]`);
  if (!el) return;
  settingsMark(sec);
  // 移っている間は、スクロールで印を付け替えない
  settingsLock = performance.now() + (smooth ? 800 : 150);
  setBody.scrollTo({ top: el.offsetTop, behavior: smooth ? 'auto' : 'instant' });
}
function settingsOpen(sec){
  const dlg = $('#settingsDlg');
  if (!dlg.open) dlg.showModal();
  settingsGo(sec || settingsSec, false);
}
setNav.onclick = (e) => { const b = e.target.closest('button[data-sec]'); if (b) settingsGo(b.dataset.sec, true); };
setBody.addEventListener('scroll', () => {
  if (performance.now() < settingsLock) return;
  let cur = null;
  // いちばん下まで来たら最後の項目（短くて上まで届かない）
  const end = setBody.scrollTop + setBody.clientHeight >= setBody.scrollHeight - 2;
  for (const el of setBody.querySelectorAll('.set-sec')) if (end || el.offsetTop <= setBody.scrollTop + 48) cur = el.dataset.sec;
  if (cur && cur !== settingsSec) settingsMark(cur);
}, { passive: true });
$('#btnSettings').onclick = () => settingsOpen();
$('#listSettings').onclick = () => settingsOpen('list');
$('#setClose').onclick = () => $('#settingsDlg').close();
$('#setPeerSmooth').checked = settings.peerSmooth !== false;
$('#setPeerSmooth').onchange = (e) => { settings.peerSmooth = e.target.checked; saveSettings(); };
$('#setOpacity').value = settings.opacity;
const applyLetterbox = () => { document.documentElement.style.setProperty('--letterbox', settings.letterbox); $('#setLetterbox').value = settings.letterbox; };
applyLetterbox();
$('#setLetterbox').oninput = (e) => { settings.letterbox = e.target.value; saveSettings(); applyLetterbox(); };
$('#setLetterboxReset').onclick = () => { settings.letterbox = '#000000'; saveSettings(); applyLetterbox(); };
$('#setArea').value = settings.commentArea === 'wide' ? 'wide' : 'video';
$('#setArea').onchange = (e) => { settings.commentArea = e.target.value; saveSettings(); updateStage(); };
$('#setPause').checked = settings.pauseOnInput;
$('#setBorder').checked = settings.mineBorder;
$('#setAutosave').checked = settings.autosave;
$('#setFormat').value = settings.saveFormat;
$('#setOpacity').oninput = (e) => { settings.opacity = +e.target.value; saveSettings(); state.needsDraw = true; };
$('#setPause').onchange = (e) => { settings.pauseOnInput = e.target.checked; saveSettings(); };
$('#setBorder').onchange = (e) => { settings.mineBorder = e.target.checked; saveSettings(); displayRenderer.reset(); state.needsDraw = true; };
$('#setAutosave').onchange = (e) => { settings.autosave = e.target.checked; saveSettings(); updateStatus(); };
$('#setListVirtual').checked = listVirtual();
$('#setListVirtual').onchange = (e) => { settings.listVirtual = e.target.checked; saveSettings(); listRowH = 0; renderList(); };
$('#setFormat').onchange = (e) => { settings.saveFormat = e.target.value; saveSettings(); };

$('#btnHelp').onclick = () => $('#helpDlg').showModal();
$('#helpClose').onclick = () => $('#helpDlg').close();

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); doSave({ saveAs: e.shiftKey }); return; }
  const tag = e.target.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !inField && !document.querySelector('dialog[open]')){
    const k = e.key.toLowerCase();
    if (k === 'z' || k === 'y'){ e.preventDefault(); if (k === 'y' || e.shiftKey) redo(); else undo(); return; }
  }
  // イン点・アウト点を消す（Alt＋I / O / X。Mac の Option は文字が変わるので、キーの位置で見る）
  if (e.altKey && !e.ctrlKey && !e.metaKey && !inField && !document.querySelector('dialog[open]')){
    const w = { KeyI: 'in', KeyO: 'out', KeyX: '' }[e.code];
    if (w != null){ e.preventDefault(); rangeClear(w || undefined); return; }
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (inField) return;
  if (document.querySelector('dialog[open]')) return;
  switch (e.key){
    case 'i': case 'I': e.preventDefault(); rangeSet('in'); break;
    case 'o': case 'O': e.preventDefault(); rangeSet('out'); break;
    case ' ': case 'k': case 'K': e.preventDefault(); togglePlay(); break;
    case 'ArrowLeft': e.preventDefault(); seekBy(e.shiftKey ? -1 : -5); break;
    case 'ArrowRight': e.preventDefault(); seekBy(e.shiftKey ? 1 : 5); break;
    case 'ArrowUp': e.preventDefault(); video.muted = false; video.volume = Math.min(1, video.volume + 0.05); break;
    case 'ArrowDown': e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); break;
    case 'c': case 'C': toggleComments(); break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': video.muted = !video.muted; break;
    case 'Enter': e.preventDefault(); textInput.focus(); break;
    default:
      {
        const p = presetForKey(e);
        if (p){ e.preventDefault(); usePreset(p, false); }
      }
  }
});
window.addEventListener('beforeunload', (e) => {
  // 送信待ちは IndexedDB に控えてあるので、控えられないときだけ確かめる
  if ((state.dirty && state.comments.length) || (collab.outbox.length && !collab.db)){ e.preventDefault(); e.returnValue = ''; }
});
if (document.fonts && document.fonts.ready){
  document.fonts.ready.then(() => { metricCache.clear(); displayRenderer.reset(); if (state.comments.length) relayout(); });
}

/* ---------- ロゴの印：マウスを重ねるとクリップが流れる ----------
   クリップごとに位置 u（左へ進むほど小さい。元の位置は W の倍数）と速さ v を持ち、毎フレーム動かす。
   重ねている間は v を一定の速さへなめらかに近づけ（加速）、離したら、無理なく止まれる所より先の元の位置を決めて、
   そこまではいつもの速さで流し、止まるのに要る距離まで来たら一定の割合で減速してちょうど止める
   （速さがほとんど無いときは、近い元の位置へばねで戻す）。
   どの途中で重ねたり離したりしても、今の位置と速さから続けるので飛ばない。画面の幅（24px）を出たら右から戻る */
(() => {
  const box = document.querySelector('.brand-flow'), brand = document.querySelector('.brand');
  if (!box || !brand) return;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const BOX_W = 24, SPEED = [30, 40, 24], ACCEL_TAU = 0.35, DECEL = 45, OMEGA = 6;
  const bars = [...box.children].map((el, i) => {
    const cs = getComputedStyle(el), w = parseFloat(cs.width) || 12, left = parseFloat(cs.left) || 0;
    // 左へ出きる所（-(left + w + 1)）から、右の外（BOX_W - left + 1）までで1周
    return { el, W: BOX_W + w + 2, out: left + w + 1, u: 0, v: 0, speed: SPEED[i] || 30, target: null };
  });
  let hover = false, raf = 0, last = 0;
  // 左へ出きったら、右の外から戻す（1周分ずらす。目指す位置も一緒に）
  const wrap = (b) => { while (b.u < -b.out){ b.u += b.W; if (b.target != null) b.target += b.W; } };
  const frame = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
    let moving = false;
    for (const b of bars){
      if (hover){
        b.v += (-b.speed - b.v) * (1 - Math.exp(-dt / ACCEL_TAU));
      } else {
        const d = b.u - b.target;
        // 残りの距離でちょうど止まる減速（毎フレーム計算し直すので、ずれても合う）。着いたら止める
        if (!b.spring){
          if (d <= 0.05 || b.v > -0.2 && b.braking){ b.u = b.target; b.v = 0; }
          else {
            const brake = b.v * b.v / (2 * d);
            if (b.braking || brake >= DECEL){ b.braking = true; b.v = Math.min(-0.2, b.v + brake * dt); }
            else b.v += (-b.speed - b.v) * (1 - Math.exp(-dt / ACCEL_TAU));
          }
        }
        // 離したときに速さがほとんど無かったら、ばねで近い元の位置へ
        else b.v += (OMEGA * OMEGA * (b.target - b.u) - 2 * OMEGA * b.v) * dt;
      }
      b.u += b.v * dt;
      if (!hover && b.u < b.target) b.u = b.target; // 行き過ぎない
      wrap(b);
      if (!hover && Math.abs(b.target - b.u) < 0.05 && Math.abs(b.v) < 0.5){ b.u = 0; b.v = 0; b.target = null; }
      else moving = true;
      b.el.style.transform = b.u ? `translateX(${b.u.toFixed(2)}px)` : '';
    }
    raf = moving ? requestAnimationFrame(frame) : 0;
  };
  const start = () => { if (!raf){ last = performance.now(); raf = requestAnimationFrame(frame); } };
  brand.addEventListener('pointerenter', (e) => {
    if (e.pointerType !== 'mouse' || reduce.matches) return;
    if (!box.classList.contains('live')){
      // 開いたときの流れ込みの途中なら、そこから続ける
      for (const b of bars){
        const m = new DOMMatrixReadOnly(getComputedStyle(b.el).transform);
        b.u = m.m41 || 0; b.v = 0;
        b.el.style.transform = b.u ? `translateX(${b.u}px)` : '';
      }
      box.classList.add('live');
    }
    hover = true;
    start();
  });
  brand.addEventListener('pointerleave', (e) => {
    if (!hover) return;
    hover = false;
    for (const b of bars){
      // 今の速さから無理なく（DECEL 以下の減速で）止まれる所より先の、いちばん近い元の位置（W の倍数）を目指す
      const reach = b.u - b.v * b.v / (2 * DECEL);
      b.spring = b.v > -3; b.braking = false;
      b.target = b.spring ? Math.round(b.u / b.W) * b.W : Math.floor(reach / b.W) * b.W;
    }
    start();
  });
})();

resizeCanvas();
renderList();
updateStatus();
autoGrow();
tlRelane();
renderPresets();
updateUndoUI();
tlSelChanged();
applyPanes();
// 言語（?lang= を付けて開き直す。選んだものは js/i18n.js がこのブラウザで覚える）
$('#setLang').value = I18N.lang;
$('#setLang').onchange = (e) => {
  const u = new URL(location.href);
  u.searchParams.set('lang', e.target.value);
  location.href = u.href;
};
collabInit();
linkParse();
requestAnimationFrame(loop);
})();
