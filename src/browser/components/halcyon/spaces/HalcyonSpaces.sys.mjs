/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Spaces in one window. Every tab except the Essentials belongs to a Space; the window shows one
// Space at a time and hides the other Spaces' tabs with Firefox's own tab hiding (the same
// mechanism extensions use), so hidden tabs keep running, stay in session restore and come back
// instantly. Each Space brings its colour, its Pinned tabs and, optionally, its container.
//
// Private windows don't have Spaces.
//
// Launchers: each Pinned tab and Essential carries a launcher id. The launcher lists live in the
// Spaces data, which Firefox Sync carries between machines; the most recently used window opens
// any launcher that has no tab on this machine yet (unloaded until clicked), and a launcher
// removed elsewhere stops its tab being pinned here (the tab stays open).

import * as Logic from "./HalcyonSpacesLogic.sys.mjs";
import { HalcyonSpacesStore as Store } from "./HalcyonSpacesStore.sys.mjs";
import { HalcyonSpacesUI } from "./HalcyonSpacesUI.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

export const SPACE_ATTR = "halcyon-space";
export const TAB_VALUE = "halcyon-space";
export const PIN_ID_VALUE = "halcyon-pin-id";
export const WINDOW_VALUE = "halcyon-active-space";
const HIDE_SOURCE = "halcyon-spaces";
const SWITCH_ANIMATION_MS = 260;

const TAB_EVENTS = [
  "TabOpen",
  "TabSelect",
  "TabClose",
  "TabPinned",
  "TabUnpinned",
  "SSTabRestoring",
  "HalcyonPinnedChange",
  "TabAttrModified",
];

export class HalcyonSpaces {
  constructor(win, { sections, createUI } = {}) {
    this.win = win;
    this._createUI = createUI ?? (controller => new HalcyonSpacesUI(controller));
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    this.sections = sections;
    this.active = null;
    this.swipe = new Logic.SwipeTracker();
    this._quiet = 0; // >0 while we change tabs ourselves (no launcher writes)
    this.handleEvent = this.handleEvent.bind(this);
    this._onData = this._onData.bind(this);
  }

  // ---- lifecycle -----------------------------------------------------------------------------

  init() {
    this.active = this._restoreActive();
    for (const tab of this.gBrowser.tabs) {
      this._readTab(tab);
    }
    for (const type of TAB_EVENTS) {
      this.gBrowser.tabContainer.addEventListener(type, this.handleEvent);
    }
    this.doc.getElementById("vertical-tabs")?.addEventListener("wheel", this.handleEvent, { passive: true });
    this.win.addEventListener("SSWindowRestored", this.handleEvent);
    this._unsubscribe = Store.subscribe(this._onData);
    this._wrapNewTabCommand();
    this._createShortcuts();
    this.ui = this._createUI(this);
    this.ui.init();
    this.apply();
    // Launchers from other machines, once the window has settled.
    this.win.setTimeout(() => this.reconcileLaunchers(), 2000);
  }

  uninit() {
    for (const type of TAB_EVENTS) {
      this.gBrowser.tabContainer.removeEventListener(type, this.handleEvent);
    }
    this.doc.getElementById("vertical-tabs")?.removeEventListener("wheel", this.handleEvent);
    this.win.removeEventListener("SSWindowRestored", this.handleEvent);
    this._unsubscribe?.();
    this._unwrapNewTabCommand();
    this.ui?.uninit();
  }

  // ---- membership --------------------------------------------------------------------------

  spaceOf(tab) {
    return tab.pinned ? null : tab.getAttribute(SPACE_ATTR) || this.active;
  }

  get activeSpace() {
    return Store.get(this.active) ?? Store.spaces[0];
  }

  tabsIn(spaceId) {
    return this.gBrowser.tabs.filter(t => !t.pinned && !t.closing && this.spaceOf(t) == spaceId);
  }

  _setSpace(tab, spaceId) {
    if (tab.pinned) {
      tab.removeAttribute(SPACE_ATTR);
      return;
    }
    tab.setAttribute(SPACE_ATTR, spaceId);
    try {
      lazy.SessionStore.setCustomTabValue(tab, TAB_VALUE, spaceId);
    } catch (e) {
      // Not tracked (yet).
    }
  }

  _readTab(tab) {
    if (tab.pinned) {
      tab.removeAttribute(SPACE_ATTR);
      return;
    }
    let saved = "";
    try {
      saved = lazy.SessionStore.getCustomTabValue(tab, TAB_VALUE);
    } catch (e) {
      // Not tracked (yet).
    }
    const id = saved || tab.getAttribute(SPACE_ATTR);
    this._setSpace(tab, Store.get(id) ? id : this.active);
  }

  _restoreActive() {
    let saved = "";
    try {
      saved = lazy.SessionStore.getCustomWindowValue(this.win, WINDOW_VALUE);
    } catch (e) {
      // First window, nothing saved.
    }
    return Store.get(saved) ? saved : Store.spaces[0].id;
  }

  _saveActive() {
    try {
      lazy.SessionStore.setCustomWindowValue(this.win, WINDOW_VALUE, this.active);
    } catch (e) {
      // Window not tracked yet.
    }
  }

  /** Move tabs to another Space (tab menu "Move to Space"). */
  moveTabs(tabs, spaceId) {
    if (!Store.get(spaceId)) {
      return;
    }
    const leaving = tabs.filter(t => !t.pinned && this.spaceOf(t) != spaceId);
    if (!leaving.length) {
      return;
    }
    // Moving the selected tab away: follow it, like Arc.
    const followSelection = leaving.includes(this.gBrowser.selectedTab);
    for (const tab of leaving) {
      this._setSpace(tab, spaceId);
      const pinId = this._pinId(tab);
      if (pinId && this.sections?.isPinned(tab)) {
        Store.movePin(pinId, spaceId);
      }
    }
    if (followSelection) {
      this.switchTo(spaceId);
    } else {
      this.apply();
    }
  }

  // ---- switching ---------------------------------------------------------------------------

  switchTo(spaceId, { direction = 0 } = {}) {
    if (!Store.get(spaceId) || spaceId == this.active) {
      return;
    }
    const from = Store.spaces.findIndex(s => s.id == this.active);
    const to = Store.spaces.findIndex(s => s.id == spaceId);
    this.active = spaceId;
    this._saveActive();
    this.gBrowser.clearMultiSelectedTabs?.();

    const target = this._tabToSelect(spaceId);
    this._showSpaceTabs();
    if (target) {
      this.gBrowser.selectedTab = target;
    } else {
      this.openNewTab();
    }
    this.apply();
    this._animate(direction || Math.sign(to - from));
  }

  next(step) {
    this.switchTo(Logic.neighbourSpace(Store.data, this.active, step), { direction: step });
  }

  /** The tab to show when entering a Space: the one used most recently there. */
  _tabToSelect(spaceId) {
    const current = this.gBrowser.selectedTab;
    if (current.pinned) {
      return current; // an Essential stays on screen across Spaces
    }
    let best = null;
    for (const tab of this.tabsIn(spaceId)) {
      if (!best || (tab.lastAccessed ?? 0) > (best.lastAccessed ?? 0)) {
        best = tab;
      }
    }
    return best;
  }

  _showSpaceTabs() {
    for (const tab of this.gBrowser.tabs) {
      if (!tab.pinned && this.spaceOf(tab) == this.active && tab.hidden) {
        this.gBrowser.showTab(tab);
      }
    }
  }

  /** Show the active Space's tabs, hide the rest, paint the Space's colour. */
  apply() {
    const selected = this.gBrowser.selectedTab;
    if (!selected.pinned && this.spaceOf(selected) != this.active) {
      // The selected tab decides (e.g. after "switch to tab" from the address bar).
      this.active = this.spaceOf(selected);
      this._saveActive();
    }
    this._showSpaceTabs();
    for (const tab of this.gBrowser.tabs) {
      if (!tab.pinned && this.spaceOf(tab) != this.active && !tab.hidden) {
        this.gBrowser.hideTab(tab, HIDE_SOURCE);
      }
    }
    const root = this.doc.documentElement;
    root.setAttribute("halcyon-space", this.active);
    root.toggleAttribute("halcyon-grain", this.activeSpace.color.grain);
    for (const [name, value] of Object.entries(Logic.colorVars(this.activeSpace.color))) {
      root.style.setProperty(name, value);
    }
    this.ui?.render();
  }

  _animate(direction) {
    if (!direction) {
      return;
    }
    const root = this.doc.documentElement;
    root.setAttribute("halcyon-space-switch", direction > 0 ? "next" : "prev");
    this.win.clearTimeout(this._animTimer);
    this._animTimer = this.win.setTimeout(() => root.removeAttribute("halcyon-space-switch"), SWITCH_ANIMATION_MS);
  }

  // ---- new tabs and containers -------------------------------------------------------------

  openNewTab(url = this.win.BROWSER_NEW_TAB_URL) {
    const userContextId = Store.userContextIdFor(this.activeSpace);
    const tab = this.gBrowser.addTrustedTab(url, { userContextId, inBackground: false });
    this.gBrowser.selectedTab = tab;
    return tab;
  }

  /** "+ New Tab" and Ctrl/Cmd+T open in the Space's container, if it has one. */
  _wrapNewTabCommand() {
    const commands = this.win.BrowserCommands;
    if (!commands?.openTab || commands._halcyonOriginalOpenTab) {
      return;
    }
    const original = commands.openTab;
    commands._halcyonOriginalOpenTab = original;
    commands.openTab = (options = {}) => {
      if (!options.url && Store.userContextIdFor(this.activeSpace) && !options.event?.button) {
        this.openNewTab();
        return;
      }
      original.call(commands, options);
    };
  }

  _unwrapNewTabCommand() {
    const commands = this.win.BrowserCommands;
    if (commands?._halcyonOriginalOpenTab) {
      commands.openTab = commands._halcyonOriginalOpenTab;
      delete commands._halcyonOriginalOpenTab;
    }
  }

  // ---- shortcuts ---------------------------------------------------------------------------

  _createShortcuts() {
    if (this.doc.getElementById("halcyonSpacesKeyset")) {
      return;
    }
    const keyset = this.doc.createXULElement("keyset");
    keyset.id = "halcyonSpacesKeyset";
    const add = (id, attrs, command) => {
      const key = this.doc.createXULElement("key");
      key.id = id;
      for (const [k, v] of Object.entries(attrs)) {
        key.setAttribute(k, v);
      }
      key.setAttribute("modifiers", "accel,alt");
      key.addEventListener("command", command);
      keyset.append(key);
    };
    add("halcyon-key-space-next", { keycode: "VK_RIGHT" }, () => this.next(1));
    add("halcyon-key-space-prev", { keycode: "VK_LEFT" }, () => this.next(-1));
    for (let n = 1; n <= 9; n++) {
      add(`halcyon-key-space-${n}`, { key: String(n) }, () => {
        const space = Store.spaces[n - 1];
        if (space) {
          this.switchTo(space.id);
        }
      });
    }
    this.doc.documentElement.append(keyset);
  }

  // ---- launchers ---------------------------------------------------------------------------

  _pinId(tab) {
    try {
      return lazy.SessionStore.getCustomTabValue(tab, PIN_ID_VALUE) || "";
    } catch (e) {
      return "";
    }
  }

  _setPinId(tab, id) {
    try {
      if (id) {
        lazy.SessionStore.setCustomTabValue(tab, PIN_ID_VALUE, id);
      } else {
        lazy.SessionStore.deleteCustomTabValue(tab, PIN_ID_VALUE);
      }
    } catch (e) {
      // Not tracked.
    }
  }

  _launcherFor(tab, id) {
    const browser = tab.linkedBrowser;
    const url = browser?.currentURI?.spec || "";
    return { id, url, title: tab.label || "" };
  }

  _isQuitting() {
    return Services.startup.shuttingDown || this.win.closed || this.gBrowser._windowIsClosing;
  }

  /** The window that opens launchers from other machines: the most recently used one. */
  _isLauncherWindow() {
    try {
      return lazy.BrowserWindowTracker.getTopWindow({ private: false }) == this.win;
    } catch (e) {
      return true;
    }
  }

  /** Every launcher-backed tab on this machine, across windows. */
  _localLaunchers() {
    const out = [];
    for (const win of lazy.BrowserWindowTracker.orderedWindows) {
      for (const tab of win.gBrowser?.tabs ?? []) {
        let pinId = "";
        try {
          pinId = lazy.SessionStore.getCustomTabValue(tab, PIN_ID_VALUE);
        } catch (e) {
          // Not tracked.
        }
        if (pinId) {
          out.push({ pinId, kind: tab.pinned ? "essential" : "pin", tab, win });
        }
      }
    }
    return out;
  }

  /** Give this window's pinned tabs and Essentials launcher ids (first run, older sessions). */
  _adoptLocalLaunchers() {
    for (const tab of this.gBrowser.tabs) {
      if (this._pinId(tab)) {
        continue;
      }
      if (tab.pinned) {
        const id = Logic.newId("p");
        this._setPinId(tab, id);
        Store.addEssential(this._launcherFor(tab, id));
      } else if (this.sections?.isPinned(tab)) {
        const id = Logic.newId("p");
        this._setPinId(tab, id);
        Store.addPin(this.spaceOf(tab), this._launcherFor(tab, id));
      }
    }
  }

  reconcileLaunchers() {
    if (this.win.closed || !this._isLauncherWindow()) {
      return;
    }
    this._quiet++;
    try {
      this._adoptLocalLaunchers();
      const local = this._localLaunchers();
      const { open, release } = Logic.reconcileLaunchers(Store.data, local);
      for (const { kind, spaceId, entry } of open) {
        this._openLauncher(kind, spaceId, entry);
      }
      for (const pinId of release) {
        for (const item of local.filter(l => l.pinId == pinId && l.win == this.win)) {
          this._setPinId(item.tab, "");
          if (item.kind == "essential") {
            this.gBrowser.unpinTab(item.tab);
          } else {
            this.sections?.setPinned(item.tab, false);
          }
        }
      }
    } finally {
      this._quiet--;
    }
  }

  _openLauncher(kind, spaceId, entry) {
    const space = spaceId ? Store.get(spaceId) : null;
    const tab = this.gBrowser.addTrustedTab(entry.url, {
      createLazyBrowser: true,
      lazyTabTitle: entry.title || entry.url,
      skipAnimation: true,
      inBackground: true,
      userContextId: space ? Store.userContextIdFor(space) : 0,
    });
    this._setPinId(tab, entry.id);
    if (kind == "essential") {
      this.gBrowser.pinTab(tab);
    } else {
      this._setSpace(tab, spaceId);
      this.sections?.setPinned(tab, true);
      if (spaceId != this.active) {
        this.gBrowser.hideTab(tab, HIDE_SOURCE);
      }
    }
  }

  // ---- data changes ------------------------------------------------------------------------

  _onData(data, change) {
    if (change.deleted) {
      for (const tab of this.gBrowser.tabs) {
        if (tab.getAttribute(SPACE_ATTR) == change.deleted) {
          this._setSpace(tab, change.fallback);
        }
      }
      if (this.active == change.deleted) {
        this.active = change.fallback;
        this._saveActive();
      }
    }
    // Spaces removed through Sync: their tabs join the first Space.
    for (const tab of this.gBrowser.tabs) {
      if (!tab.pinned && !Store.get(tab.getAttribute(SPACE_ATTR))) {
        this._setSpace(tab, Store.get(this.active) ? this.active : data.spaces[0].id);
      }
    }
    if (!Store.get(this.active)) {
      this.active = data.spaces[0].id;
      this._saveActive();
    }
    this.apply();
    if (change.external) {
      this.reconcileLaunchers();
    }
  }

  // ---- events ------------------------------------------------------------------------------

  handleEvent(event) {
    const tab = event.target;
    switch (event.type) {
      case "TabOpen": {
        const detail = event.detail ?? {};
        if (!("fromExternal" in detail)) {
          break; // session restore: SSTabRestoring tells us the Space
        }
        const adopted = detail.adoptedTab?.getAttribute?.(SPACE_ATTR);
        this._setSpace(tab, Store.get(adopted) ? adopted : this.active);
        break;
      }
      case "SSTabRestoring":
        this._readTab(tab);
        this._scheduleApply();
        break;
      case "SSWindowRestored":
        this.active = this._restoreActive();
        this.apply();
        break;
      case "TabSelect":
        if (!tab.pinned && this.spaceOf(tab) != this.active) {
          this.switchTo(this.spaceOf(tab));
        }
        break;
      case "TabClose":
        this._onClose(tab);
        break;
      case "TabPinned":
        // Became an Essential: shared by every Space, and a synced Essential.
        tab.removeAttribute(SPACE_ATTR);
        if (!this._quiet) {
          const id = this._pinId(tab) || Logic.newId("p");
          this._setPinId(tab, id);
          Store.addEssential(this._launcherFor(tab, id));
        }
        break;
      case "TabUnpinned":
        this._setSpace(tab, this.active);
        if (!this._quiet) {
          const id = this._pinId(tab);
          if (id) {
            Store.removeEssential(id);
            this._setPinId(tab, "");
          }
        }
        break;
      case "HalcyonPinnedChange":
        if (this._quiet || tab.pinned) {
          break;
        }
        if (event.detail?.pinned) {
          const id = this._pinId(tab) || Logic.newId("p");
          this._setPinId(tab, id);
          Store.addPin(this.spaceOf(tab), this._launcherFor(tab, id));
        } else {
          const id = this._pinId(tab);
          if (id) {
            Store.removePin(id);
            this._setPinId(tab, "");
          }
        }
        break;
      case "TabAttrModified":
        // A launcher's title (and its URL, if it was pinned before loading) follows the page.
        // The title often arrives while the tab is still loading, so check again once it's done.
        if (!this._quiet && event.detail?.changed?.some(c => c == "label" || c == "busy")) {
          this._refreshLauncher(tab);
        }
        break;
      case "wheel": {
        const scale = event.deltaMode == 1 ? 16 : event.deltaMode == 2 ? 400 : 1;
        const dir = this.swipe.add(event.deltaX * scale, event.deltaY * scale);
        if (dir) {
          this.next(dir);
        }
        break;
      }
    }
  }

  _refreshLauncher(tab) {
    const id = this._pinId(tab);
    if (!id || tab.hasAttribute("pending") || tab.hasAttribute("busy")) {
      return;
    }
    const list = tab.pinned ? Store.data.essentials : Store.spaces.flatMap(s => s.pins);
    const entry = list.find(e => e.id == id);
    if (!entry) {
      return;
    }
    const fresh = this._launcherFor(tab, id);
    const patch = { id, title: fresh.title || entry.title, url: entry.url };
    if (/^about:(blank|newtab|home)$/.test(entry.url) && Logic.isLauncherURL(fresh.url)) {
      patch.url = fresh.url;
    }
    if (patch.title == entry.title && patch.url == entry.url) {
      return;
    }
    if (tab.pinned) {
      Store.addEssential(patch);
    } else {
      Store.addPin(this.spaceOf(tab), patch);
    }
  }

  _scheduleApply() {
    if (this._applyQueued) {
      return;
    }
    this._applyQueued = true;
    this.win.setTimeout(() => {
      this._applyQueued = false;
      this.apply();
    }, 0);
  }

  _onClose(tab) {
    // Closed by the user (not the window closing): its launcher goes too.
    if (!this._quiet && !this._isQuitting()) {
      const id = this._pinId(tab);
      if (id) {
        if (tab.pinned) {
          Store.removeEssential(id);
        } else {
          Store.removePin(id);
        }
      }
    }
    // Closing the last tab of a Space: open a new one there rather than letting Firefox pick
    // an Essential or a tab from another Space (which would switch Spaces under the user).
    if (tab.selected && !tab.pinned && !this._isQuitting()) {
      const others = this.gBrowser.visibleTabs.filter(t => t != tab && !t.closing && !t.pinned);
      const anyOther = this.gBrowser.tabs.some(t => t != tab && !t.closing);
      if (!others.length && anyOther) {
        const userContextId = Store.userContextIdFor(this.activeSpace);
        const fresh = this.gBrowser.addTrustedTab(this.win.BROWSER_NEW_TAB_URL, { userContextId, skipAnimation: true });
        // Firefox picks the next selected tab after this event: make it the fresh one.
        this.gBrowser.setSuccessor?.(tab, fresh);
      }
    }
  }
}
