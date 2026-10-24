/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The command bar's rules, kept free of browser objects so they can be unit-tested: input
 * parsing (filters, URLs), ranking inputs, the built-in actions, result ordering, and keyboard
 * shortcuts (parsing, display, recording, conflicts).
 */

import { KIND, ALL_KINDS } from "./OmniIndex.sys.mjs";

export { KIND, ALL_KINDS };

export const PREFS = Object.freeze({
  enabled: "halcyon.commandbar.enabled",
  onNewTab: "halcyon.commandbar.onNewTab",
  onAddressKey: "halcyon.commandbar.onAddressKey",
  historyLimit: "halcyon.commandbar.historyLimit",
  shortcuts: "halcyon.shortcuts",
  /** Lets Firefox Sync carry the shortcuts (read by Sync itself, not by us). */
  shortcutsSync: "services.sync.prefs.sync.halcyon.shortcuts",
});

export const MAX_ROWS = 9;
export { MAX_RESULTS } from "./OmniIndex.sys.mjs";
export const DEFAULT_HISTORY_LIMIT = 100000;

// ---- input -------------------------------------------------------------------------------

/** "@tabs foo" style filters, and ">" for actions (as in many editors' command palettes). */
export const FILTERS = Object.freeze([
  { token: "@tabs", label: "Tabs", kinds: 1 << KIND.tab },
  { token: "@bookmarks", label: "Bookmarks", kinds: 1 << KIND.bookmark },
  { token: "@history", label: "History", kinds: 1 << KIND.history },
  { token: "@actions", label: "Actions", kinds: (1 << KIND.action) | (1 << KIND.space) },
  { token: "@spaces", label: "Spaces", kinds: 1 << KIND.space },
  // Open tabs that show the same page as another tab.
  { token: "@duplicates", label: "Duplicates", kinds: 1 << KIND.tab, duplicates: true },
]);

/**
 * Split the typed text into a filter and the query.
 *
 * @returns {{query: string, kinds: number, filter: object|null, filterHint: object[]}}
 *   `filterHint` lists filters the text could be the start of ("@ta" -> @tabs).
 */
export function parseInput(text) {
  const raw = String(text ?? "");
  const trimmed = raw.trimStart();
  if (trimmed.startsWith(">")) {
    const filter = FILTERS.find(f => f.token == "@actions");
    return { query: trimmed.slice(1).trim(), kinds: filter.kinds, filter, filterHint: [] };
  }
  const match = /^(@[a-z]*)(\s+|$)/i.exec(trimmed);
  if (match) {
    const token = match[1].toLowerCase();
    const filter = FILTERS.find(f => f.token == token);
    if (filter) {
      return { query: trimmed.slice(match[0].length).trim(), kinds: filter.kinds, filter, filterHint: [] };
    }
    const hint = FILTERS.filter(f => f.token.startsWith(token));
    if (hint.length && !match[2]) {
      return { query: "", kinds: ALL_KINDS, filter: null, filterHint: hint };
    }
  }
  return { query: raw.trim(), kinds: ALL_KINDS, filter: null, filterHint: [] };
}

const SCHEME_RE = /^(https?|about|file|view-source|moz-extension|chrome|resource|data|ftp):/i;
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}\.?(?::\d{1,5})?(?:[/?#].*)?$/i;
const LOCAL_RE = /^(?:localhost|\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#].*)?$/i;

/**
 * Whether the text is meant as an address rather than a search.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {(host: string) => boolean} [options.isKnownSuffix] whether a host ends in a real
 *   public suffix (Firefox's list, so "node.js" is a search but "nodejs.org" an address)
 */
export function looksLikeURL(text, { isKnownSuffix } = {}) {
  const t = String(text ?? "").trim();
  if (!t || /\s/.test(t)) {
    return false;
  }
  if (SCHEME_RE.test(t) || LOCAL_RE.test(t)) {
    return true;
  }
  if (!HOST_RE.test(t)) {
    return false;
  }
  const host = t.split(/[/?#:]/)[0].replace(/\.$/, "");
  return isKnownSuffix ? isKnownSuffix(host) : true;
}

/** A fallback for turning the text into a URL when Firefox's fixup isn't available. */
export function toURL(text) {
  const t = String(text ?? "").trim();
  if (SCHEME_RE.test(t)) {
    return t;
  }
  return (LOCAL_RE.test(t) ? "http://" : "https://") + t;
}

// ---- ranking inputs ----------------------------------------------------------------------

/** Firefox's frecency (unbounded) to the index's 0..100, on a log scale. */
export function boostFromFrecency(frecency, maxFrecency) {
  const f = Math.max(0, Number(frecency) || 0);
  const max = Math.max(1, Number(maxFrecency) || 0);
  return Math.min(100, (100 * Math.log1p(f)) / Math.log1p(max));
}

/** Days since a Places timestamp (microseconds since the epoch). Unknown -> a year. */
export function ageDays(placesTimeUs, nowMs = Date.now()) {
  const us = Number(placesTimeUs);
  if (!us) {
    return 365;
  }
  return Math.max(0, (nowMs - us / 1000) / 86400000);
}

/** Days since a tab was last used. */
export function tabAgeDays(lastAccessedMs, nowMs = Date.now()) {
  return lastAccessedMs ? Math.max(0, (nowMs - lastAccessedMs) / 86400000) : 30;
}

/** Addresses the command bar never lists. */
export function indexable(url) {
  return !!url && !/^(place|javascript|data|blob|moz-extension|about:blank$|about:newtab$|about:home$)/i.test(url);
}

// ---- actions -----------------------------------------------------------------------------

/**
 * Built-in actions. `command` names a Firefox <command> to run; `run` names a handler in the
 * command bar (HalcyonCommandBar.sys.mjs); `key` names the Firefox <key> whose shortcut is
 * shown. `keywords` are extra words to match (they go where a page's URL would).
 */
export const ACTIONS = Object.freeze([
  { id: "new-tab", title: "New Tab", keywords: "open blank page", run: "newTab", key: "key_newNavigatorTab" },
  { id: "new-window", title: "New Window", keywords: "open", command: "cmd_newNavigator", key: "key_newNavigator" },
  { id: "new-private-window", title: "New Private Window", keywords: "incognito open", command: "Tools:PrivateBrowsing", key: "key_privatebrowsing" },
  { id: "close-tab", title: "Close Tab", keywords: "remove", command: "cmd_close", key: "key_close" },
  { id: "reopen-tab", title: "Reopen Closed Tab", keywords: "undo restore closed", command: "History:RestoreLastClosedTabOrWindowOrSession", key: "key_restoreLastClosedTabOrWindowOrSession" },
  { id: "duplicate-tab", title: "Duplicate Tab", keywords: "copy clone", command: "Browser:DuplicateTab" },
  { id: "pin-tab", title: "Pin or Unpin Tab", keywords: "sidebar keep pinned", run: "togglePin" },
  { id: "essential", title: "Add to or Remove from Essentials", keywords: "essentials favourite favorite grid", run: "toggleEssential" },
  { id: "copy-link", title: "Copy Link", keywords: "url address clipboard share", run: "copyLink" },
  { id: "reload", title: "Reload Page", keywords: "refresh", command: "Browser:Reload", key: "key_reload" },
  { id: "find", title: "Find in Page", keywords: "search text", command: "cmd_find", key: "key_find" },
  { id: "print", title: "Print", keywords: "pdf paper", command: "cmd_print", key: "printKb" },
  { id: "bookmark", title: "Bookmark This Page", keywords: "save star favourite", command: "Browser:AddBookmarkAs", key: "addBookmarkAsKb" },
  { id: "reader", title: "Reader View", keywords: "read article clean", command: "View:ReaderView", key: "key_toggleReaderMode" },
  { id: "pip", title: "Picture-in-Picture", keywords: "video float", command: "View:PictureInPicture", key: "key_togglePictureInPicture" },
  { id: "fullscreen", title: "Full Screen", keywords: "maximise maximize", command: "View:FullScreen", key: "key_enterFullScreen" },
  { id: "zoom-in", title: "Zoom In", keywords: "bigger larger", command: "cmd_fullZoomEnlarge", key: "key_fullZoomEnlarge" },
  { id: "zoom-out", title: "Zoom Out", keywords: "smaller", command: "cmd_fullZoomReduce", key: "key_fullZoomReduce" },
  { id: "zoom-reset", title: "Reset Zoom", keywords: "actual size 100", command: "cmd_fullZoomReset", key: "key_fullZoomReset" },
  { id: "screenshot", title: "Take Screenshot", keywords: "capture image", command: "Browser:Screenshot", key: "key_screenshot" },
  { id: "page-source", title: "View Page Source", keywords: "html code developer", command: "View:PageSource", key: "key_viewSource" },
  { id: "compact", title: "Toggle Compact Mode", keywords: "hide sidebar toolbar focus", run: "toggleCompact", key: "halcyon-key-compact" },
  { id: "sidebar", title: "Collapse or Expand Sidebar", keywords: "rail tabs", run: "toggleSidebar" },
  { id: "new-space", title: "New Space", keywords: "create add workspace", run: "newSpace" },
  { id: "edit-space", title: "Edit This Space", keywords: "rename colour color icon theme workspace", run: "editSpace" },
  { id: "next-space", title: "Next Space", keywords: "switch workspace", run: "nextSpace", key: "halcyon-key-space-next" },
  { id: "previous-space", title: "Previous Space", keywords: "switch workspace", run: "previousSpace", key: "halcyon-key-space-prev" },
  { id: "downloads", title: "Downloads", keywords: "files", command: "Tools:Downloads", key: "key_openDownloads" },
  { id: "history", title: "Show All History", keywords: "library visited", command: "Browser:ShowAllHistory", key: "showAllHistoryKb" },
  { id: "bookmarks", title: "Show All Bookmarks", keywords: "library manage", command: "Browser:ShowAllBookmarks", key: "manBookmarkKb" },
  { id: "addons", title: "Add-ons and Themes", keywords: "extensions plugins", command: "Tools:Addons", key: "key_openAddons" },
  { id: "clear-history", title: "Clear Recent History", keywords: "delete forget privacy cookies cache", command: "Tools:Sanitize", key: "key_sanitize" },
  { id: "settings", title: "Settings", keywords: "preferences options", run: "openSettings", pane: "paneGeneral" },
  { id: "settings-privacy", title: "Privacy & Security Settings", keywords: "preferences tracking protection shield fingerprinting https", run: "openSettings", pane: "privacy-trackingprotection" },
  { id: "settings-cookies", title: "Cookies and Site Data", keywords: "settings storage clear data cache", run: "openSettings", pane: "privacy-sitedata" },
  { id: "settings-permissions", title: "Site Permissions", keywords: "settings camera microphone location notifications pop-ups autoplay", run: "openSettings", pane: "privacy-permissions" },
  { id: "settings-search", title: "Search Settings", keywords: "default search engine shortcuts suggestions", run: "openSettings", pane: "search" },
  { id: "settings-home", title: "Home and New Tab Settings", keywords: "homepage startup new tab", run: "openSettings", pane: "paneHome" },
  { id: "settings-sync", title: "Sync Settings", keywords: "account firefox sync devices", run: "openSettings", pane: "sync" },
  { id: "settings-containers", title: "Container Settings", keywords: "containers identities", run: "openSettings", pane: "paneContainers" },
  { id: "passwords", title: "Passwords", keywords: "logins saved passwords credentials", run: "openPage", url: "about:logins" },
  { id: "close-duplicates", title: "Close Duplicate Tabs", keywords: "duplicates merge same page tidy clean up", run: "closeDuplicates" },
  { id: "shortcuts", title: "Keyboard Shortcuts", keywords: "keys hotkeys bindings customise customize", run: "editShortcuts" },
]);

export function actionById(id) {
  return ACTIONS.find(a => a.id == id);
}

// ---- duplicate tabs ----------------------------------------------------------------------

/** The address two tabs must share to count as duplicates: the URL without its #fragment. */
export function duplicateKey(url) {
  const u = String(url ?? "");
  if (!u || /^about:(blank|newtab|home)$/.test(u)) {
    return "";
  }
  return u.replace(/#.*$/, "");
}

/**
 * Which tabs to close so each page stays open once. Kept per page: an Essential, else a pinned
 * tab, else the selected tab, else the most recently used one.
 *
 * @param {{url: string, essential?: boolean, pinned?: boolean, selected?: boolean, lastAccessed?: number}[]} tabs
 * @returns {{keep: object, close: object[]}[]} one entry per page that's open more than once
 */
export function findDuplicates(tabs) {
  const groups = new Map();
  for (const tab of tabs) {
    const key = duplicateKey(tab.url);
    if (key) {
      groups.set(key, [...(groups.get(key) ?? []), tab]);
    }
  }
  const rank = t => [t.essential ? 1 : 0, t.pinned ? 1 : 0, t.selected ? 1 : 0, t.lastAccessed ?? 0];
  const better = (a, b) => {
    const [ra, rb] = [rank(a), rank(b)];
    for (let i = 0; i < ra.length; i++) {
      if (ra[i] != rb[i]) {
        return ra[i] > rb[i];
      }
    }
    return false;
  };
  const out = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const keep = group.reduce((best, t) => (better(t, best) ? t : best));
    // Essentials and pinned tabs are never closed, even when they repeat.
    out.push({ keep, close: group.filter(t => t != keep && !t.essential && !t.pinned) });
  }
  return out.filter(g => g.close.length);
}

// ---- result ordering ---------------------------------------------------------------------

/** A hit this good goes above the "Search" row: the user is clearly spelling out this item. */
export const STRONG_SCORE = 150;

/**
 * The rows to show, in order.
 *
 * @param {object} p
 * @param {string} p.query     what was typed (after the filter)
 * @param {object[]} p.hits    [{entry, score}] from the index, best first
 * @param {boolean} p.filtered a filter is active (no search or address rows then)
 * @param {boolean} p.isURL    the query looks like an address
 */
export function arrangeRows({ query, hits, filtered = false, isURL = false, max = MAX_ROWS }) {
  const rows = hits.map(h => ({ type: "entry", entry: h.entry, score: h.score }));
  if (filtered || !query) {
    return rows.slice(0, max);
  }
  const special = isURL ? { type: "url", text: query } : { type: "search", text: query };
  // Something open, or something you can do, that matches well beats a web search; so does an
  // item whose title or site you're spelling out. An address always comes first.
  let at = 0;
  if (!isURL) {
    while (
      at < rows.length &&
      at < 2 &&
      (rows[at].score >= STRONG_SCORE ||
        (rows[at].entry.kind != KIND.history && rows[at].entry.kind != KIND.bookmark && rows[at].score >= STRONG_SCORE - 40))
    ) {
      at++;
    }
  }
  rows.splice(at, 0, special);
  return rows.slice(0, max);
}

// ---- keyboard shortcuts ------------------------------------------------------------------

const NAMED_KEYS = {
  ArrowLeft: "VK_LEFT",
  ArrowRight: "VK_RIGHT",
  ArrowUp: "VK_UP",
  ArrowDown: "VK_DOWN",
  PageUp: "VK_PAGE_UP",
  PageDown: "VK_PAGE_DOWN",
  Home: "VK_HOME",
  End: "VK_END",
  Delete: "VK_DELETE",
  Backspace: "VK_BACK",
  Insert: "VK_INSERT",
  Enter: "VK_RETURN",
  Tab: "VK_TAB",
  Escape: "VK_ESCAPE",
  " ": "VK_SPACE",
};
for (let i = 1; i <= 24; i++) {
  NAMED_KEYS[`F${i}`] = `VK_F${i}`;
}
Object.freeze(NAMED_KEYS);

const KEY_LABELS = Object.freeze({
  VK_LEFT: "←",
  VK_RIGHT: "→",
  VK_UP: "↑",
  VK_DOWN: "↓",
  VK_PAGE_UP: "Page Up",
  VK_PAGE_DOWN: "Page Down",
  VK_HOME: "Home",
  VK_END: "End",
  VK_DELETE: "Delete",
  VK_BACK: "Backspace",
  VK_INSERT: "Insert",
  VK_RETURN: "Enter",
  VK_TAB: "Tab",
  VK_ESCAPE: "Esc",
  VK_SPACE: "Space",
});

const MODIFIER_ORDER = ["accel", "control", "alt", "shift"];

/**
 * Canonical shortcut text: modifiers in a fixed order, then the key, joined by "+", e.g.
 * "accel+shift+K" or "alt+VK_LEFT". "accel" is Cmd on macOS and Ctrl elsewhere; "control" is
 * the Ctrl key on macOS (elsewhere it is the same as accel).
 *
 * @returns {{modifiers: string[], key: string, keycode: string}|null}
 */
export function parseShortcut(text, { mac = false } = {}) {
  if (!text || typeof text != "string") {
    return null;
  }
  const parts = text.split("+").map(p => p.trim());
  // "accel++" means the plus key.
  if (text.endsWith("++")) {
    parts.splice(parts.length - 2, 2, "+");
  }
  const keyPart = parts.pop();
  if (!keyPart) {
    return null;
  }
  const modifiers = new Set();
  for (const raw of parts) {
    let m = raw.toLowerCase();
    if (m == "ctrl" || m == "control") {
      m = mac ? "control" : "accel";
    } else if (m == "cmd" || m == "meta" || m == "command") {
      m = "accel";
    } else if (m == "option" || m == "opt") {
      m = "alt";
    }
    if (!MODIFIER_ORDER.includes(m)) {
      return null;
    }
    modifiers.add(m);
  }
  let key = "";
  let keycode = "";
  if (/^VK_[A-Z0-9_]+$/.test(keyPart)) {
    keycode = keyPart;
  } else if (NAMED_KEYS[keyPart]) {
    keycode = NAMED_KEYS[keyPart];
  } else if ([...keyPart].length == 1) {
    key = keyPart.toUpperCase();
  } else {
    return null;
  }
  return { modifiers: MODIFIER_ORDER.filter(m => modifiers.has(m)), key, keycode };
}

export function formatShortcut(parsed) {
  if (!parsed) {
    return "";
  }
  return [...parsed.modifiers, parsed.key || parsed.keycode].join("+");
}

/** Canonical form of any shortcut text ("" if invalid). */
export function normalizeShortcut(text, options) {
  return formatShortcut(parseShortcut(text, options));
}

/** For people: "Ctrl+Shift+K", or "⌘⇧K" on macOS. */
export function displayShortcut(text, { mac = false } = {}) {
  const parsed = typeof text == "string" ? parseShortcut(text, { mac }) : text;
  if (!parsed) {
    return "";
  }
  const keyLabel = parsed.key || KEY_LABELS[parsed.keycode] || parsed.keycode.replace(/^VK_/, "");
  if (mac) {
    const symbols = { control: "⌃", alt: "⌥", shift: "⇧", accel: "⌘" };
    // macOS order: Control, Option, Shift, Command.
    const order = ["control", "alt", "shift", "accel"];
    return order.filter(m => parsed.modifiers.includes(m)).map(m => symbols[m]).join("") + keyLabel;
  }
  const names = { accel: "Ctrl", control: "Ctrl", alt: "Alt", shift: "Shift" };
  return [...parsed.modifiers.map(m => names[m]), keyLabel].join("+");
}

/**
 * A shortcut from a keydown event, for recording. Returns "" while only modifiers are held,
 * or for keys a shortcut can't use alone.
 *
 * @returns {{shortcut: string, error: string}}
 */
export function shortcutFromEvent(event, { mac = false } = {}) {
  const { key, code } = event;
  if (["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Fn"].includes(key)) {
    return { shortcut: "", error: "" };
  }
  const modifiers = [];
  if (mac ? event.metaKey : event.ctrlKey) {
    modifiers.push("accel");
  }
  if (mac && event.ctrlKey) {
    modifiers.push("control");
  }
  if (event.altKey) {
    modifiers.push("alt");
  }
  if (event.shiftKey) {
    modifiers.push("shift");
  }
  let keyName = NAMED_KEYS[key] ?? "";
  let letter = "";
  if (!keyName) {
    // Use the physical key for letters and digits, so Shift or Option don't change them.
    const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(code ?? "");
    letter = m ? m[1] || m[2] : [...(key ?? "")].length == 1 ? key.toUpperCase() : "";
  }
  if (!keyName && !letter) {
    return { shortcut: "", error: "That key can't be used in a shortcut." };
  }
  if (["VK_ESCAPE", "VK_RETURN", "VK_TAB"].includes(keyName) && !modifiers.length) {
    return { shortcut: "", error: "" };
  }
  const isFunctionKey = /^VK_F\d+$/.test(keyName);
  const onlyShift = modifiers.length == 1 && modifiers[0] == "shift";
  if (!isFunctionKey && (!modifiers.length || (onlyShift && letter))) {
    return { shortcut: "", error: "Add Ctrl, Alt or Cmd so the key still types normally." };
  }
  return { shortcut: formatShortcut({ modifiers, key: letter, keycode: keyName }), error: "" };
}

/** The canonical shortcut of a XUL <key>'s attributes, or "" if it has none. */
export function shortcutOfKey({ key, keycode, modifiers }, { mac = false } = {}) {
  if (!key && !keycode) {
    return "";
  }
  const mods = String(modifiers ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(m => m.toLowerCase())
    .filter(m => m != "any")
    .map(m => (m == "meta" || m == "os" ? "accel" : m == "control" && !mac ? "accel" : m));
  if (mods.some(m => !MODIFIER_ORDER.includes(m))) {
    return "";
  }
  return formatShortcut({
    modifiers: MODIFIER_ORDER.filter(m => mods.includes(m)),
    key: key ? key.toUpperCase() : "",
    keycode: key ? "" : keycode,
  });
}

/**
 * Keys already using a shortcut.
 *
 * @param {string} shortcut canonical
 * @param {{id: string, label: string, shortcut: string, disabled?: boolean}[]} keys
 */
export function findConflicts(shortcut, keys) {
  return keys.filter(k => k.shortcut && !k.disabled && k.shortcut == shortcut);
}

/**
 * The user's shortcuts from the pref: { actionId: "accel+shift+K" }. Unknown actions and
 * invalid shortcuts are dropped; an empty string means "no shortcut" (removes a default).
 */
export function readShortcuts(json, { mac = false } = {}) {
  let data;
  try {
    data = JSON.parse(json || "{}");
  } catch {
    return {};
  }
  const out = {};
  if (!data || typeof data != "object" || Array.isArray(data)) {
    return out;
  }
  for (const [id, value] of Object.entries(data)) {
    if (!actionById(id) || typeof value != "string") {
      continue;
    }
    out[id] = value === "" ? "" : normalizeShortcut(value, { mac });
    if (out[id] === "" && value !== "") {
      delete out[id];
    }
  }
  return out;
}

/** Defaults merged with the user's choices: { actionId: canonical shortcut }. */
export function effectiveShortcuts(user, { mac = false } = {}) {
  const out = {};
  for (const action of ACTIONS) {
    if (action.shortcut) {
      out[action.id] = normalizeShortcut(action.shortcut, { mac });
    }
  }
  for (const [id, value] of Object.entries(user)) {
    if (value) {
      out[id] = value;
    } else {
      delete out[id];
    }
  }
  return out;
}
