"""The every-request registry: privacy/requests.toml -> public page + network-audit allowlist."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from .util import HxError

HOST_RE = re.compile(r"^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$")
STATES = ("on", "off")
TRIGGERS = ("background", "user")


@dataclass(frozen=True)
class Request:
    id: str
    name: str
    purpose: str
    hosts: tuple[str, ...]
    state: str
    trigger: str
    switch: str


def load(path: Path) -> list[Request]:
    if not path.is_file():
        raise HxError(f"{path} not found")
    with open(path, "rb") as fh:
        try:
            data = tomllib.load(fh)
        except tomllib.TOMLDecodeError as exc:
            raise HxError(f"{path.name}: invalid TOML: {exc}") from None
    out: list[Request] = []
    ids: set[str] = set()
    host_owner: dict[str, str] = {}
    for i, e in enumerate(data.get("request", []), start=1):
        where = f"{path.name} entry {i}"
        required = {"id", "name", "purpose", "hosts", "state", "trigger", "switch"}
        if missing := required - set(e):
            raise HxError(f"{where}: missing {sorted(missing)}")
        if extra := set(e) - required:
            raise HxError(f"{where}: unknown keys {sorted(extra)}")
        if e["id"] in ids:
            raise HxError(f"{where}: duplicate id {e['id']!r}")
        ids.add(e["id"])
        if e["state"] not in STATES:
            raise HxError(f"{where}: state must be one of {STATES}")
        if e["trigger"] not in TRIGGERS:
            raise HxError(f"{where}: trigger must be one of {TRIGGERS}")
        for host in e["hosts"]:
            if not HOST_RE.match(host):
                raise HxError(f"{where}: invalid host {host!r}")
            if host in host_owner:
                raise HxError(f"{where}: host {host} is already listed under {host_owner[host]!r}")
            host_owner[host] = e["id"]
        out.append(Request(e["id"], e["name"], e["purpose"].strip(), tuple(e["hosts"]),
                           e["state"], e["trigger"], e["switch"].strip()))
    return out


def host_matches(pattern: str, host: str) -> bool:
    host = host.lower().rstrip(".")
    if pattern.startswith("*."):
        return host.endswith(pattern[1:]) and host != pattern[2:]
    return host == pattern


def classify(requests: list[Request], host: str) -> Request | None:
    for req in requests:
        if any(host_matches(p, host) for p in req.hosts):
            return req
    return None


def render_markdown(requests: list[Request], product: str) -> str:
    def table(rows: list[Request], last_col: str) -> list[str]:
        lines = [f"| Connection | What it's for | Hosts | {last_col} |", "| --- | --- | --- | --- |"]
        for r in rows:
            hosts = ", ".join(f"`{h}`" for h in r.hosts) or "varies"
            lines.append(f"| {r.name} | {r.purpose} | {hosts} | {r.switch} |")
        return lines

    on_bg = [r for r in requests if r.state == "on" and r.trigger == "background"]
    on_user = [r for r in requests if r.state == "on" and r.trigger == "user"]
    off = [r for r in requests if r.state == "off"]
    out = [
        "# Every request the browser makes on its own",
        "",
        "<!-- Generated from privacy/requests.toml by `hx requests --write`. Do not edit here. -->",
        "",
        f"This is the complete list of connections {product} can open without you navigating",
        "somewhere. The network audit in CI launches the browser with a fresh profile, records",
        "every connection it attempts while idle, and fails the build if anything is not on this",
        "page, or if something listed as turned off still connects.",
        "",
        "## On by default, may happen in the background",
        "",
        *table(on_bg, "Turn it off"),
        "",
        "## Only after you do something",
        "",
        *table(on_user, "Turn it off"),
        "",
        "## Turned off (Firefox does these; we don't)",
        "",
        *table(off, "Turn it back on"),
        "",
    ]
    return "\n".join(out)


MODULE_HEADER = """/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Generated from privacy/requests.toml by `hx requests --write`. Do not edit here.
// The every-request registry, for the Privacy Ledger: what each connection the browser makes
// on its own is for, and how to turn it off.
"""


def render_module(requests: list[Request]) -> str:
    """The registry as a JS module the browser can read (the Ledger classifies with it)."""
    import json

    entries = [
        {"id": r.id, "name": r.name, "purpose": r.purpose, "hosts": list(r.hosts),
         "state": r.state, "trigger": r.trigger, "switch": r.switch}
        for r in requests
    ]
    body = json.dumps(entries, indent=2, ensure_ascii=False)
    return MODULE_HEADER + f"""
export const REQUESTS = Object.freeze({body}.map(entry => Object.freeze(entry)));

/** Whether `host` matches a registry host pattern (`*.example.com` covers subdomains only). */
export function hostMatches(pattern, host) {{
  host = String(host).toLowerCase().replace(/\\.$/, "");
  if (pattern.startsWith("*.")) {{
    return host.endsWith(pattern.slice(1)) && host != pattern.slice(2);
  }}
  return host == pattern;
}}

/** The registry entry a host belongs to, or null if it isn't listed. */
export function classify(host) {{
  return REQUESTS.find(entry => entry.hosts.some(pattern => hostMatches(pattern, host))) ?? null;
}}
"""
