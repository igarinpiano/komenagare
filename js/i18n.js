// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
'use strict';
/* 画面の言葉（日本語・英語）。?lang=en で英語、?lang=ja で日本語にし、選んだものはこのブラウザで覚える（komenagare.lang）。
   - JS の中の言葉は T('…') と T`…${x}…` で書く。日本語のときはそのまま返す。英語のときは下の EN から引く
     （T`…` のキーは ${…} を {0} {1} … にしたもの。訳では順番を入れ替えてよい）。EN に無ければ日本語のまま（括弧などだけ直す）
   - index.html の言葉は、開いたときに I18N.translate(document.body) で置き換える（文字と title・placeholder・aria-label）。
     使い方（#helpDlg）は丸ごと HELP_EN にする
   - 書き出しのワーカーでも読む（ワーカーの URL の ?lang= で受け取る。DOM は触らない） */
// 使い方（英語）。日本語の使い方（index.html の #helpDlg）と同じ内容にする
var HELP_EN = `
<h4>Basic workflow (working as a group)</h4>
<ol style="margin:0;padding-left:20px">
  <li>Everyone gets the same video file and loads it with “Open video”</li>
  <li>Open a comment file (.json). The first person can start from scratch</li>
  <li>Write comments and save them to a file with “Save” (it appends to the file you opened)</li>
  <li>Share the file; others combine it with theirs using “Merge”</li>
</ol>
<p class="muted">Merging is a union that treats comments with identical time, command and text as duplicates. Comments are re-sorted by the same rules, so after a merge they flow in nearly the same places for everyone (font differences may shift them slightly). In Chrome / Edge you can save straight to the file you opened, and each save also picks up new comments from the file (so shared folders such as Dropbox are safer to use together).</p>

<h4>Commands (Niconico compatible)</h4>
<table>
  <tr><td>Position</td><td><code>naka</code> (flowing, default) <code>ue</code> (fixed top) <code>shita</code> (fixed bottom)</td></tr>
  <tr><td>Size</td><td><code>big</code> <code>medium</code> (default) <code>small</code></td></tr>
  <tr><td>Color</td><td><code>white</code> <code>red</code> <code>pink</code> <code>orange</code> <code>yellow</code> <code>green</code> <code>cyan</code> <code>blue</code> <code>purple</code> <code>black</code><br>
    Premium colors <code>white2</code> <code>red2</code> … <code>black2</code> (aliases such as <code>niconicowhite</code> <code>truered</code> work too), color codes <code>#RRGGBB</code></td></tr>
  <tr><td>Font</td><td><code>defont</code> (default) <code>gothic</code> <code>mincho</code></td></tr>
  <tr><td>Duration</td><td><code>@seconds</code> (e.g. <code>@10</code>)</td></tr>
  <tr><td>Other</td><td><code>invisible</code> (hidden) <code>full</code> (fixed comments may use the full width) <code>ender</code> (no line-count resize) <code>_live</code> (semi-transparent)</td></tr>
</table>
<p class="muted">When several commands of the same kind are given, the first one wins. Comments with many lines shrink automatically (big 3+, medium 5+, small 7+ lines), and fixed comments wider than the screen shrink to fit. Comments that don’t fit are overlaid at random heights.</p>

<h4>Shortcuts</h4>
<table>
  <tr><td>Space / K</td><td>Play / pause</td></tr>
  <tr><td>← / →</td><td>Back / forward 5 s (1 s with Shift)</td></tr>
  <tr><td>↑ / ↓</td><td>Volume</td></tr>
  <tr><td>Enter</td><td>Jump to the comment input</td></tr>
  <tr><td>C / F / M</td><td>Show comments / full screen / mute</td></tr>
  <tr><td>Ctrl+S</td><td>Save (Shift for Save as)</td></tr>
  <tr><td>Ctrl+Z / Ctrl+Shift+Z</td><td>Undo / redo comment edits</td></tr>
  <tr><td>I / O</td><td>Set the in / out point at the playhead (Alt+I, Alt+O clear them; Alt+X clears both)</td></tr>
</table>

<h4>Layout</h4>
<p class="muted" style="margin:0">On a computer, choose how panels are arranged from “Layout” at the right of the menu bar: “Standard” (preview and list on top, timeline below), “List on right” (preview and timeline on the left, the list full height on the right) or “Timeline on right” (preview and list on the left, the timeline full height on the right). The three buttons next to it show or hide the preview, list and timeline, so you can have just the timeline, or just the preview and list. Drag the gaps between panels to resize them (double-click to reset); sizes are remembered per layout. When the preview gets short, the preset buttons move next to the comment input so the video stays as large as possible. On phones, switch with the tabs below the video.</p>

<h4>Timeline</h4>
<table>
  <tr><td>Overview strip</td><td>Drag the yellow frame to move the view, drag its edges to zoom. Tap outside the frame to jump there</td></tr>
  <tr><td>Moving comments</td><td>Drag a comment (on phones, tap to select it first, then drag)</td></tr>
  <tr><td>Multiple selection</td><td>⌘ (Ctrl on Windows / Linux)+click adds or removes one; ⌘+drag draws a box to add many (the cursor turns into a crosshair while ⌘ is held). Turn on “Marquee” to box-select by dragging empty space (handy on phones). Move the selection by dragging, delete with <code>Delete</code>, nudge with <code>,</code> <code>.</code></td></tr>
  <tr><td>Duplicate</td><td>Option (Alt)+drag a comment to copy the selection to where you drop it (the originals stay)</td></tr>
  <tr><td>Create with a length</td><td>Shift+drag across empty space creates a comment visible for that span in that lane (top / flow / bottom). Flowing comments appear 1 s early, which is subtracted</td></tr>
  <tr><td>Trim start / end</td><td>Drag the left / right edge of a selected comment. This changes the duration; flowing comments change speed accordingly (<code>@seconds</code> is added automatically)</td></tr>
  <tr><td>Create / edit text</td><td>“New”, or double-click (double-tap) empty space. Double-click a comment or press Enter to edit its text and time</td></tr>
  <tr><td>Zoom / scroll</td><td>Ctrl+wheel, pinch or the zoom buttons zoom; the wheel or dragging empty space scrolls. Scroll lanes with the scrollbar on the right, Shift+wheel, or the wheel over the left header. Wheel behavior can be changed in timeline settings; trackpads and Magic Mouse can move freely in 360°. Drag on the ruler to move the playhead</td></tr>
  <tr><td>Size</td><td>Drag the gap between the timeline and other panels (double-click to reset). Drag where two gaps meet to change height and width together. On a phone held upright, drag the handle above the “Timeline / List / Vim / History” tabs to resize the video. Lane height (short / normal / tall) is in timeline settings</td></tr>
  <tr><td>Timecode</td><td>The number at the top left is the playhead. Click it, type a time (like <code>1:23.5</code>) and press Enter to jump there. ▶ next to it plays and pauses (even with the preview hidden). Hovering shows a thin line and the time under the pointer</td></tr>
  <tr><td>In and out points</td><td>“[→” and “→]” (keys <code>I</code> <code>O</code>) set the start and end of a range at the playhead. The range shows in amber on the ruler and seek bar and becomes the default export range. Turn on “↻” loop playback to repeat the range (or the whole video). “×” clears the range</td></tr>
  <tr><td>Follow</td><td>With “Follow” on, the playhead stops at the center during playback and the timeline scrolls instead</td></tr>
  <tr><td>Keys (timeline focused)</td><td><code>Delete</code> delete　<code>Enter</code> edit　<code>,</code> <code>.</code> nudge 0.1 s (1 s with Shift)　<code>N</code> snapping　<code>Shift+Z</code> fit all</td></tr>
</table>

<h4>Comment presets</h4>
<p class="muted" style="margin:0">Add frequent comments (like <code>888</code>) with “＋ Add presets” below the input (“⚙ Edit” afterwards). Pressing a preset posts it at the playhead; Shift+click inserts it into the input. The first ten can also be posted with keys <code>1</code>–<code>9</code>, <code>0</code>.</p>

<h4>Export</h4>
<p class="muted" style="margin:0">“Fast” decodes and encodes the video file directly, so it is faster than real time, and you can keep editing or switch tabs while it runs (“Continue in background” closes the dialog and keeps going). Formats: MP4 / MOV / WebM / MKV. If your browser or video doesn’t support it, use “Real-time recording”. Resolution can be the source size (even 8K) or smaller. Bitrate can be “Same as source” (default), “Match resolution”, or a number. In Chrome / Edge you choose where to save when starting, and the file is written gradually, so long videos use little memory. Browsers that can’t choose a save location download the result, up to 4 GB at a time. For very large videos such as 8K, the CLI’s <code>komenagare render</code> is recommended. When in and out points are set, they become the export range.</p>

<h4>Vim editor</h4>
<p class="muted" style="margin:0">Edit comments as text, one per line (<code>01:23.45 ue red | text</code>), with Vim keys. Change times or commands and apply with <code>:w</code>; close with <code>:q</code>. <code>:now</code> adds a line at the playhead, <code>:seek</code> jumps to the time on the cursor line. Long lines wrap; <code>:set nowrap</code> scrolls sideways instead and <code>:set linebreak</code> wraps at word boundaries (options set with <code>:set</code> are kept for next time). See <code>:help</code> in the editor for the supported keys. On phones, the key bar at the bottom enters Esc and Ctrl (Esc is also next to :w above).</p>

<h4>History</h4>
<p class="muted" style="margin:0">The “History” tab on the right lists comment additions, changes and deletions, newest first. “Undo” adds a change that reverses it (it stops if the same comment changed afterwards), and “Go” jumps to that comment’s time. While collaborating, everyone’s changes appear.</p>

<h4>Editing together</h4>
<p class="muted" style="margin:0">When you open a page hosted with the <code>komenagare</code> command, you edit the same comments together with the other participants (“Live” appears at the top right). Changes are saved in the host’s folder and kept in git history. If two people change the same field of the same comment at once, the first one wins, and “⚠ Conflicts” lets you choose to use your change, keep theirs, or keep both. Conflicts set to “Later” appear for the others too, and anyone can decide. You can keep editing while disconnected; changes are sent when the connection returns.</p>
<p class="muted" style="margin:6px 0 0">When the host shares several projects, switch between them or open them in new tabs with the project button at the top right (the same project may be open in several tabs). If the host uses one-time passwords, log in with the one you received.</p>
<p class="muted" style="margin:6px 0 0">To work outside your local network, start the host with <code>komenagare --otp --tunnel tailscale</code> (or <code>cloudflare</code> / <code>ngrok</code>), or pass your own URL with <code>--public-url</code>. See the README for details.</p>
<p class="muted" style="margin:6px 0 0">Other participants’ playheads, selected comments and pointers appear faintly in their colors on the seek bar, timeline, list and preview. Click “Live” at the top right to open the participant list, where you can change your display name or “Follow” someone’s playhead and timeline view (seeking or scrolling yourself stops following; if they reconnect, following continues). You’re told briefly when people join or leave.</p>
<p class="muted" style="margin:6px 0 0">📣 (Look here) on the playback bar tells the others the current position and selected comments; they can jump there with “View”. 🔗 copies a link to the current position (or to the selected comment). Anyone who opens it jumps there (or when they open the video, if it isn’t open yet).</p>
<p class="muted" style="margin:6px 0 0">Everyone opens their own copy of the video, so you’re told when someone’s video has a different length (a different video would put comments at the wrong moments). It also shows in the participant list.</p>
<p class="muted" style="margin:6px 0 0">If the host was started with <code>--remote</code> and you’re allowed, “Terminal” at the top right runs commands (<code>git status</code>, <code>git push</code>, …) in the host’s project folder. Commands that ask for input don’t work. Commands are logged on the host.</p>
<p class="muted" style="margin:6px 0 0">The same people can use “Time Machine” to look back through earlier comments kept in git. Move the pointer or a finger near the scale on the right (older at top, now at the bottom; days are separated by faint bands, and longer ticks mean more changes in that commit) and nearby ticks magnify and show the date; press to see the comments from that time (on phones, slide and release). With many ticks the scale scrolls: the wheel on a computer, a quick swipe on a phone (press and hold briefly, then slide to choose). Comments added or changed in that commit are outlined (step through them with “n changes” in the menu bar), and recently changed ones are brighter on the timeline. Playback, the timeline and export keep working while you look, but editing doesn’t. “Restore this point…” records a new commit that changes the current comments back to that point (history isn’t erased).</p>

<h4>File formats</h4>
<p class="muted" style="margin:0">JSON: an array of <code>{"t": seconds, "cmd": "command", "text": "text", "id": "UUID"}</code> (under the <code>comments</code> key). CSV: four columns <code>time,command,text,id</code>. To keep spreadsheets from running cells as formulas, cells starting with <code>= + - @</code> and similar get a leading <code>'</code> (Komenagare removes it when reading). <code>id</code> identifies each comment; if omitted, a new one is assigned on load. Niconico comment XML (<code>&lt;chat vpos mail&gt;</code>) and comment JSON can be read too.</p>

<h4>Language</h4>
<p class="muted" style="margin:0">Add <code>?lang=en</code> to the URL for English or <code>?lang=ja</code> for Japanese, or change it under Settings in the comment list. The choice is remembered in this browser. Messages from the host (the komenagare command) stay in Japanese.</p>

<h4>License</h4>
<p class="muted" style="margin:0">Komenagare © 2026 Igarin. Published under the <a href="https://github.com/igarinpiano/komenagare" target="_blank" rel="noopener">Apache License 2.0</a> (distribute LICENSE and NOTICE with the code). Video conversion uses <a href="https://github.com/Vanilagy/mediabunny" target="_blank" rel="noopener">Mediabunny</a> (MPL-2.0).</p>
`;
var I18N = (function (){
  let lang = 'ja';
  try {
    const q = new URLSearchParams(self.location.search).get('lang');
    if (q === 'en' || q === 'ja'){
      lang = q;
      try { self.localStorage && localStorage.setItem('komenagare.lang', q); } catch {}
    } else {
      try { if (self.localStorage && localStorage.getItem('komenagare.lang') === 'en') lang = 'en'; } catch {}
    }
  } catch {}

  const EN = {
    // ---------- メニューバー・配置 ----------
    'コメナガレ': 'Komenagare', 'コメ': 'Kome', 'ナガレ': 'nagare',
    '動画ファイルを開く': 'Open a video file', '動画を開く': 'Open video',
    'コメントファイル': 'Comment file',
    'コメントファイルを開く（現在のコメントと置き換え）': 'Open a comment file (replaces the current comments)',
    'コメントを開く': 'Open comments', '複数のコメントファイルを現在のコメントに統合': 'Merge comment files into the current comments',
    'マージ': 'Merge', '保存 (Ctrl+S)': 'Save (Ctrl+S)', '保存': 'Save',
    '名前を付けて保存 (Ctrl+Shift+S)': 'Save as (Ctrl+Shift+S)', '名前を付けて保存': 'Save as',
    'タイムマシン': 'Time Machine', 'ひとつ前（古い方）へ': 'Previous (older)', 'ひとつ後（新しい方）へ': 'Next (newer)',
    '前の変わったコメントへ': 'Previous changed comment', '次の変わったコメントへ': 'Next changed comment',
    '今のコメントを、このときのコメントに戻す（新しいコミットとして記録します）': 'Bring the comments back to this point (recorded as a new commit)',
    'この時点に復元…': 'Restore this point…', 'タイムマシンを終わって、今に戻る': 'Leave Time Machine and return to now', '終了': 'Done',
    '動画: なし': 'Video: none', 'プロジェクトの一覧（切り替え・新しいタブで開く）': 'Projects (switch, or open in a new tab)',
    'ホストの作業フォルダでコマンドを打つ': 'Run commands in the host’s project folder', 'ターミナル': 'Terminal',
    'git の履歴をさかのぼって、前のコメントを見る・戻す': 'Go back through the git history to view or restore earlier comments',
    'ほかの人の変更と重なった変更を確認する': 'Review changes that collided with someone else’s',
    '出すパネル': 'Panels', 'プレビュー（動画）を出す・隠す': 'Show or hide the preview (video)', 'プレビュー': 'Preview',
    'コメントリスト（Vim エディタ・変更履歴）を出す・隠す': 'Show or hide the comment list (Vim editor, history)', 'コメントリスト': 'Comment list',
    'タイムラインを出す・隠す': 'Show or hide the timeline', 'タイムライン': 'Timeline',
    '画面の配置を選ぶ': 'Choose a layout', '配置': 'Layout', 'コメントを焼き込んだ動画を書き出す': 'Export the video with comments burned in',
    '書き出し': 'Export', '使い方': 'Help', '画面の配置': 'Layout', '出すもの': 'Show',
    '境目のすき間をドラッグすると大きさを変えられます（ダブルクリックで元の大きさ）。配置ごとに大きさを覚えています。': 'Drag the gaps between panels to resize them (double-click to reset). Sizes are remembered per layout.',
    '標準': 'Standard', '右にリスト': 'List on right', '右にタイムライン': 'Timeline on right',
    'どれか1つは出しておく必要があります': 'At least one panel has to stay visible',
    // ---------- プレビュー・コメント欄 ----------
    'を追いかけています': ' — following', '（つなぎ直すのを待っています）': ' (waiting for them to reconnect)', 'やめる': 'Stop',
    '動画ファイルをここにドロップ': 'Drop a video file here', 'または上の「動画を開く」から選択してください。': 'or choose one with “Open video” above.',
    'コメントファイル（.json / .csv / ニコニコ形式 .xml）もドロップで読み込めます。': 'You can also drop comment files (.json / .csv / Niconico .xml).',
    '再生/一時停止 (Space)': 'Play/pause (Space)', 'ミュート (M)': 'Mute (M)', 'コメント 0': '0 comments', 'コメント {0}': '{0} comments',
    'ここ見て：今の再生位置（と選んでいるコメント）を、ほかの参加者に知らせる': 'Look here: send the current position (and selected comments) to the others',
    'この位置へのリンクをコピー（コメントを1件選んでいれば、そのコメントへのリンク）': 'Copy a link to this position (or to the selected comment)',
    '再生速度': 'Playback speed', 'コメント表示 ON/OFF (C)': 'Show/hide comments (C)', 'フルスクリーン (F)': 'Full screen (F)',
    'コマンド一覧': 'Command list', 'コマンド': 'Command', '例: ue red big': 'e.g. ue red big',
    'コメントを入力（Enterで投稿 / Shift+Enterで改行）': 'Write a comment (Enter to post, Shift+Enter for a new line)',
    'コメントする': 'Post', 'ドラッグで動画の大きさを変更（ダブルタップでリセット）': 'Drag to resize the video (double-tap to reset)',
    'リスト': 'List', '履歴': 'History',
    'ドラッグで幅を変える（ダブルクリックで元の幅）': 'Drag to change the width (double-click to reset)',
    'ドラッグで高さを変える（ダブルクリックで元の高さ）': 'Drag to change the height (double-click to reset)',
    'ドラッグで幅と高さを同時に変える（ダブルクリックで元の大きさ）': 'Drag to change width and height together (double-click to reset)',
    'この動画は再生できません（ブラウザが形式に対応していない可能性があります）': 'This video can’t be played (the browser may not support its format)',
    '先に動画を開いてください': 'Open a video first', '同じ時刻に同じコメントが既にあります': 'The same comment already exists at this time',
    '「{0}」を投稿しました': 'Posted “{0}”',
    '{0}{1}\nクリックで投稿 / Shift+クリックで入力欄に挿入': '{0}{1}\nClick to post / Shift+click to insert into the input', '\nキー: {0}': '\nKey: {0}',
    'よく使うコメント（888 など）を登録すると、ワンタップで投稿できます': 'Save comments you use often (like 888) to post them with one tap',
    '⚙ 編集': '⚙ Edit', '＋ プリセットを登録': '＋ Add presets', 'コメントプリセットの追加・編集': 'Add or edit comment presets',
    '本文（例: 888）': 'Text (e.g. 888)', 'コマンド（任意）': 'Command (optional)', '上へ': 'Up', '下へ': 'Down', '削除': 'Delete',
    'まだ登録されていません。「＋ 追加」から登録してください。': 'No presets yet. Add one with “＋ Add”.',
    'コメント入力欄が空です': 'The comment input is empty', 'プリセットを保存しました（{0} 件）': 'Saved presets ({0})',
    '位置': 'Position', 'サイズ': 'Size', '色': 'Color', '色2': 'Color 2', 'フォント': 'Font', '特殊': 'Other',
    '任意の色 (#RRGGBB)': 'Any color (#RRGGBB)', '@秒': '@sec', '表示時間（秒）': 'Duration (seconds)',
    // ---------- コメントリスト・設定 ----------
    'Vim エディタ': 'Vim editor', '変更履歴': 'History', '0件': '0', '{0}件': '{0}', '{0} / {1}件': '{0} / {1}',
    '自動スクロール': 'Auto-scroll', 'コメント・コマンドで絞り込み': 'Filter by text or command', '時間': 'Time', 'コメント': 'Comment', '設定': 'Settings',
    '該当するコメントはありません': 'No matching comments',
    'コメントはまだありません。\n動画を再生しながら下の入力欄から書き込めます。': 'No comments yet.\nPlay the video and write in the input below.',
    'コメントの不透明度': 'Comment opacity', 'コメント入力中は一時停止': 'Pause while typing a comment', '自分のコメントを枠で囲む': 'Outline my comments',
    '投稿・削除時に自動保存': 'Save automatically after posting or deleting',
    'コメントが多いときもリストを軽く保ちます（見えている行だけを作ります。オフにすると全部の行を作ります）。どちらも長い本文は折り返して 10 行まで出し、それを超える分はマウスを重ねると出ます': 'Keeps the list fast with many comments (only visible rows are built; turn off to build every row). Long text wraps up to 10 lines either way; hover to see the rest',
    'コメントリストを軽くする（見えている行だけ作る）': 'Lightweight list (build only visible rows)', 'ダウンロード保存の形式': 'Download format',
    'プレビューの帯の色': 'Letterbox color', '黒に戻す': 'Reset to black', 'コメントを流す範囲': 'Comment area',
    '縦長などの 16:9 でない動画で、コメントを流す範囲（書き出しも同じ）': 'Where comments flow on videos that aren’t 16:9, such as vertical ones (also used for export)',
    '動画に合わせる': 'Match the video', '16:9 に固定（ニコニコ動画と同じ）': 'Fixed 16:9 (same as Niconico)',
    '言語 / Language': 'Language / 言語',
    'コメントを削除しました': 'Deleted the comment', '元に戻す': 'Undo',
    'XML の解析に失敗しました': 'Couldn’t parse the XML', 'JSON の解析に失敗しました': 'Couldn’t parse the JSON', 'コメントの配列が見つかりません': 'No comment array found',
    '動画: ': 'Video: ', 'なし': 'none', 'コメント: ': 'Comments: ', '新規': 'New', '● 未保存': '● Unsaved', '✓ 保存済み': '✓ Saved', ' · 自動保存': ' · autosave',
    'このブラウザは開いたコメントファイルへの直接保存に対応しています。保存時にはファイル側に増えたコメントも取り込んでから書き込みます。': 'This browser can save straight to the comment file you opened. Before writing, it also picks up comments that were added to the file.',
    'このブラウザはファイルへの直接保存に非対応のため、保存はダウンロードになります（Chrome / Edge 推奨）。': 'This browser can’t save to files directly, so saving downloads a file (Chrome / Edge recommended).',
    'ファイルへの書き込みが許可されませんでした': 'Permission to write the file was denied',
    'ファイル側にあった新しいコメント {0} 件を取り込みました': 'Picked up {0} new comments from the file',
    'コメントファイル (JSON)': 'Comment file (JSON)', 'コメントファイル (CSV)': 'Comment file (CSV)',
    '{0} に保存しました': 'Saved to {0}', '{0} をダウンロードしました': 'Downloaded {0}', '保存に失敗しました: ': 'Couldn’t save: ', '自動保存に失敗しました: ': 'Autosave failed: ',
    '{0} から {1} 件のコメントを追加しました（共同編集中は置き換えずに追加します）': 'Added {1} comments from {0} (while collaborating, files are added instead of replacing)',
    '　重複 {0} 件は除外': ' — {0} duplicates skipped', '{0} から {1} 件のコメントを読み込みました': 'Loaded {1} comments from {0}', '（重複 {0} 件を除外）': ' ({0} duplicates skipped)',
    '{0} ファイルをマージ: {1} 件追加': 'Merged {0} files: {1} added', ' / 重複 {0} 件': ' / {0} duplicates', ' / この作業中に削除したもの {0} 件は除外': ' / {0} deleted in this session skipped',
    '未保存のコメントがあります。破棄して別のファイルを開きますか？\n（今のコメントに追加したい場合は「マージ」を使ってください）': 'You have unsaved comments. Discard them and open another file?\n(To add to the current comments, use “Merge”.)',
    '開けませんでした: ': 'Couldn’t open: ', '対応していないファイルです': 'Unsupported file',
    // ---------- 書き出し ----------
    'ドロップして読み込み': 'Drop to load', 'コメ付き動画の書き出し': 'Export video with comments', '方式': 'Method',
    '高速（バックグラウンドで処理）': 'Fast (runs in the background)', 'リアルタイム録画（互換モード）': 'Real-time recording (compatibility)',
    '形式': 'Format', '解像度': 'Resolution', 'フレームレート': 'Frame rate', 'ビットレート': 'Bitrate', '範囲': 'Range', '音声': 'Audio',
    '音声を含める': 'Include audio', '録画中はスピーカーから音を出さない': 'Mute the speakers while recording', '出力': 'Output',
    '閉じる': 'Close', '中止': 'Cancel', 'ダイアログを閉じて、ほかの作業をしながら書き出しを続けます': 'Close this dialog and keep exporting while you work',
    'バックグラウンドで続行': 'Continue in background', '書き出し開始': 'Start export', '書き出し中 {0}%': 'Exporting {0}%',
    '動画の情報を読めませんでした': 'Couldn’t read the video’s details', '元動画と同じ（約 {0}）': 'Same as source (about {0})', '元動画と同じ（調べています…）': 'Same as source (checking…)',
    '解像度に合わせる（{0}）': 'Match resolution ({0})',
    '大きな動画は、CLI の komenagare render で書き出すのがおすすめです（ffmpeg で書き出すので、ブラウザのメモリやエンコーダーの制限を受けません）。': 'For large videos, export with the CLI’s komenagare render (it uses ffmpeg, so browser memory and encoder limits don’t apply).',
    '作業フォルダで: ': 'In the project folder: ', 'コメントを JSON で保存してから、同じフォルダで: ': 'Save the comments as JSON, then in the same folder: ',
    '{0}（確かめています…）': '{0} (checking…)',
    '動画ファイルを直接読み込んで変換するので、再生するより速く書き出せます。': 'Reads and converts the video file directly, so it exports faster than real time.',
    '処理はバックグラウンドで行うため、書き出し中もほかの作業やタブの切り替えができます。': 'It runs in the background, so you can keep working or switch tabs while exporting.',
    'ファイルを直接開いているため、このタブで処理します（書き出し中はタブを開いたままにしてください）。': 'Because the page was opened as a file, export runs in this tab (keep it open while exporting).',
    'フレームレートを動画より高くすると、映像は元のコマのまま、コメントだけが指定したフレームレートで滑らかに動きます。': 'With a frame rate higher than the video, the picture keeps its original frames and only the comments move smoothly at the chosen rate.',
    '書き出し開始で保存先を選ぶと、そこへ少しずつ書き込みます（長い動画もメモリをあまり使いません）。': 'When you choose where to save at the start, the file is written gradually (long videos use little memory).',
    'このブラウザはこの形式での録画に対応していません': 'This browser can’t record in this format',
    '動画を実際に等倍で再生しながら録画するため、動画の長さと同じ時間がかかります。録画中はこのタブを前面に表示したままにしてください。パソコンの処理が追いつかないと、指定したフレームレートより粗くなることがあります。高速書き出しが使えない動画や環境向けです。': 'This plays the video at normal speed while recording, so it takes as long as the video. Keep this tab in front while recording. If the computer can’t keep up, the result may be choppier than the chosen frame rate. Use it for videos or browsers where fast export doesn’t work.',
    '等倍の録画は画面の描き換え（多くの画面で 1 秒に 60 回）に合わせて描くため、60 fps を超えるフレームレートにしても同じコマが続くことがあります。滑らかな 120 fps には高速書き出しを使ってください。': 'Real-time recording draws in step with the display (60 times a second on most screens), so above 60 fps frames may repeat. Use fast export for smooth 120 fps.',
    '見込みの大きさ（約 {0}）が、このブラウザで一度に書き出せる 4 GB を超えそうです。ビットレートを下げるか、範囲を分けて書き出してください（Chrome / Edge なら保存先へ直接書き出せるので、この制限はありません）。': 'The estimated size (about {0}) may exceed the 4 GB this browser can export at once. Lower the bitrate or export in parts (Chrome / Edge write straight to the file and don’t have this limit).',
    'この大きさ（{0}×{1}）はブラウザでの書き出しに時間がかかり、パソコンによっては途中で失敗することがあります。': 'This size ({0}×{1}) takes a long time to export in a browser and may fail partway on some computers.',
    '・見込み 約 {0}': ' · about {0}', '{0}・{1}{2}': '{0} · {1}{2}',
    '（この大きさ・環境では H.264 が使えないため {0}。古いプレーヤーでは再生できないことがあります）': ' (H.264 isn’t available at this size here, so {0}. Older players may not play it)',
    '60 fps を超える H.264 は、パソコンによっては（ソフトウェアで変換するとき）指定したビットレートの 2 倍ほどになり、見込みより大きくなることがあります。大きさを抑えたいときは、ビットレートを下げるか WebM（VP9）を選んでください。': 'H.264 above 60 fps can come out at about twice the chosen bitrate on some computers (software encoding). To keep files small, lower the bitrate or choose WebM (VP9).',
    'このブラウザでは、この大きさ（{0}×{1}）を {2} で書き出せません。': 'This browser can’t export this size ({0}×{1}) as {2}.', '{0} なら書き出せます。': '{0} works.', '解像度を下げてください。': 'Lower the resolution.',
    ' ※大きい': ' (large)', '元動画と同じ': 'Same as source',
    '書き出しをバックグラウンドで続けます（上の「書き出し中」ボタンで進み具合を確認できます）': 'Export continues in the background (check progress with the “Exporting” button above)',
    '失敗しました: ': 'Failed: ', 'メモリが足りなかったようです。ビットレートや解像度を下げるか、範囲を分けて書き出してください。': 'It looks like memory ran out. Lower the bitrate or resolution, or export in parts.',
    'メモリが足りないか、出力が大きすぎたようです（このブラウザでは一度に 4 GB まで）。ビットレートを下げるか範囲を分けるか、Chrome / Edge（保存先へ直接書き出せる）を使ってください。': 'Memory ran out or the output was too large (this browser exports up to 4 GB at once). Lower the bitrate, export in parts, or use Chrome / Edge (they write straight to the file).',
    '書き出しに失敗しました: ': 'Export failed: ', '{0} 動画': '{0} video', '保存先を選べないため、ダウンロードで書き出します': 'Can’t choose a save location, so the export will download',
    '変換ライブラリを読み込めませんでした': 'Couldn’t load the conversion library', '変換ライブラリ（lib/': 'The conversion library (lib/',
    '）が見つかりません。index.html と同じ場所に lib フォルダを置いてください': ') is missing. Put the lib folder next to index.html',
    '書き出し範囲に映像のコマが見つかりません': 'No video frames in the export range', '書き出し範囲が短すぎます': 'The export range is too short', '動画ファイルが見つかりません': 'Video file not found',
    '見込みの大きさ（約 {0}）が、このブラウザで一度に書き出せる 4 GB を超えそうです。途中で失敗することがありますが、書き出しますか？': 'The estimated size (about {0}) may exceed the 4 GB this browser can export at once. It may fail partway. Export anyway?',
    '準備中…': 'Preparing…', 'プレーヤーから読み込みながら書き出し中（このタブを前面に表示したままにしてください）… ': 'Exporting while reading from the player (keep this tab in front)… ',
    '書き出し中… ': 'Exporting… ', '（再生速度の約 {0} 倍': ' (about {0}× real time', '・残り約 {0}': ', about {0} left', '元動画と同じfps': 'source fps',
    '完了: {0}（{1}・{2}・{3}・{4} 分を {5} で書き出し）': 'Done: {0} ({1} · {2} · {3} · {4} min exported in {5})',
    '　※この環境では H.264 が使えないため ': ' — H.264 isn’t available here, so exported as ', ' で書き出しました（古いプレーヤーでは再生できないことがあります）': ' (older players may not play it)',
    '　※音声はこの形式に変換できなかったため含まれていません': ' — audio couldn’t be converted to this format, so it isn’t included',
    '　※このブラウザでは元動画を直接デコードできないため、プレーヤーで1コマずつ読み込んで書き出しました': ' — this browser can’t decode the source directly, so frames were read one by one from the player',
    '{0} に書き出しました': 'Exported to {0}', '{0} を書き出しました': 'Exported {0}', '中止しました': 'Canceled', 'ワーカーの起動に失敗しました': 'Couldn’t start the worker',
    '。プレーヤーで1コマずつ読み込みながら書き出します…': '. Exporting by reading frames one by one from the player…',
    '録画中… {0} / {1}（等倍で進みます）': 'Recording… {0} / {1} (runs in real time)', '完了: {0} に書き出しました（{1}）': 'Done: exported to {0} ({1})', '完了: {0} をダウンロードしました': 'Done: downloaded {0}',
    'このブラウザはこの大きさ（{0}×{1}）の H.264 / HEVC をエンコードできないため MOV で書き出せません（MP4 や WebM を選んでください）': 'This browser can’t encode H.264 / HEVC at this size ({0}×{1}), so MOV isn’t possible (choose MP4 or WebM)',
    'このブラウザはこの大きさ（{0}×{1}）・形式の映像をエンコードできません（別の形式や解像度を選んでください）': 'This browser can’t encode video at this size ({0}×{1}) in this format (choose another format or resolution)',
    '動画ファイルに映像トラックが見つかりません': 'The video file has no video track', 'このブラウザでは元動画の映像（': 'This browser can’t decode the source video (',
    '不明な形式': 'unknown format', '）を直接デコードできません': ') directly', 'この動画は変換できません（': 'This video can’t be converted (', '対応していない形式': 'unsupported format',
    // ---------- 元に戻す・タイムライン ----------
    'その後の変更と重なるため元に戻せません': 'Can’t undo because later changes overlap', 'これ以上元に戻せません': 'Nothing more to undo', 'これ以上やり直せません': 'Nothing more to redo',
    '上': 'Top', '流': 'Flow', '下': 'Btm', '＋ {0}・{1}秒': '＋ {0} · {1}s', '{0} 件選択中': '{0} selected', 'ダブルクリックで作成・編集': 'Double-click to create or edit',
    '　速さ <b>×{0}</b>': '  speed <b>×{0}</b>', '開始 <b>{0}</b>　表示 <b>{1}秒</b>{2}': 'Start <b>{0}</b>  shown <b>{1}s</b>{2}',
    '最後の変更: 今（まだコミット前）': 'Last change: now (not committed yet)', '最後の変更: {0}・{1}': 'Last change: {0} · {1}',
    '{0} 件のコメントを削除しました': 'Deleted {0} comments',
    '同じ時刻・内容のコメントがあるため一部を動かせませんでした': 'Some comments couldn’t be moved because identical ones exist at that time',
    '同じ時刻・内容のコメントがあるため一部を変更できませんでした': 'Some comments couldn’t be changed because identical ones exist at that time',
    '同じ時刻・内容のコメントがあるため複製できませんでした': 'Couldn’t duplicate because identical comments exist at that time',
    '{0} 件を複製しました': 'Duplicated {0}', '（同じ時刻・内容のものがある {0} 件は除きました）': ' ({0} skipped because identical ones exist)',
    'トラックパッド（360°）': 'Trackpad (360°)', 'スナップ オン': 'Snapping on', 'スナップ オフ': 'Snapping off',
    'ループ再生 オン（イン点〜アウト点）': 'Loop on (in to out)', 'ループ再生 オン（全体）': 'Loop on (whole video)', 'ループ再生 オフ': 'Loop off',
    '時刻は 1:23.5 や 83.5 のように打ってください': 'Type a time like 1:23.5 or 83.5',
    'イン点': 'In point', 'アウト点': 'Out point', '{0}: {1}': '{0}: {1}',
    'Vim 入力': 'Vim input', '再生/一時停止': 'Play/pause', '再生位置（押して時刻を打つと移ります）': 'Playhead (click and type a time to jump)',
    '再生位置。押して時刻（例 1:23.5）を打ち、Enter でそこへ移ります': 'Playhead. Click, type a time (e.g. 1:23.5) and press Enter to jump there',
    '再生位置に新しいコメントを作成': 'Create a comment at the playhead', '選択中のコメントを編集 (Enter / ダブルクリック)': 'Edit the selected comment (Enter / double-click)', '編集': 'Edit',
    '選択中のコメントを削除 (Delete)': 'Delete the selected comments (Delete)', '元に戻す (Ctrl+Z)': 'Undo (Ctrl+Z)', 'やり直す (Ctrl+Shift+Z)': 'Redo (Ctrl+Shift+Z)', 'やり直す': 'Redo',
    'イン点を再生位置に (I)。書き出しの範囲とループ再生に使います': 'Set the in point at the playhead (I). Used for the export range and loop playback',
    'アウト点を再生位置に (O)': 'Set the out point at the playhead (O)', 'ループ再生（イン点からアウト点までをくり返す。範囲が無ければ全体）': 'Loop playback (repeats in to out, or the whole video without a range)',
    'ループ再生': 'Loop playback', '範囲を消す (Alt+X)': 'Clear the range (Alt+X)', '範囲を消す': 'Clear the range', 'スナップ (N)': 'Snapping (N)', 'スナップ': 'Snap',
    '再生中は再生位置に追従': 'Follow the playhead during playback', '追従': 'Follow',
    'オンの間は、空いている所をドラッグして範囲を囲むと、その中のコメントを選びます（⌘ / Ctrl＋ドラッグなら今の選択に足せます）': 'While on, drag across empty space to select the comments inside (⌘ / Ctrl+drag adds to the selection)',
    '範囲選択': 'Marquee', '縮小 (-)': 'Zoom out (-)', '縮小': 'Zoom out', 'ズーム': 'Zoom', '拡大 (+)': 'Zoom in (+)', '拡大': 'Zoom in',
    '全体を表示 (Shift+Z)': 'Fit all (Shift+Z)', '全体を表示': 'Fit all', 'タイムラインの設定（段の高さ・スクロールの方向など）': 'Timeline settings (lane height, scrolling, …)', 'タイムラインの設定': 'Timeline settings',
    '全体表示：枠をドラッグで移動、枠の端をドラッグで拡大縮小': 'Overview: drag the frame to move, drag its edges to zoom', 'ドラッグで上下にスクロール': 'Drag to scroll vertically',
    '段の高さ': 'Lane height', '低い（たくさん見る）': 'Short (see more)', 'ふつう': 'Normal', '高い（本文を読みやすく）': 'Tall (easier to read)',
    'マウスホイール': 'Mouse wheel', '横に移動（時間）': 'Move sideways (time)', '縦にスクロール（段）': 'Scroll vertically (lanes)', '拡大縮小': 'Zoom',
    'トラックパッド': 'Trackpad', 'Magic Mouse など': 'Magic Mouse etc.', '自動判別して360°自由に動かす': 'Detect automatically and move freely (360°)',
    '常に360°自由に動かす': 'Always move freely (360°)', 'マウスホイールと同じ扱い': 'Treat like a mouse wheel',
    '360°モードでは、指の向きのとおりに横（時間）と縦（段）が同時に動きます。どちらのモードでも Shift+ホイールで縦横が入れ替わり、Ctrl（⌘）+ホイールやピンチで拡大縮小、左の見出し列の上では縦にスクロールします。': 'In 360° mode, time and lanes move together in the direction of your fingers. In either mode, Shift+wheel swaps the axes, Ctrl (⌘)+wheel or pinch zooms, and the wheel over the left header column scrolls vertically.',
    '自動判別がうまく合わないときは「常に360°」か「マウスホイールと同じ扱い」に切り替えてください。': 'If detection guesses wrong, switch to “Always 360°” or “Treat like a mouse wheel”.',
    '直前のスクロール:': 'Last scroll:',
    // ---------- 編集・プリセットの画面 ----------
    'コメントを編集': 'Edit comment', '新しいコメント': 'New comment', '本文': 'Text', 'Enterで確定 / Shift+Enterで改行': 'Enter to confirm, Shift+Enter for a new line',
    '開始時刻': 'Start', '再生位置': 'Playhead', '表示時間': 'Duration', '秒': 's', '流れる (naka)': 'Flowing (naka)', '上固定 (ue)': 'Fixed top (ue)', '下固定 (shita)': 'Fixed bottom (shita)',
    'キャンセル': 'Cancel', '流れる速さ ×{0}': 'Flow speed ×{0}', '開始時刻を 1:23.45 のような形式で入力してください': 'Enter the start time like 1:23.45',
    '本文を入力してください': 'Enter the text', '同じ時刻・内容のコメントが既にあります': 'An identical comment already exists at this time',
    'コメントプリセット': 'Comment presets',
    'よく使うコメントを好きなだけ登録できます。ボタンを押すと再生位置にすぐ投稿されます（Shift+クリックで入力欄に挿入）。コマンドを空にすると入力欄のコマンドが使われます。先頭から10個はキーボードの 1〜9, 0 でも投稿できます。': 'Save as many frequent comments as you like. Pressing one posts it at the playhead right away (Shift+click inserts it into the input). With an empty command, the input’s command is used. The first ten can also be posted with keys 1–9 and 0.',
    '＋ 追加': '＋ Add', 'コメント入力欄の本文とコマンドをプリセットに追加': 'Add the input’s text and command as a preset', '入力欄の内容を追加': 'Add from input',
    // ---------- Vim ----------
    ':w で反映 · :q で閉じる · :help で一覧': ':w apply · :q close · :help list', 'ノーマルモードに戻る (Esc)': 'Back to normal mode (Esc)',
    'バッファをコメントに反映 (:w)': 'Apply the buffer to the comments (:w)', '反映 :w': 'Apply :w', 'コメントから読み直し (:e!)': 'Reload from the comments (:e!)', '読み直し :e!': 'Reload :e!', 'ヘルプ (:help)': 'Help (:help)',
    '" コメナガレ ― 1行 = 1コメント   書式: 時刻 コマンド | 本文   （本文中の改行は \\n）': '" Komenagare — 1 line = 1 comment   format: time command | text   (newlines in text are \\n)',
    '" :w 反映  :q 閉じる  :e! 読み直し  :seek 再生位置へ  :now 再生位置に追加  :help ヘルプ': '" :w apply  :q close  :e! reload  :seek go to time  :now add at playhead  :help help',
    '行頭に時刻（例 01:23.45）が必要です': 'A line must start with a time (e.g. 01:23.45)', '時刻「{0}」を解釈できません': 'Can’t read the time “{0}”', '本文が空です': 'The text is empty',
    'E21: タイムマシンで見ている間は書き込めません（「終了」で今に戻ります）': 'E21: Can’t write while viewing Time Machine (press “Done” to return to now)',
    'E949: コメントは読み込み後に他の場所で変更されています（:w! で上書き、:e! で読み直し）': 'E949: The comments changed elsewhere after loading (:w! to overwrite, :e! to reload)',
    'E: {0} 行目: {1}': 'E: line {0}: {1}', '（ほか {0} 件）': ' ({0} more)', ' / 重複 {0}': ' / {0} duplicates',
    '"コメント" {0}件 反映しました（追加 {1} / 削除 {2}{3}）': '"comments" {0} applied (added {1} / deleted {2}{3})',
    'E: 動画が開かれていません': 'E: No video is open', 'E: 時刻「{0}」を解釈できません': 'E: Can’t read the time “{0}”', 'E: この行には時刻がありません': 'E: This line has no time',
    'コメナガレ Vim エディタ                                   （Enter / q で閉じる）': 'Komenagare Vim editor                                    (Enter / q to close)',
    '書式        時刻 コマンド | 本文       例) 01:23.45 ue red @5 | こんにちは': 'Format      time command | text       e.g. 01:23.45 ue red @5 | hello',
    '            本文の改行は \\n 、\\ 自体は \\\\ 。" で始まる行と空行は無視されます。': '            Newlines in text are \\n, a backslash is \\\\. Lines starting with " and empty lines are ignored.',
    '            表示時間はコマンドの @秒数。時刻の数字は Ctrl-a / Ctrl-x で増減できます。': '            Duration is @seconds in the command. Ctrl-a / Ctrl-x change the time digits.',
    '反映        :w（:w! 他所での変更を上書き） :wq :x ZZ   閉じる :q :q! ZQ   読み直し :e!': 'Apply       :w (:w! overwrites changes made elsewhere) :wq :x ZZ   Close :q :q! ZQ   Reload :e!',
    '独自        :seek [時刻] 動画をシーク   :now 再生位置で行を追加   :play 再生/一時停止': 'Extra       :seek [time] seek the video   :now add a line at the playhead   :play play/pause',
    'モード      i a I A o O gi gI R s S C   v V Ctrl-v gv   :   / ?': 'Modes       i a I A o O gi gI R s S C   v V Ctrl-v gv   :   / ?',
    '移動        h j k l  w b e ge W B E gE  0 ^ $ g_ |  f F t T ; ,  gg G H M L  % { } ( )': 'Motion      h j k l  w b e ge W B E gE  0 ^ $ g_ |  f F t T ; ,  gg G H M L  % { } ( )',
    'オペレータ  d c y > < g~ gu gU g? = ＋ モーション／テキストオブジェクト（dd cc yy >> など）': 'Operators   d c y > < g~ gu gU g? = + motion / text object (dd cc yy >> etc.)',
    '編集        x X D C Y p P gp gP ]p J gJ r ~ u U Ctrl-r . Ctrl-a Ctrl-x': 'Editing     x X D C Y p P gp gP ]p J gJ r ~ u U Ctrl-r . Ctrl-a Ctrl-x',
    'レジスタ    "a-z "A-Z "0-9 "- "_ "+ ". ": "/ "%    マクロ q{reg} … q  @{reg} @@ @:': 'Registers   "a-z "A-Z "0-9 "- "_ "+ ". ": "/ "%    macros q{reg} … q  @{reg} @@ @:',
    '挿入モード  Ctrl-w Ctrl-u Ctrl-h Ctrl-r{reg} Ctrl-o Ctrl-a Ctrl-e Ctrl-y Ctrl-t Ctrl-d': 'Insert      Ctrl-w Ctrl-u Ctrl-h Ctrl-r{reg} Ctrl-o Ctrl-a Ctrl-e Ctrl-y Ctrl-t Ctrl-d',
    'ビジュアル  o O d x c s r y p P > < ~ u U J gJ I A : Ctrl-a Ctrl-x g Ctrl-a': 'Visual      o O d x c s r y p P > < ~ u U J gJ I A : Ctrl-a Ctrl-x g Ctrl-a',
    '            範囲  % . $ 数字 \'a \'<,\'> /pat/ ?pat? +n -n ;   区切り |': '            ranges  % . $ numbers \'a \'<,\'> /pat/ ?pat? +n -n ;   separator |',
    '            例) :set nowrap 折り返さない  :set linebreak 単語の区切りで折り返す': '            e.g. :set nowrap no wrapping  :set linebreak wrap at word boundaries',
    '            変えた設定は次に開いたときも使われます（:set {名前}& / :set all& で既定に戻す）': '            Changed options are kept for next time (:set {name}& / :set all& to reset)',
    '注意        Ctrl-w / Ctrl-n / Ctrl-t などブラウザ予約キーは効かないことがあります。': 'Note        Keys the browser reserves, such as Ctrl-w / Ctrl-n / Ctrl-t, may not work.',
    '            ノーマルモードでは IME をオフにしてください（挿入モードの日本語入力は可）。': '            Turn the IME off in normal mode (IME input is fine in insert mode).',
    ' <span class="stale">[他所で変更あり]</span>': ' <span class="stale">[changed elsewhere]</span>',
    'IME がオンになっています（ノーマルモードではオフにしてください）': 'The IME is on (turn it off in normal mode)',
    'E: フィルタ (!) はこのエディタでは使えません': 'E: Filters (!) aren’t available in this editor', 'E: 外部コマンドは使えません': 'E: External commands aren’t available',
    'ヘルプはありません': 'No help', 'VIM - Vi IMproved（コメナガレ版・ブラウザ実装）': 'VIM - Vi IMproved (Komenagare browser edition)', '変更履歴 {0} 件': '{0} changes',
    'E: 書き込み先がありません': 'E: Nowhere to write', '  （既定値から変更なし）': '  (no changes from defaults)',
    // ---------- 共同編集 ----------
    'ゲスト': 'Guest', '接続が切れたため': 'because the connection dropped', '接続し直したため': 'because it reconnected',
    'メールでの確認の期限が切れました。ページを再読み込みして、もう一度確認してください（未送信の変更はこのブラウザに残っています）': 'Your email verification expired. Reload the page and verify again (unsent changes are kept in this browser)',
    '再読み込み': 'Reload', 'ホスト: ': 'Host: ', '{0} 件の変更がほかの人の変更と重なったため、まだ反映していません': '{0} changes collided with someone else’s and haven’t been applied yet',
    '確認する': 'Review', '● 共同編集 {0}人': '● Live {0}', '（送信中 {0}）': ' (sending {0})',
    '参加者: {0}\nクリックで参加者の一覧（追いかける・表示名の変更）': 'Participants: {0}\nClick for the list (follow someone, change your name)',
    '○ ページを再読み込みしてください': '○ Please reload the page', '○ ログインしてください': '○ Please log in', '○ プロジェクトを選んでください': '○ Choose a project',
    '○ メールでの確認の期限切れ（再読み込み）': '○ Email verification expired (reload)', '○ ホストに接続できません': '○ Can’t reach the host', '○ オフライン': '○ Offline',
    '（未送信 {0}）': ' ({0} unsent)', 'ホストが起動しているか、URL の k= が正しいか確認してください。': 'Check that the host is running and the k= in the URL is right.',
    'ホストとの接続が切れています。': 'The connection to the host is lost.', '\n変更はこのブラウザに保存され、つながり直したら送られます。': '\nChanges are kept in this browser and sent when it reconnects.',
    '変更の衝突': 'Change conflict',
    'ほかの人の変更と重なった変更': 'Changes that collided with someone else’s',
    '同じコメントを同時に変えたため、変更はまだ反映されていません（今はホストにある内容になっています）。「元の値」は変更を始めたときの内容です。コメントごとにどうするか選んでください。': 'Someone changed the same comment at the same time, so your change hasn’t been applied (the host’s version is shown). “Original” is the value when you started editing. Choose what to do for each comment.',
    '「あとで」にすると、ほかの参加者の一覧にも出て、誰でも選べるようになります。': 'If you choose “Later”, it appears for the other participants too and anyone can decide.',
    'あとで': 'Later', 'すべて今のままにする': 'Keep all as they are',
    'ほかの人が先に同じ項目を変更していました': 'Someone else changed the same field first', 'ほかの人が先に削除していました': 'Someone else deleted it first',
    'あなたは削除しようとしましたが、ほかの人が先に変更していました': 'You tried to delete it, but someone else changed it first', '同じ id のコメントが既にありました': 'A comment with the same id already existed',
    '{0}の変更にする': 'Use {0} change', '相手のままにする': 'Keep theirs', '今のままにする': 'Keep as is', '両方残す': 'Keep both', '{0}の内容で復活させる': 'Bring it back with {0} version',
    '削除のままにする': 'Leave it deleted', 'それでも削除する': 'Delete anyway', '残す': 'Keep', '新しいコメントとして追加する': 'Add as a new comment', '追加しない': 'Don’t add',
    '同じ時刻・内容のコメントが既にあるため変更できません': 'Can’t change it because an identical comment exists at this time', '⚠ 衝突 {0}': '⚠ Conflicts {0}',
    'ほかの人の変更と重なりました': 'Collided with someone else’s change', '{0} の変更：{1}': '{0}’s change: {1}', 'ほかの参加者にも表示しています': 'Shown to the other participants too',
    '{0} が「あとで」にしたものです。誰が選んでもかまいません': '{0} chose “Later” for this. Anyone may decide', '元の値': 'Original', '（削除）': '(deleted)',
    '相手（今の内容）': 'Theirs (current)', '今の内容': 'Current', '（削除済み）': '(deleted)', 'あなた': 'your', '時刻': 'Time', '（なし）': '(none)',
    '共同編集の参加者': 'Participants',
    'ほかの人の再生位置・選んでいるコメント・マウスカーソルは、その人の色でシークバーやタイムラインに出ます。': 'Other people’s playheads, selected comments and pointers show in their color on the seek bar and timeline.',
    '「追いかける」を押すと、その人の再生位置とタイムラインの表示に合わせ続けます（自分で操作するとやめます）。': '“Follow” keeps you in step with that person’s playhead and timeline view (it stops when you take over).',
    '表示名を変更': 'Change display name', '再生中 ': 'Playing ', '停止中 ': 'Paused ', '動画を開いていません': 'No video open', '⚠ 動画の長さが違います（{0}）': '⚠ Different video length ({0})',
    'ホストにつながっていません': 'Not connected to the host', '（あなた）': ' (you)', '（あなた・別のタブ）': ' (you, another tab)', '追いかけるのをやめる': 'Stop following', '追いかける': 'Follow',
    '追いかけていた人が抜けました': 'The person you were following left',
    '{0}さんの動画と長さが違います（{1}さん: {2}、あなた: {3}）。同じ動画ファイルか確かめてください（違うと、コメントの出る場面がずれます）': '{0}’s video has a different length ({1}: {2}, you: {3}). Check that it’s the same file (otherwise comments appear at the wrong moments)',
    '{0}さんが抜けました': '{0} left', '{0}さんが入りました': '{0} joined', '動画を開いてから使ってください': 'Open a video first', 'ほかに参加している人がいません': 'Nobody else is here',
    '（コメント {0} 件）': ' ({0} comments)', 'ほかの人に {0}{1} を見てもらうよう知らせました': 'Asked the others to look at {0}{1}', '誰か': 'Someone',
    '📣 {0}さんが {1} を見てほしいそうです': '📣 {0} wants you to look at {1}', 'のコメント': ' comment',
    '{0}{1}へのリンクをコピーしました（メッセージに貼って送れます）': 'Copied a link to {0}{1} (paste it into a message)', 'このリンクをコピーしてください': 'Copy this link',
    '動画を開くと {0} に移ります': 'Opening a video will jump to {0}', 'リンクのコメントが見つかりません（消されたか、別のコメントかもしれません）': 'The linked comment wasn’t found (it may have been deleted)',
    // ---------- ターミナル ----------
    'ターミナル（ホストの作業フォルダ）': 'Terminal (host’s project folder)', '実行': 'Run', '動いているコマンドを止める (Ctrl+C)': 'Stop the running command (Ctrl+C)', '止める': 'Stop', '表示を消す': 'Clear',
    '実行中…': 'Running…', 'ホストにつながっていません。': 'Not connected to the host.', 'ホストのパソコンで、作業フォルダ（': 'You can run commands on the host computer with the project folder (',
    'このプロジェクト': 'this project',
    '）を今の場所としてコマンドを打てます。端末ではないので、色を付けるには ls --color=always や git -c color.ui=always のように指定してください。': ') as the working directory. It isn’t a real terminal, so ask for color explicitly, e.g. ls --color=always or git -c color.ui=always.',
    '作業フォルダ（': 'In the project folder (',
    '）で git の決まったサブコマンドを打てます（status / log / diff / show / add / commit / push / pull / fetch / switch / restore / stash など）。': ') you can run a fixed set of git subcommands (status / log / diff / show / add / commit / push / pull / fetch / switch / restore / stash, etc.).',
    ' 入力を求めるコマンド（エディタ・パスワードなど）は使えません。打ったコマンドはホストに記録されます。': ' Commands that ask for input (editors, passwords, …) don’t work. Commands are logged on the host.',
    '（終了コード {0}）\n': '(exit code {0})\n', '、コマンドは止まりました': ', the command stopped',
    // ---------- タイムマシン ----------
    'タイムマシンの目盛り（上が古く、下が今）': 'Time Machine scale (older at top, now at bottom)', 'ひとつ前へ': 'Previous', 'ひとつ後へ': 'Next', 'この時点に復元': 'Restore this point',
    '履歴を巻き戻す（git reset）のではなく、今の状態からこの時点の状態に戻す変更を、新しいコミットとして記録します。参加者全員に届き、それまでの履歴もそのまま残るので、あとでまたタイムマシンで戻せます。': 'This doesn’t rewind history (no git reset). It records a new commit that changes the current comments back to this point. Everyone receives it, earlier history stays, and you can go back again with Time Machine.',
    'タイムマシンで見ている間は編集できません（「終了」で今に戻ります）': 'You can’t edit while viewing Time Machine (press “Done” to return to now)',
    '今': 'Now', '今のコメント（最新）': 'Current comments (latest)', '履歴を読んでいます…': 'Reading history…', '読み込み中…': 'Loading…',
    '{0}\n{1}\nコミット {2}（{3}）': '{0}\n{1}\ncommit {2} ({3})', '{0} 個前': '{0} back', '変更 {0} / {1}': 'Change {0} / {1}', '変更 {0} 件': 'Changed: {0}',
    '最新のコミット（と、まだコミットしていない変更）で変わったコメントへ順に飛ぶ': 'Jump through comments changed in the latest commit (and uncommitted changes)',
    'このコミットで追加・変更したコメントへ順に飛ぶ（枠で囲っています）': 'Jump through comments added or changed in this commit (outlined)',
    'Vim エディタに書き込んでいない変更があります。捨ててタイムマシンを開きますか？': 'The Vim editor has unapplied changes. Discard them and open Time Machine?',
    'タイムマシン: ': 'Time Machine: ', 'このプロジェクトには、まださかのぼれる履歴がありません': 'This project has no history to go back through yet',
    '復元できませんでした: ': 'Couldn’t restore: ', '今と同じ内容だったため、何も変わりませんでした': 'Nothing changed — it matched the current comments',
    '復元しました（{0} 件の変更として記録しました）': 'Restored (recorded as {0} changes)', '{0}（{1}・コミット {2}）': '{0} ({1} · commit {2})',
    '追加': 'Add', '変更': 'Change', '{0} {1} 件': '{0} {1}', '・': ' · ',
    '今のコメント（{0} 件）から、{1}をして、このときのコメント（{2} 件）に戻します。': 'From the current comments ({0}), apply {1} to return to the comments at this point ({2}).',
    '今のコメントと同じ内容です（戻しても何も変わりません）。': 'Same as the current comments (restoring changes nothing).',
    // ---------- ホスト・プロジェクト・ログイン ----------
    'ホストがエラーを返しました（{0}）': 'The host returned an error ({0})', 'ログインし直してください（ホストの人に新しいワンタイムパスワードをもらってください）': 'Please log in again (ask the host for a new one-time password)',
    '共同編集で表示する名前': 'Name shown to others', '共同編集で表示する名前を入力してください（コミットの作者名になります）': 'Enter the name shown to others (used as the commit author)',
    '{0} - コメナガレ': '{0} - Komenagare', 'IndexedDB を使えません': 'IndexedDB is unavailable',
    'このブラウザに控えを保存できないため、オフラインの間の変更は失われることがあります': 'This browser can’t keep a local copy, so changes made while offline may be lost',
    'このプロジェクトでは前に「{0}」を開いていました。動画を開き直してください': 'You had “{0}” open in this project. Open the video again',
    'プロジェクト': 'Projects', '新しいプロジェクトの名前（フォルダの名前になります）': 'New project name (becomes the folder name)', '作る': 'Create', 'プロジェクトを復元…': 'Restore a project…',
    '「作る」はまとめフォルダに新しいフォルダを作ります。「外す」はこのホストでの共有をやめて、まとめフォルダのリポジトリからも外します（それまでの履歴には残り、ホストのフォルダとコメントもそのまま。「プロジェクトを復元」で戻せます。開いている人は切断されます）。': '“Create” makes a new folder in the collection. “Remove” stops sharing it on this host and takes it out of the collection’s repository (earlier history keeps it, and the folder and comments stay on the host; “Restore a project” brings it back. People who have it open are disconnected).',
    '「開く」はこのタブのまま切り替えます（動画・再生位置・タイムラインの表示はプロジェクトごとに覚えていて、戻ってくると元に戻します）。「新しいタブ」なら、ほかのプロジェクトや同じプロジェクトを並べて作業できます。': '“Open” switches in this tab (video, position and timeline view are remembered per project and come back when you return). “New tab” lets you work on projects side by side.',
    '招待・ログインの管理': 'Invitations & logins', 'ログアウト': 'Log out', 'プロジェクトを復元': 'Restore a project',
    '外したプロジェクトです。選んで「復元」すると、同じ id（共有のリンクもそのまま）で戻り、まとめフォルダのリポジトリにも戻ります。ホストに無いもの（別の場所で外したもの）は、外す前の履歴から取り出します。': 'These are removed projects. Choose one and “Restore” to bring it back with the same id (shared links keep working) and return it to the collection’s repository. If the host no longer has it, it’s taken from the history before removal.',
    '復元': 'Restore', 'ログイン': 'Log in',
    'このホストに入るには、ホストの人から受け取ったワンタイムパスワードを入れてください（1回だけ使えます。一度入れば、このブラウザでは次から入れ直す必要はありません）。': 'To join this host, enter the one-time password you got from the host (it works once; after that this browser stays logged in).',
    'ワンタイムパスワード': 'One-time password', '名前': 'Name', '参加する人の名前（作者名になります）': 'Participant’s name (used as the author)', '種類': 'Type',
    'ランダム（英数字 10 文字）': 'Random (10 letters and digits)', '数字（6 桁）': 'Digits (6)', '有効期限': 'Expires in', '10 分': '10 minutes', '1 時間': '1 hour', '1 日': '1 day', '7 日': '7 days',
    '管理者にする': 'Admin', '招待・取り消しもできる': 'Can also invite and revoke', 'ワンタイムパスワードを発行': 'Issue a one-time password', 'リンクをコピー': 'Copy link',
    '読み込んでいます…': 'Loading…', 'プロジェクトがありません。': 'No projects.', '下で名前を入れて「作る」と作れます。': 'Enter a name below and press “Create”.',
    'ホストの管理者に作ってもらってください。': 'Ask the host’s admin to create one.', '（このタブで開いています）': ' (open in this tab)', '{0}人: {1}': '{0}: {1}', 'だれもいません': 'Nobody',
    '開く': 'Open', '書き出し中はプロジェクトを切り替えられません': 'Can’t switch projects while exporting', '新しいタブ': 'New tab', '外す': 'Remove',
    'このホストでの共有をやめます（フォルダとコメントは残り、あとで戻せます）': 'Stop sharing on this host (the folder and comments stay and can be restored)',
    'プロジェクトを復元…（{0}）': 'Restore a project… ({0})', 'プロジェクトを復元…（外したものはありません）': 'Restore a project… (none removed)', '外したプロジェクトはありません。': 'No removed projects.',
    'ホスト:「{0}」を復元できませんでした: {1}': 'Host: couldn’t restore “{0}”: {1}', '{0}を復元しました': 'Restored {0}', '「{0}」を作りました': 'Created “{0}”',
    '「{0}」を外しますか？\nこのホストでの共有をやめて、まとめフォルダのリポジトリからも外します（それまでの履歴には残ります）。\nホストのフォルダとコメントはそのままで、「プロジェクトを復元」で戻せます。開いている人は切断されます。': 'Remove “{0}”?\nIt stops being shared on this host and is taken out of the collection’s repository (earlier history keeps it).\nThe folder and comments stay on the host and can be brought back with “Restore a project”. People who have it open are disconnected.',
    '「{0}」を外しました': 'Removed “{0}”', 'ログアウトしますか？（もう一度入るには新しいワンタイムパスワードが要ります）': 'Log out? (You’ll need a new one-time password to come back)',
    '取り消す': 'Revoke', '{0} を取り消しますか？': 'Revoke {0}?', 'ログイン中（{0}）': 'Logged in ({0})', '（管理者）': ' (admin)', ' から': ' from', ' まで': ' until',
    '{0} のログイン': '{0}’s login', '未使用のワンタイムパスワード（{0}）': 'Unused one-time passwords ({0})', 'ありません': 'None', '数字': 'digits', '英数字': 'letters and digits',
    '{0} のワンタイムパスワード': '{0}’s one-time password', '{0} 用・{1} まで・1回だけ使えます': 'For {0} · until {1} · works once', 'リンクをコピーしました': 'Copied the link',
    // ---------- 変更履歴 ----------
    'ホストに記録された全員の変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。': 'Everyone’s changes recorded on the host (newest first). “Undo” adds a new change that reverses it.',
    'ホストにつながっていないため、前回取得した履歴を表示しています。': 'Not connected to the host, so the last fetched history is shown.',
    'タイムマシン: 今までの変更です（新しい順）。印は最新のコミットとまだコミットしていない変更です。': 'Time Machine: all changes so far (newest first). Marked ones are the latest commit and uncommitted changes.',
    'タイムマシン: {0} の時点までの変更です（新しい順）。印はこの時点のコミットの変更です。': 'Time Machine: changes up to {0} (newest first). Marked ones are from this commit.',
    ' それより前はホストの最近の記録に無いので、git のコミットの一覧で出します（「見る」でその時点へ）。': ' Earlier changes aren’t in the host’s recent log, so git commits are listed instead (“View” goes to that point).',
    'この画面を開いてからの変更です（新しい順）。「取り消す」は打ち消す変更を新しく加えます。komenagare でホストすると全員の変更が記録されます。': 'Changes since this page was opened (newest first). “Undo” adds a new change that reverses it. Hosting with komenagare records everyone’s changes.',
    '見る': 'View', 'タイムマシンでこの時点を見る': 'View this point in Time Machine', '未送信': 'Unsent', '移動': 'Go', 'このコメントの時刻へ移動して選ぶ': 'Go to this comment’s time and select it',
    'この変更を打ち消す変更を加える': 'Add a change that reverses this one', '変更を取り消しました': 'Reversed the change', 'ほか {0} 件': '{0} more', 'まだ変更はありません。': 'No changes yet.',
  };
  // 取り決めた言葉が無いときに、日本語の括弧や区切りだけ英語の形にする
  const PUNCT = [[/「/g, '“'], [/」/g, '”'], [/（/g, ' ('], [/）/g, ')'], [/、/g, ', '], [/。/g, '. '], [/：/g, ': '], [/　/g, ' ']];
  const fix = (s) => { for (const [re, to] of PUNCT) s = s.replace(re, to); return s; };
  const look = (key) => {
    const v = EN[key];
    if (v != null) return v;
    return /[぀-ヿ一-鿿]/.test(key) ? key : fix(key);
  };
  function T(s, ...vals){
    if (Array.isArray(s) && s.raw){
      if (lang === 'ja') return s.reduce((a, x, i) => a + x + (i < vals.length ? vals[i] : ''), '');
      const key = s[0] + s.slice(1).map((x, i) => `{${i}}` + x).join('');
      return look(key).replace(/\{(\d+)\}/g, (m, n) => (+n < vals.length ? String(vals[+n]) : m));
    }
    return lang === 'ja' || typeof s !== 'string' ? s : look(s);
  }
  // 画面（index.html）の言葉を置き換える。前後の空白はそのまま
  const SKIP = 'script,style,textarea,.vim-screen,.term-out,.help';
  function translate(root){
    if (lang === 'ja' || !root) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const nodes = [];
    while (tw.nextNode()) nodes.push(tw.currentNode);
    for (const n of nodes){
      const v = n.nodeValue, k = v.trim();
      if (!k || !/[぀-ヿ一-鿿]/.test(k)) continue;
      const t = look(k);
      if (t !== k) n.nodeValue = v.slice(0, v.indexOf(k)) + t + v.slice(v.indexOf(k) + k.length);
    }
    for (const el of root.querySelectorAll('[title],[placeholder],[aria-label],[label]')){
      for (const a of ['title', 'placeholder', 'aria-label', 'label']){
        const v = el.getAttribute(a);
        if (v && /[぀-ヿ一-鿿]/.test(v)) el.setAttribute(a, look(v.trim()));
      }
    }
  }
  if (lang === 'en' && typeof document !== 'undefined'){
    document.documentElement.lang = 'en';
    document.title = 'Komenagare';
    translate(document.body);
    const help = document.querySelector('#helpDlg .help');
    if (help && typeof HELP_EN === 'string') help.innerHTML = HELP_EN;
  }
  return { lang, T, translate };
})();
var T = I18N.T;
