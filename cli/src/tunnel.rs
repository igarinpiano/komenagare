// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! ローカルネットワークの外から入れるようにするトンネル（--tunnel）。
//!
//! komenagare が cloudflared / tailscale / ngrok を子プロセスとして起動し、それが出力する公開 URL を読み取る。
//! 公開 URL は、共有の URL・管理者用の URL・招待のリンクに使う。komenagare を止めればトンネルも止まる。
//! 自分で用意したトンネルやリバースプロキシ（名前付きトンネル、VPS と Caddy など）なら --public-url で URL を渡す。
//!
//! Cloudflare Quick Tunnel では --allowed-mail を cloudflared に渡せる（cloudflared 2026.9.3 から）。
//! 開いた人は、まず Cloudflare Access の画面でメールに届く PIN を入れ、許可したアドレスの人だけがページまで届く
//! （最長 4 時間。cloudflared を止めると全員入れなくなる）。誰のアドレスかは komenagare には渡らないので、
//! 名前や管理者かどうかは今までどおり --otp で決める。

use anyhow::{bail, Context, Result};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

#[derive(Clone, Copy, Debug, PartialEq, clap::ValueEnum)]
pub enum Kind {
    /// Cloudflare Quick Tunnel（アカウント不要。URL は起動のたびに変わる）
    Cloudflare,
    /// Tailscale Funnel（URL は https://<PC名>.<tailnet>.ts.net/ で変わらない）
    Tailscale,
    /// ngrok（無料のアカウントで決まったドメインを1つ使える）
    Ngrok,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Cloudflare => "Cloudflare Quick Tunnel",
            Kind::Tailscale => "Tailscale Funnel",
            Kind::Ngrok => "ngrok",
        }
    }

    fn program(self) -> String {
        // テストでは偽物を使えるようにする
        if let Ok(p) = std::env::var("KOMENAGARE_TUNNEL_BIN") {
            return p;
        }
        match self {
            Kind::Cloudflare => "cloudflared",
            Kind::Tailscale => "tailscale",
            Kind::Ngrok => "ngrok",
        }
        .into()
    }

    fn args(self, port: u16, allowed_mail: &[String]) -> Vec<String> {
        let target = format!("http://127.0.0.1:{port}");
        match self {
            Kind::Cloudflare => {
                let mut a: Vec<String> = vec![
                    "tunnel".into(),
                    "--no-autoupdate".into(),
                    "--url".into(),
                    target,
                ];
                // 「--allowed-mail=値」の1つにまとめて渡す（値がほかのオプションとして読まれないように）
                a.extend(allowed_mail.iter().map(|m| format!("--allowed-mail={m}")));
                a
            }
            Kind::Tailscale => vec!["funnel".into(), port.to_string()],
            Kind::Ngrok => vec![
                "http".into(),
                target,
                "--log".into(),
                "stdout".into(),
                "--log-format".into(),
                "json".into(),
            ],
        }
    }

    fn install_hint(self) -> &'static str {
        match self {
            Kind::Cloudflare => "cloudflared を入れてください（https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 。macOS なら brew install cloudflared）",
            Kind::Tailscale => "Tailscale を入れてログインしてください（https://tailscale.com/download）",
            Kind::Ngrok => "ngrok を入れて ngrok config add-authtoken <トークン> を実行してください（https://ngrok.com/download）",
        }
    }

    /// 1行の出力から公開 URL を探す
    pub fn find_url(self, line: &str) -> Option<String> {
        match self {
            Kind::Ngrok => {
                // JSON の行の "url"（ngrok は {"msg":"started tunnel",...,"url":"https://..."} を出す）
                let v: serde_json::Value = serde_json::from_str(line).ok()?;
                let u = v["url"].as_str()?;
                u.starts_with("https://").then(|| u.to_string())
            }
            Kind::Cloudflare => https_word(line).filter(|u| u.contains(".trycloudflare.com")),
            // 有効にするよう案内する login.tailscale.com の URL は公開 URL ではない
            Kind::Tailscale => https_word(line).filter(|u| u.contains(".ts.net")),
        }
    }
}

/// 行の中の https:// で始まる語（末尾の記号は除く）
fn https_word(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"' || c == '\'')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['.', ',']);
    (url.len() > "https://".len()).then(|| url.to_string())
}

pub struct Tunnel {
    child: tokio::process::Child,
}

impl Tunnel {
    /// 止める（まず自分で終わってもらい、終わらなければ強制的に止める。Tailscale Funnel の設定を残さないため）
    pub async fn stop(mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
            if tokio::time::timeout(Duration::from_secs(3), self.child.wait())
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = self.child.kill().await;
    }
}

/// --allowed-mail を使える cloudflared の版
pub const ALLOWED_MAIL_SINCE: (u32, u32, u32) = (2026, 9, 3);

/// --allowed-mail の値をそろえる（「,」区切りも分ける）。メールアドレスか「*@ドメイン」でなければ断る
pub fn parse_allowed_mail(values: &[String]) -> Result<Vec<String>> {
    let mut out: Vec<String> = vec![];
    for v in values.iter().flat_map(|v| v.split(',')) {
        let m = v.trim();
        if m.is_empty() {
            continue;
        }
        let ok = m.split_once('@').is_some_and(|(user, domain)| {
            !user.is_empty()
                && (user == "*" || !user.contains('*'))
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !domain.contains(['@', '*'])
        }) && !m.starts_with('-')
            && !m.chars().any(|c| c.is_whitespace() || c.is_control());
        if !ok {
            bail!("--allowed-mail の「{m}」はメールアドレスではありません（例 alice@example.com、ドメインごとなら '*@example.com'）");
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(m)) {
            out.push(m.to_string());
        }
    }
    if out.is_empty() {
        bail!("--allowed-mail にメールアドレスを指定してください");
    }
    Ok(out)
}

/// 「cloudflared version 2026.9.3 (built …)」から版を読む
fn parse_cloudflared_version(text: &str) -> Option<(u32, u32, u32)> {
    text.split_whitespace().find_map(|w| {
        let mut p = w.trim_start_matches('v').split('.');
        let v = (
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
            p.next()?.parse().ok()?,
        );
        p.next().is_none().then_some(v)
    })
}

/// cloudflared が --allowed-mail を使える版か確かめる（版が読めなければ cloudflared に任せる）
fn check_allowed_mail_support(program: &str) -> Result<()> {
    let Ok(out) = std::process::Command::new(program)
        .arg("--version")
        .output()
    else {
        return Ok(()); // 見つからないときは、起動するところで案内する
    };
    let text = format!(
        "{} {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if let Some(v) = parse_cloudflared_version(&text) {
        if v < ALLOWED_MAIL_SINCE {
            let (a, b, c) = ALLOWED_MAIL_SINCE;
            bail!(
                "--allowed-mail には cloudflared {a}.{b}.{c} 以上が要ります（今は {}.{}.{}）。cloudflared を更新してください（macOS なら brew upgrade cloudflared）",
                v.0,
                v.1,
                v.2
            );
        }
    }
    Ok(())
}

/// トンネルを始めて、公開 URL が分かるまで待つ。allowed_mail を渡すと、そのアドレスの人だけが入れる（Cloudflare のみ）
pub async fn start(kind: Kind, port: u16, allowed_mail: &[String]) -> Result<(Tunnel, String)> {
    let program = kind.program();
    if !allowed_mail.is_empty() {
        if kind != Kind::Cloudflare {
            bail!("--allowed-mail は --tunnel cloudflare のときだけ使えます");
        }
        check_allowed_mail_support(&program)?;
    }
    let mut child = tokio::process::Command::new(&program)
        .args(kind.args(port, allowed_mail))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("{program} が見つかりません。{}", kind.install_hint())
            } else {
                anyhow::anyhow!("{program} を起動できません: {e}")
            }
        })?;
    // 標準出力と標準エラーの行を1つにまとめて読む
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    for out in [
        child
            .stdout
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
        child
            .stderr
            .take()
            .map(|s| Box::new(s) as Box<dyn tokio::io::AsyncRead + Unpin + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let tx = tx.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                if tx.send(l).is_err() {
                    break;
                }
            }
        });
    }
    drop(tx);
    let mut seen: Vec<String> = vec![];
    let wait = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = rx.recv().await {
            if let Some(url) = kind.find_url(&line) {
                return Some(url);
            }
            // Tailscale の出力は短く、有効にする手順の案内（初めて Funnel を使うときなど）が含まれるのでそのまま見せる
            if kind == Kind::Tailscale && !line.trim().is_empty() {
                eprintln!("  [tailscale] {}", line.trim());
            }
            seen.push(line);
        }
        None
    })
    .await;
    let url = match wait {
        Ok(Some(url)) => url,
        Ok(None) | Err(_) => {
            let _ = child.kill().await;
            let tail: Vec<&String> = seen
                .iter()
                .rev()
                .take(15)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            bail!(
                "{}の公開 URL が分かりませんでした{}。{program} の出力:\n{}",
                kind.label(),
                if wait.is_err() {
                    "（60 秒待ちました）"
                } else {
                    ""
                },
                tail.iter()
                    .map(|l| format!("    {l}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            );
        }
    };
    // その後の出力は読み捨てる（読まないと詰まる）。止まったら知らせる
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    Ok((Tunnel { child }, normalize_url(&url)?))
}

/// 公開 URL をそろえる（末尾の / を1つにする）。http(s):// で始まらなければ断る
pub fn normalize_url(url: &str) -> Result<String> {
    let u = url.trim();
    if !(u.starts_with("https://") || u.starts_with("http://")) || u.contains(char::is_whitespace) {
        bail!("公開 URL は http:// か https:// で始めてください（{u}）");
    }
    let u = u.split(['?', '#']).next().unwrap_or(u);
    Ok(format!("{}/", u.trim_end_matches('/')))
}

/// komenagare otp new が使う公開 URL の控え（--otp のホストが起動中に書く）
pub fn url_file(auth_dir: &std::path::Path) -> std::path::PathBuf {
    auth_dir.join("public-url")
}

pub fn read_url_file(auth_dir: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(url_file(auth_dir))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn write_url_file(auth_dir: &std::path::Path, url: Option<&str>) -> Result<()> {
    let p = url_file(auth_dir);
    match url {
        Some(u) => std::fs::write(&p, u).with_context(|| format!("{} に書けません", p.display())),
        None => {
            let _ = std::fs::remove_file(&p);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_urls_in_tool_output() {
        let cf = "2026-10-21T10:00:00Z INF |  https://quiet-river-1234.trycloudflare.com                                       |";
        assert_eq!(
            Kind::Cloudflare.find_url(cf).as_deref(),
            Some("https://quiet-river-1234.trycloudflare.com")
        );
        assert_eq!(
            Kind::Cloudflare.find_url("INF Requesting new quick Tunnel on trycloudflare.com..."),
            None
        );
        assert_eq!(
            Kind::Cloudflare.find_url("INF Thank you for trying Cloudflare Tunnel. ... https://developers.cloudflare.com/cloudflare-one/"),
            None
        );
        assert_eq!(
            Kind::Tailscale
                .find_url("https://my-mac.tail1234.ts.net/")
                .as_deref(),
            Some("https://my-mac.tail1234.ts.net/")
        );
        assert_eq!(
            Kind::Tailscale
                .find_url("To enable, visit: https://login.tailscale.com/f/funnel?node=abc"),
            None
        );
        let ng = r#"{"lvl":"info","msg":"started tunnel","name":"command_line","addr":"http://127.0.0.1:8764","url":"https://abc-12-34.ngrok-free.app"}"#;
        assert_eq!(
            Kind::Ngrok.find_url(ng).as_deref(),
            Some("https://abc-12-34.ngrok-free.app")
        );
        assert_eq!(Kind::Ngrok.find_url(r#"{"msg":"open config file"}"#), None);
        assert_eq!(
            Kind::Ngrok.find_url("not json https://x.ngrok-free.app"),
            None
        );
    }

    #[test]
    fn allowed_mail_goes_to_cloudflared() {
        let m = parse_allowed_mail(&[
            "alice@example.com, bob@example.com".into(),
            "*@example.org".into(),
            "Alice@example.com".into(),
        ])
        .unwrap();
        assert_eq!(m, ["alice@example.com", "bob@example.com", "*@example.org"]);
        let a = Kind::Cloudflare.args(8080, &m);
        assert_eq!(
            a,
            [
                "tunnel",
                "--no-autoupdate",
                "--url",
                "http://127.0.0.1:8080",
                "--allowed-mail=alice@example.com",
                "--allowed-mail=bob@example.com",
                "--allowed-mail=*@example.org"
            ]
        );
        // 指定しなければ今までどおり
        assert_eq!(Kind::Cloudflare.args(8080, &[]).len(), 4);
        for bad in [
            "alice",
            "@example.com",
            "alice@",
            "alice@localhost",
            "a b@example.com",
            "a*b@example.com",
            "*@*.example.com",
            "alice@example.com.",
            "--url=x@example.com x",
            "--url=x@example.com",
            " , ",
        ] {
            assert!(
                parse_allowed_mail(&[bad.into()]).is_err(),
                "{bad} を受け付けました"
            );
        }
    }

    #[test]
    fn reads_cloudflared_version() {
        assert_eq!(
            parse_cloudflared_version("cloudflared version 2026.9.3 (built 2026-09-15-1200 UTC)"),
            Some((2026, 9, 3))
        );
        assert_eq!(
            parse_cloudflared_version("cloudflared version 2025.11.1 (built ...)"),
            Some((2025, 11, 1))
        );
        assert!(Some((2025, 11, 1)) < Some(ALLOWED_MAIL_SINCE));
        assert!((2026, 10, 0) > ALLOWED_MAIL_SINCE);
        assert_eq!(parse_cloudflared_version("cloudflared version DEV"), None);
    }

    #[test]
    fn public_url_is_normalized() {
        assert_eq!(
            normalize_url("https://a.example.com").unwrap(),
            "https://a.example.com/"
        );
        assert_eq!(
            normalize_url(" https://a.example.com/x/ ").unwrap(),
            "https://a.example.com/x/"
        );
        assert_eq!(
            normalize_url("https://a.example.com/?k=1#y").unwrap(),
            "https://a.example.com/"
        );
        assert!(normalize_url("a.example.com").is_err());
        assert!(normalize_url("https://a b").is_err());
    }
}
