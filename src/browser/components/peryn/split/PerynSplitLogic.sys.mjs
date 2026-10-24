/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Split view rules, free of browser objects so they can be unit-tested: which layouts a number
 * of panes allows, the CSS grid for each layout, and how dividers move.
 *
 * Firefox's own split view handles two side-by-side panes (and keeps doing so here). Peryn
 * adds a third and fourth pane, and other arrangements, by laying the same panels out on a
 * CSS grid; see PerynSplit.sys.mjs.
 */

export const MAX_PANES = 4;
export const MIN_RATIO = 0.2;
export const MAX_RATIO = 0.8;

/** Session-store key (on a split's first tab) holding its layout and divider positions. */
export const STATE_KEY = "peryn-split";

/**
 * Layouts by pane count, the first being the default. Names are what the command bar shows.
 * "columns" with two panes is Firefox's own split view, untouched.
 */
export const LAYOUTS = Object.freeze({
  2: Object.freeze(["columns", "rows"]),
  3: Object.freeze(["main", "columns", "rows"]),
  4: Object.freeze(["grid", "columns", "rows"]),
});

export const LAYOUT_LABELS = Object.freeze({
  columns: "Side by side",
  rows: "Stacked",
  main: "One large, two small",
  grid: "Grid",
});

export function clampRatio(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, n));
}

/** A layout valid for `panes`, falling back to that count's default. */
export function layoutFor(panes, wanted) {
  const options = LAYOUTS[panes];
  if (!options) {
    return null;
  }
  return options.includes(wanted) ? wanted : options[0];
}

/** The next layout in the cycle for `panes`. */
export function nextLayout(panes, current) {
  const options = LAYOUTS[panes];
  if (!options) {
    return null;
  }
  const i = options.indexOf(current);
  return options[(i + 1) % options.length];
}

/** Whether Firefox's own two-pane split view already does this (so Peryn stays out of it). */
export function isNative(panes, layout) {
  return panes == 2 && layoutFor(2, layout) == "columns";
}

/**
 * The CSS grid for a layout: column and row tracks, the area names in order (pane i takes
 * area AREAS[i]), and which dividers can be dragged.
 *
 * @param {number} panes 2..4
 * @param {string} layout
 * @param {{x?: number, y?: number}} ratios divider positions, 0.2..0.8
 */
export function gridFor(panes, layout, { x = 0.5, y = 0.5 } = {}) {
  const fx = clampRatio(x);
  const fy = clampRatio(y);
  const cols2 = `minmax(0, ${fx}fr) minmax(0, ${1 - fx}fr)`;
  const rows2 = `minmax(0, ${fy}fr) minmax(0, ${1 - fy}fr)`;
  const even = n => Array(n).fill("minmax(0, 1fr)").join(" ");
  layout = layoutFor(panes, layout);
  switch (`${panes}:${layout}`) {
    case "2:columns":
      return { columns: cols2, rows: even(1), areas: ['"a b"'], dividers: ["x"] };
    case "2:rows":
      return { columns: even(1), rows: rows2, areas: ['"a"', '"b"'], dividers: ["y"] };
    case "3:main":
      return { columns: cols2, rows: rows2, areas: ['"a b"', '"a c"'], dividers: ["x", "y-right"] };
    case "3:columns":
      return { columns: even(3), rows: even(1), areas: ['"a b c"'], dividers: [] };
    case "3:rows":
      return { columns: even(1), rows: even(3), areas: ['"a"', '"b"', '"c"'], dividers: [] };
    case "4:grid":
      return { columns: cols2, rows: rows2, areas: ['"a b"', '"c d"'], dividers: ["x", "y"] };
    case "4:columns":
      return { columns: even(4), rows: even(1), areas: ['"a b c d"'], dividers: [] };
    case "4:rows":
      return { columns: even(1), rows: even(4), areas: ['"a"', '"b"', '"c"', '"d"'], dividers: [] };
  }
  return null;
}

export const AREAS = Object.freeze(["a", "b", "c", "d"]);

/** A divider dragged to `pointer` (px from the container's start) over `size` px. */
export function ratioFromPointer(pointer, size) {
  if (!(size > 0)) {
    return 0.5;
  }
  return clampRatio(pointer / size);
}

/** Read a split's saved state ("" or junk gives the defaults). */
export function readState(json) {
  let data = {};
  try {
    data = JSON.parse(json || "{}") ?? {};
  } catch {}
  if (typeof data != "object" || Array.isArray(data)) {
    data = {};
  }
  return {
    layout: typeof data.layout == "string" ? data.layout : "",
    x: clampRatio(data.x),
    y: clampRatio(data.y),
  };
}

/**
 * Which of `candidates` can join a split that already has `current` tabs: unpinned, not
 * already in a split, not closing, up to MAX_PANES in all.
 */
export function joinable(current, candidates) {
  const room = MAX_PANES - current.length;
  if (room <= 0) {
    return [];
  }
  return candidates.filter(t => !t.pinned && !t.splitview && !t.closing && !current.includes(t)).slice(0, room);
}
