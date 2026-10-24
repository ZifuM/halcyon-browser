# Performance budgets

Speed is a release gate, not a hope. Each budget below is checked in CI; a change that goes
over fails the build. Budgets are set with headroom over the measured baseline so that noise on
shared CI machines doesn't cause false failures, and tightened as the baseline improves.

## Shield (checked by the `shield` job in `.github/workflows/checks.yml`)

Measured with the eight default lists, downloaded and assembled by the browser's own list code,
in Firefox's in-tree adblock engine.

| Metric | Baseline (Oct 2026) | Budget |
| --- | --- | --- |
| Rule lines loaded | 177,925 | none |
| Engine build time | 0.26 to 0.43 s | 2,000 ms |
| Engine size (serialized) | 9.1 MB | 32 MB |
| Network check, per request | 10 to 13 µs | 50 µs |
| Element hiding, per page (site lookup + generic class/id lookup) | about 100 µs | 1,000 µs |

Context: a typical news page makes 100 to 300 requests, so blocking adds roughly 1 to 4 ms of
matching spread over the whole load, off the main thread. Element hiding adds one lookup per
frame at document start and small follow-ups as the page changes.

The engine is built off the main thread whenever lists change, and the browser keeps using the
previous engine until the new one is ready.

## Command bar (checked by the `omni-index` job, and in Firefox by the `ui-preview` workflow)

Synthetic history with a realistic spread of words and sites, queried letter by letter as typed
("r", "ru", "rus", "rust", "rust ", "rust g", ...).

| Metric | Baseline (Oct 2026) | Budget |
| --- | --- | --- |
| Build the index, 100,000 entries (native) | about 90 ms | 600 ms |
| Per keystroke, 100,000 entries, p95 (native) | about 2.5 ms | 8 ms |
| Per keystroke, 100,000 entries, p95 (Firefox's WebAssembly) | measured by the preview | 16 ms (one frame) |
| `omni_index.wasm` size | 93 KB | 256 KB |

## Coming with the builds (after C3)

These need a running browser and are measured once builds resume:

| Metric | Target |
| --- | --- |
| Cold start to first window | no slower than the same Firefox release |
| Memory with Shield on, 10 tabs | within 10% of Firefox with Strict tracking protection |
| Page load (Speedometer, a fixed set of news sites) | no slower than Firefox; faster on ad-heavy sites |
