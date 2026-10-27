// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! macOS のファイアウォール（アプリケーションファイアウォール）で、ほかの機械から komenagare に
//! つながらないときの手当て。
//!
//! socketfilterfw の出力は OS の版で変わるので頼らず、起動したら実際に自分の LAN のアドレスに
//! つないでみる。127.0.0.1 では答えるのに LAN のアドレスでは切られるなら、ファイアウォールで
//! 止められているとみなし、許可するコマンドを見せて y/N で実行する。
//! （komenagare update で実行ファイルが入れ替わると、前に許可していても別のアプリとして扱われる）
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::time::Duration;

const SOCKETFILTERFW: &str = "/usr/libexec/ApplicationFirewall/socketfilterfw";

/// 待ち受けを始めたあとで呼ぶ（確かめるのは別のスレッド。macOS 以外では何もしない）
pub fn check_in_background(ip: IpAddr, port: u16) {
    if !cfg!(target_os = "macos") || ip.is_loopback() {
        return;
    }
    // スレッドは待たずに終われるよう、tokio ではなく普通のスレッドにする（入力待ちのまま終了できるように）
    std::thread::spawn(move || check(ip, port));
}

fn check(ip: IpAddr, port: u16) {
    std::thread::sleep(Duration::from_millis(300));
    let lan = SocketAddr::new(ip, port);
    if reachable(lan) || !reachable(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)) {
        return;
    }
    if firewall_disabled() {
        eprintln!(
            "\n注意: {lan} にはつながりません（ファイアウォールは無効です）。VPN などのアドレスが「共有」に出ているかもしれません。\n\
             Wi-Fi のアドレスは ipconfig getifaddr en0 で確かめられます"
        );
        return;
    }
    let Ok(exe) = std::env::current_exe().and_then(|p| p.canonicalize()) else {
        return;
    };
    let cmds = allow_commands(&exe);
    eprintln!(
        "\n注意: macOS のファイアウォールが komenagare への接続を止めているため、ほかの機械から「共有」の URL を開けません。\n\
         次のコマンドで komenagare を許可できます（管理者のパスワードを聞かれます）:"
    );
    for c in &cmds {
        eprintln!("    {}", shell_line(c));
    }
    if !ask("実行しますか？ [y/N] ") {
        eprintln!("実行しませんでした。あとで上のコマンドを実行するか、システム設定 → ネットワーク → ファイアウォール → オプション で komenagare を許可してください");
        return;
    }
    for (i, c) in cmds.iter().enumerate() {
        let mut cmd = std::process::Command::new(&c[0]);
        cmd.args(&c[1..]);
        // 最初（--remove）は、まだ登録されていなければ失敗するだけなので、出力を出さない
        if i == 0 {
            cmd.stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
        }
        match cmd.status() {
            Ok(s) if s.success() || i == 0 => {}
            Ok(_) | Err(_) => {
                eprintln!("{} が失敗しました", shell_line(c));
                return;
            }
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    if reachable(lan) {
        eprintln!("許可しました。「共有」の URL を開けるようになりました");
    } else {
        eprintln!(
            "許可しましたが、まだ {lan} につながりません。\n\
             システム設定 → ネットワーク → ファイアウォール → オプション で「外部からの接続をすべてブロック」がオフになっているか確かめてください"
        );
    }
}

/// komenagare を許可するコマンド。前の版の登録が残っていると新しい実行ファイルに合わないので、消してから登録し直す
pub fn allow_commands(exe: &Path) -> Vec<Vec<String>> {
    let exe = exe.to_string_lossy().into_owned();
    ["--remove", "--add", "--unblockapp"]
        .iter()
        .map(|op| {
            vec![
                "sudo".into(),
                SOCKETFILTERFW.into(),
                op.to_string(),
                exe.clone(),
            ]
        })
        .collect()
}

/// 画面に出す形（空白などを含む引数は引用符で囲む）
fn shell_line(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if a.chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_./".contains(c))
            {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', r"'\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// ファイアウォールがはっきり無効と出たときだけ true（読めなければ有効とみなす）
fn firewall_disabled() -> bool {
    std::process::Command::new(SOCKETFILTERFW)
        .arg("--getglobalstate")
        .output()
        .map(|o| {
            let t = String::from_utf8_lossy(&o.stdout).to_lowercase();
            t.contains("disabled") || t.contains("state = 0")
        })
        .unwrap_or(false)
}

/// 端末から y と答えたら true（端末でなければ聞かずに false）
fn ask(prompt: &str) -> bool {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        return false;
    }
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let mut line = String::new();
    std::io::stdin().read_line(&mut line).is_ok()
        && matches!(line.trim().to_lowercase().as_str(), "y" | "yes")
}

/// addr につないで komenagare が答えるか
pub fn reachable(addr: SocketAddr) -> bool {
    let timeout = Duration::from_secs(2);
    let Ok(mut s) = TcpStream::connect_timeout(&addr, timeout) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(timeout));
    let _ = s.set_write_timeout(Some(timeout));
    if s.write_all(b"GET /api/info HTTP/1.0\r\nHost: komenagare\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.take(64 * 1024).read_to_end(&mut buf);
    is_komenagare_response(&buf)
}

fn is_komenagare_response(resp: &[u8]) -> bool {
    let t = String::from_utf8_lossy(resp);
    t.starts_with("HTTP/1.") && t.contains("\"app\":\"komenagare\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn detects_komenagare() {
        assert!(is_komenagare_response(
            b"HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{\"app\":\"komenagare\",\"version\":\"0.1.5\"}"
        ));
        assert!(!is_komenagare_response(b"HTTP/1.1 200 OK\r\n\r\nhello"));
        assert!(!is_komenagare_response(b""));
    }

    #[test]
    fn reachable_needs_a_komenagare_answer() {
        // つないだ直後に切られる（ファイアウォールと同じ）
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let t = std::thread::spawn(move || drop(l.accept()));
        assert!(!reachable(addr));
        t.join().unwrap();
        // komenagare のように答える
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        let t = std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0; 1024];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.0 200 OK\r\n\r\n{\"app\":\"komenagare\"}");
        });
        assert!(reachable(addr));
        t.join().unwrap();
    }

    #[test]
    fn commands_quote_paths() {
        let cmds = allow_commands(Path::new("/Users/a b/bin/komenagare"));
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[1][2], "--add");
        assert_eq!(
            shell_line(&cmds[2]),
            "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Users/a b/bin/komenagare'"
        );
    }
}
