"""Tests for tools/audit/network_audit.py using a fake browser (no Firefox, no internet)."""

from __future__ import annotations

import json
import os
import socket
import sys
import tempfile
import textwrap
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "tools" / "audit"))

import network_audit as na  # noqa: E402
from hx import requests as reg  # noqa: E402

# A stand-in browser: reads the proxy port from the profile's user.js like Firefox would, then
# makes the connections listed in $FAKE_CONNECTS ("CONNECT host:port" or "GET http://host/").
FAKE_BROWSER = textwrap.dedent('''
    import os, re, socket, sys
    profile = sys.argv[sys.argv.index("--profile") + 1]
    prefs = open(os.path.join(profile, "user.js")).read()
    port = int(re.search(r'"network.proxy.ssl_port", (\\d+)', prefs).group(1))
    for item in filter(None, os.environ.get("FAKE_CONNECTS", "").split(";")):
        method, target = item.split(" ", 1)
        s = socket.create_connection(("127.0.0.1", port))
        s.sendall(f"{method} {target} HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n".encode())
        reply = s.recv(4096)
        if method == "CONNECT" and reply.startswith(b"HTTP/1.1 200"):
            s.sendall(b"ping")
            echoed = s.recv(4096)
            open(os.environ["FAKE_ECHO_FILE"], "wb").write(echoed)
        s.close()
''')

REGISTRY = textwrap.dedent('''
    [[request]]
    id = "lists"
    name = "Lists"
    purpose = "p"
    hosts = ["lists.example.org", "*.cdn.example.org"]
    state = "on"
    trigger = "background"
    switch = "s"

    [[request]]
    id = "push"
    name = "Push"
    purpose = "p"
    hosts = ["push.example.org"]
    state = "on"
    trigger = "user"
    switch = "s"

    [[request]]
    id = "telemetry"
    name = "Telemetry"
    purpose = "p"
    hosts = ["telemetry.example.org"]
    state = "off"
    trigger = "background"
    switch = "s"
''')


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="audit-test-"))
        self.browser = self.tmp / "fake_browser.py"
        self.browser.write_text(FAKE_BROWSER, encoding="utf-8")
        self.registry = self.tmp / "requests.toml"
        self.registry.write_text(REGISTRY, encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def launcher(self) -> str:
        """An executable wrapper so --browser can be a single path on every OS."""
        if os.name == "nt":
            wrapper = self.tmp / "browser.cmd"
            wrapper.write_text(f'@"{sys.executable}" "{self.browser}" %*\r\n', encoding="utf-8")
        else:
            wrapper = self.tmp / "browser"
            wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{self.browser}" "$@"\n', encoding="utf-8")
            wrapper.chmod(0o755)
        return str(wrapper)

    def run_audit(self, connects: str, *extra: str) -> tuple[int, list[dict]]:
        os.environ["FAKE_CONNECTS"] = connects
        out = self.tmp / "findings.json"
        code = na.main(["--browser", self.launcher(), "--registry", str(self.registry),
                        "--seconds", "20", "--no-forward", "--json", str(out), *extra])
        return code, json.loads(out.read_text())

    def test_clean_run_passes(self):
        code, findings = self.run_audit(
            "CONNECT lists.example.org:443;CONNECT a.cdn.example.org:443;CONNECT lists.example.org:443")
        self.assertEqual(code, 0)
        self.assertEqual({f["host"]: (f["count"], f["verdict"]) for f in findings},
                         {"a.cdn.example.org": (1, "ok"), "lists.example.org": (2, "ok")})

    def test_each_kind_of_violation(self):
        code, findings = self.run_audit(
            "CONNECT lists.example.org:443;CONNECT tracker.evil.test:443;"
            "CONNECT telemetry.example.org:443;CONNECT push.example.org:443;"
            "GET http://plain.example.net/generate_204")
        self.assertEqual(code, 1)
        verdicts = {f["host"]: f["verdict"] for f in findings}
        self.assertEqual(verdicts, {
            "lists.example.org": "ok",
            "tracker.evil.test": "undocumented",
            "telemetry.example.org": "turned-off",
            "push.example.org": "needs-user-action",
            "plain.example.net": "undocumented",
        })

    def test_markdown_report(self):
        md = self.tmp / "summary.md"
        self.run_audit("CONNECT tracker.evil.test:443", "--markdown", str(md))
        text = md.read_text()
        self.assertIn("1 violation", text)
        self.assertIn("`tracker.evil.test`", text)

    def test_forwarding_tunnels_traffic(self):
        # Local echo server stands in for a real site.
        srv = socket.socket()
        srv.bind(("127.0.0.1", 0))
        srv.listen()
        port = srv.getsockname()[1]

        def echo():
            conn, _ = srv.accept()
            with conn:
                conn.sendall(conn.recv(4096))

        threading.Thread(target=echo, daemon=True).start()
        os.environ["FAKE_CONNECTS"] = f"CONNECT 127.0.0.1:{port}"
        os.environ["FAKE_ECHO_FILE"] = str(self.tmp / "echo.txt")
        code = na.main(["--browser", self.launcher(), "--registry", str(self.registry), "--seconds", "20"])
        srv.close()
        self.assertEqual(code, 0, "localhost is never a violation")
        self.assertEqual((self.tmp / "echo.txt").read_bytes(), b"ping")

    def test_wildcards_do_not_match_the_bare_domain(self):
        registry = reg.load(self.registry)
        self.assertEqual(reg.classify(registry, "x.cdn.example.org").id, "lists")
        self.assertIsNone(reg.classify(registry, "cdn.example.org"))
        self.assertIsNone(reg.classify(registry, "evilcdn.example.org"))


class RegistryFileTests(unittest.TestCase):
    def test_project_registry_is_valid(self):
        entries = reg.load(ROOT / "privacy" / "requests.toml")
        ids = {e.id for e in entries}
        self.assertIn("telemetry", ids)
        self.assertIn("app-updates", ids)
        self.assertTrue(all(e.state in ("on", "off") for e in entries))


if __name__ == "__main__":
    unittest.main()
