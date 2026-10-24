# Building

A first build compiles all of Firefox: plan for **1–3 hours** on a modern 8-core machine with
**16 GB RAM** and **~40 GB free disk**. Later builds are incremental (minutes).

## 1. Prerequisites

| OS | Install |
| --- | --- |
| Windows 10/11 | [MozillaBuild](https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe) and Visual Studio 2022 Build Tools with **Desktop development with C++** (includes the Windows SDK). Run every command from `C:\mozilla-build\start-shell.bat`. Keep the project on a short path such as `C:\dev\peryn`, and exclude it from Windows Defender real-time scanning for much faster builds. |
| macOS 14+ | Xcode Command Line Tools: `xcode-select --install`. Python 3.11+. |
| Linux | `git`, Python 3.11+, and your distro's basic build packages; `hx bootstrap` fetches the rest. |

Everything else (clang, Rust, Node, the macOS SDK, sccache) is installed by `hx bootstrap`.

The command bar's index is a small Rust crate built to WebAssembly before importing. It needs
Rust from [rustup.rs](https://rustup.rs) (separate from the toolchain `hx bootstrap` installs for
Firefox) and its WebAssembly target: `rustup target add wasm32-unknown-unknown`.

## 2. Build

```sh
./hx doctor                  # checks Python, git, disk, RAM
./hx download                # Firefox 158.0.1 source -> engine/
python3 tools/omni/build_wasm.py   # the command bar's index (Rust -> WebAssembly)
./hx import                  # apply our changes
./hx bootstrap               # one-time toolchain install
./hx build --profile dev     # fast optimised build, no LTO/PGO
./hx run                     # launch it
./hx package                 # installer/archive in engine/obj-*/dist/
```

## Build profiles

| Profile | Use | Notes |
| --- | --- | --- |
| `dev` | Everyday development | Optimised, no LTO/PGO. |
| `release` | Shipping | `--enable-release`, hardening, cross-language LTO, 3-stage PGO. 2–3× slower. |
| `artifact` | UI-only work (sidebar, Spaces, CSS/JS) | Downloads Mozilla's prebuilt binaries for this version: builds in minutes. Experimental with our app name; never ship it, and Rust/C++ changes are not included. |

## Changing Firefox code

See [PATCHES.md](PATCHES.md). In short: edit in `engine/`, `hx export <file>`, `hx import`.

## CI

| Workflow | When | Does |
| --- | --- | --- |
| `checks` | every push / PR | Toolchain tests on 3 OSes; applies our changes to the pinned Firefox and verifies prefs, build options and the patch budget. |
| `upstream` | twice daily | If Firefox released a new version: rebase, verify, open a PR (labelled `security-sla` for point releases). On conflict, open an issue. |
| `build` | manual (pick platforms), `v*` tags, weekly | Full builds with an sccache cache; uploads the Windows `*.installer.exe` + portable `.zip`, Linux `.tar.xz`, macOS `.dmg`. Then the **network audit** runs the Linux build and fails on undocumented connections. On a `v*` tag, a **release** job publishes a GitHub Release with the installers. `release`-profile builds need larger or self-hosted runners (`LINUX_RUNNER` / `MACOS_RUNNER` / `WINDOWS_RUNNER` repository variables). |

## Status of CI builds (Oct 2026)

Builds resumed after C3. The first attempt's `mach bootstrap` stalled on CI runners for 25+
minutes, so CI no longer runs it: configure fetches the toolchains it needs itself
(`--enable-bootstrap`). Windows builds put the object directory on whichever runner drive has
the most free space and skip debug symbols. A manual run of **build** with *publish* on puts the
Windows installer on the `test-build` pre-release (Releases page), replaced on each run.

Failures surface as annotations on the run: the first compiler errors (a parallel build's real
error scrolls far above the end of the log) and the last 80 lines.

## Releasing a version

1. Bump `version.display` in `project.toml` (e.g. `0.2.0`) and commit.
2. `git tag v0.2.0 && git push origin v0.2.0`
3. The `build` workflow builds, audits and publishes the release. Running copies of the browser
   notice it within a day and show a notification bar.

## Running the network audit locally

```sh
python3 tools/audit/network_audit.py --browser engine/obj-*/dist/bin/peryn --seconds 120
```
