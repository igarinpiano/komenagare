'use strict';
/* =====================================================================
   Vim エンジン（DOM 非依存）
   ===================================================================== */
function createVimEngine(hooks = {}){
  const INC = 'INC', BAD = 'BAD';
  class VimError extends Error {}
  const err = (m) => { throw new VimError(m); };

  let L = [''];
  const cur = { line:0, col:0 };
  let want = 0;
  const opts = {
    number:true, relativenumber:false, wrap:true, ignorecase:false, smartcase:false, hlsearch:true,
    incsearch:true, wrapscan:true, shiftwidth:2, expandtab:false, tabstop:8, scrolloff:0, report:2, joinspaces:false,
  };
  const OPT_ALIAS = { nu:'number', rnu:'relativenumber', ic:'ignorecase', scs:'smartcase', hls:'hlsearch', is:'incsearch',
    ws:'wrapscan', sw:'shiftwidth', et:'expandtab', ts:'tabstop', so:'scrolloff', js:'joinspaces' };
  const E = {
    cur, opts, mode:'normal', vmode:null, vstart:null, top:0, rows:20,
    msg:'', msgErr:false, more:null, cmd:null, showcmd:'', recording:null, hlOff:false, incMatch:null,
    oneShot:false, fileName:'comments',
  };

  /* ---------- 文字ユーティリティ ---------- */
  const isHi = (c) => c >= 0xD800 && c <= 0xDBFF, isLo = (c) => c >= 0xDC00 && c <= 0xDFFF;
  const nx = (s, i) => i >= s.length ? s.length : (isHi(s.charCodeAt(i)) && isLo(s.charCodeAt(i + 1)) ? i + 2 : i + 1);
  const pv = (s, i) => i <= 0 ? 0 : (i >= 2 && isLo(s.charCodeAt(i - 1)) && isHi(s.charCodeAt(i - 2)) ? i - 2 : i - 1);
  const lastCol = (s) => s.length ? pv(s, s.length) : 0;
  const chAt = (s, i) => i < s.length ? s.slice(i, nx(s, i)) : '';
  const isWs = (ch) => ch === ' ' || ch === '\t';
  const isKw = (ch) => !!ch && utfClass(ch.codePointAt(0)) >= 2;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cmpPos = (a, b) => a.line - b.line || a.col - b.col;
  const P = (line, col) => ({ line, col });
  function fnbRaw(line){ const s = L[line] ?? ''; let i = 0; while (i < s.length && isWs(s[i])) i++; return i; }
  function fnb(line){ return Math.min(fnbRaw(line), lastCol(L[line] ?? '')); }
  function utfClass(c){
    if (c === 0 || c === 32 || c === 9 || c === 0xa0 || c === 0x3000) return 0;
    if (c < 0x100){
      if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || (c >= 0xc0 && c !== 0xd7 && c !== 0xf7)) return 2;
      return 1;
    }
    if (c >= 0x2000 && c <= 0x200b) return 0;
    if (c >= 0x2070 && c <= 0x207f) return 0x2070;
    if (c >= 0x2080 && c <= 0x2094) return 0x2080;
    if (c >= 0x2600 && c <= 0x27bf) return 3;
    if (c >= 0x200c && c <= 0x2bff) return 1;
    if (c >= 0x2e00 && c <= 0x2e7f) return 1;
    if ((c >= 0x3001 && c <= 0x3020) || c === 0x3030 || c === 0x303d) return 1;
    if (c >= 0x3040 && c <= 0x309f) return 0x3040;
    if (c >= 0x30a0 && c <= 0x30ff) return 0x30a0;
    if (c >= 0x3300 && c <= 0x9fff) return 0x4e00;
    if (c >= 0xac00 && c <= 0xd7a3) return 0xac00;
    if (c >= 0xf900 && c <= 0xfaff) return 0x4e00;
    if (c >= 0xfe30 && c <= 0xfe6b) return 1;
    if ((c >= 0xff00 && c <= 0xff0f) || (c >= 0xff1a && c <= 0xff20) || (c >= 0xff3b && c <= 0xff40) || (c >= 0xff5b && c <= 0xff65)) return 1;
    if (c >= 0x1f000 && c <= 0x1faff) return 3;
    if (c >= 0x20000 && c <= 0x2fa1f) return 0x4e00;
    return 2;
  }
  let bigword = false;
  function clsP(p){
    const s = L[p.line];
    if (p.col >= s.length) return 0;
    const c = utfClass(s.codePointAt(p.col));
    return c !== 0 && bigword ? 1 : c;
  }
  function inc(p){
    const s = L[p.line];
    if (p.col < s.length){ p.col = nx(s, p.col); return p.col < s.length ? 0 : 2; }
    if (p.line < L.length - 1){ p.line++; p.col = 0; return 1; }
    return -1;
  }
  function dec(p){
    if (p.col > 0){ p.col = pv(L[p.line], Math.min(p.col, L[p.line].length)); return 0; }
    if (p.line > 0){ p.line--; p.col = L[p.line].length; return 1; }
    return -1;
  }
  const lineEmpty = (l) => L[l].length === 0;

  /* ---------- マーク・ジャンプ ---------- */
  const marks = Object.create(null);
  let jumps = [], jumpIdx = 0, gMarks = null;
  function forEachMark(fn){
    for (const k in marks) fn(marks[k], k);
    for (const j of jumps) fn(j);
    if (gMarks) for (const m of gMarks) fn(m);
    if (lastVisual){ fn(lastVisual.start); fn(lastVisual.end); }
  }
  function cleanGoneMarks(){ for (const k in marks) if (marks[k].gone && /[a-z]/.test(k)) delete marks[k]; }
  function pushJump(){
    jumps = jumps.slice(0, jumpIdx).filter(j => j.line !== cur.line);
    jumps.push(P(cur.line, cur.col));
    if (jumps.length > 100) jumps.shift();
    jumpIdx = jumps.length;
    marks["'"] = P(cur.line, cur.col);
  }

  /* ---------- 元に戻す ---------- */
  let undoStack = [], redoStack = [], inChange = false, ver = 0, verSeq = 0, savedVer = 0;
  function dirty(){
    if (inChange) return;
    undoStack.push({ lines: L.slice(), cur: P(cur.line, cur.col), ver, time: Date.now() });
    if (undoStack.length > 1000) undoStack.shift();
    redoStack = [];
    inChange = true;
    ver = ++verSeq;
  }
  function endChange(){
    if (!inChange) return;
    inChange = false;
    const top = undoStack[undoStack.length - 1];
    if (top && top.lines.length === L.length && top.lines.every((s, i) => s === L[i])){ undoStack.pop(); ver = top.ver; }
  }
  function ago(t){
    const s = Math.round((Date.now() - t) / 1000);
    return s < 100 ? `${s} second${s === 1 ? '' : 's'} ago` : new Date(t).toLocaleTimeString();
  }
  function lineDiffMsg(before, after, tail){
    const d = after - before;
    const head = d > 0 ? `${d} more line${d > 1 ? 's' : ''}` : d < 0 ? `${-d} line${d < -1 ? 's' : ''} less` : '1 change';
    return `${head}; ${tail}`;
  }
  function undo(n = 1){
    endChange();
    for (let i = 0; i < n; i++){
      const s = undoStack.pop();
      if (!s){ if (i === 0) setMsg('Already at oldest change'); break; }
      redoStack.push({ lines: L, cur: P(cur.line, cur.col), ver, time: s.time });
      const before = L.length;
      L = s.lines; ver = s.ver;
      setCur(Math.min(s.cur.line, L.length - 1), s.cur.col);
      setMsg(lineDiffMsg(before, L.length, `before #${undoStack.length + 1}  ${ago(s.time)}`));
    }
    clampCur();
  }
  function redo(n = 1){
    endChange();
    for (let i = 0; i < n; i++){
      const s = redoStack.pop();
      if (!s){ if (i === 0) setMsg('Already at newest change'); break; }
      undoStack.push({ lines: L, cur: P(cur.line, cur.col), ver, time: Date.now() });
      const before = L.length;
      L = s.lines; ver = s.ver;
      setCur(Math.min(s.cur.line, L.length - 1), s.cur.col);
      setMsg(lineDiffMsg(before, L.length, `after #${undoStack.length}  ${ago(s.time)}`));
    }
    clampCur();
  }

  /* ---------- バッファ編集の基本操作 ---------- */
  function getText(sl, sc, el, ec){
    if (sl === el) return L[sl].slice(sc, ec);
    return [L[sl].slice(sc), ...L.slice(sl + 1, el), L[el].slice(0, ec)].join('\n');
  }
  // [sl:sc, el:ec) を text で置き換え。挿入テキスト末尾の位置を返す
  function edit(sl, sc, el, ec, text){
    dirty();
    const parts = (L[sl].slice(0, sc) + text + L[el].slice(ec)).split('\n');
    const removed = el - sl + 1, delta = parts.length - removed;
    L.splice(sl, removed, ...parts);
    forEachMark(m => {
      if (m.line > el) m.line += delta;
      else if (m.line > sl && m.line < sl + parts.length && m.line <= el){ /* 残る */ }
      else if (m.line > sl){ m.line = sl; m.gone = true; }
    });
    const tp = text.split('\n');
    marks['['] = P(sl, sc);
    const end = P(sl + tp.length - 1, (tp.length === 1 ? sc : 0) + tp[tp.length - 1].length);
    marks[']'] = P(end.line, Math.max(0, end.col - 1));
    marks['.'] = P(sl, sc);
    return end;
  }
  function deleteLines(a, b){
    dirty();
    const n = b - a + 1;
    if (n >= L.length){ L = ['']; forEachMark(m => { m.line = 0; m.col = 0; m.gone = true; }); marks['.'] = P(0, 0); return; }
    L.splice(a, n);
    forEachMark(m => { if (m.line > b) m.line -= n; else if (m.line >= a){ m.gone = true; m.line = Math.min(a, L.length - 1); } });
    marks['.'] = P(Math.min(a, L.length - 1), 0);
  }
  function insertLines(at, arr){
    dirty();
    L.splice(at, 0, ...arr);
    forEachMark(m => { if (m.line >= at) m.line += arr.length; });
    marks['['] = P(at, 0); marks[']'] = P(at + arr.length - 1, 0); marks['.'] = P(at, 0);
  }
  function setLine(l, s){ if (L[l] !== s) edit(l, 0, l, L[l].length, s); }

  /* ---------- カーソル ---------- */
  function isInsertLike(){ return E.mode === 'insert' || E.mode === 'replace'; }
  function clampCur(){
    cur.line = clamp(cur.line, 0, L.length - 1);
    const s = L[cur.line];
    const max = isInsertLike() ? s.length : lastCol(s);
    cur.col = clamp(cur.col, 0, max);
    if (cur.col > 0 && cur.col < s.length && isLo(s.charCodeAt(cur.col)) && isHi(s.charCodeAt(cur.col - 1))) cur.col--;
  }
  function setCur(line, col){ cur.line = line; cur.col = col; clampCur(); }
  function colFromWant(line){
    const s = L[line];
    if (want === Infinity) return isInsertLike() ? s.length : lastCol(s);
    let i = 0, n = 0;
    while (n < want && i < s.length){ i = nx(s, i); n++; }
    return Math.min(i, isInsertLike() ? s.length : lastCol(s));
  }
  function wantFromCol(){ const s = L[cur.line]; let n = 0; for (let i = 0; i < cur.col && i < s.length; i = nx(s, i)) n++; want = n; }

  /* ---------- メッセージ ---------- */
  function setMsg(m, isErr = false){ E.msg = m; E.msgErr = isErr; }
  function bell(){ abortMacro = true; hooks.bell?.(); }
  let outBuf = null;
  function out(line){ if (outBuf) outBuf.push(line); else setMsg(line); }

  /* ---------- レジスタ ---------- */
  const regs = Object.create(null);
  const macros = Object.create(null);
  let lastInserted = '', lastEx = '', lastExForAt = '';
  const validReg = (r) => typeof r === 'string' && /^[a-zA-Z0-9"\-_.:+*\/%]$/.test(r);
  function writeReg(name, text, type, isYank){
    if (name === '_') return;
    let val = { text, type };
    if (name && /[A-Z]/.test(name)){
      const old = regs[name.toLowerCase()];
      if (old){
        val = (old.type === 'l' || type === 'l') ? { text: old.text + '\n' + text, type:'l' } : { text: old.text + text, type: old.type };
      }
      name = name.toLowerCase();
    }
    if (name && name !== '"'){
      regs[name] = val;
      if (name === '+' || name === '*'){ regs['+'] = regs['*'] = val; hooks.clipboardWrite?.(type === 'l' ? text + '\n' : text); }
    } else if (isYank) regs['0'] = val;
    else if (type === 'l' || text.includes('\n')){
      for (let i = 9; i > 1; i--) if (regs[i - 1]) regs[i] = regs[i - 1];
      regs['1'] = val;
    } else regs['-'] = val;
    if (name && /[a-z]/.test(name)) delete macros[name];
    regs['"'] = val;
  }
  function readReg(name){
    name = (name || '"');
    if (/[A-Z]/.test(name)) name = name.toLowerCase();
    if (name === '.') return { text: lastInserted, type:'c' };
    if (name === ':') return { text: lastEx, type:'c' };
    if (name === '/') return { text: lastSearch ? lastSearch.pat : '', type:'c' };
    if (name === '%') return { text: E.fileName, type:'c' };
    if (name === '_') return { text:'', type:'c' };
    return regs[name] || null;
  }

  /* ---------- 検索 ---------- */
  let lastSearch = null; // {pat, dir, off}
  let lastFind = null;   // {key, ch}
  function escRe(s){ return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }
  const KWC = '[0-9A-Za-z_\\u00c0-\\uffff]';
  const KW_START = `(?<!${KWC})(?=${KWC})`, KW_END = `(?<=${KWC})(?!${KWC})`;
  const POSIX = { alpha:'A-Za-z', digit:'0-9', alnum:'0-9A-Za-z', lower:'a-z', upper:'A-Z', space:'\\s', blank:' \\t', punct:'!-\\/:-@\\[-`{-~', xdigit:'0-9A-Fa-f', print:' -~', cntrl:'\\x00-\\x1f' };
  function vimToJs(p){
    let o = '', i = 0, ic = null, vm = false;
    const brace = (inner) => {
      let lazy = false;
      if (inner.startsWith('-')){ lazy = true; inner = inner.slice(1); }
      return (inner === '' ? '*' : '{' + inner + '}') + (lazy ? '?' : '');
    };
    while (i < p.length){
      const ch = p[i];
      if (ch === '\\' && i + 1 < p.length){
        const n = p[i + 1]; i += 2;
        if (n === 'c'){ ic = true; continue; }
        if (n === 'C'){ ic = false; continue; }
        if (n === 'v'){ vm = true; continue; }
        if (n === 'm' || n === 'M' || n === 'V'){ vm = false; continue; }
        if (vm && '()|+?={}<>='.includes(n)){ o += '\\' + n; continue; }
        switch (n){
          case '(': o += '('; break;
          case ')': o += ')'; break;
          case '%': if (p[i] === '('){ o += '(?:'; i++; } else o += '%'; break;
          case '|': o += '|'; break;
          case '+': o += '+'; break;
          case '=': case '?': o += '?'; break;
          case '{': { let j = p.indexOf('}', i); if (j < 0){ o += '\\{'; break; } let inner = p.slice(i, j); if (inner.endsWith('\\')) inner = inner.slice(0, -1); i = j + 1; o += brace(inner); break; }
          case '<': o += KW_START; break;
          case '>': o += KW_END; break;
          case 'n': o += '\\n'; break;
          case 't': o += '\\t'; break;
          case 'e': o += '\\x1b'; break;
          case 'r': o += '\\r'; break;
          case 'd': case 'D': case 'w': case 'W': case 's': case 'S': o += '\\' + n; break;
          case 'a': o += '[A-Za-z]'; break;
          case 'A': o += '[^A-Za-z]'; break;
          case 'l': o += '[a-z]'; break;
          case 'L': o += '[^a-z]'; break;
          case 'u': o += '[A-Z]'; break;
          case 'U': o += '[^A-Z]'; break;
          case 'x': o += '[0-9A-Fa-f]'; break;
          case 'X': o += '[^0-9A-Fa-f]'; break;
          case 'o': o += '[0-7]'; break;
          case 'O': o += '[^0-7]'; break;
          case 'h': o += '[A-Za-z_]'; break;
          case 'H': o += '[^A-Za-z_]'; break;
          case 'k': case 'i': case 'f': o += '[0-9A-Za-z_\\u00c0-\\uffff]'; break;
          case 'K': case 'I': case 'F': o += '[A-Za-z_\\u00c0-\\uffff]'; break;
          case 'p': o += '[^\\x00-\\x1f]'; break;
          case 'z': if (p[i] === 's' || p[i] === 'e') i++; break;
          default: o += /[0-9]/.test(n) ? '\\' + n : escRe(n);
        }
        continue;
      }
      i++;
      if (vm){
        if (ch === '<' || ch === '>'){ o += ch === '<' ? KW_START : KW_END; continue; }
        if (ch === '='){ o += '?'; continue; }
        if (ch === '{'){ const j = p.indexOf('}', i); if (j >= 0){ o += brace(p.slice(i, j)); i = j + 1; continue; } }
        if (ch === '%' && p[i] === '('){ o += '(?:'; i++; continue; }
        o += ch === '/' ? '\\/' : ch;
        continue;
      }
      switch (ch){
        case '(': case ')': case '|': case '+': case '?': case '{': case '}': o += '\\' + ch; break;
        case '[': {
          let j = i; if (p[j] === '^') j++; if (p[j] === ']') j++;
          while (j < p.length && p[j] !== ']'){ if (p[j] === '\\') j++; else if (p[j] === '[' && p[j + 1] === ':'){ const k = p.indexOf(':]', j + 2); if (k > 0) j = k + 1; } j++; }
          if (j >= p.length){ o += '\\['; break; }
          let body = p.slice(i, j).replace(/\[:(\w+):\]/g, (m, n) => POSIX[n] ?? m);
          body = body.replace(/(^|[^\\])\[/g, '$1\\[');
          o += '[' + body + ']'; i = j + 1; break;
        }
        case '~': o += escRe(lastRep); break;
        default: o += ch;
      }
    }
    return { src:o, ic };
  }
  function compile(pat, flags = ''){
    const { src, ic } = vimToJs(pat);
    let ignore = ic ?? (opts.ignorecase && !(opts.smartcase && /[A-Z]/.test(pat.replace(/\\./g, ''))));
    if (flags.includes('i')) ignore = true;
    if (flags.includes('I')) ignore = false;
    try { return new RegExp(src, 'g' + (ignore ? 'i' : '')); }
    catch { err(`E383: Invalid search string: ${pat}`); }
  }
  function matchesIn(re, s){
    const out = []; re.lastIndex = 0; let m;
    while ((m = re.exec(s))){
      out.push([m.index, m[0].length]);
      if (m[0].length === 0){ if (re.lastIndex >= s.length) break; re.lastIndex = m.index + 1; }
    }
    return out;
  }
  function searchFrom(re, from, dir, wrap = opts.wrapscan, acceptAt = false){
    const n = L.length;
    if (dir > 0){
      for (let k = 0; k <= n; k++){
        const l = (from.line + k) % n;
        if (!wrap && from.line + k >= n) break;
        const ms = matchesIn(re, L[l]);
        for (const [i, len] of ms){
          if (k === 0 && (acceptAt ? i < from.col : i <= from.col)) continue;
          if (k === n && i > from.col) continue;
          return { line:l, col:i, len, wrapped: from.line + k >= n };
        }
      }
    } else {
      for (let k = 0; k <= n; k++){
        const l = ((from.line - k) % n + n) % n;
        if (!wrap && from.line - k < 0) break;
        const ms = matchesIn(re, L[l]);
        for (let j = ms.length - 1; j >= 0; j--){
          const [i, len] = ms[j];
          if (k === 0 && i >= from.col) continue;
          if (k === n && i < from.col) continue;
          return { line:l, col:i, len, wrapped: from.line - k < 0 };
        }
      }
    }
    return null;
  }
  E.searchRe = () => {
    if (!lastSearch || E.hlOff || !opts.hlsearch) return null;
    try { return compile(lastSearch.pat); } catch { return null; }
  };
  E.matchesIn = matchesIn;
  function doSearch(pat, dir, count, offStr, forMotion){
    if (pat === '' || pat == null){
      if (!lastSearch) err('E35: No previous regular expression');
      pat = lastSearch.pat;
      if (offStr == null) offStr = lastSearch.off;
    }
    lastSearch = { pat, dir, off: offStr || '' };
    E.hlOff = false;
    return searchMotion(dir, count, forMotion);
  }
  function searchMotion(dir, count, forMotion){
    if (!lastSearch) err('E35: No previous regular expression');
    const re = compile(lastSearch.pat);
    const off = parseOffset(lastSearch.off);
    let p = P(cur.line, cur.col), hit = null, wrapped = false;
    if (off.type === 'e' && dir > 0){ /* 終端オフセット時は現在位置から */ }
    for (let i = 0; i < Math.max(1, count); i++){
      hit = searchFrom(re, p, dir);
      if (!hit){
        err(opts.wrapscan ? `E486: Pattern not found: ${lastSearch.pat}` : `E${dir > 0 ? 385 : 384}: Search hit ${dir > 0 ? 'BOTTOM' : 'TOP'} without match for: ${lastSearch.pat}`);
      }
      if (hit.wrapped) wrapped = true;
      p = P(hit.line, off.type === 'e' && i < count - 1 ? hit.col : hit.col);
    }
    if (wrapped) setMsg(dir > 0 ? 'search hit BOTTOM, continuing at TOP' : 'search hit TOP, continuing at BOTTOM', true);
    else if (!forMotion) setMsg((dir > 0 ? '/' : '?') + lastSearch.pat + (lastSearch.off ? (dir > 0 ? '/' : '?') + lastSearch.off : ''));
    if (off.type === 'line') return { line: clamp(hit.line + off.n, 0, L.length - 1), col: fnb(clamp(hit.line + off.n, 0, L.length - 1)), type:'line', jump:true };
    let col = hit.col, type = 'excl';
    if (off.type === 'e'){ col = hit.col + Math.max(0, hit.len - 1); col = moveChars(hit.line, col, off.n); type = 'incl'; }
    else if (off.type === 's'){ col = moveChars(hit.line, hit.col, off.n); if (off.n > 0) type = 'incl'; }
    return { line: hit.line, col, type, jump:true };
  }
  function moveChars(line, col, n){
    const s = L[line];
    while (n > 0 && col < s.length){ col = nx(s, col); n--; }
    while (n < 0 && col > 0){ col = pv(s, col); n++; }
    return Math.min(col, s.length);
  }
  function parseOffset(s){
    s = s || '';
    let m;
    if ((m = /^([es]|b)([+-]\d*)?$/.exec(s))) return { type: m[1] === 'b' ? 's' : m[1], n: m[2] ? (m[2].length === 1 ? (m[2] === '+' ? 1 : -1) : parseInt(m[2], 10)) : 0 };
    if ((m = /^([+-]?)(\d*)$/.exec(s)) && s !== ''){ const n = m[2] ? parseInt(m[2], 10) : 1; return { type:'line', n: m[1] === '-' ? -n : n }; }
    return { type:'none', n:0 };
  }
  function splitPattern(s, delim){
    // 区切り文字までのパターンと残りを返す（\ でエスケープ可）
    let i = 0, inBr = false;
    for (; i < s.length; i++){
      const ch = s[i];
      if (ch === '\\'){ i++; continue; }
      if (ch === '[' && !inBr){ inBr = s.indexOf(']', i + 2) > 0; continue; }
      if (ch === ']' && inBr){ inBr = false; continue; }
      if (ch === delim && !inBr) return [s.slice(0, i).split('\\' + delim).join(delim), s.slice(i + 1), true];
    }
    return [s.split('\\' + delim).join(delim), '', false];
  }
  function wordUnderCursor(){
    const s = L[cur.line];
    let i = cur.col;
    while (i < s.length && !isKw(chAt(s, i))) i = nx(s, i);
    if (i >= s.length){ i = cur.col; while (i < s.length && isWs(s[i])) i++; if (i >= s.length) return null; }
    const kw = isKw(chAt(s, i));
    const ok = (j) => j < s.length && (kw ? isKw(chAt(s, j)) && utfClass(s.codePointAt(j)) === utfClass(s.codePointAt(i)) : !isWs(s[j]) && !isKw(chAt(s, j)));
    let a = i; while (a > 0 && ok(pv(s, a))) a = pv(s, a);
    let b = i; while (b < s.length && ok(b)) b = nx(s, b);
    return { text: s.slice(a, b), start: a, end: b, kw };
  }

  /* ---------- 単語移動（Vim の search.c / textobject.c を移植） ---------- */
  function fwdWord(p, count, big, eol){
    bigword = big;
    while (--count >= 0){
      const sclass = clsP(p);
      const lastLine = p.line === L.length - 1;
      let i = inc(p);
      if (i === -1 || (i >= 1 && lastLine)) return false;
      if (i >= 1 && eol && count === 0) return true;
      if (sclass !== 0){
        while (clsP(p) === sclass){ i = inc(p); if (i === -1 || (i >= 1 && eol && count === 0)) return true; }
      }
      while (clsP(p) === 0){
        if (p.col === 0 && lineEmpty(p.line)) break;
        i = inc(p); if (i === -1 || (i >= 1 && eol && count === 0)) return true;
      }
    }
    return true;
  }
  function skipChars(p, cclass, dir){
    while (clsP(p) === cclass) if ((dir > 0 ? inc(p) : dec(p)) === -1) return true;
    return false;
  }
  function bckWord(p, count, big, stop){
    bigword = big;
    while (--count >= 0){
      const sclass = clsP(p);
      if (dec(p) === -1) return false;
      let finished = false;
      if (!stop || sclass === clsP(p) || sclass === 0){
        let hitStart = false;
        while (clsP(p) === 0){
          if (p.col === 0 && lineEmpty(p.line)){ finished = true; break; }
          if (dec(p) === -1){ hitStart = true; break; }
        }
        if (hitStart) return true;
        if (!finished && skipChars(p, clsP(p), -1)) return true;
      }
      if (!finished) inc(p);
      stop = false;
    }
    return true;
  }
  function endWord(p, count, big, stop, empty){
    bigword = big;
    while (--count >= 0){
      const sclass = clsP(p);
      if (inc(p) === -1) return false;
      let finished = false;
      if (clsP(p) === sclass && sclass !== 0){
        if (skipChars(p, sclass, 1)) return false;
      } else if (!stop || sclass === 0){
        while (clsP(p) === 0){
          if (p.col === 0 && lineEmpty(p.line) && empty){ finished = true; break; }
          if (inc(p) === -1) return false;
        }
        if (!finished && skipChars(p, clsP(p), 1)) return false;
      }
      if (!finished) dec(p);
      stop = false;
    }
    return true;
  }
  function bckendWord(p, count, big, eol){
    bigword = big;
    while (--count >= 0){
      const sclass = clsP(p);
      let i;
      if ((i = dec(p)) === -1) return false;
      if (eol && i === 1) return true;
      if (sclass !== 0){
        while (clsP(p) === sclass) if ((i = dec(p)) === -1 || (eol && i === 1)) return true;
      }
      while (clsP(p) === 0){
        if (p.col === 0 && lineEmpty(p.line)) break;
        if ((i = dec(p)) === -1 || (eol && i === 1)) return true;
      }
    }
    return true;
  }

  /* ---------- 文移動（簡易） ---------- */
  const SENT_END = '.!?。！？';
  const SENT_CLOSE = ')]"\'」』）】';
  function isSentStart(p){
    const s = L[p.line];
    if (s.length === 0) return p.col === 0;
    if (p.col >= s.length || isWs(s[p.col])) return false;
    // 直前の非空白まで戻る
    const q = P(p.line, p.col);
    let sawWs = false;
    for (;;){
      const r = dec(q);
      if (r === -1) return true;
      if (r === 1){ sawWs = true; if (lineEmpty(q.line)) return true; continue; }
      const ch = chAt(L[q.line], q.col);
      if (ch === '' || isWs(ch)){ sawWs = true; continue; }
      if (!sawWs) return false;
      let k = P(q.line, q.col);
      while (SENT_CLOSE.includes(chAt(L[k.line], k.col))){ if (dec(k) !== 0) return false; }
      return SENT_END.includes(chAt(L[k.line], k.col));
    }
  }
  function sentence(dir, count){
    const p = P(cur.line, cur.col);
    for (let n = 0; n < count; n++){
      for (;;){
        const r = dir > 0 ? inc(p) : dec(p);
        if (r === -1){ if (dir > 0){ p.col = lastCol(L[p.line]); } return p; }
        if (p.col < L[p.line].length || L[p.line].length === 0) if (isSentStart(p)) break;
      }
    }
    return p;
  }

  /* ---------- 括弧 ---------- */
  function scanFwd(from, fn){
    for (let l = from.line; l < L.length; l++){
      const s = L[l];
      for (let c = l === from.line ? from.col : 0; c < s.length; c++){ const r = fn(s[c], l, c); if (r) return r; }
    }
    return null;
  }
  function scanBack(from, fn){
    for (let l = from.line; l >= 0; l--){
      const s = L[l];
      for (let c = l === from.line ? Math.min(from.col, s.length - 1) : s.length - 1; c >= 0; c--){ const r = fn(s[c], l, c); if (r) return r; }
    }
    return null;
  }
  function matchBracket(pos, ch){
    const PAIRS = '()[]{}';
    const idx = PAIRS.indexOf(ch); if (idx < 0) return null;
    const open = idx % 2 === 0, mate = PAIRS[open ? idx + 1 : idx - 1];
    let depth = 0;
    if (open) return scanFwd(pos, (c, l, k) => { if (c === ch) depth++; else if (c === mate && --depth === 0) return P(l, k); });
    return scanBack(pos, (c, l, k) => { if (c === ch) depth++; else if (c === mate && --depth === 0) return P(l, k); });
  }
  function findOpen(open, close, from, count){
    let p = from, res = null;
    for (let n = 0; n < count; n++){
      let depth = 0;
      res = scanBack(p, (c, l, k) => { if (c === close) depth++; else if (c === open){ if (depth === 0) return P(l, k); depth--; } });
      if (!res) return null;
      p = P(res.line, res.col - 1);
      if (p.col < 0){ if (res.line === 0) { if (n < count - 1) return null; break; } p = P(res.line - 1, L[res.line - 1].length); }
    }
    return res;
  }

  /* ---------- モーション ---------- */
  const MOTION1 = new Set(['h','l','j','k','w','W','b','B','e','E','0','^','$','|','G','H','M','L','{','}','(',')','%','n','N','*','#',';',',','+','-','_',
    '<CR>','<Left>','<Right>','<Up>','<Down>','<Home>','<End>','<BS>','<Space>',' ','<C-h>','<C-j>','<C-n>','<C-p>','<C-m>','<S-Left>','<S-Right>','<C-Left>','<C-Right>']);
  const MOTION_ARG = new Set(['f','F','t','T',"'",'`']);
  const GMOTION = new Set(['g','e','E','_','j','k','0','^','$','m','M','*','#','o','<Down>','<Up>','<End>','<Home>']);
  const TEXTOBJ = new Set(['w','W','s','p','(',')','b','[',']','{','}','B','<','>','"',"'",'`']);

  function motion(m, count, ctx = {}){
    const n1 = count || 1, op = !!ctx.op;
    const s = L[cur.line];
    const p = P(cur.line, cur.col);
    const res = (line, col, type, extra) => Object.assign({ line, col, type }, extra);
    switch (m.key){
      case 'h': case '<Left>': case '<C-h>': {
        if (cur.col === 0) return null;
        let c = cur.col; for (let i = 0; i < n1 && c > 0; i++) c = pv(s, c);
        return res(cur.line, c, 'excl');
      }
      case '<BS>': {
        for (let i = 0; i < n1; i++){ if (p.col > 0) p.col = pv(L[p.line], p.col); else if (p.line > 0){ p.line--; p.col = op ? L[p.line].length : lastCol(L[p.line]); } else if (i === 0) return null; }
        return res(p.line, p.col, 'excl');
      }
      case 'l': case '<Right>': {
        const lim = op || E.mode === 'visual' ? s.length : lastCol(s);
        if (cur.col >= lim) return op && s.length ? res(cur.line, s.length, 'excl') : null;
        let c = cur.col; for (let i = 0; i < n1 && c < lim; i++) c = nx(s, c);
        return res(cur.line, Math.min(c, lim), 'excl');
      }
      case ' ': case '<Space>': {
        for (let i = 0; i < n1; i++){
          const t = L[p.line];
          if (nx(t, p.col) < t.length || (op && p.col < t.length)) p.col = nx(t, p.col);
          else if (p.line < L.length - 1){ p.line++; p.col = 0; }
          else if (i === 0) return null;
        }
        return res(p.line, p.col, 'excl');
      }
      case 'j': case '<Down>': case '<C-j>': case '<C-n>': case 'gj': case 'g<Down>': {
        if (cur.line >= L.length - 1) return null;
        const l = Math.min(L.length - 1, cur.line + n1);
        return res(l, colFromWant(l), 'line', { keepWant:true });
      }
      case 'k': case '<Up>': case '<C-p>': case 'gk': case 'g<Up>': {
        if (cur.line === 0) return null;
        const l = Math.max(0, cur.line - n1);
        return res(l, colFromWant(l), 'line', { keepWant:true });
      }
      case '+': case '<CR>': case '<C-m>': {
        if (cur.line + n1 > L.length - 1) return null;
        return res(cur.line + n1, fnb(cur.line + n1), 'line');
      }
      case '-': {
        if (cur.line - n1 < 0) return null;
        return res(cur.line - n1, fnb(cur.line - n1), 'line');
      }
      case '_': { const l = Math.min(L.length - 1, cur.line + n1 - 1); return res(l, fnb(l), 'line'); }
      case '0': case '<Home>': case 'g0': case 'g<Home>': return res(cur.line, 0, 'excl');
      case '^': case 'g^': return res(cur.line, fnb(cur.line), 'excl');
      case '$': case '<End>': case 'g$': case 'g<End>': {
        const l = Math.min(L.length - 1, cur.line + n1 - 1);
        return res(l, op ? Math.max(0, L[l].length - (L[l].length ? (L[l].length - lastCol(L[l])) : 0)) : lastCol(L[l]), 'incl', { want: Infinity });
      }
      case 'g_': {
        const l = Math.min(L.length - 1, cur.line + n1 - 1);
        const t = L[l]; let c = t.length; while (c > 0 && isWs(t[c - 1])) c--;
        return res(l, Math.max(0, pv(t, c)), 'incl');
      }
      case 'gm': case 'gM': { const t = L[cur.line]; return res(cur.line, Math.min(lastCol(t), Math.floor(t.length / 2)), 'excl'); }
      case '|': {
        let c = 0; for (let i = 1; i < n1 && c < s.length; i++) c = nx(s, c);
        return res(cur.line, Math.min(c, lastCol(s)), 'excl', { want: n1 - 1 });
      }
      case 'w': case 'W': case '<S-Right>': case '<C-Right>': {
        const big = m.key !== 'w' && m.key !== '<S-Right>';
        if (ctx.op === 'c' && !ctx.forced){
          const ch = chAt(s, cur.col);
          if (ch !== '' && !isWs(ch)){ endWord(p, n1, big, true, false); return res(p.line, p.col, 'incl'); }
        }
        const ok = fwdWord(p, n1, big, op);
        if (!ok && !op && p.line === cur.line && p.col === cur.col) return null;
        if (!op && p.col >= L[p.line].length && L[p.line].length) p.col = lastCol(L[p.line]);
        return res(p.line, p.col, 'excl');
      }
      case 'b': case 'B': case '<S-Left>': case '<C-Left>': {
        if (!bckWord(p, n1, m.key === 'B' || m.key === '<C-Left>', false)) return null;
        return res(p.line, Math.min(p.col, op ? L[p.line].length : lastCol(L[p.line])), 'excl');
      }
      case 'e': case 'E': {
        if (!endWord(p, n1, m.key === 'E', false, false)){ if (p.line === cur.line && p.col === cur.col) return null; }
        return res(p.line, Math.min(p.col, lastCol(L[p.line])), 'incl');
      }
      case 'ge': case 'gE': {
        if (!bckendWord(p, n1, m.key === 'gE', false)) return null;
        return res(p.line, Math.min(p.col, lastCol(L[p.line])), 'incl');
      }
      case 'f': case 'F': case 't': case 'T': case ';': case ',': {
        let key = m.key, ch = m.arg, rep = false;
        if (key === ';' || key === ','){
          if (!lastFind) return null;
          rep = true; ch = lastFind.ch; key = lastFind.key;
          if (m.key === ',') key = { f:'F', F:'f', t:'T', T:'t' }[key];
        } else lastFind = { key, ch };
        const fwd = key === 'f' || key === 't';
        let c = cur.col;
        for (let i = 0; i < n1; i++){
          let start = fwd ? nx(s, c) : pv(s, c);
          if (rep && i === 0 && (key === 't' || key === 'T')) start = fwd ? nx(s, start) : pv(s, start);
          let found = -1;
          if (fwd){ for (let j = start; j < s.length; j = nx(s, j)) if (s.startsWith(ch, j)){ found = j; break; } }
          else if (c > 0){ for (let j = start; j >= 0; j = j ? pv(s, j) : -1){ if (s.startsWith(ch, j)){ found = j; break; } if (j === 0) break; } }
          if (found < 0) return null;
          c = found;
        }
        if (key === 't') c = pv(s, c);
        if (key === 'T') c = nx(s, c);
        return res(cur.line, c, fwd ? 'incl' : 'excl');
      }
      case 'gg': case 'G': {
        const l = count ? clamp(count - 1, 0, L.length - 1) : (m.key === 'G' ? L.length - 1 : 0);
        return res(l, fnb(l), 'line', { jump:true });
      }
      case 'H': case 'L': case 'M': {
        const vis = Math.max(1, Math.min(E.rows, L.length - E.top));
        let l;
        if (m.key === 'H') l = E.top + Math.min(vis - 1, n1 - 1);
        else if (m.key === 'L') l = E.top + Math.max(0, vis - n1);
        else l = E.top + Math.floor((vis - 1) / 2);
        l = clamp(l, 0, L.length - 1);
        return res(l, fnb(l), 'line', { jump:true });
      }
      case '}': case '{': {
        const dir = m.key === '}' ? 1 : -1;
        let currL = cur.line;
        for (let n = n1; n > 0; n--){
          let didSkip = false;
          for (let first = true; ; first = false){
            if (!lineEmpty(currL)) didSkip = true;
            if (!first && didSkip && lineEmpty(currL)) break;
            currL += dir;
            if (currL < 0 || currL >= L.length){
              if (n > 1) return null;
              currL -= dir; break;
            }
          }
        }
        if (currL === cur.line && (dir < 0 ? cur.col === 0 : cur.col >= lastCol(L[currL]))) return null;
        if (currL === L.length - 1 && dir > 0 && L[currL].length) return res(currL, lastCol(L[currL]), 'incl', { jump:true });
        return res(currL, 0, 'excl', { jump:true });
      }
      case '(': case ')': { const q = sentence(m.key === ')' ? 1 : -1, n1); return res(q.line, Math.min(q.col, op ? L[q.line].length : lastCol(L[q.line])), 'excl', { jump:true }); }
      case '%': {
        if (count){ if (count > 100) return null; const l = clamp(Math.ceil(count * L.length / 100) - 1, 0, L.length - 1); return res(l, fnb(l), 'line', { jump:true }); }
        let i = cur.col; while (i < s.length && !'()[]{}'.includes(s[i])) i++;
        if (i >= s.length) return null;
        const q = matchBracket(P(cur.line, i), s[i]);
        return q ? res(q.line, q.col, 'incl', { jump:true }) : null;
      }
      case 'n': case 'N': {
        if (!lastSearch) err('E35: No previous regular expression');
        const dir = m.key === 'n' ? lastSearch.dir : -lastSearch.dir;
        E.hlOff = false;
        return searchMotion(dir, n1, op);
      }
      case '*': case '#': case 'g*': case 'g#': {
        const w = wordUnderCursor();
        if (!w) err('E348: No string under cursor');
        const whole = m.key.length === 1 && w.kw;
        const pat = (whole ? '\\<' : '') + w.text.replace(/[\\\/.*$^~\[\]]/g, '\\$&') + (whole ? '\\>' : '');
        cur.col = w.start;
        lastSearch = { pat, dir: m.key.endsWith('*') ? 1 : -1, off:'' };
        E.hlOff = false;
        pushHist('/', pat);
        return searchMotion(lastSearch.dir, n1, op);
      }
      case "'": case '`': {
        const mk = getMark(m.arg);
        if (!mk) err('E20: Mark not set');
        const l = clamp(mk.line, 0, L.length - 1);
        if (m.key === "'") return res(l, fnb(l), 'line', { jump:true });
        return res(l, Math.min(mk.col, op ? L[l].length : lastCol(L[l])), 'excl', { jump:true });
      }
      case 'go': { let rem = Math.max(0, n1 - 1), l = 0; while (l < L.length - 1 && rem > L[l].length){ rem -= L[l].length + 1; l++; } return res(l, Math.min(rem, lastCol(L[l])), 'excl', { jump:true }); }
    }
    return null;
  }
  function getMark(ch){
    if (ch === '`') ch = "'";
    if (ch === "'") return marks["'"] || P(0, 0);
    const m = marks[ch];
    return m && !m.gone ? m : null;
  }

  /* ---------- テキストオブジェクト ---------- */
  function textObject(obj, around, count){
    const n1 = count || 1;
    switch (obj){
      case 'w': case 'W': return objWord(around, n1, obj === 'W');
      case 'p': return objPara(around, n1);
      case 's': return objSentence(around);
      case '"': case "'": case '`': return objQuote(obj, around);
      case '(': case ')': case 'b': return objBlock('(', ')', around, n1);
      case '[': case ']': return objBlock('[', ']', around, n1);
      case '{': case '}': case 'B': return objBlock('{', '}', around, n1);
      case '<': case '>': return objBlock('<', '>', around, n1);
    }
    return null;
  }
  function objWord(around, count, big){
    const s = L[cur.line];
    if (!s.length) return null;
    const k = (i) => { const c = utfClass(s.codePointAt(i)); return c !== 0 && big ? 1 : c; };
    let a = cur.col, b = cur.col;
    const run = (i) => { const c = k(i); let e = i; while (nx(s, e) < s.length && k(nx(s, e)) === c) e = nx(s, e); return e; };
    while (a > 0 && k(pv(s, a)) === k(cur.col)) a = pv(s, a);
    b = run(cur.col);
    const onWs = k(cur.col) === 0;
    if (around){
      if (onWs){ if (nx(s, b) < s.length) b = run(nx(s, b)); }
      else if (nx(s, b) < s.length && k(nx(s, b)) === 0) b = run(nx(s, b));
      else { while (a > 0 && k(pv(s, a)) === 0) a = pv(s, a); }
    }
    for (let i = 1; i < count && nx(s, b) < s.length; i++){
      b = run(nx(s, b));
      if (around && k(b) !== 0 && nx(s, b) < s.length && k(nx(s, b)) === 0) b = run(nx(s, b));
    }
    return { type:'char', start: P(cur.line, a), end: P(cur.line, nx(s, b)) };
  }
  function objPara(around, count){
    const blank = (l) => L[l].trim() === '';
    let a = cur.line, b = cur.line;
    const w = blank(a);
    while (a > 0 && blank(a - 1) === w) a--;
    while (b < L.length - 1 && blank(b + 1) === w) b++;
    let extra = count - 1;
    if (around){
      if (b < L.length - 1){ const w2 = blank(b + 1); b++; while (b < L.length - 1 && blank(b + 1) === w2) b++; }
      else if (!w){ while (a > 0 && blank(a - 1)) a--; }
    }
    while (extra-- > 0 && b < L.length - 1){
      const w2 = blank(b + 1); b++; while (b < L.length - 1 && blank(b + 1) === w2) b++;
      if (around && b < L.length - 1){ const w3 = blank(b + 1); b++; while (b < L.length - 1 && blank(b + 1) === w3) b++; }
    }
    return { type:'line', start: P(a, 0), end: P(b, L[b].length) };
  }
  function objSentence(around){
    const save = P(cur.line, cur.col);
    let st = P(cur.line, cur.col);
    if (!isSentStart(st)){ const q = sentence(-1, 1); st = q; }
    cur.line = st.line; cur.col = st.col;
    const en = sentence(1, 1);
    cur.line = save.line; cur.col = save.col;
    let end = P(en.line, en.col);
    if (cmpPos(end, st) <= 0) end = P(st.line, L[st.line].length);
    if (!around){ // 末尾の空白を除く
      const t = L[end.line]; let c = end.col;
      if (end.line === st.line){ while (c > st.col && isWs(t[c - 1])) c--; end = P(end.line, c); }
      else if (end.col === 0){ end = P(end.line - 1, L[end.line - 1].length); }
    }
    return { type:'char', start: st, end };
  }
  function objQuote(q, around){
    const s = L[cur.line];
    const pos = [];
    for (let i = 0; i < s.length; i++){ if (s[i] === '\\'){ i++; continue; } if (s[i] === q) pos.push(i); }
    let o = -1, c = -1;
    const at = pos.indexOf(cur.col);
    if (at >= 0){ if (at % 2 === 0){ o = pos[at]; c = pos[at + 1] ?? -1; } else { o = pos[at - 1]; c = pos[at]; } }
    else {
      const before = pos.filter(x => x < cur.col).length;
      if (before % 2 === 1){ o = pos[before - 1]; c = pos[before] ?? -1; }
      else { o = pos[before] ?? -1; c = pos[before + 1] ?? -1; }
    }
    if (o < 0 || c < 0) return null;
    if (!around) return { type:'char', start: P(cur.line, o + 1), end: P(cur.line, c) };
    let a = o, b = c + 1;
    if (b < s.length && isWs(s[b])){ while (b < s.length && isWs(s[b])) b++; }
    else { while (a > 0 && isWs(s[a - 1])) a--; }
    return { type:'char', start: P(cur.line, a), end: P(cur.line, b) };
  }
  function objBlock(open, close, around, count){
    const s = L[cur.line];
    let from = P(cur.line, cur.col), op;
    if (s[cur.col] === open && count === 1) op = from;
    else if (s[cur.col] === close && count === 1) op = matchBracket(from, close);
    else op = findOpen(open, close, P(cur.line, cur.col - 1 < 0 ? -1 : cur.col - (s[cur.col] === close ? 0 : 0)), count);
    if (!op && s[cur.col] !== open){
      // 括弧の外ならその行で次に現れるものを使う（Vim 9 の挙動）
      const i = s.indexOf(open, cur.col);
      if (i >= 0) op = P(cur.line, i);
    }
    if (!op) return null;
    const cl = matchBracket(op, open);
    if (!cl) return null;
    if (around) return { type:'char', start: op, end: P(cl.line, cl.col + 1) };
    let st = P(op.line, op.col + 1), en = P(cl.line, cl.col);
    if (st.col >= L[st.line].length && st.line < en.line) st = P(st.line + 1, 0);
    if (en.line > st.line && L[en.line].slice(0, en.col).trim() === ''){
      en = P(en.line - 1, L[en.line - 1].length);
      if (st.col === 0 && cmpPos(st, en) <= 0) return { type:'line', start: P(st.line, 0), end: P(en.line, L[en.line].length) };
    }
    return { type:'char', start: st, end: en };
  }

  /* ---------- 範囲作成 ---------- */
  function inIndent(p){ return L[p.line].slice(0, p.col).trim() === ''; }
  function rangeFromMotion(r, forced){
    let s = P(cur.line, cur.col), e = P(r.line, r.col), type = r.type;
    if (forced === 'V') type = 'line';
    else if (forced === 'v'){ if (type === 'line'){ type = 'excl'; } else type = type === 'incl' ? 'excl' : 'incl'; }
    else if (forced === '<C-v>'){
      const a = Math.min(s.line, e.line), b = Math.max(s.line, e.line);
      return { type:'block', start: P(a, 0), end: P(b, 0), c1: Math.min(s.col, e.col), c2: Math.max(s.col, e.col), toEol:false };
    }
    if (type === 'line'){
      const a = Math.min(s.line, e.line), b = Math.max(s.line, e.line);
      return { type:'line', start: P(a, 0), end: P(b, L[b].length) };
    }
    if (cmpPos(e, s) < 0){ const t = s; s = e; e = t; }
    if (type === 'incl') e = P(e.line, nx(L[e.line], e.col));
    else if (e.col === 0 && e.line > s.line && !forced){
      if (inIndent(s)) return { type:'line', start: P(s.line, 0), end: P(e.line - 1, L[e.line - 1].length) };
      e = P(e.line - 1, L[e.line - 1].length);
    }
    return { type:'char', start: s, end: e };
  }
  function visualRange(){
    const a = E.vstart, b = cur;
    if (E.vmode === 'V'){
      const s = Math.min(a.line, b.line), e = Math.max(a.line, b.line);
      return { type:'line', start: P(s, 0), end: P(e, L[e].length) };
    }
    if (E.vmode === '<C-v>'){
      const s = Math.min(a.line, b.line), e = Math.max(a.line, b.line);
      const toEol = want === Infinity;
      return { type:'block', start: P(s, 0), end: P(e, 0), c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col), toEol };
    }
    let s = P(a.line, a.col), e = P(b.line, b.col);
    if (cmpPos(e, s) < 0){ const t = s; s = e; e = t; }
    let end;
    if (e.col >= L[e.line].length || (want === Infinity && b === cur && cmpPos(b, a) >= 0)){
      end = e.line < L.length - 1 ? P(e.line + 1, 0) : P(e.line, L[e.line].length);
    } else end = P(e.line, nx(L[e.line], e.col));
    return { type:'char', start: s, end };
  }
  E.visualRange = () => (E.mode === 'visual' || (E.mode === 'cmdline' && E.cmd?.fromVisual)) && E.vstart ? visualRange() : null;
  function blockSegs(r){
    const out = [];
    for (let l = r.start.line; l <= r.end.line; l++){
      const s = L[l];
      const a = Math.min(r.c1, s.length);
      const b = r.toEol ? s.length : Math.min(nx(s, r.c2), s.length);
      out.push({ line: l, a, b: Math.max(a, b) });
    }
    return out;
  }
  function rangeText(r){
    if (r.type === 'line') return L.slice(r.start.line, r.end.line + 1).join('\n');
    if (r.type === 'block') return blockSegs(r).map(g => L[g.line].slice(g.a, g.b)).join('\n');
    return getText(r.start.line, r.start.col, r.end.line, r.end.col);
  }
  const regType = (r) => r.type === 'line' ? 'l' : r.type === 'block' ? 'b' : 'c';

  /* ---------- オペレータ ---------- */
  let didChange = false;
  function caseFn(op){
    if (op === 'g~' || op === '~') return (t) => [...t].map(c => { const u = c.toUpperCase(), l = c.toLowerCase(); return c === u ? l : u; }).join('');
    if (op === 'gu' || op === 'u') return (t) => t.toLowerCase();
    if (op === 'gU' || op === 'U') return (t) => t.toUpperCase();
    if (op === 'g?') return (t) => t.replace(/[a-zA-Z]/g, c => String.fromCharCode((c <= 'Z' ? 65 : 97) + (c.toUpperCase().charCodeAt(0) - 65 + 13) % 26));
    return (t) => t;
  }
  function shiftLines(a, b, dir, times = 1){
    const sw = opts.shiftwidth || opts.tabstop;
    for (let l = a; l <= b; l++){
      const s = L[l];
      if (!s.length) continue;
      const m = /^[ \t]*/.exec(s)[0];
      let w = 0; for (const ch of m) w = ch === '\t' ? (Math.floor(w / opts.tabstop) + 1) * opts.tabstop : w + 1;
      const nw = dir > 0 ? (Math.floor(w / sw) + times) * sw : Math.max(0, (Math.ceil(w / sw) - times) * sw);
      const ind = opts.expandtab ? ' '.repeat(nw) : '\t'.repeat(Math.floor(nw / opts.tabstop)) + ' '.repeat(nw % opts.tabstop);
      setLine(l, ind + s.slice(m.length));
    }
    const n = b - a + 1;
    if (n > opts.report) setMsg(`${n} lines ${dir > 0 ? '>' : '<'}ed ${times} time${times > 1 ? 's' : ''}`);
  }
  function reportLines(n, what){ if (n > opts.report) setMsg(`${n} ${what}`); }
  function applyOp(op, r, reg, count){
    const first = r.start.line;
    switch (op){
      case 'y': {
        writeReg(reg, rangeText(r), regType(r), true);
        if (r.type === 'line'){ if (first !== cur.line) setCur(first, cur.col); reportLines(r.end.line - first + 1, 'lines yanked'); }
        else if (r.type === 'block'){ setCur(first, r.c1); reportLines(r.end.line - first + 1, 'lines yanked'); }
        else setCur(r.start.line, r.start.col);
        if (r.type === 'block') { marks['['] = P(first, r.c1); marks[']'] = P(r.end.line, r.c2); }
        else { marks['['] = P(r.start.line, r.start.col); marks[']'] = P(r.end.line, Math.max(0, r.end.col - 1)); }
        return;
      }
      case 'd': case 'c': {
        didChange = true;
        const text = rangeText(r);
        if (!(op === 'c' && r.type === 'char' && text === '')) writeReg(reg, text, regType(r), false);
        if (r.type === 'line'){
          const n = r.end.line - first + 1;
          if (op === 'c'){
            if (r.end.line > first) deleteLines(first + 1, r.end.line);
            const ind = '';
            setLine(first, ind);
            E.mode = 'insert'; setCur(first, ind.length);
            startInsert('c');
          } else {
            deleteLines(first, r.end.line);
            setCur(Math.min(first, L.length - 1), 0);
            cur.col = fnb(cur.line);
            reportLines(n, 'fewer lines');
          }
          return;
        }
        if (r.type === 'block'){
          const segs = blockSegs(r);
          for (const g of segs) if (g.b > g.a) edit(g.line, g.a, g.line, g.b, '');
          if (op === 'c'){
            E.mode = 'insert'; setCur(first, Math.min(r.c1, L[first].length));
            startInsert('c'); blockIns = { a: first, b: r.end.line, col: cur.col, line: first, append:false, toEol:false };
          } else setCur(first, r.c1);
          return;
        }
        edit(r.start.line, r.start.col, r.end.line, r.end.col, '');
        if (op === 'c'){ E.mode = 'insert'; setCur(r.start.line, r.start.col); startInsert('c'); }
        else setCur(r.start.line, r.start.col);
        if (r.end.line - r.start.line > opts.report) setMsg(`${r.end.line - r.start.line} fewer lines`);
        return;
      }
      case '<': case '>': {
        didChange = true;
        shiftLines(first, r.end.line, op === '>' ? 1 : -1, count || 1);
        setCur(first, fnb(first));
        return;
      }
      case 'g~': case 'gu': case 'gU': case 'g?': case '~': case 'u': case 'U': {
        didChange = true;
        const fn = caseFn(op);
        if (r.type === 'line'){ for (let l = first; l <= r.end.line; l++) setLine(l, fn(L[l])); setCur(first, r.start.line === cur.line ? cur.col : 0); }
        else if (r.type === 'block'){ for (const g of blockSegs(r)) if (g.b > g.a) edit(g.line, g.a, g.line, g.b, fn(L[g.line].slice(g.a, g.b))); setCur(first, r.c1); }
        else { const t = rangeText(r); edit(r.start.line, r.start.col, r.end.line, r.end.col, fn(t)); setCur(r.start.line, r.start.col); }
        const n = r.end.line - first + 1;
        if (n > opts.report) setMsg(`${n} lines changed`);
        return;
      }
      case 'J': case 'gJ': {
        didChange = true;
        joinLines(first, Math.max(2, r.end.line - first + 1), op === 'J');
        return;
      }
      case '=': case 'gq': case 'gw': {
        if (op === 'gw'){ /* カーソル維持 */ } else setCur(first, fnb(first));
        const n = r.end.line - first + 1;
        if (n > opts.report) setMsg(`${n} lines indented `);
        return;
      }
      case '!': err('E: フィルタ (!) はこのエディタでは使えません');
    }
  }
  function joinLines(a, count, spaces){
    const b = Math.min(a + Math.max(count, 2) - 1, L.length - 1);
    if (b === a) return false;
    let s = L[a], col = 0;
    for (let l = a + 1; l <= b; l++){
      let t = L[l];
      let add = '';
      if (spaces){
        t = t.replace(/^[ \t]+/, '');
        const end = s[s.length - 1];
        if (t !== '' && t[0] !== ')' && s.length && end !== ' ' && end !== '\t'){
          add = ' ';
          if (opts.joinspaces && /[.!?]/.test(end)) add = '  ';
        }
      }
      col = s.length + (add ? 0 : 0);
      s = s + add + t;
      if (!add && t === '') col = Math.max(0, s.length - 1);
    }
    edit(a, 0, b, L[b].length, s);
    setCur(a, col);
    return true;
  }

  /* ---------- プット ---------- */
  function put(regName, count, before, gFlag){
    const r = readReg(regName);
    if (!r || (r.text === '' && r.type !== 'l')){ if (regName && regName !== '"') err(`E353: Nothing in register ${regName}`); else err('E353: Nothing in register "'); }
    didChange = true;
    const n = Math.max(1, count || 1);
    if (r.type === 'l'){
      const lines = r.text.split('\n');
      let arr = [];
      for (let i = 0; i < n; i++) arr = arr.concat(lines);
      const at = before ? cur.line : cur.line + 1;
      insertLines(at, arr);
      if (gFlag) setCur(Math.min(at + arr.length, L.length - 1), 0);
      else setCur(at, fnb(at));
      reportLines(arr.length, 'more lines');
      return;
    }
    if (r.type === 'b'){
      const rows = r.text.split('\n');
      const w = Math.max(...rows.map(x => [...x].length));
      let col = cur.col;
      if (!before && L[cur.line].length) col = nx(L[cur.line], col);
      const vcol = [...L[cur.line].slice(0, col)].length;
      for (let i = 0; i < rows.length; i++){
        const l = cur.line + i;
        if (l >= L.length) insertLines(L.length, ['']);
        let s = L[l];
        let cl = [...s];
        while (cl.length < vcol) cl.push(' ');
        let piece = '';
        for (let k = 0; k < n; k++) piece += rows[i] + (k < n - 1 || cl.length > vcol ? ' '.repeat(w - [...rows[i]].length) : '');
        if (cl.length > vcol && n === 1) piece = rows[i] + ' '.repeat(w - [...rows[i]].length);
        const idx = cl.slice(0, vcol).join('').length;
        const ns = cl.join('');
        setLine(l, ns.slice(0, idx) + piece + ns.slice(idx));
      }
      setCur(cur.line, [...L[cur.line]].slice(0, vcol).join('').length);
      return;
    }
    let text = r.text.repeat(n);
    let col = cur.col;
    if (!before && L[cur.line].length) col = nx(L[cur.line], col);
    const end = edit(cur.line, col, cur.line, col, text);
    if (gFlag) setCur(end.line, end.col);
    else if (text.includes('\n')) setCur(cur.line, col);
    else setCur(end.line, Math.max(col, pv(L[end.line], end.col)));
  }

  /* ---------- 挿入モード ---------- */
  let insStart = P(0, 0), insCount = 1, insKind = 'i', insKeys = [], insText = '', blockIns = null, replStack = [];
  let insRegPending = false, insLiteral = false, complete = null;
  function startInsert(kind, count = 1){
    E.mode = kind === 'R' ? 'replace' : 'insert';
    insKind = kind; insCount = Math.max(1, count || 1); insKeys = []; insText = ''; replStack = [];
    insStart = P(cur.line, cur.col);
    clampCur();
    setMsg('');
  }
  function insertText(t){
    if (E.mode === 'replace'){
      for (const ch of t){
        if (ch === '\n'){ edit(cur.line, cur.col, cur.line, cur.col, '\n'); setCur(cur.line + 1, 0); replStack.push(null); continue; }
        const s = L[cur.line];
        if (cur.col < s.length){ const old = chAt(s, cur.col); edit(cur.line, cur.col, cur.line, nx(s, cur.col), ch); replStack.push(old); }
        else { edit(cur.line, cur.col, cur.line, cur.col, ch); replStack.push(null); }
        cur.col += ch.length;
      }
    } else {
      const end = edit(cur.line, cur.col, cur.line, cur.col, t);
      cur.line = end.line; cur.col = end.col;
    }
    insText += t;
    wantFromCol();
  }
  function backspace(){
    if (E.mode === 'replace'){
      if (replStack.length && (cur.line > insStart.line || cur.col > insStart.col)){
        const old = replStack.pop();
        if (cur.col === 0){ if (cur.line > 0){ const pl = L[cur.line - 1].length; edit(cur.line - 1, pl, cur.line, 0, ''); setCur(cur.line - 1, pl); } return; }
        const p = pv(L[cur.line], cur.col);
        edit(cur.line, p, cur.line, cur.col, old ?? '');
        cur.col = p;
      } else if (cur.col > 0) cur.col = pv(L[cur.line], cur.col);
      return;
    }
    if (cur.col > 0){
      const p = pv(L[cur.line], cur.col);
      edit(cur.line, p, cur.line, cur.col, '');
      cur.col = p;
      insText = insText.slice(0, -1);
    } else if (cur.line > 0){
      const pl = L[cur.line - 1].length;
      edit(cur.line - 1, pl, cur.line, 0, '');
      cur.line--; cur.col = pl;
    }
    wantFromCol();
  }
  function completionCandidates(prefix){
    const seen = new Set(), outA = [], outB = [];
    const re = /[0-9A-Za-z_À-￿]+/g;
    for (let k = 0; k < L.length; k++){
      const l = (cur.line + k) % L.length;
      let m; re.lastIndex = 0;
      const t = L[l];
      while ((m = re.exec(t))){
        const w = m[0];
        if (w.length > prefix.length && w.startsWith(prefix) && !seen.has(w) && !(l === cur.line && m.index + w.length === cur.col)){
          seen.add(w); (l >= cur.line ? outA : outB).push(w);
        }
      }
    }
    return outA.concat(outB);
  }
  function insertKey(k){
    if (k !== '<C-n>' && k !== '<C-p>') complete = null;
    if (typeof k === 'object'){ insertText(k.text); return; }
    if (insLiteral){ insLiteral = false; insertText(k === '<Tab>' ? '\t' : k === '<CR>' ? '\r' : k.length <= 2 ? k : ''); return; }
    if (insRegPending){
      insRegPending = false;
      if (k === '<Esc>' || k === '<C-c>') return;
      const r = readReg(k.replace(/^<C-(.)>$/, '$1'));
      if (r) insertText(r.text + (r.type === 'l' ? '\n' : ''));
      return;
    }
    switch (k){
      case '<Esc>': case '<C-c>': case '<C-[>': exitInsert(k === '<C-c>'); return;
      case '<CR>': case '<C-m>': case '<C-j>': insertText('\n'); return;
      case '<BS>': case '<C-h>': backspace(); return;
      case '<Del>': { const s = L[cur.line]; if (cur.col < s.length) edit(cur.line, cur.col, cur.line, nx(s, cur.col), ''); else if (cur.line < L.length - 1) edit(cur.line, s.length, cur.line + 1, 0, ''); return; }
      case '<C-w>': {
        if (cur.col === 0){ backspace(); return; }
        const p = P(cur.line, cur.col);
        const s = L[cur.line];
        let c = cur.col;
        while (c > 0 && isWs(s[c - 1])) c--;
        if (c > 0){ const k0 = utfClass(s.codePointAt(pv(s, c))); while (c > 0 && utfClass(s.codePointAt(pv(s, c))) === k0) c = pv(s, c); }
        if (cur.line === insStart.line && cur.col > insStart.col && c < insStart.col) c = insStart.col;
        edit(p.line, c, p.line, p.col, ''); cur.col = c; return;
      }
      case '<C-u>': {
        let c = 0;
        if (cur.line === insStart.line && cur.col > insStart.col) c = insStart.col;
        else if (cur.col > fnbRaw(cur.line)) c = fnbRaw(cur.line);
        edit(cur.line, c, cur.line, cur.col, ''); cur.col = c; return;
      }
      case '<Left>': case '<Right>': case '<Up>': case '<Down>': case '<Home>': case '<End>':
      case '<S-Left>': case '<S-Right>': case '<C-Left>': case '<C-Right>': {
        const s = L[cur.line];
        if (k === '<Left>' && cur.col > 0) cur.col = pv(s, cur.col);
        else if (k === '<Right>' && cur.col < s.length) cur.col = nx(s, cur.col);
        else if (k === '<Up>' && cur.line > 0){ cur.line--; cur.col = colFromWant(cur.line); }
        else if (k === '<Down>' && cur.line < L.length - 1){ cur.line++; cur.col = colFromWant(cur.line); }
        else if (k === '<Home>') cur.col = 0;
        else if (k === '<End>') cur.col = s.length;
        else if (k === '<S-Left>' || k === '<C-Left>'){ const p = P(cur.line, cur.col); bckWord(p, 1, k === '<C-Left>', false); setCur(p.line, p.col); }
        else if (k === '<S-Right>' || k === '<C-Right>'){ const p = P(cur.line, cur.col); fwdWord(p, 1, k === '<C-Right>', false); setCur(p.line, p.col); }
        if (k !== '<Up>' && k !== '<Down>') wantFromCol();
        insStart = P(cur.line, cur.col); insKeys = []; insCount = 1;
        endChange();
        return;
      }
      case '<Tab>': insertText(opts.expandtab ? ' '.repeat(opts.shiftwidth || 8) : '\t'); return;
      case '<C-t>': case '<C-d>': {
        const before = L[cur.line].length;
        shiftLines(cur.line, cur.line, k === '<C-t>' ? 1 : -1);
        cur.col = Math.max(0, cur.col + L[cur.line].length - before); return;
      }
      case '<C-r>': insRegPending = true; return;
      case '<C-a>': insertText(lastInserted); return;
      case '<C-e>': case '<C-y>': {
        const l = cur.line + (k === '<C-e>' ? 1 : -1);
        if (l < 0 || l >= L.length) return;
        const ch = chAt(L[l], Math.min(cur.col, L[l].length));
        if (ch) insertText(ch);
        return;
      }
      case '<C-v>': case '<C-q>': insLiteral = true; return;
      case '<C-o>': E.oneShot = true; E.mode = 'normal'; endChange(); clampCur(); return;
      case '<Insert>': E.mode = E.mode === 'insert' ? 'replace' : 'insert'; replStack = []; return;
      case '<C-n>': case '<C-p>': {
        if (!complete){
          const s = L[cur.line];
          let a = cur.col; while (a > 0 && /[0-9A-Za-z_À-￿]/.test(s[a - 1])) a--;
          const prefix = s.slice(a, cur.col);
          const cands = completionCandidates(prefix);
          if (!cands.length){ setMsg('-- Keyword completion (^N^P) Pattern not found', true); return; }
          complete = { a, prefix, cands, idx: -1 };
        }
        const c = complete;
        c.idx = k === '<C-n>' ? (c.idx + 1) % (c.cands.length + 1) : (c.idx <= 0 ? c.cands.length : c.idx - 1);
        const word = c.idx === c.cands.length ? c.prefix : c.cands[c.idx];
        edit(cur.line, c.a, cur.line, cur.col, word);
        cur.col = c.a + word.length;
        setMsg(c.idx === c.cands.length ? '-- Keyword completion (^N^P) Back at original' : `-- Keyword completion (^N^P) match ${c.idx + 1} of ${c.cands.length}`);
        return;
      }
      case '<C-g>': case '<C-k>': case '<C-x>': case '<C-l>': case '<C-z>': return;
    }
    if (isSpecial(k)) return;
    insertText(k);
  }
  function exitInsert(ctrlC){
    if (!ctrlC && insCount > 1){
      const ks = insKeys.slice(0, -1);
      for (let n = 1; n < insCount; n++){
        if (insKind === 'o' || insKind === 'O') insertText('\n');
        for (const k of ks) insertKey(k);
      }
    }
    if (blockIns && !ctrlC){
      const bi = blockIns;
      if (cur.line === bi.line && cur.col > bi.col){
        const t = L[bi.line].slice(bi.col, cur.col);
        const vcol = [...L[bi.line].slice(0, bi.col)].length;
        for (let l = bi.a + 1; l <= bi.b; l++){
          const s = L[l];
          const cl = [...s];
          if (bi.toEol){ setLine(l, s + t); continue; }
          if (cl.length < vcol){ if (!bi.append) continue; while (cl.length < vcol) cl.push(' '); }
          const idx = cl.slice(0, vcol).join('').length;
          const ns = cl.join('');
          setLine(l, ns.slice(0, idx) + t + ns.slice(idx));
        }
      }
      cur.line = bi.line;
    }
    blockIns = null;
    lastInserted = insText;
    marks['^'] = P(cur.line, cur.col);
    marks['.'] = P(cur.line, Math.max(0, cur.col - 1));
    E.mode = 'normal';
    if (cur.col > 0) cur.col = pv(L[cur.line], cur.col);
    clampCur(); wantFromCol();
    endChange();
    if (dotRec){ lastChange = dotRec; dotRec = null; }
    setMsg('');
  }

  /* ---------- ノーマルモードの解析 ---------- */
  const OPS = new Set(['d','c','y','<','>','=','!']);
  const GOPS = new Set(['~','u','U','?','q','w']);
  const isSpecial = (k) => typeof k === 'string' && k.length > 2 && k[0] === '<' && k[k.length - 1] === '>';
  function parseMotionAt(t, i){
    const k = t[i];
    if (k === undefined) return INC;
    if (MOTION1.has(k)) return { key: k, len: 1 };
    if (MOTION_ARG.has(k)){ if (i + 1 >= t.length) return INC; if (isSpecial(t[i + 1]) && t[i + 1] !== '<Space>') return BAD; return { key: k, arg: t[i + 1] === '<Space>' ? ' ' : t[i + 1], len: 2 }; }
    if (k === 'g'){ if (i + 1 >= t.length) return INC; if (GMOTION.has(t[i + 1])) return { key: 'g' + t[i + 1], len: 2 }; return null; }
    if (k === '/' || k === '?') return { key: k, len: 1, search: true };
    return null;
  }
  function parseCount(t, i){
    let n = 0, j = i;
    while (j < t.length && /^[0-9]$/.test(t[j]) && !(t[j] === '0' && n === 0)){ n = n * 10 + +t[j]; j++; }
    return [n, j];
  }
  function parseNormal(t, visual){
    let i = 0, reg = null, count = 0;
    for (;;){
      if (i >= t.length) return INC;
      if (t[i] === '"'){
        if (i + 1 >= t.length) return INC;
        if (!validReg(t[i + 1])) return BAD;
        reg = t[i + 1]; i += 2; continue;
      }
      const [n, j] = parseCount(t, i);
      if (j > i){ count = count ? count * n : n; i = j; continue; }
      break;
    }
    const prefixLen = i;
    const base = { reg, count, prefixLen };
    const k = t[i];
    // オペレータ
    let op = null;
    if (OPS.has(k)) op = k;
    else if (k === 'g'){ if (i + 1 >= t.length) return INC; if (GOPS.has(t[i + 1])) op = 'g' + t[i + 1]; }
    if (op && !visual){
      i += op.length;
      const [c2, j] = parseCount(t, i); i = j;
      let forced = null;
      while (t[i] === 'v' || t[i] === 'V' || t[i] === '<C-v>'){ forced = t[i]; i++; }
      if (i >= t.length) return INC;
      const k2 = t[i];
      const total = (count || 1) * (c2 || 1), hasCount = !!(count || c2);
      const r = Object.assign(base, { op, count: hasCount ? total : 0, forced });
      if (op.length === 1 && k2 === op) return Object.assign(r, { kind:'line', len: i + 1 });
      if (op.length === 2 && k2 === op[1]) return Object.assign(r, { kind:'line', len: i + 1 });
      if (op.length === 2 && k2 === 'g'){ if (i + 1 >= t.length) return INC; if (t[i + 1] === op[1]) return Object.assign(r, { kind:'line', len: i + 2 }); }
      if (k2 === 'i' || k2 === 'a'){
        if (i + 1 >= t.length) return INC;
        if (!TEXTOBJ.has(t[i + 1])) return BAD;
        return Object.assign(r, { kind:'obj', around: k2 === 'a', obj: t[i + 1], len: i + 2 });
      }
      const m = parseMotionAt(t, i);
      if (m === INC) return INC;
      if (!m || m === BAD) return BAD;
      return Object.assign(r, { kind:'motion', motion: m, len: i + m.len });
    }
    if (visual){
      if ((k === 'i' || k === 'a')){
        if (i + 1 >= t.length) return INC;
        if (TEXTOBJ.has(t[i + 1])) return Object.assign(base, { kind:'obj', around: k === 'a', obj: t[i + 1] });
        if (k === 'a') return BAD;
      }
      if (k === 'g'){
        if (i + 1 >= t.length) return INC;
        const k2 = t[i + 1];
        if (['~','u','U','?','J','v','q','w','<C-a>','<C-x>','<C-g>'].includes(k2)) return Object.assign(base, { kind:'vcmd', cmd: 'g' + k2 });
      }
      if (k === 'r'){ if (i + 1 >= t.length) return INC; return Object.assign(base, { kind:'vcmd', cmd:'r', arg: t[i + 1] }); }
      if (['d','x','X','D','<Del>','c','s','C','S','R','y','Y','>','<','=','!','~','u','U','J','p','P','I','A','o','O',':','<C-a>','<C-x>','v','V','<C-v>','<C-]>','<C-c>','<Esc>'].includes(k))
        return Object.assign(base, { kind:'vcmd', cmd: k });
      const m = parseMotionAt(t, i);
      if (m === INC) return INC;
      if (m && m !== BAD) return Object.assign(base, { kind:'motion', motion: m });
      if (k === 'm' || k === '@' || k === 'q' || k === 'z' || k === 'Z' || k === '"') { /* 下へ */ }
      else if (['<C-d>','<C-u>','<C-f>','<C-b>','<C-e>','<C-y>','<PageUp>','<PageDown>','<C-o>','<C-i>','<Tab>','<C-l>','<C-g>'].includes(k)) return Object.assign(base, { kind:'cmd', cmd: k });
      else if (k !== 'm' && k !== 'z') return BAD;
    }
    if (!visual){
      const m = parseMotionAt(t, i);
      if (m === INC) return INC;
      if (m && m !== BAD) return Object.assign(base, { kind:'motion', motion: m });
      if (m === BAD) return BAD;
    }
    // コマンド
    const single = ['x','X','D','C','s','S','Y','p','P','J','u','U','.','~','i','a','I','A','o','O','R','v','V','<C-v>',':','&',
      '<C-r>','<C-a>','<C-x>','<C-o>','<C-i>','<Tab>','<C-g>','<C-e>','<C-y>','<C-d>','<C-u>','<C-f>','<C-b>','<C-l>','<Del>','<Insert>',
      '<PageUp>','<PageDown>','<S-Up>','<S-Down>','K','<C-^>','<C-]>','<C-z>'];
    if (single.includes(k)) return Object.assign(base, { kind:'cmd', cmd: k });
    if (k === 'r' || k === 'm' || k === 'q' || k === '@'){
      if (k === 'q' && E.recording) return Object.assign(base, { kind:'cmd', cmd: 'q' });
      if (i + 1 >= t.length) return INC;
      return Object.assign(base, { kind:'cmd', cmd: k, arg: t[i + 1] });
    }
    if (k === 'Z'){ if (i + 1 >= t.length) return INC; if (t[i + 1] === 'Z' || t[i + 1] === 'Q') return Object.assign(base, { kind:'cmd', cmd: 'Z' + t[i + 1] }); return BAD; }
    if (k === 'z'){
      if (i + 1 >= t.length) return INC;
      const k2 = t[i + 1];
      if (['z','t','b','<CR>','.','-','h','l','s','e','H','L'].includes(k2)) return Object.assign(base, { kind:'cmd', cmd: 'z' + k2 });
      return BAD;
    }
    if (k === 'g'){
      const k2 = t[i + 1];
      if (['v','i','I','J','p','P','a','&','8','<C-g>','<C-a>','<C-x>','s','~','u','U','?','<','f','x','t','T',"'",'`',';',','].includes(k2)){
        if ((k2 === "'" || k2 === '`') ){ if (i + 2 >= t.length) return INC; return Object.assign(base, { kind:'motion', motion: { key: k2, arg: t[i + 2], len: 3 } }); }
        return Object.assign(base, { kind:'cmd', cmd: 'g' + k2 });
      }
      return BAD;
    }
    if (k === '[' || k === ']'){
      if (i + 1 >= t.length) return INC;
      const k2 = t[i + 1];
      if (k2 === 'p' || k2 === 'P') return Object.assign(base, { kind:'cmd', cmd: k + k2 });
      return BAD;
    }
    return BAD;
  }

  /* ---------- ノーマルモードの実行 ---------- */
  let pending = [], cmdKeys = [], dotRec = null, lastChange = null, replaying = 0, abortMacro = false;
  let pendingOp = null; // 検索モーション待ちのオペレータ
  let lastVisual = null;
  function normalKey(k){
    if (typeof k === 'object'){ for (const ch of k.text) normalKey(ch); return; }
    if (k === '<Esc>' || k === '<C-c>' || k === '<C-[>'){
      if (pending.length){ pending = []; E.showcmd = ''; return finishCmd(); }
      if (E.mode === 'visual'){ exitVisual(); return finishCmd(); }
      if (k === '<Esc>') bell();
      return finishCmd();
    }
    if (!pending.length) cmdKeys = [];
    pending.push(k); cmdKeys.push(k);
    const r = parseNormal(pending, E.mode === 'visual');
    if (r === INC){ E.showcmd = pending.map(keyLabel).join(''); return; }
    const keys = pending; pending = []; E.showcmd = '';
    if (r === BAD){ bell(); return finishCmd(); }
    didChange = false;
    const startMode = E.mode;
    try {
      if (startMode === 'visual') execVisual(r, keys);
      else execNormal(r, keys);
    } catch (e){
      if (!(e instanceof VimError)) throw e;
      setMsg(e.message, true); bell();
      if (E.mode === 'cmdline' && !E.cmd) E.mode = 'normal';
    }
    if (r.cmd === '.' || r.cmd === '@') didChange = false;
    if (didChange && !replaying){
      const rec = { keys: keys.slice(r.prefixLen), count: r.count, reg: r.reg, visual: startMode === 'visual' ? visualSnapshot : null };
      if (isInsertLike()) dotRec = rec, dotRec.ins = true;
      else lastChange = rec;
    } else if (didChange && replaying && isInsertLike()) dotRec = null;
    finishCmd();
  }
  let visualSnapshot = null;
  function finishCmd(){
    if (E.mode === 'normal' && !pending.length){
      endChange();
      cleanGoneMarks();
      if (E.oneShot && !replayingOneShot){
        E.oneShot = false; E.mode = 'insert';
        if (want === Infinity) cur.col = L[cur.line].length;
        insStart = P(cur.line, cur.col); insKeys = []; insCount = 1; clampCur();
      }
    }
    clampCur();
  }
  let replayingOneShot = false;
  function keyLabel(k){ return typeof k === 'object' ? k.text : isSpecial(k) ? '^' + (k.match(/^<C-(.)>$/)?.[1]?.toUpperCase() ?? '') : k; }
  function moveTo(res, keepWant){
    if (res.jump) pushJump();
    cur.line = res.line; cur.col = res.col;
    clampCur();
    if (res.want !== undefined) want = res.want;
    else if (!keepWant && !res.keepWant) wantFromCol();
  }
  function runMotion(r, op){
    const res = motion(r.motion, r.count, op ? { op, forced: r.forced } : { visual: E.mode === 'visual' });
    if (!res){ bell(); return null; }
    return res;
  }
  function startCmdline(type, init = '', extra = {}){
    E.cmd = Object.assign({ type, text: init, pos: init.length, hist: null, save: P(cur.line, cur.col), top: E.top }, extra);
    E.prevMode = E.mode;
    E.mode = 'cmdline';
    setMsg('');
  }
  function execNormal(r, keys){
    const count = r.count, n1 = count || 1, reg = r.reg;
    if (r.op){
      if (r.kind === 'motion' && r.motion.search){
        pendingOp = { op: r.op, reg, count, forced: r.forced };
        startCmdline(r.motion.key, '');
        return;
      }
      let range;
      if (r.kind === 'line'){
        if (cur.line + n1 - 1 > L.length - 1 && n1 > 1 && false) return bell();
        const b = Math.min(L.length - 1, cur.line + n1 - 1);
        if (r.op === '<' || r.op === '>' ){ range = { type:'line', start: P(cur.line, 0), end: P(b, L[b].length) }; applyOp(r.op, range, reg, 1); return; }
        range = { type:'line', start: P(cur.line, 0), end: P(b, L[b].length) };
        if (r.forced === 'v') range = { type:'char', start: P(cur.line, cur.col), end: P(b, L[b].length) };
      } else if (r.kind === 'obj'){
        const o = textObject(r.obj, r.around, count);
        if (!o) return bell();
        range = o;
      } else {
        const res = runMotion(r, r.op);
        if (!res) return;
        if (res.jump) pushJump();
        range = rangeFromMotion(res, r.forced);
      }
      applyOp(r.op, range, reg, r.op === '<' || r.op === '>' ? 1 : count);
      if (E.mode === 'insert' && r.op === 'c') insCount = 1;
      return;
    }
    if (r.kind === 'motion'){
      if (r.motion.search){ startCmdline(r.motion.key, '', { count }); return; }
      const res = runMotion(r, null);
      if (res) moveTo(res);
      return;
    }
    const c = r.cmd;
    switch (c){
      case 'x': case '<Del>': {
        if (!L[cur.line].length) return;
        let e = cur.col; for (let i = 0; i < n1 && e < L[cur.line].length; i++) e = nx(L[cur.line], e);
        applyOp('d', { type:'char', start: P(cur.line, cur.col), end: P(cur.line, e) }, reg); return;
      }
      case 'X': {
        if (cur.col === 0) return bell();
        let s = cur.col; for (let i = 0; i < n1 && s > 0; i++) s = pv(L[cur.line], s);
        applyOp('d', { type:'char', start: P(cur.line, s), end: P(cur.line, cur.col) }, reg); return;
      }
      case 'D': case 'C': {
        const b = Math.min(L.length - 1, cur.line + n1 - 1);
        applyOp(c === 'D' ? 'd' : 'c', { type:'char', start: P(cur.line, cur.col), end: P(b, L[b].length) }, reg);
        if (c === 'C') insCount = 1;
        return;
      }
      case 's': {
        const s = L[cur.line];
        let e = cur.col; for (let i = 0; i < n1 && e < s.length; i++) e = nx(s, e);
        applyOp('c', { type:'char', start: P(cur.line, cur.col), end: P(cur.line, e) }, reg); insCount = 1; return;
      }
      case 'S': { const b = Math.min(L.length - 1, cur.line + n1 - 1); applyOp('c', { type:'line', start: P(cur.line, 0), end: P(b, L[b].length) }, reg); insCount = 1; return; }
      case 'Y': { const b = Math.min(L.length - 1, cur.line + n1 - 1); applyOp('y', { type:'line', start: P(cur.line, 0), end: P(b, L[b].length) }, reg); return; }
      case 'p': case 'P': case 'gp': case 'gP': case ']p': case '[p': case ']P': case '[P': {
        const before = c === 'P' || c === 'gP' || c[0] === '[' || c === ']P';
        if (reg === '+' || reg === '*'){
          if (hooks.clipboardRead){
            hooks.clipboardRead().then(text => {
              if (text == null) return;
              const v = { text: text.replace(/\r\n?/g, '\n'), type:'c' };
              if (v.text.endsWith('\n')){ v.text = v.text.slice(0, -1); v.type = 'l'; }
              regs['+'] = regs['*'] = v;
              try { put('+', count, before, c[0] === 'g'); } catch (e){ setMsg(e.message, true); }
              endChange(); clampCur(); hooks.onChange?.();
            }).catch(() => { setMsg('E353: Nothing in register +', true); hooks.onChange?.(); });
            return;
          }
        }
        put(reg, count, before, c[0] === 'g');
        return;
      }
      case 'J': case 'gJ': {
        if (cur.line >= L.length - 1) return bell();
        didChange = true;
        joinLines(cur.line, Math.max(2, n1), c === 'J'); return;
      }
      case 'r': {
        let ch = r.arg;
        if (ch === '<Esc>' || ch === '<C-c>') return;
        if (ch === '<CR>') ch = '\n';
        else if (ch === '<Tab>') ch = '\t';
        else if (isSpecial(ch)) return bell();
        if (typeof ch === 'object') ch = [...ch.text][0];
        const s = L[cur.line];
        let e = cur.col, n = 0;
        for (; n < n1 && e < s.length; n++) e = nx(s, e);
        if (n < n1 || !s.length) return bell();
        didChange = true;
        if (ch === '\n'){ edit(cur.line, cur.col, cur.line, e, '\n'); setCur(cur.line + 1, 0); return; }
        edit(cur.line, cur.col, cur.line, e, ch.repeat(n1));
        cur.col = cur.col + ch.length * (n1 - 1);
        return;
      }
      case '~': case 'g~': {
        const s = L[cur.line];
        if (!s.length) return;
        let e = cur.col; for (let i = 0; i < n1 && e < s.length; i++) e = nx(s, e);
        didChange = true;
        edit(cur.line, cur.col, cur.line, e, caseFn('~')(s.slice(cur.col, e)));
        setCur(cur.line, e); wantFromCol(); return;
      }
      case 'i': case '<Insert>': didChange = true; startInsert('i', count); return;
      case 'a': didChange = true; if (L[cur.line].length) cur.col = nx(L[cur.line], cur.col); startInsert('a', count); return;
      case 'I': didChange = true; E.mode = 'insert'; cur.col = fnbRaw(cur.line); startInsert('I', count); return;
      case 'gI': didChange = true; E.mode = 'insert'; cur.col = 0; startInsert('I', count); return;
      case 'A': didChange = true; E.mode = 'insert'; cur.col = L[cur.line].length; startInsert('A', count); return;
      case 'gi': { didChange = true; const m = marks['^']; E.mode = 'insert'; if (m && !m.gone) setCur(m.line, m.col); startInsert('i', count); return; }
      case 'o': case 'O': {
        didChange = true;
        const at = c === 'o' ? cur.line + 1 : cur.line;
        insertLines(at, ['']);
        E.mode = 'insert'; setCur(at, 0); startInsert(c, count); return;
      }
      case 'R': didChange = true; startInsert('R', count); return;
      case 'v': case 'V': case '<C-v>': {
        if (count && lastVisual){ /* 1v: 直前と同じ大きさ */ }
        enterVisual(c); return;
      }
      case 'gv': {
        if (!lastVisual) return bell();
        E.mode = 'visual'; E.vmode = lastVisual.mode;
        E.vstart = P(lastVisual.start.line, lastVisual.start.col);
        setCur(lastVisual.end.line, lastVisual.end.col);
        want = lastVisual.want;
        return;
      }
      case 'u': undo(n1); return;
      case 'U': undo(1); return;
      case '<C-r>': redo(n1); return;
      case '.': return dotRepeat(count);
      case ':': startCmdline(':', count ? (count === 1 ? '.' : `.,.+${count - 1}`) : ''); return;
      case '&': exSubstitute([cur.line, cur.line], '', false, false); return;
      case 'g&': exSubstitute([0, L.length - 1], '&', false, true); return;
      case '<C-a>': case '<C-x>': if (incNumber(cur.line, cur.col, (c === '<C-a>' ? 1 : -1) * n1, true)) didChange = true; else bell(); return;
      case '<C-o>': case '<C-i>': case '<Tab>': {
        if (c === '<C-o>'){
          if (jumpIdx === jumps.length){ pushJump(); jumpIdx = jumps.length - 1; }
          if (jumpIdx - n1 < 0) return bell();
          jumpIdx -= n1;
        } else {
          if (jumpIdx + n1 >= jumps.length) return bell();
          jumpIdx += n1;
        }
        const j = jumps[jumpIdx];
        setCur(clamp(j.line, 0, L.length - 1), j.col); wantFromCol();
        return;
      }
      case '<C-g>': {
        const pct = Math.round((cur.line + 1) * 100 / L.length);
        setMsg(`"${E.fileName}"${E.modified ? ' [Modified]' : ''} ${L.length} line${L.length > 1 ? 's' : ''} --${pct}%--`);
        return;
      }
      case 'ga': {
        const ch = chAt(L[cur.line], cur.col);
        if (!ch) return setMsg('NUL');
        const cp = ch.codePointAt(0);
        setMsg(`<${ch}> ${cp}, Hex ${cp.toString(16).padStart(cp > 0xff ? 4 : 2, '0')}, Oct ${cp.toString(8)}`);
        return;
      }
      case 'g8': { const ch = chAt(L[cur.line], cur.col); setMsg([...new TextEncoder().encode(ch)].map(b => b.toString(16)).join(' ')); return; }
      case '<C-e>': case '<C-y>': scrollLines((c === '<C-e>' ? 1 : -1) * n1); return;
      case '<C-d>': case '<C-u>': {
        const amt = count || Math.max(1, Math.floor(E.rows / 2));
        const d = c === '<C-d>' ? 1 : -1;
        if ((d > 0 && cur.line >= L.length - 1) || (d < 0 && cur.line === 0)) return bell();
        E.top = clamp(E.top + d * amt, 0, Math.max(0, L.length - 1));
        setCur(clamp(cur.line + d * amt, 0, L.length - 1), 0); cur.col = fnb(cur.line); wantFromCol();
        return;
      }
      case '<C-f>': case '<C-b>': case '<PageDown>': case '<PageUp>': case '<S-Down>': case '<S-Up>': {
        const d = (c === '<C-f>' || c === '<PageDown>' || c === '<S-Down>') ? 1 : -1;
        const page = Math.max(1, E.rows - 2) * n1;
        if ((d > 0 && E.top >= L.length - 1) || (d < 0 && E.top === 0)) return bell();
        E.top = clamp(E.top + d * page, 0, Math.max(0, L.length - 1));
        const l = d > 0 ? E.top : Math.min(L.length - 1, E.top + E.rows - 1);
        setCur(Math.min(Math.max(cur.line, d > 0 ? l : 0), d > 0 ? L.length - 1 : l), 0);
        if (d > 0 && cur.line < E.top) cur.line = E.top;
        cur.col = fnb(cur.line); wantFromCol();
        return;
      }
      case 'zz': case 'z.': E.top = Math.max(0, (count ? count - 1 : cur.line) - Math.floor(E.rows / 2)); if (count) setCur(count - 1, cur.col); if (c === 'z.') cur.col = fnb(cur.line); return;
      case 'zt': case 'z<CR>': if (count) setCur(count - 1, cur.col); E.top = cur.line; if (c === 'z<CR>') cur.col = fnb(cur.line); return;
      case 'zb': case 'z-': if (count) setCur(count - 1, cur.col); E.top = Math.max(0, cur.line - E.rows + 1); if (c === 'z-') cur.col = fnb(cur.line); return;
      case 'zh': case 'zl': case 'zs': case 'ze': case 'zH': case 'zL': return;
      case '<C-l>': setMsg(''); return;
      case 'm': {
        const ch = r.arg;
        if (/^[a-zA-Z]$/.test(ch)) marks[ch.toLowerCase() === ch ? ch : ch.toLowerCase()] = P(cur.line, cur.col);
        else if (ch === "'" || ch === '`') marks["'"] = P(cur.line, cur.col);
        else if (ch === '<' || ch === '>' || ch === '[' || ch === ']') marks[ch] = P(cur.line, cur.col);
        else bell();
        return;
      }
      case 'q': {
        if (E.recording){ stopRecording(); return; }
        const ch = r.arg;
        if (!/^[a-zA-Z0-9"]$/.test(ch)) return bell();
        E.recording = ch; recKeys = [];
        return;
      }
      case '@': {
        let ch = r.arg;
        if (ch === '@'){ if (!lastMacro) err('E748: No previously used register'); ch = lastMacro; }
        if (ch === ':'){ if (!lastExForAt) err('E30: No previous command line'); for (let i = 0; i < n1; i++) execEx(lastExForAt); lastMacro = ':'; return; }
        const keysArr = macroKeys(ch);
        if (!keysArr) return bell();
        lastMacro = ch;
        runKeys(keysArr, n1);
        return;
      }
      case 'ZZ': execEx('x'); return;
      case 'ZQ': execEx('q!'); return;
      case 'K': case '<C-]>': case '<C-^>': case '<C-z>': case 'gs': case 'gf': case 'gx': case 'gt': case 'gT': return bell();
      case 'g<C-g>': { const words = L.join(' ').split(/\s+/).filter(Boolean).length; setMsg(`Col ${cur.col + 1} of ${L[cur.line].length}; Line ${cur.line + 1} of ${L.length}; Word ? of ${words}`); return; }
      case 'g<': return;
    }
    bell();
  }
  let lastMacro = null, recKeys = [];
  function stopRecording(){
    const r = E.recording; E.recording = null;
    const keysArr = recKeys.slice(0, -1); // 最後の q を除く
    const text = keysArr.map(k => typeof k === 'object' ? k.text : k).join('');
    if (/[A-Z]/.test(r)){
      const lr = r.toLowerCase();
      const prev = macros[lr] || (regs[lr] ? textToKeys(regs[lr].text) : []);
      regs[lr] = { text: (regs[lr]?.text || '') + text, type:'c' };
      macros[lr] = prev.concat(keysArr);
    } else {
      regs[r] = { text, type:'c' };
      macros[r] = keysArr;
      if (r !== '"') regs['"'] = regs[r];
    }
    recKeys = [];
  }
  function textToKeys(t){
    const out = [];
    const re = /<(?:[CSAM]-)?(?:[A-Za-z]+|.)>|[\s\S]/gu;
    let m;
    while ((m = re.exec(t))){
      let k = m[0];
      if (k.length > 2 && k.startsWith('<')){
        const norm = { '<esc>':'<Esc>', '<cr>':'<CR>', '<enter>':'<CR>', '<bs>':'<BS>', '<tab>':'<Tab>', '<del>':'<Del>', '<space>':' ', '<lt>':'<' }[k.toLowerCase()];
        if (norm) k = norm;
        else if (/^<C-.>$/i.test(k)) k = '<C-' + k[3].toLowerCase() + '>';
      }
      else if (k === '\x1b') k = '<Esc>';
      else if (k === '\r' || k === '\n') k = '<CR>';
      else if (k === '\t') k = '<Tab>';
      else if (k === '\x08') k = '<BS>';
      else if (k.charCodeAt(0) < 32) k = '<C-' + String.fromCharCode(k.charCodeAt(0) + 96) + '>';
      out.push(k);
    }
    return out;
  }
  function macroKeys(ch){
    const name = /[A-Z]/.test(ch) ? ch.toLowerCase() : ch;
    if (macros[name]) return macros[name];
    const r = readReg(name);
    if (!r) return null;
    const k = textToKeys(r.text);
    if (r.type === 'l') k.push('<CR>');
    return k;
  }
  function runKeys(keysArr, times = 1){
    if (replaying > 50){ err('E169: Command too recursive'); }
    replaying++;
    const savedAbort = abortMacro;
    abortMacro = false;
    try {
      outer: for (let n = 0; n < times; n++){
        for (const k of keysArr){
          feedKey(k, true);
          if (abortMacro) break outer;
        }
      }
    } finally { replaying--; abortMacro = savedAbort && replaying > 0; }
  }
  function dotRepeat(count){
    if (!lastChange) return;
    const lc = lastChange;
    let reg = lc.reg;
    if (reg && /^[1-8]$/.test(reg)) reg = String(+reg + 1), lc.reg = reg;
    const pre = (reg ? ['"', reg] : []).concat(count ? String(count).split('') : (lc.count ? String(lc.count).split('') : []));
    if (lc.visual){
      const v = lc.visual;
      E.mode = 'visual'; E.vmode = v.mode; E.vstart = P(cur.line, cur.col);
      if (v.mode === 'V') setCur(Math.min(L.length - 1, cur.line + v.lines - 1), cur.col);
      else if (v.mode === '<C-v>'){ cur.line = Math.min(L.length - 1, cur.line + v.lines - 1); cur.col = moveChars(cur.line, cur.col, v.cols - 1); }
      else if (v.lines > 1){ cur.line = Math.min(L.length - 1, cur.line + v.lines - 1); cur.col = Math.min(v.endCol, lastCol(L[cur.line])); }
      else cur.col = moveChars(cur.line, cur.col, v.cols - 1);
    }
    const saved = lastChange;
    runKeys(pre.concat(lc.keys));
    lastChange = saved;
    if (isInsertLike()) feedKey('<Esc>', true);
    lastChange = saved;
  }
  function incNumber(line, col, delta, moveCursor, from = 0, to = Infinity){
    const s = L[line];
    const re = /0[xX][0-9a-fA-F]+|0[bB][01]+|\d+/g;
    let m, hit = null;
    while ((m = re.exec(s))){
      if (m.index < from) { if (m.index + m[0].length <= from) continue; }
      if (m.index >= to) break;
      if (m.index + m[0].length > col){ hit = m; break; }
    }
    if (!hit) return false;
    let str = hit[0], start = hit.index, end = start + str.length;
    let out;
    if (/^0[xX]/.test(str)){
      const n = (parseInt(str.slice(2), 16) + delta + 2 ** 32 * 4) % 2 ** 32;
      let h = n.toString(16);
      if (/[A-F]/.test(str.slice(2)) && !/[a-f]/.test(str.slice(2))) h = h.toUpperCase();
      out = str.slice(0, 2) + h.padStart(str.length - 2, '0');
    } else if (/^0[bB]/.test(str)){
      const n = Math.max(0, parseInt(str.slice(2), 2) + delta);
      out = str.slice(0, 2) + n.toString(2).padStart(str.length - 2, '0');
    } else {
      let neg = start > 0 && s[start - 1] === '-' && start - 1 >= from;
      if (neg) start--;
      const v = (neg ? -1 : 1) * parseInt(str, 10) + delta;
      const pad = str.length > 1 && str[0] === '0' ? str.length : 0;
      out = (v < 0 ? '-' : '') + String(Math.abs(v)).padStart(pad, '0');
    }
    edit(line, start, line, end, out);
    if (moveCursor) setCur(line, start + out.length - 1);
    return true;
  }
  function scrollLines(n){
    E.top = clamp(E.top + n, 0, Math.max(0, L.length - 1));
    if (cur.line < E.top) setCur(E.top, colFromWant(E.top));
    else if (cur.line > E.top + E.rows - 1) setCur(Math.max(E.top, E.top + E.rows - 1), colFromWant(Math.max(E.top, E.top + E.rows - 1)));
  }

  /* ---------- ビジュアルモード ---------- */
  function enterVisual(vm){
    E.mode = 'visual'; E.vmode = vm; E.vstart = P(cur.line, cur.col);
    setMsg('');
  }
  function exitVisual(){
    if (!E.vstart) { E.mode = 'normal'; return; }
    const a = E.vstart, b = P(cur.line, cur.col);
    const [s, e] = cmpPos(a, b) <= 0 ? [a, b] : [b, a];
    if (E.vmode === 'V'){ marks['<'] = P(s.line, 0); marks['>'] = P(e.line, Math.max(0, L[e.line].length - 1)); }
    else if (E.vmode === '<C-v>'){ marks['<'] = P(Math.min(a.line, b.line), Math.min(a.col, b.col)); marks['>'] = P(Math.max(a.line, b.line), Math.max(a.col, b.col)); }
    else { marks['<'] = P(s.line, s.col); marks['>'] = P(e.line, e.col); }
    lastVisual = { mode: E.vmode, start: P(a.line, a.col), end: P(b.line, b.col), want };
    E.mode = 'normal'; E.vmode = null; E.vstart = null;
    clampCur();
  }
  function execVisual(r, keys){
    const count = r.count, n1 = count || 1, reg = r.reg;
    if (r.kind === 'motion'){
      if (r.motion.search){ startCmdline(r.motion.key, '', { count, inVisual: true }); return; }
      const res = runMotion(r, null);
      if (res){ moveTo(res); if (E.vmode !== 'v' || res.want === Infinity) { /* keep */ } }
      return;
    }
    if (r.kind === 'cmd'){ execNormal(r, keys); return; }
    if (r.kind === 'obj'){
      const o = textObject(r.obj, r.around, count);
      if (!o) return bell();
      if (o.type === 'line'){ if (E.vmode !== 'V') E.vmode = 'V'; }
      else if (E.vmode === 'V' && (r.obj === 'w' || r.obj === 'W')) { /* Vim は V のまま */ }
      else if (E.vmode !== 'v') E.vmode = 'v';
      const samePos = E.vstart.line === cur.line && E.vstart.col === cur.col;
      if (samePos || cmpPos(o.start, E.vstart) < 0) E.vstart = P(o.start.line, o.start.col);
      const endP = o.type === 'line' ? P(o.end.line, 0) : o.end.col > 0 ? P(o.end.line, pv(L[o.end.line], o.end.col)) : (o.end.line > o.start.line ? P(o.end.line - 1, Math.max(0, L[o.end.line - 1].length - 1)) : P(o.end.line, 0));
      setCur(endP.line, endP.col);
      wantFromCol();
      return;
    }
    const c = r.cmd;
    const vr = visualRange();
    const lines = vr.end.line - vr.start.line + 1;
    visualSnapshot = { mode: E.vmode, lines, cols: vr.type === 'block' ? [...L[vr.start.line].slice(vr.c1, nx(L[vr.start.line], vr.c2))].length : [...getText(vr.start.line, vr.start.col, vr.start.line, vr.start.line === vr.end.line ? vr.end.col : L[vr.start.line].length)].length, endCol: cur.col };
    const toLine = () => ({ type:'line', start: P(vr.start.line, 0), end: P(vr.end.line, L[vr.end.line].length) });
    switch (c){
      case 'v': case 'V': case '<C-v>':
        if (E.vmode === c) exitVisual(); else E.vmode = c;
        return;
      case '<Esc>': case '<C-c>': exitVisual(); return;
      case 'o': { const t = E.vstart; E.vstart = P(cur.line, cur.col); setCur(t.line, t.col); wantFromCol(); return; }
      case 'O': {
        if (E.vmode === '<C-v>'){ const t = E.vstart.col; E.vstart.col = cur.col; cur.col = t; clampCur(); wantFromCol(); }
        else { const t = E.vstart; E.vstart = P(cur.line, cur.col); setCur(t.line, t.col); }
        return;
      }
      case 'gv': {
        if (!lastVisual) return bell();
        const cv = { mode: E.vmode, start: E.vstart, end: P(cur.line, cur.col), want };
        E.vmode = lastVisual.mode; E.vstart = P(lastVisual.start.line, lastVisual.start.col); setCur(lastVisual.end.line, lastVisual.end.col);
        lastVisual = cv; return;
      }
      case ':': exitVisual(); startCmdline(':', "'<,'>"); return;
    }
    exitVisual();
    switch (c){
      case 'd': case 'x': case '<Del>': applyOp('d', vr, reg); return;
      case 'X': case 'D':
        if (vr.type === 'block'){ vr.toEol = true; applyOp('d', vr, reg); }
        else applyOp('d', toLine(), reg);
        return;
      case 'c': case 's': applyOp('c', vr, reg); insCount = 1; return;
      case 'C': case 'S': case 'R':
        if (vr.type === 'block' && c === 'C'){ vr.toEol = true; applyOp('c', vr, reg); if (blockIns) blockIns.toEol = true; }
        else applyOp('c', toLine(), reg);
        insCount = 1; return;
      case 'y': applyOp('y', vr, reg); return;
      case 'Y': applyOp('y', vr.type === 'block' ? Object.assign(vr, { toEol:true }) : toLine(), reg); return;
      case '>': case '<': applyOp(c, toLine(), reg, n1); return;
      case '~': case 'u': case 'U': case 'g~': case 'gu': case 'gU': case 'g?': applyOp(c, vr, reg); return;
      case 'J': case 'gJ': applyOp(c, toLine(), reg); return;
      case '=': case 'gq': case 'gw': applyOp(c, toLine(), reg); return;
      case '!': err('E: フィルタ (!) はこのエディタでは使えません');
      case 'r': {
        let ch = r.arg;
        if (ch === '<Esc>' || ch === '<C-c>') return;
        if (ch === '<CR>') ch = '\n'; else if (ch === '<Tab>') ch = '\t'; else if (isSpecial(ch)) return bell();
        if (typeof ch === 'object') ch = [...ch.text][0];
        didChange = true;
        const rep = (t) => t.replace(/[^\n]/gu, ch === '\n' ? '' : ch);
        if (vr.type === 'line') for (let l = vr.start.line; l <= vr.end.line; l++) setLine(l, [...L[l]].map(() => ch).join(''));
        else if (vr.type === 'block') for (const g of blockSegs(vr)) edit(g.line, g.a, g.line, g.b, [...L[g.line].slice(g.a, g.b)].map(() => ch).join(''));
        else edit(vr.start.line, vr.start.col, vr.end.line, vr.end.col, rep(getText(vr.start.line, vr.start.col, vr.end.line, vr.end.col)));
        setCur(vr.start.line, vr.type === 'block' ? vr.c1 : vr.type === 'line' ? 0 : vr.start.col);
        return;
      }
      case 'p': case 'P': {
        const src = readReg(reg);
        if (!src) err(`E353: Nothing in register ${reg || '"'}`);
        const saved = { text: src.text, type: src.type };
        didChange = true;
        const delReg = c === 'P' ? '_' : null;
        const text = rangeText(vr);
        if (vr.type === 'line'){
          deleteLines(vr.start.line, vr.end.line);
          const atEnd = vr.start.line > L.length - 1 || (L.length === 1 && L[0] === '' && vr.start.line === 0);
          const tmp = '\u0001put';
          regs[tmp] = saved;
          if (saved.type === 'l'){
            if (L.length === 1 && L[0] === '' ){ insertLines(0, saved.text.split('\n')); deleteLines(L.length - 1, L.length - 1); setCur(0, fnb(0)); }
            else { setCur(Math.min(vr.start.line, L.length - 1), 0); put(tmp, count, !atEnd, false); }
          } else {
            insertLines(Math.min(vr.start.line, L.length), ['']);
            setCur(vr.start.line, 0); put(tmp, count, true, false);
          }
          delete regs[tmp];
        } else {
          if (vr.type === 'block'){ for (const g of blockSegs(vr)) if (g.b > g.a) edit(g.line, g.a, g.line, g.b, ''); setCur(vr.start.line, vr.c1); }
          else { edit(vr.start.line, vr.start.col, vr.end.line, vr.end.col, ''); E.mode = 'insert'; setCur(vr.start.line, vr.start.col); }
          const tmp = '\u0001put';
          regs[tmp] = saved;
          if (saved.type === 'l'){ edit(cur.line, cur.col, cur.line, cur.col, '\n'); insertLines(cur.line + 1, saved.text.split('\n')); setCur(cur.line + 1, fnb(cur.line + 1)); }
          else { put(tmp, count, true, false); E.mode = 'normal'; clampCur(); }
          delete regs[tmp];
        }
        if (delReg !== '_') writeReg(null, text, regType(vr), false);
        return;
      }
      case 'I': case 'A': {
        didChange = true;
        if (vr.type === 'block'){
          const col = c === 'I' ? vr.c1 : (vr.toEol ? L[vr.start.line].length : nx(L[vr.start.line], vr.c2));
          E.mode = 'insert';
          if (c === 'A' && L[vr.start.line].length < col){ setLine(vr.start.line, L[vr.start.line].padEnd(col, ' ')); }
          setCur(vr.start.line, Math.min(col, L[vr.start.line].length));
          startInsert(c);
          blockIns = { a: vr.start.line, b: vr.end.line, col: cur.col, line: vr.start.line, append: c === 'A', toEol: vr.toEol && c === 'A' };
          return;
        }
        E.mode = 'insert';
        if (c === 'I') setCur(vr.start.line, vr.type === 'line' ? fnbRaw(vr.start.line) : vr.start.col);
        else setCur(vr.type === 'line' ? vr.end.line : vr.end.line, vr.type === 'line' ? L[vr.end.line].length : vr.end.col);
        if (vr.type === 'char' && c === 'A' && vr.end.col === 0 && vr.end.line > vr.start.line) setCur(vr.end.line - 1, L[vr.end.line - 1].length);
        startInsert(c);
        return;
      }
      case '<C-a>': case '<C-x>': case 'g<C-a>': case 'g<C-x>': {
        const d = (c.endsWith('a>') ? 1 : -1) * n1;
        let k = 0;
        for (let l = vr.start.line; l <= vr.end.line; l++){
          const from = vr.type === 'block' ? vr.c1 : (vr.type === 'char' && l === vr.start.line ? vr.start.col : 0);
          const to = vr.type === 'block' ? nx(L[l], vr.c2) : (vr.type === 'char' && l === vr.end.line ? vr.end.col : Infinity);
          if (incNumber(l, from, c[0] === 'g' ? d * (k + 1) : d, false, from, to)) { k++; didChange = true; }
        }
        setCur(vr.start.line, vr.type === 'block' ? vr.c1 : vr.type === 'char' ? vr.start.col : 0);
        return;
      }
      case 'g<C-g>': setMsg(`Selected ${lines} Lines`); return;
    }
    bell();
  }

  /* ---------- コマンドライン ---------- */
  const hist = { ':': [], '/': [] };
  function pushHist(type, text){
    const h = hist[type === '?' ? '/' : type];
    if (!text) return;
    const i = h.indexOf(text); if (i >= 0) h.splice(i, 1);
    h.push(text); if (h.length > 100) h.shift();
  }
  let cmdRegPending = false, cmdLiteral = false, cmdComplete = null;
  function cmdlineKey(k){
    const c = E.cmd;
    if (k !== '<Tab>' && k !== '<S-Tab>') cmdComplete = null;
    const ins = (t) => { c.text = c.text.slice(0, c.pos) + t + c.text.slice(c.pos); c.pos += t.length; };
    if (typeof k === 'object'){ ins(k.text.replace(/\n/g, ' ')); return afterCmdEdit(); }
    if (cmdLiteral){ cmdLiteral = false; ins(k === '<CR>' ? '\r' : k === '<Tab>' ? '\t' : k === '<Esc>' ? '\x1b' : isSpecial(k) ? '' : k); return afterCmdEdit(); }
    if (cmdRegPending){
      cmdRegPending = false;
      if (k === '<C-w>'){ const w = wordUnderCursorAt(c.save); if (w) ins(w); return afterCmdEdit(); }
      if (k === '<Esc>') return;
      const r = readReg(k.replace(/^<C-(.)>$/, '$1'));
      if (r) ins(r.text.replace(/\n/g, '\r'));
      return afterCmdEdit();
    }
    switch (k){
      case '<Esc>': case '<C-c>': return cancelCmdline();
      case '<CR>': case '<C-m>': case '<C-j>': return submitCmdline();
      case '<BS>': case '<C-h>':
        if (!c.text){ return cancelCmdline(); }
        if (c.pos > 0){ const p = pv(c.text, c.pos); c.text = c.text.slice(0, p) + c.text.slice(c.pos); c.pos = p; }
        return afterCmdEdit();
      case '<Del>': if (c.pos < c.text.length){ c.text = c.text.slice(0, c.pos) + c.text.slice(nx(c.text, c.pos)); } else if (c.pos > 0){ c.text = c.text.slice(0, -1); c.pos--; } return afterCmdEdit();
      case '<Left>': c.pos = pv(c.text, c.pos); return;
      case '<Right>': c.pos = nx(c.text, c.pos); return;
      case '<S-Left>': case '<C-Left>': { let p = c.pos; while (p > 0 && c.text[p - 1] === ' ') p--; while (p > 0 && c.text[p - 1] !== ' ') p--; c.pos = p; return; }
      case '<S-Right>': case '<C-Right>': { let p = c.pos; while (p < c.text.length && c.text[p] !== ' ') p++; while (p < c.text.length && c.text[p] === ' ') p++; c.pos = p; return; }
      case '<Home>': case '<C-b>': c.pos = 0; return;
      case '<End>': case '<C-e>': c.pos = c.text.length; return;
      case '<C-u>': c.text = c.text.slice(c.pos); c.pos = 0; return afterCmdEdit();
      case '<C-w>': {
        let p = c.pos; while (p > 0 && c.text[p - 1] === ' ') p--;
        if (p > 0 && /\w/.test(c.text[p - 1])) while (p > 0 && /\w/.test(c.text[p - 1])) p--; else if (p > 0) p--;
        c.text = c.text.slice(0, p) + c.text.slice(c.pos); c.pos = p; return afterCmdEdit();
      }
      case '<C-r>': cmdRegPending = true; return;
      case '<C-v>': case '<C-q>': cmdLiteral = true; return;
      case '<Up>': case '<Down>': case '<S-Up>': case '<S-Down>': case '<C-p>': case '<C-n>': {
        const h = hist[c.type === '?' ? '/' : c.type];
        if (c.hist === null){ c.hist = h.length; c.prefix = c.text; }
        const up = k === '<Up>' || k === '<S-Up>' || k === '<C-p>';
        const usePrefix = k === '<Up>' || k === '<Down>';
        let i = c.hist;
        for (;;){
          i += up ? -1 : 1;
          if (i < 0){ return bell(); }
          if (i >= h.length){ c.hist = h.length; c.text = c.prefix; c.pos = c.text.length; return afterCmdEdit(); }
          if (!usePrefix || h[i].startsWith(c.prefix)) break;
        }
        c.hist = i; c.text = h[i]; c.pos = c.text.length; return afterCmdEdit();
      }
      case '<Tab>': case '<S-Tab>': {
        if (c.type !== ':') { ins('\t'); return; }
        if (!cmdComplete){
          const m = /^(.*?)([A-Za-z]*)$/.exec(c.text.slice(0, c.pos));
          const head = m[1], word = m[2];
          let list;
          if (/^\s*set?\s+(no)?$|^\s*se(t)?\s+(?:\S+\s+)*(no)?$/.test(head)) list = Object.keys(opts).concat(Object.keys(opts).filter(o => typeof opts[o] === 'boolean').map(o => 'no' + o));
          else if (/^[\s:'<>,.$%\d]*$/.test(head)) list = EX_CMDS.map(x => x[0]).concat(hooks.exNames || []);
          else return;
          const cands = [...new Set(list)].filter(x => x.startsWith(word)).sort();
          if (!cands.length) return;
          cmdComplete = { head, word, cands, idx: -1, tail: c.text.slice(c.pos) };
        }
        const cc = cmdComplete;
        cc.idx = (cc.idx + (k === '<Tab>' ? 1 : cc.cands.length - 1)) % cc.cands.length;
        c.text = cc.head + cc.cands[cc.idx] + cc.tail; c.pos = (cc.head + cc.cands[cc.idx]).length;
        setMsg(cc.cands.length > 1 ? cc.cands.join('  ') : '');
        return;
      }
    }
    if (isSpecial(k)) return;
    ins(k === '<Space>' ? ' ' : k);
    afterCmdEdit();
  }
  function wordUnderCursorAt(p){ const save = P(cur.line, cur.col); cur.line = p.line; cur.col = p.col; const w = wordUnderCursor(); cur.line = save.line; cur.col = save.col; return w && w.text; }
  function afterCmdEdit(){
    const c = E.cmd;
    E.incMatch = null;
    if ((c.type === '/' || c.type === '?') && opts.incsearch && c.text){
      try {
        const [pat] = splitPattern(c.text, c.type);
        if (pat){
          const re = compile(pat);
          const hit = searchFrom(re, c.save, c.type === '/' ? 1 : -1);
          if (hit) E.incMatch = { line: hit.line, col: hit.col, len: hit.len, re };
        }
      } catch { /* 入力途中 */ }
    }
  }
  function cancelCmdline(){
    const c = E.cmd;
    E.mode = E.prevMode === 'visual' && c.inVisual ? 'visual' : 'normal';
    if (E.prevMode === 'visual' && !c.inVisual && c.type !== ':') E.mode = 'visual';
    E.cmd = null; E.incMatch = null; pendingOp = null;
    cur.line = c.save.line; cur.col = c.save.col; E.top = c.top;
    finishCmd();
  }
  function submitCmdline(){
    const c = E.cmd;
    E.cmd = null; E.incMatch = null;
    const backTo = E.prevMode === 'visual' ? 'visual' : 'normal';
    E.mode = c.type === ':' ? 'normal' : backTo;
    if (c.type === ':' && backTo === 'visual') { E.mode = 'normal'; }
    try {
      if (c.type === ':'){
        pushHist(':', c.text);
        if (c.text.trim()){ lastEx = c.text; }
        runEx(c.text);
      } else {
        pushHist('/', c.text);
        const [pat, rest, closed] = splitPattern(c.text, c.type);
        const dir = c.type === '/' ? 1 : -1;
        const po = pendingOp; pendingOp = null;
        const res = doSearch(pat, dir, (po ? po.count : c.count) || 1, closed ? rest : '', !!po);
        if (po){
          pushJump();
          const range = rangeFromMotion(res, po.forced);
          didChange = false;
          applyOp(po.op, range, po.reg, po.count);
          if (didChange && !replaying){
            const rec = { keys: cmdKeysForSearch(po, c), count: po.count, reg: po.reg };
            if (isInsertLike()){ dotRec = rec; } else lastChange = rec;
          }
        } else moveTo(res);
      }
    } catch (e){
      if (!(e instanceof VimError)) throw e;
      setMsg(e.message, true); bell();
      if (c.type !== ':'){ cur.line = c.save.line; cur.col = c.save.col; }
      pendingOp = null;
    }
    finishCmd();
  }
  function cmdKeysForSearch(po, c){ return [...po.op, ...(po.forced ? [po.forced] : []), c.type, ...[...c.text], '<CR>']; }

  /* ---------- Ex コマンド ---------- */
  const EX_CMDS = [
    ['write',1],['wq',2],['wall',2],['wqall',3],['xit',1],['xall',2],['exit',3],['update',2],['quit',1],['qall',2],['quitall',5],
    ['edit',1],['delete',1],['yank',1],['put',2],['move',1],['copy',2],['t',1],['join',1],['substitute',1],['global',1],['vglobal',1],
    ['normal',4],['sort',3],['nohlsearch',3],['set',2],['undo',1],['redo',3],['registers',3],['display',2],['marks',5],['delmarks',4],
    ['mark',2],['k',1],['help',1],['print',1],['list',1],['number',2],['retab',3],['left',2],['right',2],['center',2],['version',2],
    ['echo',2],['jumps',2],['smagic',2],['snomagic',3],['>',1],['<',1],['&',1],['&&',2],['~',1],['=',1],['#',1],['changes',7],
  ];
  function resolveEx(name){
    if (!name) return '';
    for (const [full, min] of EX_CMDS) if (name.length >= min && full.startsWith(name)) return full;
    return null;
  }
  function parseAddr(s, i, base){
    let line = null, j = i;
    while (s[j] === ' ') j++;
    const ch = s[j];
    if (ch === '.'){ line = base; j++; }
    else if (ch === '$'){ line = L.length - 1; j++; }
    else if (ch >= '0' && ch <= '9'){ const m = /^\d+/.exec(s.slice(j)); line = +m[0] - 1; j += m[0].length; }
    else if (ch === "'"){ const mk = getMark(s[j + 1]); if (!mk) err('E20: Mark not set'); line = mk.line; j += 2; }
    else if (ch === '/' || ch === '?'){
      const [pat, rest] = splitPattern(s.slice(j + 1), ch);
      const p2 = pat || lastSearch?.pat;
      if (!p2) err('E35: No previous regular expression');
      const re = compile(p2);
      const from = ch === '/' ? P(base, L[base].length) : P(base, 0);
      const hit = searchFrom(re, from, ch === '/' ? 1 : -1, opts.wrapscan, true);
      if (!hit) err(`E486: Pattern not found: ${p2}`);
      lastSearch = { pat: p2, dir: ch === '/' ? 1 : -1, off:'' };
      line = hit.line;
      j = s.length - rest.length;
    } else if (ch === '\\' && (s[j + 1] === '/' || s[j + 1] === '?')){
      if (!lastSearch) err('E35: No previous regular expression');
      const re = compile(lastSearch.pat);
      const hit = searchFrom(re, s[j + 1] === '/' ? P(base, L[base].length) : P(base, 0), s[j + 1] === '/' ? 1 : -1, opts.wrapscan, true);
      if (!hit) err(`E486: Pattern not found: ${lastSearch.pat}`);
      line = hit.line; j += 2;
    }
    for (;;){
      while (s[j] === ' ') j++;
      if (s[j] === '+' || s[j] === '-'){
        const sign = s[j] === '+' ? 1 : -1; j++;
        const m = /^\d+/.exec(s.slice(j));
        const n = m ? +m[0] : 1; if (m) j += m[0].length;
        if (line === null) line = base;
        line += sign * n;
      } else if (line !== null && s[j] >= '0' && s[j] <= '9' && false){ break; }
      else break;
    }
    return line === null ? null : { line, i: j };
  }
  function runEx(text){
    outBuf = [];
    try { execEx(text); }
    finally {
      const o = outBuf; outBuf = null;
      if (o.length > 1){ E.more = o; }
      else if (o.length === 1) setMsg(o[0]);
    }
  }
  function execEx(text, inGlobal = false){
    let s = String(text).replace(/^[\s:]+/, '');
    if (!s) return;
    if (s.startsWith('"')) return;
    let i = 0, range = [], base = cur.line, sawSep = false;
    if (s[0] === '%'){ range = [0, L.length - 1]; i = 1; }
    else if (s[0] === '*'){ const a = getMark('<'), b = getMark('>'); if (!a || !b) err('E20: Mark not set'); range = [a.line, b.line]; i = 1; }
    else {
      for (;;){
        const a = parseAddr(s, i, base);
        if (a){ range.push(a.line); i = a.i; sawSep = false; }
        while (s[i] === ' ') i++;
        if (s[i] === ',' || s[i] === ';'){
          if (!a && !sawSep && range.length === 0) range.push(cur.line);
          if (s[i] === ';' && range.length) base = range[range.length - 1], cur.line = clamp(base, 0, L.length - 1);
          sawSep = true; i++; continue;
        }
        break;
      }
      if (sawSep) range.push(cur.line);
    }
    while (s[i] === ' ' || s[i] === ':') i++;
    const rest0 = s.slice(i);
    let m = /^([a-zA-Z]+|&&|[&<>=#~!@*])/.exec(rest0);
    let name = m ? m[1] : '';
    i += name.length;
    // :s の区切りなどで名前に続くアルファベットを含めない
    if (/^s[^a-z]/.test(rest0) && !/^s(e|o|u|n|m|i)/.test(rest0) ){ name = 's'; i = s.indexOf('s', i - name.length - 0) + 1; }
    let full = resolveEx(name);
    if (full === null && /^k[a-z]$/.test(name)){ full = 'k'; i -= 1; }
    if (full === null && /^s[a-z]*$/.test(name) && /^(s|su|sub|subs|subst|substi|substit|substitu|substitut|substitute)[gciInerI&]*$/.test(name)){
      const base2 = name.match(/^(s(?:u(?:b(?:s(?:t(?:i(?:t(?:u(?:t(?:e)?)?)?)?)?)?)?)?)?)/)[1];
      full = 'substitute'; i -= name.length - base2.length;
    }
    let bang = false;
    if (s[i] === '!' && full !== '!'){ bang = true; i++; }
    let args = s.slice(i);
    const rawArgs = args;
    if (!['global','vglobal','normal'].includes(full)){
      // | で区切って続きを実行
      let k = 0, depth = 0;
      for (; k < args.length; k++){
        if (args[k] === '\\'){ k++; continue; }
        if (args[k] === '|'){ break; }
      }
      if (k < args.length){
        const tail = args.slice(k + 1);
        args = args.slice(0, k);
        exec1(full, name, range, bang, args, inGlobal);
        return execEx(tail, inGlobal);
      }
    }
    args = args.replace(/\\\|/g, '|');
    return exec1(full, name, range, bang, args, inGlobal, rawArgs);
  }
  function lineRange(range, def = 'cur'){
    if (!range.length){ if (def === 'all') return [0, L.length - 1]; return [cur.line, cur.line]; }
    let a = range.length === 1 ? range[0] : range[range.length - 2], b = range[range.length - 1];
    if (a > b){ const t = a; a = b; b = t; }
    if (a < 0 || b > L.length - 1){ if (b > L.length - 1 && a <= L.length - 1 && false) b = L.length - 1; else err('E16: Invalid range'); }
    return [a, b];
  }
  function regAndCount(args, range){
    args = args.trim();
    let reg = null;
    if (args && !/^\d/.test(args)){ reg = args[0]; args = args.slice(1).trim(); }
    let [a, b] = lineRange(range);
    if (/^\d+$/.test(args)){ const n = +args; a = b; b = Math.min(L.length - 1, a + n - 1); }
    return { reg, a, b };
  }
  function exec1(full, name, range, bang, args, inGlobal, rawArgs = args){
    const a0 = args.trim();
    if (full === ''){
      if (!range.length) return;
      const l = range[range.length - 1];
      pushJump();
      setCur(clamp(l, 0, L.length - 1), 0); cur.col = fnb(cur.line); wantFromCol();
      return;
    }
    if (full === null){
      if (hooks.ex){
        const r = hooks.ex(name, a0, { range, bang, line: L[cur.line], lineNo: cur.line, api });
        if (r !== false && r !== undefined){ if (typeof r === 'string') setMsg(r); return; }
      }
      err(`E492: Not an editor command: ${name}${bang ? '!' : ''}${args}`);
    }
    switch (full){
      case 'write': case 'update': case 'wall': {
        if (full === 'update' && !E.modified) return;
        if (a0.startsWith('!')) err('E: 外部コマンドは使えません');
        doWrite(bang); return;
      }
      case 'wq': case 'xit': case 'exit': case 'wqall': case 'xall': {
        if (full === 'wq' || full === 'wqall' || E.modified){ if (!doWrite(bang)) return; }
        hooks.quit?.(true);
        return;
      }
      case 'quit': case 'qall': case 'quitall': {
        if (E.modified && !bang) err('E37: No write since last change (add ! to override)');
        hooks.quit?.(bang);
        return;
      }
      case 'edit': {
        if (E.modified && !bang) err('E37: No write since last change (add ! to override)');
        const t = hooks.reload?.();
        if (typeof t === 'string'){ const line = cur.line; E.load(t); setCur(Math.min(line, L.length - 1), 0); cur.col = fnb(cur.line); setMsg(`"${E.fileName}" ${L.length}L`); }
        return;
      }
      case 'delete': case 'yank': {
        const { reg, a, b } = regAndCount(args, range);
        writeReg(reg, L.slice(a, b + 1).join('\n'), 'l', full === 'yank');
        if (full === 'delete'){ deleteLines(a, b); setCur(Math.min(a, L.length - 1), 0); cur.col = fnb(cur.line); reportLines(b - a + 1, 'fewer lines'); }
        else reportLines(b - a + 1, 'lines yanked');
        return;
      }
      case 'put': {
        const reg = a0 ? a0[0] : null;
        const r = readReg(reg);
        if (!r) err(`E353: Nothing in register ${reg || '"'}`);
        const at = range.length ? range[range.length - 1] : cur.line;
        const lines = r.type === 'b' ? r.text.split('\n') : r.text.split('\n');
        insertLines(bang ? Math.max(0, at) : at + 1, lines);
        setCur((bang ? Math.max(0, at) : at + 1) + lines.length - 1, 0); cur.col = fnb(cur.line);
        return;
      }
      case 'move': case 'copy': case 't': {
        const [a, b] = lineRange(range);
        const d = parseAddr(a0 || '.', 0, cur.line);
        if (!d) err('E14: Invalid address');
        const dest = d.line;
        if (dest < -1 || dest > L.length - 1) err('E16: Invalid range');
        const chunk = L.slice(a, b + 1);
        if (full === 'move'){
          if (dest >= a && dest < b) err('E134: Cannot move a range of lines into itself');
          if (dest === b || dest === a - 1){ setCur(b, 0); cur.col = fnb(cur.line); return; }
          if (dest > b){ insertLines(dest + 1, chunk); deleteLines(a, b); setCur(dest, 0); }
          else { deleteLines(a, b); insertLines(dest + 1, chunk); setCur(dest + chunk.length, 0); }
          reportLines(chunk.length, 'lines moved');
        } else {
          insertLines(dest + 1, chunk);
          setCur(dest + chunk.length, 0);
        }
        cur.col = fnb(cur.line);
        return;
      }
      case 'join': {
        let [a, b] = lineRange(range);
        if (/^\d+$/.test(a0)){ a = b; b = a + +a0 - 1; }
        if (a === b) b = a + 1;
        if (b > L.length - 1) b = L.length - 1;
        if (a === b) return;
        joinLines(a, b - a + 1, !bang);
        return;
      }
      case '>': case '<': {
        const [a, b] = lineRange(range);
        const times = 1 + (args.match(new RegExp('^\\s*\\' + full + '*'))?.[0].trim().length || 0);
        shiftLines(a, b, full === '>' ? 1 : -1, times);
        setCur(b, 0); cur.col = fnb(b);
        return;
      }
      case 'substitute': case 'smagic': case 'snomagic': return exSubstitute(lineRange(range), args, bang, false);
      case '&': case '&&': return exSubstitute(lineRange(range), full === '&&' ? '&' + args : args, bang, true);
      case '~': return exSubstitute(lineRange(range), args, bang, true, true);
      case 'global': case 'vglobal': return exGlobal(range.length ? lineRange(range) : [0, L.length - 1], rawArgs, full === 'vglobal' || bang, inGlobal);
      case 'normal': {
        const keysArr = [...rawArgs.replace(/^ /, '')];
        if (!keysArr.length) return;
        const [a, b] = range.length ? lineRange(range) : [cur.line, cur.line];
        const runOn = (l) => {
          if (range.length){ setCur(l, 0); }
          E.mode = 'normal'; pending = [];
          replayingOneShot = true;
          try { runKeys(keysArr.map(k => k === '\x1b' ? '<Esc>' : k === '\r' ? '<CR>' : k)); }
          finally { replayingOneShot = false; }
          if (E.mode === 'cmdline'){ E.cmd = null; E.mode = 'normal'; }
          if (isInsertLike()) exitInsert(false);
          if (E.mode === 'visual') exitVisual();
          pending = []; E.showcmd = '';
          endChange();
        };
        if (!range.length) runOn(cur.line);
        else {
          const mk = []; for (let l = a; l <= b; l++) mk.push({ line: l, col: 0 });
          const saveG = gMarks; gMarks = (gMarks || []).concat(mk);
          try { for (const m2 of mk){ if (m2.gone) continue; runOn(m2.line); } }
          finally { gMarks = saveG; }
        }
        return;
      }
      case 'sort': {
        const [a, b] = range.length ? lineRange(range) : [0, L.length - 1];
        const fl = a0;
        let pat = null, mm;
        if ((mm = /([\/'"#|+])(.*?)\1/.exec(fl))) pat = mm[2] || lastSearch?.pat;
        const flags = fl.replace(/([\/'"#|+])(.*?)\1/, '');
        const ic = flags.includes('i'), num = flags.includes('n'), uniq = flags.includes('u'), byMatch = flags.includes('r');
        const re = pat ? compile(pat) : null;
        const keyOf = (s) => {
          let k = s;
          if (re){ re.lastIndex = 0; const r2 = re.exec(s); if (r2) k = byMatch ? r2[0] : s.slice(r2.index + r2[0].length); else k = byMatch ? '' : s; }
          if (num){ const n = /-?\d+/.exec(k); return n ? +n[0] : -Infinity; }
          return ic ? k.toLowerCase() : k;
        };
        const arr = L.slice(a, b + 1).map((s, idx) => ({ s, k: keyOf(s), idx }));
        arr.sort((x, y) => (x.k < y.k ? -1 : x.k > y.k ? 1 : x.idx - y.idx));
        if (bang) arr.reverse();
        let res = arr.map(x => x.s);
        if (uniq){ const out2 = []; for (const x of arr){ if (!out2.length || (ic ? out2[out2.length - 1].k !== x.k : out2[out2.length - 1].k !== x.k) || (num ? false : false)) out2.push(x); } res = out2.map(x => x.s); }
        const changed = res.length !== b - a + 1 || res.some((x, k) => x !== L[a + k]);
        if (changed){ deleteLines(a, b); insertLines(Math.min(a, L.length), res); if (L.length > res.length && L[L.length - 1] === '' && a + res.length === L.length - 1 && b === L.length - 1 + (b - a + 1 - res.length)) { /* noop */ } }
        if (changed && L.length === res.length + 1 && L[L.length - 1] === '' && a === 0) deleteLines(L.length - 1, L.length - 1);
        setCur(a, 0);
        return;
      }
      case 'nohlsearch': E.hlOff = true; return;
      case 'set': return exSet(a0);
      case 'undo': undo(1); return;
      case 'redo': redo(1); return;
      case 'registers': case 'display': {
        const names = ['"','0','1','2','3','4','5','6','7','8','9','a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r','s','t','u','v','w','x','y','z','-','.',':','%','/','+'];
        const want2 = a0.replace(/\s/g, '');
        out('Type Name Content');
        for (const n of names){
          if (want2 && !want2.includes(n)) continue;
          const r = readReg(n);
          if (!r || r.text === '') continue;
          const disp = r.text.replace(/\n/g, '^J').replace(/\t/g, '^I').replace(/\x1b/g, '^[');
          out(`  ${r.type}  "${n}   ${disp.length > 120 ? disp.slice(0, 120) + '…' : disp}${r.type === 'l' ? '^J' : ''}`);
        }
        return;
      }
      case 'marks': {
        out('mark line  col file/text');
        const keys = Object.keys(marks).filter(k => !marks[k].gone).sort();
        for (const k of ["'", ...keys.filter(x => x !== "'")]){
          const mk = getMark(k); if (!mk) continue;
          if (a0 && !a0.includes(k)) continue;
          out(` ${k}  ${String(mk.line + 1).padStart(6)} ${String(mk.col).padStart(4)} ${L[mk.line] ?? ''}`);
        }
        return;
      }
      case 'jumps': {
        out(' jump line  col file/text');
        jumps.forEach((j, idx) => out(`${String(Math.abs(jumpIdx - idx)).padStart(4)} ${String(j.line + 1).padStart(5)} ${String(j.col).padStart(4)} ${L[j.line] ?? ''}`));
        if (jumpIdx >= jumps.length) out('>');
        return;
      }
      case 'delmarks': {
        if (bang){ for (const k of Object.keys(marks)) if (/[a-z]/.test(k)) delete marks[k]; return; }
        const spec = a0.replace(/\s/g, '');
        if (!spec) err('E471: Argument required');
        for (let k = 0; k < spec.length; k++){
          if (spec[k + 1] === '-' && spec[k + 2]){ for (let c = spec.charCodeAt(k); c <= spec.charCodeAt(k + 2); c++) delete marks[String.fromCharCode(c)]; k += 2; }
          else delete marks[spec[k]];
        }
        return;
      }
      case 'mark': case 'k': {
        const ch = a0[0];
        if (!ch) err('E471: Argument required');
        if (!/^[a-zA-Z'`<>\[\]]$/.test(ch)) err('E191: Argument must be a letter or forward/backward quote');
        const l = range.length ? range[range.length - 1] : cur.line;
        marks[ch === '`' ? "'" : ch] = P(l, 0);
        return;
      }
      case 'help': E.more = hooks.help?.() || ['ヘルプはありません']; return;
      case 'print': case 'list': case 'number': case '#': {
        const [a, b] = lineRange(range);
        for (let l = a; l <= b; l++) out(full === 'print' || full === 'list' ? L[l] : `${String(l + 1).padStart(3)} ${L[l]}`);
        setCur(b, 0); cur.col = fnb(b);
        return;
      }
      case '=': out(String(range.length ? range[range.length - 1] + 1 : L.length)); return;
      case 'retab': {
        const [a, b] = range.length ? lineRange(range) : [0, L.length - 1];
        const ts = /^\d+$/.test(a0) ? +a0 : opts.tabstop;
        for (let l = a; l <= b; l++){
          if (!L[l].includes('\t')) continue;
          let o = '', w = 0;
          for (const ch of L[l]){ if (ch === '\t'){ const n = ts - (w % ts); o += ' '.repeat(n); w += n; } else { o += ch; w++; } }
          if (opts.expandtab || bang) setLine(l, o);
        }
        return;
      }
      case 'left': case 'right': case 'center': {
        const [a, b] = lineRange(range);
        const width = /^\d+$/.test(a0) ? +a0 : (full === 'left' ? 0 : 80);
        for (let l = a; l <= b; l++){
          const t = L[l].trim();
          if (full === 'left') setLine(l, ' '.repeat(width) + t);
          else if (full === 'right') setLine(l, ' '.repeat(Math.max(0, width - [...t].length)) + t);
          else setLine(l, ' '.repeat(Math.max(0, Math.floor((width - [...t].length) / 2))) + t);
        }
        return;
      }
      case 'version': setMsg('VIM - Vi IMproved（コメナガレ版・ブラウザ実装）'); return;
      case 'echo': {
        const v = a0.replace(/^"(.*)"$|^'(.*)'$/, (x, d, q) => d ?? q);
        setMsg(v); return;
      }
      case 'changes': setMsg(`変更履歴 ${undoStack.length} 件`); return;
    }
    err(`E492: Not an editor command: ${name}`);
  }
  function doWrite(force){
    if (!hooks.write) err('E: 書き込み先がありません');
    const r = hooks.write(L.join('\n'), force);
    if (!r.ok){ setMsg(r.err, true); bell(); return false; }
    savedVer = ver;
    setMsg(r.msg || `"${E.fileName}" ${L.length}L written`);
    return true;
  }
  function exSet(a0){
    if (!a0 || a0 === 'all'){
      const def = { number:true, relativenumber:false, wrap:true, ignorecase:false, smartcase:false, hlsearch:true, incsearch:true, wrapscan:true, shiftwidth:2, expandtab:false, tabstop:8, scrolloff:0, report:2, joinspaces:false };
      const ch = Object.keys(opts).filter(k => a0 === 'all' || opts[k] !== def[k]).map(k => typeof opts[k] === 'boolean' ? (opts[k] ? '  ' : 'no') + k : `  ${k}=${opts[k]}`);
      E.more = ['--- Options ---', ...(ch.length ? ch : ['  （既定値から変更なし）'])];
      return;
    }
    const msgs = [];
    for (const tok of a0.split(/\s+/)){
      const m = /^(no|inv)?([a-z]+)(!|\?|&|([+\-^]?=)(.*))?$/.exec(tok);
      if (!m) err(`E518: Unknown option: ${tok}`);
      let [, pre, nm, suf, opEq, val] = m;
      nm = OPT_ALIAS[nm] || nm;
      if (!(nm in opts)){
        if (pre === 'no' && (OPT_ALIAS['no' + nm] || ('no' + nm) in opts)){ /* noh 等 */ }
        err(`E518: Unknown option: ${tok}`);
      }
      const isBool = typeof opts[nm] === 'boolean';
      if (suf === '?'){ msgs.push(isBool ? (opts[nm] ? '  ' : 'no') + nm : `  ${nm}=${opts[nm]}`); continue; }
      if (suf === '&'){ continue; }
      if (isBool){
        if (opEq) err(`E474: Invalid argument: ${tok}`);
        opts[nm] = pre === 'no' ? false : (pre === 'inv' || suf === '!') ? !opts[nm] : true;
        if (nm === 'hlsearch' && opts[nm]) E.hlOff = false;
      } else {
        if (!opEq){ msgs.push(`  ${nm}=${opts[nm]}`); continue; }
        const n = parseInt(val, 10);
        if (!isFinite(n) || n < 0) err(`E521: Number required after =: ${tok}`);
        opts[nm] = opEq === '+=' ? opts[nm] + n : opEq === '-=' ? opts[nm] - n : opEq === '^=' ? opts[nm] * n : n;
      }
    }
    if (msgs.length) setMsg(msgs.join(' '));
  }
  let lastSubPat = null, lastRep = '', lastSubFlags = '';
  function exSubstitute([a, b], args, bang, repeat, useSearch){
    let pat, rep, flags, cnt = null;
    const d = args[0];
    if (!repeat && d && !/[a-zA-Z0-9\\"| ]/.test(d)){
      const [p1, r1] = splitPattern(args.slice(1), d);
      pat = p1;
      let rem = r1;
      // 置換文字列は区切り文字まで（\ のエスケープは残す）
      let k = 0;
      for (; k < rem.length; k++){ if (rem[k] === '\\'){ k++; continue; } if (rem[k] === d) break; }
      rep = rem.slice(0, k).split('\\' + d).join(d);
      flags = rem.slice(k + 1);
      if (rep.includes('~') && !/\\~/.test(rep)){ rep = rep.replace(/(^|[^\\])~/g, (x, pre) => pre + lastRep); }
      if (pat === '') { if (!lastSearch) err('E35: No previous regular expression'); pat = lastSearch.pat; }
      lastSubPat = pat; lastRep = rep;
    } else {
      if (lastSubPat === null) err('E35: No previous regular expression');
      pat = useSearch && lastSearch ? lastSearch.pat : lastSubPat; rep = lastRep;
      flags = args.trim();
    }
    if (flags.startsWith('&')) flags = lastSubFlags + flags.slice(1);
    const mc = /\s*(\d+)\s*$/.exec(flags);
    if (mc){ cnt = +mc[1]; flags = flags.slice(0, mc.index); }
    flags = flags.trim();
    lastSubFlags = flags.replace(/[&n]/g, '');
    if (cnt){ a = b; b = Math.min(L.length - 1, a + cnt - 1); }
    const g = flags.includes('g'), countOnly = flags.includes('n'), noErr = flags.includes('e');
    const re = compile(pat, flags);
    lastSearch = { pat, dir: lastSearch?.dir || 1, off:'' };
    E.hlOff = false;
    const replacer = makeReplacer(rep);
    let subs = 0, linesCh = 0;
    const newLines = new Map();
    for (let l = a; l <= b; l++){
      const s = L[l];
      let o = '', last = 0, n = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(s))){
        o += s.slice(last, m.index) + replacer(m);
        last = m.index + m[0].length; n++;
        if (!g) break;
        if (m[0].length === 0){ if (m.index >= s.length) break; re.lastIndex = m.index + 1; }
      }
      if (n){ subs += n; linesCh++; newLines.set(l, o + s.slice(last)); }
    }
    if (!subs){ if (noErr) return; err(`E486: Pattern not found: ${pat}`); }
    if (countOnly){ setMsg(`${subs} match${subs > 1 ? 'es' : ''} on ${linesCh} line${linesCh > 1 ? 's' : ''}`); return; }
    let lastLine = a, added = 0;
    const order = [...newLines.keys()].sort((x, y) => y - x);
    for (const l of order) setLine(l, newLines.get(l));
    for (const l of [...newLines.keys()].sort((x, y) => x - y)){
      const extra = newLines.get(l).split('\n').length - 1;
      lastLine = l + added + extra; added += extra;
    }
    setCur(Math.min(lastLine, L.length - 1), 0); cur.col = fnb(cur.line);
    if (subs > opts.report) setMsg(`${subs} substitution${subs > 1 ? 's' : ''} on ${linesCh} line${linesCh > 1 ? 's' : ''}`);
  }
  function makeReplacer(rep){
    return (m) => {
      let o = '', mode = null, one = null;
      const emit = (str) => {
        for (const ch of str){
          let c = ch;
          if (one){ c = one === 'u' ? c.toUpperCase() : c.toLowerCase(); one = null; }
          else if (mode) c = mode === 'U' ? c.toUpperCase() : c.toLowerCase();
          o += c;
        }
      };
      for (let i = 0; i < rep.length; i++){
        const ch = rep[i];
        if (ch === '\\' && i + 1 < rep.length){
          const n = rep[++i];
          if (n >= '0' && n <= '9') emit(m[+n] ?? '');
          else if (n === 'n' || n === 'r') o += '\n';
          else if (n === 't') o += '\t';
          else if (n === 'u' || n === 'l') one = n;
          else if (n === 'U' || n === 'L') mode = n;
          else if (n === 'e' || n === 'E') mode = null;
          else emit(n);
        } else if (ch === '&') emit(m[0]);
        else if (ch === '\r') o += '\n';
        else emit(ch);
      }
      return o;
    };
  }
  function exGlobal([a, b], args, invert, inGlobal){
    if (inGlobal) err('E147: Cannot do :global recursive');
    const d = args[0];
    if (!d || /[a-zA-Z0-9\\"| ]/.test(d)) err('E146: Regular expressions can\'t be delimited by letters');
    const [p1, cmd0, closed] = splitPattern(args.slice(1), d);
    const pat = p1 || lastSearch?.pat;
    if (!pat) err('E35: No previous regular expression');
    lastSearch = { pat, dir: 1, off:'' }; E.hlOff = false;
    const re = compile(pat);
    const cmd = (closed ? cmd0 : '').trim() || 'p';
    const mk = [];
    for (let l = a; l <= b; l++){ re.lastIndex = 0; if (re.test(L[l]) !== invert) mk.push({ line: l, col: 0 }); }
    if (!mk.length){ setMsg(invert ? `Pattern found in every line: ${pat}` : `Pattern not found: ${pat}`, !invert); return; }
    const saveG = gMarks; gMarks = (gMarks || []).concat(mk);
    try {
      for (const m of mk){
        if (m.gone) continue;
        setCur(m.line, 0);
        execEx(cmd, true);
      }
    } finally { gMarks = saveG; cleanGoneMarks(); }
  }

  /* ---------- 公開 API ---------- */
  function feedKey(k, fromMacro){
    if (E.recording && !fromMacro) recKeys.push(k);
    if (E.more && !fromMacro){
      E.more = null;
      if (k === '<CR>' || k === ' ' || k === '<Esc>' || k === '<C-c>' || k === 'q' || k === '<Space>') return;
    }
    if (dotRec && isInsertLike() && !replaying) dotRec.keys.push(k);
    if (isInsertLike()){
      insKeys.push(k);
      insertKey(k);
      if (E.mode === 'normal' && !E.oneShot) finishCmd();
      return;
    }
    if (E.mode === 'cmdline'){ cmdlineKey(k); return; }
    normalKey(k);
  }
  const api = {
    openLineBelow(text, insert = true){
      insertLines(cur.line + 1, [text]);
      setCur(cur.line + 1, 0);
      if (insert){ E.mode = 'insert'; cur.col = L[cur.line].length; startInsert('A'); }
      else { endChange(); }
    },
    curLine: () => L[cur.line],
  };
  E.api = api;
  E.feed = (k) => {
    try { feedKey(k, false); }
    catch (e){
      if (!(e instanceof VimError)) throw e;
      setMsg(e.message, true);
      if (E.mode === 'cmdline' && !E.cmd) E.mode = 'normal';
      pending = [];
    }
    hooks.onChange?.();
  };
  E.feedKeys = (arr) => { for (const k of arr) E.feed(k); };
  // 次のキーを文字として待っているか（r・f・t など。IME で確定した日本語をノーマルモードでも受け取るため）
  E.wantsChar = () => {
    const n = pending.length;
    return (E.mode === 'normal' || E.mode === 'visual') && n > 0 && ['r','f','F','t','T'].includes(pending[n - 1]) && pending[n - 2] !== '"';
  };
  // キーを打つ前の状態の控えと、そこへの巻き戻し（スマホのキーボードが打った文字をあとから置き換えたとき。
  // 例: Gboard の 12 キーで g を打ってから「大⇔小」で G にする）。ノーマル・ビジュアルモードで控える
  const copyMarks = (o) => { const r = Object.create(null); for (const k in o) r[k] = { ...o[k] }; return r; };
  const copyVisual = (v) => v && { ...v, start: { ...v.start }, end: { ...v.end } };
  E.checkpoint = () => ({
    L: L.slice(), ver, inChange, undo: undoStack.slice(), redo: redoStack.slice(),
    line: cur.line, col: cur.col, want, top: E.top, mode: E.mode, vmode: E.vmode, vstart: E.vstart && P(E.vstart.line, E.vstart.col),
    pending: pending.slice(), cmdKeys: cmdKeys.slice(), regs: { ...regs }, marks: copyMarks(marks),
    jumps: jumps.map((j) => ({ ...j })), jumpIdx, lastChange, lastVisual: copyVisual(lastVisual), recording: E.recording, recLen: recKeys.length,
    msg: E.msg, msgErr: E.msgErr, hlOff: E.hlOff,
  });
  E.rewind = (c) => {
    L = c.L.slice(); ver = c.ver; inChange = c.inChange; undoStack = c.undo.slice(); redoStack = c.redo.slice();
    E.mode = c.mode; E.vmode = c.vmode; E.vstart = c.vstart && P(c.vstart.line, c.vstart.col);
    E.cmd = null; E.more = null; E.oneShot = false; blockIns = null; dotRec = null;
    pending = c.pending.slice(); cmdKeys = c.cmdKeys.slice(); E.showcmd = pending.map(keyLabel).join('');
    for (const k of Object.keys(regs)) delete regs[k];
    Object.assign(regs, c.regs);
    for (const k of Object.keys(marks)) delete marks[k];
    Object.assign(marks, copyMarks(c.marks));
    jumps = c.jumps.map((j) => ({ ...j })); jumpIdx = c.jumpIdx; lastChange = c.lastChange; lastVisual = copyVisual(c.lastVisual);
    E.recording = c.recording; recKeys.length = Math.min(recKeys.length, c.recLen);
    E.msg = c.msg; E.msgErr = c.msgErr; E.hlOff = c.hlOff;
    cur.line = c.line; cur.col = c.col; want = c.want; E.top = c.top;
    clampCur();
    hooks.onChange?.();
  };
  E.ex = (text) => { try { if (E.mode !== 'normal'){ if (isInsertLike()) exitInsert(false); else if (E.mode === 'visual') exitVisual(); else if (E.mode === 'cmdline'){ E.cmd = null; E.mode = 'normal'; } } lastEx = text; pushHist(':', text); runEx(text); } catch (e){ if (!(e instanceof VimError)) throw e; setMsg(e.message, true); } finishCmd(); hooks.onChange?.(); };
  E.load = (text, { keepUndo = false } = {}) => {
    if (!keepUndo){ undoStack = []; redoStack = []; }
    else if (L.length) { undoStack.push({ lines: L.slice(), cur: P(cur.line, cur.col), ver, time: Date.now() }); redoStack = []; }
    inChange = false;
    L = String(text).split('\n');
    if (!L.length) L = [''];
    ver = ++verSeq; savedVer = ver;
    for (const k of Object.keys(marks)) if (k !== "'" ) delete marks[k];
    jumps = []; jumpIdx = 0;
    E.top = clamp(E.top, 0, L.length - 1);
    clampCur();
  };
  E.markSaved = () => { savedVer = ver; };
  E.scrollBy = (n) => { if (E.mode === 'cmdline') return; scrollLines(n); hooks.onChange?.(); };
  E.getText = () => L.join('\n');
  E.setCursor = (line, col) => {
    if (E.mode === 'cmdline') return;
    endChange();
    setCur(clamp(line, 0, L.length - 1), col); wantFromCol();
    if (isInsertLike()){ insStart = P(cur.line, cur.col); insKeys = []; insCount = 1; }
  };
  E.startVisualAt = (line, col) => { if (E.mode !== 'normal' && E.mode !== 'visual') return; if (E.mode === 'normal') { E.mode = 'visual'; E.vmode = 'v'; E.vstart = P(line, col); } };
  E.pasteText = (t) => {
    t = t.replace(/\r\n?/g, '\n');
    if (isInsertLike() || E.mode === 'cmdline'){ E.feed({ text: t }); return; }
    if (E.mode === 'visual') exitVisual();
    const v = t.endsWith('\n') ? { text: t.slice(0, -1), type:'l' } : { text: t, type:'c' };
    regs['+'] = regs['*'] = v;
    try { put('+', 1, false, false); } catch (e){ setMsg(e.message, true); }
    endChange();
    hooks.onChange?.();
  };
  Object.defineProperty(E, 'lines', { get: () => L });
  Object.defineProperty(E, 'modified', { get: () => ver !== savedVer });
  Object.defineProperty(E, 'want', { get: () => want });
  Object.defineProperty(E, 'regs', { get: () => regs });
  return E;
}
if (typeof module !== 'undefined') module.exports = { createVimEngine };
