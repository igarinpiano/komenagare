// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! コメントを動画に焼き込む（komenagare render）。
//!
//! Web アプリの書き出しと同じ規則（js/comment-render.js の定数と js/app.js の relayout）で
//! コメントの位置を決め、ASS 字幕にして ffmpeg（libass）で描く。ASS だけを書き出して
//! mpv などの再生ソフトで重ねて見ることもできる。
//!
//! 文字の幅は実際のフォントでは測らず、文字の種類から見積もる（全角 1、半角 0.56 など）。
//! そのため流れるコメントの重なり具合は Web アプリの書き出しと少し違うことがある。

use crate::files::Item;
use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

/// 既定のフォント（Windows では Web アプリが使うのと同じもの。ほかは fontconfig に任せる）
pub const DEFAULT_FONT: &str = if cfg!(windows) {
    "MS PGothic"
} else {
    "sans-serif"
};
pub const DEFAULT_FONT_SERIF: &str = if cfg!(windows) { "Yu Mincho" } else { "serif" };

// js/comment-render.js と同じ値
const STAGE_H: f64 = 384.0;
const STAGE_W: f64 = STAGE_H * 16.0 / 9.0;
const UESHITA_RANGE: f64 = 1530.0 / 1920.0;
const NAKA_LEAD: f64 = 1.0;
const DEFAULT_DURATION: f64 = 3.0;
const STROKE_BASE: f64 = 2.8;

/// コメントを描く範囲（ステージ）の大きさ（js/comment-render.js の stageSize と同じ）。
/// 16:9 の基準ステージを範囲の中に収め、足りない向きに広げる
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Stage {
    pub w: f64,
    pub h: f64,
}

impl Stage {
    /// aspect は幅 / 高さ
    pub fn of(aspect: f64) -> Stage {
        if !(aspect > 0.0 && aspect.is_finite()) {
            return Stage::WIDE;
        }
        if aspect >= 16.0 / 9.0 {
            Stage {
                w: STAGE_H * aspect,
                h: STAGE_H,
            }
        } else {
            Stage {
                w: STAGE_W,
                h: STAGE_W / aspect,
            }
        }
    }
    pub const WIDE: Stage = Stage {
        w: STAGE_W,
        h: STAGE_H,
    };
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Pos {
    Naka,
    Ue,
    Shita,
}
#[derive(Clone, Copy, PartialEq, Debug)]
enum Size {
    Big,
    Medium,
    Small,
}

#[derive(Clone, Debug)]
struct Cmd {
    pos: Pos,
    size: Size,
    color: String,
    mincho: bool,
    long: Option<f64>,
    invisible: bool,
    full: bool,
    ender: bool,
    live: bool,
}

fn color_table(t: &str) -> Option<&'static str> {
    Some(match t {
        "white" => "#FFFFFF",
        "red" => "#FF0000",
        "pink" => "#FF8080",
        "orange" => "#FFC000",
        "yellow" => "#FFFF00",
        "green" => "#00FF00",
        "cyan" => "#00FFFF",
        "blue" => "#0000FF",
        "purple" => "#C000FF",
        "black" => "#000000",
        "white2" | "niconicowhite" => "#CCCC99",
        "red2" | "truered" => "#CC0033",
        "pink2" => "#FF33CC",
        "orange2" | "passionorange" => "#FF6600",
        "yellow2" | "madyellow" => "#999900",
        "green2" | "elementalgreen" => "#00CC66",
        "cyan2" => "#00CCCC",
        "blue2" | "marineblue" => "#3399FF",
        "purple2" | "nobleviolet" => "#6633CC",
        "black2" => "#666666",
        _ => return None,
    })
}

fn hex_color(t: &str) -> Option<String> {
    let h = t.strip_prefix('#')?;
    if !(h.len() == 3 || h.len() == 6) || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let h = h.to_uppercase();
    Some(if h.len() == 3 {
        h.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        h
    })
    .map(|h| format!("#{h}"))
}

/// js/app.js の parseCmd と同じ（同じ種類のものは最初の1つが有効）
fn parse_cmd(cmd: &str) -> Cmd {
    let (mut pos, mut size, mut color, mut font, mut long) = (None, None, None, None, None);
    let mut o = Cmd {
        pos: Pos::Naka,
        size: Size::Medium,
        color: "#FFFFFF".into(),
        mincho: false,
        long: None,
        invisible: false,
        full: false,
        ender: false,
        live: false,
    };
    for raw in cmd.split_whitespace() {
        let t = raw.to_lowercase();
        match t.as_str() {
            "naka" | "ue" | "shita" => {
                pos.get_or_insert(match t.as_str() {
                    "ue" => Pos::Ue,
                    "shita" => Pos::Shita,
                    _ => Pos::Naka,
                });
            }
            "big" | "medium" | "small" => {
                size.get_or_insert(match t.as_str() {
                    "big" => Size::Big,
                    "small" => Size::Small,
                    _ => Size::Medium,
                });
            }
            "defont" | "gothic" | "mincho" => {
                font.get_or_insert(t == "mincho");
            }
            "invisible" => o.invisible = true,
            "full" => o.full = true,
            "ender" => o.ender = true,
            "_live" => o.live = true,
            _ => {
                if let Some(c) = color_table(&t)
                    .map(str::to_string)
                    .or_else(|| hex_color(&t))
                {
                    color.get_or_insert(c);
                } else if let Some(n) = t.strip_prefix('@').filter(|n| {
                    !n.is_empty()
                        && n.split('.').count() <= 2
                        && n.chars().all(|c| c.is_ascii_digit() || c == '.')
                }) {
                    if let Ok(v) = n.parse::<f64>() {
                        long.get_or_insert(v.max(0.1));
                    }
                }
            }
        }
    }
    o.pos = pos.unwrap_or(Pos::Naka);
    o.size = size.unwrap_or(Size::Medium);
    o.color = color.unwrap_or_else(|| "#FFFFFF".into());
    o.mincho = font.unwrap_or(false);
    o.long = long;
    o
}

fn font_size(size: Size, resized: bool) -> f64 {
    match (size, resized) {
        (Size::Big, false) => 39.0,
        (Size::Big, true) => 19.5,
        (Size::Medium, false) => 27.0,
        (Size::Medium, true) => 14.0,
        (Size::Small, false) => 18.0,
        (Size::Small, true) => 10.0,
    }
}
fn line_height(size: Size, resized: bool) -> f64 {
    match (size, resized) {
        (Size::Small, false) => (18.0 / 15.0) * (475.0 / 400.0),
        (Size::Small, true) => (10.0 / 7.5) * (475.0 / 400.0),
        (Size::Medium, false) => (29.0 / 25.0) * (461.0 / 400.0),
        (Size::Medium, true) => (15.0 / 12.5) * (466.0 / 400.0),
        (Size::Big, false) => (45.0 / 40.0) * (395.0 / 400.0),
        (Size::Big, true) => (24.0 / 20.0) * (418.0 / 400.0),
    }
}
fn resize_lines(size: Size) -> usize {
    match size {
        Size::Big => 3,
        Size::Medium => 5,
        Size::Small => 7,
    }
}

/// 1行の幅（フォントの大きさ 1 あたり）の見積もり
fn text_width(s: &str) -> f64 {
    s.chars()
        .map(|c| match c {
            ' ' => 0.3,
            '\u{21}'..='\u{7e}' => 0.56,
            '\u{ff61}'..='\u{ff9f}' => 0.5,
            _ => 1.0,
        })
        .sum()
}

#[derive(Debug)]
struct Layout {
    lines: Vec<String>,
    o: Cmd,
    fs: f64,
    lh: f64,
    w: f64,
    h: f64,
    y: f64,
    start: f64,
    end: f64,
    speed: f64,
    alpha: f64,
    /// ステージの幅
    sw: f64,
}

fn key(it: &Item) -> String {
    format!(
        "{}\u{1}{}\u{1}{}",
        (it.t * 100.0).round() as i64,
        it.cmd,
        it.text
    )
}

/// js/app.js の hashStr（FNV-1a、UTF-16 単位）
fn hash_str(s: &str) -> u32 {
    let mut h: u32 = 2166136261;
    for u in s.encode_utf16() {
        h ^= u as u32;
        h = h.wrapping_mul(16777619);
    }
    h
}

fn naka_x(l: &Layout, t: f64) -> f64 {
    l.sw - (t - l.start) * l.speed
}
fn naka_collide(a: &Layout, b: &Layout) -> bool {
    if a.end <= b.start || b.end <= a.start {
        return false;
    }
    let (t0, t1) = (a.start.max(b.start), a.end.min(b.end));
    let d0 = naka_x(b, t0) - naka_x(a, t0);
    let d1 = naka_x(b, t1) - naka_x(a, t1);
    d0.min(d1) < a.w && d0.max(d1) > -b.w
}
fn find_slot(h: f64, stage_h: f64, blockers: &mut [(f64, f64)]) -> Option<f64> {
    blockers.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut y = 0.0;
    for &(by, bh) in blockers.iter() {
        if y < by + bh && by < y + h {
            y = by + bh;
        }
    }
    (y + h <= stage_h + 0.01).then_some(y)
}

/// 段（naka / ue / shita）ごとに今も表示中のもの: (layout の添字, 上からの位置)
type Lane = Vec<(usize, f64)>;

/// js/app.js の relayout と同じ手順で位置を決める（invisible は除く）
fn layout(items: &[Item], st: Stage) -> Vec<Layout> {
    let mut items: Vec<&Item> = items.iter().filter(|i| !i.text.trim().is_empty()).collect();
    let keys: HashMap<*const Item, String> =
        items.iter().map(|i| (*i as *const Item, key(i))).collect();
    items.sort_by(|a, b| {
        a.t.total_cmp(&b.t)
            .then_with(|| keys[&(*a as *const Item)].cmp(&keys[&(*b as *const Item)]))
    });
    let mut out: Vec<Layout> = vec![];
    // 各レーンで今も表示中のもの（out の添字と、上からの位置 yy）
    let (mut naka, mut ue, mut shita): (Lane, Lane, Lane) = (vec![], vec![], vec![]);
    for it in items {
        let o = parse_cmd(&it.cmd);
        if o.invisible {
            continue;
        }
        let lines: Vec<String> = it.text.split('\n').map(str::to_string).collect();
        let resized = !o.ender && lines.len() >= resize_lines(o.size);
        let mut fs = font_size(o.size, resized);
        let mut lh = fs * line_height(o.size, resized);
        let mut w = lines.iter().map(|l| text_width(l)).fold(0.0, f64::max) * fs;
        let mut h = lh * lines.len() as f64;
        if o.pos != Pos::Naka {
            let limit = if o.full { st.w } else { st.w * UESHITA_RANGE };
            if w > limit {
                let k = limit / w;
                fs *= k;
                lh *= k;
                w = limit;
                h *= k;
            }
        }
        if h > st.h {
            let k = st.h / h;
            fs *= k;
            lh *= k;
            w *= k;
            h = st.h;
        }
        let dur = o.long.unwrap_or(DEFAULT_DURATION);
        let (start, end) = if o.pos == Pos::Naka {
            (it.t - NAKA_LEAD, it.t + dur)
        } else {
            (it.t, it.t + dur)
        };
        let speed = if o.pos == Pos::Naka {
            (st.w + w) / (end - start)
        } else {
            0.0
        };
        let alpha = if o.live { 0.5 } else { 1.0 };
        let mut l = Layout {
            lines,
            o,
            fs,
            lh,
            w,
            h,
            y: 0.0,
            start,
            end,
            speed,
            alpha,
            sw: st.w,
        };
        let pool = match l.o.pos {
            Pos::Naka => &mut naka,
            Pos::Ue => &mut ue,
            Pos::Shita => &mut shita,
        };
        pool.retain(|&(i, _)| out[i].end > l.start);
        let mut blockers: Vec<(f64, f64)> = pool
            .iter()
            .filter(|&&(i, _)| l.o.pos != Pos::Naka || naka_collide(&out[i], &l))
            .map(|&(i, yy)| (yy, out[i].h))
            .collect();
        let yy = match find_slot(l.h, st.h, &mut blockers) {
            Some(yy) => {
                pool.push((out.len(), yy));
                yy
            }
            // 画面に収まらない → キーから決めた高さ
            None => (hash_str(&key(it)) as f64 / 4294967296.0) * (st.h - l.h).max(0.0),
        };
        l.y = if l.o.pos == Pos::Shita {
            st.h - yy - l.h
        } else {
            yy
        };
        out.push(l);
    }
    out
}

pub struct AssOptions {
    pub width: u32,
    pub height: u32,
    /// ゴシック（defont / gothic）に使うフォント
    pub font: String,
    /// 明朝（mincho）に使うフォント
    pub font_serif: String,
    /// 書き出す範囲の先頭（秒）。ASS の時刻はここを 0 にする
    pub start: f64,
    /// libass の文字の大きさの補正（font_scale。ゴシック体と明朝体）
    pub size_scale: f64,
    pub size_scale_serif: f64,
}

fn ass_time(t: f64) -> String {
    let cs = (t.max(0.0) * 100.0).round() as u64;
    format!(
        "{}:{:02}:{:02}.{:02}",
        cs / 360000,
        cs / 6000 % 60,
        cs / 100 % 60,
        cs % 100
    )
}
/// #RRGGBB と不透明度 → ASS の &HAABBGGRR
fn ass_color(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    format!("&H{}{}{}&", &h[4..6], &h[2..4], &h[0..2])
}
fn ass_alpha(opacity: f64) -> String {
    format!(
        "&H{:02X}&",
        ((1.0 - opacity.clamp(0.0, 1.0)) * 255.0).round() as u8
    )
}
/// 本文を ASS で文字どおりに出す（{ } と \ を特別扱いさせない）
fn ass_text(s: &str) -> String {
    s.replace('\\', "\\\u{2060}")
        .replace('{', "｛")
        .replace('}', "｝")
}

pub fn to_ass(items: &[Item], opt: &AssOptions) -> String {
    let (w, h) = (opt.width as f64, opt.height as f64);
    // 書き出す大きさは、コメントを流す範囲と同じ縦横比（16:9 に固定するときは 16:9）
    let st = Stage::of(w / h);
    let s = (w / st.w).min(h / st.h);
    let (ox, oy) = ((w - st.w * s) / 2.0, (h - st.h * s) / 2.0);
    let mut out = String::new();
    let _ = write!(
        out,
        "[Script Info]\nScriptType: v4.00+\nTitle: komenagare\nPlayResX: {}\nPlayResY: {}\nWrapStyle: 2\nScaledBorderAndShadow: yes\n\n\
         [V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n\
         Style: Default,{},{},&H00FFFFFF,&H00FFFFFF,&H99000000,&H00000000,-1,0,0,0,100,100,0,0,1,2,0,4,0,0,0,1\n\n\
         [Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        opt.width, opt.height, opt.font, (27.0 * s).round()
    );
    for l in layout(items, st) {
        let fs = l.fs * s;
        let bord = (STROKE_BASE * (l.fs / 27.0) * s).max(1.0) / 2.0;
        let black = l.o.color == "#000000";
        let (font, scale) = if l.o.mincho {
            (&opt.font_serif, opt.size_scale_serif)
        } else {
            (&opt.font, opt.size_scale)
        };
        let style = format!(
            "\\fn{font}\\fs{:.1}\\b1\\bord{bord:.2}\\shad0\\c{}\\1a{}\\3c{}\\3a{}",
            fs * scale,
            ass_color(&l.o.color),
            ass_alpha(l.alpha),
            if black { "&HFFFFFF&" } else { "&H000000&" },
            ass_alpha(0.4 * l.alpha),
        );
        // 流れるコメントは、見積もった幅より実際が広くても途中で消えないよう少し長めに流す
        let extra = if l.o.pos == Pos::Naka {
            (l.w * 0.3 + 10.0) / l.speed
        } else {
            0.0
        };
        let (t0, t1) = (l.start - opt.start, l.end + extra - opt.start);
        if t1 <= 0.0 {
            continue;
        }
        for (i, line) in l.lines.iter().enumerate() {
            let yc = (l.y + (i as f64 + 0.5) * l.lh) * s + oy;
            let pos = match l.o.pos {
                Pos::Naka => {
                    let x1 = st.w * s + ox;
                    let x2 = (st.w - (l.end + extra - l.start) * l.speed) * s + ox;
                    // 範囲の先頭より前に始まったものは、その時点の位置から
                    let from = if t0 < 0.0 {
                        x1 + (x2 - x1) * (-t0) / (t1 - t0)
                    } else {
                        x1
                    };
                    format!("\\an4\\move({from:.1},{yc:.1},{x2:.1},{yc:.1})")
                }
                _ => format!("\\an5\\pos({:.1},{yc:.1})", w / 2.0),
            };
            let _ = writeln!(
                out,
                "Dialogue: 0,{},{},Default,,0,0,0,,{{{pos}{style}}}{}",
                ass_time(t0),
                ass_time(t1),
                ass_text(line)
            );
        }
    }
    out
}

pub struct RenderOptions {
    pub video: PathBuf,
    pub output: PathBuf,
    pub height: Option<u32>,
    /// コメントを流す範囲を 16:9 に固定する（既定は動画と同じ縦横比）
    pub wide: bool,
    pub fps: Option<f64>,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub crf: u32,
    pub font: String,
    pub font_serif: String,
    pub font_scale: Option<f64>,
}

pub fn ffmpeg_available() -> bool {
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 元動画の見た目の大きさ（幅, 高さ）。回転と画素の縦横比を反映する（ffprobe があれば）
pub fn probe_size(video: &Path) -> Option<(f64, f64)> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio:stream_side_data=rotation:stream_tags=rotate",
            "-of",
            "json",
        ])
        .arg(video)
        .output()
        .ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    display_size(v.get("streams")?.get(0)?)
}

/// ffprobe の stream から見た目の大きさを求める
fn display_size(st: &serde_json::Value) -> Option<(f64, f64)> {
    let w = st.get("width")?.as_f64()?;
    let h = st.get("height")?.as_f64()?;
    if !(w > 0.0 && h > 0.0) {
        return None;
    }
    let sar = st
        .get("sample_aspect_ratio")
        .and_then(|s| s.as_str())
        .and_then(|s| s.split_once(':'))
        .and_then(|(a, b)| Some(a.parse::<f64>().ok()? / b.parse::<f64>().ok()?))
        .filter(|k| *k > 0.0 && k.is_finite())
        .unwrap_or(1.0);
    let rotation = st
        .get("side_data_list")
        .and_then(|l| l.as_array())
        .and_then(|l| l.iter().find_map(|d| d.get("rotation")?.as_f64()))
        .or_else(|| st.get("tags")?.get("rotate")?.as_str()?.parse().ok())
        .unwrap_or(0.0);
    let w = w * sar;
    if (rotation.round() as i64).rem_euclid(180) == 90 {
        Some((h, w))
    } else {
        Some((w, h))
    }
}

/// 高さ h、縦横比 aspect（幅 / 高さ）の書き出しの大きさ（どちらも偶数）
pub fn even_size(h: u32, aspect: f64) -> (u32, u32) {
    let h = (h - h % 2).max(2);
    let w = (h as f64 * aspect).round() as u32;
    ((w + w % 2).max(2), h)
}

/// 書き出しの縦横比と、既定の高さ（短い辺が 2160 を超えないようにする）
pub fn output_shape(src: Option<(f64, f64)>, wide: bool) -> (f64, u32) {
    let (sw, sh) = src.unwrap_or((1920.0, 1080.0));
    let aspect = if wide { 16.0 / 9.0 } else { sw / sh };
    let h = if aspect >= 1.0 || wide {
        sh.min(2160.0)
    } else {
        sh.min(2160.0 / aspect)
    };
    (aspect, h.round() as u32)
}

pub fn render(items: &[Item], opt: &RenderOptions) -> Result<()> {
    if !ffmpeg_available() {
        bail!("ffmpeg が見つかりません。動画に焼き込むには ffmpeg（libass 付き）をインストールしてください: https://ffmpeg.org/download.html\n（--ass で字幕ファイルだけを書き出すこともできます）");
    }
    let (aspect, src_h) = output_shape(probe_size(&opt.video), opt.wide);
    let (w, h) = even_size(opt.height.unwrap_or(src_h).max(144), aspect);
    let start = opt.start.unwrap_or(0.0).max(0.0);
    let ass = to_ass(
        items,
        &AssOptions {
            width: w,
            height: h,
            font: opt.font.clone(),
            font_serif: opt.font_serif.clone(),
            start,
            size_scale: opt.font_scale.unwrap_or_else(|| font_scale(&opt.font)),
            size_scale_serif: opt
                .font_scale
                .unwrap_or_else(|| font_scale(&opt.font_serif)),
        },
    );
    let dir = std::env::temp_dir().join(format!("komenagare-{}", std::process::id()));
    std::fs::create_dir_all(&dir)?;
    let ass_path = dir.join("comments.ass");
    std::fs::write(&ass_path, ass)?;
    let ass_arg = ass_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:")
        .replace('\'', "\\'");

    let ext = opt
        .output
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-hide_banner", "-loglevel", "error", "-stats", "-y"]);
    if start > 0.0 {
        cmd.args(["-ss", &format!("{start:.3}")]);
    }
    if let Some(end) = opt.end {
        cmd.args(["-to", &format!("{end:.3}")]);
    }
    cmd.arg("-i").arg(&opt.video);
    // 画素が正方形でない動画は、先に見た目の大きさにしてから収める
    let mut vf = format!("scale='trunc(iw*sar/2)*2':ih,setsar=1,scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:black,setsar=1");
    if let Some(fps) = opt.fps {
        let _ = write!(vf, ",fps={fps}");
    }
    let _ = write!(vf, ",ass='{ass_arg}'");
    cmd.args(["-vf", &vf, "-map", "0:v:0", "-map", "0:a:0?"]);
    if ext == "webm" {
        cmd.args([
            "-c:v",
            "libvpx-vp9",
            "-b:v",
            "0",
            "-crf",
            &(opt.crf + 12).to_string(),
            "-row-mt",
            "1",
            "-c:a",
            "libopus",
            "-b:a",
            "160k",
        ]);
    } else {
        cmd.args([
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            &opt.crf.to_string(),
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
        ]);
        if ext == "mp4" || ext == "mov" {
            cmd.args(["-movflags", "+faststart"]);
        }
    }
    cmd.arg(&opt.output);
    let status = cmd.status().context("ffmpeg を実行できません")?;
    let _ = std::fs::remove_dir_all(&dir);
    if !status.success() {
        bail!("ffmpeg が失敗しました（終了コード {:?}）", status.code());
    }
    Ok(())
}

/// libass は \fs を「フォントの em」ではなく「usWinAscent + usWinDescent の高さ」として描く
/// （VSFilter と同じ）。Web アプリ（canvas は em）と同じ大きさにするための倍率を、
/// fontconfig でそのフォントのファイルを探して求める。分からなければ一般的な値
pub fn font_scale(name: &str) -> f64 {
    font_scale_of(name).unwrap_or(1.25)
}

fn font_scale_of(name: &str) -> Option<f64> {
    let (file, index) = fc_match(name).or_else(|| windows_font(name))?;
    let data = std::fs::read(file).ok()?;
    let face = ttf_parser::Face::parse(&data, index).ok()?;
    let em = face.units_per_em() as f64;
    let height = match face.tables().os2 {
        // windows_descender は負の値で返る
        Some(os2) if os2.windows_ascender() as i32 - os2.windows_descender() as i32 > 0 => {
            os2.windows_ascender() as f64 - os2.windows_descender() as f64
        }
        _ => face.ascender() as f64 - face.descender() as f64,
    };
    let k = height / em;
    (0.5..3.0).contains(&k).then_some(k)
}

/// fontconfig でフォントのファイルを探す
fn fc_match(name: &str) -> Option<(PathBuf, u32)> {
    let out = Command::new("fc-match")
        .args(["-f", "%{file}\n%{index}\n"])
        .arg(format!("{name}:lang=ja"))
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let file = lines.next()?.trim();
    if file.is_empty() {
        return None;
    }
    let index = lines
        .next()
        .and_then(|x| x.trim().parse().ok())
        .unwrap_or(0);
    Some((PathBuf::from(file), index))
}

/// fontconfig の無い Windows で、よく使う日本語フォントのファイルを探す
fn windows_font(name: &str) -> Option<(PathBuf, u32)> {
    if !cfg!(windows) {
        return None;
    }
    let files: &[&str] = match name.to_lowercase().as_str() {
        "ms pgothic" | "ms gothic" | "ms ui gothic" | "ｍｓ ｐゴシック" | "ｍｓ ゴシック" => {
            &["msgothic.ttc"]
        }
        "ms pmincho" | "ms mincho" | "ｍｓ ｐ明朝" | "ｍｓ 明朝" => &["msmincho.ttc"],
        "yu gothic" | "yu gothic ui" | "游ゴシック" => &["YuGothR.ttc", "YuGothM.ttc"],
        "yu mincho" | "游明朝" => &["yumin.ttf"],
        "meiryo" | "meiryo ui" | "メイリオ" => &["meiryo.ttc"],
        "sans-serif" => &["msgothic.ttc"],
        "serif" => &["yumin.ttf"],
        _ => return None,
    };
    let dirs = [
        std::env::var_os("WINDIR").map(|d| PathBuf::from(d).join("Fonts")),
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Microsoft/Windows/Fonts")),
    ];
    let path = dirs
        .iter()
        .flatten()
        .flat_map(|d| files.iter().map(move |f| d.join(f)))
        .find(|p| p.is_file())?;
    // .ttc なら名前の合う書体を選ぶ（MS PGothic は msgothic.ttc の中の1つ）
    let data = std::fs::read(&path).ok()?;
    let want = name.to_lowercase();
    let count = ttf_parser::fonts_in_collection(&data).unwrap_or(1);
    let index = (0..count)
        .find(|&i| {
            ttf_parser::Face::parse(&data, i).is_ok_and(|f| {
                f.names().into_iter().any(|n| {
                    n.name_id == ttf_parser::name_id::FAMILY
                        && n.to_string().is_some_and(|s| s.to_lowercase() == want)
                })
            })
        })
        .unwrap_or(0);
    Some((path, index))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(t: f64, cmd: &str, text: &str) -> Item {
        Item {
            t,
            cmd: cmd.into(),
            text: text.into(),
            id: None,
        }
    }

    #[test]
    fn parses_commands_like_the_web_app() {
        let o = parse_cmd("ue big red @5 RED shita");
        assert_eq!(
            (o.pos, o.size, o.color.as_str(), o.long),
            (Pos::Ue, Size::Big, "#FF0000", Some(5.0))
        );
        let o = parse_cmd("#0f0 mincho _live invisible");
        assert_eq!(
            (o.color.as_str(), o.mincho, o.live, o.invisible),
            ("#00FF00", true, true, true)
        );
        assert_eq!(parse_cmd("").pos, Pos::Naka);
        assert_eq!(parse_cmd("@abc").long, None);
    }

    #[test]
    fn stacks_overlapping_comments() {
        // 同時に流れるコメントは別の段に、上コメは上から順に積む
        let items = vec![
            item(1.0, "", "あああ"),
            item(1.0, "", "いいい"),
            item(1.0, "ue", "上1"),
            item(1.0, "ue", "上2"),
            item(1.0, "shita", "下"),
        ];
        let l = layout(&items, Stage::WIDE);
        let ys = |pos: Pos| {
            l.iter()
                .filter(|x| x.o.pos == pos)
                .map(|x| x.y)
                .collect::<Vec<_>>()
        };
        let naka = ys(Pos::Naka);
        assert_eq!(naka.len(), 2);
        assert!(naka[0] != naka[1]);
        let ue = ys(Pos::Ue);
        assert_eq!(ue[0], 0.0);
        assert!(ue[1] > 0.0);
        let shita = &l.iter().find(|x| x.o.pos == Pos::Shita).unwrap();
        assert!((shita.y + shita.h - STAGE_H).abs() < 1e-9);
    }

    #[test]
    fn writes_ass_events() {
        let items = vec![
            item(2.0, "red", "a{b}\\n"),
            item(3.0, "ue invisible", "見えない"),
            item(4.0, "shita @2", "1行目\n2行目"),
        ];
        let ass = to_ass(
            &items,
            &AssOptions {
                width: 1920,
                height: 1080,
                font: "sans-serif".into(),
                font_serif: "serif".into(),
                start: 0.0,
                size_scale: 1.0,
                size_scale_serif: 1.0,
            },
        );
        assert!(ass.contains("PlayResX: 1920"));
        let events: Vec<&str> = ass.lines().filter(|l| l.starts_with("Dialogue:")).collect();
        assert_eq!(events.len(), 3); // 流れる1 + 下の2行（invisible は出さない）
        assert!(
            events[0].starts_with("Dialogue: 0,0:00:01.00,")
                && events[0].contains("\\move(1920.0,")
                && events[0].contains("\\c&H0000FF&")
        );
        assert!(events[0].ends_with("a｛b｝\\\u{2060}n"));
        assert!(
            events[1].contains("0:00:04.00,0:00:06.00") && events[1].contains("\\an5\\pos(960.0,")
        );
    }

    #[test]
    fn time_format() {
        assert_eq!(ass_time(3723.456), "1:02:03.46");
        assert_eq!(even_size(1080, 16.0 / 9.0), (1920, 1080));
        assert_eq!(even_size(721, 16.0 / 9.0), (1280, 720));
        assert_eq!(even_size(1920, 9.0 / 16.0), (1080, 1920));
    }

    #[test]
    fn stage_follows_the_video() {
        // 縦長は幅を基準の 682.67 のまま高さを伸ばし、横に長いものは高さ 384 のまま幅を伸ばす
        assert_eq!(Stage::of(16.0 / 9.0), Stage::WIDE);
        let st = Stage::of(9.0 / 16.0);
        assert!((st.w - STAGE_W).abs() < 1e-9 && (st.h - STAGE_W * 16.0 / 9.0).abs() < 1e-9);
        let st = Stage::of(2.4);
        assert!((st.h - STAGE_H).abs() < 1e-9 && (st.w - STAGE_H * 2.4).abs() < 1e-9);
        // 縦長の動画では、下コメは縦長のステージの下端に付く
        let items = vec![item(1.0, "shita", "下"), item(1.0, "", "流れる")];
        let st = Stage::of(9.0 / 16.0);
        let l = layout(&items, st);
        let shita = l.iter().find(|x| x.o.pos == Pos::Shita).unwrap();
        assert!((shita.y + shita.h - st.h).abs() < 1e-9);
        let naka = l.iter().find(|x| x.o.pos == Pos::Naka).unwrap();
        assert!((naka.speed - (st.w + naka.w) / 4.0).abs() < 1e-9);
    }

    #[test]
    fn output_size_of_portrait_video() {
        assert_eq!(output_shape(Some((1080.0, 1920.0)), false), (0.5625, 1920));
        assert_eq!(output_shape(Some((1080.0, 1920.0)), true).1, 1920);
        // 4K の縦長は短い辺を 2160 に
        assert_eq!(output_shape(Some((2160.0, 3840.0)), false).1, 3840);
        assert_eq!(output_shape(Some((3840.0, 2160.0)), false).1, 2160);
        assert_eq!(output_shape(Some((4320.0, 7680.0)), false).1, 3840);
        assert_eq!(output_shape(None, false), (16.0 / 9.0, 1080));
        // スマホで撮った動画（横長で保存し、回転の情報で縦にする）
        let st = serde_json::json!({"width": 1920, "height": 1080, "side_data_list": [{"rotation": -90}]});
        assert_eq!(display_size(&st), Some((1080.0, 1920.0)));
        let st = serde_json::json!({"width": 720, "height": 480, "sample_aspect_ratio": "32:27"});
        let (w, h) = display_size(&st).unwrap();
        assert!((w - 720.0 * 32.0 / 27.0).abs() < 1e-9 && h == 480.0);
    }
}
