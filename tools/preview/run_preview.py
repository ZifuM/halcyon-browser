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
    ap.add_argument("--timeout", type=int, default=480)
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
    sp = out / "spaces.json"
    if sp.exists():
        d = json.loads(sp.read_text())
        checks.append(("Spaces: Work is active, its name above Pinned, three dots", d["active"] and d["header"] == "Work" and d["dots"] == 3))
        checks.append(("Spaces: only Work's tabs are visible (plus the new tab an empty Space opens with)",
                       sorted(d["visibleTodayTabs"]) == sorted(
                           ["Q4 planning — Docs", "halcyon-browser: Pull requests", "Roadmap 2027", "New Tab"])))
        checks.append(("Spaces: Work's pinned tab is a synced launcher, titled from the page",
                       d["pinsInWork"] == ["Q4 planning — Docs"]))
        checks.append(("Spaces: the window takes Work's colour", d["hueOnWindow"] == "155"))
    sk = out / "spaces-keys.json"
    if sk.exists():
        d = json.loads(sk.read_text())
        checks.append(("Spaces: Ctrl+Alt+Right goes to the next Space", d["afterNext"] == "Weekend"))
        checks.append(("Spaces: closing a Space's last tab stays in that Space",
                       d["afterCloseLast"]["stayed"] and d["afterCloseLast"]["selectedInSpace"]))
        checks.append(("Spaces: Ctrl+Alt+1 jumps to the first; Work's tabs hide", d["afterJump1"] == "Personal" and d["workTabsHiddenInPersonal"]))
    sy = out / "sync.json"
    if sy.exists():
        d = json.loads(sy.read_text())
        checks.append(("Sync: Firefox Sync's prefs engine carries halcyon.spaces", d["syncedByFirefoxSync"]))
        checks.append(("Sync: a Space from another machine appears", d["dots"] == 4))
        checks.append(("Sync: an Essential from another machine opens here (unloaded)", d["laptopEssential"]))
    tab_menu = out / "tab-menu.json"
    if tab_menu.exists():
        data = json.loads(tab_menu.read_text())
        ids = [i["id"] for i in data["items"]]
        labels = [i["label"] for i in data["items"]]
        checks.append(("Tab menu opened", data["open"]))
        checks.append(("Tab menu has no AI chatbot item", "context_askChat" not in ids))
        checks.append(("Tab menu offers Pin to Sidebar and Add to Essentials",
                       "Pin to Sidebar" in labels and "Add to Essentials" in labels and "Pin Tab" not in labels))
    cb = out / "commandbar.json"
    if cb.exists():
        d = json.loads(cb.read_text())
        o = d["opened"]
        checks.append(("Command bar: Ctrl+T opens it, focused (Firefox's key pointed at it)",
                       o["open"] and o["mode"] == "newtab" and o["focused"] and o["keyRetargeted"]))
        titles = [r["title"] for r in d["rustRows"]]
        checks.append(("Command bar: \"rust\" finds the Rust page from history", any("Rust" in (t or "") for t in titles[:3])))
        checks.append(("Command bar: @tabs becomes a filter chip and lists only tabs",
                       d["tabsFilter"]["chip"] == "Tabs" and d["tabsFilter"]["rows"] and set(d["tabsFilter"]["rows"]) == {"0"}))
        checks.append(("Command bar: \"> zoom\" lists the zoom actions", [r["title"] for r in d["zoomRows"]][:1] in (["Zoom In"], ["Zoom Out"], ["Reset Zoom"])))
        checks.append(("Command bar: Backspace on an empty bar removes the filter chip", d.get("chipCleared") is True))
        checks.append(("Command bar: bookmarks are found", any(r["title"] == "Halcyon on GitHub" and r["kind"] == "1" for r in d["bookmarkRows"])))
        checks.append(("Command bar: Enter opens the top result in a new tab and closes the bar",
                       d["afterEnter"]["closed"] and d["afterEnter"]["newTab"] and "rust-lang.org/learn" in d["afterEnter"]["url"]))
        checks.append(("Command bar: Ctrl+L opens it on this page's address",
                       d["address"]["open"] and d["address"]["mode"] == "address" and "rust-lang.org/learn" in d["address"]["value"]))
        checks.append(("Command bar: Escape closes it", d["escapeCloses"]))
    perf = out / "commandbar-perf.json"
    if perf.exists():
        d = json.loads(perf.read_text())
        checks.append((f"Command bar index in Firefox's WebAssembly: {d['items']} entries, p95 {d['p95Ms']} ms per keystroke (budget 16)",
                       d["native"] and d["items"] == 100000 and d["p95Ms"] <= 16))
    sc = out / "shortcuts.json"
    if sc.exists():
        d = json.loads(sc.read_text())
        checks.append(("Shortcuts: recording Ctrl+Shift+U adds a key for Copy Link",
                       d["first"]["key"] == "U" and d["first"]["modifiers"] == "accel,shift"))
        checks.append(("Shortcuts: taking Firefox's Ctrl+R asks first, then disables Reload's key",
                       "Reload" in (d["asked"] or "") and d["taken"]["reloadDisabled"]))
        checks.append(("Shortcuts: removing it gives Ctrl+R back", not d["givenBack"]["reloadDisabled"] and not d["givenBack"]["ours"]))
    du = out / "duplicates.json"
    if du.exists():
        d = json.loads(du.read_text())
        checks.append(("Command bar: @duplicates lists repeated tabs under Close Duplicate Tabs",
                       d["repeatsBefore"] > 0 and d["duplicateRows"][:1] and d["duplicateRows"][0]["title"] == "Close Duplicate Tabs"
                       and all(r["kind"] == "0" for r in d["duplicateRows"][1:])))
        checks.append(("Command bar: Close Duplicate Tabs leaves each page open once", d["repeatsAfter"] == 0))
    off = out / "commandbar-off.json"
    if off.exists():
        d = json.loads(off.read_text())
        checks.append(("Command bar off: Firefox's Ctrl+T and Ctrl+L work as before",
                       d["off"]["newTabCommand"] == "cmd_newNavigatorTabNoEvent" and d["off"]["addressCommand"] == "Browser:OpenLocation" and d["backOn"]))
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
