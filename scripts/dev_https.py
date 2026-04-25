"""
Local-HTTPS dev launcher for the phone demo.

Camera, mic, geolocation, and SpeechRecognition all require a "secure context"
on phones. localhost gets the exemption; LAN IPs do not. This script generates
a mkcert-signed cert for localhost + 127.0.0.1 + your current LAN IP, then
launches uvicorn with --ssl-* so https://<lan-ip>:8000 is fully trusted on
any device that has the mkcert root CA installed.

Usage:
    python scripts/dev_https.py            # generate cert if missing, run
    python scripts/dev_https.py --regen    # force regenerate (use after wifi change)
    AEYES_PORT=9000 python scripts/dev_https.py --reload   # extra args pass through

Prereq (one-time, on the laptop):
    choco install mkcert        # Windows
    mkcert -install             # installs a local root CA into the OS trust store

Prereq (one-time, on each phone): trust the mkcert root CA. See README.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CERTS_DIR = ROOT / "certs"
KEY = CERTS_DIR / "aeyes-key.pem"
CRT = CERTS_DIR / "aeyes.pem"
IP_CACHE = CERTS_DIR / ".issued-for"  # records the LAN IP the cert was issued for


def lan_ip() -> str:
    """Best-effort LAN IP. Opens a UDP socket toward a public address (no
    packet is actually sent — connect on UDP just sets the local route),
    then reads the local end. More reliable than parsing ipconfig output."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_mkcert() -> str:
    path = shutil.which("mkcert")
    if not path:
        sys.exit(
            "mkcert not found on PATH.\n"
            "  Windows:  choco install mkcert  (or scoop install mkcert)\n"
            "  macOS:    brew install mkcert\n"
            "  Linux:    see https://github.com/FiloSottile/mkcert#installation\n"
            "Then run once:  mkcert -install\n"
            "Then re-run this script."
        )
    return path


def needs_regen(ip: str, force: bool) -> bool:
    if force:
        return True
    if not KEY.exists() or not CRT.exists():
        return True
    if not IP_CACHE.exists():
        return True
    return IP_CACHE.read_text().strip() != ip


def generate(mkcert: str, ip: str) -> None:
    CERTS_DIR.mkdir(exist_ok=True)
    print(f"-> issuing cert for localhost, 127.0.0.1, {ip}")
    subprocess.check_call(
        [mkcert, "-key-file", str(KEY), "-cert-file", str(CRT),
         "localhost", "127.0.0.1", ip],
        cwd=ROOT,
    )
    IP_CACHE.write_text(ip)


def main() -> None:
    args = sys.argv[1:]
    force = "--regen" in args
    passthrough = [a for a in args if a != "--regen"]

    mkcert = ensure_mkcert()
    ip = lan_ip()
    if needs_regen(ip, force):
        generate(mkcert, ip)
    else:
        print(f"-> reusing existing cert for {ip}  (pass --regen to refresh)")

    port = os.environ.get("AEYES_PORT", "8000")
    print()
    print(f"  Open on phone:    https://{ip}:{port}")
    print(f"  On this machine:  https://localhost:{port}")
    print(f"  (phone needs the mkcert root CA installed — see README)")
    print()

    cmd = [
        sys.executable, "-m", "uvicorn", "server:app",
        "--host", "0.0.0.0",
        "--port", port,
        "--ssl-keyfile", str(KEY),
        "--ssl-certfile", str(CRT),
        *passthrough,
    ]
    # subprocess.run rather than os.execvp — execvp on Windows is emulated
    # and can mangle Ctrl-C signal handling.
    sys.exit(subprocess.run(cmd, cwd=ROOT).returncode)


if __name__ == "__main__":
    main()
