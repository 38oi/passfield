"""Секреты шифруются ключом из файла, база видит только шифртекст."""

from __future__ import annotations

import base64
import hashlib
import os
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

AAD = b"passmanager"
PREFIX = b"passmanager.v1\x00"


def resolve_key_path() -> Path:
    env = os.environ.get("PASSMANAGER_KEY")
    if env:
        path = Path(env).expanduser()
        if not path.is_file():
            raise FileNotFoundError(f"Ключ не найден: {path}")
        return path

    ssh = Path.home() / ".ssh"
    for name in ("id_25519ed", "id_ed25519"):
        path = ssh / name
        if path.is_file():
            return path
    raise FileNotFoundError(
        "Не найден ключ. Положите его в %USERPROFILE%\\.ssh\\id_25519ed "
        "или id_ed25519, либо укажите путь в PASSMANAGER_KEY."
    )


def load_key(path: Path | None = None) -> bytes:
    raw = (path or resolve_key_path()).read_bytes()
    if not raw:
        raise FileNotFoundError("Файл ключа пустой")
    return hashlib.sha256(PREFIX + raw).digest()


def encrypt(key: bytes, text: str) -> str:
    aes = AESGCM(key)
    nonce = os.urandom(12)
    cipher = aes.encrypt(nonce, text.encode("utf-8"), AAD)
    return base64.b64encode(nonce + cipher).decode("ascii")


def decrypt(key: bytes, blob: str) -> str:
    raw = base64.b64decode(blob)
    if len(raw) < 13:
        raise ValueError("битый шифртекст")
    aes = AESGCM(key)
    plain = aes.decrypt(raw[:12], raw[12:], AAD)
    return plain.decode("utf-8")
