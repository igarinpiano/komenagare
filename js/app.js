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
const settings = Object.assign(
  { show:true, opacity:1, pauseOnInput:false, mineBorder:true, autosave:true, saveFormat:'json', volume:1, muted:false,
    timeline:true, tlHeight:TL_H, mVideo:M_VIDEO, sideWidth:SIDE_W, sidePane:'list', mobilePane:'timeline', tlSnap:true, tlFollow:true, presets:[], wheelMouse:'time', wheelPad:'auto', letterbox:'#000000' },
  (() => { try { return JSON.parse(localStorage.getItem('komenagare.settings') || '{}'); } catch { return {}; } })()
);
function saveSettings(){ try { localStorage.setItem('komenagare.settings', JSON.stringify(settings)); } catch {} }

/* ---------- 状態 ---------- */
// コメントの追加・変更・削除はすべて store（js/comment-store.js）の変更セットで行う
const store = new CommentStore();
// 共同編集で自分の様子（再生位置・選択・カーソル）を送るための状態（送る処理は「ほかの参加者の様子」）
const presence = { ready: false, timer: 0, last: 0, sent: '', cursor: null, dirty: false, dlgAt: 0, dlgRows: new Map() };
const state = {
  get comments(){ return store.comments; }, layouts: [],
  changeLog: [], // この画面で行った変更（変更履歴の表示用。新しいものが後ろ）
  collab: !!document.querySelector('meta[name="komenagare-host"]'), // komenagare CLI から配信されているか（共同編集）
  fileHandle: null, fileName: null, dirty: false,
  videoName: null, videoUrl: null, videoLoaded: false, needsDraw: true, needsRelayout: false, version: 0,
};

/* =====================================================================
   ユーティリティ
   ===================================================================== */
function fmt(t){
  if (!isFinite(t) || t < 0) t = 0;
  const s = Math.floor(t), h = Math.floor(s/3600), m = Math.floor(s%3600/60), sec = s%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}
function fmtList(t){
  const s = Math.floor(t), m = Math.floor(s/60), sec = s%60;
  return `${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
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
function normCmd(cmd){ return String(cmd ?? '').trim().split(/\s+/).filter(Boolean).join(' '); }
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
  o = { pos:null, size:null, color:null, font:null, long:null, invisible:false, full:false, ender:false, live:false };
  for (const raw of cmd.split(' ')){
    if (!raw) continue;
    const t = raw.toLowerCase(), g = tokGroup(t);
    if (g === 'pos') o.pos ??= t;
    else if (g === 'size') o.size ??= t;
    else if (g === 'color') o.color ??= (COLOR_TABLE[t] || expandHex(t));
    else if (g === 'font') o.font ??= t;
    else if (g === 'long') o.long ??= Math.max(0.1, parseFloat(t.slice(1)));
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
  t: Math.max(0, Math.round(Number(t) * 100) / 100), cmd: normCmd(cmd), text: String(text ?? '').replace(/\r\n?/g, '\n'),
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
  const { applied, conflicts } = store.apply({ id: uuidv7(), ops }, { atomic });
  if (conflicts.length){ if (out) out.push(...conflicts); else console.warn('変更の衝突', conflicts); }
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
  if (TL.sel.size) for (const id of [...TL.sel]) if (!store.has(id)) TL.sel.delete(id);
  relayout();
  renderList();
  drawDensity();
  $('#commentCount').textContent = `コメント ${state.comments.length}`;
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
  if (o.pos !== 'naka'){
    const limit = o.full ? STAGE_W : STAGE_W * UESHITA_RANGE;
    if (w > limit){ const k = limit / w; fs *= k; lh *= k; w = limit; h *= k; }
  }
  if (h > STAGE_H){ const k = STAGE_H / h; fs *= k; lh *= k; w *= k; h = STAGE_H; }
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
  return y + h <= STAGE_H + 0.01 ? y : null;
}
function relayout(){
  const out = [];
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
      L.speed = (STAGE_W + L.w) / (L.end - L.start);
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
      L.yy = (hashStr(c.key) / 4294967296) * Math.max(0, STAGE_H - L.h);
      L.overflow = true;
    } else {
      L.yy = yy;
      pool.push(L);
    }
    L.y = o.pos === 'shita' ? STAGE_H - L.yy - L.h : L.yy;
    out.push(L);
  }
  state.layouts = out;
  state.needsDraw = true;
}

/* =====================================================================
   描画
   ===================================================================== */
const displayRenderer = new CommentRenderer();

function resizeCanvas(){
  // プレビュー枠の中に、書き出しと同じ 16:9 の範囲を収めてコメントを描く
  const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const fw = Math.min(r.width, r.height * 16 / 9), fh = fw * 9 / 16;
  Object.assign(canvas.style, { left: (r.width - fw) / 2 + 'px', top: (r.height - fh) / 2 + 'px', width: fw + 'px', height: fh + 'px' });
  const w = Math.max(1, Math.round(fw * dpr)), h = Math.max(1, Math.round(fh * dpr));
  if (canvas.width !== w || canvas.height !== h){ canvas.width = w; canvas.height = h; }
  state.needsDraw = true;
}
new ResizeObserver(() => { resizeCanvas(); drawDensity(); }).observe(stage);

function loop(){
  requestAnimationFrame(loop);
  const playing = !video.paused && !video.ended;
  const t = video.currentTime || 0;
  if (state.needsRelayout){ state.needsRelayout = false; relayout(); }
  if (playing || state.needsDraw){
    state.needsDraw = false;
    cctx.clearRect(0, 0, canvas.width, canvas.height);
    if (settings.show){
      displayRenderer.draw(cctx, canvas.width, canvas.height, t, state.layouts,
        { opacity: settings.opacity, mineBorder: settings.mineBorder, selected: TL.sel });
    }
    updateTimeUI(t);
  }
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
};
$('#btnFull').innerHTML = ICON.full;
function updatePlayIcon(){ $('#btnPlay').innerHTML = video.paused ? ICON.play : ICON.pause; }
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
  $('#emptyState').hidden = false;
  drawDensity(); updateTimeUI(0); updatePlayIcon(); updateStatus();
}
video.addEventListener('loadedmetadata', () => {
  state.videoLoaded = true; drawDensity(); state.needsDraw = true; updateStatus();
  tlResetView();
  if (state.videoRestoreAt != null){ video.currentTime = Math.min(state.videoRestoreAt, video.duration || 0); state.videoRestoreAt = null; }
  if (state.viewRestore){ tlRestoreView(state.viewRestore); state.viewRestore = null; }
});
video.addEventListener('error', () => {
  if (!video.src) return;
  toast('この動画は再生できません（ブラウザが形式に対応していない可能性があります）', { type:'error', timeout:6000 });
});
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
  highlightCurrent(t);
}

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
  if (!state.videoLoaded){ toast('先に動画を開いてください'); return false; }
  const c = makeComment(video.currentTime, cmd, text, true);
  if (store.hasKey(c.key)){ toast('同じ時刻に同じコメントが既にあります'); return false; }
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
function usePreset(p, insert){
  if (insert){
    const a = textInput.selectionStart ?? textInput.value.length, b = textInput.selectionEnd ?? a;
    textInput.value = textInput.value.slice(0, a) + p.text + textInput.value.slice(b);
    if (normCmd(p.cmd)) cmdInput.value = normCmd(p.cmd), syncPalette();
    autoGrow(); textInput.focus();
    textInput.selectionStart = textInput.selectionEnd = a + p.text.length;
    return;
  }
  if (postAtCurrentTime(p.text, presetCmd(p))) toast(`「${p.text}」を投稿しました`, { timeout:1200 });
}
function renderPresets(){
  presetBar.replaceChildren();
  settings.presets.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'preset';
    b.title = `${p.text}${normCmd(p.cmd) ? `　[${normCmd(p.cmd)}]` : ''}\nクリックで投稿 / Shift+クリックで入力欄に挿入` + (i < 10 ? `\nキー: ${(i + 1) % 10}` : '');
    const o = parseCmd(normCmd(p.cmd));
    if (normCmd(p.cmd) && o.color !== '#FFFFFF'){ const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color; b.append(sw); }
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = p.text.replace(/\n/g, ' ⏎ ');
    b.append(tx);
    if (i < 10){ const k = document.createElement('kbd'); k.textContent = (i + 1) % 10; b.append(k); }
    b.onclick = (e) => usePreset(p, e.shiftKey);
    presetBar.append(b);
  });
  if (!settings.presets.length){
    const h = document.createElement('span'); h.className = 'hint';
    h.textContent = 'よく使うコメント（888 など）を登録すると、ワンタップで投稿できます';
    presetBar.append(h);
  }
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'preset-tool';
  add.textContent = settings.presets.length ? '⚙ 編集' : '＋ プリセットを登録';
  add.title = 'コメントプリセットの追加・編集';
  add.onclick = openPresetDialog;
  presetBar.append(add);
}
const presetDlg = $('#presetDlg');
function prRow(p = { text:'', cmd:'' }){
  const row = document.createElement('div'); row.className = 'pr-row';
  const t = document.createElement('input'); t.className = 'pr-text'; t.placeholder = '本文（例: 888）'; t.value = p.text.replace(/\n/g, '\\n');
  const c = document.createElement('input'); c.className = 'pr-cmd'; c.placeholder = 'コマンド（任意）'; c.value = p.cmd || ''; c.spellcheck = false;
  const mk = (label, title, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title; b.onclick = fn; return b; };
  row.append(t, c,
    mk('↑', '上へ', () => { if (row.previousElementSibling) row.parentNode.insertBefore(row, row.previousElementSibling); }),
    mk('↓', '下へ', () => { if (row.nextElementSibling) row.parentNode.insertBefore(row.nextElementSibling, row); }),
    mk('✕', '削除', () => { row.remove(); prEmpty(); }));
  return row;
}
function prEmpty(){
  const list = $('#prList');
  list.querySelector('.pr-empty')?.remove();
  if (!list.querySelector('.pr-row')){ const e = document.createElement('div'); e.className = 'pr-empty'; e.textContent = 'まだ登録されていません。「＋ 追加」から登録してください。'; list.append(e); }
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
  if (!text.trim()){ toast('コメント入力欄が空です'); return; }
  const r = prRow({ text, cmd: normCmd(cmdInput.value) }); $('#prList').append(r); prEmpty();
};
$('#prCancel').onclick = () => presetDlg.close();
$('#prSave').onclick = () => {
  settings.presets = [...$('#prList').querySelectorAll('.pr-row')].map(r => ({
    text: r.querySelector('.pr-text').value.replace(/\\n/g, '\n').replace(/\s+$/, ''),
    cmd: normCmd(r.querySelector('.pr-cmd').value),
  })).filter(p => p.text.trim());
  saveSettings(); renderPresets(); presetDlg.close();
  toast(`プリセットを保存しました（${settings.presets.length} 件）`);
};
$('#prList').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229){ e.preventDefault(); $('#prSave').click(); } });

/* ---------- コマンドパレット ---------- */
const PALETTE = [
  { label:'位置', tokens:['naka','ue','shita'] },
  { label:'サイズ', tokens:['medium','big','small'] },
  { label:'色', tokens:['white','red','pink','orange','yellow','green','cyan','blue','purple','black'] },
  { label:'色2', tokens:['white2','red2','pink2','orange2','yellow2','green2','cyan2','blue2','purple2','black2'] },
  { label:'フォント', tokens:['defont','gothic','mincho'] },
  { label:'特殊', tokens:['invisible','full','ender','_live'] },
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
    if (grp.label === '色2'){
      const picker = document.createElement('input'); picker.type = 'color'; picker.title = '任意の色 (#RRGGBB)';
      picker.oninput = () => setGroupToken('color', picker.value.toUpperCase());
      chips.append(picker);
    }
    if (grp.label === '特殊'){
      const num = document.createElement('input'); num.type = 'number'; num.min = '1'; num.max = '600'; num.step = '1';
      num.placeholder = '@秒'; num.title = '表示時間（秒）'; num.id = 'longInput';
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
   ===================================================================== */
let listItems = [], listRows = [], currentRowIdx = -1, lastHL = NaN, listHover = false;
const listRowOf = new Map(); // コメントの id → リストの行
let listPeerRows = []; // ほかの人の選択で色を付けた行
list.addEventListener('mouseenter', () => { listHover = true; });
list.addEventListener('mouseleave', () => { listHover = false; });
function renderList(){
  const q = $('#search').value.trim().toLowerCase();
  listItems = q ? state.comments.filter(c => c.text.toLowerCase().includes(q) || c.cmd.toLowerCase().includes(q)) : state.comments.slice();
  const frag = document.createDocumentFragment();
  listRowOf.clear(); listPeerRows = [];
  listRows = listItems.map((c, i) => {
    const row = document.createElement('div');
    row.className = 'row' + (c.mine ? ' mine' : '') + (parseCmd(c.cmd).invisible ? ' inv' : '');
    row.dataset.i = i;
    const rt = document.createElement('span'); rt.className = 'rt'; rt.textContent = fmtList(c.t);
    const rc = document.createElement('span'); rc.className = 'rc'; rc.textContent = c.text;
    const rm = document.createElement('span'); rm.className = 'rm'; rm.title = c.cmd;
    const o = parseCmd(c.cmd);
    if (o.color !== '#FFFFFF'){ const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color; rm.append(sw); }
    rm.append(c.cmd);
    const del = document.createElement('button'); del.className = 'del'; del.title = '削除'; del.textContent = '×';
    row.append(rt, rc, rm, del);
    frag.append(row);
    listRowOf.set(c.id, row);
    return row;
  });
  list.replaceChildren(frag);
  if (!listItems.length){
    const em = document.createElement('div'); em.className = 'list-empty';
    em.textContent = q ? '該当するコメントはありません' : 'コメントはまだありません。\n動画を再生しながら下の入力欄から書き込めます。';
    em.style.whiteSpace = 'pre-line';
    list.append(em);
  }
  $('#listCount').textContent = q ? `${listItems.length} / ${state.comments.length}件` : `${state.comments.length}件`;
  currentRowIdx = -1; lastHL = NaN;
  highlightCurrent(video.currentTime || 0);
  listMarkPeers();
}
$('#search').addEventListener('input', renderList);
list.addEventListener('click', (e) => {
  const row = e.target.closest('.row'); if (!row) return;
  const c = listItems[+row.dataset.i]; if (!c) return;
  if (e.target.closest('.del')){ deleteComment(c); return; }
  seekTo(parseCmd(c.cmd).pos === 'naka' ? c.t - NAKA_LEAD : c.t);
  TL.sel = new Set([c.id]); tlSelChanged(); tlEnsureVisible(c);
});
function highlightCurrent(t){
  const k = Math.floor(t * 4);
  if (k === lastHL) return;
  lastHL = k;
  let lo = 0, hi = listItems.length - 1, idx = -1;
  while (lo <= hi){ const mid = (lo + hi) >> 1; if (listItems[mid].t <= t){ idx = mid; lo = mid + 1; } else hi = mid - 1; }
  if (idx === currentRowIdx) return;
  listRows[currentRowIdx]?.classList.remove('current');
  currentRowIdx = idx;
  const row = listRows[idx];
  if (row){
    row.classList.add('current');
    if ($('#autoScroll').checked && !listHover && !video.paused){
      list.scrollTop = row.offsetTop - list.clientHeight * 0.65;
    }
  }
}
function deleteComment(c){
  if (!store.has(c.id)) return;
  const ch = commitOps([deleteOp(c)]);
  if (ch) toast('コメントを削除しました', { action:{ label:'元に戻す', fn:() => revertChange(ch) } });
}

/* =====================================================================
   ファイル入出力
   ===================================================================== */
function csvEsc(s){ return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function serialize(fmt){
  const items = state.comments.map(c => ({ t: c.t, cmd: c.cmd, text: c.text, id: c.id }));
  if (fmt === 'csv'){
    return '\ufeff' + 'time,command,text,id\r\n' + items.map(c => [c.t.toFixed(2), csvEsc(c.cmd), csvEsc(c.text), c.id].join(',')).join('\r\n') + (items.length ? '\r\n' : '');
  }
  const body = items.length ? '[\n' + items.map(c => '    ' + JSON.stringify(c)).join(',\n') + '\n  ]' : '[]';
  return `{\n  "format": "komenagare",\n  "version": 2,\n  "comments": ${body}\n}\n`;
}
function parseCSV(text){
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++){
    const ch = text[i];
    if (q){
      if (ch === '"'){ if (text[i + 1] === '"'){ f += '"'; i++; } else q = false; }
      else f += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\r') {}
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f !== '' || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ''));
}
function parseCommentText(text, name = ''){
  text = text.replace(/^\ufeff/, '');
  const head = text.trimStart();
  if (/\.xml$/i.test(name) || head.startsWith('<')){
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('XML の解析に失敗しました');
    return [...doc.getElementsByTagName('chat')].map(ch => {
      const v = Number(ch.getAttribute('vpos'));
      return isFinite(v) ? makeComment(v / 100, ch.getAttribute('mail') || '', ch.textContent || '') : null;
    }).filter(Boolean);
  }
  if (/\.json$/i.test(name) || head.startsWith('{') || head.startsWith('[')){
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('JSON の解析に失敗しました'); }
    let arr = null;
    if (Array.isArray(data)) arr = data;
    else if (data && Array.isArray(data.comments)) arr = data.comments;
    else if (data && (data.data?.threads || data.threads)) arr = (data.data?.threads || data.threads).flatMap(th => th.comments || []);
    if (!arr) throw new Error('コメントの配列が見つかりません');
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
    out.push(makeComment(t, r[ci] ?? '', r[xi] ?? '', false, ii >= 0 ? r[ii] : null));
  }
  return out;
}

function defaultFileName(ext){
  const b = state.fileName ? baseName(state.fileName) : (state.videoName ? baseName(state.videoName) + '.comments' : 'comments');
  return `${b}.${ext}`;
}
function updateStatus(){
  $('#videoStatus').textContent = '動画: ' + (state.videoName || 'なし');
  const fs = $('#fileStatus');
  fs.replaceChildren();
  const name = document.createElement('span');
  name.textContent = 'コメント: ' + (state.collab ? '共同編集（ホストに保存）' : (state.fileName || '新規'));
  fs.append(name, ' ');
  const st = document.createElement('span');
  if (state.dirty){ st.className = 'dirty'; st.textContent = '● 未保存'; }
  else if (state.fileName){ st.className = 'clean'; st.textContent = '✓ 保存済み'; }
  fs.append(st);
  if (state.fileHandle && settings.autosave){ fs.append(' · 自動保存'); }
  $('#fsNote').textContent = hasFS
    ? 'このブラウザは開いたコメントファイルへの直接保存に対応しています。保存時にはファイル側に増えたコメントも取り込んでから書き込みます。'
    : 'このブラウザはファイルへの直接保存に非対応のため、保存はダウンロードになります（Chrome / Edge 推奨）。';
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
  if (!(await ensurePerm(h))) throw new Error('ファイルへの書き込みが許可されませんでした');
  if (mergeFirst){
    try {
      const f = await h.getFile();
      const txt = await f.text();
      if (txt.trim()){
        const r = addComments(parseCommentText(txt, f.name), { skipDeleted:true, undoable:false, save:false });
        if (r.added) toast(`ファイル側にあった新しいコメント ${r.added} 件を取り込みました`);
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
          { description:'コメントファイル (JSON)', accept:{ 'application/json':['.json'] } },
          { description:'コメントファイル (CSV)', accept:{ 'text/csv':['.csv'] } },
        ],
      });
    } catch (e) { if (e.name === 'AbortError') return false; throw e; }
    state.fileHandle = h;
    await writeHandle(h, false);
    toast(`${h.name} に保存しました`);
    return true;
  }
  const fmt = settings.saveFormat;
  const name = defaultFileName(fmt);
  download(serialize(fmt), name, fmt === 'csv' ? 'text/csv' : 'application/json');
  state.fileName = name;
  markClean();
  toast(`${name} をダウンロードしました`);
  return true;
}
function doSave(opts){ save(opts).catch(e => toast('保存に失敗しました: ' + e.message, { type:'error' })); }

let saving = null, savePending = false;
function autosave(){
  if (!settings.autosave || !state.fileHandle) return;
  if (saving){ savePending = true; return; }
  saving = writeHandle(state.fileHandle, true)
    .catch(e => toast('自動保存に失敗しました: ' + e.message, { type:'error' }))
    .finally(() => { saving = null; if (savePending){ savePending = false; autosave(); } });
}

function loadReplace(text, name, handle){
  let items;
  try { items = parseCommentText(text, name); }
  catch (e) { toast(`${name}: ${e.message}`, { type:'error' }); return; }
  if (state.collab){
    // 共同編集中は全体を入れ替えず、ほかの人のコメントを残したまま追加する
    const r = addComments(items);
    toast(`${name} から ${r.added} 件のコメントを追加しました（共同編集中は置き換えずに追加します）` + (r.dup ? `　重複 ${r.dup} 件は除外` : ''), { timeout:6000 });
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
  toast(`${name} から ${r.added} 件のコメントを読み込みました` + (r.dup ? `（重複 ${r.dup} 件を除外）` : ''));
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
  let msg = `${ok} ファイルをマージ: ${added} 件追加`;
  if (dup) msg += ` / 重複 ${dup} 件`;
  if (skipped) msg += ` / この作業中に削除したもの ${skipped} 件は除外`;
  toast(msg, { timeout:5000 });
}

const COMMENT_TYPES = [{ description:'コメントファイル', accept:{ 'application/json':['.json'], 'text/csv':['.csv'], 'text/xml':['.xml'] } }];
$('#btnOpenComments').onclick = async () => {
  if (state.dirty && state.comments.length &&
      !confirm('未保存のコメントがあります。破棄して別のファイルを開きますか？\n（今のコメントに追加したい場合は「マージ」を使ってください）')) return;
  if (hasFS){
    try {
      const [h] = await window.showOpenFilePicker({ types: COMMENT_TYPES });
      const f = await h.getFile();
      loadReplace(await f.text(), f.name, h);
    } catch (e) { if (e.name !== 'AbortError') toast('開けませんでした: ' + e.message, { type:'error' }); }
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
    } catch (e) { if (e.name !== 'AbortError') toast('開けませんでした: ' + e.message, { type:'error' }); }
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
  if (!cmts.length){ if (!vids.length) toast('対応していないファイルです', { type:'error' }); return; }
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
  if (!on) b.textContent = '⏺ コメ付き書き出し';
}
function expProgress(p, text){
  exportState.progress = p;
  $('#expBar').style.width = (p * 100).toFixed(1) + '%';
  $('#expText').textContent = text;
  if (exportState.running && exportState.mode === 'fast') $('#btnExport').textContent = `⏺ 書き出し中 ${Math.floor(p * 100)}%`;
}
function expSyncForm(){
  const fast = $('#expMode').value === 'fast';
  const cont = $('#expContainer');
  for (const o of cont.options) o.disabled = !fast && !pickMime(o.value);
  if (cont.selectedOptions[0]?.disabled) cont.value = [...cont.options].find(o => !o.disabled)?.value || 'mp4';
  $('#expMuteRow').hidden = fast;
  if (!fast && $('#expFps').value === '0') $('#expFps').value = '30';
  $('#expFps').options[0].disabled = !fast;
  let ok = true, out;
  if (fast){
    out = `${CONTAINERS[cont.value].label}（コーデックは対応するものを自動で選択）`;
    $('#expNote').textContent = '動画ファイルを直接読み込んで変換するので、再生するより速く書き出せます。'
      + (fastExportInWorker() ? '処理はバックグラウンドで行うため、書き出し中もほかの作業やタブの切り替えができます。' : 'ファイルを直接開いているため、このタブで処理します（書き出し中はタブを開いたままにしてください）。')
      + 'フレームレートを動画より高くすると、映像は元のコマのまま、コメントだけが指定したフレームレートで滑らかに動きます。';
  } else {
    const mime = pickMime(cont.value);
    const canCapture = typeof HTMLCanvasElement.prototype.captureStream === 'function';
    ok = !!(mime && canCapture);
    out = ok ? mime : 'このブラウザはこの形式での録画に対応していません';
    $('#expNote').textContent = '動画を実際に等倍で再生しながら録画するため、動画の長さと同じ時間がかかります。録画中はこのタブを前面に表示したままにしてください。パソコンの処理が追いつかないと、指定したフレームレートより粗くなることがあります。高速書き出しが使えない動画や環境向けです。';
  }
  $('#expFormat').textContent = out;
  $('#expStartBtn').disabled = !ok;
}
$('#expMode').onchange = expSyncForm;
$('#expContainer').onchange = expSyncForm;
$('#btnExport').onclick = () => {
  if (exportState.running){ exportDlg.showModal(); return; }
  if (!state.videoLoaded){ toast('先に動画を開いてください'); return; }
  const vh = video.videoHeight || 720;
  const res = $('#expRes'); res.replaceChildren();
  const opts = [[Math.min(2160, vh - vh % 2), `元動画と同じ高さ (${Math.min(2160, vh)}p)`], [1080, '1080p'], [720, '720p'], [480, '480p']];
  for (const [v, l] of opts){ const o = document.createElement('option'); o.value = v; o.textContent = l; res.append(o); }
  $('#expStart').value = '0:00';
  $('#expEnd').value = fmt(video.duration);
  const fastOk = canFastExport();
  $('#expMode').options[0].disabled = !fastOk;
  $('#expMode').value = fastOk ? 'fast' : 'realtime';
  if (fastOk) $('#expFps').value = '0';
  $('#expText').textContent = ''; $('#expBar').style.width = '0%';
  expSyncForm();
  expSetBusy(false);
  exportDlg.showModal();
};
$('#expClose').onclick = () => { if (!exportUsesPlayer()) exportDlg.close(); };
$('#expBg').onclick = () => { exportDlg.close(); toast('書き出しをバックグラウンドで続けます（上の「書き出し中」ボタンで進み具合を確認できます）', { timeout:5000 }); };
exportDlg.addEventListener('cancel', (e) => { if (exportUsesPlayer()) e.preventDefault(); });
$('#expCancel').onclick = () => {
  exportState.cancel = true;
  if (exportState.worker) exportState.worker.postMessage({ type:'cancel' });
  if (exportState.ctl){ exportState.ctl.canceled = true; exportState.ctl.conv?.cancel().catch(() => {}); }
};
$('#expStartBtn').onclick = () => {
  const run = $('#expMode').value === 'fast' ? runFastExport : runRealtimeExport;
  run().catch(e => {
    console.error(e);
    expSetBusy(false);
    expProgress(0, '失敗しました: ' + e.message);
    toast('書き出しに失敗しました: ' + e.message, { type:'error', timeout:8000 });
  });
};
function readExportOptions(){
  let H = +$('#expRes').value || 720; H -= H % 2;
  let W = Math.round(H * 16 / 9); W += W % 2;
  const dur = video.duration;
  let start = parseTime($('#expStart').value); if (!isFinite(start) || start < 0) start = 0;
  let end = parseTime($('#expEnd').value); if (!isFinite(end) || end > dur) end = dur;
  return { W, H, fps: +$('#expFps').value, vbps: +$('#expBitrate').value * 1e6, start, end,
    audio: $('#expAudio').checked, container: $('#expContainer').value };
}
function exportFileName(ext){ return `${baseName(state.videoName) || 'video'}_comments.${ext}`; }

/* ---------- 高速書き出し（WebCodecs。Web Worker で処理し、使えない環境ではこのタブで処理） ---------- */
function loadMediabunny(){
  if (window.Mediabunny) return Promise.resolve(window.Mediabunny);
  return new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = MB_URL;
    sc.onload = () => window.Mediabunny ? resolve(window.Mediabunny) : reject(new Error('変換ライブラリを読み込めませんでした'));
    sc.onerror = () => reject(new Error('変換ライブラリ（lib/' + MB_URL.split('/').pop() + '）が見つかりません。index.html と同じ場所に lib フォルダを置いてください'));
    document.head.append(sc);
  });
}
// 元動画の映像をこのブラウザの WebCodecs でデコードできないとき（Firefox で HEVC など）の書き出し。
// 映像は再生プレーヤーから元のコマを1つずつ取り込み（等倍で再生しながら取り込み、取りこぼしたコマはシークして取る）、
// エンコードと音声は高速書き出しと同じ仕組みで行う
async function exportViaPlayer(MB, d, ctl){
  const { input, format, output, vcodec, track } = await exportSetup(MB, d);
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
  if (!times.length) throw new Error('書き出し範囲に映像のコマが見つかりません');
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
  output.addVideoTrack(src, d.fps > 0 ? { frameRate: d.fps } : {});
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
  return { buffer: output.target.buffer, mime: format.mimeType, ext: format.fileExtension.replace(/^\./, ''), codec: vcodec,
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
  if (o.end - o.start < 0.5){ toast('書き出し範囲が短すぎます', { type:'error' }); return; }
  if (!state.videoFile) throw new Error('動画ファイルが見つかりません');
  const d = { type: 'start', lib: MB_URL, file: state.videoFile, layouts: snapshotLayouts(o.start, o.end), ...o };
  exportState.mode = 'fast'; exportState.cancel = false;
  expSetBusy(true);
  expProgress(0, '準備中…');
  let t0 = performance.now();
  const span = o.end - o.start;
  const onProgress = (p, t) => {
    const el = (performance.now() - t0) / 1000;
    const speed = t > 0 ? (t / el) : 0;
    const left = p > 0.02 ? el * (1 - p) / p : NaN;
    expProgress(p, (exportState.mode === 'seek' ? 'プレーヤーから読み込みながら書き出し中（このタブを前面に表示したままにしてください）… ' : '書き出し中… ') + `${Math.floor(p * 100)}%` + (speed ? `（再生速度の約 ${speed.toFixed(1)} 倍` + (isFinite(left) ? `・残り約 ${fmt(left)}` : '') + '）' : ''));
  };
  const onDone = (m) => {
    const name = exportFileName(m.ext);
    download(new Blob([m.buffer], { type: m.mime }), name);
    const el = (performance.now() - t0) / 1000;
    const CODEC = { avc:'H.264', hevc:'H.265', vp9:'VP9', vp8:'VP8', av1:'AV1' };
    expProgress(1, `完了: ${name}（${CODEC[m.codec] || m.codec}・${o.fps ? o.fps + 'fps' : '元動画と同じfps'}・${(m.buffer.byteLength / 1048576).toFixed(1)} MB・${fmt(span)} 分を ${fmt(el)} で書き出し）`
      + ((o.container === 'mp4' || o.container === 'mkv') && m.codec !== 'avc' ? '　※この環境では H.264 が使えないため ' + (CODEC[m.codec] || m.codec) + ' で書き出しました（古いプレーヤーでは再生できないことがあります）' : '')
      + (m.audioDropped ? '　※音声はこの形式に変換できなかったため含まれていません' : '')
      + (m.viaPlayer ? '　※このブラウザでは元動画を直接デコードできないため、プレーヤーで1コマずつ読み込んで書き出しました' : ''));
    toast(`${name} を書き出しました`, { timeout:6000 });
  };
  // このタブで変換する（ファイルを直接開いているとき・プレーヤーから映像を取り出すとき）
  const inTab = async (convert) => {
    const ctl = { canceled: false, conv: null, onProgress };
    exportState.ctl = ctl;
    try {
      const MB = await loadMediabunny();
      onDone(await convert(MB, d, ctl));
    } catch (e){
      if (ctl.canceled) expProgress(0, '中止しました'); else throw e;
    } finally { exportState.ctl = null; }
  };
  try {
    try {
      if (fastExportInWorker()){
        const worker = new Worker(new URL('js/export-worker.js', location.href));
        exportState.worker = worker;
        try {
          await new Promise((resolve, reject) => {
            worker.onerror = (e) => reject(new Error(e.message || 'ワーカーの起動に失敗しました'));
            worker.onmessage = (ev) => {
              const m = ev.data;
              if (m.type === 'progress') onProgress(m.p, m.t);
              else if (m.type === 'done'){ onDone(m); resolve(); }
              else if (m.type === 'canceled'){ expProgress(0, '中止しました'); resolve(); }
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
      expProgress(0, e.message + '。プレーヤーで1コマずつ読み込みながら書き出します…');
      await inTab(exportViaPlayer);
    }
  } finally { expSetBusy(false); }
}

/* ---------- リアルタイム録画（互換モード） ---------- */
async function runRealtimeExport(){
  const o = readExportOptions();
  const mime = pickMime(o.container); if (!mime) return;
  const { W, H, start, end } = o, fps = o.fps || 30, vbps = o.vbps;
  if (end - start < 0.5){ toast('書き出し範囲が短すぎます', { type:'error' }); return; }

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
    renderer.draw(c2, W, H, video.currentTime, state.layouts, { opacity:1 });
  };

  exportState.mode = 'realtime'; exportState.cancel = false;
  expSetBusy(true);
  expProgress(0, '準備中…');

  let rec = null;
  try {
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
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);
    await video.play();
    await new Promise(resolve => {
      const tick = () => {
        const t = video.currentTime;
        if (exportState.cancel || video.ended || t >= end){ resolve(); return; }
        draw();
        expProgress((t - start) / (end - start), `録画中… ${fmt(t - start)} / ${fmt(end - start)}（等倍で進みます）`);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    draw();
    video.pause();
    rec.stop();
    await stopped;
    if (!exportState.cancel){
      const name = exportFileName(o.container);
      download(new Blob(chunks, { type: mime.split(';')[0] }), name);
      expProgress(1, `完了: ${name} をダウンロードしました`);
      toast(`${name} を書き出しました`);
    } else {
      expProgress(0, '中止しました');
    }
  } finally {
    if (rec && rec.state !== 'inactive') try { rec.stop(); } catch {}
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
  const { applied, conflicts } = store.apply(ch, { atomic: true });
  if (conflicts.length){ toast('その後の変更と重なるため元に戻せません', { type:'error' }); return false; }
  if (applied){ recordChange(applied); commentsChanged(); collabSend(applied); markDirty(); autosave(); tlSelChanged(); }
  return true;
}
function undo(){
  if (!history.undo.length){ toast('これ以上元に戻せません'); return; }
  const ch = history.undo[history.undo.length - 1];
  if (!applyHistory(invertChange(ch))) return;
  history.redo.push(history.undo.pop());
  updateUndoUI();
}
function redo(){
  if (!history.redo.length){ toast('これ以上やり直せません'); return; }
  const ch = history.redo[history.redo.length - 1];
  if (!applyHistory({ ...ch, id: uuidv7() })) return;
  history.undo.push(history.redo.pop());
  updateUndoUI();
}
// 特定の変更を打ち消す変更を新しく積む（git revert）
function revertChange(ch){
  const { applied, conflicts } = store.apply(invertChange(ch), { atomic: true });
  if (conflicts.length){ toast('その後の変更と重なるため元に戻せません', { type:'error' }); return null; }
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
const TL_RULER = 22, TL_HEAD = 30, TL_GAP = 6, TL_MIN_DUR = 0.1;
const TL_GROUPS = [
  { pos:'ue', label:'上', color:'#2e9e6b' },
  { pos:'naka', label:'流', color:'#3b74d6' },
  { pos:'shita', label:'下', color:'#c47f22' },
];
const TL_GI = { ue:0, naka:1, shita:2 };
const coarse = matchMedia('(pointer: coarse)');
const laneH = () => coarse.matches ? 32 : 24;
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
  return Math.max(60, m + 5);
}
const tx = (t) => TL_HEAD + (t - TL.t0) * TL.pps;
const xt = (x) => TL.t0 + (x - TL_HEAD) / TL.pps;
const laneTop = (gi, lane) => TL_RULER + TL.groups[gi].y + lane * laneH() - TL.scrollY;
const tlShown = () => TL.main.clientWidth > 0 && TL.main.clientHeight > 0;

function tlRelane(){
  const groups = TL_GROUPS.map(g => ({ ...g, lanes: [] }));
  const items = state.comments.map(c => ({ c, sp: spanOf(c) })).sort((a, b) => a.sp.s - b.sp.s || a.c.t - b.c.t);
  TL.laneOf.clear();
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
  for (const [cv, w, h] of [[TL.cv, TL.W, TL.H], [TL.ov, TL.ovW, TL.ovH]]){
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph){ cv.width = pw; cv.height = ph; }
  }
  if (!TL.inited && TL.W > 60){ TL.inited = true; tlResetView(); }
  TL.ovDirty = true;
  tlClampView();
  // 隠れている間の表示範囲は、見えるようになってから戻す
  if (TL.pendingView && TL.W > 60){ const v = TL.pendingView; TL.pendingView = null; tlRestoreView(v); }
}
new ResizeObserver(tlResize).observe(TL.main);
new ResizeObserver(tlResize).observe(TL.ovBox);
coarse.addEventListener?.('change', tlRelane);

const RULER_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
function rulerStep(){
  const major = RULER_STEPS.find(s => s * TL.pps >= 70) ?? 3600;
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
  g.globalAlpha = sp.o.invisible ? 0.4 : 1;
  g.fillStyle = sel ? shade(TL_GROUPS[gi].color, 1.3) : TL_GROUPS[gi].color;
  rr(g, x0 + 0.5, top, w - 1, h, 4); g.fill();
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
  if (sel){
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
  g.fillStyle = '#141414'; g.fillRect(0, 0, W, H);
  const t1 = xt(W), D = tlDuration(), hasDur = isFinite(video.duration) && video.duration > 0;
  const step = rulerStep(), minor = step.major / step.div;
  // トラック
  g.save(); g.beginPath(); g.rect(TL_HEAD, TL_RULER, W - TL_HEAD, H - TL_RULER); g.clip();
  TL.groups.forEach((G, gi) => {
    for (let ln = 0; ln < G.n; ln++){
      const y = laneTop(gi, ln);
      if (y > H || y + lh < TL_RULER) continue;
      g.fillStyle = ln % 2 ? '#1a1a1a' : '#1e1e1e';
      g.fillRect(TL_HEAD, y, W - TL_HEAD, lh);
    }
  });
  g.fillStyle = 'rgba(255,255,255,.045)';
  for (let k = Math.ceil(TL.t0 / step.major); k * step.major <= t1; k++) g.fillRect(Math.round(tx(k * step.major)), TL_RULER, 1, H - TL_RULER);
  g.fillStyle = 'rgba(0,0,0,.5)';
  if (tx(0) > TL_HEAD) g.fillRect(TL_HEAD, TL_RULER, tx(0) - TL_HEAD, H);
  if (hasDur && tx(D) < W) g.fillRect(tx(D), TL_RULER, W - tx(D), H);
  g.font = TL_FONT; g.textBaseline = 'middle';
  for (const c of state.comments){
    const pos = TL.laneOf.get(c.id);
    if (!pos) continue;
    const sp = spanOf(c);
    if (sp.e < TL.t0 || sp.s > t1) continue;
    const y = laneTop(pos.g, pos.lane);
    if (y > H || y + lh < TL_RULER) continue;
    tlDrawClip(g, c, sp, y, lh, pos.g);
  }
  if (TL.snapT != null){ g.fillStyle = '#ffd400'; g.fillRect(Math.round(tx(TL.snapT)) - 0.5, TL_RULER, 1.5, H); }
  tlDrawPeerSel(g, t1);
  g.restore();
  // 見出し列
  g.fillStyle = '#101010'; g.fillRect(0, TL_RULER, TL_HEAD, H);
  g.save(); g.beginPath(); g.rect(0, TL_RULER, TL_HEAD, H - TL_RULER); g.clip();
  g.font = '600 12px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  TL.groups.forEach((G, gi) => {
    const y0 = laneTop(gi, 0), h = G.n * lh;
    if (y0 > H || y0 + h < TL_RULER) return;
    g.fillStyle = G.color; g.fillRect(4, y0 + 2, 3, h - 4);
    const vy0 = Math.max(y0, TL_RULER), vy1 = Math.min(y0 + h, H);
    g.fillStyle = '#c8c8c8'; g.fillText(G.label, TL_HEAD / 2 + 3, (vy0 + vy1) / 2);
    g.fillStyle = '#262626'; g.fillRect(0, y0 + h + TL_GAP / 2 - 0.5, W, 1);
  });
  g.restore();
  // 目盛り
  g.fillStyle = '#1f1f1f'; g.fillRect(0, 0, W, TL_RULER);
  g.fillStyle = '#333'; g.fillRect(0, TL_RULER - 1, W, 1);
  g.save(); g.beginPath(); g.rect(TL_HEAD, 0, W - TL_HEAD, TL_RULER); g.clip();
  g.font = '11px system-ui,sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  for (let k = Math.ceil(TL.t0 / minor); k * minor <= t1; k++){
    const x = Math.round(tx(k * minor));
    if (k % step.div === 0){
      g.fillStyle = '#8a8a8a'; g.fillRect(x, TL_RULER - 9, 1, 8);
      g.fillStyle = '#bdbdbd'; g.fillText(fmtRuler(k * minor, step.major), x + 3, 11);
    } else { g.fillStyle = '#555'; g.fillRect(x, TL_RULER - 5, 1, 4); }
  }
  g.restore();
  // 再生位置
  const px = tx(video.currentTime || 0);
  if (px >= TL_HEAD - 7 && px <= W + 7){
    g.fillStyle = '#ff4d4d';
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
    c2.fillStyle = '#0d0d0d'; c2.fillRect(0, 0, W, H);
    const k = ovK(), rh = (H - 4) / 3;
    if (isFinite(video.duration)){ c2.fillStyle = '#161616'; c2.fillRect(ovX(0), 0, video.duration * k, H); }
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
  if (t !== TL.lastT){ TL.lastT = t; TL.dirty = true; }
  if (TL.dirty){ TL.dirty = false; tlDraw(); tlDrawOverview(); }
}

/* ---------- 選択と情報表示 ---------- */
function tlSelected(){ return state.comments.filter(c => TL.sel.has(c.id)); }
function tlSelChanged(){
  const n = TL.sel.size;
  $('#tlEdit').disabled = n !== 1;
  $('#tlDelete').disabled = !n;
  TL.dirty = true; state.needsDraw = true;
  presenceDirty();
  if (n === 1) tlShowInfo(tlSelected()[0]);
  else $('#tlInfo').textContent = n ? `${n} 件選択中` : 'ダブルクリックで作成・編集';
}
function tlShowInfo(c){
  if (!c){ $('#tlInfo').textContent = ''; return; }
  const sp = spanOf(c);
  const speed = sp.lead ? `　速さ <b>×${((DEFAULT_DURATION + NAKA_LEAD) / (sp.dur + NAKA_LEAD)).toFixed(2)}</b>` : '';
  $('#tlInfo').innerHTML = `開始 <b>${fmtPrecise(c.t)}</b>　表示 <b>${sp.dur.toFixed(2)}秒</b>${speed}`;
}
function deleteSelected(){
  const list = tlSelected();
  if (!list.length) return;
  TL.sel.clear();
  const ch = commitOps(list.map(deleteOp));
  tlSelChanged();
  if (ch) toast(`${list.length} 件のコメントを削除しました`, { action:{ label:'元に戻す', fn:() => revertChange(ch) } });
}
function nudgeSelected(dt){
  const list = tlSelected();
  if (!list.length) return;
  dt = Math.max(dt, -Math.min(...list.map(c => c.t)));
  if (!dt) return;
  const { ops, failed } = updateOps(list.map(c => ({ c, t: c.t + dt })));
  if (failed) toast('同じ時刻・内容のコメントがあるため一部を動かせませんでした');
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
  const changes = [];
  for (const [c, o] of d.orig) if (c.t !== o.t || c.cmd !== o.cmd) changes.push({ c, t: c.t, cmd: c.cmd });
  tlDragRestore(d);
  TL.snapT = null;
  if (!changes.length){ relayout(); return; }
  const { ops, failed } = updateOps(changes);
  if (failed) toast('同じ時刻・内容のコメントがあるため一部を変更できませんでした');
  if (!commitOps(ops)) relayout();
  tlSelChanged();
}
function tlCancelDrag(){
  const d = TL.drag;
  TL.drag = null; TL.snapT = null;
  if (d && d.orig && d.started){ tlDragRestore(d); relayout(); tlSelChanged(); }
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
    TL.drag = { ...base, type:'scrub' };
    if (state.videoLoaded) seekTo(Math.max(0, xt(p.x)));
    return;
  }
  const hit = tlHit(p.x, p.y, touch);
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
    TL.drag = { ...base, type: hit.zone, c, orig: new Map(moving.map(x => [x, { t: x.t, cmd: x.cmd }])) };
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
    if (e.pointerType === 'mouse'){
      const hit = p.y < TL_RULER ? null : tlHit(p.x, p.y, false);
      TL.main.style.cursor = p.y < TL_RULER ? 'col-resize' : !hit ? 'default' : hit.zone === 'move' ? 'grab' : 'ew-resize';
    }
    return;
  }
  if (d.id !== e.pointerId) return;
  const dx = p.x - d.x0, dy = p.y - d.y0;
  if (!d.started){
    if (Math.hypot(dx, dy) < (d.touch ? 8 : 3)) return;
    d.started = true;
    if (d.orig) tlDragBegin(d);
    if (d.type === 'move') TL.main.style.cursor = 'grabbing';
  }
  if (d.type === 'scrub'){ if (state.videoLoaded) seekTo(Math.max(0, xt(p.x))); }
  else if (d.type === 'pan'){ TL.t0 = d.t0 - dx / TL.pps; TL.scrollY = d.sy - dy; tlClampView(); }
  else if (d.orig){ d.lastX = p.x; tlDragUpdate(p.x); }
  TL.dirty = true;
});
function tlPointerEnd(e, cancel){
  TL.pointers.delete(e.pointerId);
  if (TL.pinch){ if (TL.pointers.size < 2) TL.pinch = null; TL.drag = null; return; }
  const d = TL.drag;
  if (!d || d.id !== e.pointerId) return;
  if (cancel){ tlCancelDrag(); return; }
  TL.drag = null;
  if (d.started){
    if (d.orig) tlDragCommit(d);
    TL.snapT = null; TL.dirty = true;
    return;
  }
  // タップ／クリック
  const p = tlLocal(e), now = performance.now();
  const dbl = !!TL.lastTap && now - TL.lastTap.time < 380 && Math.hypot(p.x - TL.lastTap.x, p.y - TL.lastTap.y) < 24;
  TL.lastTap = dbl ? null : { time: now, x: p.x, y: p.y };
  if (d.type === 'scrub') return;
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
  const kind = $('#tlWheelKind'); if (kind) kind.textContent = pad ? 'トラックパッド（360°）' : 'マウスホイール';
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
function toggleSnap(){ TL.snap = settings.tlSnap = !TL.snap; saveSettings(); $('#tlSnap').classList.toggle('on', TL.snap); toast(TL.snap ? 'スナップ オン' : 'スナップ オフ', { timeout:1200 }); }
$('#tlSnap').classList.toggle('on', TL.snap);
$('#tlFollow').classList.toggle('on', TL.follow);
$('#tlSnap').onclick = toggleSnap;
$('#tlFollow').onclick = () => { TL.follow = settings.tlFollow = !TL.follow; saveSettings(); $('#tlFollow').classList.toggle('on', TL.follow); };
$('#tlNew').onclick = () => openNewDialog(video.currentTime || 0);
$('#tlEdit').onclick = () => { const s = tlSelected(); if (s.length === 1) openEditDialog(s[0]); };
$('#tlDelete').onclick = deleteSelected;
$('#tlUndo').onclick = undo;
$('#tlRedo').onclick = redo;
$('#tlZoomIn').onclick = () => tlZoomAt(1.5, tlZoomCenterX());
$('#tlZoomOut').onclick = () => tlZoomAt(1 / 1.5, tlZoomCenterX());
$('#tlFit').onclick = tlFit;
$('#setWheelMouse').value = settings.wheelMouse;
$('#setWheelPad').value = settings.wheelPad;
$('#setWheelMouse').onchange = (e) => { settings.wheelMouse = e.target.value; saveSettings(); };
$('#setWheelPad').onchange = (e) => { settings.wheelPad = e.target.value; saveSettings(); };
$('#tlSettings').onclick = () => $('#tlSetDlg').showModal();
$('#tlSetClose').onclick = () => $('#tlSetDlg').close();
$('#tlZoom').oninput = (e) => {
  const b = tlBounds();
  tlZoomAt(b.minPps * Math.pow(b.maxPps / b.minPps, e.target.value / 1000) / TL.pps, tlZoomCenterX());
};
// 高さを変えるつまみ（ダブルクリックで元に戻す）。PC ではタイムラインの上端でタイムラインの高さを、
// 縦向きのスマホではタブの上で動画の大きさを変えて、下の画面（タイムライン・リスト・Vim・履歴）がその残りに広がる
for (const h of [$('#tlResize'), $('#mResize')]) {
  let st = null;
  // 縦向きのスマホで動画をどこまで大きくできるか（横幅いっぱいまで）
  const mVideoMax = () => Math.max(0.12, Math.min(0.6, ($('.player-col').clientWidth - 16) * 9 / 16 / stableH));
  h.addEventListener('pointerdown', (e) => {
    st = mq.matches ? { y: e.clientY, f: Math.min(settings.mVideo, mVideoMax()), mobile: true } : { y: e.clientY, h: Math.min(settings.tlHeight, tlMaxHeight()) };
    h.setPointerCapture(e.pointerId); h.classList.add('on');
  });
  h.addEventListener('pointermove', (e) => {
    if (!st) return;
    const dy = e.clientY - st.y;
    if (st.mobile) settings.mVideo = Math.round(clamp(st.f + dy / stableH, 0.12, mVideoMax()) * 1000) / 1000;
    else settings.tlHeight = Math.round(clamp(st.h - dy, 140, tlMaxHeight()));
    applyLayoutVars();
  });
  const end = () => { if (st){ st = null; h.classList.remove('on'); saveSettings(); } };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { if (mq.matches) settings.mVideo = M_VIDEO; else settings.tlHeight = TL_H; applyLayoutVars(); saveSettings(); });
}
// 右のパネルの幅：左端をドラッグして変える（ダブルクリックで元に戻す）
(() => {
  const h = $('#sideResize');
  let st = null;
  // 動画の列に 400px 残す（css/komenagare.css の .layout と同じ）
  const maxW = () => {
    const l = $('#layout'), cs = getComputedStyle(l);
    return Math.max(300, l.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - parseFloat(cs.columnGap) - 400);
  };
  h.addEventListener('pointerdown', (e) => {
    // 今の見た目の幅から始める（画面が狭くて縮んでいるときも飛ばないように）
    st = { x: e.clientX, w: $('#side').getBoundingClientRect().width };
    h.setPointerCapture(e.pointerId); h.classList.add('on');
  });
  h.addEventListener('pointermove', (e) => {
    if (!st) return;
    settings.sideWidth = Math.round(clamp(st.w - (e.clientX - st.x), 300, maxW()));
    applyLayoutVars();
  });
  const end = () => { if (st){ st = null; h.classList.remove('on'); saveSettings(); } };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { settings.sideWidth = SIDE_W; applyLayoutVars(); saveSettings(); });
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
  $('#edSpeed').textContent = o.pos === 'naka' ? `流れる速さ ×${((DEFAULT_DURATION + NAKA_LEAD) / (d + NAKA_LEAD)).toFixed(2)}` : '';
}
function openEditDialog(c){
  editTarget = c;
  editBase = pickFields(c);
  $('#edTitle').textContent = 'コメントを編集';
  $('#edText').value = c.text;
  $('#edTime').value = fmtPrecise(c.t);
  $('#edCmd').value = c.cmd;
  $('#edDelete').hidden = false;
  edSync();
  editDlg.showModal();
  $('#edText').focus();
}
function openNewDialog(t, pos){
  editTarget = null;
  $('#edTitle').textContent = '新しいコメント';
  $('#edText').value = '';
  $('#edTime').value = fmtPrecise(t);
  $('#edCmd').value = pos ? setCmdPos(cmdInput.value, pos) : normCmd(cmdInput.value);
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
  if (!isFinite(t) || t < 0){ toast('開始時刻を 1:23.45 のような形式で入力してください', { type:'error' }); $('#edTime').focus(); return; }
  const text = $('#edText').value.replace(/\s+$/, '');
  if (!text.trim()){ toast('本文を入力してください', { type:'error' }); $('#edText').focus(); return; }
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
        if (key !== cur.key && store.hasKey(key)){ toast('同じ時刻・内容のコメントが既にあります', { type:'error' }); return; }
      }
      const conflicts = [];
      commitOps([{ type:'update', id, before: pickFields(base, changed), after: pickFields(f, changed) }], { conflicts });
      if (conflicts.length) conflict = { reason: conflicts[0].reason, id, base, mine: pickFields(f, changed) };
    }
    if (store.has(id)) TL.sel = new Set([id]);
  } else {
    const c = makeComment(t, cmd, text, true);
    if (store.hasKey(c.key)){ toast('同じ時刻・内容のコメントが既にあります', { type:'error' }); return; }
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
  '" コメナガレ ― 1行 = 1コメント   書式: 時刻 コマンド | 本文   （本文中の改行は \\n）',
  '" :w 反映  :q 閉じる  :e! 読み直し  :seek 再生位置へ  :now 再生位置に追加  :help ヘルプ',
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
  if (!m) return { error:'行頭に時刻（例 01:23.45）が必要です' };
  const t = parseTime(m[1]);
  if (!VIM_TIME_RE.test(m[1]) || !isFinite(t)) return { error:`時刻「${m[1]}」を解釈できません` };
  const rest = m[2], bar = rest.indexOf('|');
  let cmd = '', text;
  if (bar >= 0){ cmd = rest.slice(0, bar).trim(); text = rest.slice(bar + 1); if (text.startsWith(' ')) text = text.slice(1); }
  else text = rest.trim();
  text = text.replace(/\\(.)/g, (x, ch) => ch === 'n' ? '\n' : ch === 't' ? '\t' : ch);
  if (!text.trim()) return { error:'本文が空です' };
  return { t, cmd, text };
}
function vimWrite(text, force){
  if (!force && vim.synced !== state.version) return { ok:false, err:'E949: コメントは読み込み後に他の場所で変更されています（:w! で上書き、:e! で読み直し）' };
  const parsed = [], errors = [];
  text.split('\n').forEach((ln, i) => {
    const r = parseVimLine(ln);
    if (!r) return;
    if (r.error) errors.push({ line: i + 1, msg: r.error });
    else parsed.push(r);
  });
  if (errors.length) return { ok:false, err:`E: ${errors[0].line} 行目: ${errors[0].msg}` + (errors.length > 1 ? `（ほか ${errors.length - 1} 件）` : '') };
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
  return { ok:true, msg:`"コメント" ${next.length}件 反映しました（追加 ${added} / 削除 ${removed.length}${dup ? ` / 重複 ${dup}` : ''}）` };
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
    if (!state.videoLoaded) return 'E: 動画が開かれていません';
    let t;
    if (args){ t = parseTime(args); if (!isFinite(t)) return `E: 時刻「${args}」を解釈できません`; }
    else {
      const r = parseVimLine(ctx.line);
      if (!r || r.error) return 'E: この行には時刻がありません';
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
    'コメナガレ Vim エディタ                                   （Enter / q で閉じる）',
    '',
    '書式        時刻 コマンド | 本文       例) 01:23.45 ue red @5 | こんにちは',
    '            本文の改行は \\n 、\\ 自体は \\\\ 。" で始まる行と空行は無視されます。',
    '            表示時間はコマンドの @秒数。時刻の数字は Ctrl-a / Ctrl-x で増減できます。',
    '反映        :w（:w! 他所での変更を上書き） :wq :x ZZ   閉じる :q :q! ZQ   読み直し :e!',
    '独自        :seek [時刻] 動画をシーク   :now 再生位置で行を追加   :play 再生/一時停止',
    '',
    'モード      i a I A o O gi gI R s S C   v V Ctrl-v gv   :   / ?',
    '移動        h j k l  w b e ge W B E gE  0 ^ $ g_ |  f F t T ; ,  gg G H M L  % { } ( )',
    '            Ctrl-d u f b e y  zz zt zb  n N * # g* g#  m{a-z} `{a-z} \'{a-z}  Ctrl-o Ctrl-i',
    'オペレータ  d c y > < g~ gu gU g? = ＋ モーション／テキストオブジェクト（dd cc yy >> など）',
    '            iw aw iW aW is as ip ap i( a( ib i{ iB i[ i< i" i\' i`',
    '編集        x X D C Y p P gp gP ]p J gJ r ~ u U Ctrl-r . Ctrl-a Ctrl-x',
    'レジスタ    "a-z "A-Z "0-9 "- "_ "+ ". ": "/ "%    マクロ q{reg} … q  @{reg} @@ @:',
    '挿入モード  Ctrl-w Ctrl-u Ctrl-h Ctrl-r{reg} Ctrl-o Ctrl-a Ctrl-e Ctrl-y Ctrl-t Ctrl-d',
    '            Ctrl-v Ctrl-n Ctrl-p Insert',
    'ビジュアル  o O d x c s r y p P > < ~ u U J gJ I A : Ctrl-a Ctrl-x g Ctrl-a',
    'Ex          :s :& :&& :g :v :d :y :m :t :co :j :> :< :normal :sort :pu :k :mark',
    '            :noh :set :reg :marks :jumps :delm :p :nu := :undo :redo :retab',
    '            範囲  % . $ 数字 \'a \'<,\'> /pat/ ?pat? +n -n ;   区切り |',
    ':set        number relativenumber wrap ignorecase smartcase hlsearch incsearch',
    '            wrapscan shiftwidth expandtab tabstop joinspaces report',
    '',
    '注意        Ctrl-w / Ctrl-n / Ctrl-t などブラウザ予約キーは効かないことがあります。',
    '            ノーマルモードでは IME をオフにしてください（挿入モードの日本語入力は可）。',
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
    onChange: vimScheduleRender,
  });
  E.fileName = 'コメント';
  E.load(vimBufferText());
  E.setCursor(VIM_HEADER.length, 0);
  vim.synced = state.version;
  return E;
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
  $('#vimStatus').innerHTML = `<span class="grow">"${escHtml(E.fileName)}"${E.modified ? ' <span class="mod">[+]</span>' : ''}${stale ? ' <span class="stale">[他所で変更あり]</span>' : ''}</span>`
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
    if (e.key === 'Process' && !vimTakesIme()){ vim.E.msg = 'IME がオンになっています（ノーマルモードではオフにしてください）'; vim.E.msgErr = true; vimScheduleRender(); }
    return;
  }
  let tok = vimKeyToken(e);
  if (!tok) return;
  if (tok === '<C-s>') return;
  e.preventDefault();
  e.stopPropagation();
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
// 表示領域の高さ（スマホの縦持ちで動画の大きさを決める）。キーボードで縮んだ高さは使わない
let stableH = 0, stableTimer = 0;
const isTyping = () => { const el = document.activeElement; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)); };
function setStableHeight(h){ stableH = h; document.documentElement.style.setProperty('--stable-h', h + 'px'); }
function applyStableHeight(reset){
  if (reset || !stableH || innerHeight > stableH){ setStableHeight(innerHeight); return; }
  // 縮んだときは、しばらく待っても縮んだままで、入力中でもなければ測り直す。
  // キーボードは入力欄から離れたあとも閉じ切るまで時間がかかり、その間に測ると動画が細くなってしまうため
  clearTimeout(stableTimer);
  stableTimer = setTimeout(() => { if (!isTyping() && innerHeight < stableH) setStableHeight(innerHeight); }, 1000);
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
// キーボードが閉じたあと（入力欄から離れたあと）に測り直す
document.addEventListener('focusout', () => setTimeout(() => { applyStableHeight(false); resetStrayScroll(); }, 300));
window.visualViewport?.addEventListener('resize', () => { applyStableHeight(false); setTimeout(resetStrayScroll, 300); });
// タイムラインの高さの上限（PC の配置で、動画と右のパネルが潰れないように。窓を小さくしたときや iPad を回したときも）
function tlMaxHeight(){ return Math.max(140, innerHeight - ($('.topbar')?.offsetHeight || 0) - 340); }
function applyLayoutVars(){
  const root = document.documentElement.style;
  const tlH = Math.min(settings.tlHeight, tlMaxHeight());
  root.setProperty('--tl-h', tlH + 'px');
  root.setProperty('--tl-space', (!mq.matches && settings.timeline) ? tlH + 'px' : '0px');
  root.setProperty('--side-w', settings.sideWidth + 'px');
  root.setProperty('--m-video', settings.mVideo);
}
window.addEventListener('resize', applyLayoutVars);
function applyPanes(){
  const mobile = mq.matches;
  const pane = mobile ? (settings.mobilePane === 'timeline' ? 'list' : settings.mobilePane) : settings.sidePane;
  $('#paneList').hidden = pane !== 'list';
  $('#paneVim').hidden = pane !== 'vim';
  $('#paneHistory').hidden = pane !== 'history';
  document.body.dataset.mpane = settings.mobilePane;
  document.body.classList.toggle('tl-off', !settings.timeline);
  $('#btnTimeline').classList.toggle('on', settings.timeline);
  for (const b of document.querySelectorAll('.stab')) b.classList.toggle('on', b.dataset.pane === settings.sidePane);
  for (const b of document.querySelectorAll('.mtab')) b.classList.toggle('on', b.dataset.mpane === settings.mobilePane);
  applyLayoutVars();
  const vimShown = pane === 'vim' && (!mobile || settings.mobilePane === 'vim');
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
$('#btnTimeline').onclick = () => { settings.timeline = !settings.timeline; saveSettings(); applyPanes(); };
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
const COLLAB_PROTOCOL = 4;
const collab = {
  ws: null, connected: false, retry: 0, timer: 0, peers: [], outbox: [], db: null, saveTimer: 0, failed: 0,
  conflicts: [], // ほかの人の変更と重なって反映されなかった自分の変更（衝突の解決画面で選ぶ）
  shared: [], // 「あとで」にされてホストに預けられた衝突（全員のもの。author・client 付き）
  me: null, peerList: [], // 自分の接続 id と、参加者（{ id, name, client }）
  presence: new Map(), // 接続 id → { state, at }（ほかの人の再生位置・選択・カーソル）
  follow: null, // 追いかけている人の接続 id
  // 入り方（token: URL の k= / otp: 参加者ごとのワンタイムパスワード / none）
  auth: document.querySelector('meta[name="komenagare-host"]')?.dataset.auth || 'token',
  // 外から入るときの URL（ホストの --tunnel / --public-url。招待のリンクに使う。localhost で開いていても外の人に渡せるように）
  publicUrl: document.querySelector('meta[name="komenagare-host"]')?.dataset.publicUrl || '',
  session: null, // --otp のときのログイン（{ token, name, admin }。localStorage に控える）
  project: null, projects: [], // 開いているプロジェクト（{ id, name }）と、ホストにあるプロジェクトの一覧
  workspace: 'default', // 控え（IndexedDB）の名前に使う。プロジェクトの id
  owner: null, // このタブがこのプロジェクトを開いている間の id（衝突の控えをタブごとに分ける）
  serverName: null, // ホストが使っている自分の名前
  key: (() => {
    const k = new URLSearchParams(location.search).get('k');
    try { if (k) sessionStorage.setItem('komenagare.key', k); return k || sessionStorage.getItem('komenagare.key'); } catch { return k; }
  })(),
};
const collabLS = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} return null; };
function collabName(){ return collab.session?.name || collabLS('komenagare.name') || ''; }
function collabClientId(){
  let id = collabLS('komenagare.clientId');
  if (!isUuid(id)){ id = uuidv7(); collabLS('komenagare.clientId', id); }
  return id;
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
function collabSend(change){
  if (!state.collab || !change) return;
  const ch = { id: change.id, ops: change.ops.map(({ mine, ...op }) => op) };
  collab.outbox.push({ id: ch.id, seq: Date.now(), change: ch });
  collabTx('outbox', 'readwrite', s => s.put(collab.outbox[collab.outbox.length - 1])).catch(e => console.warn(e));
  collabSaveSoon();
  if (collab.connected) collab.ws.send(JSON.stringify({ type: 'change', change: ch }));
  collabUI();
}

function collabHello(){
  return { type: 'hello', protocol: COLLAB_PROTOCOL, name: collabName() || 'ゲスト', client: collabClientId(), session: collab.session?.token };
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
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } collabHandle(m); };
  ws.onclose = () => {
    if (collab.ws !== ws) return;
    if (collab.blocked){ collab.connected = false; collabUI(); return; }
    const was = collab.connected;
    collab.connected = false; collab.peers = []; collab.peerList = []; collab.presence.clear();
    if (collab.follow != null) collabUnfollow();
    presenceChanged();
    if (!was) collab.failed++;
    collabUI();
    collab.timer = setTimeout(collabConnect, Math.min(10000, 1000 * 2 ** Math.min(collab.retry++, 4)));
  };
}

function collabHandle(m){
  if (m.type === 'snapshot'){
    // ホストの内容に、まだ受け取り確認のない自分の変更を重ねてから送り直す
    const mine = new Set(store.comments.filter(c => c.mine).map(c => c.id));
    store.reset(m.comments.map(c => ({ ...c, mine: mine.has(c.id) })));
    for (const e of collab.outbox) store.apply(e.change);
    commentsChanged();
    collab.connected = true; collab.retry = 0; collab.failed = 0; collab.me = m.you ?? null; collab.serverName = m.name ?? null;
    for (const e of collab.outbox) collab.ws.send(JSON.stringify({ type: 'change', change: e.change }));
    collabShareConflicts();
    presence.sent = ''; presenceDirty();
    collabSaveSoon();
    collabUI();
    histChanged();
  } else if (m.type === 'change'){
    const r = store.apply(m.change);
    if (r.applied){ commentsChanged(); collabSaveSoon(); }
    if (hist.entries){ hist.entries.unshift({ rev: m.rev, time: m.time, author: m.author, change: m.change }); histRender(); }
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
  } else if (m.type === 'history'){
    hist.entries = m.entries || [];
    histRender();
  } else if (m.type === 'peers'){
    collab.peers = m.names || [];
    collab.peerList = m.peers || [];
    const ids = new Set(collab.peerList.map(p => p.id));
    for (const id of [...collab.presence.keys()]) if (!ids.has(id)) collab.presence.delete(id);
    if (collab.follow != null && !ids.has(collab.follow)) collabUnfollow('追いかけていた人が抜けました');
    collabUI(); presenceChanged();
  } else if (m.type === 'presence'){
    if (m.id === collab.me) return;
    collab.presence.set(m.id, { state: m.state || {}, at: performance.now() });
    presenceChanged();
    if (m.id === collab.follow) followApply(true);
  } else if (m.type === 'conflicts'){
    collab.shared = Array.isArray(m.list) ? m.list : [];
    // ホストに預けられたものは手元の控えから外す
    const keys = new Set(collab.shared.map(r => r.key));
    collab.conflicts = collab.conflicts.filter(r => !keys.has(r.key));
    conflictsChanged();
  } else if (m.type === 'error'){
    if (m.code === 'auth'){ collab.ws.close(); collabRelogin(); return; }
    if (m.code === 'project'){
      collab.blocked = 'project'; collab.ws.close();
      toast('ホスト: ' + m.message, { type:'error', timeout:6000 });
      projectsOpen();
      return;
    }
    toast('ホスト: ' + m.message, { type:'error', timeout: m.code === 'protocol' ? 20000 : 3800 });
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
  toast(`${added} 件の変更がほかの人の変更と重なったため、まだ反映していません`, { type:'error', timeout:10000, action:{ label:'確認する', fn: conflictOpen } });
}

function collabUI(){
  const el = $('#collabStatus');
  if (!el) return;
  el.hidden = !state.collab;
  const pending = collab.outbox.length;
  if (collab.connected){
    el.className = 'collab on';
    el.textContent = `● 共同編集 ${collab.peers.length}人` + (pending ? `（送信中 ${pending}）` : '');
    el.title = `参加者: ${collab.peers.join('、') || '—'}\nクリックで参加者の一覧（追いかける・表示名の変更）`;
  } else {
    el.className = 'collab off';
    const blocked = { protocol: '○ ページを再読み込みしてください', auth: '○ ログインしてください', project: '○ プロジェクトを選んでください' }[collab.blocked];
    el.textContent = (blocked || (collab.failed >= 3 ? '○ ホストに接続できません' : '○ オフライン')) + (pending ? `（未送信 ${pending}）` : '');
    el.title = (collab.failed >= 3 ? 'ホストが起動しているか、URL の k= が正しいか確認してください。' : 'ホストとの接続が切れています。') + '\n変更はこのブラウザに保存され、つながり直したら送られます。';
  }
}

/* ---------- ホストへの問い合わせ（合言葉・ログインを付ける） ---------- */
async function collabApi(path, body){
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (collab.session) headers.Authorization = 'Bearer ' + collab.session.token;
  const url = path + (collab.key ? (path.includes('?') ? '&' : '?') + 'k=' + encodeURIComponent(collab.key) : '');
  const r = await fetch(url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `ホストがエラーを返しました（${r.status}）`), { status: r.status });
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
  $('#loginErr').textContent = 'ログインし直してください（ホストの人に新しいワンタイムパスワードをもらってください）';
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
  $('#collabStatus').onclick = peersOpen;
  $('#projectBtn').onclick = () => projectsOpen();
  $('#projectBtn').hidden = false;
  $('#projectBtn').textContent = '📁 プロジェクト';
  $('#peersRename').onclick = () => {
    const n = prompt('共同編集で表示する名前', collabName());
    if (n == null) return;
    collabLS('komenagare.name', n.trim().slice(0, 40));
    if (collab.connected) collab.ws.send(JSON.stringify(collabHello()));
  };
  presence.ready = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (collab.auth === 'otp') await ensureLogin();
  else if (!collabName()){
    const n = prompt('共同編集で表示する名前を入力してください（コミットの作者名になります）', '');
    if (n && n.trim()) collabLS('komenagare.name', n.trim().slice(0, 40));
  }
  peersUI();
  collabUI();
  let list = null;
  try { list = await projectsFetch(); } catch (e) { toast('ホスト: ' + e.message, { type:'error', timeout:8000 }); }
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
  document.title = `${p.name} - コメナガレ`;
  $('#projectBtn').textContent = '📁 ' + p.name;
  store.reset([]);
  try {
    collab.db = await collabIdb();
    const [snap, outbox] = await Promise.all([collabTx('meta', 'readonly', s => s.get('snapshot')), collabTx('outbox', 'readonly', s => s.getAll())]);
    collab.outbox = (outbox || []).sort((a, b) => a.seq - b.seq);
    collab.conflicts = await loadConflicts();
    conflictsChanged();
    // 前回の控えをすぐに表示する（ホストにつながる前やオフラインでも作業できるように）
    if (snap && snap.comments) store.reset(snap.comments);
    for (const e of collab.outbox) store.apply(e.change);
  } catch (e) {
    console.warn('IndexedDB を使えません', e);
    toast('このブラウザに控えを保存できないため、オフラインの間の変更は失われることがあります', { type:'error', timeout:8000 });
  }
  commentsChanged();
  // このタブで前に開いていたなら、動画（再生位置）とタイムラインの表示（位置・拡大縮小・縦の位置）を戻す
  const v = projectVideos.get(p.id);
  if (v?.file){ state.viewRestore = v.view; loadVideo(v.file, { at: v.t }); } // 表示は動画の長さが分かってから戻す
  else {
    if (v?.view) tlRestoreView(v.view); else { TL.pendingView = null; tlResetView(); }
    const name = collabLS(VIDEO_HINT + p.id);
    if (name) toast(`このプロジェクトでは前に「${name}」を開いていました。動画を開き直してください`, { timeout: 6000 });
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
  // このプロジェクトで開いていた動画とタイムラインの表示を覚えて閉じる（このタブで戻ってきたら戻す）
  if (collab.project) projectVideos.set(collab.project.id, { file: state.videoFile, t: video.currentTime || 0, view: tlSaveView() });
  unloadVideo();
  const ws = collab.ws;
  collab.ws = null;
  clearTimeout(collab.timer); clearTimeout(collab.saveTimer); clearTimeout(presence.timer); presence.timer = 0;
  if (ws){ try { ws.close(); } catch {} }
  if (collab.db){ collabTx('meta', 'readwrite', s => s.put(collab.conflicts, 'conflicts:' + collab.owner)).catch(() => {}); }
  ownerRelease();
  const db = collab.db;
  setTimeout(() => db?.close(), 1000); // 書きかけの控えを書き終えてから閉じる
  Object.assign(collab, { db: null, connected: false, blocked: false, retry: 0, failed: 0, me: null, serverName: null,
    outbox: [], conflicts: [], shared: [], peers: [], peerList: [], follow: null, project: null });
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
  projectsFetch().then(projectsRender).catch(e => { $('#projectsList').replaceChildren(mkEl('p', 'muted', 'ホスト: ' + e.message)); });
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
  if (!collab.projects.length) frag.append(mkEl('p', 'muted', '読み込んでいます…'));
  for (const p of collab.projects){
    const cur = collab.project?.id === p.id;
    const row = mkEl('div', 'proj-row' + (cur ? ' on' : ''));
    const info = mkEl('div', 'proj-info');
    info.append(mkEl('div', 'proj-name', p.name + (cur ? '（このタブで開いています）' : '')));
    info.append(mkEl('div', 'proj-peers', p.peers?.length ? `${p.peers.length}人: ${p.peers.join('、')}` : 'だれもいません'));
    row.append(info);
    if (!cur){
      const b = mkEl('button', 'primary', '開く');
      b.onclick = () => {
        if (exportState.running){ toast('書き出し中はプロジェクトを切り替えられません', { type:'error' }); return; }
        const dlg = $('#projectsDlg'), done = dlg._done;
        dlg._done = null; projectsWait = null; dlg.dataset.required = '';
        dlg.close();
        if (done) done(p); else collabOpen(p); // 起動時の選択なら collabInit が開く
      };
      row.append(b);
    }
    const a = mkEl('a', 'btn', '新しいタブ');
    a.href = projectUrl(p); a.target = '_blank'; a.rel = 'noopener';
    row.append(a);
    frag.append(row);
  }
  $('#projectsList').replaceChildren(frag);
}
$('#projectsDlg').addEventListener('cancel', (e) => { if ($('#projectsDlg').dataset.required) e.preventDefault(); });
$('#projectsDlg').addEventListener('close', () => clearInterval(projectsTimer));
$('#projectsClose').onclick = () => $('#projectsDlg').close();
$('#projectsLogout').onclick = async () => {
  if (!confirm('ログアウトしますか？（もう一度入るには新しいワンタイムパスワードが要ります）')) return;
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
    const b = mkEl('button', null, '取り消す');
    b.onclick = async () => {
      if (!confirm(`${label} を取り消しますか？`)) return;
      try { await collabApi('/api/admin/revoke', { id }); } catch (e) { toast(e.message, { type:'error' }); }
      authRender();
    };
    return b;
  };
  frag.append(mkEl('h4', null, `ログイン中（${r.sessions.length}）`));
  for (const x of r.sessions){
    const row = mkEl('div', 'auth-row');
    row.append(mkEl('span', 'auth-name', x.name + (x.admin ? '（管理者）' : '') + (x.you ? '（あなた）' : '')), mkEl('span', 'muted', fmtDate(x.created) + ' から'));
    if (!x.you) row.append(revoke(x.id, `${x.name} のログイン`));
    frag.append(row);
  }
  frag.append(mkEl('h4', null, `未使用のワンタイムパスワード（${r.otps.length}）`));
  if (!r.otps.length) frag.append(mkEl('p', 'muted', 'ありません'));
  for (const x of r.otps){
    const row = mkEl('div', 'auth-row');
    row.append(mkEl('span', 'auth-name', x.name + (x.admin ? '（管理者）' : '')), mkEl('span', 'muted', (x.kind === 'numeric' ? '数字' : '英数字') + '・' + fmtDate(x.expires) + ' まで'), revoke(x.id, `${x.name} のワンタイムパスワード`));
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
    $('#authExpires').textContent = `${name} 用・${fmtDate(r.expires)} まで・1回だけ使えます`;
    $('#authResult').hidden = false;
    $('#authName').value = '';
    authRender();
  } catch (err) { toast(err.message, { type:'error' }); }
});
$('#authCopy').onclick = () => { const v = $('#authLink').value; (navigator.clipboard?.writeText(v) || Promise.reject()).then(() => toast('リンクをコピーしました', { timeout:1500 }), () => { $('#authLink').select(); document.execCommand('copy'); }); };
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
  state.changeLog.push({ time: Date.now(), author: state.collab ? (collabName() || 'ゲスト') : 'あなた', change: ch });
  if (state.changeLog.length > 1000) state.changeLog.splice(0, state.changeLog.length - 1000);
  histChanged();
}
const histShown = () => !$('#paneHistory').hidden;
function histChanged(){ if (histShown()){ clearTimeout(hist.timer); hist.timer = setTimeout(histRefresh, 120); } }
function histRefresh(){
  if (state.collab && collab.connected) collab.ws.send(JSON.stringify({ type: 'history', limit: 300 }));
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
  const kind = { add: '追加', update: '変更', delete: '削除' }[op.type];
  line.append(mkEl('span', 'k ' + op.type, kind));
  if (op.type === 'add' || op.type === 'delete'){
    const f = op.type === 'add' ? op.after : op.before;
    line.append(`「${clip(f.text)}」 ${fmtPrecise(f.t ?? 0)}` + (f.cmd ? ` [${f.cmd}]` : ''));
    return line;
  }
  const name = op.after.text ?? op.before.text ?? store.get(op.id)?.text;
  line.append(name != null ? `「${clip(name, 24)}」 ` : '');
  const label = { t: '時刻', cmd: 'コマンド', text: '本文' };
  const show = (k, v) => k === 't' ? fmtPrecise(v ?? 0) : k === 'text' ? `「${clip(v, 24)}」` : (v || '（なし）');
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
  let items, note;
  if (state.collab){
    const me = collabName() || 'ゲスト';
    items = [...collab.outbox.slice().reverse().map(e => ({ change: e.change, author: me, time: e.seq, pending: true })), ...(hist.entries || [])];
    note = collab.connected ? 'ホストに記録された全員の変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。'
      : 'ホストにつながっていないため、前回取得した履歴を表示しています。';
  } else {
    items = state.changeLog.slice().reverse();
    note = 'この画面を開いてからの変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。komenagare でホストすると全員の変更が記録されます。';
  }
  $('#histNote').textContent = note;
  $('#histCount').textContent = items.length ? `${items.length}件` : '';
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 300)){
    const box = mkEl('div', 'hist-item' + (it.pending ? ' pending' : ''));
    const meta = mkEl('div', 'hist-meta');
    meta.append(mkEl('span', null, histTime(it.time)), mkEl('b', null, it.author || ''));
    if (it.rev) meta.append(mkEl('span', null, '#' + it.rev));
    if (it.pending) meta.append(mkEl('span', null, '未送信'));
    meta.append(mkEl('span', 'spacer'));
    const target = it.change.ops.map(op => store.get(op.id)).find(Boolean);
    if (target){
      const go = mkEl('button', null, '移動');
      go.title = 'このコメントの時刻へ移動して選ぶ';
      go.onclick = () => { seekTo(target.t); TL.sel = new Set([target.id]); tlEnsureVisible(target); tlSelChanged(); };
      meta.append(go);
    }
    if (!it.pending){
      const undo = mkEl('button', null, '取り消す');
      undo.title = 'この変更を打ち消す変更を加える';
      undo.onclick = () => { if (revertChange(it.change)) toast('変更を取り消しました'); };
      meta.append(undo);
    }
    box.append(meta);
    for (const op of it.change.ops.slice(0, 5)) box.append(histOpLine(op));
    if (it.change.ops.length > 5) box.append(mkEl('div', 'hist-op muted', `ほか ${it.change.ops.length - 5} 件`));
    frag.append(box);
  }
  if (!items.length) frag.append(mkEl('p', 'muted hist-note', 'まだ変更はありません。'));
  list.replaceChildren(frag);
}

/* ---------- 衝突の解決（共同編集） ---------- */
const CONFLICT_WHY = {
  'modified:update': 'ほかの人が先に同じ項目を変更していました',
  'deleted:update': 'ほかの人が先に削除していました',
  'modified:delete': 'あなたは削除しようとしましたが、ほかの人が先に変更していました',
  'exists:add': '同じ id のコメントが既にありました',
};
const allConflicts = () => [...collab.conflicts, ...collab.shared];
// 自分の変更か（ホストに預けたものも、同じブラウザから出したものなら自分の分）
const conflictOwn = (rec) => !rec.author || rec.client === collabClientId();
// 今の内容（ホストに預けた衝突はあとから変わっていることがあるので、いつも今の値を見る）
const conflictNow = (rec) => { const c = store.get(rec.id); return c ? pickFields(c) : null; };
function conflictActions(rec){
  const own = conflictOwn(rec), who = own ? 'あなた' : rec.author;
  if (rec.opType === 'update' && conflictNow(rec)) return [['mine', `${who}の変更にする`], ['keep', own ? '相手のままにする' : '今のままにする'], ['both', '両方残す']];
  if (rec.opType === 'update') return [['mine', `${who}の内容で復活させる`], ['keep', '削除のままにする']];
  if (rec.opType === 'delete') return [['mine', 'それでも削除する'], ['keep', '残す']];
  return [['both', '新しいコメントとして追加する'], ['keep', '追加しない']];
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
  collab.ws.send(JSON.stringify({ type: 'conflict_add', conflicts: recs.map(({ share, ...r }) => r) }));
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
      if (r.failed){ toast('同じ時刻・内容のコメントが既にあるため変更できません', { type:'error' }); return; }
      ops = r.ops;
    } else ops = [{ type:'add', id: rec.id, after: { t: rec.mine.t, cmd: rec.mine.cmd, text: rec.mine.text }, mine: true }];
  } else if (action === 'both'){
    const c = makeComment(rec.mine.t, rec.mine.cmd, rec.mine.text, true);
    if (store.hasKey(c.key)){ toast('同じ時刻・内容のコメントが既にあります', { type:'error' }); return; }
    ops = [addOp(c)];
  }
  if (ops.length) commitOps(ops);
  conflictDrop([rec]);
}
function conflictsChanged(){
  if (collab.owner) collabTx('meta', 'readwrite', s => s.put(collab.conflicts, 'conflicts:' + collab.owner)).catch(e => console.warn(e));
  const n = allConflicts().length;
  for (const b of [$('#conflictBtn'), $('#histConflicts')]){ b.hidden = !n; b.textContent = `⚠ 衝突 ${n}`; }
  if ($('#conflictDlg').open){ if (n) conflictRender(); else $('#conflictDlg').close(); }
}
function conflictRender(){
  const label = { t: '時刻', cmd: 'コマンド', text: '本文' };
  const show = (k, v) => k === 't' ? fmtPrecise(v ?? 0) : (v || '（なし）');
  const frag = document.createDocumentFragment();
  for (const rec of allConflicts()){
    const box = mkEl('div', 'cf-item');
    const own = conflictOwn(rec), now = conflictNow(rec);
    const base = now || rec.mine || {};
    box.append(mkEl('div', 'cf-title', `「${clip(base.text, 60)}」 ${fmtPrecise(base.t ?? 0)}`));
    const why = CONFLICT_WHY[`${rec.reason}:${rec.opType}`] || 'ほかの人の変更と重なりました';
    box.append(mkEl('div', 'cf-why', own ? why : `${rec.author} の変更：${why.replace(/^あなたは/, '')}`));
    if (rec.author || rec.share) box.append(mkEl('div', 'cf-shared', own ? 'ほかの参加者にも表示しています' : `${rec.author} が「あとで」にしたものです。誰が選んでもかまいません`));
    // 3-way：元の値（共通の祖先）・あなた・相手（今の内容）を並べ、どれかが違う項目だけ出す
    const table = mkEl('table', 'cf-table');
    const cols = [];
    if (rec.base) cols.push(['元の値', rec.base, '（なし）']);
    cols.push([own ? 'あなた' : rec.author, rec.mine, '（削除）'], [own ? '相手（今の内容）' : '今の内容', now, '（削除済み）']);
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
// ほかの人の今の再生位置（再生中なら、届いてからの時間だけ進める）
function peerTime(pr){
  const s = pr.state;
  if (typeof s.t !== 'number') return null;
  return s.playing ? s.t + (performance.now() - pr.at) / 1000 * (s.rate || 1) : s.t;
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
    const p = peerOf(id), t = peerTime(pr);
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
    const p = peerOf(id), cur = pr.state.cur;
    if (p && cur && cur.a === 'st') items.push([p, cur]);
  }
  const els = syncEls($('#peerCursors'), items.length, () => {
    const el = mkEl('div', 'peer-cursor');
    el.innerHTML = '<svg width="14" height="18" viewBox="0 0 14 18"><path d="M1 1v14l4-4h7z" fill="currentColor" stroke="rgba(0,0,0,.6)"/></svg><span></span>';
    return el;
  });
  items.forEach(([p, cur], i) => {
    const el = els[i];
    el.style.left = (canvas.offsetLeft + cur.x * canvas.offsetWidth) + 'px';
    el.style.top = (canvas.offsetTop + cur.y * canvas.offsetHeight) + 'px';
    el.style.setProperty('--peer', peerColor(p));
    el.lastChild.textContent = p.name;
  });
}
function listMarkPeers(){
  for (const row of listPeerRows) row.classList.remove('peer-sel');
  listPeerRows = [];
  if (!state.collab) return;
  for (const [id, pr] of collab.presence){
    const p = peerOf(id);
    if (!p) continue;
    for (const cid of pr.state.sel || []){
      const row = listRowOf.get(cid);
      if (!row) continue;
      row.classList.add('peer-sel'); row.style.setProperty('--peer', peerColor(p));
      listPeerRows.push(row);
    }
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
      const c = store.get(cid), pos = c && TL.laneOf.get(cid);
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
    const t = peerTime(pr);
    if (t != null){
      const x = tx(t);
      if (x >= TL_HEAD - 5 && x <= W + 5){
        g.fillStyle = peerColor(p, 0.5); g.fillRect(Math.round(x) - 0.5, TL_RULER, 1.5, H);
        g.fillStyle = peerColor(p, 0.9);
        g.beginPath(); g.moveTo(x - 4, TL_RULER - 9); g.lineTo(x + 4, TL_RULER - 9); g.lineTo(x, TL_RULER - 1); g.closePath(); g.fill();
      }
    }
    const cur = pr.state.cur;
    if (cur && cur.a === 'tl'){
      const x = tx(cur.t), y = TL_RULER + tlLaneToY(cur.y) - TL.scrollY;
      if (x >= TL_HEAD && x <= W && y >= TL_RULER && y <= H) tlDrawCursor(g, x, y, p);
    }
  }
  g.restore();
}
// 全体表示：ほかの人の再生位置（自分の再生位置より下に、その人の色で）
function tlDrawOverviewPeers(g, H){
  if (!state.collab || !collab.presence.size) return;
  for (const [id, pr] of collab.presence){
    const p = peerOf(id), t = p && peerTime(pr);
    if (t == null) continue;
    const x = ovX(t);
    g.fillStyle = peerColor(p, 0.9); g.fillRect(x - 1, 0, 2, H);
    g.beginPath(); g.moveTo(x - 4, 0); g.lineTo(x + 4, 0); g.lineTo(x, 5); g.closePath(); g.fill();
  }
}
function tlDrawCursor(g, x, y, p){
  g.fillStyle = peerColor(p); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 14); g.lineTo(x + 4, y + 10); g.lineTo(x + 10, y + 10); g.closePath(); g.fill(); g.stroke();
  const label = clip(p.name, 12), w = g.measureText(label).width + 8;
  g.fillStyle = peerColor(p, 0.9); rr(g, x + 8, y + 12, w, 14, 3); g.fill();
  g.fillStyle = '#111'; g.fillText(label, x + 12, y + 19.5);
}

/* ---------- 参加者の一覧と追いかける ---------- */
function presenceText(s, t = s.t){
  if (typeof t !== 'number') return '—';
  const parts = [(s.playing ? '再生中 ' : '停止中 ') + fmt(t)];
  if (s.sel && s.sel.length) parts.push(`${s.sel.length} 件選択中`);
  return parts.join('　');
}
function peersRender(){
  const frag = document.createDocumentFragment();
  presence.dlgRows.clear();
  if (!collab.connected) frag.append(mkEl('p', 'muted', 'ホストにつながっていません'));
  for (const p of collab.peerList){
    const me = p.id === collab.me, on = collab.follow === p.id;
    const row = mkEl('div', 'peer-row' + (on ? ' on' : ''));
    row.style.setProperty('--peer', peerColor(p));
    const info = mkEl('div', 'peer-info'), st = mkEl('div', 'peer-state');
    info.append(mkEl('div', 'peer-name', p.name + (me ? '（あなた）' : p.client === collabClientId() ? '（あなた・別のタブ）' : '')), st);
    row.append(mkEl('span', 'peer-dot'), info);
    if (!me){
      const b = mkEl('button', on ? 'primary' : null, on ? '追いかけるのをやめる' : '追いかける');
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
    el.textContent = id === collab.me ? presenceText(presenceState()) : pr ? presenceText(pr.state, peerTime(pr)) : '—';
  }
}
function peersOpen(){ peersRender(); if (!$('#peersDlg').open) $('#peersDlg').showModal(); }
$('#peersClose').onclick = () => $('#peersDlg').close();

function collabFollow(id){
  if (id == null || id === collab.me) return collabUnfollow();
  collab.follow = id;
  followUI();
  followApply();
}
function collabUnfollow(msg){
  if (collab.follow == null) return;
  collab.follow = null;
  followUI();
  if (msg) toast(msg, { timeout: 2500 });
}
function followUI(){
  const p = collab.follow != null ? peerOf(collab.follow) : null;
  $('#followBar').hidden = !p;
  $('#player').classList.toggle('following', !!p);
  if (p){ $('#player').style.setProperty('--peer', peerColor(p)); $('#followName').textContent = p.name; }
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
  if (collab.follow == null || e.ctrlKey || e.metaKey || e.altKey || ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
  collabUnfollow();
}, true);

/* =====================================================================
   設定UI・ショートカット・その他
   ===================================================================== */
$('#setOpacity').value = settings.opacity;
const applyLetterbox = () => { document.documentElement.style.setProperty('--letterbox', settings.letterbox); $('#setLetterbox').value = settings.letterbox; };
applyLetterbox();
$('#setLetterbox').oninput = (e) => { settings.letterbox = e.target.value; saveSettings(); applyLetterbox(); };
$('#setLetterboxReset').onclick = () => { settings.letterbox = '#000000'; saveSettings(); applyLetterbox(); };
$('#setPause').checked = settings.pauseOnInput;
$('#setBorder').checked = settings.mineBorder;
$('#setAutosave').checked = settings.autosave;
$('#setFormat').value = settings.saveFormat;
$('#setOpacity').oninput = (e) => { settings.opacity = +e.target.value; saveSettings(); state.needsDraw = true; };
$('#setPause').onchange = (e) => { settings.pauseOnInput = e.target.checked; saveSettings(); };
$('#setBorder').onchange = (e) => { settings.mineBorder = e.target.checked; saveSettings(); displayRenderer.reset(); state.needsDraw = true; };
$('#setAutosave').onchange = (e) => { settings.autosave = e.target.checked; saveSettings(); updateStatus(); };
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
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (inField) return;
  if (document.querySelector('dialog[open]')) return;
  switch (e.key){
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
      if (/^[0-9]$/.test(e.key) && !e.shiftKey){
        const p = settings.presets[e.key === '0' ? 9 : +e.key - 1];
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

resizeCanvas();
renderList();
updateStatus();
autoGrow();
tlRelane();
renderPresets();
updateUndoUI();
tlSelChanged();
applyPanes();
collabInit();
requestAnimationFrame(loop);
})();
