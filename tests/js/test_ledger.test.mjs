// Tests for the Privacy Ledger: who made a request, recording connections and blocks, what
// the Ledger shows, retention, forgetting sites, and the registry it classifies with.
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const Logic = await import("moz-src:///browser/components/peryn/privacy/PerynLedgerLogic.sys.mjs");
const Registry = await import("moz-src:///browser/components/peryn/privacy/PerynRequests.sys.mjs");
ChromeUtils._preload("resource://gre/modules/AsyncShutdown.sys.mjs", { AsyncShutdown: { profileBeforeChange: { addBlocker() {} } } });
ChromeUtils._preload("resource://gre/modules/PrivateBrowsingUtils.sys.mjs", { PrivateBrowsingUtils: { isBrowserPrivate: b => !!b.private } });
const { PerynLedger, channelInfo, PerynLedgerTabs } = await import("moz-src:///browser/components/peryn/privacy/PerynLedger.sys.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DAY = 86400000;
const NOW = new Date(2026, 9, 24, 12, 0, 0).getTime();

beforeEach(() => {
  Services.prefs._reset();
  PerynLedger._reset();
});

test("who made a request: the browser, an add-on, or a page", () => {
  assert.equal(Logic.madeBy({ inContentBrowsingContext: false, loadingPrincipal: "system" }), "browser");
  assert.equal(Logic.madeBy({ inContentBrowsingContext: false, loadingPrincipal: "none" }), "browser");
  assert.equal(Logic.madeBy({ inContentBrowsingContext: true, loadingPrincipal: "system" }), null, "a tab's own load");
  assert.equal(Logic.madeBy({ inContentBrowsingContext: false, loadingPrincipal: "content" }), null, "a page's favicon or prefetch");
  assert.equal(Logic.madeBy({ inContentBrowsingContext: true, loadingPrincipal: "addon" }), "addon");
});

test("channel info reads Firefox's loadInfo", () => {
  const ch = (bc, principal) => ({ loadInfo: { browsingContext: bc, loadingPrincipal: principal } });
  assert.deepEqual(channelInfo(ch(null, { isSystemPrincipal: true })), { inContentBrowsingContext: false, loadingPrincipal: "system", addon: null });
  assert.deepEqual(channelInfo(ch({ isContent: true }, { isSystemPrincipal: false, addonId: "" })), { inContentBrowsingContext: true, loadingPrincipal: "content", addon: null });
  assert.deepEqual(channelInfo(ch({ isContent: true }, { isSystemPrincipal: false, addonId: "ublock@x" })).addon, "ublock@x");
  assert.equal(channelInfo(ch(null, null)).loadingPrincipal, "none");
});

test("blocking flags map to kinds; allowed entries don't count", () => {
  assert.equal(Logic.kindOfFlag(Logic.FLAGS.STATE_BLOCKED_TRACKING_CONTENT), "tracker");
  assert.equal(Logic.kindOfFlag(Logic.FLAGS.STATE_BLOCKED_FINGERPRINTING_CONTENT), "fingerprinter");
  assert.equal(Logic.kindOfFlag(Logic.FLAGS.STATE_BLOCKED_SOCIALTRACKING_CONTENT), "social");
  assert.equal(Logic.kindOfFlag(Logic.FLAGS.STATE_COOKIES_BLOCKED_TRACKER), "cookie");
  assert.equal(Logic.kindOfFlag(0x4), null);
});

test("a page's running log only adds what's new since it was last read", () => {
  const T = Logic.FLAGS.STATE_BLOCKED_TRACKING_CONTENT;
  const F = Logic.FLAGS.STATE_BLOCKED_FINGERPRINTING_CONTENT;
  const seen = new Map();
  let d = Logic.blockDelta({ "https://ads.example": [[T, true, 2]], "https://ok.example": [[T, false, 5]] }, seen);
  assert.deepEqual(d.counts, { tracker: 2 });
  d = Logic.blockDelta(JSON.stringify({ "https://ads.example": [[T, true, 3]], "https://fp.example": [[F, true, 1]] }), seen);
  assert.deepEqual(d.counts, { tracker: 1, fingerprinter: 1 });
  assert.deepEqual(d.origins.sort(), ["https://ads.example", "https://fp.example"]);
  assert.deepEqual(Logic.blockDelta("not json", seen).counts, {});
});

test("connections are kept per day and per host, classified by the registry", () => {
  PerynLedger.recordConnection({ host: "firefox.settings.services.mozilla.com", time: NOW });
  PerynLedger.recordConnection({ host: "firefox.settings.services.mozilla.com", time: NOW + 1000 });
  PerynLedger.recordConnection({ host: "edgedl.me.gvt1.com", time: NOW });
  PerynLedger.recordConnection({ host: "mystery.example", time: NOW });
  PerynLedger.recordConnection({ host: "api.addon.example", by: "addon", addon: "helper@example", time: NOW });
  const day = PerynLedger.state.days[Logic.dayOf(NOW)];
  assert.equal(day.connections["firefox.settings.services.mozilla.com"].count, 2);
  assert.equal(day.connections["firefox.settings.services.mozilla.com"].entry, "remote-settings");
  assert.equal(day.connections["edgedl.me.gvt1.com"].entry, "media-plugins", "wildcard hosts");
  assert.equal(day.connections["mystery.example"].entry, null);
  assert.equal(PerynLedger.recent[0].host, "api.addon.example");

  const s = Logic.summarize(PerynLedger.state, { now: NOW, registry: Registry.REQUESTS });
  const rs = s.connections.find(c => c.id == "remote-settings");
  assert.equal(rs.seen, 2);
  assert.ok(rs.purpose.length > 10, "each connection carries what it's for");
  assert.equal(s.connections.find(c => c.id == "app-updates").seen, 0, "listed but not seen");
  assert.deepEqual(s.unknown.map(u => u.host), ["mystery.example"]);
  assert.deepEqual(s.addons[0].hosts, ["api.addon.example"]);
});

test("blocks are counted per site, not in private windows, and only as totals with history off", () => {
  const T = Logic.FLAGS.STATE_BLOCKED_TRACKING_CONTENT;
  PerynLedger.recordPageLog({ site: "news.example", log: { "https://ads.example": [[T, true, 3]] }, seen: new Map(), time: NOW });
  PerynLedger.recordPageLog({ site: "secret.example", private: true, log: { "https://ads.example": [[T, true, 9]] }, seen: new Map(), time: NOW });
  Services.prefs.setBoolPref("places.history.enabled", false);
  PerynLedger.recordPageLog({ site: "shop.example", log: { "https://ads.example": [[T, true, 2]] }, seen: new Map(), time: NOW });
  const day = PerynLedger.state.days[Logic.dayOf(NOW)];
  assert.deepEqual(Object.keys(day.blocked), ["news.example"]);
  assert.equal(day.blockedTotal.tracker, 5);
  const s = Logic.summarize(PerynLedger.state, { now: NOW });
  assert.equal(s.blockedCount, 5);
  assert.equal(s.topSites[0].site, "news.example");
});

test("old days drop off; clearing history forgets sites but keeps totals", () => {
  const state = Logic.emptyState();
  Logic.recordConnection(state, { host: "a.example", time: NOW - 40 * DAY });
  Logic.recordConnection(state, { host: "b.example", time: NOW });
  Logic.recordBlocked(state, { site: "news.example", counts: { tracker: 2 }, time: NOW });
  Logic.recordBlocked(state, { site: "mail.news.example", counts: { tracker: 1 }, time: NOW });
  Logic.prune(state, NOW);
  assert.deepEqual(Logic.hostsSeen(state, { now: NOW }), ["b.example"]);
  Logic.forgetSites(state, site => site == "news.example");
  assert.deepEqual(Object.keys(state.days[Logic.dayOf(NOW)].blocked), ["mail.news.example"]);
  Logic.forgetSites(state);
  assert.deepEqual(state.days[Logic.dayOf(NOW)].blocked, {});
  assert.equal(state.days[Logic.dayOf(NOW)].blockedTotal.tracker, 3);
});

test("clearing history through Firefox reaches the Ledger", () => {
  PerynLedger.recordPageLog({ site: "news.example", log: { x: [[Logic.FLAGS.STATE_BLOCKED_TRACKING_CONTENT, true, 1]] }, seen: new Map(), time: Date.now() });
  PerynLedger.observe(null, "browser:purge-domain-data", "example");
  assert.equal(Object.keys(PerynLedger.state.days[Logic.dayOf(Date.now())].blocked).length, 0);
});

test("stored data is read defensively", () => {
  assert.deepEqual(Logic.normalizeState("{bad"), Logic.emptyState());
  const s = Logic.normalizeState({
    days: {
      "2026-10-24": { connections: { "a.example": { count: 2, entry: "x", last: 5 }, bad: { count: -1 } }, blocked: { "s.example": { tracker: 1, nonsense: 4 } }, blockedTotal: { tracker: 1 } },
      "not-a-day": {},
    },
  });
  assert.deepEqual(Object.keys(s.days), ["2026-10-24"]);
  assert.deepEqual(Object.keys(s.days["2026-10-24"].connections), ["a.example"]);
  assert.deepEqual(s.days["2026-10-24"].blocked["s.example"], { tracker: 1 });
});

test("a day keeps at most so many hosts, so a runaway can't fill the disk", () => {
  const state = Logic.emptyState();
  for (let i = 0; i < Logic.MAX_HOSTS_PER_DAY + 10; i++) {
    Logic.recordConnection(state, { host: `h${i}.example`, time: NOW });
  }
  assert.equal(Object.keys(state.days[Logic.dayOf(NOW)].connections).length, Logic.MAX_HOSTS_PER_DAY);
});

test("export is the whole Ledger as JSON", () => {
  PerynLedger.recordConnection({ host: "api.github.com", time: NOW });
  const out = JSON.parse(PerynLedger.exportText());
  assert.ok(out.exported);
  assert.equal(out.days[Logic.dayOf(NOW)].connections["api.github.com"].entry, "app-updates");
});

test("the Ledger's registry is generated from privacy/requests.toml and classifies like the audit", () => {
  const toml = fs.readFileSync(path.join(ROOT, "privacy/requests.toml"), "utf8");
  const ids = [...toml.matchAll(/^id = "([^"]+)"/gm)].map(m => m[1]);
  assert.deepEqual(Registry.REQUESTS.map(r => r.id), ids);
  assert.ok(Registry.hostMatches("*.gvt1.com", "r1.gvt1.com"));
  assert.ok(!Registry.hostMatches("*.gvt1.com", "gvt1.com"), "the wildcard covers subdomains only, as in the audit");
  assert.equal(Registry.classify("API.GITHUB.COM.").id, "app-updates");
});

test("per window: a page's blocking is read once per burst", async () => {
  const listeners = [];
  const timers = [];
  const win = {
    gBrowser: { addTabsProgressListener: l => listeners.push(l), removeTabsProgressListener() {} },
    setTimeout: fn => timers.push(fn),
  };
  const tabs = new PerynLedgerTabs(win);
  Services.obs = { addObserver() {} };
  Services.eTLD = { getBaseDomain: uri => uri.host.split(".").slice(-2).join(".") };
  tabs.init();
  const T = Logic.FLAGS.STATE_BLOCKED_TRACKING_CONTENT;
  const browser = {
    currentURI: { host: "www.news.example" },
    browsingContext: { currentWindowGlobal: { innerWindowId: 7 } },
    getContentBlockingLog: async () => JSON.stringify({ "https://ads.example": [[T, true, 4]] }),
  };
  listeners[0].onContentBlockingEvent(browser, { isTopLevel: true }, null, T);
  listeners[0].onContentBlockingEvent(browser, { isTopLevel: true }, null, T);
  assert.equal(timers.length, 1, "coalesced");
  await timers[0]();
  await new Promise(r => setTimeout(r, 0));
  const day = PerynLedger.state.days[Logic.dayOf(Date.now())];
  assert.deepEqual(day.blocked["news.example"], { tracker: 4 });
});

// ---- the privacy page's words --------------------------------------------------------------

const Privacy = await import("moz-src:///browser/components/peryn/privacy/PerynPrivacyLogic.sys.mjs");

test("privacy page: presets say what they change and may break; no score anywhere", () => {
  for (const id of ["strict", "standard", "custom"]) {
    const p = Privacy.PRESETS[id];
    assert.equal(p.category, id);
    assert.ok(p.changes.length && p.breaks.length, id);
  }
  assert.equal(Privacy.presetFor("nonsense").category, "custom");
  assert.equal(Privacy.PRESETS.standard.title, "Balanced");
  const src = fs.readFileSync(path.join(ROOT, "src/browser/components/peryn/privacy/PerynPrivacy.sys.mjs"), "utf8");
  assert.doesNotMatch(src + JSON.stringify(Privacy), /score/i, "real counts, not a privacy score");
});

test("privacy page: permissions people look for come first; clear-data choices are Firefox's", () => {
  assert.deepEqual(Privacy.orderPermissions(["popup", "cookie", "geo", "camera"]), ["camera", "geo", "popup", "cookie"]);
  assert.deepEqual(Privacy.CLEAR_ITEMS.map(i => i.id), ["browsingHistoryAndDownloads", "cookiesAndStorage", "cache", "formdata", "siteSettings"]);
  assert.deepEqual(Privacy.RANGES.map(r => r.timespan), [1, 2, 3, 4, 0], "Sanitizer.TIMESPAN_* values");
});

test("privacy page: plain counts and times", () => {
  assert.equal(Privacy.formatCount(12345), "12,345");
  assert.equal(Privacy.ago(NOW - 120 * 1000, NOW), "2 minutes ago");
  assert.equal(Privacy.ago(NOW - DAY, NOW), "yesterday");
  assert.equal(Privacy.ago(0, NOW), "never");
  const lines = Privacy.overviewLines({
    days: 7,
    blockedCount: 1200,
    connections: [{ seen: 3 }, { seen: 0 }, { seen: 2 }],
    unknown: [{ host: "x" }],
  });
  assert.equal(lines[0], "1,200 trackers and ads blocked in the last 7 days.");
  assert.equal(lines[1], "The browser connected on its own 5 times in the last 7 days, for 2 listed purposes.");
  assert.match(lines[2], /isn't on the list/);
  assert.equal(Privacy.overviewLines({ days: 1, blockedCount: 0, connections: [], unknown: [] })[0], "Nothing blocked today yet.");
});
