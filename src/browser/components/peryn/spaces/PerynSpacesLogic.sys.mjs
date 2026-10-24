/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pure logic for Spaces: the data model, its validation, edits, colours, and the launcher
// reconciliation that keeps pinned tabs and Essentials in step across synced machines.
// No Firefox APIs, so the unit tests run it directly.
//
// Data (one JSON pref, `peryn.spaces`, synced by Firefox Sync's prefs engine):
//   {
//     version: 1,
//     spaces: [{ id, name, icon, color: { hue, hue2, chroma, grain }, container, pins }],
//     essentials: [{ id, url, title }],
//   }
// `container` is null or { name, icon, color }: matched to a local container by name on each
// machine (container ids differ between machines). `pins` are the Space's pinned tabs as
// launchers: { id, url, title }.

export const PREFS = Object.freeze({
  data: "peryn.spaces",
  syncControl: "services.sync.prefs.sync.peryn.spaces",
});

export const DATA_VERSION = 1;
export const MAX_SPACES = 24;
export const MAX_LAUNCHERS = 200;
export const MAX_NAME = 40;

/** Hues offered for new Spaces, in order, skipping ones already used. */
export const PALETTE = Object.freeze([268, 210, 155, 32, 340, 95, 0, 285, 185, 55]);

/** Icons offered in the editor. Any short text works (an emoji, a letter). */
export const ICON_CHOICES = Object.freeze([
  "🏠", "💼", "🎓", "🎨", "🎮", "🎵", "✈️", "🛒", "📚", "💡", "🧪", "🌱",
]);

export const DEFAULT_COLOR = Object.freeze({ hue: 268, hue2: 228, chroma: 0.045, grain: false }); // the feather: violet to sky blue

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isObject = v => v && typeof v == "object" && !Array.isArray(v);

/** A short random id: "s-" for Spaces, "p-" for launchers. */
export function newId(prefix, random = Math.random) {
  let id = "";
  for (let i = 0; i < 10; i++) {
    id += "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(random() * 32)];
  }
  return `${prefix}-${id}`;
}

/** First grapheme-ish chunk of `text`, at most 8 code units (an emoji with modifiers fits). */
export function cleanIcon(text) {
  if (typeof text != "string") {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  let first = trimmed;
  if (typeof Intl != "undefined" && Intl.Segmenter) {
    first = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)][0].segment;
  } else {
    first = [...trimmed][0];
  }
  return first.slice(0, 8);
}

export function cleanName(text, fallback = "Space") {
  const name = typeof text == "string" ? text.replace(/\s+/g, " ").trim().slice(0, MAX_NAME) : "";
  return name || fallback;
}

export function cleanColor(color) {
  const c = isObject(color) ? color : {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const hue = ((num(c.hue, DEFAULT_COLOR.hue) % 360) + 360) % 360;
  return {
    hue: Math.round(hue),
    hue2: Math.round((((num(c.hue2, hue + 28) % 360) + 360) % 360)),
    chroma: Math.round(clamp(num(c.chroma, DEFAULT_COLOR.chroma), 0, 0.12) * 1000) / 1000,
    grain: c.grain === true,
  };
}

export function cleanContainer(container) {
  if (!isObject(container) || typeof container.name != "string" || !container.name.trim()) {
    return null;
  }
  return {
    name: container.name.trim().slice(0, MAX_NAME),
    icon: typeof container.icon == "string" ? container.icon : "circle",
    color: typeof container.color == "string" ? container.color : "blue",
  };
}

/** Launcher URLs worth restoring on another machine. */
export function isLauncherURL(url) {
  return typeof url == "string" && url.length <= 4096 && /^(https?|file|about|moz-extension):/i.test(url);
}

export function cleanLaunchers(list, seen = new Set()) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!isObject(entry) || typeof entry.id != "string" || seen.has(entry.id) || !isLauncherURL(entry.url)) {
      continue;
    }
    seen.add(entry.id);
    out.push({
      id: entry.id.slice(0, 40),
      url: entry.url,
      title: typeof entry.title == "string" ? entry.title.slice(0, 200) : "",
    });
    if (out.length >= MAX_LAUNCHERS) {
      break;
    }
  }
  return out;
}

export function defaultData() {
  return {
    version: DATA_VERSION,
    spaces: [
      {
        id: "s-personal",
        name: "Personal",
        icon: "",
        color: { ...DEFAULT_COLOR },
        container: null,
        pins: [],
      },
    ],
    essentials: [],
  };
}

/**
 * Validate and repair data read from the pref (or received through Sync). Never throws:
 * anything unusable is dropped, and there is always at least one Space.
 */
export function normalizeData(raw) {
  let input = raw;
  if (typeof input == "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  if (!isObject(input) || !Array.isArray(input.spaces)) {
    return defaultData();
  }
  const ids = new Set();
  const launcherIds = new Set();
  const spaces = [];
  for (const s of input.spaces) {
    if (!isObject(s) || typeof s.id != "string" || !s.id || ids.has(s.id) || spaces.length >= MAX_SPACES) {
      continue;
    }
    ids.add(s.id);
    spaces.push({
      id: s.id.slice(0, 40),
      name: cleanName(s.name),
      icon: cleanIcon(s.icon),
      color: cleanColor(s.color),
      container: cleanContainer(s.container),
      pins: cleanLaunchers(s.pins, launcherIds),
    });
  }
  if (!spaces.length) {
    return defaultData();
  }
  return {
    version: DATA_VERSION,
    spaces,
    essentials: cleanLaunchers(input.essentials, launcherIds),
  };
}

export function serialize(data) {
  return JSON.stringify(normalizeData(data));
}

export function findSpace(data, id) {
  return data.spaces.find(s => s.id == id) ?? null;
}

/** The hue for a new Space: the first palette hue not already used. */
export function nextHue(data) {
  const used = new Set(data.spaces.map(s => s.color.hue));
  return PALETTE.find(h => !used.has(h)) ?? PALETTE[data.spaces.length % PALETTE.length];
}

// ---- edits (all return new data; inputs are never mutated) --------------------------------

export function createSpace(data, { name, icon = "", color, container = null, id } = {}, random) {
  if (data.spaces.length >= MAX_SPACES) {
    throw new Error(`at most ${MAX_SPACES} Spaces`);
  }
  const hue = nextHue(data);
  const space = {
    id: id ?? newId("s", random),
    name: cleanName(name, `Space ${data.spaces.length + 1}`),
    icon: cleanIcon(icon),
    color: cleanColor(color ?? { hue, hue2: hue + 28, chroma: DEFAULT_COLOR.chroma }),
    container: cleanContainer(container),
    pins: [],
  };
  return { data: { ...data, spaces: [...data.spaces, space] }, space };
}

export function updateSpace(data, id, patch) {
  let found = false;
  const spaces = data.spaces.map(s => {
    if (s.id != id) {
      return s;
    }
    found = true;
    return {
      ...s,
      ...("name" in patch ? { name: cleanName(patch.name, s.name) } : {}),
      ...("icon" in patch ? { icon: cleanIcon(patch.icon) } : {}),
      ...("color" in patch ? { color: cleanColor({ ...s.color, ...patch.color }) } : {}),
      ...("container" in patch ? { container: cleanContainer(patch.container) } : {}),
      ...("pins" in patch ? { pins: cleanLaunchers(patch.pins) } : {}),
    };
  });
  if (!found) {
    throw new Error(`no Space ${id}`);
  }
  return { ...data, spaces };
}

/** Remove a Space. Returns the new data and the Space its tabs should move to. */
export function deleteSpace(data, id) {
  const index = data.spaces.findIndex(s => s.id == id);
  if (index < 0) {
    throw new Error(`no Space ${id}`);
  }
  if (data.spaces.length == 1) {
    throw new Error("the last Space can't be deleted");
  }
  const spaces = data.spaces.filter(s => s.id != id);
  const fallback = spaces[Math.max(0, index - 1)];
  return { data: { ...data, spaces }, fallback: fallback.id };
}

export function moveSpace(data, id, toIndex) {
  const index = data.spaces.findIndex(s => s.id == id);
  if (index < 0) {
    throw new Error(`no Space ${id}`);
  }
  const spaces = [...data.spaces];
  const [space] = spaces.splice(index, 1);
  spaces.splice(clamp(toIndex, 0, spaces.length), 0, space);
  return { ...data, spaces };
}

/** The Space `step` places after `id` (negative: before), stopping at the ends. */
export function neighbourSpace(data, id, step) {
  const index = data.spaces.findIndex(s => s.id == id);
  if (index < 0) {
    return data.spaces[0].id;
  }
  return data.spaces[clamp(index + step, 0, data.spaces.length - 1)].id;
}

// ---- launchers (pinned tabs and Essentials across machines) --------------------------------

export function addLauncher(list, entry) {
  if (list.some(l => l.id == entry.id)) {
    return list.map(l => (l.id == entry.id ? { ...l, ...entry } : l));
  }
  return cleanLaunchers([...list, entry]);
}

export function removeLauncher(list, id) {
  return list.filter(l => l.id != id);
}

/**
 * What a window must do so its tabs match the launcher lists.
 *
 * @param {object} data  Spaces data
 * @param {Array<{pinId, kind, spaceId}>} local  every launcher-backed tab open on this machine
 *   (all windows): kind is "pin" or "essential"
 * @returns {{open: Array<{kind, spaceId, entry}>, release: Array<string>}}
 *   open: launchers with no tab on this machine; release: pinIds whose launcher is gone
 *   (those tabs stop being pinned / Essentials but stay open).
 */
export function reconcileLaunchers(data, local) {
  const present = new Set(local.map(t => t.pinId));
  const wanted = new Map();
  for (const entry of data.essentials) {
    wanted.set(entry.id, { kind: "essential", spaceId: null, entry });
  }
  for (const space of data.spaces) {
    for (const entry of space.pins) {
      wanted.set(entry.id, { kind: "pin", spaceId: space.id, entry });
    }
  }
  const open = [...wanted.entries()].filter(([id]) => !present.has(id)).map(([, v]) => v);
  const release = local.filter(t => !wanted.has(t.pinId)).map(t => t.pinId);
  return { open, release };
}

// ---- colour ------------------------------------------------------------------------------

/** CSS custom properties that put a Space's colour on a window (see peryn-tokens.css). */
export function colorVars(color) {
  const c = cleanColor(color);
  return {
    "--hx-space-hue": String(c.hue),
    "--hx-space-hue-2": String(c.hue2),
    "--hx-space-chroma": String(c.chroma),
  };
}

/** A preview swatch for the editor and the Space dots. */
export function swatchCSS(color) {
  const c = cleanColor(color);
  const chroma = Math.max(c.chroma * 2.2, 0.06);
  return `linear-gradient(135deg, oklch(0.78 ${chroma} ${c.hue}), oklch(0.68 ${chroma} ${c.hue2}))`;
}

/** Hue (0–359) from a click on the colour wheel, relative to its centre. 0° is at the top. */
export function hueFromPoint(x, y) {
  const deg = (Math.atan2(x, -y) * 180) / Math.PI;
  return Math.round((deg + 360) % 360);
}

// ---- input ---------------------------------------------------------------------------------

/**
 * Turns horizontal wheel/trackpad movement over the sidebar into Space switches: one switch
 * per swipe once the movement passes `threshold` pixels, then a pause before the next.
 */
export class SwipeTracker {
  constructor({ threshold = 150, cooldownMs = 450, resetMs = 220, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.resetMs = resetMs;
    this.now = now;
    this.total = 0;
    this.last = 0;
    this.blockedUntil = 0;
  }

  /** Feed one wheel event; returns +1 (next Space), -1 (previous) or 0. */
  add(deltaX, deltaY) {
    const t = this.now();
    if (Math.abs(deltaX) <= Math.abs(deltaY)) {
      return 0;
    }
    if (t - this.last > this.resetMs) {
      this.total = 0;
    }
    this.last = t;
    if (t < this.blockedUntil) {
      return 0;
    }
    this.total += deltaX;
    if (Math.abs(this.total) >= this.threshold) {
      const dir = Math.sign(this.total);
      this.total = 0;
      this.blockedUntil = t + this.cooldownMs;
      return dir;
    }
    return 0;
  }
}
