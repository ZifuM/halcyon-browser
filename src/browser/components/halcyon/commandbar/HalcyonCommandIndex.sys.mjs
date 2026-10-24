/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * What the command bar searches, shared by all windows: history and bookmarks (loaded from
 * Places once, then kept current from Places notifications), the built-in actions, Spaces,
 * and open tabs (refreshed each time the bar opens). Everything is searched by one OmniIndex.
 *
 * All of it stays in memory in this process. Nothing is sent anywhere.
 */

import { OmniIndex } from "./OmniIndex.sys.mjs";
import * as Logic from "./HalcyonCommandLogic.sys.mjs";
import { HalcyonSpacesStore as Store } from "../spaces/HalcyonSpacesStore.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const { KIND } = Logic;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const PLACES_EVENTS = [
  "page-visited",
  "page-title-changed",
  "page-removed",
  "history-cleared",
  "bookmark-added",
  "bookmark-removed",
  "bookmark-title-changed",
  "bookmark-url-changed",
];
/** Reload history and bookmarks in full at most this often (frecency drifts over time). */
const FULL_RELOAD_MS = 30 * 60 * 1000;
const RELOAD_DEBOUNCE_MS = 2000;
/** Rows added between breaks, so loading 100,000 entries never holds up the browser. */
const LOAD_CHUNK = 4000;

const PLACES_SQL = `
  SELECT h.url AS url,
         IFNULL(b.title, h.title) AS title,
         h.frecency AS frecency,
         h.last_visit_date AS visited,
         b.fk IS NOT NULL AS bookmarked
  FROM moz_places h
  LEFT JOIN (SELECT fk, MAX(title) AS title FROM moz_bookmarks WHERE type = 1 GROUP BY fk) b
    ON b.fk = h.id
  WHERE (h.hidden = 0 AND h.frecency <> 0) OR b.fk IS NOT NULL
  ORDER BY bookmarked DESC, h.frecency DESC
  LIMIT :limit`;

class CommandIndex {
  constructor() {
    /** @type {OmniIndex|null} */
    this.index = null;
    /** id -> {kind, key, title, url, data} */
    this.entries = new Map();
    /** key ("h:<url>", "b:<url>", "a:<id>", "s:<id>", "t:<n>") -> id */
    this.byKey = new Map();
    this._ready = null;
    this._placesLoaded = 0;
    this._reloadTimer = 0;
    this._maxFrecency = 1;
    this._added = 0;
    this._onPlaces = events => this._handlePlacesEvents(events);
  }

  /**
   * Load the index once (later calls return the same promise).
   *
   * @param {object} [options]
   * @param {object} [options.index] an index to use instead of loading the WebAssembly one
   * @param {boolean} [options.places] load history and bookmarks (default true)
   */
  ready(options = {}) {
    this._ready ??= this._init(options);
    return this._ready;
  }

  async _init({ index, places = true } = {}) {
    this.index = index ?? (await OmniIndex.load());
    this._addActions();
    this._addSpaces();
    if (places) {
      await this.loadPlaces().catch(e => console.error("Halcyon command bar: history load failed", e));
      lazy.PlacesUtils.observers.addListener(PLACES_EVENTS, this._onPlaces);
    }
    this.index.prepare();
    return this;
  }

  /** For tests: forget everything. */
  _reset() {
    if (this._ready) {
      try {
        lazy.PlacesUtils.observers.removeListener(PLACES_EVENTS, this._onPlaces);
      } catch {}
    }
    this.index?.clear();
    this.entries.clear();
    this.byKey.clear();
    this._ready = null;
  }

  // ---- entries -----------------------------------------------------------------------------

  _put(kind, key, title, url, boost, age, data = null) {
    this._drop(key);
    const id = this.index.add(kind, title || url, url || "", boost, age);
    this._added++;
    this.entries.set(id, { id, kind, key, title: title || url, url, boost, age, data });
    this.byKey.set(key, id);
    return id;
  }

  _drop(key) {
    const id = this.byKey.get(key);
    if (id === undefined) {
      return false;
    }
    this.index.remove(id);
    this.entries.delete(id);
    this.byKey.delete(key);
    return true;
  }

  _dropAll(prefix) {
    for (const key of [...this.byKey.keys()]) {
      if (key.startsWith(prefix)) {
        this._drop(key);
      }
    }
  }

  _addActions() {
    for (const action of Logic.ACTIONS) {
      // Keywords go where a page's address would; actions rank as quite useful by default.
      this._put(KIND.action, `a:${action.id}`, action.title, action.keywords, 30, 0, { action });
    }
  }

  _addSpaces() {
    const refresh = () => {
      this._dropAll("s:");
      Store.spaces.forEach((space, i) => {
        this._put(KIND.space, `s:${space.id}`, space.name, `space switch ${space.icon ?? ""}`, 40 - i, 0, {
          space,
        });
      });
    };
    refresh();
    this._unsubscribeSpaces?.();
    this._unsubscribeSpaces = Store.subscribe(() => {
      if (this.index) {
        refresh();
      }
    });
  }

  // ---- history and bookmarks ---------------------------------------------------------------

  get historyLimit() {
    return Services.prefs.getIntPref(Logic.PREFS.historyLimit, Logic.DEFAULT_HISTORY_LIMIT);
  }

  async loadPlaces() {
    const db = await lazy.PlacesUtils.promiseLargeCacheDBConnection();
    const rows = [];
    await db.execute(PLACES_SQL, { limit: this.historyLimit }, row => {
      rows.push({
        url: row.getResultByName("url"),
        title: row.getResultByName("title") ?? "",
        frecency: row.getResultByName("frecency") ?? 0,
        visited: row.getResultByName("visited") ?? 0,
        bookmarked: !!row.getResultByName("bookmarked"),
      });
    });
    await this.replacePlaces(rows);
  }

  /**
   * Bring history and bookmark entries in line with `rows` (as loadPlaces makes them): new
   * ones added, changed ones updated, missing ones removed. Works in chunks with breaks in
   * between, and never empties the index first, so searching keeps working throughout.
   */
  async replacePlaces(rows, now = Date.now()) {
    this._maxFrecency = rows.reduce((max, r) => Math.max(max, r.frecency || 0), 1);
    const seen = new Set();
    let n = 0;
    for (const row of rows) {
      if (!Logic.indexable(row.url)) {
        continue;
      }
      const boost = Logic.boostFromFrecency(row.frecency, this._maxFrecency);
      const age = Logic.ageDays(row.visited, now);
      const [kind, key, b] = row.bookmarked
        ? [KIND.bookmark, `b:${row.url}`, Math.max(boost, 20)]
        : [KIND.history, `h:${row.url}`, boost];
      seen.add(key);
      const existing = this.entries.get(this.byKey.get(key));
      if (existing && existing.title == (row.title || row.url)) {
        if (Math.abs(existing.boost - b) > 0.5 || Math.abs(existing.age - age) > 0.5) {
          existing.boost = b;
          existing.age = age;
          this.index.touch(existing.id, b, age);
        }
      } else {
        this._put(kind, key, row.title, row.url, b, age);
      }
      if (++n % LOAD_CHUNK == 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    for (const key of [...this.byKey.keys()]) {
      if ((key.startsWith("h:") || key.startsWith("b:")) && !seen.has(key)) {
        this._drop(key);
      }
    }
    this._placesLoaded = now;
    this.index.prepare();
  }

  _scheduleReload() {
    if (this._reloadTimer) {
      return;
    }
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = 0;
      this.loadPlaces().catch(e => console.error("Halcyon command bar: history reload failed", e));
    }, RELOAD_DEBOUNCE_MS);
  }

  /** A visited page: update its entry, or add it. */
  _visited(url, title, visitCount, now = Date.now()) {
    if (!Logic.indexable(url)) {
      return;
    }
    for (const prefix of ["b:", "h:"]) {
      const id = this.byKey.get(prefix + url);
      if (id !== undefined) {
        const entry = this.entries.get(id);
        entry.boost = Math.min(100, entry.boost + 4);
        entry.age = 0;
        this.index.touch(id, entry.boost, 0);
        return;
      }
    }
    const boost = Math.min(100, 20 + 10 * Math.log1p(visitCount || 1));
    this._put(KIND.history, `h:${url}`, title, url, boost, 0);
  }

  _retitle(key, title) {
    const id = this.byKey.get(key);
    if (id === undefined) {
      return;
    }
    const e = this.entries.get(id);
    this._put(e.kind, key, title, e.url, e.boost, e.age, e.data);
  }

  _handlePlacesEvents(events) {
    for (const event of events) {
      try {
        this._handlePlacesEvent(event);
      } catch (e) {
        console.error("Halcyon command bar: Places event", e);
      }
    }
  }

  _handlePlacesEvent(event) {
    const TYPE_BOOKMARK = lazy.PlacesUtils.bookmarks?.TYPE_BOOKMARK ?? 1;
    switch (event.type) {
      case "page-visited":
        if (!event.hidden) {
          this._visited(event.url, event.lastKnownTitle, event.visitCount);
        }
        break;
      case "page-title-changed":
        this._retitle(`h:${event.url}`, event.title);
        break;
      case "page-removed":
        if (event.isRemovedFromStore) {
          this._drop(`h:${event.url}`);
        }
        break;
      case "history-cleared":
        this._dropAll("h:");
        break;
      case "bookmark-added":
        if (event.itemType == TYPE_BOOKMARK && Logic.indexable(event.url)) {
          const old = this.entries.get(this.byKey.get(`h:${event.url}`));
          this._drop(`h:${event.url}`);
          this._put(KIND.bookmark, `b:${event.url}`, event.title || old?.title, event.url, Math.max(old?.boost ?? 0, 20), old?.age ?? 0);
        }
        break;
      case "bookmark-removed":
        if (event.itemType == TYPE_BOOKMARK) {
          // It may still be bookmarked elsewhere, or be in history: the next reload decides.
          this._drop(`b:${event.url}`);
          this._scheduleReload();
        }
        break;
      case "bookmark-title-changed":
        if (event.url) {
          this._retitle(`b:${event.url}`, event.title);
        }
        break;
      case "bookmark-url-changed":
        this._scheduleReload();
        break;
    }
  }

  // ---- tabs --------------------------------------------------------------------------------

  /**
   * Refresh the open-tab entries for a window that's about to search: tabs of all normal
   * windows (or, from a private window, of private windows only).
   *
   * @param {Window} fromWindow
   * @param {(tab) => string} [spaceName] the name of a tab's Space, for display
   */
  refreshTabs(fromWindow, spaceName = () => "") {
    this._dropAll("t:");
    const isPrivate = w => lazy.PrivateBrowsingUtils.isWindowPrivate(w);
    const privateOnly = isPrivate(fromWindow);
    const windows = lazy.BrowserWindowTracker.orderedWindows.filter(w => isPrivate(w) == privateOnly && w.gBrowser);
    const now = Date.now();
    // How many open tabs show each page (the one you're on included), for @duplicates.
    const counts = new Map();
    for (const win of windows) {
      for (const tab of win.gBrowser.tabs) {
        const key = Logic.duplicateKey(tab.linkedBrowser?.currentURI?.spec);
        if (key && !tab.closing) {
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
    }
    let n = 0;
    for (const win of windows) {
      for (const tab of win.gBrowser.tabs) {
        if (tab.closing || (win == fromWindow && tab.selected)) {
          continue;
        }
        const url = tab.linkedBrowser?.currentURI?.spec ?? "";
        if (url == "about:blank" && !tab.label) {
          continue;
        }
        this._put(KIND.tab, `t:${n++}`, tab.label, url, tab.pinned ? 60 : 40, Logic.tabAgeDays(tab.lastAccessed, now), {
          tab,
          window: win,
          space: spaceName(tab),
          duplicate: (counts.get(Logic.duplicateKey(url)) ?? 0) > 1,
        });
      }
    }
  }

  /** Let go of tab references once the bar closes. */
  forgetTabs() {
    this._dropAll("t:");
    this.compactIfNeeded();
  }

  /**
   * Ids are never reused, so removed items keep their memory until the index is rebuilt. Do
   * that when they outnumber what's left (or there are many), e.g. after many tab refreshes.
   */
  compactIfNeeded() {
    const dead = this._added - this.entries.size;
    if (dead < Math.max(20000, this.entries.size / 2)) {
      return false;
    }
    const old = [...this.entries.values()];
    this.index.clear();
    this.entries.clear();
    this.byKey.clear();
    this._added = 0;
    for (const e of old) {
      this._put(e.kind, e.key, e.title, e.url, e.boost, e.age, e.data);
    }
    this.index.prepare();
    return true;
  }

  // ---- searching ---------------------------------------------------------------------------

  /** @returns {{entry: object, score: number}[]} */
  search(query, { kinds = Logic.ALL_KINDS, limit = Logic.MAX_ROWS } = {}) {
    if (!this.index) {
      return [];
    }
    if (this._placesLoaded && Date.now() - this._placesLoaded > FULL_RELOAD_MS) {
      this._placesLoaded = Date.now();
      this._scheduleReload();
    }
    const hits = this.index.query(query, { kinds, limit });
    return hits.map(h => ({ entry: this.entries.get(h.id), score: h.score })).filter(h => h.entry);
  }
}

export const HalcyonCommandIndex = new CommandIndex();
