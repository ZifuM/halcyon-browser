// Tests for Spaces: the data model, the shared store, and the per-window controller against a
// fake tab strip (switching, membership, containers, launchers).
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const Logic = await import("moz-src:///browser/components/peryn/spaces/PerynSpacesLogic.sys.mjs");

// ---- Firefox module mocks -------------------------------------------------------------------

const tabValues = new Map();
const windowValues = new Map();
ChromeUtils._preload("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs", {
  SessionStore: {
    getCustomTabValue: (tab, key) => tabValues.get(tab)?.[key] ?? "",
    setCustomTabValue: (tab, key, value) => tabValues.set(tab, { ...tabValues.get(tab), [key]: value }),
    deleteCustomTabValue: (tab, key) => {
      const v = { ...tabValues.get(tab) };
      delete v[key];
      tabValues.set(tab, v);
    },
    getCustomWindowValue: (win, key) => windowValues.get(win)?.[key] ?? "",
    setCustomWindowValue: (win, key, value) => windowValues.set(win, { ...windowValues.get(win), [key]: value }),
  },
});
const tracker = { windows: [] };
ChromeUtils._preload("resource:///modules/BrowserWindowTracker.sys.mjs", {
  BrowserWindowTracker: {
    getTopWindow: () => tracker.windows[0],
    get orderedWindows() {
      return tracker.windows;
    },
  },
});
const identities = [];
ChromeUtils._preload("resource://gre/modules/ContextualIdentityService.sys.mjs", {
  ContextualIdentityService: {
    getPublicIdentities: () => identities,
    getUserContextLabel: id => identities.find(i => i.userContextId == id)?.name ?? "",
    create: (name, icon, color) => {
      const identity = { userContextId: identities.length + 1, name, icon, color };
      identities.push(identity);
      return identity;
    },
  },
});
globalThis.Services.startup = { shuttingDown: false };
globalThis.Services.prefs.removeObserver = () => {};

const { PerynSpacesStore: Store } = await import(
  "moz-src:///browser/components/peryn/spaces/PerynSpacesStore.sys.mjs"
);
const { PerynSpaces, SPACE_ATTR, PIN_ID_VALUE } = await import(
  "moz-src:///browser/components/peryn/spaces/PerynSpaces.sys.mjs"
);

let seq = 0;
const rnd = () => ((seq = (seq * 9301 + 49297) % 233280), seq / 233280);

// ---- data model -------------------------------------------------------------------------------

test("normalizeData repairs anything: garbage, duplicates, out-of-range colours, bad URLs", () => {
  assert.deepEqual(Logic.normalizeData("not json"), Logic.defaultData());
  assert.deepEqual(Logic.normalizeData({ spaces: [] }), Logic.defaultData());
  const data = Logic.normalizeData({
    spaces: [
      { id: "a", name: "  Work   stuff ", icon: "💼💼", color: { hue: 400, chroma: 9, grain: "yes" }, pins: [
        { id: "p1", url: "https://mail.example/", title: "Mail" },
        { id: "p1", url: "https://dup.example/" },
        { id: "p2", url: "javascript:alert(1)" },
      ] },
      { id: "a", name: "dup" },
      { name: "no id" },
      { id: "b", name: "", container: { name: " Work " } },
    ],
    essentials: [{ id: "p1", url: "https://again.example/" }, { id: "e1", url: "https://cal.example/" }],
  });
  assert.equal(data.spaces.length, 2);
  const [a, b] = data.spaces;
  assert.equal(a.name, "Work stuff");
  assert.equal(a.icon, "💼");
  assert.deepEqual(a.color, { hue: 40, hue2: 68, chroma: 0.12, grain: false });
  assert.deepEqual(a.pins.map(p => p.id), ["p1"]);
  assert.equal(b.name, "Space");
  assert.deepEqual(b.container, { name: "Work", icon: "circle", color: "blue" });
  assert.deepEqual(data.essentials.map(e => e.id), ["e1"], "launcher ids are unique across lists");
});

test("create, update, move, delete, neighbours", () => {
  let data = Logic.defaultData();
  const { data: d1, space } = Logic.createSpace(data, { name: "Work", icon: "💼" }, rnd);
  assert.equal(d1.spaces.length, 2);
  assert.equal(space.color.hue, 210, "next unused palette hue");
  assert.match(space.id, /^s-[a-z0-9]{10}$/);
  data = Logic.updateSpace(d1, space.id, { name: "Job", color: { hue: 10 } });
  assert.equal(Logic.findSpace(data, space.id).name, "Job");
  assert.equal(Logic.findSpace(data, space.id).color.hue, 10);
  assert.equal(Logic.findSpace(data, space.id).color.chroma, space.color.chroma, "partial colour patch keeps the rest");
  data = Logic.moveSpace(data, space.id, 0);
  assert.equal(data.spaces[0].id, space.id);
  assert.equal(Logic.neighbourSpace(data, space.id, -1), space.id, "stops at the start");
  assert.equal(Logic.neighbourSpace(data, space.id, 1), "s-personal");
  const { data: d2, fallback } = Logic.deleteSpace(data, "s-personal");
  assert.equal(fallback, space.id);
  assert.throws(() => Logic.deleteSpace(d2, space.id), /last Space/);
  assert.throws(() => Logic.updateSpace(d2, "nope", {}));
});

test("reconcileLaunchers: open what's missing here, release what's gone", () => {
  const data = Logic.normalizeData({
    spaces: [{ id: "s1", name: "A", pins: [{ id: "p1", url: "https://a/" }, { id: "p2", url: "https://b/" }] }],
    essentials: [{ id: "e1", url: "https://mail/" }],
  });
  const { open, release } = Logic.reconcileLaunchers(data, [
    { pinId: "p1", kind: "pin" },
    { pinId: "gone", kind: "pin" },
  ]);
  assert.deepEqual(open.map(o => [o.kind, o.spaceId, o.entry.id]), [["essential", null, "e1"], ["pin", "s1", "p2"]]);
  assert.deepEqual(release, ["gone"]);
});

test("SwipeTracker: one switch per swipe past the threshold, vertical scrolling ignored", () => {
  let now = 0;
  const s = new Logic.SwipeTracker({ threshold: 100, cooldownMs: 400, resetMs: 200, now: () => now });
  assert.equal(s.add(0, 50), 0, "vertical");
  assert.equal(s.add(60, 5), 0);
  now += 10;
  assert.equal(s.add(60, 5), 1);
  now += 10;
  assert.equal(s.add(200, 0), 0, "cooldown");
  now += 500;
  assert.equal(s.add(-120, 0), -1);
  now += 1000;
  assert.equal(s.add(60, 0), 0);
  now += 300; // pause: the partial swipe is forgotten
  assert.equal(s.add(60, 0), 0);
});

test("colour helpers", () => {
  assert.equal(Logic.hueFromPoint(0, -10), 0, "top");
  assert.equal(Logic.hueFromPoint(10, 0), 90, "right");
  assert.equal(Logic.hueFromPoint(0, 10), 180);
  assert.equal(Logic.hueFromPoint(-10, 0), 270);
  assert.deepEqual(Logic.colorVars({ hue: 10, hue2: 50, chroma: 0.05 }), {
    "--hx-space-hue": "10",
    "--hx-space-hue-2": "50",
    "--hx-space-chroma": "0.05",
  });
  assert.match(Logic.swatchCSS({ hue: 10 }), /^linear-gradient/);
  assert.equal(Logic.cleanIcon("  👩‍💻 rest"), "👩‍💻");
});

// ---- store ----------------------------------------------------------------------------------

beforeEach(() => {
  Services.prefs._reset();
  Store._reset();
  tabValues.clear();
  windowValues.clear();
  identities.length = 0;
  tracker.windows = [];
});

test("store: edits write the pref; other writers (Sync) notify windows; own writes don't echo", () => {
  const changes = [];
  Store.subscribe((data, change) => changes.push(change));
  const space = Store.create({ name: "Work" });
  assert.equal(JSON.parse(Services.prefs.getStringPref("peryn.spaces")).spaces.length, 2);
  Store.observe(null, "nsPref:changed", "peryn.spaces"); // the echo of our own write
  assert.deepEqual(changes, [{ created: space.id }]);

  // Sync replaces the pref.
  Services.prefs.setStringPref("peryn.spaces", JSON.stringify({ spaces: [{ id: "x", name: "From laptop" }] }));
  Store.observe(null, "nsPref:changed", "peryn.spaces");
  assert.deepEqual(changes.at(-1), { external: true });
  assert.deepEqual(Store.spaces.map(s => s.name), ["From laptop"]);
});

test("store: a Space's container is matched by name on this machine, created if missing", () => {
  identities.push({ userContextId: 7, name: "Work", icon: "briefcase", color: "orange" });
  const work = Store.create({ name: "Work", container: { name: "Work" } });
  assert.equal(Store.userContextIdFor(work), 7);
  const bank = Store.create({ name: "Bank", container: { name: "Banking", icon: "dollar", color: "green" } });
  const id = Store.userContextIdFor(bank);
  assert.equal(identities.find(i => i.userContextId == id).name, "Banking");
  assert.equal(Store.userContextIdFor(Store.spaces[0]), 0, "no container");
});

test("store: pins move between Spaces; Essentials add and remove", () => {
  const work = Store.create({ name: "Work" });
  Store.addPin("s-personal", { id: "p1", url: "https://a/", title: "A" });
  Store.movePin("p1", work.id);
  assert.equal(Store.get("s-personal").pins.length, 0);
  assert.deepEqual(Store.get(work.id).pins.map(p => p.id), ["p1"]);
  Store.removePin("p1");
  assert.equal(Store.get(work.id).pins.length, 0);
  Store.addEssential({ id: "e1", url: "https://mail/", title: "Mail" });
  Store.removeEssential("e1");
  assert.equal(Store.data.essentials.length, 0);
});

// ---- controller (fake window) ----------------------------------------------------------------

class FakeTab {
  constructor(url, { pinned = false } = {}) {
    this.url = url;
    this.label = url;
    this.pinned = pinned;
    this.hidden = false;
    this.selected = false;
    this.closing = false;
    this.lastAccessed = 0;
    this.attrs = new Map();
    this.linkedBrowser = { currentURI: { spec: url } };
  }
  getAttribute(a) {
    return this.attrs.get(a) ?? null;
  }
  setAttribute(a, v) {
    this.attrs.set(a, String(v));
  }
  removeAttribute(a) {
    this.attrs.delete(a);
  }
  hasAttribute(a) {
    return this.attrs.has(a);
  }
}

let clock = 1;
function makeWindow(urls = ["https://a/"]) {
  const listeners = new Map();
  const fire = (type, target, detail) => {
    for (const fn of listeners.get(type) ?? []) fn({ type, target, detail });
  };
  const tabs = urls.map(u => new FakeTab(u));
  const pinnedSet = new Set();
  const gBrowser = {
    tabs,
    tabContainer: {
      addEventListener: (t, fn) => listeners.set(t, [...(listeners.get(t) ?? []), fn]),
      removeEventListener: () => {},
    },
    get selectedTab() {
      return tabs.find(t => t.selected);
    },
    set selectedTab(tab) {
      const previousTab = tabs.find(t => t.selected);
      for (const t of tabs) t.selected = t == tab;
      tab.lastAccessed = clock++;
      tab.hidden = false;
      fire("TabSelect", tab, { previousTab });
    },
    get visibleTabs() {
      return tabs.filter(t => !t.hidden);
    },
    hideTab(tab) {
      if (!tab.pinned && !tab.selected) tab.hidden = true;
    },
    showTab(tab) {
      tab.hidden = false;
    },
    addTrustedTab(url, options = {}) {
      const tab = new FakeTab(url);
      tab.options = options;
      tabs.push(tab);
      fire("TabOpen", tab, { fromExternal: false });
      return tab;
    },
    pinTab(tab) {
      tab.pinned = true;
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(tabs.filter(t => t.pinned && t != tab).length, 0, tab);
      fire("TabPinned", tab);
    },
    unpinTab(tab) {
      tab.pinned = false;
      fire("TabUnpinned", tab);
    },
    clearMultiSelectedTabs() {},
    fire,
  };
  const doc = {
    documentElement: {
      attrs: new Map(),
      style: { props: {}, setProperty(k, v) { this.props[k] = v; } },
      setAttribute(k, v) { this.attrs.set(k, v); },
      removeAttribute(k) { this.attrs.delete(k); },
      toggleAttribute(k, on) { on ? this.attrs.set(k, "") : this.attrs.delete(k); },
      append() {},
    },
    getElementById: () => null,
  };
  const sectionsPinned = new Set();
  const sections = {
    isPinned: tab => sectionsPinned.has(tab),
    setPinned: (tab, on) => (on ? sectionsPinned.add(tab) : sectionsPinned.delete(tab)),
  };
  const win = {
    gBrowser,
    document: doc,
    BROWSER_NEW_TAB_URL: "about:newtab",
    closed: false,
    setTimeout: fn => (win._timers.push(fn), 0),
    _timers: [],
    runTimers() {
      while (this._timers.length) this._timers.shift()();
    },
    clearTimeout: () => {},
    addEventListener() {},
    removeEventListener() {},
  };
  doc.createXULElement = () => ({ setAttribute() {}, addEventListener() {}, append() {} });
  tabs[0].selected = true;
  tracker.windows.push(win);
  const spaces = new PerynSpaces(win, {
    sections,
    createUI: () => ({ init() {}, render() {}, uninit() {} }),
  });
  spaces.init();
  return { win, gBrowser, tabs, spaces, sections, sectionsPinned, root: doc.documentElement };
}

test("existing tabs join the first Space; the window shows that Space's colour", () => {
  const { tabs, root } = makeWindow(["https://a/", "https://b/"]);
  assert.deepEqual(tabs.map(t => t.getAttribute(SPACE_ATTR)), ["s-personal", "s-personal"]);
  assert.equal(root.attrs.get("peryn-space"), "s-personal");
  assert.equal(root.style.props["--hx-space-hue"], "268");
});

test("switching shows only that Space's tabs and selects its most recent tab", () => {
  const work = Store.create({ name: "Work" });
  const { win, gBrowser, tabs, spaces, root } = makeWindow(["https://a/", "https://b/"]);
  spaces.switchTo(work.id);
  // An empty Space gets a new tab.
  const workTab = gBrowser.selectedTab;
  assert.equal(workTab.url, "about:newtab");
  assert.equal(workTab.getAttribute(SPACE_ATTR), work.id);
  assert.ok(tabs[0].hidden && tabs[1].hidden);
  assert.equal(root.style.props["--hx-space-hue"], String(work.color.hue));

  gBrowser.addTrustedTab("https://work2/");
  assert.equal(gBrowser.tabs.at(-1).getAttribute(SPACE_ATTR), work.id, "new tabs join the active Space");

  gBrowser.selectedTab = tabs[1]; // e.g. "switch to tab" from the address bar
  win.runTimers();
  assert.equal(spaces.active, "s-personal", "selecting a hidden tab switches to its Space");
  assert.ok(workTab.hidden);
  tabs[0].lastAccessed = clock + 100;
  spaces.switchTo(work.id);
  spaces.switchTo("s-personal");
  assert.equal(gBrowser.selectedTab, tabs[0], "comes back to the most recently used tab");
});

test("Essentials stay visible in every Space and keep the selection", () => {
  const work = Store.create({ name: "Work" });
  const { gBrowser, tabs, spaces } = makeWindow(["https://a/"]);
  const mail = gBrowser.addTrustedTab("https://mail/");
  gBrowser.pinTab(mail);
  gBrowser.selectedTab = mail;
  spaces.switchTo(work.id);
  assert.equal(gBrowser.selectedTab, mail);
  assert.equal(mail.hidden, false);
  assert.ok(tabs.find(t => t.url == "https://a/").hidden);
  assert.equal(mail.getAttribute(SPACE_ATTR), null);
});

test("Ctrl/Cmd+T in a Space with a container opens the new tab in that container", () => {
  const bank = Store.create({ name: "Bank", container: { name: "Banking" } });
  let original = 0;
  const { win, gBrowser, spaces } = (() => {
    const w = makeWindow();
    return w;
  })();
  win.BrowserCommands = { openTab: () => original++ };
  spaces._wrapNewTabCommand();
  spaces.switchTo(bank.id);
  const before = gBrowser.tabs.length;
  win.BrowserCommands.openTab({});
  assert.equal(gBrowser.tabs.length, before + 1);
  assert.ok(gBrowser.tabs.at(-1).options.userContextId > 0);
  spaces.switchTo("s-personal");
  win.BrowserCommands.openTab({});
  assert.equal(original, 1, "no container: Firefox's own new-tab path");
  spaces._unwrapNewTabCommand();
});

test("moving the selected tab to another Space follows it there", () => {
  const work = Store.create({ name: "Work" });
  const { gBrowser, tabs, spaces } = makeWindow(["https://a/", "https://b/"]);
  spaces.moveTabs([tabs[1]], work.id);
  assert.equal(tabs[1].getAttribute(SPACE_ATTR), work.id);
  assert.ok(tabs[1].hidden, "not the selected tab: just hidden");
  spaces.moveTabs([gBrowser.selectedTab], work.id);
  assert.equal(spaces.active, work.id);
});

test("deleting a Space moves its tabs to the neighbouring Space", () => {
  const work = Store.create({ name: "Work" });
  const { tabs, spaces } = makeWindow(["https://a/", "https://b/"]);
  spaces.moveTabs([tabs[1]], work.id);
  Store.delete(work.id);
  assert.equal(tabs[1].getAttribute(SPACE_ATTR), "s-personal");
  assert.equal(tabs[1].hidden, false);
});

test("launchers: pinning records a launcher; another machine's launchers open here; removed ones release", () => {
  const { gBrowser, tabs, spaces, sectionsPinned } = makeWindow(["https://a/", "https://b/"]);
  // Pinned in this window (PerynSections announces it).
  sectionsPinned.add(tabs[1]);
  gBrowser.fire("PerynPinnedChange", tabs[1], { pinned: true });
  const pinId = tabValues.get(tabs[1])[PIN_ID_VALUE];
  assert.ok(pinId);
  assert.deepEqual(Store.get("s-personal").pins.map(p => p.url), ["https://b/"]);

  // Sync brings a launcher from the laptop, and drops ours.
  const data = structuredClone(Store.data);
  data.spaces[0].pins = [{ id: "p-laptop", url: "https://laptop/", title: "From laptop" }];
  Services.prefs.setStringPref("peryn.spaces", JSON.stringify(data));
  Store.observe(null, "nsPref:changed", "peryn.spaces");
  const opened = gBrowser.tabs.find(t => t.url == "https://laptop/");
  assert.ok(opened, "missing launcher opened");
  assert.equal(opened.options.createLazyBrowser, true, "unloaded until clicked");
  assert.ok(sectionsPinned.has(opened));
  assert.equal(tabValues.get(opened)[PIN_ID_VALUE], "p-laptop");
  assert.ok(!sectionsPinned.has(tabs[1]), "launcher gone: no longer pinned");
  assert.ok(gBrowser.tabs.includes(tabs[1]), "but still open");
  assert.equal(Store.get("s-personal").pins.length, 1, "releasing doesn't write back");
});

test("Essentials sync: pinning adds, a remote Essential opens pinned, closing by the user removes it", () => {
  const { gBrowser, spaces } = makeWindow();
  const mail = gBrowser.addTrustedTab("https://mail/");
  gBrowser.pinTab(mail);
  assert.deepEqual(Store.data.essentials.map(e => e.url), ["https://mail/"]);

  const data = structuredClone(Store.data);
  data.essentials.push({ id: "e-cal", url: "https://cal/", title: "Calendar" });
  Services.prefs.setStringPref("peryn.spaces", JSON.stringify(data));
  Store.observe(null, "nsPref:changed", "peryn.spaces");
  const cal = gBrowser.tabs.find(t => t.url == "https://cal/");
  assert.ok(cal?.pinned);
  assert.equal(Store.data.essentials.length, 2, "opening a launcher doesn't duplicate it");

  gBrowser.fire("TabClose", cal);
  assert.deepEqual(Store.data.essentials.map(e => e.url), ["https://mail/"]);
});

test("swiping sideways on the sidebar switches Space", () => {
  const work = Store.create({ name: "Work" });
  const { spaces } = makeWindow();
  spaces.swipe = new Logic.SwipeTracker({ threshold: 100, now: () => 0 });
  spaces.handleEvent({ type: "wheel", target: null, deltaX: 150, deltaY: 0, deltaMode: 0 });
  assert.equal(spaces.active, work.id);
});

test("a launcher's title follows the page once it loads (and its URL, if pinned before loading)", () => {
  const { gBrowser, tabs, sectionsPinned } = makeWindow(["about:newtab"]);
  sectionsPinned.add(tabs[0]);
  gBrowser.fire("PerynPinnedChange", tabs[0], { pinned: true });
  tabs[0].linkedBrowser.currentURI.spec = "https://docs.example/";
  tabs[0].label = "Docs";
  gBrowser.fire("TabAttrModified", tabs[0], { changed: ["label"] });
  assert.deepEqual(
    Store.get("s-personal").pins.map(p => [p.title, p.url]),
    [["Docs", "https://docs.example/"]]
  );
});

test("closing a Space's last tab keeps you in that Space with a fresh tab", () => {
  const work = Store.create({ name: "Work" });
  const { win, gBrowser, spaces } = makeWindow(["https://a/"]);
  const mail = gBrowser.addTrustedTab("https://mail/");
  gBrowser.pinTab(mail);
  spaces.switchTo(work.id);
  const only = gBrowser.selectedTab;
  win.runTimers();
  // Firefox: move the selection (to the Essential), then mark the tab closing and remove it.
  gBrowser.selectedTab = mail;
  only.closing = true;
  gBrowser.tabs.splice(gBrowser.tabs.indexOf(only), 1);
  win.runTimers();
  assert.equal(spaces.active, work.id);
  assert.equal(gBrowser.selectedTab.getAttribute(SPACE_ATTR), work.id);
  assert.equal(gBrowser.selectedTab.url, "about:newtab");
});
