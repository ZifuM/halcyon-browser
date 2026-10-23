/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Registers Shield's element-hiding actor. Registered from our own manifest at
// browser-before-ui-startup rather than in Firefox's actor tables, so Firefox's files stay
// unpatched. The actor only exists while halcyon.shield.cosmetic.enabled is true.

export const ACTOR_NAME = "HalcyonShieldCosmetic";

export const ACTOR_OPTIONS = {
  parent: {
    esModuleURI: "moz-src:///browser/components/halcyon/shield/ShieldCosmeticParent.sys.mjs",
  },
  child: {
    esModuleURI: "moz-src:///browser/components/halcyon/shield/ShieldCosmeticChild.sys.mjs",
    events: {
      DOMDocElementInserted: { capture: true },
      DOMContentLoaded: {},
    },
  },
  matches: ["http://*/*", "https://*/*"],
  allFrames: true,
  messageManagerGroups: ["browsers"],
  enablePreference: "halcyon.shield.cosmetic.enabled",
};

export const ShieldCosmetic = {
  _registered: false,

  init() {
    if (this._registered) {
      return;
    }
    ChromeUtils.registerWindowActor(ACTOR_NAME, ACTOR_OPTIONS);
    this._registered = true;
  },
};
