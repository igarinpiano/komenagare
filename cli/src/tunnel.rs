// SPDX-FileCopyrightText: 2026 Igarin
// SPDX-License-Identifier: Apache-2.0
//! ローカルネットワークの外から入れるようにするトンネル（--tunnel）。
//!
//! komenagare が cloudflared / tailscale / ngrok を子プロセスとして起動し、それが出力する公開 URL を読み取る。
//! 公開 URL は、共有の URL・管理者用の URL・招待のリンクに使う。komenagare を止めればトンネルも止まる。
//! 自分で用意したトンネルやリバースプロキシ（名前付きトンネル、VPS と Caddy など）なら --public-url で URL を渡す。

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

    fn args(self, port: u16) -> Vec<String> {
        let target = format!("http://127.0.0.1:{port}");
        match self {
            Kind::Cloudflare => vec![
                "tunnel".into(),
                "--no-autoupdate".into(),
                "--url".into(),
                target,
            ],
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

/// トンネルを始めて、公開 URL が分かるまで待つ
pub async fn start(kind: Kind, port: u16) -> Result<(Tunnel, String)> {
    let program = kind.program();
    let mut child = tokio::process::Command::new(&program)
        .args(kind.args(port))
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
