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
            cmd: r.get(ci).cloned().unwrap_or_default(),
            text: r.get(xi).cloned().unwrap_or_default(),
            id: ii.and_then(|i| r.get(i).cloned()),
        });
    }
    Ok(out)
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
}
