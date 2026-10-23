"""Track Firefox Release: find the newest release tag upstream and compare with ours."""

from __future__ import annotations

import re
from dataclasses import dataclass

from .util import run

RELEASE_TAG_RE = re.compile(r"refs/tags/FIREFOX_(\d+)_(\d+)(?:_(\d+))?_RELEASE$")


@dataclass(frozen=True, order=True)
class Version:
    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, text: str) -> "Version":
        parts = [int(p) for p in text.split(".")]
        while len(parts) < 3:
            parts.append(0)
        return cls(*parts[:3])

    def __str__(self) -> str:
        base = f"{self.major}.{self.minor}"
        return f"{base}.{self.patch}" if self.patch else base


def release_versions(ls_remote_output: str) -> list[Version]:
    """Parse `git ls-remote --tags` output into Release versions (no betas, ESR or RCs)."""
    out = set()
    for line in ls_remote_output.splitlines():
        ref = line.split("\t")[-1].strip()
        if ref.endswith("^{}"):
            ref = ref[:-3]
        m = RELEASE_TAG_RE.search(ref)
        if m:
            out.add(Version(int(m.group(1)), int(m.group(2)), int(m.group(3) or 0)))
    return sorted(out)


def latest_release(repo: str) -> Version:
    res = run(["git", "ls-remote", "--tags", repo, "refs/tags/FIREFOX_*_RELEASE"], capture=True)
    versions = release_versions(res.stdout)
    if not versions:
        raise RuntimeError(f"No Firefox release tags found at {repo}")
    return versions[-1]


@dataclass(frozen=True)
class UpstreamStatus:
    current: Version
    latest: Version

    @property
    def behind(self) -> bool:
        return self.latest > self.current

    @property
    def kind(self) -> str:
        """'major' for a new Firefox version, 'point' for a dot release (often security), or 'none'."""
        if not self.behind:
            return "none"
        return "major" if self.latest.major != self.current.major else "point"
