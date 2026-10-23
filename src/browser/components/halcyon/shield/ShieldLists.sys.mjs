/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shield list manager: downloads, preprocesses and caches the filter lists, and hands them to
// Firefox's content classifier (the in-tree adblock-rust engine) on request.
//
//   * Lists live in <profile>/shield/<id>.txt (already preprocessed: one engine rule per line),
//     with download state in <profile>/shield/state.json.
//   * The classifier asks for list bytes through ContentClassifierRemoteSettingsClient's
//     getListBytes("shield-<id>") (see the patch to that file). Disabled or not-yet-downloaded
//     lists return empty bytes; the rest of the engine still builds.
//   * After lists change we call nsIContentClassifierService.onListsChanged(), which rebuilds
//     the Shield engine off the main thread.
//   * Requests carry no cookies or referrer; ETags avoid re-downloading unchanged lists.
//   * `halcyon.shield.updates.enabled = false` stops downloads; cached lists keep working.

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import {
  SHIELD_LISTS,
  assembleList,
  enabledLists,
  isStale,
  parseExpiresHours,
} from "moz-src:///browser/components/halcyon/shield/ShieldListLogic.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(lazy, "updatesEnabled", "halcyon.shield.updates.enabled", true);

const LIST_PREF_BRANCH = "halcyon.shield.list.";
const RECHECK_EVERY_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30000;
const MAX_LIST_BYTES = 16 * 1024 * 1024;

function listPrefName(id) {
  return `${LIST_PREF_BRANCH}${id}.enabled`;
}

export const ShieldLists = {
  _timer: null,
  _state: null,
  _updating: null,
  _prefObserver: null,

  get dir() {
    return PathUtils.join(PathUtils.profileDir, "shield");
  },

  /** Per-list on/off: the user's pref if set, else the catalog default. */
  isEnabled(id) {
    const pref = listPrefName(id);
    if (Services.prefs.getPrefType(pref) === Services.prefs.PREF_BOOL) {
      return Services.prefs.getBoolPref(pref);
    }
    return SHIELD_LISTS.find(l => l.id === id)?.defaultEnabled ?? false;
  },

  enabledIds() {
    return enabledLists(id => {
      const pref = listPrefName(id);
      return Services.prefs.getPrefType(pref) === Services.prefs.PREF_BOOL
        ? Services.prefs.getBoolPref(pref)
        : undefined;
    }).map(l => l.id);
  },

  init() {
    if (!this._prefObserver) {
      this._prefObserver = (_subject, _topic, data) => this._onListPrefChanged(data);
      Services.prefs.addObserver(LIST_PREF_BRANCH, this._prefObserver);
    }
    this.updateStale();
    if (!this._timer) {
      this._timer = lazy.setInterval(() => this.updateStale(), RECHECK_EVERY_MS);
    }
  },

  /** Called by the classifier (via the RS client) while building the Shield engine. */
  async getListBytes(id) {
    if (!SHIELD_LISTS.some(l => l.id === id) || !this.isEnabled(id)) {
      return new Uint8Array(0);
    }
    try {
      return await IOUtils.read(PathUtils.join(this.dir, `${id}.txt`));
    } catch (e) {
      if (DOMException.isInstance(e) && e.name === "NotFoundError") {
        return new Uint8Array(0); // not downloaded yet; updateStale() will notify when it is
      }
      throw e;
    }
  },

  async _loadState() {
    if (!this._state) {
      try {
        this._state = await IOUtils.readJSON(PathUtils.join(this.dir, "state.json"));
      } catch {
        this._state = { lists: {} };
      }
      this._state.lists ??= {};
    }
    return this._state;
  },

  async _saveState() {
    await IOUtils.writeJSON(PathUtils.join(this.dir, "state.json"), this._state, {
      tmpPath: PathUtils.join(this.dir, "state.json.tmp"),
    });
  },

  /** Download every enabled list that is stale (or all, with force). Serialized. */
  updateStale({ force = false } = {}) {
    if (!this._updating) {
      this._updating = this._updateStale(force).finally(() => {
        this._updating = null;
      });
    }
    return this._updating;
  },

  async _updateStale(force) {
    if (!lazy.updatesEnabled || Services.io.offline) {
      return [];
    }
    await IOUtils.makeDirectory(this.dir, { ignoreExisting: true });
    const state = await this._loadState();
    const nowSec = Math.floor(Date.now() / 1000);
    const changed = [];
    for (const id of this.enabledIds()) {
      if (!force && !isStale(state.lists[id], nowSec)) {
        continue;
      }
      try {
        if (await this._updateList(id, state, nowSec)) {
          changed.push(id);
        }
      } catch (e) {
        console.warn(`Shield: couldn't update list ${id}:`, e);
      }
    }
    await this._saveState();
    if (changed.length) {
      this.notifyClassifier(changed);
    }
    return changed;
  },

  /** @returns {Promise<boolean>} true if the cached list changed */
  async _updateList(id, state, nowSec) {
    const list = SHIELD_LISTS.find(l => l.id === id);
    const meta = state.lists[id] ?? {};
    let lastError = null;
    for (const url of list.urls) {
      let response;
      try {
        response = await this._fetch(url, meta.url === url ? meta.etag : null);
      } catch (e) {
        lastError = e;
        continue;
      }
      if (response.status === 304) {
        state.lists[id] = { ...meta, fetchedAtSec: nowSec };
        return false;
      }
      if (!response.ok) {
        lastError = new Error(`${url}: HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      if (text.length > MAX_LIST_BYTES) {
        lastError = new Error(`${url}: list too large`);
        continue;
      }
      const rules = await assembleList({
        url,
        text,
        format: list.format,
        fetchText: async includeUrl => {
          const r = await this._fetch(includeUrl, null);
          if (!r.ok) {
            throw new Error(`${includeUrl}: HTTP ${r.status}`);
          }
          return r.text();
        },
        onIncludeError: (includeUrl, e) => console.warn(`Shield: skipped include ${includeUrl}:`, e),
      });
      const file = PathUtils.join(this.dir, `${id}.txt`);
      await IOUtils.writeUTF8(file, rules.join("\n") + "\n", { tmpPath: `${file}.tmp` });
      state.lists[id] = {
        url,
        etag: response.headers.get("ETag"),
        fetchedAtSec: nowSec,
        expiresHours: parseExpiresHours(text),
        rules: rules.length,
      };
      return true;
    }
    throw lastError ?? new Error("no URLs");
  },

  async _fetch(url, etag) {
    const headers = {};
    if (etag) {
      headers["If-None-Match"] = etag;
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = lazy.setTimeout(() => reject(new Error(`${url}: timed out`)), FETCH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers }),
        timeout,
      ]);
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  /** Ask the classifier to rebuild the Shield engine with the current lists. */
  notifyClassifier(ids) {
    try {
      const service = Cc["@mozilla.org/content-classifier-service;1"].getService(
        Ci.nsIContentClassifierService
      );
      service.onListsChanged(
        ids.map(id => `shield-${id}`),
        []
      );
    } catch (e) {
      console.warn("Shield: classifier service unavailable:", e);
    }
  },

  async _onListPrefChanged(prefName) {
    const m = /^halcyon\.shield\.list\.([a-z0-9-]+)\.enabled$/.exec(prefName ?? "");
    if (!m || !SHIELD_LISTS.some(l => l.id === m[1])) {
      return;
    }
    const id = m[1];
    if (this.isEnabled(id)) {
      const state = await this._loadState();
      if (!state.lists[id]?.fetchedAtSec) {
        await this.updateStale(); // downloads it, then notifies
        return;
      }
    }
    this.notifyClassifier([id]); // enabled from cache, or disabled (now returns empty bytes)
  },
};
