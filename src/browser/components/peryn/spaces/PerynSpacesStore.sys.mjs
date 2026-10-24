/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The one copy of the Spaces data, shared by every window. Kept in the `peryn.spaces` pref so
// Firefox Sync's prefs engine carries it to the user's other machines (end-to-end encrypted,
// only when they've signed in and kept "Settings" syncing). Windows subscribe to changes,
// whether they come from another window, from Sync, or from about:config.

import * as Logic from "./PerynSpacesLogic.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContextualIdentityService: "resource://gre/modules/ContextualIdentityService.sys.mjs",
});

class Store {
  constructor() {
    this._data = null;
    this._raw = null;
    this._listeners = new Set();
    this._observing = false;
  }

  // ---- reading -----------------------------------------------------------------------------

  get data() {
    if (!this._data) {
      this._load();
    }
    return this._data;
  }

  get spaces() {
    return this.data.spaces;
  }

  get(id) {
    return Logic.findSpace(this.data, id);
  }

  _load() {
    this._raw = Services.prefs.getStringPref(Logic.PREFS.data, "");
    this._data = Logic.normalizeData(this._raw);
    if (!this._observing) {
      this._observing = true;
      Services.prefs.addObserver(Logic.PREFS.data, this);
    }
  }

  // ---- writing -----------------------------------------------------------------------------

  /** Replace the data (normalised) and tell every window. */
  set(data, change = {}) {
    const raw = Logic.serialize(data);
    this._data = Logic.normalizeData(raw);
    if (raw != this._raw) {
      this._raw = raw;
      Services.prefs.setStringPref(Logic.PREFS.data, raw);
    }
    this._notify(change);
    return this._data;
  }

  create(fields) {
    const { data, space } = Logic.createSpace(this.data, fields);
    this.set(data, { created: space.id });
    return this.get(space.id);
  }

  update(id, patch) {
    this.set(Logic.updateSpace(this.data, id, patch), { updated: id });
    return this.get(id);
  }

  delete(id) {
    const { data, fallback } = Logic.deleteSpace(this.data, id);
    this.set(data, { deleted: id, fallback });
    return fallback;
  }

  move(id, toIndex) {
    this.set(Logic.moveSpace(this.data, id, toIndex), { moved: id });
  }

  addPin(spaceId, entry) {
    const space = this.get(spaceId);
    if (space) {
      this.update(spaceId, { pins: Logic.addLauncher(space.pins, entry) });
    }
  }

  removePin(pinId) {
    for (const space of this.spaces) {
      if (space.pins.some(p => p.id == pinId)) {
        this.update(space.id, { pins: Logic.removeLauncher(space.pins, pinId) });
      }
    }
  }

  /** Move a launcher to another Space (a pinned tab moved between Spaces). */
  movePin(pinId, toSpaceId) {
    const from = this.spaces.find(s => s.pins.some(p => p.id == pinId));
    const entry = from?.pins.find(p => p.id == pinId);
    if (!entry || from.id == toSpaceId) {
      return;
    }
    let data = Logic.updateSpace(this.data, from.id, { pins: Logic.removeLauncher(from.pins, pinId) });
    const to = Logic.findSpace(data, toSpaceId);
    data = Logic.updateSpace(data, toSpaceId, { pins: Logic.addLauncher(to.pins, entry) });
    this.set(data, { updated: toSpaceId });
  }

  addEssential(entry) {
    this.set({ ...this.data, essentials: Logic.addLauncher(this.data.essentials, entry) }, { essentials: true });
  }

  removeEssential(pinId) {
    if (this.data.essentials.some(e => e.id == pinId)) {
      this.set({ ...this.data, essentials: Logic.removeLauncher(this.data.essentials, pinId) }, { essentials: true });
    }
  }

  // ---- change notification -----------------------------------------------------------------

  /** `listener(data, change)`; returns an unsubscribe function. */
  subscribe(listener) {
    this.data; // make sure we observe the pref
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  observe(_subject, topic, prefName) {
    if (topic != "nsPref:changed" || prefName != Logic.PREFS.data) {
      return;
    }
    const raw = Services.prefs.getStringPref(Logic.PREFS.data, "");
    if (raw == this._raw) {
      return; // our own write
    }
    this._raw = raw;
    this._data = Logic.normalizeData(raw);
    this._notify({ external: true });
  }

  _notify(change) {
    for (const listener of [...this._listeners]) {
      try {
        listener(this._data, change);
      } catch (e) {
        console.error("Peryn Spaces: listener failed", e);
      }
    }
  }

  // ---- containers --------------------------------------------------------------------------

  /** Local containers, for the editor. */
  containers() {
    const CIS = lazy.ContextualIdentityService;
    return CIS.getPublicIdentities().map(identity => ({
      userContextId: identity.userContextId,
      name: CIS.getUserContextLabel(identity.userContextId),
      icon: identity.icon,
      color: identity.color,
    }));
  }

  /**
   * The local container for a Space (matched by name, so it works on every synced machine),
   * created if it doesn't exist here yet. 0 when the Space has no container.
   */
  userContextIdFor(space) {
    if (!space?.container) {
      return 0;
    }
    const match = this.containers().find(c => c.name == space.container.name);
    if (match) {
      return match.userContextId;
    }
    try {
      const { name, icon, color } = space.container;
      return lazy.ContextualIdentityService.create(name, icon, color).userContextId;
    } catch (e) {
      console.error("Peryn Spaces: couldn't create container", e);
      return 0;
    }
  }

  /** For tests: forget the cached copy. */
  _reset() {
    this._data = null;
    this._raw = null;
    this._listeners.clear();
  }
}

export const PerynSpacesStore = new Store();
