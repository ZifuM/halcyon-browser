"""Network audit: does the browser contact anything that isn't in privacy/requests.toml?

Launches the built browser headless with a brand-new profile whose only change is an HTTP/HTTPS
proxy pointing at a recorder on 127.0.0.1. Every connection the browser attempts while idle goes
through the recorder, which notes the host and (by default) forwards the traffic so features behave
as they really would. After the idle period the browser is closed (shutdown traffic is captured
too) and every host is checked against the registry:

  ok         listed, state "on", trigger "background"
  violation  not listed at all                          -> undocumented connection
  violation  listed with state "off"                    -> we said it's off, but it isn't
  violation  listed with trigger "user"                 -> happened without any user action

Usage:
  python3 tools/audit/network_audit.py --browser path/to/peryn [--seconds 120]
Exit status 1 if there are violations. Standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))

from hx import requests as registry_mod  # noqa: E402

# ---- recording proxy ----------------------------------------------------------


@dataclass
class Recorder:
    forward: bool = True
    hits: dict[str, int] = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def record(self, host: str) -> None:
        host = host.lower().strip("[]").rstrip(".")
        with self.lock:
            self.hits[host] = self.hits.get(host, 0) + 1


def _relay(a: socket.socket, b: socket.socket, idle_timeout: float = 60.0) -> None:
    sockets = [a, b]
    try:
        while True:
            readable, _, errored = select.select(sockets, [], sockets, idle_timeout)
            if errored or not readable:
                return
            for s in readable:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        return


class _Handler(socketserver.StreamRequestHandler):
    recorder: Recorder  # set on the server class

    def handle(self) -> None:
        rec: Recorder = self.server.recorder  # type: ignore[attr-defined]
        try:
            request_line = self.rfile.readline(8192).decode("latin-1").strip()
            headers = []
            while True:
                line = self.rfile.readline(8192)
                if not line or line in (b"\r\n", b"\n"):
                    break
                headers.append(line)
        except OSError:
            return
        parts = request_line.split()
        if len(parts) < 3:
            return
        method, target = parts[0].upper(), parts[1]

        if method == "CONNECT":
            host, _, port = target.rpartition(":")
            rec.record(host)
            if not rec.forward:
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            try:
                upstream = socket.create_connection((host, int(port or 443)), timeout=15)
            except OSError:
                self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                return
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            with upstream:
                _relay(self.connection, upstream)
            return

        # Plain HTTP through a proxy uses an absolute URI: GET http://host/path HTTP/1.1
        url = urlsplit(target)
        if not url.hostname:
            return
        rec.record(url.hostname)
        if not rec.forward:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((url.hostname, url.port or 80), timeout=15)
        except OSError:
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            return
        path = url.path or "/"
        if url.query:
            path += "?" + url.query
        with upstream:
            upstream.sendall(f"{method} {path} {parts[2]}\r\n".encode("latin-1") + b"".join(headers) + b"\r\n")
            _relay(self.connection, upstream)


class _Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def start_proxy(recorder: Recorder) -> tuple[_Server, int]:
    server = _Server(("127.0.0.1", 0), _Handler)
    server.recorder = recorder  # type: ignore[attr-defined]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


# ---- browser launch -------------------------------------------------------------

def write_profile(profile: Path, port: int) -> None:
    """The ONLY prefs we change: route everything through the recorder."""
    prefs = {
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": port,
        "network.proxy.ssl": "127.0.0.1",
        "network.proxy.ssl_port": port,
        "network.proxy.share_proxy_settings": True,
        "network.proxy.no_proxies_on": "",
        "network.proxy.socks_remote_dns": False,
    }
    lines = [f"user_pref({json.dumps(k)}, {json.dumps(v)});" for k, v in prefs.items()]
    (profile / "user.js").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")


def run_browser(browser: str, profile: Path, seconds: float, grace: float = 15.0) -> int:
    env = {**os.environ, "MOZ_HEADLESS": "1", "MOZ_CRASHREPORTER_DISABLE": "1"}
    cmd = [browser, "--headless", "--no-remote", "--profile", str(profile), "about:blank"]
    proc = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and proc.poll() is None:
        time.sleep(0.5)
    if proc.poll() is None:
        proc.terminate()  # graceful quit: lets shutdown-time requests happen and get recorded
        try:
            proc.wait(timeout=grace)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
    return proc.returncode or 0


# ---- the Privacy Ledger must match ----------------------------------------------------
# The browser's own record of its connections (peryn-ledger.json in the profile, written at
# shutdown) has to show every host the proxy saw: if the Ledger misses one, it can't be trusted.

LOCAL = {"127.0.0.1", "localhost", "::1"}


def read_ledger_hosts(profile: Path) -> set[str] | None:
    path = profile / "peryn-ledger.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    hosts: set[str] = set()
    for day in (data.get("days") or {}).values():
        hosts |= set((day.get("connections") or {}).keys())
    return hosts


def compare_ledger(hits: dict[str, int], ledger: set[str] | None) -> list[str]:
    if ledger is None:
        return ["the browser wrote no Ledger (peryn-ledger.json) to compare with"]
    missed = sorted(h for h in hits if h not in LOCAL and h.lower() not in ledger)
    return [f"{h} was seen by the audit but is missing from the Ledger" for h in missed]


def report_ledger(problems: list[str], ledger: set[str] | None) -> str:
    lines = ["", "## Privacy Ledger", ""]
    if ledger is None:
        lines.append("**No Ledger written.**")
    elif problems:
        lines.append(f"**{len(problems)} host(s) missing from the Ledger:**")
        lines += [f"- {p}" for p in problems]
    else:
        lines.append(f"**Matches:** every host the audit saw is in the Ledger ({len(ledger)} hosts recorded).")
    return "\n".join(lines) + "\n"


# ---- verdict --------------------------------------------------------------------

@dataclass
class Finding:
    host: str
    count: int
    verdict: str          # ok | undocumented | turned-off | needs-user-action
    entry: str | None


def judge(hits: dict[str, int], registry: list[registry_mod.Request]) -> list[Finding]:
    out = []
    for host, count in sorted(hits.items()):
        if host in ("127.0.0.1", "localhost", "::1"):
            continue
        req = registry_mod.classify(registry, host)
        if req is None:
            verdict = "undocumented"
        elif req.state == "off":
            verdict = "turned-off"
        elif req.trigger == "user":
            verdict = "needs-user-action"
        else:
            verdict = "ok"
        out.append(Finding(host, count, verdict, req.id if req else None))
    return out


MESSAGES = {
    "undocumented": "not listed in privacy/requests.toml",
    "turned-off": "listed as turned off, but the browser still connected",
    "needs-user-action": "should only happen after a user action, but happened while idle",
}


def report_markdown(findings: list[Finding], seconds: float) -> str:
    bad = [f for f in findings if f.verdict != "ok"]
    lines = [f"## Network audit ({int(seconds)} s idle, fresh profile)", ""]
    lines.append("**Result: pass**" if not bad else f"**Result: {len(bad)} violation(s)**")
    lines += ["", "| Host | Connections | Registry entry | Verdict |", "| --- | --- | --- | --- |"]
    for f in findings:
        lines.append(f"| `{f.host}` | {f.count} | {f.entry or '-'} | {f.verdict} |")
    if not findings:
        lines.append("| (none) | 0 | - | ok |")
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--browser", required=True, help="path to the browser executable")
    ap.add_argument("--registry", default=str(ROOT / "privacy" / "requests.toml"))
    ap.add_argument("--seconds", type=float, default=120.0, help="idle time before quitting")
    ap.add_argument("--no-forward", action="store_true", help="record only; answer 502 to everything")
    ap.add_argument("--json", help="write findings as JSON here")
    ap.add_argument("--markdown", help="write a Markdown report here (e.g. $GITHUB_STEP_SUMMARY)")
    args = ap.parse_args(argv)

    registry = registry_mod.load(Path(args.registry))
    recorder = Recorder(forward=not args.no_forward)
    server, port = start_proxy(recorder)
    try:
        with tempfile.TemporaryDirectory(prefix="netaudit-") as tmp:
            profile = Path(tmp)
            write_profile(profile, port)
            print(f"Recording proxy on 127.0.0.1:{port}; running browser for {args.seconds:.0f} s...")
            run_browser(args.browser, profile, args.seconds)
            time.sleep(1)
            ledger_hosts = read_ledger_hosts(profile)
    finally:
        server.shutdown()

    findings = judge(dict(recorder.hits), registry)
    md = report_markdown(findings, args.seconds)
    ledger_problems = compare_ledger(dict(recorder.hits), ledger_hosts)
    md += report_ledger(ledger_problems, ledger_hosts)
    print(md)
    if args.markdown:
        with open(args.markdown, "a", encoding="utf-8") as fh:
            fh.write(md)
    if args.json:
        Path(args.json).write_text(json.dumps([f.__dict__ for f in findings], indent=2), encoding="utf-8")
    violations = [f for f in findings if f.verdict != "ok"]
    for f in violations:
        print(f"::error title=Network audit: {f.host}::{f.host} {MESSAGES[f.verdict]}")
    for problem in ledger_problems:
        print(f"::error title=Privacy Ledger::{problem}")
    return 1 if violations or ledger_problems else 0


if __name__ == "__main__":
    sys.exit(main())
