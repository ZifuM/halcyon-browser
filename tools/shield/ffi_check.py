#!/usr/bin/env python3
"""Type-check Shield's element-hiding FFI (our addition to content_classifier_engine/src/lib.rs)
without a full Firefox build.

The real crate needs Gecko's generated XPCOM bindings, so it can't be checked on its own. The
functions we add only touch etp_engine, nsstring and thin-vec, which build standalone, so this
copies the "Halcyon Shield" section of the patched lib.rs into a scratch crate next to a tiny
stand-in for nserror and runs `cargo check` against Firefox's vendored crates (offline).

    python3 tools/shield/ffi_check.py [--engine engine] [--work DIR]

Needs `hx import` first (so the patch is applied) and /xpcom/rust/nsstring/ in the checkout.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LIB_RS = "toolkit/components/content-classifier/content_classifier_engine/src/lib.rs"
START = "// Halcyon Shield: element hiding."
END = "struct SchemelessSiteResolver {}"

PRELUDE = """#![allow(dead_code)]
// Stand-ins for the bits of the real crate the Halcyon section uses.
mod nserror {
    #[repr(transparent)]
    #[allow(non_camel_case_types)]
    #[derive(Clone, Copy)]
    pub struct nsresult(pub u32);
    pub const NS_OK: nsresult = nsresult(0);
    pub const NS_ERROR_INVALID_ARG: nsresult = nsresult(0x80070057);
}
use etp_engine::Engine;
use nserror::{nsresult, NS_ERROR_INVALID_ARG, NS_OK};
use nsstring::{nsACString, nsCString};
use thin_vec::ThinVec;
pub struct ContentClassifierFFIEngine {
    engine: Engine,
}

"""


def patch_table(engine: Path) -> str:
    """Firefox's [patch.crates-io] table, already mirrored into the shield-check manifest."""
    manifest = (ROOT / "crates/shield-check/Cargo.toml").read_text()
    table = manifest[manifest.index("\n[patch.crates-io]\n") + 1:]
    return table.replace('"../../engine/', f'"{engine.as_posix()}/')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--engine", default=str(ROOT / "engine"))
    ap.add_argument("--work", help="scratch directory (default: a temporary one)")
    args = ap.parse_args()
    engine = Path(args.engine).resolve()

    lib = (engine / LIB_RS).read_text()
    if START not in lib or END not in lib:
        print(f"error: the Halcyon section isn't in {LIB_RS} (run `hx import` first)", file=sys.stderr)
        return 2
    if not (engine / "xpcom/rust/nsstring/Cargo.toml").exists():
        print("error: xpcom/rust/nsstring is missing from the checkout", file=sys.stderr)
        return 2
    section = lib[lib.index(START):lib.index(END)]

    work = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix="shield-ffi-"))
    if work.exists():
        shutil.rmtree(work)
    (work / "src").mkdir(parents=True)
    (work / ".cargo").mkdir()
    (work / ".cargo/config.toml").write_text(
        "[source.crates-io]\nreplace-with = \"vendored\"\n"
        f"[source.vendored]\ndirectory = \"{(engine / 'third_party/rust').as_posix()}\"\n"
        "[net]\noffline = true\n",
        newline="\n",
    )
    etp = (engine / "toolkit/components/content-classifier/etp_engine").as_posix()
    nsstring = (engine / "xpcom/rust/nsstring").as_posix()
    (work / "Cargo.toml").write_text(
        "[package]\nname = \"shield-ffi-check\"\nversion = \"0.0.0\"\nedition = \"2021\"\n"
        "publish = false\n\n[lib]\npath = \"src/lib.rs\"\n\n[dependencies]\n"
        f"etp_engine = {{ path = \"{etp}\", default-features = false, "
        "features = [\"full-regex-handling\", \"single-thread\"] }\n"
        f"nsstring = {{ path = \"{nsstring}\" }}\n"
        "thin-vec = { version = \"0.2.1\", features = [\"gecko-ffi\"] }\n\n[workspace]\n\n"
        + patch_table(engine),
        newline="\n",
    )
    (work / "src/lib.rs").write_text(PRELUDE + section, newline="\n")

    result = subprocess.run(["cargo", "check", "--quiet"], cwd=work)
    if result.returncode == 0:
        print(f"ok  Shield FFI type-checks against etp_engine, nsstring and thin-vec ({work})")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
