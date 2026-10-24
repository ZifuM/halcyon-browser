/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Glance: Alt+click (Option+click) a link and it opens in a card floating over the page you're
 * on, instead of replacing it or piling up a tab. Esc, the close button or a click beside the
 * card closes it; Expand keeps it as an ordinary tab; Split puts the two side by side.
 *
 * The preview is an ordinary tab, selected and drawn as a card (peryn-glance.css), with the
 * page it came from kept visible and live underneath. While it's a preview it doesn't appear
 * in the sidebar. Going to any other tab turns the preview into an ordinary tab, so nothing is
 * ever lost.
 */

import { Motion } from "../layout/PerynMotion.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ACTOR = "PerynGlance";
export const PREFS = Object.freeze({ enabled: "peryn.glance.enabled" });
export const GLANCE_ATTR = "peryn-glance";
export const PARENT_ATTR = "peryn-glance-parent";

export const STRINGS = Object.freeze({
  close: "Close preview (Esc)",
  expand: "Open as a tab",
  split: "Open side by side",
});

let actorRegistered = false;

/** Register the actor once per process, relative to this module (moz-src, or the preview). */
export function registerGlanceActor() {
  if (actorRegistered) {
    return;
  }
  actorRegistered = true;
  try {
    ChromeUtils.registerWindowActor(ACTOR, {
      parent: { esModuleURI: new URL("PerynGlanceParent.sys.mjs", import.meta.url).href },
      child: {
        esModuleURI: new URL("PerynGlanceChild.sys.mjs", import.meta.url).href,
        events: {
          click: { capture: true, mozSystemGroup: true },
          keydown: { mozSystemGroup: true },
        },
      },
      matches: ["http://*/*", "https://*/*"],
      allFrames: true,
      messageManagerGroups: ["browsers"],
      // The child lives in ordinary web content processes. That's safe: the parent only opens
      // http(s) URLs as a preview of the tab on screen, with the page's own principal (no more
      // than the page could do with window.open), and Esc only closes a preview.
      safeForUntrustedWebProcess: true,
      enablePreference: PREFS.enabled,
    });
  } catch (e) {
    // NotSupportedError: already registered by an earlier load of this module.
    if (e?.name != "NotSupportedError") {
      console.error("Peryn Glance: actor registration failed", e);
    }
  }
}

export class PerynGlance {
  constructor(win, parts = {}) {
    this.win = win;
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    this.parts = parts;
    /** preview tab -> the tab it was opened from */
    this.parents = new WeakMap();
    this.motion = new Motion(win);
    this.handleEvent = this.handleEvent.bind(this);
  }

  init() {
    registerGlanceActor();
    this.win.PerynGlance = this;
    this.gBrowser.tabContainer.addEventListener("TabSelect", this.handleEvent);
    this.gBrowser.tabContainer.addEventListener("TabClose", this.handleEvent);
    // Esc while the browser's own UI has focus (the card's buttons, the sidebar). Esc in the
    // page comes through the actor; the address bar and other text fields keep their own Esc.
    this.win.addEventListener("keydown", this.handleEvent);
  }

  uninit() {
    this.win.removeEventListener("keydown", this.handleEvent);
    this.gBrowser.tabContainer.removeEventListener("TabSelect", this.handleEvent);
    this.gBrowser.tabContainer.removeEventListener("TabClose", this.handleEvent);
    if (this.win.PerynGlance == this) {
      delete this.win.PerynGlance;
    }
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREFS.enabled, true);
  }

  /** The preview on screen, if any. */
  get current() {
    const tab = this.gBrowser.selectedTab;
    return tab?.hasAttribute(GLANCE_ATTR) ? tab : null;
  }

  parentOf(tab) {
    return this.parents.get(tab) ?? null;
  }

  /**
   * Open `url` as a preview over the tab showing `fromBrowser` (default: the current tab).
   * Only the page on screen can open one; a new preview replaces the one open.
   *
   * @returns {object|null} the preview tab
   */
  open(url, { fromBrowser = null, triggeringPrincipal = null, referrer = "" } = {}) {
    if (!this.enabled) {
      return null;
    }
    let parent = fromBrowser ? this.gBrowser.getTabForBrowser(fromBrowser) : this.gBrowser.selectedTab;
    if (!parent || parent != this.gBrowser.selectedTab) {
      return null;
    }
    if (parent.hasAttribute(GLANCE_ATTR)) {
      // A link in a preview: the new preview replaces it, over the same page.
      const below = this.parentOf(parent);
      this.close();
      parent = below ?? this.gBrowser.selectedTab;
    }
    const tab = this.gBrowser.addTab(url, {
      triggeringPrincipal: triggeringPrincipal ?? Services.scriptSecurityManager.getSystemPrincipal(),
      referrerInfo: this._referrerInfo(referrer),
      userContextId: parent.userContextId,
      ownerTab: parent,
      relatedToCurrent: true,
      inBackground: true,
      skipAnimation: true,
      hasValidUserGestureActivation: true,
    });
    this.parents.set(tab, parent);
    tab.setAttribute(GLANCE_ATTR, "true");
    // Before the switch, so the tab switcher leaves the page underneath painting.
    this._keepActive(parent.linkedBrowser);
    this._show(tab, parent);
    this.gBrowser.selectedTab = tab;
    return tab;
  }

  /** Close the preview on screen and go back to the page it came from. */
  close() {
    const tab = this.current;
    if (!tab || this._closing == tab) {
      return;
    }
    if (!this.motion.duration("--hx-duration-fast")) {
      this._closeNow(tab);
      return;
    }
    // The card drops away and the backdrop clears, then the tab goes.
    this._closing = tab;
    Promise.all([
      this.motion.leave([this._panelOf(tab)], [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px) scale(0.98)" }]),
      this.motion.leave([this._layerEl], [{ opacity: 1 }, { opacity: 0 }]),
    ]).finally(() => {
      this._closing = null;
      if (tab.isConnected && tab.hasAttribute(GLANCE_ATTR)) {
        this._closeNow(tab);
      }
    });
  }

  _closeNow(tab) {
    const parent = this.parentOf(tab);
    this._forget(tab);
    if (parent?.isConnected) {
      this.gBrowser.selectedTab = parent;
    }
    this.gBrowser.removeTab(tab, { animate: false });
  }

  /** Esc in a page: closes it if it's the preview on screen. */
  closeFor(browser) {
    const tab = this.gBrowser.getTabForBrowser(browser);
    if (tab && tab == this.current) {
      this.close();
    }
  }

  /** Keep the preview as an ordinary tab, right after the page it came from. */
  expand() {
    const tab = this.current;
    if (!tab) {
      return null;
    }
    const parent = this.parentOf(tab);
    // The card grows to fill the content area.
    this.motion.flip([this._panelOf(tab)], () => this._forget(tab));
    const tabs = this.gBrowser.tabs;
    if (parent?.isConnected && !parent.pinned && !parent.splitview && tabs.indexOf(tab) != tabs.indexOf(parent) + 1) {
      this.gBrowser.moveTabAfter(tab, parent);
    }
    return tab;
  }

  /** The page and its preview side by side (joining the page's split view, if it's in one). */
  split() {
    const tab = this.current;
    const parent = tab && this.parentOf(tab);
    if (!tab || !parent?.isConnected || parent.pinned) {
      return this.expand();
    }
    // The page and the card glide into their halves.
    let made = null;
    this.motion.flip([this._panelOf(parent), this._panelOf(tab)], () => {
      this._forget(tab);
      this.gBrowser.selectedTab = parent;
      made = this.parts.split
        ? this.parts.split.add([tab])
        : this.gBrowser.addTabSplitView([parent, tab], { insertBefore: parent });
      this.gBrowser.selectedTab = made ? tab : parent;
    });
    return tab;
  }

  /** Places whose own Esc comes first: text fields, the address bar, our other overlays. */
  _keepsOwnEscape(target) {
    return !!target?.closest?.("#urlbar, input, textarea, [contenteditable], #peryn-commandbar, #peryn-onboarding");
  }

  // ---- showing -----------------------------------------------------------------------------

  _referrerInfo(referrer) {
    if (!referrer) {
      return null;
    }
    try {
      const info = Cc["@mozilla.org/referrer-info;1"].createInstance(Ci.nsIReferrerInfo);
      info.init(Ci.nsIReferrerInfo.EMPTY, true, Services.io.newURI(referrer));
      return info;
    } catch {
      return null;
    }
  }

  _panelOf(tab) {
    return tab?.linkedPanel ? this.doc.getElementById(tab.linkedPanel) : null;
  }

  /**
   * Firefox keeps a hidden tab's page from painting. It makes an exception for print preview;
   * the page under a card gets the same one, for as long as the card is open.
   */
  _keepActive(browser) {
    if (!browser) {
      return;
    }
    if (typeof this.gBrowser.activateBrowserForPrintPreview == "function") {
      this.gBrowser.activateBrowserForPrintPreview(browser);
    } else {
      browser.docShellIsActive = true;
    }
  }

  _release(browser) {
    if (!browser) {
      return;
    }
    this.gBrowser._printPreviewBrowsers?.delete(browser);
    try {
      browser.docShellIsActive = this.gBrowser.shouldActivateDocShell?.(browser) ?? browser == this.gBrowser.selectedBrowser;
    } catch {}
  }

  _show(tab, parent) {
    this.doc.getElementById("tabbrowser-tabpanels")?.setAttribute(GLANCE_ATTR, "true");
    this._panelOf(tab)?.setAttribute(GLANCE_ATTR, "card");
    this._panelOf(parent)?.setAttribute(PARENT_ATTR, "true");
    this._layer().hidden = false;
    this.doc.documentElement.setAttribute("peryn-glance-open", "true");
  }

  /** The tab stops being a preview (closed, kept, or left). */
  _forget(tab) {
    const parent = this.parentOf(tab);
    tab.removeAttribute(GLANCE_ATTR);
    this.parents.delete(tab);
    this._panelOf(tab)?.removeAttribute(GLANCE_ATTR);
    if (parent) {
      this._panelOf(parent)?.removeAttribute(PARENT_ATTR);
      this._release(parent.linkedBrowser);
    }
    if (!this.gBrowser.tabs.some(t => t.hasAttribute(GLANCE_ATTR))) {
      this.doc.getElementById("tabbrowser-tabpanels")?.removeAttribute(GLANCE_ATTR);
      if (this._layerEl) {
        this._layerEl.hidden = true;
      }
      this.doc.documentElement.removeAttribute("peryn-glance-open");
    }
  }

  /** The dimmed backdrop over the page underneath, and the card's buttons. */
  _layer() {
    if (this._layerEl) {
      return this._layerEl;
    }
    const make = (tag, attrs = {}, children = []) => {
      const el = this.doc.createElementNS(HTML_NS, tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (typeof v == "function") {
          el.addEventListener(k, v);
        } else {
          el.setAttribute(k, v);
        }
      }
      el.append(...children);
      return el;
    };
    const button = (cls, label, run) =>
      make("button", {
        class: `peryn-glance-button ${cls}`,
        title: label,
        "aria-label": label,
        click: event => {
          event.stopPropagation();
          run();
        },
      });
    this._layerEl = make(
      "div",
      {
        id: "peryn-glance-layer",
        hidden: "true",
        keydown: event => {
          if (event.key == "Escape") {
            event.preventDefault();
            this.close();
          }
        },
      },
      [
        make("div", { class: "peryn-glance-backdrop", mousedown: () => this.close() }),
        make("div", { class: "peryn-glance-controls", role: "toolbar", "aria-label": "Preview" }, [
          button("peryn-glance-close", STRINGS.close, () => this.close()),
          button("peryn-glance-expand", STRINGS.expand, () => this.expand()),
          button("peryn-glance-split", STRINGS.split, () => this.split()),
        ]),
      ]
    );
    this.doc.getElementById("tabbrowser-tabbox").append(this._layerEl);
    return this._layerEl;
  }

  handleEvent(event) {
    const tab = event.target;
    switch (event.type) {
      case "keydown":
        if (event.key == "Escape" && this.current && !event.defaultPrevented && !this._keepsOwnEscape(event.target)) {
          event.preventDefault();
          this.close();
        }
        break;
      case "TabSelect": {
        // Went somewhere other than the page underneath: the preview stays, as a tab.
        const previous = event.detail?.previousTab;
        if (previous?.hasAttribute(GLANCE_ATTR) && tab != this.parentOf(previous)) {
          this._forget(previous);
        }
        break;
      }
      case "TabClose":
        if (tab.hasAttribute(GLANCE_ATTR)) {
          const parent = this.parentOf(tab);
          const wasSelected = tab.selected;
          this._forget(tab);
          if (wasSelected && parent?.isConnected) {
            this.gBrowser.selectedTab = parent;
          }
        } else {
          // The page under a preview closed: the preview stays, as an ordinary tab.
          for (const other of this.gBrowser.tabs) {
            if (other.hasAttribute(GLANCE_ATTR) && this.parentOf(other) == tab) {
              this._forget(other);
            }
          }
        }
        break;
    }
  }
}
