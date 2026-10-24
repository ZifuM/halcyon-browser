# Parity checklist (Gate B)

Gate B, the public beta at the end of C6, asks for parity with Arc and Zen on the sidebar,
Spaces, the command bar, split view and Glance. This is the checklist. Each line says what
Peryn does today and how it's checked.

How things are checked:

- **Preview**: the `ui-preview` workflow loads Peryn into the official Firefox 158.0.1 and
  checks the behaviour in that real browser on every change.
- **Unit**: unit tests in `tests/`.
- **Installer**: needs a hands-on check on an installed build.

## Sidebar

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| Vertical sidebar instead of a tab strip | Yes, built on Firefox's own vertical tabs | Preview |
| Favorites (Arc) / Essentials (Zen): a tile grid shared by every Space | Essentials | Preview |
| Pinned tabs per Space, then today's tabs | Pinned and Today sections, + New Tab between them | Preview |
| New tabs at the top of Today | Yes (or Firefox's placement, by pref) | Preview |
| Collapse to an icon rail | Yes | Preview |
| Compact / hide the sidebar and toolbar, reveal on edge hover | Compact mode (Ctrl+Alt+C), reveals on the edge, address bar focus | Preview |
| The page as an inset card on a tinted backdrop | Yes, tinted by the Space | Preview |
| Tab folders | **Not yet** (imports flatten folders) | |
| Archive old Today tabs automatically | **C8** (auto-archive) | |
| Media controls in the sidebar | **C9** | |

## Spaces

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| Named Spaces with an icon | Yes | Preview |
| Colour / gradient per Space | Colour wheel, intensity, blend, grain | Preview |
| A Space tied to a container (cookies kept apart) | Optional container per Space | Unit, preview |
| Switch by swipe, shortcut or the dots | Swipe, Ctrl+Alt+←/→, Ctrl+Alt+1–9, dots | Preview |
| Sync Spaces between computers | Firefox Sync, end-to-end encrypted, with pinned tabs and Essentials | Preview (simulated), **Installer** (two real accounts still to do) |
| Profiles per Space (Arc) | Containers instead; real profiles **not planned** | |

## Command bar

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| One box for tabs, history, bookmarks, actions | Yes, plus Spaces and settings pages | Preview |
| Opens on new tab and on the address key | Ctrl/Cmd+T, Ctrl/Cmd+L | Preview |
| Fast on a large history | p95 about 6 ms per keystroke over 100,000 entries in Firefox's WebAssembly | Preview, CI budget |
| Custom shortcuts | Every action, with conflict warnings | Preview |
| Search individual settings | **C10** | |

## Split view

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| Two pages side by side | Firefox's own split view | Preview |
| Up to four panes, grid and stacked layouts | Yes: one large plus two, grid, side by side, stacked | Preview |
| Drag a tab onto the page to split | Yes, left/right/top/bottom drop zones | Preview (drop), **Installer** (real drag) |
| Resize between panes | Drag or arrow keys, 20–80% | Preview |
| Closing one pane keeps the rest | Yes | Preview |

## Glance (Arc's Peek, Zen's Glance)

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| Modifier-click a link to preview it over the page | Alt/Option+click | Preview (a real Alt+click in the page) |
| Close with Esc or a click outside | Yes | Preview |
| Expand to a tab, or open side by side | Yes | Preview |

## Moving over

| Arc / Zen | Peryn | Checked by |
| --- | --- | --- |
| Import bookmarks, history, passwords from Chrome, Edge, Safari, Firefox and others | Firefox's import wizard | Firefox's own tests |
| Import from Arc: Spaces, pinned tabs, Favorites | Yes | Unit, preview |
| Import from Zen: Spaces, pinned tabs, Essentials | Yes, from its session file | Unit, preview |

## Beyond parity (Peryn's own)

Peryn's own additions, not part of the parity check:

- built-in ad and tracker blocking
- zero telemetry, with every connection documented and checked in CI
- the Rust command-bar index
- a split view that goes past Firefox's two panes

## What still blocks Gate B

1. Hands-on checks on the C6 installer:
   - a real tab drag onto the page
   - element hiding now that its actor runs in pages
   - a two-account Sync round trip
2. Performance targets on an installed build:
   - start-up no slower than Firefox
   - memory within 10% with Shield on
   - page loads no slower than Firefox

   See [PERFORMANCE.md](PERFORMANCE.md).
