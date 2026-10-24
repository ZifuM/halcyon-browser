/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Split view with up to four panes, one controller per window.
 *
 * Firefox's split view groups tabs in a <tab-split-view-wrapper> and shows their panels side by
 * side. It's built for two panes; Peryn keeps that as is and only steps in for a third or
 * fourth pane, or another arrangement: it marks each panel with the grid area it takes, and
 * peryn-split.css lays #tabbrowser-tabpanels out as a CSS grid. Dividers are our own handles
 * over the panels. The layout and divider positions are saved with the split's first tab.
 */

import * as Logic from "./PerynSplitLogic.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "moz-src:///browser/components/sessionstore/SessionStore.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANE_ATTR = "peryn-pane";
const MENU_ID = "peryn-context-add-to-split";

export const STRINGS = Object.freeze({
  addToSplit: "Add to Split View",
  divider: "Resize split view",
});

export class PerynSplit {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    /** split view element -> {layout, x, y} */
    this._states = new WeakMap();
    this._marked = new Set();
    this.handleEvent = this.handleEvent.bind(this);
  }

  get tabpanels() {
    return this.gBrowser.tabpanels ?? this.doc.getElementById("tabbrowser-tabpanels");
  }

  init() {
    const container = this.gBrowser.tabContainer;
    for (const type of ["TabSplitViewActivate", "TabSplitViewDeactivate", "SplitViewTabChange", "SplitViewRemoved", "TabClose"]) {
      container.addEventListener(type, this.handleEvent);
    }
    this.win.addEventListener("TabSelect", this.handleEvent);
    this._resizeObserver = new this.win.ResizeObserver(() => this._placeHandles());
    this._resizeObserver.observe(this.tabpanels);
    this._addContextMenu();
    this.apply();
  }

  uninit() {
    const container = this.gBrowser.tabContainer;
    for (const type of ["TabSplitViewActivate", "TabSplitViewDeactivate", "SplitViewTabChange", "SplitViewRemoved", "TabClose"]) {
      container.removeEventListener(type, this.handleEvent);
    }
    this.win.removeEventListener("TabSelect", this.handleEvent);
    this._resizeObserver?.disconnect();
    this.menu?.removeEventListener("popupshowing", this.handleEvent);
    this._clear();
  }

  handleEvent(event) {
    switch (event.type) {
      case "TabClose":
        this._onTabClose(event.target);
        break;
      case "popupshowing":
        if (event.target == this.menu) {
          this._updateMenu();
        }
        break;
      default:
        // Activation, tab changes and selection all settle in the same tick.
        this.win.clearTimeout(this._applyTimer);
        this._applyTimer = this.win.setTimeout(() => this.apply(), 0);
    }
  }

  // ---- state -------------------------------------------------------------------------------

  get active() {
    return this.gBrowser.activeSplitView ?? null;
  }

  stateOf(split) {
    let state = this._states.get(split);
    if (!state) {
      let saved = "";
      try {
        saved = lazy.SessionStore.getCustomTabValue(split.tabs[0], Logic.STATE_KEY);
      } catch {}
      state = Logic.readState(saved);
      this._states.set(split, state);
    }
    return state;
  }

  _save(split) {
    const state = this.stateOf(split);
    try {
      lazy.SessionStore.setCustomTabValue(split.tabs[0], Logic.STATE_KEY, JSON.stringify(state));
    } catch {}
  }

  // ---- layout ------------------------------------------------------------------------------

  /** Lay out the active split view (or step aside for Firefox's own two-pane one). */
  apply() {
    const split = this.active;
    const tabs = split?.tabs ?? [];
    if (tabs.length < 2) {
      this._clear();
      return;
    }
    const panes = Math.min(tabs.length, Logic.MAX_PANES);
    const state = this.stateOf(split);
    const layout = Logic.layoutFor(panes, state.layout);
    if (Logic.isNative(panes, layout)) {
      this._clear();
      return;
    }
    const grid = Logic.gridFor(panes, layout, state);
    const panels = this.tabpanels;
    panels.setAttribute("peryn-split", layout);
    panels.setAttribute("peryn-panes", String(panes));
    panels.style.setProperty("--peryn-split-columns", grid.columns);
    panels.style.setProperty("--peryn-split-rows", grid.rows);
    panels.style.setProperty("--peryn-split-areas", grid.areas.join(" "));

    const marked = new Set();
    tabs.slice(0, panes).forEach((tab, i) => {
      const panel = this.doc.getElementById(tab.linkedPanel);
      if (panel) {
        panel.setAttribute(PANE_ATTR, Logic.AREAS[i]);
        marked.add(panel);
      }
    });
    for (const panel of this._marked) {
      if (!marked.has(panel)) {
        panel.removeAttribute(PANE_ATTR);
      }
    }
    this._marked = marked;
    this._dividers = grid.dividers;
    this._placeHandles();
  }

  _clear() {
    const panels = this.tabpanels;
    if (!panels) {
      return;
    }
    panels.removeAttribute("peryn-split");
    panels.removeAttribute("peryn-panes");
    for (const name of ["--peryn-split-columns", "--peryn-split-rows", "--peryn-split-areas"]) {
      panels.style.removeProperty(name);
    }
    for (const panel of this._marked) {
      panel.removeAttribute(PANE_ATTR);
    }
    this._marked = new Set();
    this._dividers = [];
    this._placeHandles();
  }

  // ---- dividers ----------------------------------------------------------------------------

  _handleLayer() {
    let layer = this.doc.getElementById("peryn-split-handles");
    if (!layer) {
      layer = this.doc.createElementNS(HTML_NS, "div");
      layer.id = "peryn-split-handles";
      this.doc.getElementById("tabbrowser-tabbox")?.append(layer);
    }
    return layer;
  }

  _placeHandles() {
    const dividers = this._dividers ?? [];
    const existing = this.doc.getElementById("peryn-split-handles");
    if (!dividers.length) {
      existing?.replaceChildren();
      return;
    }
    const layer = this._handleLayer();
    const box = this.doc.getElementById("tabbrowser-tabbox").getBoundingClientRect();
    const area = this.tabpanels.getBoundingClientRect();
    const state = this.stateOf(this.active);
    const left = area.left - box.left;
    const topEdge = area.top - box.top;
    const handles = dividers.map(kind => {
      const el = this.doc.createElementNS(HTML_NS, "div");
      el.className = "peryn-split-divider";
      el.dataset.kind = kind;
      el.setAttribute("role", "separator");
      el.setAttribute("aria-label", STRINGS.divider);
      el.setAttribute("tabindex", "0");
      if (kind == "x") {
        el.setAttribute("aria-orientation", "vertical");
        Object.assign(el.style, {
          left: `${left + area.width * state.x}px`,
          top: `${topEdge}px`,
          height: `${area.height}px`,
        });
      } else {
        const fromX = kind == "y-right" ? area.width * state.x : 0;
        el.setAttribute("aria-orientation", "horizontal");
        Object.assign(el.style, {
          left: `${left + fromX}px`,
          top: `${topEdge + area.height * state.y}px`,
          width: `${area.width - fromX}px`,
        });
      }
      el.addEventListener("pointerdown", e => this._startDrag(e, kind));
      el.addEventListener("keydown", e => this._keyResize(e, kind));
      return el;
    });
    layer.replaceChildren(...handles);
  }

  _startDrag(event, kind) {
    const split = this.active;
    if (!split || event.button != 0) {
      return;
    }
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    this.tabpanels.setAttribute("peryn-split-dragging", "true");
    const move = e => {
      const area = this.tabpanels.getBoundingClientRect();
      const state = this.stateOf(split);
      if (kind == "x") {
        state.x = Logic.ratioFromPointer(e.clientX - area.left, area.width);
      } else {
        state.y = Logic.ratioFromPointer(e.clientY - area.top, area.height);
      }
      this.apply();
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("lostpointercapture", end);
      this.tabpanels.removeAttribute("peryn-split-dragging");
      this._save(split);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("lostpointercapture", end);
    event.preventDefault();
  }

  _keyResize(event, kind) {
    const split = this.active;
    const step = { ArrowLeft: -0.05, ArrowRight: 0.05, ArrowUp: -0.05, ArrowDown: 0.05 }[event.key];
    if (!split || !step) {
      return;
    }
    const horizontalKey = event.key == "ArrowLeft" || event.key == "ArrowRight";
    if ((kind == "x") != horizontalKey) {
      return;
    }
    const state = this.stateOf(split);
    const axis = kind == "x" ? "x" : "y";
    state[axis] = Logic.clampRatio(state[axis] + step);
    this.apply();
    this._save(split);
    this.doc.querySelector(`.peryn-split-divider[data-kind="${kind}"]`)?.focus();
    event.preventDefault();
  }

  // ---- commands ----------------------------------------------------------------------------

  /** Whether `tabs` can be added to the active split view (or start one with the current tab). */
  canAdd(tabs) {
    const split = this.active;
    const current = split ? split.tabs : [this.gBrowser.selectedTab];
    return Logic.joinable(current, tabs).length > 0;
  }

  /**
   * Add tabs to the active split view, or start one from the current tab and these.
   *
   * @returns {object|null} the split view
   */
  add(tabs) {
    const split = this.active;
    if (split) {
      const joining = Logic.joinable(split.tabs, tabs);
      if (joining.length) {
        this._sameSpace(split.tabs[0], joining);
        split.addTabs(joining);
        this.apply();
      }
      return split;
    }
    const selected = this.gBrowser.selectedTab;
    if (selected.pinned) {
      return null;
    }
    const joining = Logic.joinable([selected], tabs);
    if (!joining.length) {
      return null;
    }
    this._sameSpace(selected, joining);
    return this.gBrowser.addTabSplitView([selected, ...joining], { insertBefore: selected });
  }

  /** Tabs from another Space join this one, so the split never straddles Spaces. */
  _sameSpace(reference, tabs) {
    const space = reference.getAttribute("peryn-space");
    for (const tab of tabs) {
      if (space && tab.getAttribute("peryn-space") != space) {
        tab.setAttribute("peryn-space", space);
      }
      if (tab.hidden) {
        this.gBrowser.showTab(tab);
      }
    }
  }

  /** Switch the active split view to its next layout. */
  cycleLayout() {
    const split = this.active;
    if (!split) {
      return null;
    }
    const panes = Math.min(split.tabs.length, Logic.MAX_PANES);
    const state = this.stateOf(split);
    state.layout = Logic.nextLayout(panes, Logic.layoutFor(panes, state.layout));
    this._save(split);
    this.apply();
    return state.layout;
  }

  separate() {
    this.active?.unsplitTabs();
  }

  /**
   * Firefox's split view expects two panes, and dissolves when one is left. With three or
   * four, rebuild it from the remaining tabs after a close, keeping the layout.
   */
  _onTabClose(tab) {
    const split = tab.splitview;
    if (!split || split.tabs.length <= 2) {
      return;
    }
    const state = { ...this.stateOf(split) };
    const remaining = split.tabs.filter(t => t != tab);
    this.win.setTimeout(() => {
      const live = remaining.filter(t => t.isConnected && !t.closing);
      if (live.length < 2) {
        return;
      }
      if (tab.splitview === split || split.isConnected) {
        split.unsplitTabs?.();
      }
      const rebuilt = this.gBrowser.addTabSplitView(live, { insertBefore: live[0] });
      if (rebuilt) {
        this._states.set(rebuilt, state);
        this._save(rebuilt);
        this.apply();
      }
    }, 0);
  }

  // ---- tab context menu --------------------------------------------------------------------

  _addContextMenu() {
    this.menu = this.doc.getElementById("tabContextMenu");
    if (!this.menu || this.doc.getElementById(MENU_ID)) {
      return;
    }
    const item = this.doc.createXULElement("menuitem");
    item.id = MENU_ID;
    item.setAttribute("label", STRINGS.addToSplit);
    item.hidden = true;
    item.addEventListener("command", () => this.add(this._contextTabs()));
    const anchor = this.doc.getElementById("context_moveTabOptions") ?? this.menu.firstElementChild;
    this.menu.insertBefore(item, anchor);
    this.menu.addEventListener("popupshowing", this.handleEvent);
  }

  _contextTabs() {
    const tab = this.win.TabContextMenu?.contextTab;
    if (!tab) {
      return [];
    }
    return tab.multiselected ? this.gBrowser.selectedTabs : [tab];
  }

  _updateMenu() {
    const item = this.doc.getElementById(MENU_ID);
    if (item) {
      // Only offered while a split view is open here; Firefox's own item starts a new one.
      item.hidden = !this.active || !this.canAdd(this._contextTabs());
    }
  }
}
