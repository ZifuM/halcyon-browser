/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Privacy Ledger: a local record of every connection the browser makes by itself and of
 * the trackers it blocks on each site. Nothing in it ever leaves this computer; it's there so
 * the zero-telemetry promise can be checked by anyone, not just taken on trust.
 *
 * One Ledger per browser (all windows share it). Connections are seen through Necko's
 * request observers in the parent process; blocks are read from each page's content blocking
 * log by PerynLedgerTabs, one per window. The data lives in peryn-ledger.json in the profile.
 */

import * as Logic from "./PerynLedgerLogic.sys.mjs";
import { REQUESTS, classify } from "./PerynRequests.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const PREFS = Object.freeze({
  enabled: "peryn.ledger.enabled",
  sites: "peryn.ledger.sites",
});
const FILE_NAME = "peryn-ledger.json";
const SAVE_DELAY_MS = 30000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

class Ledger {
  constructor() {
    this.state = Logic.emptyState();
    this.recent = [];
    this.listeners = new Set();
    this._started = false;
    this._dirty = false;
    this._saveTimer = null;
    this._loaded = null;
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREFS.enabled, true);
  }

  /** Per-site blocking is kept only when history is (it's history in all but name). */
  get keepSites() {
    return Services.prefs.getBoolPref(PREFS.sites, true) && Services.prefs.getBoolPref("places.history.enabled", true);
  }

  get path() {
    return PathUtils.join(PathUtils.profileDir, FILE_NAME);
  }

  /** Start watching (once per process). Safe to call from every window. */
  init() {
    if (this._started) {
      return this._loaded;
    }
    this._started = true;
    Services.obs.addObserver(this, "http-on-modify-request");
    Services.obs.addObserver(this, "browser:purge-session-history");
    Services.obs.addObserver(this, "browser:purge-sanitize-history");
    Services.obs.addObserver(this, "browser:purge-domain-data");
    try {
      lazy.AsyncShutdown.profileBeforeChange.addBlocker("Peryn Ledger: save", () => this.save());
    } catch {}
    this._loaded = this.load();
    return this._loaded;
  }

  async load() {
    try {
      const saved = Logic.normalizeState(await IOUtils.readJSON(this.path));
      // Keep anything recorded while the file was loading.
      for (const [day, value] of Object.entries(this.state.days)) {
        saved.days[day] = mergeDay(saved.days[day], value);
      }
      this.state = saved;
    } catch (e) {
      if (e?.name != "NotFoundError") {
        console.error("Peryn Ledger: couldn't read the ledger, starting a new one", e);
      }
    }
    Logic.prune(this.state, Date.now());
  }

  async save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!this._dirty) {
      return;
    }
    this._dirty = false;
    Logic.prune(this.state, Date.now());
    try {
      await IOUtils.writeJSON(this.path, this.state, { tmpPath: `${this.path}.tmp` });
    } catch (e) {
      console.error("Peryn Ledger: couldn't save", e);
    }
  }

  _changed(event) {
    this._dirty = true;
    if (!this._saveTimer) {
      this._saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** `listener(event)` for live views; returns an unsubscribe function. */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---- connections ---------------------------------------------------------------------------

  observe(subject, topic, data) {
    switch (topic) {
      case "http-on-modify-request":
        if (this.enabled) {
          try {
            this._onRequest(subject.QueryInterface(Ci.nsIHttpChannel));
          } catch (e) {
            // Never let the Ledger get in the way of a request.
          }
        }
        break;
      case "browser:purge-session-history":
      case "browser:purge-sanitize-history":
        Logic.forgetSites(this.state);
        this._changed({ type: "forget" });
        break;
      case "browser:purge-domain-data": {
        const domain = String(data || "").toLowerCase();
        if (domain) {
          Logic.forgetSites(this.state, site => site == domain || site.endsWith(`.${domain}`));
          this._changed({ type: "forget" });
        }
        break;
      }
    }
  }

  _onRequest(channel) {
    const info = channelInfo(channel);
    const by = Logic.madeBy(info);
    if (!by) {
      return;
    }
    const host = channel.URI.host;
    if (!host || LOCAL_HOSTS.has(host)) {
      return;
    }
    this.recordConnection({ host, by, addon: info.addon, url: channel.URI.prePath });
  }

  /** Record one connection (exposed for tests and for requests seen elsewhere). */
  recordConnection({ host, by = "browser", addon = null, url = "", time = Date.now() }) {
    const entry = by == "browser" ? classify(host) : null;
    Logic.recordConnection(this.state, { host, by, entry: entry?.id ?? null, addon, time });
    const event = { type: "connection", host, by, addon, entry: entry?.id ?? null, url, time };
    this.recent.unshift(event);
    this.recent.length = Math.min(this.recent.length, Logic.RECENT_LIMIT);
    this._changed(event);
  }

  // ---- blocks --------------------------------------------------------------------------------

  /**
   * Note what a page's content blocking log adds (PerynLedgerTabs calls this).
   *
   * @param {object} page {site, private, log, seen: Map}
   */
  recordPageLog({ site, private: isPrivate, log, seen, time = Date.now() }) {
    if (!this.enabled || isPrivate) {
      return 0;
    }
    const { counts } = Logic.blockDelta(log, seen);
    const added = Logic.recordBlocked(this.state, { site: this.keepSites ? site : null, counts, time });
    if (added) {
      this._changed({ type: "blocked", site, counts, time });
    }
    return added;
  }

  // ---- reading -------------------------------------------------------------------------------

  summary({ days = 7 } = {}) {
    return Logic.summarize(this.state, { now: Date.now(), days, registry: REQUESTS });
  }

  hostsSeen(options) {
    return Logic.hostsSeen(this.state, { now: Date.now(), ...options });
  }

  /** The whole Ledger as JSON text, for "Export". */
  exportText() {
    return JSON.stringify({ exported: new Date().toISOString(), registry: REQUESTS.map(r => r.id), ...this.state }, null, 2);
  }

  /** Forget everything (a button on the Ledger). */
  clear() {
    this.state = Logic.emptyState();
    this.recent = [];
    this._changed({ type: "clear" });
  }

  _reset() {
    this.state = Logic.emptyState();
    this.recent = [];
    this._dirty = false;
  }
}

function mergeDay(a, b) {
  if (!a) {
    return b;
  }
  for (const [host, c] of Object.entries(b.connections)) {
    const into = (a.connections[host] ??= { ...c, count: 0 });
    into.count += c.count;
    into.last = Math.max(into.last, c.last);
  }
  for (const [site, kinds] of Object.entries(b.blocked)) {
    a.blocked[site] ??= {};
    for (const [kind, n] of Object.entries(kinds)) {
      a.blocked[site][kind] = (a.blocked[site][kind] ?? 0) + n;
    }
  }
  for (const [kind, n] of Object.entries(b.blockedTotal)) {
    a.blockedTotal[kind] = (a.blockedTotal[kind] ?? 0) + n;
  }
  return a;
}

/** What a channel says about who asked for it. */
export function channelInfo(channel) {
  const loadInfo = channel.loadInfo;
  let inContent = false;
  try {
    const bc = loadInfo?.browsingContext;
    inContent = !!bc && bc.isContent;
  } catch {}
  const principal = loadInfo?.loadingPrincipal ?? loadInfo?.triggeringPrincipal ?? null;
  let kind = "none";
  let addon = null;
  if (principal) {
    if (principal.isSystemPrincipal) {
      kind = "system";
    } else if (principal.addonId) {
      kind = "addon";
      addon = principal.addonId;
    } else {
      kind = "content";
    }
  }
  return { inContentBrowsingContext: inContent, loadingPrincipal: kind, addon };
}

export const PerynLedger = new Ledger();

/**
 * Per window: reads each page's content blocking log when Firefox reports blocking, and hands
 * what's new to the Ledger.
 */
export class PerynLedgerTabs {
  constructor(win) {
    this.win = win;
    this.gBrowser = win.gBrowser;
    /** browser -> {page id, seen counts, timer} */
    this.pages = new WeakMap();
  }

  init() {
    PerynLedger.init();
    this.listener = {
      onContentBlockingEvent: (browser, webProgress, request, event) => {
        if (webProgress?.isTopLevel !== false) {
          this._schedule(browser);
        }
      },
    };
    this.gBrowser.addTabsProgressListener(this.listener);
  }

  uninit() {
    this.gBrowser.removeTabsProgressListener(this.listener);
  }

  _schedule(browser) {
    const pageId = browser.browsingContext?.currentWindowGlobal?.innerWindowId ?? 0;
    let page = this.pages.get(browser);
    if (!page || page.id != pageId) {
      page = { id: pageId, seen: new Map(), timer: null };
      this.pages.set(browser, page);
    }
    if (page.timer) {
      return;
    }
    // Blocking comes in bursts while a page loads: read the log once per second at most.
    page.timer = this.win.setTimeout(() => {
      page.timer = null;
      this._read(browser, page).catch(() => {});
    }, 1000);
  }

  async _read(browser, page) {
    const log = await browser.getContentBlockingLog();
    let site = null;
    try {
      site = Services.eTLD.getBaseDomain(browser.currentURI);
    } catch {
      site = browser.currentURI?.host || null;
    }
    PerynLedger.recordPageLog({
      site,
      private: lazy.PrivateBrowsingUtils.isBrowserPrivate(browser),
      log,
      seen: page.seen,
    });
  }
}
