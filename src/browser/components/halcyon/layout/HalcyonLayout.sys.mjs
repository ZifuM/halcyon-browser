/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Halcyon's window layout: Arc-style chrome built on Firefox's own vertical tabs.
//
// Wired in through browser-window categories (halcyon.manifest), so Firefox's files stay
// unpatched:
//   browser-before-ui-startup               init()               copy-link button, toolbar setup
//   browser-window-before-initial-xul-layout beforeLayout(win)   stylesheets, before first paint
//   browser-window-domcontentloaded          onDOMContentLoaded(win)  sections, compact mode
//
// Everything is behind halcyon.layout.enabled; with it off, windows are stock Firefox.
// Modules here import each other relatively and find their stylesheets next to themselves, so
// the same files work from the build (moz-src:///) and from the preview harness.

import { PREFS, STYLESHEETS } from "./HalcyonLayoutLogic.sys.mjs";
import { HalcyonSections } from "./HalcyonSections.sys.mjs";
import { HalcyonCompact } from "./HalcyonCompact.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

export const COPY_LINK_ID = "halcyon-copy-link-button";
const TOOLBAR_SETUP_PREF = "halcyon.layout.toolbarSetupDone";

export const STRINGS = Object.freeze({
  copyLink: "Copy Link",
  copyLinkTooltip: "Copy this page's link",
});

const windows = new WeakMap();

export const HalcyonLayout = {
  get enabled() {
    return Services.prefs.getBoolPref(PREFS.enabled, true);
  },

  /** URLs of our stylesheets (next to this module). */
  get stylesheets() {
    return STYLESHEETS.map(name => new URL(name, import.meta.url).href);
  },

  /** Whether a window gets the layout: normal browser windows, not popups. */
  appliesTo(win) {
    const chromehidden = win.document.documentElement.getAttribute("chromehidden") || "";
    return this.enabled && !/\btoolbar\b/.test(chromehidden);
  },

  // ---- browser-before-ui-startup -----------------------------------------------------------

  init() {
    if (!this.enabled) {
      return;
    }
    try {
      this._createCopyLinkWidget();
      this._setUpToolbarOnce();
    } catch (e) {
      console.error("Halcyon layout: toolbar setup failed", e);
    }
  },

  _createCopyLinkWidget() {
    const CUI = lazy.CustomizableUI;
    if (CUI.getWidget(COPY_LINK_ID)?.provider == CUI.PROVIDER_API) {
      return;
    }
    CUI.createWidget({
      id: COPY_LINK_ID,
      type: "button",
      label: STRINGS.copyLink,
      tooltiptext: STRINGS.copyLinkTooltip,
      defaultArea: CUI.AREA_NAVBAR,
      onCommand(event) {
        const win = event.target.ownerGlobal;
        HalcyonLayout.copyCurrentLink(win, event.target);
      },
    });
  },

  /** First run only: put copy-link right after the address, drop the account button. */
  _setUpToolbarOnce() {
    if (Services.prefs.getBoolPref(TOOLBAR_SETUP_PREF, false)) {
      return;
    }
    const CUI = lazy.CustomizableUI;
    const placements = CUI.getWidgetIdsInArea(CUI.AREA_NAVBAR);
    const urlbarAt = placements.indexOf("urlbar-container");
    if (urlbarAt >= 0) {
      CUI.addWidgetToArea(COPY_LINK_ID, CUI.AREA_NAVBAR, urlbarAt + 1);
    }
    // A sign-in prompt in the toolbar isn't ours to push; Sync stays in Settings and the menu.
    if (CUI.getPlacementOfWidget("fxa-toolbar-menu-button")) {
      CUI.removeWidgetFromArea("fxa-toolbar-menu-button");
    }
    Services.prefs.setBoolPref(TOOLBAR_SETUP_PREF, true);
  },

  copyCurrentLink(win, button) {
    const uri = win.gBrowser.currentURI;
    if (!uri || uri.spec == "about:blank") {
      return;
    }
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(uri.displaySpec);
    if (button) {
      button.setAttribute("halcyon-copied", "true");
      win.setTimeout(() => button.removeAttribute("halcyon-copied"), 1200);
    }
  },

  // ---- browser-window-before-initial-xul-layout -------------------------------------------

  beforeLayout(win) {
    if (!this.appliesTo(win)) {
      return;
    }
    const utils = win.windowUtils;
    for (const url of this.stylesheets) {
      utils.loadSheetUsingURIString(url, utils.AUTHOR_SHEET);
    }
    win.document.documentElement.setAttribute("halcyon-layout", "true");
  },

  // ---- browser-window-domcontentloaded ----------------------------------------------------

  onDOMContentLoaded(win) {
    if (!win.document.documentElement.hasAttribute("halcyon-layout") || windows.has(win)) {
      return;
    }
    const parts = { sections: new HalcyonSections(win), compact: new HalcyonCompact(win) };
    for (const part of Object.values(parts)) {
      try {
        part.init();
      } catch (e) {
        console.error("Halcyon layout: window setup failed", e);
      }
    }
    windows.set(win, parts);
    win.addEventListener(
      "unload",
      () => {
        for (const part of Object.values(parts)) {
          try {
            part.uninit();
          } catch (e) {
            // The window is going away anyway.
          }
        }
        windows.delete(win);
      },
      { once: true }
    );
  },

  /** The per-window controllers (tests and other components). */
  forWindow(win) {
    return windows.get(win);
  },
};
