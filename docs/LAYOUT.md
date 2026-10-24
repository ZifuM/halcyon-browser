# The Arc-style layout

Halcyon's window follows Arc's layout: tabs in a sidebar, a slim top bar, and the page as a
rounded card floating on a soft Space-coloured backdrop.

![Halcyon window: Essentials grid, Pinned and Today tabs in the sidebar, page as a card](images/layout-light.png)

## What's where

| Part | What it is |
| --- | --- |
| Essentials | The tile grid at the top of the sidebar: Firefox's pinned tabs, shown as large rounded tiles. Right-click a tab > **Add to Essentials**. |
| Pinned | Tabs you keep, listed under the Essentials. Right-click > **Pin to Sidebar**, or drag a tab above the divider. Drag it below the divider to unpin. Pinned tabs survive restarts. |
| + New Tab | Between Pinned and Today. New tabs open at the top of Today, right under it (as in Arc). |
| Today | Everything else. |
| Top bar | Sidebar button, back, forward, reload, the address (centred) with a copy-link button, downloads, extensions. |
| Content card | The page, inset 8 px from the window with 10 px corners. |
| Rail | Click the sidebar button to collapse the sidebar to icons. |
| Compact mode | **Ctrl+Alt+C** (Cmd+Option+C on macOS). The sidebar and top bar slide away; they come back when the pointer reaches the window edge, when the address bar has focus (F6), or while a menu opened from them is up. |
| Command bar | **Ctrl/Cmd+T** and **Ctrl/Cmd+L** open it over the page. See [COMMANDBAR.md](COMMANDBAR.md). |

## How it's built

Firefox already has vertical tabs, a collapsible sidebar and pinned tabs. Halcyon builds on
them instead of replacing them, so it inherits their accessibility, drag and drop, tab groups,
split view and session restore, and it costs **no patches to Firefox's files**.

| Piece | File (in `src/browser/components/halcyon/layout/`) |
| --- | --- |
| Design tokens (colours, spacing, radii, type, motion) | `halcyon-tokens.css` |
| Layout: backdrop, card, sidebar, Essentials, top bar | `halcyon-layout.css` |
| Compact mode styling | `halcyon-compact.css` |
| Window wiring: loads the sheets before first paint, first-run top bar, copy link | `HalcyonLayout.sys.mjs` |
| Pinned and Today sections | `HalcyonSections.sys.mjs` |
| Compact mode behaviour | `HalcyonCompact.sys.mjs` |
| Pure rules shared by the above (unit-tested) | `HalcyonLayoutLogic.sys.mjs` |

The module hooks into Firefox's per-window startup categories from `halcyon.manifest`:
stylesheets load at `browser-window-before-initial-xul-layout`, so a window never paints stock
Firefox first; the rest attaches at `browser-window-domcontentloaded`.

### Rules worth knowing

* **Order invariant.** Pinned tabs are always the first tabs after the Essentials. Moving a tab
  decides its section by its neighbours: dropped among pinned tabs it's pinned, among Today tabs
  it's unpinned, on the boundary it keeps its state. Tabs in a tab group or split view are always
  Today. After a session restore the Pinned block is regrouped once.
* **Motion.** Only `transform` and `opacity` animate (150–250 ms), so the compositor does the work
  and the page never re-lays-out while chrome slides. A test fails if anything else is animated.
  The OS reduced-motion setting turns the motion off.
* **Themes.** Lightweight themes keep their colours; only the layout applies to them.
* **Off switch.** `halcyon.layout.enabled = false` gives stock Firefox chrome in new windows.

## Settings (about:config for now)

| Pref | Default | Effect |
| --- | --- | --- |
| `halcyon.layout.enabled` | true | The whole layout |
| `halcyon.layout.compact` | false | Compact mode |
| `halcyon.layout.compact.hideDelayMs` | 300 | Delay before hidden chrome slides away again |
| `halcyon.tabs.newTabPosition` | `top` | `top`: new tabs at the top of Today. `firefox`: Firefox's placement (never inside Pinned) |
| `sidebar.verticalTabs` | true | Tabs in the sidebar |
| `sidebar.visibility` | `always-show` | Firefox's sidebar mode |

## How it's checked without a build

Full builds are paused, so the layout is checked in the **official Firefox release we're based
on**. The `ui-preview` workflow downloads Firefox 158.0.1, loads our layout modules and default
prefs into it through autoconfig (`tools/preview/`), scripts a session with Essentials, Pinned
and Today tabs, and screenshots every state: expanded (light and dark), rail, compact (hidden,
sidebar revealed, both revealed) and the tab menu. It also checks, in that real browser:

* Essentials, then Pinned, then Today, in tab order
* "+ New Tab" opens at the top of Today
* the top bar's order, and no AI or sign-in buttons in it
* the tab menu offers Pin to Sidebar and Add to Essentials, and no AI chatbot item
* compact mode through its real triggers: the shortcut, the window edge, address-bar focus, and
  hiding again when the pointer and focus leave

Screenshots are published to the `ui-previews` branch on every change.

## Not done yet

| Item | Plan |
| --- | --- |
| Archive button in the bottom row | With auto-archive (C8) |
| Arc's "pinned tab resets to its URL when closed" | Later; Pinned tabs are synced launchers already ([SPACES.md](SPACES.md)) |
| Localised strings (menu labels are English-only) | With the browser's own localisation files |
| Frame-time measurement of the motion | When builds resume (Xvfb in CI renders in software, so its timings mean little) |
