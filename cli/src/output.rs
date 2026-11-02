// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! 画面への出力（標準出力・標準エラー）の行き先。
//!
//! - `--log FILE`: ファイルに書き足す（裏で動かすとき、起動時の URL や参加者の出入りをあとで見られるように）
//! - 端末が閉じられたとき（SIGHUP、Windows のウィンドウを閉じたとき）: 端末への出力を捨てる先に向ける。
//!   閉じた端末に書くと失敗し（println! は失敗すると止まる）、保存してから終わる前に落ちてしまうため

use anyhow::{Context, Result};
use std::io::Write;
use std::path::Path;

/// 標準出力と標準エラーを path に書き足すようにする
pub fn to_file(path: &Path) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("ログのファイル {} を開けません", path.display()))?;
    writeln!(
        file,
        "\n--- komenagare {} 起動 {} ---",
        env!("CARGO_PKG_VERSION"),
        utc_now()
    )?;
    redirect(file, false);
    Ok(())
}

/// 標準出力・標準エラーのうち端末に向いているものを、捨てる先に向ける（ファイルに向いているものはそのまま）
pub fn detach_terminal() {
    #[cfg(unix)]
    let null = std::fs::OpenOptions::new().write(true).open("/dev/null");
    #[cfg(windows)]
    let null = std::fs::OpenOptions::new().write(true).open("NUL");
    #[cfg(any(unix, windows))]
    if let Ok(f) = null {
        redirect(f, true);
    }
}

#[cfg(unix)]
fn redirect(file: std::fs::File, only_terminal: bool) {
    use std::os::fd::IntoRawFd;
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    let fd = file.into_raw_fd();
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        // SAFETY: 開いている fd を標準出力・標準エラーの番号に複製するだけ
        if !only_terminal || unsafe { libc::isatty(target) } == 1 {
            unsafe { libc::dup2(fd, target) };
        }
    }
    // SAFETY: 複製し終えた元の fd を閉じる（複製したものは開いたまま）
    unsafe { libc::close(fd) };
}

#[cfg(windows)]
fn redirect(file: std::fs::File, only_terminal: bool) {
    use std::ffi::c_void;
    use std::os::windows::io::IntoRawHandle;

    const STD_OUTPUT_HANDLE: u32 = -11i32 as u32;
    const STD_ERROR_HANDLE: u32 = -12i32 as u32;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n: u32) -> *mut c_void;
        fn SetStdHandle(n: u32, h: *mut c_void) -> i32;
        fn GetConsoleMode(h: *mut c_void, mode: *mut u32) -> i32;
    }
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    // 閉じずに持ち続ける（標準出力・標準エラーとして終わるまで使う）
    let h = file.into_raw_handle();
    for n in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        // SAFETY: 標準のハンドルを読む・差し替えるだけ。Rust の標準出力は書くたびに GetStdHandle で読み直す
        unsafe {
            let mut mode = 0u32;
            if !only_terminal || GetConsoleMode(GetStdHandle(n), &mut mode) != 0 {
                SetStdHandle(n, h);
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn redirect(_file: std::fs::File, _only_terminal: bool) {}

/// 今の時刻（UTC）を「2026-11-02 01:23:45 UTC」の形で
fn utc_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format_utc(secs)
}

fn format_utc(secs: u64) -> String {
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    // 1970-01-01 からの日数を年月日に（Howard Hinnant の days_from_civil の逆）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02} UTC",
        rem / 3600,
        rem / 60 % 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00 UTC");
        assert_eq!(format_utc(951_782_400), "2000-02-29 00:00:00 UTC");
        assert_eq!(format_utc(1_793_582_625), "2026-11-02 01:23:45 UTC");
    }
}
