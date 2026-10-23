"""Small shared helpers: logging, subprocess, git, templating."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Sequence

_COLOR = sys.stderr.isatty() and os.environ.get("NO_COLOR") is None


def _paint(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


def info(msg: str) -> None:
    print(_paint("36", "hx") + f"  {msg}", file=sys.stderr)


def ok(msg: str) -> None:
    print(_paint("32", "ok") + f"  {msg}", file=sys.stderr)


def warn(msg: str) -> None:
    print(_paint("33", "warn") + f" {msg}", file=sys.stderr)


class HxError(Exception):
    """A user-facing failure: printed without a traceback, exits non-zero."""


def run(
    cmd: Sequence[str | os.PathLike],
    cwd: Path | None = None,
    check: bool = True,
    capture: bool = False,
    env: dict | None = None,
    input_text: str | None = None,
) -> subprocess.CompletedProcess:
    merged_env = {**os.environ, **(env or {})}
    result = subprocess.run(
        [str(c) for c in cmd],
        cwd=str(cwd) if cwd else None,
        env=merged_env,
        text=True,
        input=input_text,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        raise HxError(f"Command failed ({result.returncode}): {' '.join(map(str, cmd))}\n{detail}".rstrip())
    return result


def git(engine: Path, *args: str, check: bool = True, input_text: str | None = None) -> str:
    """Run git inside `engine` with a fixed identity, return stdout."""
    env = {
        "GIT_AUTHOR_NAME": "hx",
        "GIT_AUTHOR_EMAIL": "hx@localhost",
        "GIT_COMMITTER_NAME": "hx",
        "GIT_COMMITTER_EMAIL": "hx@localhost",
    }
    res = run(["git", *args], cwd=engine, check=check, capture=True, env=env, input_text=input_text)
    return res.stdout


TOKEN_RE = re.compile(r"\{\{([A-Z_]+)\}\}")


def render(text: str, tokens: dict[str, str], source: str = "<template>") -> str:
    def sub(match: re.Match) -> str:
        key = match.group(1)
        if key not in tokens:
            raise HxError(f"Unknown template token {{{{{key}}}}} in {source}")
        return tokens[key]

    return TOKEN_RE.sub(sub, text)


TEXT_SUFFIXES = {
    ".ftl", ".properties", ".sh", ".js", ".mjs", ".css", ".json", ".xml", ".svg",
    ".html", ".xhtml", ".mozconfig", ".build", ".mn", ".nsi", ".ini", ".toml", ".txt", ".md",
}


def is_text(path: Path) -> bool:
    return path.suffix.lower() in TEXT_SUFFIXES or path.name in {"moz.build", "jar.mn", "mozconfig"}


def rel_files(base: Path) -> list[Path]:
    """All files under base (relative paths), skipping editor junk."""
    if not base.is_dir():
        return []
    out = []
    for p in sorted(base.rglob("*")):
        rel = p.relative_to(base)
        if any(part.startswith(".") for part in rel.parts):  # .gitkeep, .DS_Store, editor dirs
            continue
        if p.is_file() and not p.name.endswith("~"):
            out.append(p.relative_to(base))
    return out
