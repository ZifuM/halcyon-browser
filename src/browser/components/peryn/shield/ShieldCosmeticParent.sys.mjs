/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Parent side of Shield's element hiding: answers the child's lookups from the content
// classifier service (the same engines that block network requests). See ShieldCosmeticLogic.

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContentBlockingAllowList: "resource://gre/modules/ContentBlockingAllowList.sys.mjs",
  ShieldCosmeticLogic: "moz-src:///browser/components/peryn/shield/ShieldCosmeticLogic.sys.mjs",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "classifier",
  "@mozilla.org/content-classifier-service;1",
  Ci.nsIContentClassifierService
);

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "cosmeticEnabled",
  "peryn.shield.cosmetic.enabled",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "shieldEnabled",
  "privacy.trackingprotection.content.protection.enabled",
  false
);

let siteCache = null;
function cache() {
  siteCache ??= new lazy.ShieldCosmeticLogic.ExpiringCache();
  return siteCache;
}

export class ShieldCosmeticParent extends JSWindowActorParent {
  /** Whether element hiding applies to this frame's tab right now. */
  _active() {
    if (!lazy.cosmeticEnabled || !lazy.shieldEnabled) {
      return false;
    }
    // The shield in the address bar ("turn off blocking for this site") covers element hiding
    // too, for every frame in the tab.
    const browser = this.browsingContext.top.embedderElement;
    if (!browser) {
      return false;
    }
    try {
      return !lazy.ContentBlockingAllowList.includes(browser);
    } catch (e) {
      return true;
    }
  }

  get _private() {
    return !!this.browsingContext.usePrivateBrowsing;
  }

  /**
   * Site resources for a page: { css, exceptions, generichide } or null when element hiding
   * doesn't apply.
   */
  siteResources(url) {
    const key = lazy.ShieldCosmeticLogic.cacheKeyForURL(url);
    if (!key || !this._active()) {
      return null;
    }
    const cacheKey = `${this._private ? "p" : "n"}|${key}`;
    const cached = cache().get(cacheKey);
    if (cached) {
      return cached;
    }
    const hide = {};
    const procedural = {};
    const exceptions = {};
    const script = {};
    const generichide = {};
    try {
      lazy.classifier.getCosmeticResources(
        url,
        this._private,
        hide,
        procedural,
        exceptions,
        script,
        generichide
      );
    } catch (e) {
      // Not initialised yet (first seconds after startup) or Shield turned off.
      return null;
    }
    // Procedural filters (:has-text and friends) and scriptlets need an in-page runtime that
    // Shield doesn't ship yet; only plain CSS selectors are applied.
    const result = {
      css: lazy.ShieldCosmeticLogic.buildHideStylesheet(hide.value ?? []),
      exceptions: exceptions.value ?? [],
      generichide: !!generichide.value,
    };
    cache().set(cacheKey, result);
    return result;
  }

  /** Stylesheet for generic rules matching the given classes and ids, or "". */
  genericStylesheet({ classes, ids, exceptions }) {
    if (!this._active()) {
      return "";
    }
    const asStrings = v => (Array.isArray(v) ? v.filter(s => typeof s == "string") : []);
    let selectors;
    try {
      selectors = lazy.classifier.getHiddenClassIdSelectors(
        this._private,
        asStrings(classes),
        asStrings(ids),
        asStrings(exceptions)
      );
    } catch (e) {
      return "";
    }
    return lazy.ShieldCosmeticLogic.buildHideStylesheet(selectors);
  }

  receiveMessage(message) {
    switch (message.name) {
      case "ShieldCosmetic:Site":
        return this.siteResources(message.data?.url);
      case "ShieldCosmetic:Generic":
        return this.genericStylesheet(message.data ?? {});
    }
    return undefined;
  }
}

/** For tests and list updates: forget cached site resources. */
export function clearShieldCosmeticCache() {
  siteCache?.clear();
}
