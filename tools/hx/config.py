"""Project configuration: reads project.toml and derives every name/path the toolchain uses."""

from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

APP_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{1,30}$")
FIREFOX_VERSION_RE = re.compile(r"^(\d+)\.(\d+)(?:\.(\d+))?$")


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Project:
    root: Path
    name: str
    app_name: str
    vendor: str
    bundle_id: str
    homepage: str
    display_version: str
    firefox_version: str
    upstream_repo: str
    channel: str
    patch_budget: int
    security_sla_hours: int
    update_repo: str = ""

    # ---- derived paths -------------------------------------------------
    @property
    def engine(self) -> Path:
        return self.root / "engine"

    @property
    def patches_dir(self) -> Path:
        return self.root / "patches"

    @property
    def src_dir(self) -> Path:
        return self.root / "src"

    @property
    def prefs_dir(self) -> Path:
        return self.root / "prefs"

    @property
    def branding_dir(self) -> Path:
        return self.root / "branding"

    @property
    def configs_dir(self) -> Path:
        return self.root / "configs"

    @property
    def branding_engine_rel(self) -> str:
        """Branding directory inside the engine tree, e.g. browser/branding/halcyon."""
        return f"browser/branding/{self.app_name}"

    @property
    def upstream_tag(self) -> str:
        return firefox_tag(self.firefox_version)

    def tokens(self) -> dict[str, str]:
        """Values substituted for {{TOKEN}} in branding templates and mozconfigs."""
        return {
            "NAME": self.name,
            "APP_NAME": self.app_name,
            "VENDOR": self.vendor,
            "BUNDLE_ID": self.bundle_id,
            "HOMEPAGE": self.homepage,
            "DISPLAY_VERSION": self.display_version,
            "FIREFOX_VERSION": self.firefox_version,
            "BRANDING_DIR": self.branding_engine_rel,
            # macOS bundle id is built by Firefox as <distribution-id>.<MOZ_MACBUNDLE_ID>
            "DISTRIBUTION_ID": self.bundle_id.rsplit(".", 1)[0],
            "MACBUNDLE_ID": self.bundle_id.rsplit(".", 1)[1],
            "UPDATE_REPO": self.update_repo,
        }


def firefox_tag(version: str) -> str:
    """'158.0.1' -> 'FIREFOX_158_0_1_RELEASE'."""
    if not FIREFOX_VERSION_RE.match(version):
        raise ConfigError(f"Not a Firefox release version: {version!r}")
    return "FIREFOX_" + version.replace(".", "_") + "_RELEASE"


def find_root(start: Path | None = None) -> Path:
    here = (start or Path.cwd()).resolve()
    for candidate in (here, *here.parents):
        if (candidate / "project.toml").is_file():
            return candidate
    raise ConfigError("project.toml not found; run hx from inside the project")


def load(root: Path | None = None) -> Project:
    root = find_root(root)
    with open(root / "project.toml", "rb") as fh:
        data = tomllib.load(fh)
    try:
        ident = data["identity"]
        project = Project(
            root=root,
            name=ident["name"],
            app_name=ident["app_name"],
            vendor=ident["vendor"],
            bundle_id=ident["bundle_id"],
            homepage=ident["homepage"],
            display_version=data["version"]["display"],
            firefox_version=data["upstream"]["firefox"],
            upstream_repo=data["upstream"]["repo"],
            channel=data["upstream"].get("channel", "release"),
            patch_budget=int(data["policy"]["patch_budget"]),
            security_sla_hours=int(data["policy"]["security_sla_hours"]),
            update_repo=data.get("updates", {}).get("github_repo", ""),
        )
    except KeyError as exc:
        raise ConfigError(f"project.toml is missing {exc}") from None

    if not APP_NAME_RE.match(project.app_name):
        raise ConfigError("identity.app_name must be lowercase letters, digits or '-', 2-31 chars")
    if not re.match(r"^[a-z0-9-]+(\.[a-z0-9-]+)+$", project.bundle_id):
        raise ConfigError("identity.bundle_id must be reverse-DNS, e.g. app.example.browser")
    if not re.match(r"^[A-Za-z][A-Za-z0-9]{1,30}$", project.name):
        raise ConfigError("identity.name must be letters/digits only (it becomes the profile folder name)")
    if project.update_repo and not re.match(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", project.update_repo):
        raise ConfigError("updates.github_repo must look like owner/repo")
    if project.channel != "release":
        raise ConfigError("upstream.channel must be 'release'")
    firefox_tag(project.firefox_version)  # validates
    return project


def set_firefox_version(root: Path, version: str) -> None:
    """Rewrite upstream.firefox in project.toml, preserving comments and layout."""
    firefox_tag(version)
    path = root / "project.toml"
    text = path.read_text(encoding="utf-8")
    new, count = re.subn(
        r'(?m)^(firefox\s*=\s*")[^"]*(")', lambda m: f"{m.group(1)}{version}{m.group(2)}", text
    )
    if count != 1:
        raise ConfigError("Could not find a single upstream.firefox entry to update")
    path.write_text(new, encoding="utf-8", newline="\n")
