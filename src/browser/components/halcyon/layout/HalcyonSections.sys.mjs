/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The sidebar's sections, per window:
//
//   Essentials  Firefox's pinned tabs (their own grid at the top; "Add to Essentials").
//   Pinned      tabs pinned to the sidebar: the first standalone tabs, kept there.
//   + New Tab
//   Today       everything else.
//
// A Pinned tab carries the `halcyon-pinned` attribute and a session-store value, so it stays
// pinned across restarts. This module keeps Pinned tabs together at the top of the tab list,
// pins or unpins a tab dragged across the divider, and adds the context-menu items.
// Strings are English until the browser ships its own localisation files.

import {
  PREFS,
  PINNED_ATTR,
  PINNED_TAB_VALUE,
  canPinToSidebar,
  pinnedAfterMove,
  placementForNewTab,
} from "./HalcyonLayoutLogic.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const MENU_ID = "halcyon-context-pin-to-sidebar";
const ESSENTIALS_MENU_ID = "halcyon-context-essentials";

export const STRINGS = Object.freeze({
  pin: "Pin to Sidebar",
  unpin: "Unpin from Sidebar",
  addEssential: "Add to Essentials",
  removeEssential: "Remove from Essentials",
});

export class HalcyonSections {
  constructor(win) {
    this.win = win;
    this.gBrowser = win.gBrowser;
    this.tabContainer = this.gBrowser.tabContainer;
    this.restored = new WeakSet();
    this.handleEvent = this.handleEvent.bind(this);
  }

  init() {
    for (const type of [
      "TabOpen",
      "TabMove",
      "TabPinned",
      "TabUnpinned",
      "TabGrouped",
      "TabClose",
      "SSTabRestoring",
    ]) {
      this.tabContainer.addEventListener(type, this.handleEvent);
    }
    // Tabs that already exist (a tab torn off into this window, or restored before we ran).
    for (const tab of this.gBrowser.tabs) {
      this._readSavedState(tab);
    }
    this._addContextMenu();
    this._updateContainer();
  }

  uninit() {
    for (const type of [
      "TabOpen",
      "TabMove",
      "TabPinned",
      "TabUnpinned",
      "TabGrouped",
      "TabClose",
      "SSTabRestoring",
    ]) {
      this.tabContainer.removeEventListener(type, this.handleEvent);
    }
    this.menu?.removeEventListener("popupshowing", this.handleEvent);
  }

  // ---- state -------------------------------------------------------------------------------

  isPinned(tab) {
    return !!tab?.hasAttribute(PINNED_ATTR);
  }

  /** The tabs after the Essentials, in order. */
  _standaloneOrder() {
    return this.gBrowser.tabs.filter(t => !t.pinned);
  }

  /** Section of the tab before / after `tab` among non-Essential tabs (null at the ends). */
  _neighbours(tab) {
    const order = this._standaloneOrder();
    const i = order.indexOf(tab);
    const section = t => (t ? this.isPinned(t) && !t.group && !t.splitview : null);
    return {
      prevPinned: i > 0 ? section(order[i - 1]) : null,
      nextPinned: i >= 0 && i < order.length - 1 ? section(order[i + 1]) : null,
    };
  }

  /** The last tab of the Pinned block, not counting `moving` (the tab about to be moved). */
  _lastPinned(moving = null) {
    let last = null;
    for (const tab of this._standaloneOrder()) {
      if (tab == moving) {
        continue;
      }
      if (!this.isPinned(tab)) {
        break;
      }
      last = tab;
    }
    return last;
  }

  _readSavedState(tab) {
    let saved = "";
    try {
      saved = lazy.SessionStore.getCustomTabValue(tab, PINNED_TAB_VALUE);
    } catch (e) {
      // Tab not tracked by session store (yet).
    }
    this._setAttr(tab, saved == "1" && canPinToSidebar(tab));
  }

  _setAttr(tab, pinned) {
    tab.toggleAttribute(PINNED_ATTR, pinned);
  }

  _save(tab, pinned) {
    try {
      if (pinned) {
        lazy.SessionStore.setCustomTabValue(tab, PINNED_TAB_VALUE, "1");
      } else {
        lazy.SessionStore.deleteCustomTabValue(tab, PINNED_TAB_VALUE);
      }
    } catch (e) {
      // Private windows and closing tabs have nothing to save to.
    }
  }

  _updateContainer() {
    this.tabContainer.toggleAttribute(
      "halcyon-has-pinned",
      this._standaloneOrder().some(t => this.isPinned(t))
    );
  }

  /** Move `tab` to the top of Today (right after the last Pinned tab). */
  _moveToTopOfToday(tab) {
    const last = this._lastPinned(tab);
    if (last) {
      this.gBrowser.moveTabAfter(tab, last);
    } else {
      this.gBrowser.moveTabTo(tab, { tabIndex: this.gBrowser.pinnedTabCount });
    }
  }

  /** Move `tab` to the end of the Pinned block. */
  _moveToEndOfPinned(tab) {
    const last = this._lastPinned(tab);
    if (last) {
      this.gBrowser.moveTabAfter(tab, last);
    } else {
      this.gBrowser.moveTabTo(tab, { tabIndex: this.gBrowser.pinnedTabCount });
    }
  }

  // ---- actions -----------------------------------------------------------------------------

  /** Pin `tab` to the sidebar (or unpin it): updates the attribute, saves it, moves the tab. */
  setPinned(tab, pinned) {
    if (pinned && !canPinToSidebar(tab)) {
      return;
    }
    if (this.isPinned(tab) == pinned) {
      return;
    }
    if (pinned) {
      // To the end of Pinned, i.e. just before the first Today tab.
      this._setAttr(tab, true);
      this._moveToEndOfPinned(tab);
    } else {
      this._setAttr(tab, false);
      this._moveToTopOfToday(tab);
    }
    this._save(tab, pinned);
    this._updateContainer();
  }

  togglePinned(tab) {
    this.setPinned(tab, !this.isPinned(tab));
  }

  // ---- events ------------------------------------------------------------------------------

  handleEvent(event) {
    const tab = event.target;
    switch (event.type) {
      case "SSTabRestoring":
        this.restored.add(tab);
        this._readSavedState(tab);
        this._scheduleNormalize();
        break;
      case "TabOpen":
        // Session restore announces its tabs without `fromExternal` (Tabbrowser's
        // createTabsForSessionRestore); their saved order is already right.
        if (!("fromExternal" in (event.detail ?? {}))) {
          this.restored.add(tab);
          break;
        }
        this._placeNewTab(tab);
        break;
      case "TabMove":
        this._onMove(tab);
        break;
      case "TabPinned":
        // Became an Essential.
        if (this.isPinned(tab)) {
          this._setAttr(tab, false);
          this._save(tab, false);
        }
        this._updateContainer();
        break;
      case "TabUnpinned": {
        // Firefox puts an ex-Essential first after the Essentials, i.e. inside Pinned.
        const { nextPinned } = this._neighbours(tab);
        if (nextPinned) {
          this._moveToTopOfToday(tab);
        }
        break;
      }
      case "TabGrouped":
        if (this.isPinned(tab)) {
          this._setAttr(tab, false);
          this._save(tab, false);
          this._updateContainer();
        }
        break;
      case "TabClose":
        this.win.setTimeout(() => this._updateContainer(), 0);
        break;
      case "popupshowing":
        if (event.target == this.menu) {
          this._onContextMenu();
        }
        break;
    }
  }

  _placeNewTab(tab) {
    if (tab.closing || !tab.parentNode || tab.pinned || this.isPinned(tab)) {
      return;
    }
    const where = placementForNewTab({
      restoring: this.restored.has(tab),
      grouped: !!(tab.group || tab.splitview),
      position: Services.prefs.getStringPref(PREFS.newTabPosition, "top"),
      ...this._neighbours(tab),
    });
    if (where == "after-pinned") {
      this._moveToTopOfToday(tab);
    }
  }

  /**
   * After a session restore marks tabs (one at a time, not necessarily in order), make sure
   * every Pinned tab sits in the Pinned block, keeping their relative order. Coalesced to one
   * pass per burst of restores.
   */
  _scheduleNormalize() {
    if (this._normalizeQueued) {
      return;
    }
    this._normalizeQueued = true;
    this.win.setTimeout(() => {
      this._normalizeQueued = false;
      this.normalize();
    }, 0);
  }

  normalize() {
    let last = null; // last tab of the Pinned block so far
    let seenToday = false;
    for (const tab of this._standaloneOrder()) {
      if (tab.closing || tab.group || tab.splitview || !this.isPinned(tab)) {
        seenToday = true;
        continue;
      }
      if (seenToday) {
        if (last) {
          this.gBrowser.moveTabAfter(tab, last);
        } else {
          this.gBrowser.moveTabTo(tab, { tabIndex: this.gBrowser.pinnedTabCount });
        }
      }
      last = tab;
    }
    this._updateContainer();
  }

  _onMove(tab) {
    if (tab.pinned || tab.group || tab.splitview || tab.closing) {
      return;
    }
    const wasPinned = this.isPinned(tab);
    const pinned = pinnedAfterMove({ wasPinned, ...this._neighbours(tab) });
    if (pinned != wasPinned) {
      this._setAttr(tab, pinned);
      this._save(tab, pinned);
      this._updateContainer();
    }
  }

  // ---- context menu ------------------------------------------------------------------------

  _addContextMenu() {
    const doc = this.win.document;
    this.menu = doc.getElementById("tabContextMenu");
    if (!this.menu || doc.getElementById(MENU_ID)) {
      return;
    }
    const make = (id, onCommand) => {
      const item = doc.createXULElement("menuitem");
      item.id = id;
      item.addEventListener("command", () => {
        const tab = this.win.TabContextMenu?.contextTab;
        if (tab) {
          onCommand(tab);
        }
      });
      return item;
    };
    const pinItem = make(MENU_ID, tab => this.togglePinned(tab));
    // Firefox's pinned tabs are the Essentials here. Its own Pin/Unpin items are hidden by
    // halcyon-layout.css and replaced by this one, worded for Essentials.
    const essentialsItem = make(ESSENTIALS_MENU_ID, tab => this.toggleEssential(tab));
    const anchor = doc.getElementById("context_pinTab");
    if (anchor) {
      anchor.before(pinItem, essentialsItem);
    } else {
      this.menu.prepend(pinItem, essentialsItem);
    }
    this.menu.addEventListener("popupshowing", this.handleEvent);
  }

  /** Add the tab (or the selected tabs) to Essentials, or take it out. */
  toggleEssential(tab) {
    const gBrowser = this.gBrowser;
    if (tab.multiselected) {
      if (tab.pinned) {
        gBrowser.unpinMultiSelectedTabs();
      } else {
        gBrowser.pinMultiSelectedTabs();
      }
    } else if (tab.pinned) {
      gBrowser.unpinTab(tab);
    } else {
      gBrowser.pinTab(tab);
    }
  }

  _onContextMenu() {
    const doc = this.win.document;
    const item = doc.getElementById(MENU_ID);
    const essentials = doc.getElementById(ESSENTIALS_MENU_ID);
    const tab = this.win.TabContextMenu?.contextTab;
    if (!item || !essentials || !tab) {
      return;
    }
    const pinned = this.isPinned(tab);
    item.hidden = tab.multiselected || (!pinned && !canPinToSidebar(tab));
    item.setAttribute("label", pinned ? STRINGS.unpin : STRINGS.pin);
    essentials.setAttribute("label", tab.pinned ? STRINGS.removeEssential : STRINGS.addEssential);
  }
}
