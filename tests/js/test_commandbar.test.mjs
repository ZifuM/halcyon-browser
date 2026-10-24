// Tests for the command bar: input parsing, result order, shortcuts (logic and the per-window
// keyset), and the shared index (history, bookmarks, Places notifications, tabs, Spaces).
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// ---- Firefox module mocks -------------------------------------------------------------------

const placesListeners = [];
ChromeUtils._preload("resource://gre/modules/PlacesUtils.sys.mjs", {
  PlacesUtils: {
    bookmarks: { TYPE_BOOKMARK: 1 },
    observers: {
      addListener: (types, fn) => placesListeners.push({ types, fn }),
      removeListener: (types, fn) => placesListeners.splice(placesListeners.findIndex(l => l.fn == fn), 1),
    },
    promiseLargeCacheDBConnection: async () => ({
      execute: async (sql, params, onRow) => {
        globalThis.__lastPlacesQuery = { sql, params };
        for (const row of globalThis.__placesRows ?? []) {
          onRow({ getResultByName: name => row[name] });
        }
      },
    }),
  },
});
const tracker = { windows: [] };
ChromeUtils._preload("resource:///modules/BrowserWindowTracker.sys.mjs", {
  BrowserWindowTracker: {
    get orderedWindows() {
      return tracker.windows;
    },
  },
});
ChromeUtils._preload("resource://gre/modules/PrivateBrowsingUtils.sys.mjs", {
  PrivateBrowsingUtils: { isWindowPrivate: w => !!w.isPrivate },
});
ChromeUtils._preload("resource://gre/modules/ContextualIdentityService.sys.mjs", {
  ContextualIdentityService: { getPublicIdentities: () => [], getUserContextLabel: () => "" },
});

const Logic = await import("moz-src:///browser/components/halcyon/commandbar/HalcyonCommandLogic.sys.mjs");
const { OmniIndex, SimpleIndex } = await import("moz-src:///browser/components/halcyon/commandbar/OmniIndex.sys.mjs");
const { HalcyonCommandIndex: Index } = await import(
  "moz-src:///browser/components/halcyon/commandbar/HalcyonCommandIndex.sys.mjs"
);
const { HalcyonShortcuts } = await import("moz-src:///browser/components/halcyon/commandbar/HalcyonShortcuts.sys.mjs");
const { HalcyonSpacesStore: Spaces } = await import(
  "moz-src:///browser/components/halcyon/spaces/HalcyonSpacesStore.sys.mjs"
);
const { KIND } = Logic;
Spaces.create({ name: "Work", icon: "💼" });

const wasmBytes = await readFile(
  fileURLToPath(new URL("../../src/browser/components/halcyon/commandbar/omni_index.wasm", import.meta.url))
);

// ---- input -----------------------------------------------------------------------------------

test("filters: @tokens, > for actions, and hints while typing one", () => {
  assert.deepEqual(
    (({ query, kinds }) => ({ query, kinds }))(Logic.parseInput("@tabs github")),
    { query: "github", kinds: 1 << KIND.tab }
  );
  assert.equal(Logic.parseInput("@TABS").filter.token, "@tabs");
  assert.equal(Logic.parseInput("> zoom").query, "zoom");
  assert.equal(Logic.parseInput("> zoom").kinds, (1 << KIND.action) | (1 << KIND.space));
  assert.deepEqual(Logic.parseInput("@b").filterHint.map(f => f.token), ["@bookmarks"]);
  assert.equal(Logic.parseInput("@").filterHint.length, Logic.FILTERS.length);
  const plain = Logic.parseInput("  email @work  ");
  assert.equal(plain.query, "email @work");
  assert.equal(plain.kinds, Logic.ALL_KINDS);
  assert.equal(Logic.parseInput("@nothing here").filter, null);
});

test("addresses versus searches", () => {
  for (const url of ["example.com", "sub.example.co.uk/path?q=1", "https://x", "about:config", "localhost:8080", "127.0.0.1/a", "[::1]:3000", "view-source:https://a.b"]) {
    assert.ok(Logic.looksLikeURL(url), url);
  }
  for (const text of ["hello", "how to cook rice", "foo.bar baz", "file", "", "e.g"]) {
    assert.ok(!Logic.looksLikeURL(text), text);
  }
  const isKnownSuffix = host => /\.(com|uk|org)$/.test(host);
  assert.ok(!Logic.looksLikeURL("node.js", { isKnownSuffix }), "not a real suffix: a search");
  assert.ok(Logic.looksLikeURL("nodejs.org/en", { isKnownSuffix }));
  assert.ok(Logic.looksLikeURL("localhost:3000", { isKnownSuffix }));
  assert.equal(Logic.toURL("example.com"), "https://example.com");
  assert.equal(Logic.toURL("localhost:3000"), "http://localhost:3000");
  assert.equal(Logic.toURL("about:config"), "about:config");
});

test("ranking inputs", () => {
  assert.equal(Logic.boostFromFrecency(0, 1000), 0);
  assert.equal(Logic.boostFromFrecency(1000, 1000), 100);
  assert.ok(Logic.boostFromFrecency(30, 1000) > 40, "log scale lifts the middle");
  assert.equal(Logic.boostFromFrecency(-1, 1000), 0);
  const now = Date.UTC(2026, 9, 1);
  assert.equal(Math.round(Logic.ageDays((now - 2 * 86400000) * 1000, now)), 2);
  assert.equal(Logic.ageDays(0, now), 365);
  assert.ok(!Logic.indexable("place:sort=8"));
  assert.ok(!Logic.indexable("javascript:alert(1)"));
  assert.ok(!Logic.indexable("about:newtab"));
  assert.ok(Logic.indexable("about:config"));
});

test("rows: search first unless something matches strongly; addresses always first", () => {
  const e = (kind, score) => ({ entry: { kind, title: "x" }, score });
  const weak = Logic.arrangeRows({ query: "rice", hits: [e(KIND.history, 90), e(KIND.history, 80)] });
  assert.deepEqual(weak.map(r => r.type), ["search", "entry", "entry"]);
  const strong = Logic.arrangeRows({ query: "git", hits: [e(KIND.tab, 200), e(KIND.history, 160), e(KIND.history, 150)] });
  assert.deepEqual(strong.map(r => r.type), ["entry", "entry", "search", "entry"]);
  const action = Logic.arrangeRows({ query: "zoom", hits: [e(KIND.action, 115)] });
  assert.equal(action[0].type, "entry");
  const url = Logic.arrangeRows({ query: "github.com", hits: [e(KIND.tab, 300)], isURL: true });
  assert.equal(url[0].type, "url");
  const filtered = Logic.arrangeRows({ query: "git", hits: [e(KIND.tab, 10)], filtered: true });
  assert.deepEqual(filtered.map(r => r.type), ["entry"]);
  assert.equal(Logic.arrangeRows({ query: "a", hits: Array.from({ length: 20 }, () => e(KIND.history, 1)) }).length, Logic.MAX_ROWS);
});

test("actions: unique ids, and every one is runnable", () => {
  const ids = Logic.ACTIONS.map(a => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of Logic.ACTIONS) {
    assert.ok(a.command || a.run, a.id);
    assert.ok(a.title && a.keywords, a.id);
  }
});

// ---- shortcuts (logic) -------------------------------------------------------------------------

test("shortcut text: parse, normalise, display", () => {
  assert.equal(Logic.normalizeShortcut("Ctrl+Shift+k"), "accel+shift+K");
  assert.equal(Logic.normalizeShortcut("shift+ctrl+K"), "accel+shift+K");
  assert.equal(Logic.normalizeShortcut("Ctrl+Shift+k", { mac: true }), "control+shift+K");
  assert.equal(Logic.normalizeShortcut("Cmd+Option+ArrowLeft", { mac: true }), "accel+alt+VK_LEFT");
  assert.equal(Logic.normalizeShortcut("F5"), "VK_F5");
  assert.equal(Logic.normalizeShortcut("accel++"), "accel++");
  assert.equal(Logic.normalizeShortcut("Hyper+K"), "");
  assert.equal(Logic.normalizeShortcut("Ctrl+Banana"), "");
  assert.equal(Logic.displayShortcut("accel+shift+K"), "Ctrl+Shift+K");
  assert.equal(Logic.displayShortcut("accel+shift+K", { mac: true }), "⇧⌘K");
  assert.equal(Logic.displayShortcut("accel+alt+VK_LEFT", { mac: true }), "⌥⌘←");
  assert.equal(Logic.displayShortcut("alt+VK_F4"), "Alt+F4");
});

test("recording a shortcut from key events", () => {
  const ev = (key, code, mods = {}) => ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(Logic.shortcutFromEvent(ev("k", "KeyK", { ctrlKey: true, shiftKey: true })).shortcut, "accel+shift+K");
  assert.equal(Logic.shortcutFromEvent(ev("˚", "KeyK", { metaKey: true, altKey: true }), { mac: true }).shortcut, "accel+alt+K");
  assert.equal(Logic.shortcutFromEvent(ev("Control", "ControlLeft", { ctrlKey: true })).shortcut, "");
  assert.equal(Logic.shortcutFromEvent(ev("F7", "F7")).shortcut, "VK_F7");
  assert.equal(Logic.shortcutFromEvent(ev("!", "Digit1", { shiftKey: true, ctrlKey: true })).shortcut, "accel+shift+1");
  const bare = Logic.shortcutFromEvent(ev("k", "KeyK"));
  assert.equal(bare.shortcut, "");
  assert.match(bare.error, /Ctrl, Alt or Cmd/);
  assert.match(Logic.shortcutFromEvent(ev("K", "KeyK", { shiftKey: true })).error, /Ctrl/);
  assert.equal(Logic.shortcutFromEvent(ev("Escape", "Escape")).shortcut, "");
  assert.equal(Logic.shortcutFromEvent(ev("ArrowLeft", "ArrowLeft", { altKey: true })).shortcut, "alt+VK_LEFT");
});

test("XUL keys, conflicts and the pref", () => {
  assert.equal(Logic.shortcutOfKey({ key: "r", modifiers: "accel" }), "accel+R");
  assert.equal(Logic.shortcutOfKey({ keycode: "VK_F5" }), "VK_F5");
  assert.equal(Logic.shortcutOfKey({ key: "t", modifiers: "control, shift" }), "accel+shift+T");
  assert.equal(Logic.shortcutOfKey({ key: "t", modifiers: "control,shift" }, { mac: true }), "control+shift+T");
  assert.equal(Logic.shortcutOfKey({ modifiers: "accel" }), "");
  const keys = [
    { id: "a", shortcut: "accel+R", label: "Reload" },
    { id: "b", shortcut: "accel+R", label: "Off", disabled: true },
  ];
  assert.deepEqual(Logic.findConflicts("accel+R", keys).map(k => k.id), ["a"]);
  assert.deepEqual(Logic.readShortcuts('{"copy-link":"Ctrl+Shift+U","nope":"Ctrl+X","reload":"Ctrl+Banana","find":""}'), {
    "copy-link": "accel+shift+U",
    find: "",
  });
  assert.deepEqual(Logic.readShortcuts("not json"), {});
  assert.deepEqual(Logic.readShortcuts("[1]"), {});
  assert.deepEqual(Logic.effectiveShortcuts({ "copy-link": "accel+shift+U", find: "" }), { "copy-link": "accel+shift+U" });
});

// ---- shortcuts (window keyset) -----------------------------------------------------------------

class FakeElement {
  constructor(doc, tag) {
    this.doc = doc;
    this.localName = tag;
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this.listeners = {};
  }
  get id() {
    return this.attrs.get("id") ?? "";
  }
  set id(v) {
    this.attrs.set("id", v);
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
  closest(selector) {
    const id = selector.replace(/^#/, "");
    for (let n = this; n; n = n.parent) {
      if (n.id == id) return n;
    }
    return null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] ?? []) fn({ type, currentTarget: this });
  }
  *walk() {
    for (const c of this.children) {
      yield c;
      yield* c.walk();
    }
  }
}

function fakeWindow(keys) {
  const doc = {
    documentElement: null,
    createXULElement: tag => new FakeElement(doc, tag),
    getElementById: id => [...doc.documentElement.walk()].find(n => n.id == id) ?? null,
    querySelectorAll: sel => {
      const m = /^key\[(.+)\]$/.exec(sel);
      return [...doc.documentElement.walk()].filter(n => n.localName == "key" && (!m || n.hasAttribute(m[1])));
    },
    querySelector: sel => {
      const m = /menuitem\[key="([^"]+)"\]/.exec(sel);
      return m ? ([...doc.documentElement.walk()].find(n => n.localName == "menuitem" && n.getAttribute("key") == m[1]) ?? null) : null;
    },
  };
  doc.documentElement = new FakeElement(doc, "window");
  const keyset = new FakeElement(doc, "keyset");
  for (const attrs of keys) {
    const k = new FakeElement(doc, attrs.tag ?? "key");
    for (const [a, v] of Object.entries(attrs)) if (a != "tag") k.setAttribute(a, v);
    keyset.append(k);
  }
  doc.documentElement.append(keyset);
  return { document: doc, CSS: { escape: s => s } };
}

test("shortcuts: keyset from the pref, Firefox keys given back when removed", () => {
  Services.prefs._reset();
  const win = fakeWindow([
    { id: "key_reload", key: "R", modifiers: "accel", command: "Browser:Reload" },
    { id: "key_find", key: "F", modifiers: "accel", command: "cmd_find" },
    { tag: "menuitem", key: "key_reload", label: "Reload" },
  ]);
  const ran = [];
  const shortcuts = new HalcyonShortcuts(win, { run: id => ran.push(id) });
  shortcuts.init();
  assert.equal(win.document.getElementById("halcyon-shortcuts-keyset"), null, "no shortcuts, no keyset");
  assert.equal(shortcuts.displayFor(Logic.actionById("find")), "Ctrl+F", "Firefox's own shortcut is shown");

  // A new shortcut nobody uses.
  assert.deepEqual(shortcuts.conflictsFor("accel+shift+U", "copy-link"), []);
  shortcuts.set("copy-link", "accel+shift+U");
  shortcuts.build(); // the fake prefs don't notify observers of string prefs
  const key = win.document.getElementById("halcyon-shortcut-copy-link");
  assert.equal(key.getAttribute("key"), "U");
  assert.equal(key.getAttribute("modifiers"), "accel,shift");
  key.fire("command");
  assert.deepEqual(ran, ["copy-link"]);
  assert.equal(shortcuts.displayFor(Logic.actionById("copy-link")), "Ctrl+Shift+U");

  // Taking Firefox's Ctrl+R: reported, then Firefox's key is disabled while ours exists.
  assert.deepEqual(shortcuts.conflictsFor("accel+R", "copy-link").map(c => c.label), ["Reload"]);
  assert.deepEqual(shortcuts.conflictsFor("accel+R", "reload"), [], "an action's own Firefox key isn't a conflict");
  shortcuts.set("copy-link", "accel+R");
  shortcuts.build();
  assert.equal(win.document.getElementById("key_reload").getAttribute("disabled"), "true");
  assert.equal(shortcuts.displayFor(Logic.actionById("reload")), "", "Reload's key is off while taken");

  // Moving a shortcut to another action takes it from the first.
  shortcuts.set("find", "accel+R");
  shortcuts.build();
  assert.deepEqual(shortcuts.effective, { find: "accel+R" });

  // Removing it gives Ctrl+R back to Firefox.
  shortcuts.set("find", "");
  shortcuts.build();
  assert.equal(win.document.getElementById("key_reload").getAttribute("disabled"), null);
  assert.equal(win.document.getElementById("halcyon-shortcuts-keyset"), null);
  assert.equal(shortcuts.displayFor(Logic.actionById("find")), "Ctrl+F", "Firefox's own key shows again");
  shortcuts.uninit();
});

// ---- the shared index --------------------------------------------------------------------------

function fakeTab(label, url, extra = {}) {
  return { label, linkedBrowser: { currentURI: { spec: url } }, lastAccessed: Date.now(), getAttribute: () => null, ...extra };
}

const rows = [
  { url: "https://github.com/", title: "GitHub", frecency: 5000, visited: Date.now() * 1000, bookmarked: true },
  { url: "https://news.example/", title: "Daily News", frecency: 3000, visited: Date.now() * 1000, bookmarked: false },
  { url: "https://rust-lang.org/", title: "Rust", frecency: 100, visited: 0, bookmarked: false },
  { url: "place:sort=8", title: "Most Visited", frecency: 0, visited: 0, bookmarked: true },
];

for (const [name, makeIndex] of [
  ["wasm", () => OmniIndex.fromBytes(wasmBytes)],
  ["fallback", async () => new SimpleIndex()],
]) {
  test(`index (${name}): history, bookmarks, actions and Spaces load and search`, async () => {
    Index._reset();
    placesListeners.length = 0;
    globalThis.__placesRows = rows;
    await Index.ready({ index: await makeIndex() });
    assert.equal(globalThis.__lastPlacesQuery.params.limit, Logic.DEFAULT_HISTORY_LIMIT);
    assert.equal(placesListeners.length, 1);
    const kinds = q => Index.search(q).map(h => [h.entry.kind, h.entry.title]);
    assert.deepEqual(kinds("github")[0], [KIND.bookmark, "GitHub"]);
    assert.deepEqual(kinds("daily"), [[KIND.history, "Daily News"]]);
    assert.deepEqual(kinds("most visited"), [], "place: queries are skipped");
    assert.deepEqual(kinds("zoom in")[0], [KIND.action, "Zoom In"]);
    assert.deepEqual(kinds("work")[0], [KIND.space, "Work"]);
    assert.ok(Index.search("bigger")[0].entry.data.action.id == "zoom-in", "keywords match");
  });

  test(`index (${name}): kept current from Places notifications`, async () => {
    Index._reset();
    placesListeners.length = 0;
    globalThis.__placesRows = rows;
    await Index.ready({ index: await makeIndex() });
    const send = (...events) => placesListeners[0].fn(events);
    send({ type: "page-visited", url: "https://new.example/", lastKnownTitle: "Brand New", visitCount: 1 });
    assert.equal(Index.search("brand")[0].entry.url, "https://new.example/");
    send({ type: "page-title-changed", url: "https://new.example/", title: "Renamed Page" });
    assert.deepEqual(Index.search("brand"), []);
    assert.equal(Index.search("renamed").length, 1);
    send({ type: "page-visited", url: "https://rust-lang.org/", visitCount: 9, hidden: true });
    send({ type: "bookmark-added", itemType: 1, url: "https://rust-lang.org/", title: "Rust Home" });
    assert.deepEqual(Index.search("rust").map(h => [h.entry.kind, h.entry.title]), [[KIND.bookmark, "Rust Home"]]);
    send({ type: "page-removed", url: "https://new.example/", isRemovedFromStore: true });
    assert.deepEqual(Index.search("renamed"), []);
    send({ type: "history-cleared" });
    assert.deepEqual(Index.search("daily"), []);
    assert.equal(Index.search("rust").length, 1, "bookmarks survive clearing history");
    send({ type: "bogus" }, { type: "page-visited" });
  });

  test(`index (${name}): tabs from the right windows, with their Space`, async () => {
    Index._reset();
    globalThis.__placesRows = [];
    await Index.ready({ index: await makeIndex() });
    const current = fakeTab("Current", "https://current.example/", { selected: true });
    const mail = fakeTab("Inbox", "https://mail.example/", { getAttribute: () => "s2" });
    const secret = fakeTab("Secret", "https://secret.example/");
    const normal = { gBrowser: { tabs: [current, mail] } };
    const priv = { isPrivate: true, gBrowser: { tabs: [secret] } };
    tracker.windows = [normal, priv];
    Index.refreshTabs(normal, tab => (tab == mail ? "Work" : ""));
    assert.deepEqual(Index.search("inbox").map(h => h.entry.data.space), ["Work"]);
    assert.deepEqual(Index.search("current"), [], "the tab you're on isn't offered");
    assert.deepEqual(Index.search("secret"), [], "private tabs stay out of normal windows");
    Index.refreshTabs(priv);
    assert.deepEqual(Index.search("inbox"), []);
    Index.forgetTabs();
    assert.deepEqual(Index.search("secret"), []);
  });
}

test("index: compacts after many tab refreshes, keeping everything findable", async () => {
  Index._reset();
  globalThis.__placesRows = rows;
  await Index.ready({ index: await OmniIndex.fromBytes(wasmBytes) });
  const tabs = Array.from({ length: 300 }, (_, i) => fakeTab(`Tab ${i}`, `https://t${i}.example/`));
  const win = { gBrowser: { tabs } };
  tracker.windows = [win];
  let compacted = false;
  for (let i = 0; i < 80 && !compacted; i++) {
    Index.refreshTabs(win);
    Index._dropAll("t:");
    compacted = Index.compactIfNeeded();
  }
  assert.ok(compacted);
  assert.equal(Index.search("daily")[0].entry.title, "Daily News");
  assert.equal(Index.search("zoom in")[0].entry.title, "Zoom In");
  assert.ok(Index._added < 200);
});

test("index: a reload updates entries in place and drops what's gone", async t => {
  // The Timer mock doesn't keep Node alive; the chunked load waits on it.
  const keepAlive = globalThis.setInterval(() => {}, 1000);
  t.after(() => globalThis.clearInterval(keepAlive));
  Index._reset();
  globalThis.__placesRows = rows;
  await Index.ready({ index: await OmniIndex.fromBytes(wasmBytes) });
  const before = Index.search("daily")[0].entry.id;
  await Index.replacePlaces([
    { ...rows[1], frecency: 9000 },
    { url: "https://later.example/", title: "Added Later", frecency: 10, visited: 0, bookmarked: false },
    { ...rows[0], bookmarked: false },
  ]);
  assert.equal(Index.search("daily")[0].entry.id, before, "same entry, new score");
  assert.equal(Index.search("added later").length, 1);
  assert.deepEqual(Index.search("rust"), [], "gone from Places, gone from the index");
  assert.equal(Index.search("github")[0].entry.kind, KIND.history, "no longer bookmarked");
  // Big loads take breaks but finish.
  const many = Array.from({ length: 9000 }, (_, i) => ({ url: `https://m${i}.example/`, title: `Many ${i}`, frecency: i, visited: 0, bookmarked: false }));
  await Index.replacePlaces(many);
  assert.equal(Index.search("many 8999")[0].entry.title, "Many 8999");
});
