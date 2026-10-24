"""The engine tree: download Firefox source, apply our changes on top, export edits back.

Layout of our changes (applied in this order by `import`):
  src/**              new files copied into the engine. A src/ file may NOT replace an upstream
                      file; changes to upstream files must be patches (that's what the budget counts).
  branding            browser/branding/unofficial is copied to browser/branding/<app_name>, then
                      branding/overlay/** is laid over it ({{TOKENS}} rendered in text files),
                      then prefs/*.toml are compiled onto its pref file.
  patches/**.patch    one patch per upstream file, at patches/<path-in-engine>.patch.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from . import prefs as prefs_mod
from .config import Project
from .util import HxError, git, info, is_text, ok, rel_files, render, rmtree, warn

STATE_DIR = ".hx"
EXCLUDES = ("/.hx/", "/obj-*/", "/mozconfig", "/.mozconfig*", "*.rej", "*.orig")
UPSTREAM_BRANDING = "browser/branding/unofficial"
BRANDING_PREF_FILE = "pref/firefox-branding.js"
TMPL = ".tmpl"


def _tmpl_target(rel: Path) -> Path:
    return rel.with_name(rel.name[: -len(TMPL)]) if rel.name.endswith(TMPL) else rel


# ---- state ----------------------------------------------------------------

def _state_path(engine: Path) -> Path:
    return engine / STATE_DIR / "state.json"


def read_state(engine: Path) -> dict:
    p = _state_path(engine)
    if not p.is_file():
        raise HxError("No engine yet. Run `hx download` first.")
    return json.loads(p.read_text(encoding="utf-8"))


def write_state(engine: Path, state: dict) -> None:
    p = _state_path(engine)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8", newline="\n")


# ---- download ---------------------------------------------------------------

def download(project: Project, sparse: list[str] | None = None, force: bool = False,
             repo: str | None = None, also_fetch: list[str] | None = None) -> None:
    """Shallow-clone the upstream release tag into engine/.

    also_fetch: extra tags (e.g. the previous release during a rebase) fetched shallowly so that
    `git apply --3way` can find our patches' original base files and produce conflict markers.
    """
    engine = project.engine
    tag = project.upstream_tag
    if engine.exists():
        try:
            state = read_state(engine)
        except HxError:
            state = {}
        if state.get("firefox") == project.firefox_version and not force:
            ok(f"Engine already at Firefox {project.firefox_version}")
            return
        if not force:
            raise HxError(
                f"engine/ holds Firefox {state.get('firefox', '?')}, project wants "
                f"{project.firefox_version}. Re-run with --force to replace it."
            )
        info("Removing old engine/")
        rmtree(engine)

    source = repo or project.upstream_repo
    info(f"Fetching {tag} from {source} (shallow{', sparse' if sparse else ''})")
    # Firefox needs LF line endings; never let a machine's core.autocrlf (default on Windows) apply.
    args = ["clone", "--quiet", "--depth", "1", "--branch", tag, "-c", "advice.detachedHead=false",
            "-c", "core.autocrlf=false", "-c", "core.longpaths=true"]
    if sparse:
        args += ["--filter=blob:none", "--sparse"]
    args += [source, str(engine)]
    git(project.root, *args)
    if sparse:
        git(engine, "sparse-checkout", "set", "--no-cone", *sparse)
    for extra in also_fetch or []:
        info(f"Fetching {extra} too (for three-way merges)")
        git(engine, "fetch", "--quiet", "--depth", "1", "origin", f"refs/tags/{extra}:refs/tags/{extra}")

    exclude = engine / ".git" / "info" / "exclude"
    exclude.parent.mkdir(parents=True, exist_ok=True)
    with open(exclude, "a", encoding="utf-8", newline="\n") as fh:
        fh.write("\n# hx\n" + "\n".join(EXCLUDES) + "\n")

    base = git(engine, "rev-parse", "HEAD").strip()
    write_state(engine, {"firefox": project.firefox_version, "tag": tag, "base": base,
                         "sparse": bool(sparse), "import_commit": None})
    ok(f"Engine ready at Firefox {project.firefox_version} ({base[:12]})")


# ---- import -----------------------------------------------------------------

@dataclass
class ImportReport:
    src_files: int = 0
    branding_files: int = 0
    prefs: int = 0
    patches_applied: list[str] = field(default_factory=list)
    patches_failed: list[tuple[str, str]] = field(default_factory=list)


def _dirty(engine: Path) -> list[str]:
    out = git(engine, "status", "--porcelain", "--untracked-files=all")
    return [line[3:] for line in out.splitlines() if line.strip()]


def _exists_in_commit(engine: Path, commit: str, rel: str) -> bool:
    out = git(engine, "ls-tree", "--name-only", commit, "--", rel, check=False)
    return out.strip() == rel


def patch_files(project: Project) -> list[Path]:
    return sorted(project.patches_dir.rglob("*.patch")) if project.patches_dir.is_dir() else []


def patch_target(project: Project, patch: Path) -> str:
    rel = patch.relative_to(project.patches_dir).as_posix()
    return rel[: -len(".patch")]


def _check_patch_header(patch: Path, target: str) -> None:
    text = patch.read_text(encoding="utf-8", errors="replace")
    files = {line[6:].strip() for line in text.splitlines() if line.startswith("+++ b/")}
    files |= {line[6:].strip() for line in text.splitlines() if line.startswith("--- a/")}
    if files != {target}:
        raise HxError(f"{patch.name}: must change exactly {target} (found {sorted(files) or 'nothing'})")


def import_changes(project: Project, force: bool = False, allow_over_budget: bool = False) -> ImportReport:
    engine = project.engine
    state = read_state(engine)
    base = state["base"]
    if state["firefox"] != project.firefox_version:
        raise HxError(f"engine/ is Firefox {state['firefox']} but project.toml says "
                      f"{project.firefox_version}. Run `hx download --force`.")

    # Validate everything we can BEFORE touching the tree, so a refusal leaves engine/ as it was.
    patches = patch_files(project)
    if len(patches) > project.patch_budget and not allow_over_budget:
        raise HxError(f"{len(patches)} patched upstream files exceeds the budget of "
                      f"{project.patch_budget} (project.toml [policy]). See docs/PATCHES.md.")
    for patch in patches:
        _check_patch_header(patch, patch_target(project, patch))
    prefs_mod.load_groups(project.prefs_dir)  # raises on invalid pref files
    _check_src_listings(project.src_dir, auto_build=True)

    # A previous import that stopped on a conflict leaves generated files uncommitted on purpose
    # (so conflicts can be resolved in place); those are not user edits.
    if state.get("import_commit") and not state.get("import_incomplete") and not force:
        dirty = _dirty(engine)
        if dirty:
            listing = "\n  ".join(dirty[:20])
            raise HxError("engine/ has edits that are not exported yet:\n  " + listing +
                          "\nRun `hx export <file>...` (or `hx export --all`) first, or `hx import --force` to discard them.")

    info(f"Resetting engine to Firefox {project.firefox_version}")
    git(engine, "reset", "--quiet", "--hard", base)
    git(engine, "clean", "-fdq")
    state["import_incomplete"] = True
    write_state(engine, state)

    report = ImportReport()

    # 1. src/ overlay: new files only. `name.ext.tmpl` is rendered with {{TOKENS}} to `name.ext`.
    tokens = project.tokens()
    for rel in rel_files(project.src_dir):
        out_rel = _tmpl_target(rel)
        rel_posix = PurePosixPath(out_rel.as_posix())
        if _exists_in_commit(engine, base, str(rel_posix)):
            raise HxError(f"src/{rel_posix} would replace an upstream file. Edit it in engine/ and "
                          f"`hx export` it as a patch instead.")
        dest = engine / out_rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if rel.name.endswith(TMPL):
            text = (project.src_dir / rel).read_text(encoding="utf-8")
            dest.write_text(render(text, tokens, f"src/{rel.as_posix()}"), encoding="utf-8", newline="\n")
        else:
            shutil.copy2(project.src_dir / rel, dest)
        report.src_files += 1

    # 2. branding
    report.branding_files, report.prefs = _apply_branding(project, base)

    # 3. patches (one per upstream file; a failure doesn't stop the others, so all conflicts show at once)
    for patch in patches:
        target = patch_target(project, patch)
        git(engine, "apply", "--3way", "--whitespace=nowarn", str(patch.resolve()), check=False)
        if _apply_ok(engine, target):
            report.patches_applied.append(target)
            continue
        if not _has_markers(engine / target):
            # No base blob for a 3-way merge: apply what fits, leave the rest in <file>.rej.
            git(engine, "apply", "--reject", "--whitespace=nowarn", str(patch.resolve()), check=False)
        report.patches_failed.append((target, _conflict_hint(engine, target)))

    if report.patches_failed:
        names = "\n  ".join(f"{t}  ({hint})" for t, hint in report.patches_failed)
        raise HxError(f"{len(report.patches_failed)} patch(es) did not apply cleanly:\n  {names}\n"
                      "Fix each file in engine/ (delete any .rej once handled), then `hx export` it "
                      "and run `hx import` again.")

    git(engine, "add", "-A", "--sparse")
    git(engine, "commit", "--quiet", "--allow-empty", "-m",
        f"hx import: {project.name} on Firefox {project.firefox_version}")
    state["import_commit"] = git(engine, "rev-parse", "HEAD").strip()
    state["import_incomplete"] = False
    write_state(engine, state)
    return report


_LISTED_RE = re.compile(r"MOZ_SRC_FILES\s*\+=\s*\[(.*?)\]", re.S)

# Files our moz.build files list but that are built before import rather than checked in:
# name -> (script under the project root, hint).
_BUILT_BEFORE_IMPORT = {
    "omni_index.wasm": ("tools/omni/build_wasm.py",
                        "python3 tools/omni/build_wasm.py (needs Rust from rustup.rs)"),
}


def _build_missing(src_dir: Path, auto_build: bool) -> None:
    """Build what's built before import (the command bar's WebAssembly) if it's missing."""
    if not auto_build:
        return
    root = src_dir.parent
    for build in sorted(src_dir.rglob("moz.build")):
        for block in _LISTED_RE.findall(build.read_text(encoding="utf-8")):
            for name in re.findall(r'"([^"]+)"', block):
                if name in _BUILT_BEFORE_IMPORT and not (build.parent / name).exists():
                    script = root / _BUILT_BEFORE_IMPORT[name][0]
                    info(f"Building {name} ({script.relative_to(root).as_posix()})")
                    subprocess.run([sys.executable, str(script)], cwd=root, check=False)


def _check_src_listings(src_dir: Path, auto_build: bool = False) -> None:
    """Every file a src/ moz.build lists must exist, or the build fails hours later."""
    _build_missing(src_dir, auto_build)
    missing = []
    for build in sorted(src_dir.rglob("moz.build")):
        for block in _LISTED_RE.findall(build.read_text(encoding="utf-8")):
            for name in re.findall(r'"([^"]+)"', block):
                target = build.parent / name
                if not target.exists() and not (build.parent / (name + TMPL)).exists():
                    missing.append((build.parent.relative_to(src_dir) / name, name))
    if missing:
        lines = []
        for rel, name in missing:
            how = _BUILT_BEFORE_IMPORT.get(name)
            lines.append(f"src/{rel.as_posix()}" + (f"  (build it: {how[1]})" if how else ""))
        raise HxError("Files listed in moz.build are missing:\n  " + "\n  ".join(lines))


def _has_markers(path: Path) -> bool:
    if not path.is_file():
        return False
    text = "\n" + path.read_text(encoding="utf-8", errors="replace")
    return "\n<<<<<<< " in text and "\n>>>>>>> " in text


def _conflict_hint(engine: Path, target: str) -> str:
    if _has_markers(engine / target):
        return "conflict markers in file"
    if (engine / f"{target}.rej").is_file():
        return f"rejected hunks in {target}.rej"
    return "patch could not be applied"


def _apply_ok(engine: Path, target: str) -> bool:
    """A patch applied cleanly if its target has no unmerged entries / conflict markers."""
    unmerged = git(engine, "diff", "--name-only", "--diff-filter=U", check=False).split()
    if target in unmerged:
        return False
    if _has_markers(engine / target):
        return False
    # Changed vs base? (a patch that silently did nothing is a failure too)
    changed = git(engine, "status", "--porcelain", "--", target).strip()
    return bool(changed)


def _apply_branding(project: Project, base: str) -> tuple[int, int]:
    engine = project.engine
    upstream = engine / UPSTREAM_BRANDING
    dest = engine / project.branding_engine_rel
    if not upstream.is_dir():
        raise HxError(f"{UPSTREAM_BRANDING} not found in engine (sparse checkout missing it?)")
    if _exists_in_commit(engine, base, project.branding_engine_rel):
        raise HxError(f"{project.branding_engine_rel} already exists upstream; pick another app_name")
    shutil.copytree(upstream, dest)

    tokens = project.tokens()
    overlay = project.branding_dir / "overlay"
    count = 0
    for rel in rel_files(overlay):
        src = overlay / rel
        out = dest / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if is_text(src):
            out.write_text(render(src.read_text(encoding="utf-8"), tokens, str(src)), encoding="utf-8",
                           newline="\n")
        else:
            shutil.copy2(src, out)
        count += 1

    groups = prefs_mod.load_groups(project.prefs_dir)
    pref_file = dest / BRANDING_PREF_FILE
    existing = pref_file.read_text(encoding="utf-8") if pref_file.is_file() else ""
    pref_file.parent.mkdir(parents=True, exist_ok=True)
    pref_file.write_text(existing.rstrip("\n") + "\n" + prefs_mod.compile_js(groups, project.name),
                         encoding="utf-8", newline="\n")
    return count, sum(len(g.prefs) for g in groups)


# ---- export / status -----------------------------------------------------------

def status(project: Project) -> list[str]:
    read_state(project.engine)
    return _dirty(project.engine)


def export(project: Project, paths: list[str], all_dirty: bool = False) -> list[str]:
    engine = project.engine
    state = read_state(engine)
    base = state["base"]
    if not state.get("import_commit") and not state.get("import_incomplete"):
        raise HxError("Run `hx import` before exporting.")
    targets = list(paths)
    if all_dirty:
        targets += _dirty(engine)
    if not targets:
        raise HxError("Nothing to export. Name files (relative to engine/) or pass --all.")

    written: list[str] = []
    for raw in dict.fromkeys(targets):
        rel = PurePosixPath(Path(raw).as_posix().removeprefix("engine/")).as_posix()
        if rel.startswith(project.branding_engine_rel + "/"):
            raise HxError(f"{rel} is generated branding. Edit branding/overlay/ or prefs/ instead.")
        if _exists_in_commit(engine, base, rel):
            diff = git(engine, "diff", "--no-color", "--full-index", base, "--", rel)
            patch = project.patches_dir / f"{rel}.patch"
            if diff.strip():
                patch.parent.mkdir(parents=True, exist_ok=True)
                patch.write_text(diff, encoding="utf-8", newline="\n")
                written.append(f"patches/{rel}.patch")
            elif patch.exists():
                patch.unlink()
                written.append(f"(removed) patches/{rel}.patch")
        else:
            if (project.src_dir / f"{rel}{TMPL}").is_file():
                raise HxError(f"{rel} is generated from src/{rel}{TMPL}. Edit the template instead.")
            src_path = engine / rel
            dest = project.src_dir / rel
            if src_path.is_file():
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src_path, dest)
                written.append(f"src/{rel}")
            elif dest.exists():
                dest.unlink()
                written.append(f"(removed) src/{rel}")
        git(engine, "add", "-A", "--sparse", "--", rel)

    if git(engine, "diff", "--cached", "--name-only").strip():
        git(engine, "commit", "--quiet", "-m", "hx export")
        if not state.get("import_incomplete"):
            state["import_commit"] = git(engine, "rev-parse", "HEAD").strip()
            write_state(engine, state)
    if len(patch_files(project)) > project.patch_budget:
        warn(f"Patch budget exceeded: {len(patch_files(project))}/{project.patch_budget}")
    return written
