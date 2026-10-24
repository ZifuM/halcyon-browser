// Tests for Shield element hiding: the pure logic, the parent and child actors (with a fake
// DOM and a fake classifier service) and the actor registration.
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as Timer from "./mocks/Timer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LOGIC_URL = "moz-src:///browser/components/peryn/shield/ShieldCosmeticLogic.sys.mjs";

const Logic = await import(LOGIC_URL);
const allowList = new Set();
ChromeUtils._preload(LOGIC_URL, { ShieldCosmeticLogic: Logic });
ChromeUtils._preload("resource://gre/modules/Timer.sys.mjs", Timer);
ChromeUtils._preload("resource://gre/modules/ContentBlockingAllowList.sys.mjs", {
  ContentBlockingAllowList: { includes: browser => allowList.has(browser) },
});

const { ShieldCosmeticParent, clearShieldCosmeticCache } = await import(
  "moz-src:///browser/components/peryn/shield/ShieldCosmeticParent.sys.mjs"
);
const { ShieldCosmeticChild } = await import(
  "moz-src:///browser/components/peryn/shield/ShieldCosmeticChild.sys.mjs"
);
const { ShieldCosmetic, ACTOR_NAME, ACTOR_OPTIONS } = await import(
  "moz-src:///browser/components/peryn/shield/ShieldCosmetic.sys.mjs"
);

const tick = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await sleep(20);
  }
}

// ---- logic ------------------------------------------------------------------------------

test("stylesheet: :is() groups, deduped, unsafe selectors dropped, pseudo-elements alone", () => {
  const css = Logic.buildHideStylesheet([
    ".ad",
    "#banner",
    ".ad",
    " .ad ",
    "div{} body { display:none",
    "a /* comment",
    "",
    42,
    ".x::before",
    "ins.adsbygoogle[data-ad-client]",
  ]);
  assert.equal(
    css,
    ":is(.ad,\n#banner,\nins.adsbygoogle[data-ad-client]) { display: none !important; }\n" +
      ".x::before { display: none !important; }"
  );
  assert.equal(Logic.buildHideStylesheet([]), "");
  assert.equal(Logic.buildHideStylesheet(["a{b}"]), "");
});

test("stylesheet: large selector sets are split into several rules", () => {
  const selectors = Array.from({ length: Logic.SELECTORS_PER_RULE * 2 + 1 }, (_, i) => `.ad-${i}`);
  const css = Logic.buildHideStylesheet(selectors);
  assert.equal(css.split("\n:is(").length, 3);
  assert.equal(css.match(/display: none !important/g).length, 3);
});

test("isSafeSelector rejects anything that could leave its rule", () => {
  for (const bad of ["a{", "}", "a/*", "*/", "a\0", "</style><script>", "x".repeat(5000)]) {
    assert.equal(Logic.isSafeSelector(bad), false, bad);
  }
  for (const good of [".ad", "#x > .y", 'a[href^="https://ads.example/"]', "div:has(> .sponsor)"]) {
    assert.equal(Logic.isSafeSelector(good), true, good);
  }
});

test("stylesheetDataURI encodes the sheet", () => {
  const uri = Logic.stylesheetDataURI(':is(a[href="#x"]) { display: none !important; }');
  assert.ok(uri.startsWith("data:text/css;charset=utf-8,"));
  assert.ok(!uri.includes("#"), "a raw # would end the data URI");
  assert.equal(decodeURIComponent(uri.split(",").slice(1).join(",")), ':is(a[href="#x"]) { display: none !important; }');
});

const el = (id, ...classes) => ({ id, classList: classes, nodeType: 1 });

test("TokenCollector hands out each class and id once, in bounded batches", () => {
  const c = new Logic.TokenCollector({ maxPerQuery: 3, maxPerPage: 100 });
  c.addElement(el("main", "a", "b"));
  c.addElement(el("main", "b", "c"));
  c.addElement(el("", "d"));
  assert.deepEqual(c.take(), { classes: ["a", "b", "c"], ids: [] });
  assert.deepEqual(c.take(), { classes: ["d"], ids: ["main"] });
  assert.equal(c.hasPending, false);
  c.addElement(el("main", "a"));
  assert.equal(c.hasPending, false, "already seen");
});

test("TokenCollector stops growing at the per-page cap", () => {
  const c = new Logic.TokenCollector({ maxPerQuery: 1000, maxPerPage: 5 });
  for (let i = 0; i < 20; i++) c.addElement(el(`id${i}`, `c${i}`));
  assert.ok(c.full);
  assert.ok(c.seenCount <= 6, `seen ${c.seenCount}`);
});

test("ExpiringCache expires entries and evicts the least recently used", () => {
  let now = 0;
  const cache = new Logic.ExpiringCache({ maxEntries: 2, ttlMs: 100, now: () => now });
  cache.set("a", 1);
  cache.set("b", 2);
  assert.equal(cache.get("a"), 1); // a is now most recent
  cache.set("c", 3); // evicts b
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  now = 100;
  assert.equal(cache.get("a"), undefined, "expired");
});

test("cacheKeyForURL: origin for http(s), null otherwise", () => {
  assert.equal(Logic.cacheKeyForURL("https://www.bbc.com/news?x=1#y"), "https://www.bbc.com");
  assert.equal(Logic.cacheKeyForURL("http://localhost:8080/a"), "http://localhost:8080");
  assert.equal(Logic.cacheKeyForURL("about:blank"), null);
  assert.equal(Logic.cacheKeyForURL("file:///etc/passwd"), null);
  assert.equal(Logic.cacheKeyForURL("not a url"), null);
});

// ---- parent actor ---------------------------------------------------------------------

function makeParent({ pb = false, browser = {} } = {}) {
  const parent = new ShieldCosmeticParent();
  parent.browsingContext = { usePrivateBrowsing: pb, top: { embedderElement: browser } };
  return parent;
}

beforeEach(() => {
  Services.prefs._reset();
  Services.prefs.setBoolPref("privacy.trackingprotection.content.protection.enabled", true);
  allowList.clear();
  clearShieldCosmeticCache();
  globalThis.__classifierCalls.length = 0;
  globalThis.__cosmetic = {
    hide: ["#leaderboard", ".sponsor"],
    procedural: ['{"selector":[{"type":"css-selector","arg":"div"}]}'],
    exceptions: ["#keep"],
    generichide: false,
    generic: (classes, ids) => [...classes.filter(c => c.startsWith("ad")).map(c => `.${c}`), ...ids.filter(i => i.startsWith("ad")).map(i => `#${i}`)],
  };
});

test("parent: site resources become a stylesheet; cached per origin and per private mode", () => {
  const parent = makeParent();
  const site = parent.receiveMessage({ name: "ShieldCosmetic:Site", data: { url: "https://www.bbc.com/news" } });
  assert.equal(site.css, ":is(#leaderboard,\n.sponsor) { display: none !important; }");
  assert.deepEqual(site.exceptions, ["#keep"]);
  assert.equal(site.generichide, false);

  parent.siteResources("https://www.bbc.com/sport");
  assert.equal(globalThis.__classifierCalls.length, 1, "same origin: cached");

  makeParent({ pb: true }).siteResources("https://www.bbc.com/");
  assert.deepEqual(globalThis.__classifierCalls.at(-1), { cosmetic: "https://www.bbc.com/", pb: true });
  assert.equal(globalThis.__classifierCalls.length, 2, "private windows don't share the cache");
});

test("parent: nothing when element hiding is off, Shield is off, or the site is allow-listed", () => {
  const browser = {};
  const parent = makeParent({ browser });
  Services.prefs.setBoolPref("peryn.shield.cosmetic.enabled", false);
  assert.equal(parent.siteResources("https://a.example/"), null);
  Services.prefs.setBoolPref("peryn.shield.cosmetic.enabled", true);
  Services.prefs.setBoolPref("privacy.trackingprotection.content.protection.enabled", false);
  assert.equal(parent.siteResources("https://a.example/"), null);
  Services.prefs.setBoolPref("privacy.trackingprotection.content.protection.enabled", true);
  allowList.add(browser);
  assert.equal(parent.siteResources("https://a.example/"), null);
  assert.equal(parent.genericStylesheet({ classes: ["ad-box"], ids: [], exceptions: [] }), "");
  assert.equal(globalThis.__classifierCalls.length, 0);
  assert.equal(parent.siteResources("about:blank"), null);
});

test("parent: classifier not ready yet means no styles, and nothing cached", () => {
  globalThis.__cosmetic.throws = true;
  const parent = makeParent();
  assert.equal(parent.siteResources("https://a.example/"), null);
  assert.equal(parent.genericStylesheet({ classes: ["ad-box"], ids: [], exceptions: [] }), "");
  globalThis.__cosmetic.throws = false;
  assert.notEqual(parent.siteResources("https://a.example/"), null, "retried once ready");
});

test("parent: generic lookups pass only strings through to the engine", () => {
  const parent = makeParent();
  const css = parent.receiveMessage({
    name: "ShieldCosmetic:Generic",
    data: { classes: ["ad-box", "header", 7], ids: ["ad-top", null], exceptions: "nope" },
  });
  assert.equal(css, ":is(.ad-box,\n#ad-top) { display: none !important; }");
  assert.deepEqual(globalThis.__classifierCalls.at(-1).generic, {
    classes: ["ad-box", "header"],
    ids: ["ad-top"],
    exceptions: [],
  });
  assert.equal(parent.receiveMessage({ name: "Unknown" }), undefined);
});

// ---- child actor (fake DOM) -----------------------------------------------------------

class FakeElement {
  constructor(id = "", classes = [], children = []) {
    this.id = id;
    this.classList = classes;
    this.children = children;
    this.nodeType = 1;
  }
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  querySelectorAll() {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (child.id || child.classList.length) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

function makePage(url, body) {
  const sheets = [];
  let observer = null;
  const root = new FakeElement("", [], [body]);
  const win = {
    MutationObserver: class {
      constructor(cb) {
        this.cb = cb;
        this.connected = false;
        observer = this;
      }
      observe(target, options) {
        this.connected = true;
        this.options = options;
      }
      disconnect() {
        this.connected = false;
      }
    },
  };
  const doc = {
    documentURI: url,
    readyState: "loading",
    documentElement: root,
    defaultView: win,
    querySelectorAll: () => root.querySelectorAll(),
  };
  const contentWindow = {
    windowUtils: {
      USER_SHEET: 2,
      loadSheetUsingURIString: (uri, type) => sheets.push({ css: decodeURIComponent(uri.split(",").slice(1).join(",")), type }),
    },
  };
  return { doc, contentWindow, sheets, observer: () => observer };
}

function makeChild(page, parent = makeParent()) {
  const child = new ShieldCosmeticChild();
  child.document = page.doc;
  child.contentWindow = page.contentWindow;
  child._parent = parent;
  return child;
}

test("child: site sheet at document start, generic sheet at DOMContentLoaded, then only new tokens", async () => {
  const body = new FakeElement("main", ["page"], [new FakeElement("ad-top", ["ad-box", "header"])]);
  const page = makePage("https://news.example/story", body);
  const child = makeChild(page);

  child.handleEvent({ type: "DOMDocElementInserted", target: page.doc });
  await tick();
  assert.equal(page.sheets.length, 1);
  assert.equal(page.sheets[0].type, 2, "user-level sheet");
  assert.match(page.sheets[0].css, /#leaderboard/);

  page.doc.readyState = "interactive";
  child.handleEvent({ type: "DOMContentLoaded", target: page.doc });
  await tick();
  assert.equal(page.sheets.length, 2);
  assert.equal(page.sheets[1].css, ":is(.ad-box,\n#ad-top) { display: none !important; }");
  const firstQuery = globalThis.__classifierCalls.find(c => c.generic).generic;
  assert.deepEqual(firstQuery.classes.sort(), ["ad-box", "header", "page"]);
  assert.deepEqual(firstQuery.exceptions, ["#keep"], "site exceptions are passed back");

  // An ad injected later, plus an element we've already seen.
  const injected = new FakeElement("", ["ad-late"], [new FakeElement("ad-inner", [])]);
  page.observer().cb([
    { type: "childList", addedNodes: [injected, { nodeType: 3 }] },
    { type: "attributes", target: new FakeElement("main", ["page"]) },
  ]);
  await waitFor(() => page.sheets.length >= 3);
  assert.equal(page.sheets.length, 3);
  assert.equal(page.sheets[2].css, ":is(.ad-late,\n#ad-inner) { display: none !important; }");
  const last = globalThis.__classifierCalls.filter(c => c.generic).at(-1).generic;
  assert.deepEqual(last, { classes: ["ad-late"], ids: ["ad-inner"], exceptions: ["#keep"] });

  child.didDestroy();
  assert.equal(page.observer().connected, false, "observer disconnected on teardown");
});

test("child: a $generichide page gets site rules but no generic lookups", async () => {
  globalThis.__cosmetic.generichide = true;
  const page = makePage("https://accounts.example/", new FakeElement("ad-top", ["ad-box"]));
  const child = makeChild(page);
  child.handleEvent({ type: "DOMDocElementInserted", target: page.doc });
  await tick();
  child.handleEvent({ type: "DOMContentLoaded", target: page.doc });
  await tick();
  assert.equal(page.sheets.length, 1);
  assert.equal(globalThis.__classifierCalls.filter(c => c.generic).length, 0);
  assert.equal(page.observer(), null, "no observer when generic rules don't apply");
});

test("child: a document already parsed when the site answer arrives starts generic hiding at once", async () => {
  const page = makePage("https://late.example/", new FakeElement("", ["ad-box"]));
  page.doc.readyState = "complete";
  const child = makeChild(page);
  child.handleEvent({ type: "DOMDocElementInserted", target: page.doc });
  await tick();
  await tick();
  assert.equal(page.sheets.length, 2);
});

test("child: ignores other documents' events and does nothing when the parent says no", async () => {
  const page = makePage("https://a.example/", new FakeElement("", ["ad-box"]));
  const child = makeChild(page);
  child.handleEvent({ type: "DOMDocElementInserted", target: { other: true } });
  await tick();
  assert.equal(globalThis.__classifierCalls.length, 0);

  Services.prefs.setBoolPref("peryn.shield.cosmetic.enabled", false);
  child.handleEvent({ type: "DOMDocElementInserted", target: page.doc });
  await tick();
  child.handleEvent({ type: "DOMContentLoaded", target: page.doc });
  await tick();
  assert.equal(page.sheets.length, 0);
});

// ---- registration -----------------------------------------------------------------------

test("actor registration: once, http(s) only, all frames, behind the element-hiding pref", () => {
  ShieldCosmetic.init();
  ShieldCosmetic.init();
  const options = ChromeUtils._actors.get(ACTOR_NAME);
  assert.equal(options, ACTOR_OPTIONS);
  assert.deepEqual(options.matches, ["http://*/*", "https://*/*"]);
  assert.equal(options.allFrames, true);
  assert.equal(options.enablePreference, "peryn.shield.cosmetic.enabled");
  assert.deepEqual(Object.keys(options.child.events).sort(), ["DOMContentLoaded", "DOMDocElementInserted"]);
  for (const side of ["parent", "child"]) {
    const rel = options[side].esModuleURI.replace("moz-src:///", "");
    assert.ok(fs.existsSync(path.join(ROOT, "src", rel)), rel);
  }
  const ownPrefs = fs.readFileSync(path.join(ROOT, "prefs/90-own.toml"), "utf8");
  assert.match(ownPrefs, /name = "peryn\.shield\.cosmetic\.enabled"\r?\nvalue = true/);
});
