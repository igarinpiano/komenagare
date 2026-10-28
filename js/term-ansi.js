// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
'use strict';
/* =====================================================================
   ターミナルの色（ANSI のエスケープシーケンス）の読み取り（DOM 非依存）
   ===================================================================== */
// 0〜15 の色（暗い背景で読めるよう、黒は灰色寄りにする）
const ANSI_PALETTE = [
  '#4d4d4d', '#ff6b6b', '#5fd38d', '#e5c07b', '#6cb6ff', '#d38aea', '#56d4dd', '#d0d0d0',
  '#7f7f7f', '#ff8f8f', '#8ff0b4', '#ffe08a', '#9ccfff', '#e7a8ff', '#8deff5', '#ffffff',
];
// 色の番号（0〜255）を CSS の色にする
function ansiColor256(n){
  if (n < 16) return ANSI_PALETTE[n];
  if (n < 232){
    const v = (k) => k ? 55 + k * 40 : 0;
    n -= 16;
    return `rgb(${v(Math.floor(n / 36))},${v(Math.floor(n / 6) % 6)},${v(n % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
// 出力を少しずつ渡すと、色の付いたかたまり [{ text, style }] にして返す。
// シーケンスがかたまりの境目で切れていても、続きが来るまで待つ。色以外の制御（カーソルの移動・題名など）は捨てる
function createAnsiParser(){
  const st = { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false };
  let rest = '';
  const reset = () => Object.assign(st, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, strike: false, inverse: false });
  // 38;5;n / 38;2;r;g;b の続き（p[i] が 5 か 2）。色と、読んだ数を返す
  const extColor = (p, i) => {
    if (p[i] === 5) return [p[i + 1] >= 0 && p[i + 1] <= 255 ? ansiColor256(p[i + 1]) : null, 2];
    if (p[i] === 2){
      const [r, g, b] = p.slice(i + 1, i + 4).map(v => Math.max(0, Math.min(255, v || 0)));
      return [`rgb(${r},${g},${b})`, 4];
    }
    return [null, 0];
  };
  function sgr(params){
    // ; で区切った1つずつ。38:2::r:g:b のように : で区切ったものは1つのまとまり（2 の次は色空間の欄）
    const groups = (params === '' ? '0' : params).split(';').map(g => g.split(':').map(v => v === '' ? 0 : +v));
    for (let gi = 0; gi < groups.length; gi++){
      const g = groups[gi], n = g[0];
      if (n === 38 || n === 48){
        let c;
        if (g.length > 1){
          const sub = g[1] === 2 && g.length >= 6 ? [2, ...g.slice(3, 6)] : g.slice(1);
          [c] = extColor(sub, 0);
        } else {
          const rest = groups.slice(gi + 1).map(x => x[0]);
          let used; [c, used] = extColor(rest, 0);
          gi += used;
        }
        if (c){ if (n === 38) st.fg = c; else st.bg = c; }
      }
      else if (n === 0) reset();
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4) st.underline = true;
      else if (n === 7) st.inverse = true;
      else if (n === 9) st.strike = true;
      else if (n === 22) st.bold = st.dim = false;
      else if (n === 23) st.italic = false;
      else if (n === 24) st.underline = false;
      else if (n === 27) st.inverse = false;
      else if (n === 29) st.strike = false;
      else if (n >= 30 && n <= 37) st.fg = ANSI_PALETTE[n - 30];
      else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = ANSI_PALETTE[n - 40];
      else if (n === 49) st.bg = null;
      else if (n >= 90 && n <= 97) st.fg = ANSI_PALETTE[n - 90 + 8];
      else if (n >= 100 && n <= 107) st.bg = ANSI_PALETTE[n - 100 + 8];
    }
  }
  // 今の色を CSS にする（何も付いていなければ空）。反転は、色がなければ文字と背景の既定の色を入れ替える
  function style(){
    let fg = st.fg, bg = st.bg;
    if (st.inverse){ [fg, bg] = [bg || 'var(--term-bg, #0b0b0b)', fg || 'var(--term-fg, #ddd)']; }
    const s = [];
    if (fg) s.push('color:' + fg);
    if (bg) s.push('background:' + bg);
    if (st.bold) s.push('font-weight:700');
    if (st.dim) s.push('opacity:.7');
    if (st.italic) s.push('font-style:italic');
    if (st.underline || st.strike) s.push('text-decoration:' + [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' '));
    return s.join(';');
  }
  function push(data){
    const s = rest + data, out = [];
    rest = '';
    const emit = (text) => {
      if (!text) return;
      const k = style(), last = out[out.length - 1];
      if (last && last.style === k) last.text += text; else out.push({ text, style: k });
    };
    let i = 0;
    while (i < s.length){
      const j = s.indexOf('\x1b', i);
      if (j < 0){ emit(s.slice(i)); break; }
      emit(s.slice(i, j));
      const tail = s.slice(j, j + 512);
      let m;
      if ((m = /^\x1b\[([0-?]*)[ -/]*([@-~])/.exec(tail))){ if (m[2] === 'm' && /^[\d;:]*$/.test(m[1])) sgr(m[1]); }
      else if ((m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(tail))){ /* 題名など */ }
      else if ((m = /^\x1b[ -/]*[0-Z\\^-~]/.exec(tail))){ /* 文字の集合の切り替えなど */ }
      else if (s.length - j < 512 && /^\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b]*\x1b?|[ -/]*)$/.test(tail)){ rest = tail; break; } // 途中で切れている（続きを待つ）
      else { i = j + 1; continue; } // 読めないものは ESC だけ捨てる
      i = j + m[0].length;
    }
    return out;
  }
  return { push, reset(){ reset(); rest = ''; } };
}
if (typeof module !== 'undefined') module.exports = { createAnsiParser, ansiColor256, ANSI_PALETTE };
