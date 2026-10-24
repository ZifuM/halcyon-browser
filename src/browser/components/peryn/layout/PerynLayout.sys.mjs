/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Peryn's window layout: Arc-style chrome built on Firefox's own vertical tabs.
//
// Wired in through browser-window categories (peryn.manifest), so Firefox's files stay
// unpatched:
//   browser-before-ui-startup                init()                    copy-link button
//   browser-window-before-initial-xul-layout beforeLayout(win)         stylesheets, before paint
//   browser-window-domcontentloaded          onDOMContentLoaded(win)   top bar (first run),
//                                                                       sections, compact mode,
//                                                                       Spaces (../spaces/)
//
// Everything is behind peryn.layout.enabled; with it off, windows are stock Firefox.
// Modules here import each other relatively and find their stylesheets next to themselves, so
// the same files work from the build (moz-src:///) and from the preview harness.

import { PREFS, STYLESHEETS } from "./PerynLayoutLogic.sys.mjs";
import { PerynSections } from "./PerynSections.sys.mjs";
import { PerynCompact } from "./PerynCompact.sys.mjs";
import { PerynSpaces } from "../spaces/PerynSpaces.sys.mjs";
import { PerynCommandBar } from "../commandbar/PerynCommandBar.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export const COPY_LINK_ID = "peryn-copy-link-button";
const TOOLBAR_SETUP_PREF = "peryn.layout.toolbarSetupDone";

/** The top bar on first run, left to right (the address is centred by CSS). */
export const TOP_BAR = Object.freeze([
  "sidebar-button",
  "back-button",
  "forward-button",
  "stop-reload-button",
  "vertical-spacer",
  "urlbar-container",
  COPY_LINK_ID,
  "downloads-button",
  "unified-extensions-button",
]);

/** Removed from the top bar on first run: a sign-in prompt, AI buttons (AI is off by default)
 * and the tab list (the command bar replaces it in C5). All can be added back. */
export const TOP_BAR_REMOVE = Object.freeze([
  "fxa-toolbar-menu-button",
  "smartwindow-group-tabs-button",
  "ai-window-toggle",
  "alltabs-button",
  "home-button",
]);

export const STRINGS = Object.freeze({
  copyLink: "Copy Link",
  copyLinkTooltip: "Copy this page's link",
});

const windows = new WeakMap();

export const PerynLayout = {
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
    } catch (e) {
      console.error("Peryn layout: copy-link button failed", e);
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
      // No defaultArea: CustomizableUI is still settling the toolbars this early (vertical
      // tabs move widgets around), so the button is placed once the first window is up.
      onCommand(event) {
        const win = event.target.ownerGlobal;
        PerynLayout.copyCurrentLink(win, event.target);
      },
    });
  },

  /**
   * First run only: lay out the top bar the Arc way. Firefox has no sensible default for a
   * profile that starts with vertical tabs (it restores the nav-bar from its vertical-tabs
   * extras only, dropping reload and the sidebar button), so the whole order is set here once;
   * after that the toolbar is the user's to customise.
   */
  _setUpToolbarOnce() {
    if (Services.prefs.getBoolPref(TOOLBAR_SETUP_PREF, false)) {
      return;
    }
    const CUI = lazy.CustomizableUI;
    CUI.beginBatchUpdate();
    try {
      TOP_BAR.forEach((id, index) => {
        try {
          CUI.addWidgetToArea(id, CUI.AREA_NAVBAR, index);
        } catch (e) {
          // Not available in this build (or not movable): skip it.
        }
      });
      for (const id of TOP_BAR_REMOVE) {
        if (CUI.getPlacementOfWidget(id)?.area == CUI.AREA_NAVBAR) {
          CUI.removeWidgetFromArea(id);
        }
      }
    } finally {
      CUI.endBatchUpdate();
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
      button.setAttribute("peryn-copied", "true");
      win.setTimeout(() => button.removeAttribute("peryn-copied"), 1200);
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
    win.document.documentElement.setAttribute("peryn-layout", "true");
  },

  // ---- browser-window-domcontentloaded ----------------------------------------------------

  onDOMContentLoaded(win) {
    if (!win.document.documentElement.hasAttribute("peryn-layout") || windows.has(win)) {
      return;
    }
    try {
      this._setUpToolbarOnce();
    } catch (e) {
      console.error("Peryn layout: toolbar setup failed", e);
    }
    const sections = new PerynSections(win);
    const parts = { sections, compact: new PerynCompact(win) };
    // Spaces (C4) need the sections; private windows don't get Spaces.
    if (!lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      parts.spaces = new PerynSpaces(win, { sections });
    }
    // After Spaces, so the command bar can open new tabs in the Space's container.
    parts.commandBar = new PerynCommandBar(win, parts);
    for (const part of Object.values(parts)) {
      try {
        part.init();
      } catch (e) {
        console.error("Peryn layout: window setup failed", e);
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
