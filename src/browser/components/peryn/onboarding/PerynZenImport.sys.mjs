/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Import from Zen: Zen is built on Firefox and keeps its Spaces (workspaces), pinned tabs and
 * Essentials in its session file. This reads that file's JSON (PerynOnboarding decompresses
 * it) into the same shape as the Arc import, so the same merge applies. Free of browser
 * objects so it can be unit-tested.
 *
 * Zen's format isn't documented and changes between versions, so it's read defensively:
 *   - Zen 1.18 and later: zen-sessions.jsonlz4 with top-level `spaces` ({uuid, name, icon,
 *     theme}) and `tabs`; Zen 1.17 and older: sessionstore.jsonlz4, with the tabs under
 *     windows[].tabs.
 *   - A tab has `entries` ([{url, title}], `index` pointing at the current one, from 1),
 *     `pinned`, `zenWorkspace` (a Space's uuid) and `zenEssential` (sometimes under
 *     `attributes`).
 * Folders are flattened (their tabs keep their order); unpinned tabs aren't imported.
 */

import * as Logic from "../spaces/PerynSpacesLogic.sys.mjs";
import { hueOf } from "./PerynArcImport.sys.mjs";

/** Where Zen keeps profiles, under the OS folders PerynOnboarding resolves. */
export const ZEN_PATHS = Object.freeze({
  win: ["zen", "Profiles"], // %APPDATA%
  macosx: ["zen", "Profiles"], // ~/Library/Application Support
  linux: [".zen"], // ~
  sessionFiles: ["zen-sessions.jsonlz4", "sessionstore.jsonlz4"],
});

const isObject = v => v && typeof v == "object" && !Array.isArray(v);

/** Arrays of objects anywhere in `json` whose items pass `test` (depth-limited). */
function arraysOf(json, test, depth = 0, out = []) {
  if (!json || typeof json != "object" || depth > 6) {
    return out;
  }
  if (Array.isArray(json)) {
    if (json.length && json.every(isObject) && json.some(test)) {
      out.push(json);
      return out;
    }
    for (const item of json) {
      arraysOf(item, test, depth + 1, out);
    }
    return out;
  }
  for (const value of Object.values(json)) {
    arraysOf(value, test, depth + 1, out);
  }
  return out;
}

const isSpace = o => typeof o.uuid == "string" && typeof o.name == "string";
const isTab = o => Array.isArray(o.entries);

/** A tab's current page. */
function pageOf(tab) {
  const entries = tab.entries.filter(isObject);
  if (!entries.length) {
    return null;
  }
  const i = Number.isInteger(tab.index) ? tab.index - 1 : entries.length - 1;
  const entry = entries[Math.min(entries.length - 1, Math.max(0, i))];
  return typeof entry.url == "string" ? { url: entry.url, title: typeof entry.title == "string" ? entry.title.trim().slice(0, 200) : "" } : null;
}

const flag = (tab, name) => tab[name] === true || tab[name] === "true" || tab.attributes?.[name] === true || tab.attributes?.[name] === "true";

function iconOf(space) {
  const icon = typeof space.icon == "string" ? space.icon.trim() : "";
  // Zen also allows its own SVG icons (chrome:// URLs); only an emoji carries over.
  return icon && !/^[a-z-]+:/i.test(icon) ? Logic.cleanIcon(icon) : "";
}

function colorOf(space) {
  const hues = [];
  const walk = (value, depth = 0) => {
    if (!value || typeof value != "object" || depth > 6 || hues.length >= 2) {
      return;
    }
    if (Array.isArray(value.c) && value.c.length >= 3 && value.c.slice(0, 3).every(n => typeof n == "number")) {
      const [red, green, blue] = value.c.map(n => n / 255);
      const hue = hueOf({ red, green, blue });
      if (hue !== null) {
        hues.push(hue);
      }
      return;
    }
    for (const v of Array.isArray(value) ? value : Object.values(value)) {
      walk(v, depth + 1);
    }
  };
  walk(space.theme);
  return hues.length ? { hue: hues[0], hue2: hues[1] ?? hues[0] + 28, chroma: Logic.DEFAULT_COLOR.chroma } : null;
}

/**
 * Read Zen's session JSON.
 *
 * @returns {{spaces: Array<{name, icon, color, pins}>, essentials: Array<{url, title}>, skipped: number}}
 */
export function parseZenSession(json) {
  if (!json || typeof json != "object") {
    throw new Error("This isn't Zen's session file.");
  }
  const spaceList = arraysOf(json, isSpace)[0] ?? [];
  const tabs = arraysOf(json, isTab).flat().filter(isTab);
  if (!spaceList.length && !tabs.length) {
    throw new Error("This isn't Zen's session file (no Spaces or tabs in it).");
  }
  const byUuid = new Map();
  // Zen's own order when it gives one (`position`), else the file's.
  const ordered = spaceList
    .filter(isSpace)
    .map((space, i) => ({ space, at: Number.isFinite(space.position) ? space.position : i }))
    .sort((a, b) => a.at - b.at);
  const spaces = [];
  for (const { space } of ordered) {
    if (byUuid.has(space.uuid)) {
      continue;
    }
    const entry = { name: Logic.cleanName(space.name, `Space ${spaces.length + 1}`), icon: iconOf(space), color: colorOf(space), pins: [] };
    byUuid.set(space.uuid, entry);
    spaces.push(entry);
  }

  const essentials = [];
  const seen = new Set();
  let skipped = 0;
  for (const tab of tabs) {
    const essential = flag(tab, "zenEssential");
    const pinned = essential || flag(tab, "pinned");
    if (!pinned) {
      continue;
    }
    const page = pageOf(tab);
    if (!page || !Logic.isLauncherURL(page.url) || /^about:/i.test(page.url)) {
      skipped++;
      continue;
    }
    const space = byUuid.get(tab.zenWorkspace) ?? byUuid.get(tab.attributes?.zenWorkspace);
    const key = `${essential ? "e" : tab.zenWorkspace}|${page.url}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (essential) {
      essentials.push(page);
    } else if (space) {
      space.pins.push(page);
    } else if (spaces.length) {
      spaces[0].pins.push(page);
    } else {
      skipped++;
    }
  }
  if (!spaces.length && !essentials.length) {
    throw new Error("Zen's session file has no Spaces or pinned tabs to import.");
  }
  return { spaces, essentials, skipped };
}
