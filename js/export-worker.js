'use strict';
/* 高速書き出し用のワーカー。変換ライブラリ（d.lib）は開始時に読み込む */
importScripts('comment-render.js', 'export-core.js');

const ctl = { canceled: false, conv: null, onProgress: (p, t) => self.postMessage({ type: 'progress', p, t }) };
self.onmessage = async (ev) => {
  const d = ev.data;
  if (d.type === 'cancel'){ ctl.canceled = true; if (ctl.conv) ctl.conv.cancel().catch(() => {}); return; }
  if (d.type !== 'start') return;
  try {
    importScripts(d.lib);
    const r = await exportConvert(self.Mediabunny, d, ctl);
    self.postMessage(Object.assign({ type: 'done' }, r), [r.buffer]);
  } catch (e){
    self.postMessage({ type: ctl.canceled ? 'canceled' : 'error', message: String((e && e.message) || e), code: e && e.code });
  }
};
