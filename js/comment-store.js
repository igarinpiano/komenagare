'use strict';
/* =====================================================================
   コメントの保管と変更（DOM 非依存。Node からも require できる）

   コメントの追加・変更・削除はすべて「変更セット」で行う。
     変更セット: { id, ops: [op, ...] }
     op: { type: 'add',    id, after:  { t, cmd, text } }
         { type: 'update', id, before: { 変える項目の元の値 }, after: { 新しい値 } }
         { type: 'delete', id, before: { t, cmd, text } }
   op には元の値（before）が入っているので、他の人の変更と重なったかどうかを
   git の 3-way マージのように項目ごとに判定できる（apply の conflicts）。
   ===================================================================== */
const COMMENT_FIELDS = ['t', 'cmd', 'text'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// UUID v7（先頭 48 ビットがミリ秒の時刻なので、作った順に並ぶ）。同じミリ秒内でも順序を保つ
const uuidv7 = (() => {
  let lastMs = -1, seq = 0;
  const hex = [];
  for (let i = 0; i < 256; i++) hex.push((i + 0x100).toString(16).slice(1));
  return function uuidv7(){
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    let ms = Date.now();
    if (ms > lastMs){ lastMs = ms; seq = ((b[6] & 0x07) << 8) | b[7]; } // 12 ビットの連番を乱数から始める（上位 1 ビットは余裕として 0）
    else if (++seq > 0xfff){ lastMs++; seq = 0; }
    ms = lastMs;
    b[0] = Math.floor(ms / 2 ** 40) & 0xff; b[1] = Math.floor(ms / 2 ** 32) & 0xff;
    b[2] = (ms >>> 24) & 0xff; b[3] = (ms >>> 16) & 0xff; b[4] = (ms >>> 8) & 0xff; b[5] = ms & 0xff;
    b[6] = 0x70 | (seq >> 8); b[7] = seq & 0xff;
    b[8] = 0x80 | (b[8] & 0x3f);
    let s = '';
    for (let i = 0; i < 16; i++){ s += hex[b[i]]; if (i === 3 || i === 5 || i === 7 || i === 9) s += '-'; }
    return s;
  };
})();
const isUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

// 同じ時刻・コマンド・本文のコメントを見分けるためのキー
function commentKey(t, cmd, text){ return `${Math.round(t * 100)}\u0001${cmd}\u0001${text}`; }
function cmpComments(a, b){ return a.t - b.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); }
const pickFields = (c, fields = COMMENT_FIELDS) => { const o = {}; for (const f of fields) o[f] = c[f]; return o; };

// 変更セットを打ち消す変更セット（元に戻す・リバート用）
function invertChange(ch){
  const ops = ch.ops.slice().reverse().map(op =>
    op.type === 'add' ? { type: 'delete', id: op.id, before: { ...op.after }, mine: op.mine }
    : op.type === 'delete' ? { type: 'add', id: op.id, after: { ...op.before }, mine: op.mine }
    : { type: 'update', id: op.id, before: { ...op.after }, after: { ...op.before } });
  return { id: uuidv7(), ops, revertOf: ch.id };
}

class CommentStore {
  constructor(){
    this.byId = new Map();
    this.keyCount = new Map();   // キー → 件数（同じ内容が既にあるかの判定用）
    this.deletedKeys = new Set(); // この作業中に削除した内容（ファイルを取り込み直しても復活させない）
    this.list = [];               // 時刻順に並べたコメント
    this.version = 0;
    this.log = [];                // 適用した変更セットの記録（新しいものが後ろ）
  }
  get comments(){ return this.list; }
  get size(){ return this.byId.size; }
  get(id){ return this.byId.get(id); }
  has(id){ return this.byId.has(id); }
  hasKey(key){ return (this.keyCount.get(key) || 0) > 0; }
  sort(){ this.list.sort(cmpComments); }

  // すべて入れ替える（ファイルを開いたとき）。記録は残さない
  reset(items = []){
    this.byId.clear(); this.keyCount.clear(); this.deletedKeys.clear(); this.list = []; this.log = [];
    for (const it of items) this._insert(it.id, it, it.mine);
    this.sort();
    this.version++;
  }

  /* 変更セットを適用する。
     各 op は元の値（before）と今の値を比べ、項目ごとに次のように扱う（git の 3-way マージと同じ考え方）。
       今の値 = 元の値   → 新しい値にする
       今の値 = 新しい値 → もう同じなので何もしない
       それ以外           → 衝突（その項目は変えない）
     atomic: true なら、衝突が1つでもあれば何も変えない。
     戻り値: { applied: 実際に適用した op だけの変更セット（何も変わらなければ null）, conflicts } */
  apply(change, { atomic = false } = {}){
    const conflicts = [], plan = [];
    // 同じ変更セットの中で前の op が変えたものを後の op から見えるようにする（まだ本体には入れない）
    const view = new Map();
    const look = (id) => view.has(id) ? view.get(id) : this.byId.get(id);
    for (const op of change.ops){
      const cur = look(op.id), planned = plan.length;
      this._plan(op, cur, plan, conflicts);
      if (plan.length > planned){
        const p = plan[planned];
        view.set(op.id, p.type === 'delete' ? undefined : { ...(cur || {}), ...p.after });
      }
    }
    if ((atomic && conflicts.length) || !plan.length) return { applied: null, conflicts };
    for (const op of plan){
      if (op.type === 'add') this._insert(op.id, op.after, op.mine);
      else if (op.type === 'delete') this._remove(op.id);
      else this._update(op.id, op.after);
    }
    this.sort();
    this.version++;
    const applied = { ...change, ops: plan };
    this.log.push(applied);
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
    return { applied, conflicts };
  }

  // 1つの op を今の値（cur）と比べ、適用するものは plan に、衝突は conflicts に入れる
  _plan(op, cur, plan, conflicts){
    if (op.type === 'add'){
      if (!cur){ plan.push(op); return; }
      const diff = COMMENT_FIELDS.filter(f => cur[f] !== op.after[f]);
      if (diff.length) conflicts.push({ op, reason: 'exists', fields: diff, ours: pickFields(cur), theirs: { ...op.after } });
    } else if (op.type === 'delete'){
      if (!cur) return; // もう削除されている
      const diff = COMMENT_FIELDS.filter(f => f in op.before && cur[f] !== op.before[f]);
      if (diff.length) conflicts.push({ op, reason: 'modified', fields: diff, ours: pickFields(cur), base: { ...op.before } });
      else plan.push({ ...op, before: pickFields(cur), mine: cur.mine });
    } else if (op.type === 'update'){
      if (!cur){ conflicts.push({ op, reason: 'deleted', fields: Object.keys(op.after) }); return; }
      const after = {}, bad = [];
      for (const f of Object.keys(op.after)){
        if (!COMMENT_FIELDS.includes(f)) continue;
        if (cur[f] === op.after[f]) continue;
        if (!(f in op.before) || cur[f] === op.before[f]) after[f] = op.after[f];
        else bad.push(f);
      }
      if (bad.length) conflicts.push({ op, reason: 'modified', fields: bad, ours: pickFields(cur, bad), base: pickFields(op.before, bad), theirs: pickFields(op.after, bad) });
      if (Object.keys(after).length) plan.push({ type: 'update', id: op.id, before: pickFields(cur, Object.keys(after)), after });
    } else throw new Error('unknown op: ' + op.type);
  }

  _insert(id, f, mine = false){
    const c = { id, t: f.t, cmd: f.cmd, text: f.text, key: commentKey(f.t, f.cmd, f.text), mine: !!mine };
    this.byId.set(id, c);
    this.list.push(c);
    this.keyCount.set(c.key, (this.keyCount.get(c.key) || 0) + 1);
    this.deletedKeys.delete(c.key);
    return c;
  }
  _remove(id){
    const c = this.byId.get(id);
    this.byId.delete(id);
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
    this._dropKey(c.key);
    this.deletedKeys.add(c.key);
  }
  _update(id, after){
    const c = this.byId.get(id);
    Object.assign(c, after);
    const key = commentKey(c.t, c.cmd, c.text);
    if (key !== c.key){ this._dropKey(c.key); this.deletedKeys.add(c.key); c.key = key; this.keyCount.set(key, (this.keyCount.get(key) || 0) + 1); this.deletedKeys.delete(key); }
  }
  _dropKey(key){ const n = (this.keyCount.get(key) || 0) - 1; if (n > 0) this.keyCount.set(key, n); else this.keyCount.delete(key); }
}

if (typeof module !== 'undefined') module.exports = { CommentStore, uuidv7, isUuid, commentKey, cmpComments, invertChange, COMMENT_FIELDS };
