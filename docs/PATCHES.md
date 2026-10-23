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

## Budget log

| Date | Budget | Reason |
| --- | --- | --- |
| 2026-10-23 | 60 | Initial budget. |
