"""Локальный запуск.

По умолчанию только 127.0.0.1. Для телефона в домашней сети:
PASSMANAGER_LAN=1 (слушает 0.0.0.0, пускает RFC1918).

Служба Windows: PASSMANAGER_OPEN=0 — не открывать браузер.
"""

from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser

import uvicorn


def _lan_urls(port: int) -> list[str]:
    urls: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                urls.append(f"http://{ip}:{port}")
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip.startswith("127.") or ip.startswith("169.254."):
                continue
            url = f"http://{ip}:{port}"
            if url not in urls:
                urls.append(url)
    except OSError:
        pass
    return urls


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    lan = os.environ.get("PASSMANAGER_LAN", "0") == "1"
    host = os.environ.get("PASSMANAGER_HOST") or ("0.0.0.0" if lan else "127.0.0.1")
    port = int(os.environ.get("PASSMANAGER_PORT", "8765"))
    local = f"http://127.0.0.1:{port}"
    if os.environ.get("PASSMANAGER_OPEN", "1") != "0":
        threading.Timer(0.8, lambda: webbrowser.open(local)).start()
    print(f"passfield: {local}", flush=True)
    if host in ("0.0.0.0", "::"):
        for url in _lan_urls(port):
            print(f"passfield lan: {url}", flush=True)
    uvicorn.run(
        "app.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
        access_log=False,
    )


if __name__ == "__main__":
    main()
