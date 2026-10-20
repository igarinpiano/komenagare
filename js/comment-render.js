'use strict';
/* コメントの描画（画面・書き出し・書き出しワーカーで共通） */

/* =====================================================================
   定数（ニコニコ動画 HTML5 プレイヤーの挙動を模倣）
   基準ステージ: 高さ 384 / 16:9
   ===================================================================== */
const STAGE_H = 384;
const STAGE_W = STAGE_H * 16 / 9;           // ≒ 682.67
const UESHITA_RANGE = 1530 / 1920;          // 上下コメの縮小基準幅（full なしの場合）
const NAKA_LEAD = 1;                         // 流れるコメントは vpos の 1 秒前に出現
const DEFAULT_DURATION = 3;                  // vpos 以降 3 秒（naka は合計 4 秒）
const FONT_SIZE = { big:{n:39, r:19.5}, medium:{n:27, r:14}, small:{n:18, r:10} };
const LINE_HEIGHT = {
  small:  { n:(18/15)*(475/400), r:(10/7.5)*(475/400) },
  medium: { n:(29/25)*(461/400), r:(15/12.5)*(466/400) },
  big:    { n:(45/40)*(395/400), r:(24/20)*(418/400) },
};
const RESIZE_LINES = { big:3, medium:5, small:7 };
const STROKE_BASE = 2.8;
const FONTS = {
  defont: '"MS PGothic","ＭＳ Ｐゴシック","Hiragino Kaku Gothic ProN","Hiragino Sans","Noto Sans JP","Noto Sans CJK JP",Meiryo,Arial,"Segoe UI Emoji","Apple Color Emoji",sans-serif',
  gothic: '"Noto Sans JP","Yu Gothic","游ゴシック体","游ゴシック","Hiragino Sans",Meiryo,"Segoe UI Emoji",sans-serif',
  mincho: '"Yu Mincho","游明朝体","游明朝","Hiragino Mincho ProN","MS PMincho","ＭＳ Ｐ明朝","Noto Serif JP",serif',
};
const COLOR_TABLE = Object.assign(Object.create(null), {
  white:'#FFFFFF', red:'#FF0000', pink:'#FF8080', orange:'#FFC000', yellow:'#FFFF00',
  green:'#00FF00', cyan:'#00FFFF', blue:'#0000FF', purple:'#C000FF', black:'#000000',
  white2:'#CCCC99', niconicowhite:'#CCCC99', red2:'#CC0033', truered:'#CC0033',
  pink2:'#FF33CC', orange2:'#FF6600', passionorange:'#FF6600', yellow2:'#999900', madyellow:'#999900',
  green2:'#00CC66', elementalgreen:'#00CC66', cyan2:'#00CCCC', blue2:'#3399FF', marineblue:'#3399FF',
  purple2:'#6633CC', nobleviolet:'#6633CC', black2:'#666666',
});
const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

function makeCanvas(w, h){
  if (typeof document !== 'undefined'){ const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}
function nakaX(L, time){ return STAGE_W - (time - L.start) * L.speed; }

/* =====================================================================
   描画
   ===================================================================== */
function paintComment(g, L, s, x0, y0, border){
  const fs = L.fs * s;
  g.font = `600 ${fs}px ${L.font}`;
  g.textBaseline = 'middle'; g.textAlign = 'left'; g.lineJoin = 'round'; g.miterLimit = 2;
  g.lineWidth = Math.max(1, STROKE_BASE * (L.fs / 27) * s);
  g.strokeStyle = L.color === '#000000' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)';
  const lh = L.lh * s;
  for (let i = 0; i < L.lines.length; i++) g.strokeText(L.lines[i], x0, y0 + (i + 0.5) * lh);
  g.fillStyle = L.color;
  for (let i = 0; i < L.lines.length; i++) g.fillText(L.lines[i], x0, y0 + (i + 0.5) * lh);
  if (border){
    const p = 2 * s;
    g.lineWidth = Math.max(1, (border === 2 ? 2 : 1.2) * s);
    g.strokeStyle = border === 2 ? '#38d0ff' : '#FFD800';
    if (border === 2) g.setLineDash([4 * s, 3 * s]);
    g.strokeRect(x0 - p, y0 - p * 0.5, L.w * s + p * 2, L.h * s + p);
    g.setLineDash([]);
  }
}

class CommentRenderer {
  constructor(){ this.cache = new Map(); this.scale = 0; this.frame = 0; }
  reset(){ this.cache.clear(); }
  // ビットマップは見た目を決める cmd + 本文で共有する（再レイアウトしても描き直さない）
  bitmap(L, s, border){
    const key = L.c.cmd + '\u0002' + L.c.text;
    let e = this.cache.get(key);
    if (e && e.border === border){ e.used = this.frame; return e; }
    const stroke = Math.max(1, STROKE_BASE * (L.fs / 27) * s);
    const pad = Math.ceil(stroke + 3 * s) + 2;
    const cw = Math.ceil(L.w * s * 1.03) + pad * 2, ch = Math.ceil(L.h * s) + pad * 2;
    if (cw > 16000 || ch > 16000 || cw * ch > 3.2e7){
      e = { direct: true, border, used: this.frame };
    } else {
      const cv = makeCanvas(Math.max(1, cw), Math.max(1, ch));
      paintComment(cv.getContext('2d'), L, s, pad, pad, border);
      e = { cv, pad, border, used: this.frame };
    }
    this.cache.set(key, e);
    return e;
  }
  draw(g, W, H, time, layouts, { opacity = 1, mineBorder = false, selected = null } = {}){
    const s = H / STAGE_H;
    const ox = (W - STAGE_W * s) / 2;
    if (Math.abs(s - this.scale) > 1e-6){ this.cache.clear(); this.scale = s; }
    this.frame++;
    for (const L of layouts){
      if (L.invisible || time < L.start || time >= L.end) continue;
      const x = L.o.pos === 'naka' ? nakaX(L, time) : (STAGE_W - L.w) / 2;
      const border = selected && selected.has(L.c.id) ? 2 : (mineBorder && L.c.mine ? 1 : 0);
      const e = this.bitmap(L, s, border);
      g.globalAlpha = opacity * L.alpha;
      if (e.direct) paintComment(g, L, s, ox + x * s, Math.round(L.y * s), border);
      else g.drawImage(e.cv, ox + x * s - e.pad, Math.round(L.y * s) - e.pad);
    }
    g.globalAlpha = 1;
    if (this.frame % 240 === 0){
      for (const [k, e] of this.cache) if (this.frame - e.used > 240) this.cache.delete(k);
    }
  }
}
