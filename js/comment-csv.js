// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
// コメントの CSV（time,command,text,id）の書き出しと読み取り（DOM 非依存。Node からも require できる）。
//
// 表計算ソフト（Excel・LibreOffice・Google スプレッドシート）は、先頭が = + - @ タブ CR のセルを数式として
// 扱う。CSV には他の参加者が書いたコメントも入るので、そのまま書くと、開いた人の表計算ソフトで数式が動く
// （CSV インジェクション）。そこで書き出しでは、先頭が「'」の並びに続けてこれらの文字のセルに「'」を1つ足す。
// コメナガレの CSV（見出しが time,command,text,id）を読むときは、同じ形のセルから「'」を1つ外すので、元に戻る。
//   書き出し: 先頭が /^'*[=+\-@\t\r]/ なら「'」を足す
//   読み込み: 先頭が /^'+[=+\-@\t\r]/ なら「'」を1つ外す
// 足すのは「'」の並び＋危ない文字の形だけなので、もともと「'=」で始まる本文も「''=」になって正しく戻る。
// cli/src/files.rs も同じ規則で読む（両方を同じに保つこと）。

const CSV_HEADER = 'time,command,text,id';
// 表計算ソフトが数式の始まりとみなす文字（OWASP の CSV Injection の一覧）
const CSV_FORMULA_START = /^'*[=+\-@\t\r]/;
const CSV_GUARDED = /^'+[=+\-@\t\r]/;

function csvGuard(s){ return CSV_FORMULA_START.test(s) ? "'" + s : s; }
function csvUnguard(s){ return CSV_GUARDED.test(s) ? s.slice(1) : s; }
function csvEsc(s){ return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
// 文字のセル（command・text・id）。数式にならないようにしてから、必要なら "…" で囲む
function csvCell(s){ return csvEsc(csvGuard(String(s ?? ''))); }

// コメントの並び（{ t, cmd, text, id }）を CSV にする（Excel で文字化けしないよう BOM を付ける）
function commentsToCSV(items){
  return '﻿' + CSV_HEADER + '\r\n'
    + items.map(c => [Number(c.t).toFixed(2), csvCell(c.cmd), csvCell(c.text), csvCell(c.id)].join(',')).join('\r\n')
    + (items.length ? '\r\n' : '');
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

// コメナガレが書き出した CSV の見出しか（このときだけ「'」を外す。ほかのツールの CSV は書かれたまま読む）
function isKomenagareCsvHeader(row){
  return Array.isArray(row) && row.map(x => String(x).trim().toLowerCase()).join(',') === CSV_HEADER;
}

if (typeof module !== 'undefined') module.exports = { CSV_HEADER, csvGuard, csvUnguard, csvEsc, csvCell, commentsToCSV, parseCSV, isKomenagareCsvHeader };
