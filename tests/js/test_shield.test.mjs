// Tests for Shield's list logic and list manager, with mocked Firefox APIs:
//   node --import ./tests/js/register.mjs --test tests/js/*.test.mjs
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as Timer from "./mocks/Timer.mjs";

ChromeUtils._preload("resource://gre/modules/Timer.sys.mjs", Timer);

const Logic = await import("moz-src:///browser/components/peryn/shield/ShieldListLogic.sys.mjs");
const { ShieldLists } = await import("moz-src:///browser/components/peryn/shield/ShieldLists.sys.mjs");

const noFetch = async url => {
  throw new Error(`unexpected fetch ${url}`);
};

// ---- preprocessing -----------------------------------------------------------

test("evalCondition handles !, &&, ||, parentheses and unknown tokens", () => {
  const env = { a: true, b: false };
  assert.equal(Logic.evalCondition("a", env), true);
  assert.equal(Logic.evalCondition("!a", env), false);
  assert.equal(Logic.evalCondition("a && b", env), false);
  assert.equal(Logic.evalCondition("a || b", env), true);
  assert.equal(Logic.evalCondition("!(a && b)", env), true);
  assert.equal(Logic.evalCondition("(b || a) && !b", env), true);
  assert.equal(Logic.evalCondition("unknown_token", env), false);
  assert.throws(() => Logic.evalCondition("(a", env));
});

test("our environment: Gecko desktop, no uBO-only capabilities", () => {
  assert.equal(Logic.evalCondition("env_firefox"), true);
  assert.equal(Logic.evalCondition("env_mobile"), false);
  assert.equal(Logic.evalCondition("cap_html_filtering"), false);
  assert.equal(Logic.evalCondition("(ext_ublock || adguard)"), false);
  assert.equal(Logic.evalCondition("!env_mv3"), true);
});

test("assembleList keeps the right branches, drops comments, handles nesting", async () => {
  const text = [
    "! Title: test",
    "[Adblock Plus 2.0]",
    "||always.example^",
    "!#if env_mobile",
    "||mobile-only.example^",
    "!#else",
    "||desktop.example^",
    "!#if cap_html_filtering",
    "example.com##^script:has-text(x)",
    "!#endif",
    "!#endif",
    "!#if !env_safari",
    "||not-safari.example^",
    "!#endif",
    "",
  ].join("\n");
  const rules = await Logic.assembleList({ url: "https://h/x/list.txt", text, fetchText: noFetch });
  assert.deepEqual(rules, ["||always.example^", "||desktop.example^", "||not-safari.example^"]);
});

test("includes resolve next to the parent, recurse, and can't escape the directory", async () => {
  const served = {
    "https://h/filters/part.txt": "||part.example^\n!#include sub/deep.txt\n",
    "https://h/filters/sub/deep.txt": "||deep.example^\n",
  };
  const fetched = [];
  const fetchText = async url => {
    fetched.push(url);
    if (!(url in served)) throw new Error(`404 ${url}`);
    return served[url];
  };
  const text = "!#include part.txt\n!#include ../secret.txt\n!#include https://evil.example/x.txt\n||main.example^";
  const rules = await Logic.assembleList({ url: "https://h/filters/main.txt", text, fetchText });
  assert.deepEqual(rules, ["||part.example^", "||deep.example^", "||main.example^"]);
  assert.deepEqual(fetched, ["https://h/filters/part.txt", "https://h/filters/sub/deep.txt"]);
});

test("a failed include is skipped with onIncludeError, and fatal without it", async () => {
  const text = "||a.example^\n!#include missing.txt\n||b.example^";
  const errors = [];
  const rules = await Logic.assembleList({
    url: "https://h/f/main.txt",
    text,
    fetchText: noFetch,
    onIncludeError: url => errors.push(url),
  });
  assert.deepEqual(rules, ["||a.example^", "||b.example^"]);
  assert.deepEqual(errors, ["https://h/f/missing.txt"]);
  await assert.rejects(Logic.assembleList({ url: "https://h/f/main.txt", text, fetchText: noFetch }));
});

test("hosts-format lists become network filters", async () => {
  const text = "# comment\n127.0.0.1 localhost\n0.0.0.0 ads.example.com\n127.0.0.1  Tracker.Example.net # x\nnot a host line\n";
  const rules = await Logic.assembleList({ url: "https://h/hosts", text, format: "hosts", fetchText: noFetch });
  assert.deepEqual(rules, ["||ads.example.com^", "||tracker.example.net^"]);
});

test("expiry parsing and staleness", () => {
  assert.equal(Logic.parseExpiresHours("! Expires: 5 days\n"), 120);
  assert.equal(Logic.parseExpiresHours("! Expires: 4 hours"), 4);
  assert.equal(Logic.parseExpiresHours("! Expires: 1 hour"), 4, "clamped to 4 h minimum");
  assert.equal(Logic.parseExpiresHours("! Expires: 30 days"), 168, "clamped to a week");
  assert.equal(Logic.parseExpiresHours("no header"), 24);
  assert.equal(Logic.isStale(undefined, 1000), true);
  assert.equal(Logic.isStale({ fetchedAtSec: 1000, expiresHours: 1 }, 1000 + 3599), false);
  assert.equal(Logic.isStale({ fetchedAtSec: 1000, expiresHours: 1 }, 1000 + 3600), true);
  assert.equal(Logic.isStale({ fetchedAtSec: 5000 }, 1000), true, "clock went backwards");
});

test("catalog: unique ids, two mirrors each, uBO defaults on, annoyances off", () => {
  const ids = Logic.SHIELD_LISTS.map(l => l.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const list of Logic.SHIELD_LISTS) {
    assert.equal(list.urls.length, 2, list.id);
    assert.ok(list.urls.every(u => u.startsWith("https://")), list.id);
  }
  const defaults = Logic.SHIELD_LISTS.filter(l => l.defaultEnabled).map(l => l.id);
  assert.deepEqual(defaults, [
    "ublock-filters", "ublock-badware", "ublock-privacy", "ublock-quick-fixes",
    "ublock-unbreak", "easylist", "easyprivacy", "peter-lowe",
  ]);
});

// ---- list manager (runtime) ----------------------------------------------------

let fetchLog;
function serve(table) {
  globalThis.fetch = async (url, options) => {
    fetchLog.push({ url, options });
    const entry = table[url];
    if (entry === undefined) {
      return { ok: false, status: 404, headers: new Map(), text: async () => "" };
    }
    if (typeof entry === "number") {
      return { ok: entry < 400, status: entry, headers: new Map(), text: async () => "" };
    }
    const etag = entry.etag ?? null;
    if (etag && options?.headers?.["If-None-Match"] === etag) {
      return { ok: false, status: 304, headers: new Map([["ETag", etag]]), text: async () => "" };
    }
    return { ok: true, status: 200, headers: new Map([["ETag", etag]]), text: async () => entry.body };
  };
}

const PRIMARY = id => Logic.SHIELD_LISTS.find(l => l.id === id).urls[0];
const FALLBACK = id => Logic.SHIELD_LISTS.find(l => l.id === id).urls[1];

beforeEach(() => {
  Services.prefs._reset();
  Services.io.offline = false;
  IOUtils._files.clear();
  globalThis.__classifierCalls.length = 0;
  ShieldLists._state = null;
  fetchLog = [];
  // Only EasyList enabled, to keep tests small.
  for (const list of Logic.SHIELD_LISTS) {
    Services.prefs.setBoolPref(`peryn.shield.list.${list.id}.enabled`, list.id === "easylist");
  }
  globalThis.__classifierCalls.length = 0;
});

test("downloads enabled lists, caches them, and tells the classifier to rebuild", async () => {
  serve({ [PRIMARY("easylist")]: { body: "! Expires: 4 days\n||ads.example^\n", etag: '"v1"' } });
  const changed = await ShieldLists.updateStale();
  assert.deepEqual(changed, ["easylist"]);
  assert.equal(fetchLog[0].options.credentials, "omit");
  assert.equal(fetchLog[0].options.referrerPolicy, "no-referrer");
  assert.equal(IOUtils._files.get("/profile/shield/easylist.txt"), "||ads.example^\n");
  const state = JSON.parse(IOUtils._files.get("/profile/shield/state.json"));
  assert.equal(state.lists.easylist.expiresHours, 96);
  assert.equal(state.lists.easylist.etag, '"v1"');
  assert.deepEqual(globalThis.__classifierCalls, [{ updated: ["shield-easylist"], removed: [] }]);

  const bytes = await ShieldLists.getListBytes("easylist");
  assert.equal(new TextDecoder().decode(bytes), "||ads.example^\n");
});

test("fresh lists aren't re-downloaded; forced checks use the ETag (304 = no rebuild)", async () => {
  serve({ [PRIMARY("easylist")]: { body: "||ads.example^\n", etag: '"v1"' } });
  await ShieldLists.updateStale();
  globalThis.__classifierCalls.length = 0;
  fetchLog = [];
  await ShieldLists.updateStale();
  assert.equal(fetchLog.length, 0, "not stale yet");
  await ShieldLists.updateStale({ force: true });
  assert.equal(fetchLog[0].options.headers["If-None-Match"], '"v1"');
  assert.equal(globalThis.__classifierCalls.length, 0, "unchanged list: no rebuild");
});

test("falls back to the second mirror when the first fails", async () => {
  serve({ [PRIMARY("easylist")]: 503, [FALLBACK("easylist")]: { body: "||mirror.example^\n" } });
  assert.deepEqual(await ShieldLists.updateStale(), ["easylist"]);
  assert.equal(IOUtils._files.get("/profile/shield/easylist.txt"), "||mirror.example^\n");
});

test("disabled, unknown and not-yet-downloaded lists give empty bytes", async () => {
  assert.equal((await ShieldLists.getListBytes("easylist")).length, 0, "not downloaded yet");
  assert.equal((await ShieldLists.getListBytes("easyprivacy")).length, 0, "disabled");
  assert.equal((await ShieldLists.getListBytes("../../etc/passwd")).length, 0, "unknown id");
});

test("no downloads when list updates are switched off or offline", async () => {
  serve({ [PRIMARY("easylist")]: { body: "||ads.example^\n" } });
  Services.prefs.setBoolPref("peryn.shield.updates.enabled", false);
  assert.deepEqual(await ShieldLists.updateStale(), []);
  Services.prefs.setBoolPref("peryn.shield.updates.enabled", true);
  Services.io.offline = true;
  assert.deepEqual(await ShieldLists.updateStale(), []);
  assert.equal(fetchLog.length, 0);
});

test("turning a list off rebuilds without it; turning one on downloads it first", async () => {
  serve({
    [PRIMARY("easylist")]: { body: "||ads.example^\n" },
    [PRIMARY("easyprivacy")]: { body: "||tracker.example^\n" },
  });
  ShieldLists.init();
  await ShieldLists._updating;
  globalThis.__classifierCalls.length = 0;

  Services.prefs.setBoolPref("peryn.shield.list.easylist.enabled", false);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(globalThis.__classifierCalls.at(-1), { updated: ["shield-easylist"], removed: [] });
  assert.equal((await ShieldLists.getListBytes("easylist")).length, 0);

  Services.prefs.setBoolPref("peryn.shield.list.easyprivacy.enabled", true);
  await new Promise(r => setTimeout(r, 10));
  await ShieldLists._updating;
  assert.equal(IOUtils._files.get("/profile/shield/easyprivacy.txt"), "||tracker.example^\n");
  assert.deepEqual(globalThis.__classifierCalls.at(-1), { updated: ["shield-easyprivacy"], removed: [] });
});

test("concurrent update requests share one run", async () => {
  serve({ [PRIMARY("easylist")]: { body: "||ads.example^\n" } });
  const [a, b] = await Promise.all([ShieldLists.updateStale(), ShieldLists.updateStale()]);
  assert.deepEqual(a, ["easylist"]);
  assert.equal(a, b);
  assert.equal(fetchLog.length, 1);
});
