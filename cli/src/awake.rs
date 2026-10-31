// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! ホストしている間、パソコンをスリープさせない（ほかの人とつないでいるときだけ。--allow-sleep で止める）。
//!
//! macOS: caffeinate -i -w <自分の pid>（自分が終われば caffeinate も終わる）
//! Linux: systemd-inhibit の下で「自分が生きている間だけ待つ」ループを動かす（logind が無ければ使えない）
//! Android（Termux）: termux-wake-lock / termux-wake-unlock
//! Windows: SetThreadExecutionState（止めるための thread を1つ置いておく）
//! ほかの OS では何もしない。
//!
//! どれも、komenagare が落ちても止めた状態が残らないようにする（macOS・Linux は pid を見張り、
//! Windows はプロセスが終われば元に戻る）。

/// スリープを止めている間持っておく（捨てると元に戻す）
pub struct Guard {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    child: std::process::Child,
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<()>,
    #[cfg(target_os = "android")]
    _wake: (),
}

/// スリープを止める。止められなければ理由を返す
pub fn start() -> Result<Guard, String> {
    imp::start()
}

impl Drop for Guard {
    fn drop(&mut self) {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        #[cfg(windows)]
        let _ = self.stop.send(());
        #[cfg(target_os = "android")]
        {
            let _ = std::process::Command::new("termux-wake-unlock")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}

/// Linux で systemd-inhibit に渡す引数（自分の pid が生きている間だけ待つ）
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn inhibit_args(pid: u32) -> Vec<String> {
    [
        "--what=idle:sleep",
        "--who=komenagare",
        "--why=komenagare でホストしています",
        "--mode=block",
        "/bin/sh",
        "-c",
        "while kill -0 \"$1\" 2>/dev/null; do sleep 5; done",
        "sh",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([pid.to_string()])
    .collect()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::Guard;
    use std::process::{Command, Stdio};

    pub fn start() -> Result<Guard, String> {
        // PATH から探すと、作業フォルダなどに置かれた同じ名前のものを動かしかねないので決まった場所のものを使う
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("caffeinate を起動できません（{e}）"))?;
        Ok(Guard { child })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Guard;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    pub fn start() -> Result<Guard, String> {
        let mut child = Command::new("systemd-inhibit")
            .args(super::inhibit_args(std::process::id()))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "systemd-inhibit が見つかりません".to_string())?;
        // logind が無い環境（コンテナ・一部の WSL など）では、すぐに終わってしまう
        std::thread::sleep(Duration::from_millis(300));
        if let Ok(Some(_)) = child.try_wait() {
            return Err(
                "systemd-inhibit を始められませんでした（logind が使えない可能性があります）"
                    .into(),
            );
        }
        Ok(Guard { child })
    }
}

#[cfg(target_os = "android")]
mod imp {
    use super::Guard;
    use std::process::{Command, Stdio};

    pub fn start() -> Result<Guard, String> {
        match Command::new("termux-wake-lock")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(s) if s.success() => Ok(Guard { _wake: () }),
            _ => Err(
                "termux-wake-lock を使えません（Termux の外で動かしている可能性があります）".into(),
            ),
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::Guard;

    const ES_CONTINUOUS: u32 = 0x8000_0000;
    const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }

    pub fn start() -> Result<Guard, String> {
        // 設定はそれを呼んだ thread が生きている間だけ効くので、止めるための thread を置いておく
        let (stop, rx) = std::sync::mpsc::channel::<()>();
        let (ok_tx, ok_rx) = std::sync::mpsc::channel::<bool>();
        std::thread::spawn(move || {
            // SAFETY: 引数は決まった値だけ。返り値（前の状態。失敗なら 0）を見るだけ
            let ok = unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) } != 0;
            let _ = ok_tx.send(ok);
            if ok {
                let _ = rx.recv();
                // SAFETY: 同上
                unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
            }
        });
        if ok_rx.recv().unwrap_or(false) {
            Ok(Guard { stop })
        } else {
            Err("SetThreadExecutionState が失敗しました".into())
        }
    }
}

#[cfg(not(any(
    target_os = "macos",
    target_os = "linux",
    target_os = "android",
    windows
)))]
mod imp {
    use super::Guard;

    pub fn start() -> Result<Guard, String> {
        Err("この OS ではスリープを止められません".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inhibit_waits_for_own_pid() {
        let a = inhibit_args(1234);
        assert_eq!(a.last().map(String::as_str), Some("1234"));
        assert!(a.contains(&"--what=idle:sleep".to_string()));
        // pid はスクリプトに埋め込まず、引数（$1）で渡す
        assert!(!a[6].contains("1234"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn inhibit_loop_ends_with_pid() {
        // systemd-inhibit を通さず、待つループだけを動かす（見張る pid が終われば終わる）
        let mut target = std::process::Command::new("sleep")
            .arg("0.2")
            .spawn()
            .unwrap();
        let a = inhibit_args(target.id());
        let mut w = std::process::Command::new(&a[4])
            .args(&a[5..])
            .spawn()
            .unwrap();
        target.wait().unwrap();
        let start = std::time::Instant::now();
        loop {
            if w.try_wait().unwrap().is_some() {
                break;
            }
            assert!(start.elapsed().as_secs() < 15, "ループが終わりません");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
}
