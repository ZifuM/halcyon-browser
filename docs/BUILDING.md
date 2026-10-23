# Building

A first build compiles all of Firefox: plan for **1–3 hours** on a modern 8-core machine with
**16 GB RAM** and **~40 GB free disk**. Later builds are incremental (minutes).

## 1. Prerequisites

| OS | Install |
| --- | --- |
| Windows 10/11 | [MozillaBuild](https://ftp.mozilla.org/pub/mozilla/libraries/win32/MozillaBuildSetup-Latest.exe) and Visual Studio 2022 Build Tools with **Desktop development with C++** (includes the Windows SDK). Run every command from `C:\mozilla-build\start-shell.bat`. Keep the project on a short path such as `C:\dev\halcyon`, and exclude it from Windows Defender real-time scanning for much faster builds. |
| macOS 14+ | Xcode Command Line Tools: `xcode-select --install`. Python 3.11+. |
| Linux | `git`, Python 3.11+, and your distro's basic build packages; `hx bootstrap` fetches the rest. |

Everything else (clang, Rust, Node, the macOS SDK, sccache) is installed by `hx bootstrap`.

## 2. Build

```sh
./hx doctor                  # checks Python, git, disk, RAM
./hx download                # Firefox 158.0.1 source -> engine/
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
| `build` | manual, `v*` tags, weekly | Full builds on Linux, macOS and Windows with an sccache cache; uploads installers. `release` builds need larger or self-hosted runners (set `LINUX_RUNNER` / `MACOS_RUNNER` / `WINDOWS_RUNNER` repository variables). |
