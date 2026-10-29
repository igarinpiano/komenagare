#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Igarin
# SPDX-License-Identifier: Apache-2.0
"""komenagare のリリースと Web アプリに署名する（minisign と同じ形式。鍵も minisign で使える）。

要るもの: Python 3.8 以上と cryptography（pip install cryptography）

  keygen <秘密鍵のファイル> <公開鍵のファイル>
      鍵を作る（秘密鍵はパスワードなし。GitHub の environment の secret に置く前提）。
      既にあるファイルは上書きしない。
  sign <ファイル> <信頼できるコメント>
      <ファイル>.minisig を書く。秘密鍵は環境変数 MINISIGN_SECRET_KEY（秘密鍵のファイルの中身）から読む。
  verify <ファイル> <公開鍵のファイル> [<信頼できるコメント>]
      署名を確かめる（コメントを渡したら、それと同じかも確かめる）。
  web-sums <フォルダ>
      <フォルダ>/web.json と、そこに書かれたファイルの SHA-256 の一覧を <フォルダ>/web.sums に書く。

署名は minisign の「ED」（BLAKE2b-512 で要約してから Ed25519）。CLI（cli/src/sign.rs）は
minisign-verify で確かめる。形式: https://jedisct1.github.io/minisign/
"""

import base64
import hashlib
import json
import os
import secrets
import struct
import sys

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat


def fail(msg):
    print(f"minisign.py: {msg}", file=sys.stderr)
    sys.exit(1)


def b2b(data, n):
    return hashlib.blake2b(data, digest_size=n).digest()


def key_id(keynum):
    return "%016X" % struct.unpack("<Q", keynum)[0]


def b64_line(text, what):
    """「untrusted comment:」の行を飛ばして、最初の base64 の行を読む"""
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("untrusted comment:"):
            try:
                return base64.b64decode(line, validate=True)
            except ValueError:
                fail(f"{what}を読めません")
    fail(f"{what}が空です")


def read_secret(text):
    raw = b64_line(text, "秘密鍵")
    if len(raw) != 158 or raw[:2] != b"Ed" or raw[4:6] != b"B2":
        fail("秘密鍵の形式が違います（minisign の秘密鍵ではありません）")
    if raw[2:4] != b"\0\0":
        fail("パスワード付きの秘密鍵は使えません（minisign -G -W か、このスクリプトの keygen で作ってください）")
    keynum, sk, chk = raw[54:62], raw[62:126], raw[126:158]
    if b2b(raw[:2] + keynum + sk, 32) != chk:
        fail("秘密鍵が壊れています（チェックサムが合いません）")
    return keynum, Ed25519PrivateKey.from_private_bytes(sk[:32]), sk[32:]


def read_public(text):
    raw = b64_line(text, "公開鍵")
    if len(raw) != 42 or raw[:2] != b"Ed":
        fail("公開鍵の形式が違います")
    return raw[2:10], Ed25519PublicKey.from_public_bytes(raw[10:42])


def keygen(sec_path, pub_path):
    for p in (sec_path, pub_path):
        if os.path.exists(p):
            fail(f"{p} は既にあります（上書きしません）")
    priv = Ed25519PrivateKey.generate()
    seed = priv.private_bytes_raw()
    pk = priv.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
    keynum = secrets.token_bytes(8)
    sk = seed + pk
    # minisign -W と同じ（KDF なし）。塩と回数は使わないので 0
    raw = b"Ed" + b"\0\0" + b"B2" + bytes(32) + bytes(8) + bytes(8) + keynum + sk + b2b(b"Ed" + keynum + sk, 32)
    fd = os.open(sec_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write("untrusted comment: minisign encrypted secret key\n" + base64.b64encode(raw).decode() + "\n")
    with open(pub_path, "x") as f:
        f.write(f"untrusted comment: minisign public key {key_id(keynum)}\n" + base64.b64encode(b"Ed" + keynum + pk).decode() + "\n")
    print(f"鍵を作りました（鍵の id {key_id(keynum)}）\n  秘密鍵: {sec_path}（GitHub の secret に置いたら、このファイルは消してください）\n  公開鍵: {pub_path}")


def sign(path, trusted):
    text = os.environ.get("MINISIGN_SECRET_KEY", "")
    if not text.strip():
        fail("環境変数 MINISIGN_SECRET_KEY（秘密鍵）がありません")
    if "\n" in trusted or "\r" in trusted:
        fail("信頼できるコメントに改行は入れられません")
    keynum, priv, _ = read_secret(text)
    with open(path, "rb") as f:
        data = f.read()
    sig = priv.sign(b2b(data, 64))
    gsig = priv.sign(sig + trusted.encode())
    with open(path + ".minisig", "w") as f:
        f.write(f"untrusted comment: signature from komenagare key {key_id(keynum)}\n"
                + base64.b64encode(b"ED" + keynum + sig).decode() + "\n"
                + f"trusted comment: {trusted}\n"
                + base64.b64encode(gsig).decode() + "\n")
    print(f"署名しました: {path}.minisig（{trusted}）")


def verify(path, pub_path, expect=None):
    with open(pub_path) as f:
        keynum, pub = read_public(f.read())
    with open(path + ".minisig") as f:
        lines = [l.rstrip("\r\n") for l in f.read().splitlines()]
    if len(lines) < 4 or not lines[2].startswith("trusted comment: "):
        fail("署名の形式が違います")
    s = base64.b64decode(lines[1], validate=True)
    if len(s) != 74 or s[:2] != b"ED":
        fail("署名の形式が違います")
    if s[2:10] != keynum:
        fail(f"別の鍵の署名です（署名 {key_id(s[2:10])}、公開鍵 {key_id(keynum)}）")
    trusted = lines[2][len("trusted comment: "):]
    with open(path, "rb") as f:
        data = f.read()
    try:
        pub.verify(s[10:], b2b(data, 64))
        pub.verify(base64.b64decode(lines[3], validate=True), s[10:] + trusted.encode())
    except InvalidSignature:
        fail(f"署名が合いません: {path}")
    if expect is not None and trusted != expect:
        fail(f"署名のコメントが違います（{trusted!r}、期待 {expect!r}）")
    print(f"署名を確かめました: {path}（{trusted}）")


def web_sums(folder):
    with open(os.path.join(folder, "web.json"), "rb") as f:
        manifest = f.read()
    files = json.loads(manifest)["files"]
    lines = ["%s  web.json" % hashlib.sha256(manifest).hexdigest()]
    for name in files:
        with open(os.path.join(folder, name), "rb") as f:
            lines.append("%s  %s" % (hashlib.sha256(f.read()).hexdigest(), name))
    with open(os.path.join(folder, "web.sums"), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"web.sums を書きました（{len(lines)} 件）")


def main(argv):
    # Windows の CI ではパイプの文字コードが UTF-8 でないことがある（日本語のメッセージで落ちないように）
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    cmds = {"keygen": (keygen, 2, 2), "sign": (sign, 2, 2), "verify": (verify, 2, 3), "web-sums": (web_sums, 1, 1)}
    if len(argv) < 1 or argv[0] not in cmds or not cmds[argv[0]][1] <= len(argv) - 1 <= cmds[argv[0]][2]:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    fn = cmds[argv[0]][0]
    fn(*argv[1:])


if __name__ == "__main__":
    main(sys.argv[1:])
