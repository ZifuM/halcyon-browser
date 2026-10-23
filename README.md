# Halcyon

> Working name. The browser's name lives in one place, `project.toml`; renaming is a one-line edit.

A fast, beautiful, private browser built on Firefox's Gecko engine, with an Arc-style layout,
built-in ad and tracker blocking, and zero telemetry.

**This is the user's browser, not ours.** Nothing runs, downloads or connects unless the user chose
it. See [docs/OWNERSHIP.md](docs/OWNERSHIP.md) for the eight release-blocking promises.

## Status

Phase 1 (Foundation), cycle **C0: build pipeline** — in progress.

| Done in C0 | |
| --- | --- |
| `hx` toolchain | download Firefox, apply our changes, export edits, rebase, build |
| Upstream base | Firefox **158.0.1** Release, verified |
| Privacy baseline (head start on C1) | 86 default prefs, every one verified against the Firefox source |
| Normandy (remote experiments) | compiled out — our first patch (1 of a 60-file budget) |
| Branding | placeholder name and logo, generated from `project.toml` |
| CI | unit tests on 3 OSes, upstream compatibility checks, 3-OS builds, twice-daily rebase bot |

Next: C1 privacy baseline (own update server, network audit in CI, every-request page), then C2
Shield ad blocker on adblock-rust.

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
| `src/` | New files added to the Firefox tree (no budget cost) |
| `crates/` | Our Rust components (Shield engine, Omni index, ...) from cycle C2 |
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

## License

[MPL 2.0](LICENSE), like Firefox. Not affiliated with or endorsed by Mozilla; "Firefox" is a
Mozilla trademark and is not used in this product's branding.
