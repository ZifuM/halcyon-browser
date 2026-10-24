/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Spaces with identity (C7): a Space can have its own search engine and protection level, so
 * Work and Personal can behave differently. Firefox has one default search engine and one
 * protection level for the whole browser, so Peryn switches them to the Space you're in: when
 * you change Space, or come back to a window showing another Space. A Space without its own
 * choice uses your default, which is remembered separately (peryn.identity.* prefs).
 *
 * Changing the engine or level by hand (in Firefox's settings, or the privacy page) changes the
 * Space you're in if it has its own, or your default if it doesn't.
 */

import { PerynSpacesStore as Store } from "./PerynSpacesStore.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  // Firefox 158 has no Services.search; the search service is a module.
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

export const PREFS = Object.freeze({
  defaultSearch: "peryn.identity.defaultSearch",
  defaultProtection: "peryn.identity.defaultProtection",
});
const CATEGORY = "browser.contentblocking.category";

/** What a Space wants: its own choice, else the default. Pure, for tests. */
export function wanted(space, defaults) {
  return {
    search: space?.search || defaults.search || "",
    protection: space?.protection || defaults.protection || "",
  };
}

/** Who a hand-made change belongs to: the Space if it has its own value, else the default. */
export function ownerOfChange(space, key) {
  return space && space[key] ? "space" : "default";
}

class Identity {
  constructor() {
    this.activeSpaceId = null;
    this._applying = 0;
    this._started = false;
  }

  get defaults() {
    return {
      search: Services.prefs.getStringPref(PREFS.defaultSearch, ""),
      protection: Services.prefs.getStringPref(PREFS.defaultProtection, ""),
    };
  }

  init() {
    if (this._started) {
      return;
    }
    this._started = true;
    Services.obs.addObserver(this, "browser-search-engine-modified");
    Services.prefs.addObserver(CATEGORY, this);
    // Remember the current choices as the defaults the first time.
    if (!Services.prefs.getStringPref(PREFS.defaultProtection, "")) {
      const category = Services.prefs.getStringPref(CATEGORY, "");
      if (category == "strict" || category == "standard") {
        Services.prefs.setStringPref(PREFS.defaultProtection, category);
      }
    }
    this._captureDefaultEngine();
  }

  async _captureDefaultEngine() {
    if (Services.prefs.getStringPref(PREFS.defaultSearch, "")) {
      return;
    }
    try {
      await lazy.SearchService.init();
      const engine = await lazy.SearchService.getDefault();
      if (engine?.id) {
        Services.prefs.setStringPref(PREFS.defaultSearch, engine.id);
      }
    } catch {}
  }

  /** Make Firefox's engine and level those of `space` (the Space a window is showing). */
  async apply(space) {
    this.activeSpaceId = space?.id ?? null;
    try {
      this.init();
    } catch (e) {
      return; // no search or prefs services (tests, early shutdown)
    }
    const want = wanted(space, this.defaults);
    this._applying++;
    try {
      if (want.protection && Services.prefs.getStringPref(CATEGORY, "") != want.protection) {
        Services.prefs.setStringPref(CATEGORY, want.protection);
      }
      if (want.search) {
        await lazy.SearchService.init();
        const current = await lazy.SearchService.getDefault();
        if (current?.id != want.search) {
          const engine = lazy.SearchService.getEngineById(want.search);
          if (engine) {
            await lazy.SearchService.setDefault(engine, lazy.SearchService.CHANGE_REASON.USER);
          }
        }
      }
    } catch (e) {
      console.error("Peryn Spaces: applying the Space's search engine or protection failed", e);
    } finally {
      this._applying--;
    }
  }

  /** The visible search engines, for the Space editor. */
  async engines() {
    try {
      await lazy.SearchService.init();
      return (await lazy.SearchService.getVisibleEngines()).map(e => ({ id: e.id, name: e.name }));
    } catch {
      return [];
    }
  }

  observe(subject, topic, data) {
    if (this._applying) {
      return;
    }
    const space = this.activeSpaceId ? Store.get(this.activeSpaceId) : null;
    if (topic == "browser-search-engine-modified" && data == "engine-default") {
      const id = subject?.id ?? subject?.wrappedJSObject?.id;
      if (!id) {
        return;
      }
      if (ownerOfChange(space, "search") == "space") {
        Store.update(space.id, { search: id });
      } else {
        Services.prefs.setStringPref(PREFS.defaultSearch, id);
      }
    } else if (topic == "nsPref:changed" && data == CATEGORY) {
      const level = Services.prefs.getStringPref(CATEGORY, "");
      if (level != "strict" && level != "standard") {
        return; // Custom: leave the Space's and default choices alone
      }
      if (ownerOfChange(space, "protection") == "space") {
        Store.update(space.id, { protection: level });
      } else {
        Services.prefs.setStringPref(PREFS.defaultProtection, level);
      }
    }
  }
}

export const PerynSpaceIdentity = new Identity();
