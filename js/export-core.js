'use strict';
/* コメント付き動画の高速書き出し（WebCodecs）。ワーカーとメインスレッドの両方で使う */

// 入力・出力と映像コーデックを用意する
async function exportSetup(MB, d){
  const input = new MB.Input({ formats: MB.ALL_FORMATS, source: new MB.BlobSource(d.file) });
  const FMT = { mp4: MB.Mp4OutputFormat, mov: MB.MovOutputFormat, webm: MB.WebMOutputFormat, mkv: MB.MkvOutputFormat }[d.container];
  const format = new FMT(d.container === 'mp4' || d.container === 'mov' ? { fastStart: 'in-memory' } : {});
  const output = new MB.Output({ format, target: new MB.BufferTarget() });
  const pref = { mp4: ['avc', 'hevc', 'vp9', 'av1'], mov: ['avc', 'hevc'], webm: ['vp9', 'vp8', 'av1'], mkv: ['avc', 'vp9', 'hevc', 'av1', 'vp8'] }[d.container];
  const supported = format.getSupportedVideoCodecs();
  const vcodec = await MB.getFirstEncodableVideoCodec(pref.filter(c => supported.includes(c)), { width: d.W, height: d.H, bitrate: d.vbps });
  if (!vcodec) throw new Error(d.container === 'mov'
    ? 'このブラウザは H.264 / HEVC のエンコードに対応していないため MOV で書き出せません（MP4 や WebM を選んでください）'
    : 'このブラウザはこの形式の映像をエンコードできません（別の形式を選んでください）');
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('動画ファイルに映像トラックが見つかりません');
  return { input, format, output, vcodec, track };
}
// 元のコマから出力フレームを作る。
// フレームレート指定時は、指定 fps の等間隔の時刻ごとに1フレーム作る。
// 映像はその時刻を含む元のコマを使い（元が 30fps なら実質 30fps）、コメントはフレームごとの時刻で描く。
function exportFramer(MB, d){
  const W = d.W, H = d.H;
  const cv = makeCanvas(W, H), g = cv.getContext('2d');
  const renderer = new CommentRenderer();
  const step = d.fps > 0 ? 1 / d.fps : 0;
  let base = null, k = 0;
  // paint(g, x, y, w, h) で元のコマを描く。ts は出力の時刻、off はコメントの時刻との差
  const frameAt = (paint, vw, vh, ts, dur, off) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    const s = Math.min(W / vw, H / vh), dw = vw * s, dh = vh * s;
    paint(g, (W - dw) / 2, (H - dh) / 2, dw, dh);
    renderer.draw(g, W, H, ts + off, d.layouts, { opacity: 1 });
    return new MB.VideoSample(cv, { timestamp: ts, duration: dur });
  };
  // 元のコマ [ts, ts + dur) に入る出力フレームを返す
  return (paint, vw, vh, ts, dur, off) => {
    if (!(dur > 0)) dur = step || 1 / 30;
    if (!step) return [frameAt(paint, vw, vh, ts, dur, off)];
    if (base === null) base = ts;
    const out = [];
    // 時刻がミリ秒単位に丸められている形式（WebM など）でもコマの割り当てがずれないよう少し余裕を持たせる
    const tol = Math.min(0.002, step / 4);
    while (base + k * step < ts + dur - tol){ out.push(frameAt(paint, vw, vh, base + k * step, step, off)); k++; }
    return out;
  };
}
// 変換の本体
async function exportConvert(MB, d, ctl){
  const { input, format, output, vcodec, track } = await exportSetup(MB, d);
  // このブラウザの WebCodecs で元動画の映像をデコードできない（Firefox で HEVC など）ときは、呼び出し側で再生プレーヤーから映像を取り出す
  if (!(await track.canDecode())){
    const e = new Error('このブラウザでは元動画の映像（' + ((await track.getCodec()) || '不明な形式') + '）を直接デコードできません');
    e.code = 'undecodable';
    throw e;
  }
  const frames = exportFramer(MB, d);
  let relative = null;
  const conv = await MB.Conversion.init({
    input, output, tracks: 'primary',
    trim: { start: d.start, end: d.end },
    video: {
      codec: vcodec, bitrate: d.vbps, forceTranscode: true,
      processedWidth: d.W, processedHeight: d.H, allowTransformationMetadata: false,
      process: (sample) => {
        if (relative === null) relative = sample.timestamp < d.start - 0.5;
        const out = frames((g, x, y, w, h) => sample.draw(g, x, y, w, h), sample.displayWidth, sample.displayHeight,
          sample.timestamp, sample.duration, relative ? d.start : 0);
        return out.length ? out : null;
      },
    },
    audio: d.audio ? {} : { discard: true },
  });
  const lost = conv.discardedTracks.find(x => x.track.type === 'video');
  if (!conv.isValid || lost){
    const why = conv.discardedTracks.map(x => `${x.track.type}: ${x.reason}`).join(', ');
    const e = new Error('この動画は変換できません（' + (why || '対応していない形式') + '）');
    if (lost && lost.reason === 'undecodable_source_codec') e.code = 'undecodable';
    throw e;
  }
  ctl.conv = conv;
  if (ctl.canceled) await conv.cancel();
  conv.onProgress = (p, t) => ctl.onProgress(p, t);
  await conv.execute();
  const buffer = output.target.buffer;
  return { buffer, mime: format.mimeType, ext: format.fileExtension.replace(/^\./, ''), codec: vcodec,
    audioDropped: d.audio && conv.discardedTracks.some(x => x.track.type === 'audio') };
}
