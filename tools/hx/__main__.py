"""hx: the project's build toolchain. Run `./hx --help` (or `hx.cmd` on Windows)."""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import build, config, engine, prefs, upstream
from . import requests as req_registry
from .util import HxError, info, ok, warn

# Upstream paths needed for CI checks without a full 6 GB checkout.
CI_SPARSE_BASE = [
    "/browser/branding/unofficial/",
    "/browser/branding/branding-common.mozbuild",
    "/browser/moz.configure",
    "/toolkit/moz.configure",
    "/moz.configure",
    "/build/moz.configure/",
    "/js/moz.configure",
    # Shield: the in-tree adblock-rust engine and the vendored crates it builds against
    "/toolkit/components/content-classifier/",
    "/third_party/rust/",
    "/gfx/wr/wr_malloc_size_of/",
    "/Cargo.toml",            # Firefox's [patch.crates-io] table (tools/shield/sync_cargo_patches.py)
    "/build/rust/",           # the local crate shims that table points at
    "/xpcom/rust/nsstring/",  # for type-checking our element-hiding FFI (tools/shield/ffi_check.py)
]


def ci_sparse_paths(project: config.Project) -> list[str]:
    paths = list(CI_SPARSE_BASE)
    paths += ["/" + p for p in prefs.upstream_paths(prefs.load_groups(project.prefs_dir))]
    paths += ["/" + engine.patch_target(project, p) for p in engine.patch_files(project)]
    return sorted(set(paths))


def cmd_download(p, a):
    sparse = ci_sparse_paths(p) if a.sparse_ci else None
    engine.download(p, sparse=sparse, force=a.force, repo=a.repo)


def cmd_import(p, a):
    r = engine.import_changes(p, force=a.force, allow_over_budget=a.allow_over_budget)
    ok(f"Imported: {r.src_files} new files, {r.branding_files} branding files, {r.prefs} default prefs, "
       f"{len(r.patches_applied)} patches ({len(r.patches_applied)}/{p.patch_budget} budget)")


def cmd_export(p, a):
    for line in engine.export(p, a.paths, all_dirty=a.all):
        ok(line)


def cmd_status(p, a):
    dirty = engine.status(p)
    if not dirty:
        ok("No unexported changes in engine/")
    for f in dirty:
        print(f"  modified  {f}")


def cmd_patches(p, a):
    files = engine.patch_files(p)
    for f in files:
        print("  " + engine.patch_target(p, f))
    print(f"{len(files)}/{p.patch_budget} of the patch budget used")


def cmd_audit_prefs(p, a):
    groups = prefs.load_groups(p.prefs_dir)
    result = prefs.audit(groups, p.engine, p.src_dir)
    total = sum(len(g.prefs) for g in groups)
    for pref in result.unverified:
        hint = f" (looked in {pref.upstream})" if pref.upstream else ""
        warn(f"{pref.name}: not found upstream{hint}  [{pref.source_file}]")
    ok(f"{len(result.verified)}/{total} prefs verified against Firefox {p.firefox_version}")
    if a.strict and result.unverified:
        raise HxError(f"{len(result.unverified)} pref(s) could not be verified. Fix the name, or add "
                      "`upstream = \"<file that defines or reads it>\"`.")


def cmd_check_upstream(p, a):
    latest = upstream.latest_release(p.upstream_repo)
    status = upstream.UpstreamStatus(upstream.Version.parse(p.firefox_version), latest)
    payload = {"current": str(status.current), "latest": str(latest),
               "behind": status.behind, "kind": status.kind}
    if a.json:
        print(json.dumps(payload))
    else:
        msg = f"Firefox {status.latest} is out (we are on {status.current}, {status.kind} update)" \
            if status.behind else f"Up to date with Firefox {status.current}"
        (warn if status.behind else ok)(msg)
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if a.github_output and gh_out:
        with open(gh_out, "a", encoding="utf-8") as fh:
            for k, v in payload.items():
                fh.write(f"{k}={str(v).lower() if isinstance(v, bool) else v}\n")


def cmd_bump(p, a):
    config.set_firefox_version(p.root, a.to)
    ok(f"project.toml now targets Firefox {a.to}")


def cmd_rebase(p, a):
    target = a.to or str(upstream.latest_release(p.upstream_repo))
    if target == p.firefox_version and not a.force:
        ok(f"Already on Firefox {target}")
        return
    previous = p.firefox_version
    info(f"Rebasing {previous} -> {target}")
    config.set_firefox_version(p.root, target)
    p = config.load(p.root)
    sparse = ci_sparse_paths(p) if a.sparse_ci else None
    old_tag = config.firefox_tag(previous)
    engine.download(p, sparse=sparse, force=True, also_fetch=[old_tag])
    r = engine.import_changes(p, force=True)
    ok(f"Rebased onto Firefox {target}: {len(r.patches_applied)} patches applied cleanly")
    if sparse:
        result = prefs.audit(prefs.load_groups(p.prefs_dir), p.engine, p.src_dir)
        if result.unverified:
            raise HxError("Prefs missing upstream after rebase: " + ", ".join(x.name for x in result.unverified))


def cmd_mozconfig(p, a):
    if a.print:
        print(build.compose_mozconfig(p, a.os or build.host_os(), a.profile))
    else:
        build.write_mozconfig(p, a.os, a.profile)


def cmd_check_mozconfig(p, a):
    problems = build.validate_mozconfigs(p)
    for prob in problems:
        warn(prob)
    if problems:
        raise HxError(f"{len(problems)} mozconfig option(s) not declared by Firefox {p.firefox_version}")
    ok(f"All mozconfig options exist in Firefox {p.firefox_version} "
       f"({len(build.OS_CHOICES)} platforms x {len(build.PROFILE_CHOICES)} profiles)")


def cmd_requests(p, a):
    registry = req_registry.load(p.root / "privacy" / "requests.toml")
    outputs = {
        p.root / "docs" / "EVERY-REQUEST.md": req_registry.render_markdown(registry, p.name),
        p.root / "src/browser/components/peryn/privacy/PerynRequests.sys.mjs": req_registry.render_module(registry),
    }
    if a.write:
        for target, text in outputs.items():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8", newline="\n")
            ok(f"Wrote {target.relative_to(p.root)} ({len(registry)} entries)")
    elif a.check:
        for target, text in outputs.items():
            if not target.is_file() or target.read_text(encoding="utf-8") != text:
                raise HxError(f"{target.relative_to(p.root)} is out of date: run `hx requests --write`")
        ok("docs/EVERY-REQUEST.md and the Ledger's registry match privacy/requests.toml")
    else:
        for r in registry:
            print(f"  {r.state:3}  {r.trigger:10}  {r.id:22} {', '.join(r.hosts) or '-'}")


def cmd_doctor(p, a):
    problems = build.doctor(p)
    for prob in problems:
        warn(prob)
    if problems:
        raise HxError(f"{len(problems)} problem(s) to fix before building")
    ok("This machine looks ready to build")


def make_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="hx", description="Build toolchain for the browser.")
    sub = ap.add_subparsers(dest="cmd", required=True, metavar="command")

    s = sub.add_parser("download", help="fetch the Firefox source into engine/")
    s.add_argument("--force", action="store_true", help="replace an existing engine/")
    s.add_argument("--sparse-ci", action="store_true", help="only the files CI checks need")
    s.add_argument("--repo", help=argparse.SUPPRESS)
    s.set_defaults(fn=cmd_download)

    s = sub.add_parser("import", help="reset engine/ and apply src/, branding, prefs and patches")
    s.add_argument("--force", action="store_true", help="discard unexported edits in engine/")
    s.add_argument("--allow-over-budget", action="store_true")
    s.set_defaults(fn=cmd_import)

    s = sub.add_parser("export", help="save engine/ edits as patches (or src/ for new files)")
    s.add_argument("paths", nargs="*", help="paths relative to engine/")
    s.add_argument("--all", action="store_true", help="export every changed file")
    s.set_defaults(fn=cmd_export)

    sub.add_parser("status", help="list engine/ edits not yet exported").set_defaults(fn=cmd_status)
    sub.add_parser("patches", help="list patched upstream files vs budget").set_defaults(fn=cmd_patches)

    s = sub.add_parser("audit-prefs", help="check every default pref exists upstream")
    s.add_argument("--strict", action="store_true", help="fail on any unverified pref")
    s.set_defaults(fn=cmd_audit_prefs)

    s = sub.add_parser("check-upstream", help="is there a newer Firefox release?")
    s.add_argument("--json", action="store_true")
    s.add_argument("--github-output", action="store_true", help="also write to $GITHUB_OUTPUT")
    s.set_defaults(fn=cmd_check_upstream)

    s = sub.add_parser("bump", help="set the Firefox version in project.toml")
    s.add_argument("--to", required=True)
    s.set_defaults(fn=cmd_bump)

    s = sub.add_parser("rebase", help="move to a newer Firefox release and re-apply everything")
    s.add_argument("--to", help="version (default: latest release)")
    s.add_argument("--sparse-ci", action="store_true")
    s.add_argument("--force", action="store_true")
    s.set_defaults(fn=cmd_rebase)

    s = sub.add_parser("mozconfig", help="write (or --print) the mozconfig")
    s.add_argument("--os", choices=["linux", "macos", "windows"])
    s.add_argument("--profile", choices=["release", "dev", "artifact"], default="release")
    s.add_argument("--print", action="store_true")
    s.set_defaults(fn=cmd_mozconfig)

    s = sub.add_parser("requests", help="the every-request registry (list / --write page / --check)")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--write", action="store_true")
    g.add_argument("--check", action="store_true")
    s.set_defaults(fn=cmd_requests)
    sub.add_parser("check-mozconfig", help="verify build options exist upstream").set_defaults(
        fn=cmd_check_mozconfig)
    sub.add_parser("bootstrap", help="install Mozilla build toolchains").set_defaults(
        fn=lambda p, a: build.bootstrap(p))
    s = sub.add_parser("build", help="compile the browser")
    s.add_argument("--os", choices=["linux", "macos", "windows"])
    s.add_argument("--profile", choices=["release", "dev", "artifact"], default="release")
    s.set_defaults(fn=lambda p, a: build.build(p, a.os, a.profile))
    s = sub.add_parser("run", help="launch the built browser")
    s.add_argument("extra", nargs=argparse.REMAINDER)
    s.set_defaults(fn=lambda p, a: build.run_browser(p, a.extra))
    s = sub.add_parser("package", help="make an installable package (setup .exe on Windows)")
    s.add_argument("--os", choices=["linux", "macos", "windows"])
    s.set_defaults(fn=lambda p, a: build.package(p, a.os))
    sub.add_parser("doctor", help="check this machine can build").set_defaults(fn=cmd_doctor)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = make_parser().parse_args(argv)
    try:
        project = config.load()
        args.fn(project, args)
    except (HxError, config.ConfigError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
