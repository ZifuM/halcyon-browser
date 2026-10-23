# Halcyon

> Working name. The browser's name lives in one place, `project.toml`; renaming is a one-line edit.

A fast, beautiful, private browser built on Firefox's Gecko engine, with an Arc-style layout,
built-in ad and tracker blocking, and zero telemetry.

**This is the user's browser, not ours.** Nothing runs, downloads or connects unless the user chose
it. See [docs/OWNERSHIP.md](docs/OWNERSHIP.md) for the eight release-blocking promises.

## Status

Phase 1 (Foundation). **C0 build pipeline** and **C1 privacy baseline** done. **C2 Shield**
(ad and tracker blocking) done, verified against the real engine and lists. Builds are paused
until after C3 (the Arc-style sidebar and layout), which is next.

| Area | State |
| --- | --- |
| `hx` toolchain | download Firefox, apply our changes, export edits, rebase, build, package |
| Upstream base | Firefox **158.0.1** Release |
| Privacy defaults | 94 prefs, every one verified against the Firefox source (or our own code) |
| Shield | uBlock Origin's default lists in Firefox's in-tree adblock-rust engine: network blocking and element hiding, ~11 µs per request. See [docs/SHIELD.md](docs/SHIELD.md) |
| Performance budgets | checked in CI: [docs/PERFORMANCE.md](docs/PERFORMANCE.md) |
| Compiled out | telemetry upload, Normandy experiments, crash reporter, Mozilla updater, Windows default-browser agent |
| Every-request registry | `privacy/requests.toml` → [docs/EVERY-REQUEST.md](docs/EVERY-REQUEST.md) |
| Network audit | CI launches the built browser and fails on any undocumented connection |
| Updates | notification-only update check against GitHub Releases; never auto-installs |
| Windows installer | `hx package` on Windows → `*.installer.exe` (built by the `build` workflow) |
| Patches to Firefox | 7 of a 60-file budget ([docs/PATCHES.md](docs/PATCHES.md)) |
| CI | tests on 3 OSes, upstream checks, Shield corpus and budgets, twice-daily rebase bot; 3-OS builds, network audit and releases (paused until after C3) |

Next: C3, the Arc-style sidebar, Essentials, top bar and compact mode.

## Get the browser

Builds are paused until after C3, so there is no installer yet. Once they resume: download the
Windows installer from the latest successful **build** run (Actions tab →
build → `windows-installer-dev`), or from **Releases** once a version is tagged. The build is not
code-signed yet, so Windows SmartScreen will warn: choose *More info → Run anyway*.

## Quick start

```sh
./hx doctor          # can this machine build? (16 GB RAM, ~40 GB disk recommended)
./hx download        # Firefox source -> engine/   (~3 GB, shallow)
./hx import          # apply src/, branding, prefs, patches
./hx bootstrap       # Mozilla's toolchains (clang, rust, ...), once
./hx build --profile dev
./hx run
```

On Windows use `hx.cmd` from the MozillaBuild shell. Full guide: [docs/BUILDING.md](docs/BUILDING.md).

## Layout

| Path | What lives there |
| --- | --- |
| `project.toml` | Name, ids, Firefox version, patch budget — the single source of truth |
| `prefs/*.toml` | Default preferences, each with a reason; compiled into the build, never locked |
| `patches/` | One patch per upstream Firefox file we change (`patches/<path>.patch`) |
| `src/` | New files added to the Firefox tree (no budget cost); `*.tmpl` files get project values filled in |
| `src/browser/components/halcyon/` | The browser's own components (update notifier now; sidebar, Spaces, Shield UI later) |
| `privacy/requests.toml` | Every connection the browser may make on its own; drives the public page and the audit |
| `crates/` | Rust: `shield-check` (Shield corpus and benchmarks against Firefox's engine); later the Omni index |
| `branding/overlay/` | Logo, icons and brand strings laid over Firefox's unofficial branding |
| `configs/` | mozconfig fragments: common + per-OS + per-profile (release / dev / artifact) |
| `tools/hx/` | The toolchain (Python 3.11+, standard library only) |
| `engine/` | Downloaded Firefox source (git-ignored) |

## Everyday commands

| Command | Does |
| --- | --- |
| `hx status` | List edits in `engine/` not yet saved as patches |
| `hx export <file>` / `--all` | Save `engine/` edits to `patches/` (or `src/` for new files) |
| `hx import` | Reset `engine/` to upstream and re-apply everything |
| `hx audit-prefs --strict` | Check every default pref still exists upstream |
| `hx check-mozconfig` | Check every build option still exists upstream |
| `hx check-upstream` | Is a newer Firefox out? |
| `hx rebase [--to X]` | Move to a newer Firefox and re-apply everything |
| `hx patches` | Patched files vs the budget |
| `hx requests [--write]` | List the every-request registry / regenerate its page |

## License

[MPL 2.0](LICENSE), like Firefox. Not affiliated with or endorsed by Mozilla; "Firefox" is a
Mozilla trademark and is not used in this product's branding.
