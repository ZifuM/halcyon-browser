# The ownership promise

**This is the user's browser, not ours.** The browser never treats the user's device as its own.
These eight rules are release-blocking: a release that breaks one does not ship.

1. **No nagging.** No pop-ups asking to become the default browser, sign in, rate us or try a
   feature. Asked once at onboarding, then never again.
2. **Updates never change your choices.** A setting the user turned off stays off; nothing is
   re-enabled, reset or "reintroduced" by an update.
3. **No forced accounts.** Every feature except Sync works fully without signing in to anything.
4. **No ads or promotions in the browser.** No sponsored tiles, recommended content, upsells or
   partner offers anywhere in the UI.
5. **Off means gone.** Optional features (AI, Sync, crash reports) are off by default; turning one
   off removes it, its data and its network access.
6. **No dark patterns.** "No" is as easy to click as "Yes"; no pre-ticked boxes, guilt wording or
   hidden opt-outs.
7. **The user controls updates.** Users can see what an update changes before installing it and
   choose when to restart.
8. **Your data leaves with you.** One-click export of bookmarks, history, Spaces, passwords and
   settings in open formats.

## How the code enforces it today

| Promise | Mechanism | Where |
| --- | --- | --- |
| 2 | Our settings are *defaults* (`pref()`), never `lockPref` or user values, so a user's choice always wins and updates can't overwrite it. CI fails if a lock appears. | `tools/hx/prefs.py`, `.github/workflows/checks.yml` |
| 1, 4 | Default-browser nag, sponsored tiles and stories, Suggest, add-on recommendations, VPN/pin/Relay promos and "More from Mozilla" are off. | `prefs/20-no-ads-or-nagging.toml` |
| 5 | Telemetry upload compiled out; Normandy compiled out; studies, rollouts and crash reports off. | `configs/common.mozconfig`, `patches/browser/moz.configure.patch`, `prefs/10-no-telemetry.toml` |
| 5 | Every AI feature, local or cloud, off by default; the ML engine doesn't run or download models until the user enables AI in Settings > AI Controls. | `prefs/30-ai-off-by-default.toml` |
| 5 | No background connections the user didn't ask for. | `prefs/50-quiet-network.toml`, [EVERY-REQUEST.md](EVERY-REQUEST.md) |

Still to build: onboarding (ask-once default browser), update preview and restart control (C1),
one-click export (C10), and a CI network audit that fails on any undocumented connection (C1).
