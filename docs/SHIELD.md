# Shield: the built-in ad and tracker blocker

Shield blocks ads, trackers and malware sites with the same filter lists uBlock Origin uses by
default. It is built into the browser, on for everyone, and costs no add-on.

## How it works

Firefox already ships an adblock engine: its *content classifier*
(`toolkit/components/content-classifier`) runs `etp_engine`, Mozilla's in-tree fork of Brave's
`adblock-rust`. Mozilla uses it for its own tracker lists. Shield adds a feature named `shield`
to it and supplies the lists, so blocking runs in Rust, off the main thread, in the same place
Firefox's own tracking protection does.

| Part | Where | What it does |
| --- | --- | --- |
| List manager | `src/.../shield/ShieldLists.sys.mjs` | Downloads the lists, preprocesses them (`!#if`, `!#include`, hosts format), caches them in the profile, re-downloads when each list's own expiry passes. |
| List catalog | `src/.../shield/ShieldListLogic.sys.mjs` | Which lists exist, which are on by default, and the preprocessing logic. |
| Network blocking | patches to `ContentClassifierService.cpp` and `ContentClassifierRemoteSettingsClient.sys.mjs` | Registers the `shield` feature; the engine asks our list manager for `shield-*` lists. |
| Element hiding | `src/.../shield/ShieldCosmetic*.sys.mjs` plus patches to the engine's FFI, wrapper, service and IDL | Hides ad containers and the blank boxes blocked ads leave behind. |
| Per-site off switch | Firefox's shield icon in the address bar | Turning protection off for a site turns off both blocking and element hiding there. |

### Element hiding

The engine already parses the cosmetic (`##`) rules in every list; our patches expose its two
lookups. For each page and frame:

1. When the document starts, the `PerynShieldCosmetic` actor asks for the site's resources
   (site-specific rules plus generic rules that aren't simple classes or ids) and loads them as a
   user-level `!important` stylesheet, so the page's own CSS can't un-hide anything.
2. Once the page is parsed, and as it changes, the actor sends the classes and ids it hasn't
   seen yet and gets back a stylesheet of the generic rules that match them. Pages with a
   `$generichide` exception (sign-in pages, ad dashboards) skip this step.

Selectors are grouped inside `:is()`, whose forgiving parsing drops a single invalid selector
instead of the whole group. Anything that could break out of a rule (`{`, `}`, comments) is
discarded.

## Default lists

| List | Default |
| --- | --- |
| uBlock filters, Badware risks, Privacy, Quick fixes, Unbreak | on |
| EasyList, EasyPrivacy, Peter Lowe's | on |
| EasyList Cookie, uBlock Cookie Notices | on (C7): cookie consent pop-ups are hidden and the scripts that show them blocked, so a site never gets a "yes" |
| EasyList Newsletter pop-ups, Notification prompts | on (C7): "subscribe" overlays and "allow notifications?" nags |
| EasyList Chat widgets, Social widgets | off: some people use them |

Why lists and not a "Reject" click: Firefox 158 removed its own cookie-banner handling (the
`cookiebanners.*` prefs are gone), so there's no built-in auto-reject to turn on. Hiding the
banner and blocking its script leaves the site without consent, which under the GDPR means no.
A rule engine that clicks "Reject" for the big consent platforms is a possible follow-up.

Lists come from `ublockorigin.github.io` (the uAssets gh-pages branch, where third-party lists
sit directly in `thirdparties/`), with `cdn.jsdelivr.net` (the master branch, where they're in
subfolders) as a mirror; Peter Lowe's list is only on the mirror. Requests carry no
cookies or referrer, and ETags mean unchanged lists aren't downloaded again. See
[EVERY-REQUEST.md](EVERY-REQUEST.md).

## Settings (about:config, until the Shield panel exists)

| Pref | Default | Effect |
| --- | --- | --- |
| `privacy.trackingprotection.content.protection.enabled` | true | Shield on or off |
| `peryn.shield.cosmetic.enabled` | true | Element hiding (false: block requests only) |
| `peryn.shield.updates.enabled` | true | List downloads (false: keep the last lists) |
| `peryn.shield.list.<id>.enabled` | see above | One list on or off |

## How it is tested

* `crates/shield-check` runs the real default lists through the real engine, with the same calls
  the browser makes, against `corpus.toml`: requests that must be blocked, requests that must
  keep working (sign-in, payments, video, CDNs), and pages whose elements must or must not be
  hidden. CI fails on any miss and on the performance budgets in [PERFORMANCE.md](PERFORMANCE.md).
* `tools/shield/ffi_check.py` type-checks our element-hiding FFI against the Firefox version we
  build on, on every CI run.
* `tests/js/test_shield.test.mjs` and `test_cosmetic.test.mjs` cover the list manager and the
  element-hiding actors with mocked Firefox APIs; `tests/test_shield_sync.py` checks the names
  that cross the patched files still agree.

## Not done yet

| Gap | Effect | Plan |
| --- | --- | --- |
| Scriptlets (`##+js(...)`) | Ads that are injected by a site's own scripts, notably YouTube video ads, aren't blocked. | Needs a scriptlet library loaded into the engine as resources. Licensing (uBlock's is GPLv3) and how to update it are open; candidate for a later Shield cycle. |
| Procedural filters (`:has-text()`, `:upward()`, `:remove()` ...) | A few hundred site-specific rules are skipped. | The engine already returns them; needs a small in-page runtime. |
| First run | For the few seconds before the first list download finishes, nothing is blocked. | Ship a snapshot of the lists in the installer. |
| Shield panel | Lists and switches are only in about:config. | Part of the C3/C4 UI work (blocked counts, per-site switch, list picker). |
| End-to-end check | The actor, IDL and C++ glue are covered by unit tests and a type check, not yet checked on a running page. Installers up to the C5 test build didn't hide elements at all: Firefox 158 only creates an actor in web content processes when it's marked `safeForUntrustedWebProcess`, and ours wasn't (fixed in C6; a test now checks every web-page actor for it). Request blocking was unaffected. | Check on the first C6 installer. |
