// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! コメントの保管と変更セットの適用（js/comment-store.js と同じ規則）。
//!
//! 変更セットの各 op は元の値（before）を持っていて、今の値と項目ごとに比べる
//! （git の 3-way マージと同じ考え方）。
//!   今の値 = 元の値   → 新しい値にする
//!   今の値 = 新しい値 → 何もしない
//!   それ以外           → 衝突（その項目は変えない）

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Comment {
    pub id: String,
    pub t: f64,
    pub cmd: String,
    pub text: String,
}

/// 時刻・コマンド・本文のうち、op が持っている項目だけ
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Fields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub t: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cmd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl Fields {
    fn of(c: &Comment) -> Fields {
        Fields {
            t: Some(c.t),
            cmd: Some(c.cmd.clone()),
            text: Some(c.text.clone()),
        }
    }
    fn names(&self) -> Vec<&'static str> {
        let mut v = vec![];
        if self.t.is_some() {
            v.push("t");
        }
        if self.cmd.is_some() {
            v.push("cmd");
        }
        if self.text.is_some() {
            v.push("text");
        }
        v
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Op {
    Add {
        id: String,
        after: Fields,
    },
    Update {
        id: String,
        before: Fields,
        after: Fields,
    },
    Delete {
        id: String,
        before: Fields,
    },
}

impl Op {
    pub fn id(&self) -> &str {
        match self {
            Op::Add { id, .. } | Op::Update { id, .. } | Op::Delete { id, .. } => id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub id: String,
    pub ops: Vec<Op>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Conflict {
    pub id: String,
    /// exists: 同じ id で内容の違うコメントがある / modified: 他の人が変更していた / deleted: 他の人が削除していた
    pub reason: &'static str,
    pub fields: Vec<&'static str>,
}

#[derive(Default)]
pub struct Store {
    by_id: HashMap<String, Comment>,
}

#[derive(Debug, PartialEq)]
pub struct ApplyResult {
    /// 実際に適用した op だけの変更セット（何も変わらなければ None）
    pub applied: Option<Change>,
    pub conflicts: Vec<Conflict>,
}

impl Store {
    pub fn new(items: Vec<Comment>) -> Store {
        Store {
            by_id: items.into_iter().map(|c| (c.id.clone(), c)).collect(),
        }
    }
    pub fn len(&self) -> usize {
        self.by_id.len()
    }
    pub fn get(&self, id: &str) -> Option<&Comment> {
        self.by_id.get(id)
    }

    /// 時刻順（同じ時刻なら id 順）に並べたコメント
    pub fn sorted(&self) -> Vec<&Comment> {
        let mut v: Vec<&Comment> = self.by_id.values().collect();
        v.sort_by(|a, b| {
            a.t.partial_cmp(&b.t)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.id.cmp(&b.id))
        });
        v
    }

    pub fn apply(&mut self, change: &Change, atomic: bool) -> ApplyResult {
        let mut conflicts = vec![];
        let mut plan = vec![];
        // 同じ変更セットの中で前の op が変えたものを後の op から見えるようにする（まだ本体には入れない）
        let mut view: HashMap<String, Option<Comment>> = HashMap::new();
        for op in &change.ops {
            let cur = match view.get(op.id()) {
                Some(v) => v.as_ref(),
                None => self.by_id.get(op.id()),
            };
            let planned = plan.len();
            match (op, cur) {
                (Op::Add { .. }, None) => plan.push(op.clone()),
                (Op::Add { id, after }, Some(c)) => {
                    let diff = differs(c, after);
                    if !diff.is_empty() {
                        conflicts.push(Conflict {
                            id: id.clone(),
                            reason: "exists",
                            fields: diff,
                        });
                    }
                }
                (Op::Delete { .. }, None) => {} // もう削除されている
                (Op::Delete { id, before }, Some(c)) => {
                    let diff = differs(c, before);
                    if diff.is_empty() {
                        plan.push(Op::Delete {
                            id: id.clone(),
                            before: Fields::of(c),
                        });
                    } else {
                        conflicts.push(Conflict {
                            id: id.clone(),
                            reason: "modified",
                            fields: diff,
                        });
                    }
                }
                (Op::Update { id, after, .. }, None) => {
                    conflicts.push(Conflict {
                        id: id.clone(),
                        reason: "deleted",
                        fields: after.names(),
                    });
                }
                (Op::Update { id, before, after }, Some(c)) => {
                    let (mut b, mut a, mut bad) = (Fields::default(), Fields::default(), vec![]);
                    merge_field(&c.t, &before.t, &after.t, &mut b.t, &mut a.t, "t", &mut bad);
                    merge_field(
                        &c.cmd,
                        &before.cmd,
                        &after.cmd,
                        &mut b.cmd,
                        &mut a.cmd,
                        "cmd",
                        &mut bad,
                    );
                    merge_field(
                        &c.text,
                        &before.text,
                        &after.text,
                        &mut b.text,
                        &mut a.text,
                        "text",
                        &mut bad,
                    );
                    if !bad.is_empty() {
                        conflicts.push(Conflict {
                            id: id.clone(),
                            reason: "modified",
                            fields: bad,
                        });
                    }
                    if a != Fields::default() {
                        plan.push(Op::Update {
                            id: id.clone(),
                            before: b,
                            after: a,
                        });
                    }
                }
            }
            if plan.len() > planned {
                let next = match &plan[planned] {
                    Op::Delete { .. } => None,
                    Op::Add { id, after } => Some(Comment {
                        id: id.clone(),
                        t: after.t.unwrap_or(0.0),
                        cmd: after.cmd.clone().unwrap_or_default(),
                        text: after.text.clone().unwrap_or_default(),
                    }),
                    Op::Update { after, .. } => {
                        let mut c = cur.cloned().expect("update target exists");
                        if let Some(t) = after.t {
                            c.t = t;
                        }
                        if let Some(x) = &after.cmd {
                            c.cmd = x.clone();
                        }
                        if let Some(x) = &after.text {
                            c.text = x.clone();
                        }
                        Some(c)
                    }
                };
                view.insert(op.id().to_string(), next);
            }
        }
        if (atomic && !conflicts.is_empty()) || plan.is_empty() {
            return ApplyResult {
                applied: None,
                conflicts,
            };
        }
        for (id, c) in view {
            match c {
                Some(c) => {
                    self.by_id.insert(id, c);
                }
                None => {
                    self.by_id.remove(&id);
                }
            }
        }
        ApplyResult {
            applied: Some(Change {
                id: change.id.clone(),
                ops: plan,
            }),
            conflicts,
        }
    }
}

/// op が持つ項目のうち、今の値と違うもの
fn differs(c: &Comment, f: &Fields) -> Vec<&'static str> {
    let mut v = vec![];
    if f.t.is_some_and(|t| t != c.t) {
        v.push("t");
    }
    if f.cmd.as_ref().is_some_and(|x| *x != c.cmd) {
        v.push("cmd");
    }
    if f.text.as_ref().is_some_and(|x| *x != c.text) {
        v.push("text");
    }
    v
}

fn merge_field<T: Clone + PartialEq>(
    cur: &T,
    before: &Option<T>,
    after: &Option<T>,
    out_before: &mut Option<T>,
    out_after: &mut Option<T>,
    name: &'static str,
    bad: &mut Vec<&'static str>,
) {
    let Some(after) = after else { return };
    if cur == after {
        return;
    }
    match before {
        Some(b) if b != cur => bad.push(name),
        _ => {
            *out_before = Some(cur.clone());
            *out_after = Some(after.clone());
        }
    }
}

/// UUID v7（先頭 48 ビットがミリ秒の時刻）
pub fn uuid_v7() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut b: [u8; 16] = rand::random();
    b[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    b[6] = 0x70 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(id: &str, t: f64, text: &str) -> Comment {
        Comment {
            id: id.into(),
            t,
            cmd: String::new(),
            text: text.into(),
        }
    }
    fn add(id: &str, t: f64, text: &str) -> Op {
        Op::Add {
            id: id.into(),
            after: Fields {
                t: Some(t),
                cmd: Some(String::new()),
                text: Some(text.into()),
            },
        }
    }
    fn upd_text(id: &str, from: &str, to: &str) -> Op {
        Op::Update {
            id: id.into(),
            before: Fields {
                text: Some(from.into()),
                ..Default::default()
            },
            after: Fields {
                text: Some(to.into()),
                ..Default::default()
            },
        }
    }
    fn ch(ops: Vec<Op>) -> Change {
        Change {
            id: "x".into(),
            ops,
        }
    }

    #[test]
    fn add_update_delete_and_sort() {
        let mut s = Store::default();
        s.apply(&ch(vec![add("b", 2.0, "い"), add("a", 1.0, "あ")]), false);
        assert_eq!(
            s.sorted().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        s.apply(&ch(vec![upd_text("a", "あ", "ア")]), false);
        assert_eq!(s.get("a").unwrap().text, "ア");
        s.apply(
            &ch(vec![Op::Delete {
                id: "b".into(),
                before: Fields::of(&c("b", 2.0, "い")),
            }]),
            false,
        );
        assert_eq!(s.len(), 1);
    }

    #[test]
    fn separate_fields_merge() {
        let mut s = Store::new(vec![c("a", 1.0, "x")]);
        s.apply(
            &ch(vec![Op::Update {
                id: "a".into(),
                before: Fields {
                    t: Some(1.0),
                    ..Default::default()
                },
                after: Fields {
                    t: Some(5.0),
                    ..Default::default()
                },
            }]),
            false,
        );
        let r = s.apply(&ch(vec![upd_text("a", "x", "y")]), false);
        assert!(r.conflicts.is_empty());
        assert_eq!(
            s.get("a").unwrap(),
            &Comment {
                id: "a".into(),
                t: 5.0,
                cmd: String::new(),
                text: "y".into()
            }
        );
    }

    #[test]
    fn same_field_conflicts() {
        let mut s = Store::new(vec![c("a", 1.0, "x")]);
        s.apply(&ch(vec![upd_text("a", "x", "mine")]), false);
        let r = s.apply(&ch(vec![upd_text("a", "x", "theirs")]), false);
        assert_eq!(
            r.conflicts,
            vec![Conflict {
                id: "a".into(),
                reason: "modified",
                fields: vec!["text"]
            }]
        );
        assert_eq!(r.applied, None);
        assert_eq!(s.get("a").unwrap().text, "mine");
        // 同じ値への変更は衝突にしない
        let r = s.apply(&ch(vec![upd_text("a", "x", "mine")]), false);
        assert!(r.conflicts.is_empty() && r.applied.is_none());
    }

    #[test]
    fn delete_vs_modify() {
        let mut s = Store::new(vec![c("a", 1.0, "x"), c("b", 2.0, "y")]);
        s.apply(&ch(vec![upd_text("a", "x", "X")]), false);
        let r = s.apply(
            &ch(vec![Op::Delete {
                id: "a".into(),
                before: Fields::of(&c("a", 1.0, "x")),
            }]),
            false,
        );
        assert_eq!(r.conflicts[0].reason, "modified");
        assert!(s.get("a").is_some());
        s.apply(
            &ch(vec![Op::Delete {
                id: "b".into(),
                before: Fields::of(&c("b", 2.0, "y")),
            }]),
            false,
        );
        let r = s.apply(&ch(vec![upd_text("b", "y", "Y")]), false);
        assert_eq!(r.conflicts[0].reason, "deleted");
    }

    #[test]
    fn atomic_applies_nothing_on_conflict() {
        let mut s = Store::new(vec![c("a", 1.0, "x")]);
        s.apply(&ch(vec![upd_text("a", "x", "mine")]), false);
        let r = s.apply(
            &ch(vec![add("b", 2.0, "y"), upd_text("a", "x", "theirs")]),
            true,
        );
        assert!(r.applied.is_none());
        assert!(s.get("b").is_none());
    }

    #[test]
    fn parses_client_json() {
        let j = r#"{"id":"c1","ops":[{"type":"add","id":"a","after":{"t":1.5,"cmd":"ue","text":"x"},"mine":true},
                   {"type":"update","id":"a","before":{"t":1.5},"after":{"t":2}},{"type":"delete","id":"a","before":{"t":2,"cmd":"ue","text":"x"}}]}"#;
        let change: Change = serde_json::from_str(j).unwrap();
        assert_eq!(change.ops.len(), 3);
        let mut s = Store::default();
        let r = s.apply(&change, false);
        assert!(r.conflicts.is_empty());
        assert_eq!(s.len(), 0);
        // 送り返すときに mine（各ブラウザだけの印）は含めない
        assert!(!serde_json::to_string(&r.applied.unwrap())
            .unwrap()
            .contains("mine"));
    }
}
