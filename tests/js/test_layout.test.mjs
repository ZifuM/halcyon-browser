// Tests for the window layout: section rules, compact mode's reveal state, and the Pinned/Today
// controller against a fake tab strip.
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LAYOUT_DIR = path.join(ROOT, "src/browser/components/halcyon/layout");

const Logic = await import("moz-src:///browser/components/halcyon/layout/HalcyonLayoutLogic.sys.mjs");

// Fake session store for HalcyonSections (it loads it lazily).
const saved = new Map();
ChromeUtils._preload("moz-src:///browser/components/sessionstore/SessionStore.sys.mjs", {
  SessionStore: {
    getCustomTabValue: (tab, key) => saved.get(tab)?.[key] ?? "",
    setCustomTabValue: (tab, key, value) => saved.set(tab, { ...saved.get(tab), [key]: value }),
    deleteCustomTabValue: (tab, key) => {
      const v = { ...saved.get(tab) };
      delete v[key];
      saved.set(tab, v);
    },
  },
});
const { HalcyonSections, STRINGS } = await import(
  "moz-src:///browser/components/halcyon/layout/HalcyonSections.sys.mjs"
);

// ---- section rules ------------------------------------------------------------------------

test("pinnedAfterMove: among pinned pins, among Today unpins, the boundary keeps state", () => {
  const f = Logic.pinnedAfterMove;
  // Today tab dropped above a pinned tab (inside Pinned, or at its very top).
  assert.equal(f({ wasPinned: false, prevPinned: true, nextPinned: true }), true);
  assert.equal(f({ wasPinned: false, prevPinned: null, nextPinned: true }), true);
  // Today tab dropped right after the last pinned tab: the boundary, stays Today.
  assert.equal(f({ wasPinned: false, prevPinned: true, nextPinned: false }), false);
  assert.equal(f({ wasPinned: false, prevPinned: true, nextPinned: null }), false);
  // Pinned tab dropped among Today tabs.
  assert.equal(f({ wasPinned: true, prevPinned: false, nextPinned: false }), false);
  assert.equal(f({ wasPinned: true, prevPinned: false, nextPinned: null }), false);
  // Pinned tab dropped at the boundary or within Pinned.
  assert.equal(f({ wasPinned: true, prevPinned: true, nextPinned: false }), true);
  assert.equal(f({ wasPinned: true, prevPinned: null, nextPinned: false }), true);
});

test("placementForNewTab: top of Today by default; Firefox placement never inside Pinned", () => {
  const f = Logic.placementForNewTab;
  assert.equal(f({ restoring: false, grouped: false, prevPinned: false, nextPinned: null }), "after-pinned");
  assert.equal(f({ restoring: true, grouped: false, prevPinned: true, nextPinned: true }), null);
  assert.equal(f({ restoring: false, grouped: true, prevPinned: true, nextPinned: null }), null);
  const ff = args => f({ restoring: false, grouped: false, position: "firefox", ...args });
  assert.equal(ff({ prevPinned: false, nextPinned: null }), null, "end of Today: fine");
  assert.equal(ff({ prevPinned: true, nextPinned: true }), "after-pinned", "opened from a pinned tab");
  assert.equal(ff({ prevPinned: null, nextPinned: true }), "after-pinned");
});

test("canPinToSidebar: not Essentials, grouped or split-view tabs", () => {
  assert.equal(Logic.canPinToSidebar({ pinned: false }), true);
  assert.equal(Logic.canPinToSidebar({ pinned: true }), false);
  assert.equal(Logic.canPinToSidebar({ pinned: false, group: {} }), false);
  assert.equal(Logic.canPinToSidebar({ pinned: false, splitview: {} }), false);
});

// ---- compact reveal state -------------------------------------------------------------------

function fakeTimers() {
  let now = 0;
  const timers = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => {
      timers.set(next, { fn, at: now + ms });
      return next++;
    },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get pending() {
      return timers.size;
    },
  };
}

test("RevealState: shows at once, hides after the delay, and only when the last reason goes", () => {
  const timers = fakeTimers();
  const changes = [];
  const s = new Logic.RevealState({ onChange: r => changes.push(Logic.revealAttribute(r)), hideDelayMs: 300, ...timers });
  s.add("sidebar", "hover:edge");
  assert.deepEqual(changes, ["sidebar"]);
  s.add("sidebar", "hover:sidebar"); // pointer moved from the edge onto the sidebar
  s.remove("sidebar", "hover:edge");
  timers.advance(1000);
  assert.ok(s.has("sidebar"), "still hovered");
  s.remove("sidebar", "hover:sidebar");
  timers.advance(299);
  assert.ok(s.has("sidebar"), "hide waits for the delay");
  s.add("sidebar", "hover:sidebar"); // came back in time
  timers.advance(500);
  assert.ok(s.has("sidebar"));
  s.remove("sidebar", "hover:sidebar");
  timers.advance(300);
  assert.equal(s.has("sidebar"), false);
  assert.deepEqual(changes, ["sidebar", ""]);
});

test("RevealState: parts are independent; reset hides everything now", () => {
  const timers = fakeTimers();
  const changes = [];
  const s = new Logic.RevealState({ onChange: r => changes.push(Logic.revealAttribute(r)), ...timers });
  s.add("toolbar", "focus");
  s.add("sidebar", "popup:menu");
  assert.equal(changes.at(-1), "sidebar toolbar");
  s.reset();
  assert.equal(changes.at(-1), "");
  assert.equal(timers.pending, 0);
  assert.throws(() => s.add("nope", "x"));
  s.remove("toolbar", "never-added"); // harmless
});

// ---- Pinned / Today controller (fake tab strip) ----------------------------------------------

class FakeTab {
  constructor(name, { pinned = false } = {}) {
    this.label = name;
    this.pinned = pinned;
    this.attrs = new Set();
    this.group = null;
    this.splitview = null;
  }
  hasAttribute(a) {
    return this.attrs.has(a);
  }
  toggleAttribute(a, on) {
    if (on) this.attrs.add(a);
    else this.attrs.delete(a);
  }
}

class FakeTabContainer {
  constructor() {
    this.listeners = new Map();
    this.attrs = new Set();
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  toggleAttribute(a, on) {
    if (on) this.attrs.add(a);
    else this.attrs.delete(a);
  }
  hasAttribute(a) {
    return this.attrs.has(a);
  }
  fire(type, target, detail) {
    this.listeners.get(type)?.({ type, target, detail });
  }
}

function makeWindow(names, essentials = 0) {
  const tabContainer = new FakeTabContainer();
  const tabs = names.map((n, i) => new FakeTab(n, { pinned: i < essentials }));
  const gBrowser = {
    tabs,
    tabContainer,
    get pinnedTabCount() {
      return tabs.filter(t => t.pinned).length;
    },
    moveTabTo(tab, { tabIndex }) {
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(tabIndex, 0, tab);
      tabContainer.fire("TabMove", tab);
    },
    moveTabAfter(tab, target) {
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(tabs.indexOf(target) + 1, 0, tab);
      tabContainer.fire("TabMove", tab);
    },
    // A user drag: move without the controller's involvement, then Firefox fires TabMove.
    drag(tab, toIndex) {
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(toIndex, 0, tab);
      tabContainer.fire("TabMove", tab);
    },
    open(name, index = tabs.length, detail = { fromExternal: false }) {
      const tab = new FakeTab(name);
      tab.parentNode = {};
      tabs.splice(index, 0, tab);
      tabContainer.fire("TabOpen", tab, detail);
      return tab;
    },
  };
  for (const t of tabs) t.parentNode = {};
  const win = {
    gBrowser,
    document: { getElementById: () => null },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
  return { win, gBrowser, tabs, tabContainer };
}

const order = tabs => tabs.map(t => (t.pinned ? `E:${t.label}` : t.hasAttribute("halcyon-pinned") ? `P:${t.label}` : t.label));

beforeEach(() => {
  saved.clear();
  Services.prefs._reset();
});

test("pinning moves a tab to the end of Pinned and saves it; unpinning moves it to the top of Today", () => {
  const { win, gBrowser, tabs, tabContainer } = makeWindow(["mail", "a", "b", "c", "d"], 1);
  const s = new HalcyonSections(win);
  s.init();
  s.setPinned(tabs[3], true); // c
  assert.deepEqual(order(gBrowser.tabs), ["E:mail", "P:c", "a", "b", "d"]);
  s.setPinned(gBrowser.tabs[4], true); // d
  assert.deepEqual(order(gBrowser.tabs), ["E:mail", "P:c", "P:d", "a", "b"]);
  assert.ok(tabContainer.hasAttribute("halcyon-has-pinned"));
  assert.equal(saved.get(gBrowser.tabs[1])["halcyon-pinned"], "1");

  s.setPinned(gBrowser.tabs[1], false); // c back to Today
  assert.deepEqual(order(gBrowser.tabs), ["E:mail", "P:d", "c", "a", "b"]);
  assert.equal(saved.get(gBrowser.tabs[2])["halcyon-pinned"], undefined);
  s.setPinned(gBrowser.tabs[1], false);
  assert.ok(!tabContainer.hasAttribute("halcyon-has-pinned"));
});

test("dragging across the divider pins and unpins", () => {
  const { win, gBrowser } = makeWindow(["a", "b", "c", "d"]);
  const s = new HalcyonSections(win);
  s.init();
  s.setPinned(gBrowser.tabs[0], true);
  s.setPinned(gBrowser.tabs[1], true);
  assert.deepEqual(order(gBrowser.tabs), ["P:a", "P:b", "c", "d"]);
  gBrowser.drag(gBrowser.tabs[3], 1); // d between a and b
  assert.deepEqual(order(gBrowser.tabs), ["P:a", "P:d", "P:b", "c"]);
  gBrowser.drag(gBrowser.tabs[0], 3); // a below c
  assert.deepEqual(order(gBrowser.tabs), ["P:d", "P:b", "c", "a"]);
  gBrowser.drag(gBrowser.tabs[3], 2); // a to the boundary: stays Today
  assert.deepEqual(order(gBrowser.tabs), ["P:d", "P:b", "a", "c"]);
});

test("new tabs open at the top of Today, also when opened from a pinned tab", () => {
  const { win, gBrowser } = makeWindow(["e", "a", "b"], 1);
  const s = new HalcyonSections(win);
  s.init();
  s.setPinned(gBrowser.tabs[1], true); // a
  gBrowser.open("new"); // Firefox put it at the end
  assert.deepEqual(order(gBrowser.tabs), ["E:e", "P:a", "new", "b"]);
  gBrowser.open("link", 2); // right after the pinned tab it came from
  assert.deepEqual(order(gBrowser.tabs), ["E:e", "P:a", "link", "new", "b"]);
});

test("with Firefox placement, only tabs landing inside Pinned are moved", () => {
  Services.prefs.setStringPref("halcyon.tabs.newTabPosition", "firefox");
  const { win, gBrowser } = makeWindow(["a", "b", "c"]);
  const s = new HalcyonSections(win);
  s.init();
  s.setPinned(gBrowser.tabs[0], true);
  s.setPinned(gBrowser.tabs[1], true);
  gBrowser.open("end");
  assert.deepEqual(order(gBrowser.tabs), ["P:a", "P:b", "c", "end"]);
  gBrowser.open("inside", 1);
  assert.deepEqual(order(gBrowser.tabs), ["P:a", "P:b", "inside", "c", "end"]);
});

test("session restore: restored tabs aren't moved on open; Pinned is regrouped after marking", async () => {
  const { win, gBrowser, tabContainer } = makeWindow(["x"]);
  const s = new HalcyonSections(win);
  s.init();
  // Restore announces tabs without fromExternal, in saved order: today1, pin1, today2, pin2.
  const t1 = gBrowser.open("today1", 1, {});
  const p1 = gBrowser.open("pin1", 2, {});
  const t2 = gBrowser.open("today2", 3, {});
  const p2 = gBrowser.open("pin2", 4, {});
  assert.deepEqual(order(gBrowser.tabs), ["x", "today1", "pin1", "today2", "pin2"]);
  saved.set(p1, { "halcyon-pinned": "1" });
  saved.set(p2, { "halcyon-pinned": "1" });
  // Restoring marks the selected tab first, the rest after.
  for (const tab of [p2, t1, p1, t2]) tabContainer.fire("SSTabRestoring", tab);
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(order(gBrowser.tabs), ["P:pin1", "P:pin2", "x", "today1", "today2"]);
});

test("becoming an Essential or joining a group drops Pinned; an ex-Essential leaves Pinned", () => {
  const { win, gBrowser, tabContainer } = makeWindow(["e", "a", "b", "c"], 1);
  const s = new HalcyonSections(win);
  s.init();
  s.setPinned(gBrowser.tabs[1], true);
  s.setPinned(gBrowser.tabs[2], true);
  const a = gBrowser.tabs[1];
  a.pinned = true;
  tabContainer.fire("TabPinned", a);
  assert.equal(a.hasAttribute("halcyon-pinned"), false);
  const b = gBrowser.tabs[2];
  b.group = {};
  tabContainer.fire("TabGrouped", b);
  assert.equal(b.hasAttribute("halcyon-pinned"), false);

  // Unpinning an Essential: Firefox puts it first after the Essentials, inside Pinned.
  b.group = null;
  s.setPinned(b, true);
  const e = gBrowser.tabs[0];
  e.pinned = false;
  gBrowser.tabs.splice(0, 1);
  gBrowser.tabs.splice(gBrowser.pinnedTabCount, 0, e);
  tabContainer.fire("TabUnpinned", e);
  assert.deepEqual(order(gBrowser.tabs), ["E:a", "P:b", "e", "c"]);
});

test("saved Pinned state is read back for tabs already in the window", () => {
  const { win, gBrowser } = makeWindow(["a", "b"]);
  saved.set(gBrowser.tabs[0], { "halcyon-pinned": "1" });
  new HalcyonSections(win).init();
  assert.ok(gBrowser.tabs[0].hasAttribute("halcyon-pinned"));
  assert.ok(!gBrowser.tabs[1].hasAttribute("halcyon-pinned"));
  assert.equal(STRINGS.pin, "Pin to Sidebar");
});

// ---- stylesheets ------------------------------------------------------------------------------

test("every --hx-* property the layout uses is defined in the tokens", () => {
  const tokens = fs.readFileSync(path.join(LAYOUT_DIR, "halcyon-tokens.css"), "utf8");
  const defined = new Set([...tokens.matchAll(/(--hx-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
  for (const file of Logic.STYLESHEETS) {
    const css = fs.readFileSync(path.join(LAYOUT_DIR, file), "utf8");
    for (const [, name] of css.matchAll(/var\((--hx-[a-z0-9-]+)/g)) {
      // A few have inline fallbacks on purpose (var(--hx-x, default)).
      if (!defined.has(name) && !new RegExp(`var\\(${name},`).test(css)) {
        assert.fail(`${file} uses ${name}, which halcyon-tokens.css doesn't define`);
      }
    }
  }
});

test("only transform and opacity are animated", () => {
  for (const file of Logic.STYLESHEETS) {
    const css = fs.readFileSync(path.join(LAYOUT_DIR, file), "utf8");
    for (const [, value] of css.matchAll(/transition:\s*([^;]+);/g)) {
      for (const part of value.split(",")) {
        const prop = part.trim().split(/\s+/)[0];
        assert.ok(
          ["transform", "opacity", "background-color"].includes(prop),
          `${file} animates ${prop}; only transform/opacity (and colour fades) keep motion on the compositor`
        );
      }
    }
  }
});

test("stylesheets listed in the logic module exist and are packaged", () => {
  const mozbuild = fs.readFileSync(path.join(LAYOUT_DIR, "moz.build"), "utf8");
  for (const file of Logic.STYLESHEETS) {
    assert.ok(fs.existsSync(path.join(LAYOUT_DIR, file)), file);
    assert.ok(mozbuild.includes(`"${file}"`), `${file} missing from layout/moz.build`);
  }
});
