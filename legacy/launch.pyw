import argparse
import atexit
import os
import random
import socket
import subprocess
import sys
import time

import webview


WINDOW_WIDTH = 1200
WINDOW_HEIGHT = 820
BRIDGE_DEFAULT_PORT = 14168

ROOT = os.path.dirname(os.path.abspath(__file__))


def project_python():
    venv_python = os.path.join(
        ROOT,
        ".venv",
        "Scripts" if os.name == "nt" else "bin",
        "python.exe" if os.name == "nt" else "python",
    )
    return venv_python if os.path.exists(venv_python) else sys.executable


def port_is_open(port):
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def find_free_port(lo=BRIDGE_DEFAULT_PORT + 1, hi=BRIDGE_DEFAULT_PORT + 100):
    ports = list(range(lo, hi + 1))
    random.shuffle(ports)
    for port in ports:
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError(f"No free port in {lo}-{hi}")


def pick_bridge_port(raw_port):
    if raw_port != "0":
        return int(raw_port)
    return BRIDGE_DEFAULT_PORT if not port_is_open(BRIDGE_DEFAULT_PORT) else find_free_port()


def wait_for_port(port, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if port_is_open(port):
            return True
        time.sleep(0.25)
    return False


def start_html_bridge(port):
    if port_is_open(port):
        print(f"[Launch] HTML bridge already running on {port}; reusing it")
        return None

    env = os.environ.copy()
    env["BRIDGE_HOST"] = "127.0.0.1"
    env["BRIDGE_PORT"] = str(port)
    proc = subprocess.Popen(
        [project_python(), os.path.join(ROOT, "frontends", "desktop_bridge.py")],
        cwd=ROOT,
        env=env,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    atexit.register(proc.kill)
    return proc


def main():
    parser = argparse.ArgumentParser(prog="SecHeur Agent")
    parser.add_argument("port", nargs="?", default="0", help="本地 bridge 端口，0 表示自动选择")
    args = parser.parse_args()

    port = pick_bridge_port(args.port)
    app_url = f"http://127.0.0.1:{port}/"
    print(f"[Launch] Using HTML desktop UI on port {port}")
    start_html_bridge(port)
    if not wait_for_port(port):
        print(f"[Launch] Warning: HTML bridge did not become ready on {port}")

    window = webview.create_window(
        title="SecHeur Agent",
        url=app_url,
        width=WINDOW_WIDTH,
        height=WINDOW_HEIGHT,
        resizable=True,
        text_select=True,
    )
    webview.start()
    return window


if __name__ == "__main__":
    main()
