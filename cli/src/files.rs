// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! コメントファイル（コメナガレの JSON / JSONL / CSV）を読む。

use anyhow::{Context, Result};
use std::path::Path;

/// ファイルから読んだコメント（id はあれば）
pub struct Item {
    pub t: f64,
    pub cmd: String,
    pub text: String,
    pub id: Option<String>,
}

pub fn read(path: &Path) -> Result<Vec<Item>> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("{} を読めません", path.display()))?;
    let text = text.trim_start_matches('\u{feff}');
    let is_csv = path
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("csv"));
    if is_csv {
        return read_csv(text);
    }
    let values: Vec<serde_json::Value> = match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Array(a)) => a,
        Ok(v) if v["comments"].is_array() => v["comments"].as_array().cloned().unwrap_or_default(),
        _ => text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()
            .context("コメナガレの JSON / JSONL / CSV として読めません")?,
    };
    Ok(values
        .into_iter()
        .filter_map(|v| {
            let t = v["t"].as_f64().or_else(|| v["time"].as_f64())?;
            Some(Item {
                t,
                cmd: v["cmd"].as_str().unwrap_or_default().to_string(),
                text: v["text"].as_str().unwrap_or_default().to_string(),
                id: v["id"].as_str().map(str::to_string),
            })
        })
        .collect())
}

/// time,command,text[,id]（見出し行は任意）
fn read_csv(text: &str) -> Result<Vec<Item>> {
    let rows = parse_csv(text);
    let mut out = vec![];
    let (mut ti, mut ci, mut xi, mut ii) = (0, 1, 2, None);
    let mut start = 0;
    // コメナガレが書き出した CSV なら、数式にならないよう足した「'」を外す（js/comment-csv.js と同じ）
    let ours = rows.first().is_some_and(|h| is_komenagare_header(h));
    let un = |s: String| if ours { csv_unguard(s) } else { s };
    if let Some(head) = rows.first() {
        if parse_time(&head[0]).is_none() {
            let find = |names: &[&str]| {
                head.iter()
                    .position(|h| names.contains(&h.trim().to_lowercase().as_str()))
            };
            ti = find(&["time", "t", "秒", "時間", "時刻"]).unwrap_or(0);
            ci = find(&["command", "cmd", "mail", "コマンド"]).unwrap_or(1);
            xi = find(&["text", "comment", "body", "コメント", "本文"]).unwrap_or(2);
            ii = find(&["id", "uuid"]);
            start = 1;
        }
    }
    for r in rows.iter().skip(start) {
        let Some(t) = r.get(ti).and_then(|s| parse_time(s)) else {
            continue;
        };
        out.push(Item {
            t,
            cmd: un(r.get(ci).cloned().unwrap_or_default()),
            text: un(r.get(xi).cloned().unwrap_or_default()),
            id: ii.and_then(|i| r.get(i).cloned()).map(un),
        });
    }
    Ok(out)
}

/// コメナガレが書き出す CSV の見出し
const CSV_HEADER: &str = "time,command,text,id";

fn is_komenagare_header(row: &[String]) -> bool {
    row.iter()
        .map(|h| h.trim().to_lowercase())
        .collect::<Vec<_>>()
        .join(",")
        == CSV_HEADER
}

/// 表計算ソフトが数式の始まりとみなす文字（= + - @ タブ CR）
fn is_formula_start(c: char) -> bool {
    matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r')
}

/// 書き出すときに足した「'」を1つ外す（先頭が「'」の並び＋数式の始まりの文字のときだけ）
pub fn csv_unguard(s: String) -> String {
    let rest = s.trim_start_matches('\'');
    if rest.len() < s.len() && rest.chars().next().is_some_and(is_formula_start) {
        s[1..].to_string()
    } else {
        s
    }
}

fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let (mut rows, mut row, mut f, mut q) = (vec![], vec![], String::new(), false);
    let mut it = text.chars().peekable();
    while let Some(ch) = it.next() {
        if q {
            if ch == '"' {
                if it.peek() == Some(&'"') {
                    f.push('"');
                    it.next();
                } else {
                    q = false;
                }
            } else {
                f.push(ch);
            }
            continue;
        }
        match ch {
            '"' => q = true,
            ',' => row.push(std::mem::take(&mut f)),
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut f));
                rows.push(std::mem::take(&mut row));
            }
            _ => f.push(ch),
        }
    }
    if !f.is_empty() || !row.is_empty() {
        row.push(f);
        rows.push(row);
    }
    rows.into_iter()
        .filter(|r: &Vec<String>| r.iter().any(|x| !x.is_empty()))
        .collect()
}

/// 1:23.45 や 83.45 を秒にする
pub fn parse_time(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut acc = 0.0;
    for p in s.split(':') {
        let v: f64 = p.trim().parse().ok()?;
        if !v.is_finite() {
            return None;
        }
        acc = acc * 60.0 + v;
    }
    Some(acc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_all_formats() {
        let dir = tempfile::tempdir().unwrap();
        let json = dir.path().join("a.json");
        std::fs::write(&json, r#"{"format":"komenagare","version":2,"comments":[{"t":1.5,"cmd":"ue","text":"あ","id":"x"}]}"#).unwrap();
        let jsonl = dir.path().join("a.jsonl");
        std::fs::write(&jsonl, "{\"id\":\"a\",\"t\":1.0,\"cmd\":\"\",\"text\":\"い\"}\n{\"id\":\"b\",\"t\":2.0,\"cmd\":\"red\",\"text\":\"う\"}\n").unwrap();
        let csv = dir.path().join("a.csv");
        std::fs::write(
            &csv,
            "\u{feff}time,command,text,id\r\n1:02.50,shita,\"え,\"\"お\"\"\nか\",y\r\n",
        )
        .unwrap();
        let j = read(&json).unwrap();
        assert_eq!(
            (
                j[0].t,
                j[0].cmd.as_str(),
                j[0].text.as_str(),
                j[0].id.as_deref()
            ),
            (1.5, "ue", "あ", Some("x"))
        );
        assert_eq!(read(&jsonl).unwrap().len(), 2);
        let c = read(&csv).unwrap();
        assert_eq!(
            (
                c[0].t,
                c[0].cmd.as_str(),
                c[0].text.as_str(),
                c[0].id.as_deref()
            ),
            (62.5, "shita", "え,\"お\"\nか", Some("y"))
        );
    }

    #[test]
    fn reads_guarded_csv_like_the_web_app() {
        // Web アプリ（js/comment-csv.js）が書き出した CSV を読むと、元の値に戻る（tests/fixtures を共有）
        let fix = Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures");
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(&std::fs::read_to_string(fix.join("csv-cases.json")).unwrap())
                .unwrap();
        let got = read(&fix.join("csv-guarded.csv")).unwrap();
        assert_eq!(got.len(), cases.len());
        for (g, c) in got.iter().zip(&cases) {
            assert_eq!(g.cmd, c["cmd"].as_str().unwrap(), "{c}");
            assert_eq!(g.text, c["text"].as_str().unwrap(), "{c}");
            assert_eq!(g.id.as_deref(), c["id"].as_str(), "{c}");
            assert!((g.t - c["t"].as_f64().unwrap()).abs() < 0.006, "{c}");
        }
    }

    #[test]
    fn unguard_only_removes_the_added_quote() {
        let u = |s: &str| csv_unguard(s.to_string());
        assert_eq!(u("'@5"), "@5");
        assert_eq!(u("'=1"), "=1");
        assert_eq!(u("''=1"), "'=1");
        assert_eq!(u("'\t=1"), "\t=1");
        for s in ["", "'", "''", "'abc", "abc", "@5", "'1", "'あ"] {
            assert_eq!(u(s), s);
        }
    }

    #[test]
    fn other_csv_is_read_as_written() {
        // 見出しがコメナガレのものでなければ「'」を外さない（ほかのツールの CSV）
        let dir = tempfile::tempdir().unwrap();
        let csv = dir.path().join("b.csv");
        std::fs::write(&csv, "time,cmd,comment\n1.0,'@5,'=1\n").unwrap();
        let c = read(&csv).unwrap();
        assert_eq!((c[0].cmd.as_str(), c[0].text.as_str()), ("'@5", "'=1"));
        // 見出しの無い CSV も同じ
        std::fs::write(&csv, "1.0,'@5,'=1\n").unwrap();
        assert_eq!(read(&csv).unwrap()[0].cmd, "'@5");
    }
}
