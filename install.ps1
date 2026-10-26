# SPDX-FileCopyrightText: 2026 Igarin
# SPDX-License-Identifier: Apache-2.0
# komenagare（コメナガレのホスト）を Windows にインストールする
#
#   irm https://raw.githubusercontent.com/igarinpiano/komenagare/main/install.ps1 | iex
#
# 環境変数
#   KOMENAGARE_VERSION        入れるバージョン（例: v0.1.2。既定は最新）
#   KOMENAGARE_INSTALL_DIR    入れる場所（既定は %LOCALAPPDATA%\komenagare\bin）
#   KOMENAGARE_TARGET         配布物の種類（例: x86_64-pc-windows-gnu。既定は CPU から選ぶ）
#   KOMENAGARE_DOWNLOAD_URL   ダウンロード元（既定は GitHub のリリース。ミラーやテスト用）
#   KOMENAGARE_NO_MODIFY_PATH 1 なら PATH に足さない

# iex で読み込まれても、呼んだ側の設定（$ErrorActionPreference など）を変えないよう、全体をまとめて実行する
& {
  $ErrorActionPreference = 'Stop'
  # Windows PowerShell 5.1 では進捗表示があるとダウンロードがとても遅い
  $ProgressPreference = 'SilentlyContinue'

  $repo = 'igarinpiano/komenagare'
  $version = if ($env:KOMENAGARE_VERSION) { $env:KOMENAGARE_VERSION } else { 'latest' }
  $dir = if ($env:KOMENAGARE_INSTALL_DIR) { $env:KOMENAGARE_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'komenagare\bin' }
  # CPU に合う配布物を選ぶ。x64 のエミュレーションで動いている PowerShell でも OS 本来の CPU を見る
  $target = $env:KOMENAGARE_TARGET
  if (-not $target) {
    $cpu = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -ErrorAction SilentlyContinue).PROCESSOR_ARCHITECTURE
    if (-not $cpu) { $cpu = $env:PROCESSOR_ARCHITECTURE }
    $target = switch ($cpu) {
      'AMD64' { 'x86_64-pc-windows-msvc' }
      'ARM64' { 'aarch64-pc-windows-msvc' }
      'x86' { 'i686-pc-windows-msvc' }
      default { throw "この CPU（$cpu）向けの配布物はありません" }
    }
  }
  $asset = "komenagare-$target.zip"
  if ($env:KOMENAGARE_DOWNLOAD_URL) {
    $base = $env:KOMENAGARE_DOWNLOAD_URL.TrimEnd('/')
  } elseif ($version -eq 'latest') {
    $base = "https://github.com/$repo/releases/latest/download"
  } else {
    $base = "https://github.com/$repo/releases/download/$version"
  }
  # Windows PowerShell 5.1 は TLS 1.2 が既定で有効でないことがある
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('komenagare-' + [Guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  try {
    Write-Host "komenagare（$version・$target）をダウンロードしています…"
    $zip = Join-Path $tmp $asset
    try {
      Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $zip
      Invoke-WebRequest -UseBasicParsing "$base/$asset.sha256" -OutFile "$zip.sha256"
    } catch {
      throw "ダウンロードできませんでした: $base/$asset（$($_.Exception.Message)）"
    }
    $expected = ((Get-Content "$zip.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
      throw 'ダウンロードしたファイルが壊れています（チェックサムが一致しません）'
    }
    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive $zip -DestinationPath $unpacked -Force

    New-Item -ItemType Directory -Force $dir | Out-Null
    $exe = Join-Path $dir 'komenagare.exe'
    if (Test-Path $exe) {
      # 実行中の komenagare は上書きできないが、名前は変えられる（古いものは次に起動したときに消える）
      Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
      Move-Item -Force $exe "$exe.old"
    }
    Copy-Item (Join-Path $unpacked 'komenagare.exe') $exe
    Remove-Item -Force "$exe.old" -ErrorAction SilentlyContinue
    $installed = & $exe --version
    Write-Host "インストールしました: $exe（$installed）"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  if ($env:KOMENAGARE_NO_MODIFY_PATH -ne '1') {
    # ユーザーの PATH に足す（%USERPROFILE% などを展開せずに書き戻すため、レジストリを直接読み書きする）
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $cur = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if (-not (($cur -split ';') -contains $dir)) {
        $new = if ($cur) { $cur.TrimEnd(';') + ';' + $dir } else { $dir }
        $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        # 開いているほかのアプリ（エクスプローラーなど）に環境変数の変更を知らせる
        [Environment]::SetEnvironmentVariable('KOMENAGARE_INSTALL', '1', 'User')
        [Environment]::SetEnvironmentVariable('KOMENAGARE_INSTALL', $null, 'User')
        Write-Host ''
        Write-Host "$dir を PATH に足しました。新しく開いたターミナルから komenagare を使えます。"
      }
    } finally {
      $key.Close()
    }
    if (-not (($env:Path -split ';') -contains $dir)) {
      $env:Path = $env:Path.TrimEnd(';') + ';' + $dir
    }
  }

  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '注意: git が見つかりません。git がないと変更の履歴は残りません。'
    Write-Host '      https://git-scm.com/downloads からインストールしてください（winget install Git.Git でも入ります）。'
  }
  Write-Host ''
  Write-Host '使い方: 作業用のフォルダで komenagare init を実行してから komenagare で始め、表示された URL をブラウザで開きます（komenagare --help で一覧）'
  Write-Host '更新: komenagare update'
}
