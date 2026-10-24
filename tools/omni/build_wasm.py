#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Build crates/omni-index for WebAssembly and put omni_index.wasm next to OmniIndex.sys.mjs.

Needs the wasm32-unknown-unknown target (`rustup target add wasm32-unknown-unknown`). The
module is built from source on every build and never committed.
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CRATE = ROOT / "crates" / "omni-index"
TARGET = "wasm32-unknown-unknown"
BUILT = CRATE / "target" / TARGET / "release" / "omni_index.wasm"
DEST = ROOT / "src" / "browser" / "components" / "halcyon" / "commandbar" / "omni_index.wasm"
MAX_BYTES = 256 * 1024


def ensure_target() -> None:
    """Add the WebAssembly target if rustup is how Rust was installed (quick when present)."""
    if shutil.which("rustup"):
        subprocess.run(["rustup", "target", "add", TARGET], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dest", type=Path, default=DEST)
    args = parser.parse_args()
    ensure_target()
    subprocess.run(
        ["cargo", "build", "--release", "--lib", "--target", TARGET],
        cwd=CRATE,
        check=True,
    )
    size = BUILT.stat().st_size
    if size > MAX_BYTES:
        print(f"omni_index.wasm is {size} bytes, over the {MAX_BYTES} budget", file=sys.stderr)
        return 1
    args.dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(BUILT, args.dest)
    print(f"omni_index.wasm: {size} bytes -> {args.dest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
