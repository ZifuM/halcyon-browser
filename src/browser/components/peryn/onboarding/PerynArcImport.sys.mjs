/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Import from Arc: reads Arc's sidebar file (StorableSidebar.json) and turns its Spaces, pinned
 * tabs and Favorites into Peryn Spaces, pinned tabs and Essentials. Free of browser objects so
 * it can be unit-tested; PerynOnboarding.sys.mjs finds the file and applies the result.
 *
 * Arc's file isn't documented and has changed shape over time, so everything here is read
 * defensively: anything unrecognised is skipped, never fatal.
 *   - Spaces and items are flat lists that alternate ids and objects: ["id1", {...}, "id2", ...].
 *     Newer files (sidebarSyncState) wrap each object as {value: {...}}.
 *   - A Space has containerIDs ["pinned", <id>, "unpinned", <id>], a title, and customInfo with
 *     its emoji and colours.
 *   - An item is a tab ({data: {tab: {savedURL, savedTitle}}}), a folder ({data: {list: {}}})
 *     or a container ({data: {itemContainer: {containerType: {topApps | spaceItems | ...}}}}),
 *     with childrenIds.
 * Folders are flattened (Peryn has none yet); today's unpinned tabs are not imported (Arc
 * archives them anyway).
 */

import * as Logic from "../spaces/PerynSpacesLogic.sys.mjs";

/** Where Arc keeps the file, relative to the folders the OS gives us. */
export const ARC_PATHS = Object.freeze({
  // ~/Library/Application Support/Arc/StorableSidebar.json
  macosx: ["Arc", "StorableSidebar.json"],
  // %LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_<publisher>\LocalCache\Local\Arc\StorableSidebar.json
  win: ["LocalCache", "Local", "Arc", "StorableSidebar.json"],
  winPackagePrefix: "TheBrowserCompany.Arc_",
});

const isObject = v => v && typeof v == "object" && !Array.isArray(v);
const MAX_DEPTH = 64;

/** Objects from an alternating ["id", {...}, ...] list (or a plain list of objects). */
function objectsOf(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const obj = isObject(entry?.value) && typeof entry.value.id == "string" ? entry.value : entry;
    if (isObject(obj) && typeof obj.id == "string") {
      out.push(obj);
    }
  }
  return out;
}

/** The part of the file that holds `spaces` and `items` (it moved between Arc versions). */
export function findSidebar(json, depth = 0) {
  if (!json || typeof json != "object" || depth > 8) {
    return null;
  }
  if (Array.isArray(json.spaces) && Array.isArray(json.items)) {
    return json;
  }
  for (const value of Array.isArray(json) ? json : Object.values(json)) {
    const found = findSidebar(value, depth + 1);
    if (found) {
      return found;
    }
  }
  return null;
}

/** The ids paired with a label in Arc's ["pinned", id, "unpinned", id] lists. */
function pairedIds(list, label) {
  const out = [];
  if (!Array.isArray(list)) {
    return out;
  }
  for (let i = 0; i < list.length - 1; i++) {
    const key = list[i];
    const matches = key === label || (isObject(key) && label in key);
    if (matches && typeof list[i + 1] == "string") {
      out.push(list[i + 1]);
    }
  }
  return out;
}

/** OKLCH hue (degrees) of an sRGB colour with 0..1 channels; null for greys. */
export function hueOf({ red, green, blue }) {
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [red, green, blue].map(v => lin(Math.min(1, Math.max(0, Number(v) || 0))));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  if (Math.hypot(A, B) < 0.02) {
    return null;
  }
  return Math.round(((Math.atan2(B, A) * 180) / Math.PI + 360) % 360);
}

/** Every {red, green, blue} colour found in a Space's customInfo, in order. */
export function colorsIn(value, out = [], depth = 0) {
  if (!value || typeof value != "object" || depth > 12) {
    return out;
  }
  if (["red", "green", "blue"].every(k => typeof value[k] == "number")) {
    out.push(value);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value)) {
    colorsIn(v, out, depth + 1);
  }
  return out;
}

function emojiOf(space) {
  const icon = space.customInfo?.iconType;
  if (!isObject(icon)) {
    return "";
  }
  for (const key of ["emoji_v2", "emoji"]) {
    const value = icon[key];
    if (typeof value == "string") {
      return Logic.cleanIcon(value);
    }
    if (typeof value == "number" && value > 0 && value <= 0x10ffff) {
      return Logic.cleanIcon(String.fromCodePoint(value));
    }
  }
  return "";
}

function colorOf(space) {
  const hues = colorsIn(space.customInfo?.windowTheme).map(hueOf).filter(h => h !== null);
  if (!hues.length) {
    return null;
  }
  return { hue: hues[0], hue2: hues[1] ?? hues[0] + 28, chroma: Logic.DEFAULT_COLOR.chroma };
}

/**
 * Read Arc's sidebar file.
 *
 * @param {string|object} input the file's text or parsed JSON
 * @returns {{spaces: Array<{name, icon, color, pins: Array<{url, title}>}>,
 *            essentials: Array<{url, title}>, skipped: number}}
 */
export function parseArcSidebar(input) {
  let json = input;
  if (typeof json == "string") {
    try {
      json = JSON.parse(json);
    } catch {
      throw new Error("This isn't Arc's sidebar file (it isn't JSON).");
    }
  }
  const sidebar = findSidebar(json);
  if (!sidebar) {
    throw new Error("This isn't Arc's sidebar file (no Spaces in it).");
  }
  const items = new Map(objectsOf(sidebar.items).map(item => [item.id, item]));
  let skipped = 0;

  /** Tabs under an item, folders flattened, in sidebar order. */
  const tabsUnder = (id, seen = new Set(), depth = 0) => {
    const item = items.get(id);
    if (!item || seen.has(id) || depth > MAX_DEPTH) {
      return [];
    }
    seen.add(id);
    const tab = item.data?.tab;
    if (isObject(tab)) {
      const url = typeof tab.savedURL == "string" ? tab.savedURL : "";
      if (!Logic.isLauncherURL(url)) {
        skipped++;
        return [];
      }
      const title = [item.title, tab.savedTitle].find(t => typeof t == "string" && t.trim()) ?? "";
      return [{ url, title: title.trim().slice(0, 200) }];
    }
    let children = Array.isArray(item.childrenIds) ? item.childrenIds : [];
    if (!children.length) {
      // Some files only link children to parents.
      children = [...items.values()].filter(i => i.parentID == id).map(i => i.id);
    }
    return children.flatMap(child => tabsUnder(child, seen, depth + 1));
  };

  const spaces = [];
  for (const space of objectsOf(sidebar.spaces)) {
    const pinnedIds = pairedIds(space.containerIDs, "pinned");
    const pins = dedupe(pinnedIds.flatMap(id => tabsUnder(id)));
    spaces.push({
      name: Logic.cleanName(space.title, `Space ${spaces.length + 1}`),
      icon: emojiOf(space),
      color: colorOf(space),
      pins,
    });
  }

  // Favorites ("top apps") live in their own container, shared by every Space.
  let topIds = pairedIds(sidebar.topAppsContainerIDs, "default");
  if (!topIds.length) {
    topIds = [...items.values()].filter(i => isObject(i.data?.itemContainer?.containerType?.topApps)).map(i => i.id);
  }
  const essentials = dedupe(topIds.flatMap(id => tabsUnder(id)));

  if (!spaces.length && !essentials.length) {
    throw new Error("Arc's sidebar file has no Spaces or Favorites to import.");
  }
  return { spaces, essentials, skipped };
}

function dedupe(list) {
  const seen = new Set();
  return list.filter(entry => !seen.has(entry.url) && seen.add(entry.url));
}

/** Whether Spaces data is still what a new profile starts with. */
export function isUntouched(data) {
  return (
    data.spaces.length == 1 &&
    !data.spaces[0].pins.length &&
    !data.essentials.length &&
    data.spaces[0].name == Logic.defaultData().spaces[0].name
  );
}

/**
 * Peryn's Spaces data with an Arc import added. A brand-new profile's lone "Personal" Space is
 * replaced; otherwise Arc's Spaces are added after yours (a name already taken gets " (Arc)").
 * Essentials already there are kept and Arc's Favorites added after them.
 *
 * @returns {{data, added: {spaces: number, pins: number, essentials: number}, dropped: number}}
 */
export function mergeArcImport(data, imported, random = Math.random) {
  return mergeImport(data, imported, { source: "Arc", random });
}

/**
 * The same merge for any browser's Spaces, pinned tabs and Essentials (Arc, Zen); a name
 * already taken gets " (<source>)".
 */
export function mergeImport(data, imported, { source = "Arc", random = Math.random } = {}) {
  let next = isUntouched(data) ? { ...data, spaces: [] } : { ...data, spaces: [...data.spaces] };
  const names = new Set(next.spaces.map(s => s.name.toLowerCase()));
  const urls = new Set([...next.essentials.map(e => e.url)]);
  const added = { spaces: 0, pins: 0, essentials: 0 };
  let dropped = 0;
  const launcher = entry => ({ id: Logic.newId("p", random), url: entry.url, title: entry.title });

  for (const space of imported.spaces) {
    if (next.spaces.length >= Logic.MAX_SPACES) {
      dropped += 1 + space.pins.length;
      continue;
    }
    let name = space.name;
    if (names.has(name.toLowerCase())) {
      name = Logic.cleanName(`${name} (${source})`);
    }
    names.add(name.toLowerCase());
    const pins = space.pins.slice(0, Logic.MAX_LAUNCHERS).map(launcher);
    dropped += space.pins.length - pins.length;
    const created = Logic.createSpace({ ...next, spaces: next.spaces }, { name, icon: space.icon, color: space.color ?? undefined }, random);
    next = Logic.updateSpace(created.data, created.space.id, { pins });
    added.spaces++;
    added.pins += pins.length;
  }
  const essentials = [...next.essentials];
  for (const entry of imported.essentials) {
    if (urls.has(entry.url)) {
      continue;
    }
    if (essentials.length >= Logic.MAX_LAUNCHERS) {
      dropped++;
      continue;
    }
    urls.add(entry.url);
    essentials.push(launcher(entry));
    added.essentials++;
  }
  next = { ...next, essentials };
  if (!next.spaces.length) {
    next = { ...next, spaces: Logic.defaultData().spaces };
  }
  return { data: Logic.normalizeData(next), added, dropped };
}
