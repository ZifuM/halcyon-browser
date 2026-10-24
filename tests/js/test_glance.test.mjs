// Tests for Glance: the in-page trigger (Alt+click, Esc), the parent hand-off, and the
// per-window controller that shows a preview tab as a card over the page it came from.
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { PerynGlanceChild, isGlanceClick, linkFromEvent } = await import(
  "moz-src:///browser/components/peryn/glance/PerynGlanceChild.sys.mjs"
);
const { PerynGlanceParent } = await import("moz-src:///browser/components/peryn/glance/PerynGlanceParent.sys.mjs");
const Glance = await import("moz-src:///browser/components/peryn/glance/PerynGlance.sys.mjs");

// ---- a small fake DOM ---------------------------------------------------------------------

class El {
  constructor(tag = "div", id = "") {
    this.localName = tag;
    this.id = id;
    this.attrs = new Map();
    this.children = [];
    this.listeners = new Map();
  }
  setAttribute(k, v) {
    this.attrs.set(k, String(v));
  }
  getAttribute(k) {
    return this.attrs.has(k) ? this.attrs.get(k) : null;
  }
  hasAttribute(k) {
    return this.attrs.has(k);
  }
  removeAttribute(k) {
    this.attrs.delete(k);
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  append(...kids) {
    this.children.push(...kids);
  }
  set hidden(v) {
    if (v) this.attrs.set("hidden", "true");
    else this.attrs.delete("hidden");
  }
  get hidden() {
    return this.attrs.has("hidden");
  }
  find(cls) {
    for (const c of this.children) {
      if ((c.getAttribute("class") ?? "").split(" ").includes(cls)) return c;
      const deeper = c.find?.(cls);
      if (deeper) return deeper;
    }
    return null;
  }
}

let nextId = 0;
class Tab extends El {
  constructor(label, browsers) {
    super("tab");
    this.label = label;
    this.linkedPanel = `panel-${++nextId}`;
    this.linkedBrowser = { docShellIsActive: false, tab: this };
    this.userContextId = 0;
    this.pinned = false;
    this.splitview = null;
    this.isConnected = true;
    browsers.set(this.linkedBrowser, this);
  }
}

function makeWindow(labels = ["a", "b"]) {
  const elements = new Map();
  const browsers = new Map();
  const byId = id => {
    if (!elements.has(id)) elements.set(id, new El("div", id));
    return elements.get(id);
  };
  const tabContainer = new El("tabs");
  const fire = (type, target, detail) => tabContainer.listeners.get(type)?.({ type, target, detail });
  const tabs = labels.map(l => new Tab(l, browsers));
  let selected = tabs[0];
  const calls = { addTab: [], split: [] };
  const gBrowser = {
    tabs,
    tabContainer,
    _printPreviewBrowsers: new Set(),
    get selectedTab() {
      return selected;
    },
    set selectedTab(tab) {
      if (tab == selected) return;
      const previousTab = selected;
      selected = tab;
      fire("TabSelect", tab, { previousTab });
    },
    get selectedBrowser() {
      return selected.linkedBrowser;
    },
    getTabForBrowser: b => browsers.get(b) ?? null,
    addTab(url, opts) {
      calls.addTab.push({ url, opts });
      const tab = new Tab(url, browsers);
      tabs.splice(tabs.indexOf(opts.ownerTab) + 1, 0, tab);
      fire("TabOpen", tab);
      return tab;
    },
    removeTab(tab) {
      fire("TabClose", tab);
      tabs.splice(tabs.indexOf(tab), 1);
      tab.isConnected = false;
      if (selected == tab) selected = tabs[0];
    },
    moveTabAfter(tab, target) {
      tabs.splice(tabs.indexOf(tab), 1);
      tabs.splice(tabs.indexOf(target) + 1, 0, tab);
    },
    addTabSplitView(list) {
      calls.split.push(list.map(t => t.label));
      return {};
    },
    activateBrowserForPrintPreview(browser) {
      this._printPreviewBrowsers.add(browser);
      browser.docShellIsActive = true;
    },
    shouldActivateDocShell(browser) {
      return browser == selected.linkedBrowser || this._printPreviewBrowsers.has(browser);
    },
  };
  for (const t of tabs) Object.defineProperty(t, "_tPos", { get: () => tabs.indexOf(t) });
  const documentElement = new El("html");
  const win = {
    gBrowser,
    document: {
      documentElement,
      getElementById: byId,
      createElementNS: (ns, tag) => new El(tag),
    },
  };
  return { win, gBrowser, tabs, byId, calls, fire, documentElement };
}

beforeEach(() => {
  Services.prefs._reset();
});

globalThis.Services.scriptSecurityManager = { getSystemPrincipal: () => ({ system: true }) };
globalThis.Services.io.newURI = spec => ({ spec });
Cc["@mozilla.org/referrer-info;1"] = { createInstance: () => ({ init(policy, send, uri) { this.uri = uri; } }) };
Ci.nsIReferrerInfo = { EMPTY: 0 };

// ---- in the page ---------------------------------------------------------------------------

const click = (over = {}) => {
  const ev = {
    type: "click",
    button: 0,
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    path: [{ localName: "span" }, { localName: "a", href: "https://example.com/story" }, { localName: "body" }],
    composedPath() {
      return this.path;
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...over,
  };
  return ev;
};

function child() {
  const c = new PerynGlanceChild();
  c.sent = [];
  c.sendAsyncMessage = (name, data) => c.sent.push({ name, data });
  c.document = { location: { href: "https://news.example/" } };
  return c;
}

test("Alt+click on a link asks for a preview and stops the page following it", () => {
  const c = child();
  const ev = click();
  c.handleEvent(ev);
  assert.deepEqual(c.sent, [{ name: "Glance:Open", data: { url: "https://example.com/story", referrer: "https://news.example/" } }]);
  assert.ok(ev.defaultPrevented && ev.stopped);
});

test("other clicks, other links and the off switch are left to the page", () => {
  for (const over of [{ altKey: false }, { ctrlKey: true }, { shiftKey: true }, { metaKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const c = child();
    c.handleEvent(click(over));
    assert.equal(c.sent.length, 0, JSON.stringify(over));
  }
  const notHttp = child();
  notHttp.handleEvent(click({ path: [{ localName: "a", href: "javascript:void(0)" }] }));
  notHttp.handleEvent(click({ path: [{ localName: "a", href: "mailto:a@b.c" }] }));
  notHttp.handleEvent(click({ path: [{ localName: "div" }] }));
  assert.equal(notHttp.sent.length, 0);

  Services.prefs.setBoolPref(Glance.PREFS.enabled, false);
  const off = child();
  const ev = click();
  off.handleEvent(ev);
  assert.equal(off.sent.length, 0);
  assert.ok(!ev.defaultPrevented);
});

test("the nearest link wins, image-map areas count", () => {
  assert.equal(linkFromEvent(click({ path: [{ localName: "area", href: "http://x.test/" }, { localName: "a", href: "https://y.test/" }] })), "http://x.test/");
  assert.ok(isGlanceClick(click()));
});

test("Esc is passed on, once per press", () => {
  const c = child();
  c.handleEvent({ type: "keydown", key: "Escape", repeat: false, defaultPrevented: false });
  c.handleEvent({ type: "keydown", key: "Escape", repeat: true, defaultPrevented: false });
  c.handleEvent({ type: "keydown", key: "Escape", repeat: false, defaultPrevented: true });
  c.handleEvent({ type: "keydown", key: "a", repeat: false, defaultPrevented: false });
  assert.deepEqual(c.sent.map(m => m.name), ["Glance:Escape"]);
});

test("the parent hands requests to the window the page is in", () => {
  const log = [];
  const browser = { ownerGlobal: { PerynGlance: { open: (...a) => log.push(["open", ...a]), closeFor: b => log.push(["closeFor", b]) } } };
  const p = new PerynGlanceParent();
  p.browsingContext = { top: { embedderElement: browser } };
  p.manager = { documentPrincipal: { origin: "https://news.example" } };
  p.receiveMessage({ name: "Glance:Open", data: { url: "https://a.test/", referrer: "https://news.example/" } });
  p.receiveMessage({ name: "Glance:Escape" });
  assert.equal(log[0][1], "https://a.test/");
  assert.equal(log[0][2].fromBrowser, browser);
  assert.equal(log[0][2].triggeringPrincipal.origin, "https://news.example");
  assert.deepEqual(log[1], ["closeFor", browser]);
  // A window without Peryn's layout: nothing happens.
  p.browsingContext = { top: { embedderElement: { ownerGlobal: {} } } };
  p.receiveMessage({ name: "Glance:Open", data: { url: "https://a.test/" } });
  assert.equal(log.length, 2);
});

// ---- the controller --------------------------------------------------------------------------

function setUp(labels) {
  const w = makeWindow(labels);
  const glance = new Glance.PerynGlance(w.win, w.parts ?? {});
  glance.init();
  return { ...w, glance };
}

test("init registers the actor once and exposes the controller to it", () => {
  const { win, glance } = setUp();
  assert.equal(win.PerynGlance, glance);
  const actor = ChromeUtils._actors.get("PerynGlance");
  assert.ok(actor.child.esModuleURI.endsWith("/glance/PerynGlanceChild.sys.mjs"));
  assert.ok(actor.parent.esModuleURI.endsWith("/glance/PerynGlanceParent.sys.mjs"));
  assert.equal(actor.enablePreference, "peryn.glance.enabled");
  assert.deepEqual(actor.matches, ["http://*/*", "https://*/*"]);
  setUp(); // a second window doesn't register again (the mock throws if it does)
  glance.uninit();
  assert.equal(win.PerynGlance, undefined);
});

test("open: the preview is selected as a card, the page underneath stays live", () => {
  const { glance, gBrowser, tabs, byId, documentElement, calls } = setUp(["a", "b"]);
  const [a] = tabs;
  const tab = glance.open("https://x.test/", { fromBrowser: a.linkedBrowser, referrer: "https://a.test/" });
  assert.equal(gBrowser.selectedTab, tab);
  assert.equal(glance.current, tab);
  assert.equal(glance.parentOf(tab), a);
  assert.equal(tabs.indexOf(tab), 1, "opened right after the page");
  assert.equal(calls.addTab[0].opts.ownerTab, a);
  assert.equal(calls.addTab[0].opts.referrerInfo.uri.spec, "https://a.test/");
  assert.ok(a.linkedBrowser.docShellIsActive && gBrowser._printPreviewBrowsers.has(a.linkedBrowser));
  assert.equal(byId(tab.linkedPanel).getAttribute("peryn-glance"), "card");
  assert.ok(byId(a.linkedPanel).hasAttribute("peryn-glance-parent"));
  assert.ok(byId("tabbrowser-tabpanels").hasAttribute("peryn-glance"));
  assert.ok(documentElement.hasAttribute("peryn-glance-open"));
  const layer = byId("tabbrowser-tabbox").children[0];
  assert.equal(layer.getAttribute("id"), "peryn-glance-layer");
  assert.ok(!layer.hidden);
  assert.ok(layer.find("peryn-glance-close") && layer.find("peryn-glance-expand") && layer.find("peryn-glance-split"));
});

test("only the page on screen can open a preview, and not when Glance is off", () => {
  const { glance, tabs } = setUp(["a", "b"]);
  assert.equal(glance.open("https://x.test/", { fromBrowser: tabs[1].linkedBrowser }), null);
  Services.prefs.setBoolPref("peryn.glance.enabled", false);
  assert.equal(glance.open("https://x.test/"), null);
});

test("close goes back to the page and removes the preview", () => {
  const { glance, gBrowser, tabs, byId, documentElement } = setUp(["a", "b"]);
  const [a] = tabs;
  const tab = glance.open("https://x.test/");
  glance.close();
  assert.equal(gBrowser.selectedTab, a);
  assert.ok(!tabs.includes(tab));
  assert.ok(!gBrowser._printPreviewBrowsers.has(a.linkedBrowser));
  assert.ok(!byId(a.linkedPanel).hasAttribute("peryn-glance-parent"));
  assert.ok(!byId("tabbrowser-tabpanels").hasAttribute("peryn-glance"));
  assert.ok(!documentElement.hasAttribute("peryn-glance-open"));
  assert.ok(byId("tabbrowser-tabbox").children[0].hidden);
  glance.close(); // nothing open: no-op
});

test("Esc from the preview closes it; from any other page it does nothing", () => {
  const { glance, gBrowser, tabs } = setUp(["a", "b"]);
  const b = tabs[1];
  const tab = glance.open("https://x.test/");
  glance.closeFor(b.linkedBrowser);
  assert.equal(gBrowser.selectedTab, tab);
  glance.closeFor(tab.linkedBrowser);
  assert.equal(gBrowser.selectedTab, tabs[0]);
});

test("the backdrop and buttons work", () => {
  const { glance, gBrowser, tabs, byId } = setUp(["a", "b"]);
  glance.open("https://x.test/");
  const layer = byId("tabbrowser-tabbox").children[0];
  layer.find("peryn-glance-backdrop").listeners.get("mousedown")();
  assert.equal(gBrowser.selectedTab, tabs[0]);
  const tab = glance.open("https://y.test/");
  layer.find("peryn-glance-expand").listeners.get("click")({ stopPropagation() {} });
  assert.equal(gBrowser.selectedTab, tab);
  assert.ok(!tab.hasAttribute("peryn-glance"));
});

test("expand keeps it as an ordinary tab after the page", () => {
  const { glance, gBrowser, tabs, byId } = setUp(["a", "b", "c"]);
  const [a] = tabs;
  const tab = glance.open("https://x.test/");
  assert.equal(glance.expand(), tab);
  assert.equal(gBrowser.selectedTab, tab);
  assert.ok(!tab.hasAttribute("peryn-glance"));
  assert.equal(glance.parentOf(tab), null);
  assert.equal(tabs.indexOf(tab), tabs.indexOf(a) + 1);
  assert.ok(!byId(tab.linkedPanel).hasAttribute("peryn-glance"));
  assert.ok(!gBrowser._printPreviewBrowsers.has(a.linkedBrowser));
  assert.equal(glance.expand(), null);
});

test("split puts the page and the preview side by side", () => {
  const { glance, gBrowser, tabs, calls } = setUp(["a", "b"]);
  const tab = glance.open("https://x.test/");
  glance.split();
  assert.deepEqual(calls.split, [["a", "https://x.test/"]]);
  assert.equal(gBrowser.selectedTab, tab);
  assert.ok(!tab.hasAttribute("peryn-glance"));

  // With Peryn's split view controller, the preview joins through it (up to four panes).
  const w = makeWindow(["a"]);
  const added = [];
  const g = new Glance.PerynGlance(w.win, { split: { add: list => (added.push(...list), {}) } });
  g.init();
  const t = g.open("https://y.test/");
  g.split();
  assert.deepEqual(added, [t]);
  assert.equal(w.gBrowser.selectedTab, t);
});

test("going to another tab turns the preview into an ordinary tab", () => {
  const { glance, gBrowser, tabs, documentElement } = setUp(["a", "b"]);
  const tab = glance.open("https://x.test/");
  gBrowser.selectedTab = tabs.at(-1);
  assert.ok(!tab.hasAttribute("peryn-glance"));
  assert.ok(tabs.includes(tab), "nothing is lost");
  assert.ok(!documentElement.hasAttribute("peryn-glance-open"));
  assert.ok(!gBrowser._printPreviewBrowsers.has(tabs[0].linkedBrowser));
});

test("closing the page underneath leaves the preview as a tab", () => {
  const { glance, gBrowser, tabs } = setUp(["a", "b"]);
  const [a] = tabs;
  const tab = glance.open("https://x.test/");
  gBrowser.removeTab(a);
  assert.ok(!tab.hasAttribute("peryn-glance"));
  assert.ok(tabs.includes(tab));
});

test("closing the preview some other way still returns to the page", () => {
  const { glance, gBrowser, tabs } = setUp(["a", "b"]);
  const tab = glance.open("https://x.test/");
  gBrowser.removeTab(tab);
  assert.equal(gBrowser.selectedTab, tabs[0]);
  assert.ok(!gBrowser._printPreviewBrowsers.has(tabs[0].linkedBrowser));
});

test("a link Alt+clicked inside a preview replaces it, over the same page", () => {
  const { glance, gBrowser, tabs } = setUp(["a", "b"]);
  const [a] = tabs;
  const first = glance.open("https://x.test/");
  const second = glance.open("https://y.test/", { fromBrowser: first.linkedBrowser });
  assert.ok(!tabs.includes(first));
  assert.equal(gBrowser.selectedTab, second);
  assert.equal(glance.parentOf(second), a);
  assert.ok(a.linkedBrowser.docShellIsActive);
});
