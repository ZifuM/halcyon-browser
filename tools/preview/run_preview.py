#!/usr/bin/env python3
"""Screenshot Halcyon's UI in a stock Firefox, without building anything.

Loads our layout modules and default prefs into an official Firefox release (the version in
project.toml) through autoconfig, scripts a session (halcyon-preview.cfg) and takes an X
screenshot at each layout state. Run it under Xvfb:

    xvfb-run -a -s "-screen 0 1440x900x24" \\
        python3 tools/preview/run_preview.py --firefox firefox/ --out previews/

Writes previews/<state>.png, console.log (errors from the browser), order.json / new-tab.json
(checks the scenario records) and summary.md. Exit status 1 if the scenario failed or a check
didn't hold.
"""

from __future__ import annotations

import argparse
import functools
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools"))

from hx import config, prefs  # noqa: E402

# Prefs for the preview profile only: skip first-run pages and anything that needs our engine
# patches (Shield's classifier feature doesn't exist in a stock build).
USER_JS = {
    "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore",
    "startup.homepage_welcome_url": "",
    "startup.homepage_welcome_url.additional": "",
    "browser.startup.page": 0,
    "browser.startup.homepage": "about:blank",
    "browser.newtabpage.enabled": False,
    "datareporting.policy.dataSubmissionPolicyBypassNotification": True,
    "toolkit.telemetry.reportingpolicy.firstRun": False,
    "browser.tabs.warnOnClose": False,
    "sidebar.verticalTabs.dragToPinPromo.dismissed": True,
    "privacy.trackingprotection.content.protection.enabled": False,
    "browser.sessionstore.resume_from_crash": False,
    "app.update.disabledForTesting": True,
    "browser.translations.automaticallyPopup": False,
    "media.autoplay.default": 5,
}


def js_value(value) -> str:
    return json.dumps(value)


def install(firefox: Path, out: Path) -> None:
    """Autoconfig loader, the scenario script and our default prefs, into the Firefox folder."""
    (firefox / "defaults/pref").mkdir(parents=True, exist_ok=True)
    shutil.copy(HERE / "autoconfig.js", firefox / "defaults/pref/autoconfig.js")
    shutil.copy(HERE / "halcyon-preview.cfg", firefox / "halcyon-preview.cfg")
    project = config.load(ROOT)
    groups = prefs.load_groups(ROOT / "prefs")
    target = firefox / "browser/defaults/preferences"
    target.mkdir(parents=True, exist_ok=True)
    (target / "halcyon-prefs.js").write_text(prefs.compile_js(groups, project.name), newline="\n")


def make_profile() -> Path:
    profile = Path(tempfile.mkdtemp(prefix="halcyon-preview-profile-"))
    lines = [f"user_pref({json.dumps(k)}, {js_value(v)});" for k, v in USER_JS.items()]
    (profile / "user.js").write_text("\n".join(lines) + "\n", newline="\n")
    return profile


def serve(directory: Path) -> tuple[http.server.ThreadingHTTPServer, str]:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(directory))
    handler.log_message = lambda *a, **k: None
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/"


def screenshot(path: Path) -> None:
    subprocess.run(["import", "-window", "root", str(path)], check=True, timeout=30)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--firefox", required=True, help="extracted Firefox folder (contains firefox)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=int, default=240)
    args = ap.parse_args()

    firefox = Path(args.firefox).resolve()
    out = Path(args.out).resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    install(firefox, out)
    profile = make_profile()
    server, site = serve(HERE / "site")

    env = dict(os.environ)
    env.update({
        "HALCYON_PREVIEW_SRC": str(ROOT / "src/browser/components/halcyon"),
        "HALCYON_PREVIEW_TOOLS": str(HERE),
        "HALCYON_PREVIEW_OUT": str(out),
        "HALCYON_PREVIEW_SITE": site,
        "MOZ_ENABLE_WAYLAND": "0",
        "MOZ_CRASHREPORTER_DISABLE": "1",
    })
    binary = firefox / "firefox"
    proc = subprocess.Popen(
        [str(binary), "--no-remote", "--new-instance", "--profile", str(profile)],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    output: list[str] = []
    threading.Thread(
        target=lambda: output.extend(line.decode(errors="replace") for line in proc.stdout),
        daemon=True,
    ).start()

    shots: list[str] = []
    deadline = time.time() + args.timeout
    status = "timeout"
    while time.time() < deadline:
        for ready in sorted(out.glob("*.ready")):
            name = ready.stem
            if (out / f"{name}.done").exists():
                continue
            time.sleep(0.3)
            screenshot(out / f"{name}.png")
            shots.append(name)
            (out / f"{name}.done").write_text("")
        if (out / "finished").exists():
            status = (out / "finished").read_text().strip() or "ok"
            break
        if proc.poll() is not None:
            status = f"firefox exited with {proc.returncode}"
            break
        time.sleep(0.2)

    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
    server.shutdown()
    (out / "firefox-output.log").write_text("".join(output))
    for marker in list(out.glob("*.ready")) + list(out.glob("*.done")):
        marker.unlink()

    checks = []
    order_file = out / "order.json"
    if order_file.exists():
        tabs = json.loads(order_file.read_text())["tabs"]
        sections = ["essential" if t["essential"] else "pinned" if t["pinned"] else "today" for t in tabs]
        rank = {"essential": 0, "pinned": 1, "today": 2}
        checks.append(("Essentials, then Pinned, then Today", sections == sorted(sections, key=rank.get)))
    new_tab = out / "new-tab.json"
    if new_tab.exists():
        data = json.loads(new_tab.read_text())
        checks.append(("+ New Tab opens at the top of Today", data["index"] == data["expected"]))
    toolbar = out / "toolbar.json"
    if toolbar.exists():
        data = json.loads(toolbar.read_text())
        placed = data["placements"]
        checks.append(("Copy-link button sits right after the address", data.get("copyLinkAfterUrlbar") is True))
        expected = ["sidebar-button", "back-button", "forward-button", "stop-reload-button",
                    "urlbar-container", "halcyon-copy-link-button"]
        checks.append(("Top bar: sidebar, back, forward, reload, address, copy link (in order)",
                       [w for w in placed if w in expected] == expected))
        checks.append(("No AI or sign-in buttons in the top bar",
                       not {"ai-window-toggle", "smartwindow-group-tabs-button", "fxa-toolbar-menu-button"} & set(placed)))
    compact = out / "compact.json"
    if compact.exists():
        c = json.loads(compact.read_text())
        checks.append(("Compact: shortcut hides the chrome", c["afterToggle"] == {"compact": True, "reveal": ""}))
        checks.append(("Compact: window edge reveals the sidebar", c["afterEdge"]["reveal"] == "sidebar"))
        checks.append(("Compact: address-bar focus reveals the top bar", c["afterFocus"]["reveal"] == "sidebar toolbar"))
        checks.append(("Compact: both hide again when left", c["afterLeave"]["reveal"] == ""))
        checks.append(("Compact: shortcut turns it off", c["afterOff"] == {"compact": False, "reveal": ""}))
    tab_menu = out / "tab-menu.json"
    if tab_menu.exists():
        data = json.loads(tab_menu.read_text())
        ids = [i["id"] for i in data["items"]]
        labels = [i["label"] for i in data["items"]]
        checks.append(("Tab menu opened", data["open"]))
        checks.append(("Tab menu has no AI chatbot item", "context_askChat" not in ids))
        checks.append(("Tab menu offers Pin to Sidebar and Add to Essentials",
                       "Pin to Sidebar" in labels and "Add to Essentials" in labels and "Pin Tab" not in labels))
    errors = []
    if (out / "console.log").exists():
        errors = [l for l in (out / "console.log").read_text().splitlines()
                  if ("halcyon" in l.lower() or "[scenario]" in l)
                  and "first window ready" not in l and "addons.xpi" not in l]

    if not (out / "started").exists():
        status += " (autoconfig never ran: check defaults/pref/autoconfig.js and the .cfg)"
    lines = ["# Halcyon UI preview", "", f"Scenario: **{status}**", ""]
    lines += [f"- {'PASS' if ok else 'FAIL'}: {name}" for name, ok in checks]
    lines += ["", f"Screenshots: {', '.join(shots) or 'none'}", ""]
    if errors:
        lines += ["Errors from our code:", "", "```", *errors[:50], "```"]
    (out / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    ok = status == "ok" and all(ok for _, ok in checks) and not errors
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
