# Patch discipline

Firefox ships every two weeks. Every upstream file we change is a file that can conflict on every
rebase, so changes to Firefox's own files are budgeted.

## Rules

1. **New code goes in `src/`** (new modules, CSS, custom elements, Rust crates). It costs nothing
   and never conflicts. `hx import` refuses a `src/` file that would replace an upstream file.
2. **Changes to upstream files are patches**, one per file, at `patches/<path>.patch`, made with
   `hx export <path>`. Hook in at the fewest possible points; put the logic in `src/`.
3. **Reuse Firefox's plumbing** (sidebar, vertical tabs, split view, tab groups, containers):
   extend and restyle it rather than re-implementing it.
4. **Settings are prefs, not patches.** Defaults go in `prefs/*.toml` (zero patch cost).
5. **The budget** is `policy.patch_budget` in `project.toml` (currently 60). `hx import` fails over
   budget. Raising it needs a line in the log below saying why.

## Workflow

```sh
./hx import                      # clean engine/ with everything applied
# edit files in engine/ ...
./hx status                      # what changed
./hx export browser/foo/bar.js   # upstream file -> patches/browser/foo/bar.js.patch
./hx export --all                # or everything at once (new files go to src/)
./hx import                      # proves the result re-applies from scratch
```

Generated branding (`engine/browser/branding/<app_name>/`) is never exported: edit
`branding/overlay/` or `prefs/` instead.

## When a rebase conflicts

`hx rebase` fetches the previous Firefox release too, so git can produce normal conflict markers.
If it can't, clean hunks are applied and the rest are written to `<file>.rej`.

1. Fix each listed file in `engine/` (delete any `.rej` once handled).
2. `hx export <file>` for each.
3. `hx import` — must succeed from scratch.

The rebase bot (`.github/workflows/upstream.yml`) opens an issue with the log when this happens.

## Current patches

| File | Why |
| --- | --- |
| `browser/moz.configure` | Don't build-enable Normandy: the browser must not change behaviour from server instructions. |
| `browser/components/moz.build` | Adds `halcyon` to the component directories. All our own components live in `src/browser/components/halcyon/` behind this one-line hook. |
| `toolkit/components/content-classifier/ContentClassifierService.cpp` | Shield: registers the `shield` feature and its list ids in Firefox's content classifier (adblock-rust), and implements the two element-hiding methods below. |
| `toolkit/components/content-classifier/ContentClassifierRemoteSettingsClient.sys.mjs` | Shield: lists named `shield-*` are read from our list manager (uBlock Origin / EasyList lists) instead of Mozilla's Remote Settings. |
| `toolkit/components/content-classifier/nsIContentClassifierService.idl` | Shield element hiding: `getCosmeticResources` and `getHiddenClassIdSelectors`. |
| `toolkit/components/content-classifier/content_classifier_engine/ContentClassifierEngine.h` | Shield element hiding: engine wrapper methods for the two lookups. |
| `toolkit/components/content-classifier/content_classifier_engine/src/lib.rs` | Shield element hiding: exposes the engine's existing cosmetic-filter lookups over FFI. Type-checked in CI by `tools/shield/ffi_check.py`. |

The five content-classifier patches are one feature (Shield). They hook into code Mozilla is
actively developing, so they are the likeliest to conflict on a rebase; each one is small and
`tests/test_shield_sync.py` checks that the names across them still line up.

## Budget log

| Date | Budget | Reason |
| --- | --- | --- |
| 2026-10-23 | 60 | Initial budget. |
