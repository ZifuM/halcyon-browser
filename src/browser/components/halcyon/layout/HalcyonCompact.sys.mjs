/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Compact mode, per window: the sidebar and top bar slide away and the page takes the whole
// window. They come back while the pointer is at the window edge or over them, while the
// keyboard is in them (Ctrl/Cmd+L reveals the top bar), and while a menu or panel opened from
// them is up. Toggled with Ctrl+Alt+C (Cmd+Option+C on macOS) or halcyon.layout.compact.
//
// This module only tracks *why* each part is shown and writes the `halcyon-reveal` attribute;
// halcyon-compact.css does the sliding, on the compositor.

import {
  DEFAULT_HIDE_DELAY_MS,
  PREFS,
  RevealState,
  revealAttribute,
} from "./HalcyonLayoutLogic.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const STRINGS = Object.freeze({
  toggle: "Compact Mode",
});

export class HalcyonCompact {
  constructor(win) {
    this.win = win;
    this.doc = win.document;
    this.root = this.doc.documentElement;
    this.handleEvent = this.handleEvent.bind(this);
    this.observe = this.observe.bind(this);
    this.state = new RevealState({
      onChange: revealed => this._render(revealed),
      hideDelayMs: Services.prefs.getIntPref(PREFS.hideDelayMs, DEFAULT_HIDE_DELAY_MS),
      setTimeout: (fn, ms) => win.setTimeout(fn, ms),
      clearTimeout: id => win.clearTimeout(id),
    });
  }

  get toolbox() {
    return this.doc.getElementById("navigator-toolbox");
  }

  get sidebar() {
    return this.doc.getElementById("sidebar-container");
  }

  init() {
    this._createEdges();
    this._createShortcut();
    for (const [el, part] of this._watched()) {
      el?.addEventListener("mouseenter", this.handleEvent);
      el?.addEventListener("mouseleave", this.handleEvent);
      el?.addEventListener("focusin", this.handleEvent);
      el?.addEventListener("focusout", this.handleEvent);
      el?.setAttribute("halcyon-part", part);
    }
    this.doc.addEventListener("popupshown", this.handleEvent);
    this.doc.addEventListener("popuphidden", this.handleEvent);
    Services.prefs.addObserver(PREFS.compact, this.observe);
    Services.prefs.addObserver("sidebar.position_start", this.observe);
    this._apply();
  }

  uninit() {
    for (const [el] of this._watched()) {
      el?.removeEventListener("mouseenter", this.handleEvent);
      el?.removeEventListener("mouseleave", this.handleEvent);
      el?.removeEventListener("focusin", this.handleEvent);
      el?.removeEventListener("focusout", this.handleEvent);
    }
    this.doc.removeEventListener("popupshown", this.handleEvent);
    this.doc.removeEventListener("popuphidden", this.handleEvent);
    Services.prefs.removeObserver(PREFS.compact, this.observe);
    Services.prefs.removeObserver("sidebar.position_start", this.observe);
    this.state.reset();
  }

  get enabled() {
    return Services.prefs.getBoolPref(PREFS.compact, false);
  }

  toggle() {
    Services.prefs.setBoolPref(PREFS.compact, !this.enabled);
  }

  _watched() {
    return [
      [this.toolbox, "toolbar"],
      [this.sidebar, "sidebar"],
      [this.edgeToolbar, "toolbar"],
      [this.edgeSidebar, "sidebar"],
    ];
  }

  _createEdges() {
    const make = (id, part) => {
      let el = this.doc.getElementById(id);
      if (!el) {
        el = this.doc.createElementNS(HTML_NS, "div");
        el.id = id;
        el.className = "halcyon-reveal-edge";
        el.setAttribute("halcyon-part", part);
        this.doc.body.append(el);
      }
      return el;
    };
    this.edgeToolbar = make("halcyon-edge-toolbar", "toolbar");
    this.edgeSidebar = make("halcyon-edge-sidebar", "sidebar");
  }

  _createShortcut() {
    // A keyset of our own: keys added to an existing keyset aren't picked up after load.
    if (this.doc.getElementById("halcyonKeyset")) {
      return;
    }
    const keyset = this.doc.createXULElement("keyset");
    keyset.id = "halcyonKeyset";
    const key = this.doc.createXULElement("key");
    key.id = "halcyon-key-compact";
    key.setAttribute("key", "C");
    key.setAttribute("modifiers", "accel,alt");
    key.addEventListener("command", () => this.toggle());
    keyset.append(key);
    this.root.append(keyset);
  }

  _apply() {
    const on = this.enabled;
    this.root.toggleAttribute("halcyon-compact", on);
    this.root.toggleAttribute(
      "halcyon-sidebar-end",
      !Services.prefs.getBoolPref("sidebar.position_start", true)
    );
    if (!on) {
      this.state.reset();
    }
  }

  _render(revealed) {
    const value = revealAttribute(revealed);
    if (value) {
      this.root.setAttribute("halcyon-reveal", value);
    } else {
      this.root.removeAttribute("halcyon-reveal");
    }
  }

  /** Which part of the chrome a node belongs to, if any. */
  _partOf(node) {
    for (let n = node; n; n = n.parentNode) {
      if (n.nodeType == 1 && n.hasAttribute?.("halcyon-part")) {
        return n.getAttribute("halcyon-part");
      }
      if (n.nodeType == 1 && n.localName == "browser") {
        return null; // inside page content
      }
    }
    return null;
  }

  observe(_subject, topic, data) {
    if (topic == "nsPref:changed" && (data == PREFS.compact || data == "sidebar.position_start")) {
      this._apply();
    }
  }

  handleEvent(event) {
    if (!this.enabled) {
      return;
    }
    switch (event.type) {
      case "mouseenter": {
        const part = event.currentTarget.getAttribute("halcyon-part");
        this.state.add(part, `hover:${event.currentTarget.id}`);
        break;
      }
      case "mouseleave": {
        const part = event.currentTarget.getAttribute("halcyon-part");
        this.state.remove(part, `hover:${event.currentTarget.id}`);
        break;
      }
      case "focusin": {
        const part = event.currentTarget.getAttribute("halcyon-part");
        this.state.add(part, "focus");
        break;
      }
      case "focusout": {
        const part = event.currentTarget.getAttribute("halcyon-part");
        if (!event.relatedTarget || this._partOf(event.relatedTarget) != part) {
          this.state.remove(part, "focus");
        }
        break;
      }
      case "popupshown": {
        const popup = event.target;
        const part = this._partOf(popup.anchorNode ?? popup.triggerNode);
        if (part) {
          popup._halcyonRevealPart = part;
          this.state.add(part, `popup:${popup.id || "anon"}`);
        }
        break;
      }
      case "popuphidden": {
        const popup = event.target;
        if (popup._halcyonRevealPart) {
          this.state.remove(popup._halcyonRevealPart, `popup:${popup.id || "anon"}`);
          delete popup._halcyonRevealPart;
        }
        break;
      }
    }
  }
}
