/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Spaces UI in one window:
//   * the Space's name above its Pinned tabs (click to edit),
//   * the Space switcher at the bottom of the sidebar (one dot per Space, + for a new one),
//   * the Space editor panel (name, icon, colour wheel, intensity, grain, container, delete),
//   * "Move to Space" in the tab menu.
// Strings are English until the browser ships its own localisation files.

import * as Logic from "./HalcyonSpacesLogic.sys.mjs";
import { HalcyonSpacesStore as Store } from "./HalcyonSpacesStore.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const STRINGS = Object.freeze({
  newSpace: "New Space",
  editSpace: "Edit Space",
  name: "Name",
  icon: "Icon",
  color: "Colour",
  intensity: "Intensity",
  blend: "Blend",
  grain: "Grain",
  container: "Container",
  noContainer: "No container",
  newContainer: "New container named after this Space",
  deleteSpace: "Delete Space",
  confirmDelete: "Click again to delete",
  done: "Done",
  moveToSpace: "Move to Space",
  switchTo: name => `Switch to ${name}`,
  containerHint: "New tabs in this Space open in this container: separate cookies and logins.",
});

export class HalcyonSpacesUI {
  constructor(controller) {
    this.c = controller;
    this.win = controller.win;
    this.doc = controller.doc;
    this.editingId = null;
  }

  html(tag, props = {}, children = []) {
    const el = this.doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(props)) {
      if (k == "class") {
        el.className = v;
      } else if (k == "style") {
        el.style.cssText = v; // CSSOM: not subject to the chrome document's CSP
      } else if (k == "text") {
        el.textContent = v;
      } else if (k.startsWith("on")) {
        el.addEventListener(k.slice(2), v);
      } else if (v !== undefined && v !== null && v !== false) {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children);
    return el;
  }

  init() {
    this._createHeader();
    this._createBar();
    this._createEditor();
    this._createTabMenu();
  }

  uninit() {
    for (const id of ["halcyon-space-header", "halcyon-space-bar", "halcyon-space-editor", "halcyon-context-move-to-space"]) {
      this.doc.getElementById(id)?.remove();
    }
  }

  // ---- header ------------------------------------------------------------------------------

  _createHeader() {
    const tabs = this.doc.getElementById("tabbrowser-tabs");
    const scrollbox = this.doc.getElementById("tabbrowser-arrowscrollbox");
    if (!tabs || !scrollbox || this.doc.getElementById("halcyon-space-header")) {
      return;
    }
    this.header = this.html("div", { id: "halcyon-space-header", role: "heading", "aria-level": "2" }, [
      this.html("span", { class: "halcyon-space-icon" }),
      this.html("button", {
        class: "halcyon-space-name",
        title: STRINGS.editSpace,
        onclick: e => this.openEditor(this.c.active, e.currentTarget),
      }),
      this.html("button", {
        class: "halcyon-space-more",
        title: STRINGS.editSpace,
        "aria-label": STRINGS.editSpace,
        onclick: e => this.openEditor(this.c.active, e.currentTarget),
      }),
    ]);
    scrollbox.before(this.header);
  }

  // ---- bottom bar --------------------------------------------------------------------------

  _createBar() {
    const vertical = this.doc.getElementById("vertical-tabs");
    if (!vertical || this.doc.getElementById("halcyon-space-bar")) {
      return;
    }
    this.dots = this.html("div", { class: "halcyon-space-dots", role: "tablist", "aria-label": "Spaces" });
    this.bar = this.html("div", { id: "halcyon-space-bar" }, [
      this.dots,
      this.html("button", {
        class: "halcyon-space-add",
        title: STRINGS.newSpace,
        "aria-label": STRINGS.newSpace,
        onclick: e => this.createSpace(e.currentTarget),
      }),
    ]);
    vertical.append(this.bar);
  }

  createSpace(anchor) {
    const space = Store.create({});
    this.c.switchTo(space.id, { direction: 1 });
    this.openEditor(space.id, this.doc.querySelector(`.halcyon-space-dot[data-space="${space.id}"]`) ?? anchor);
  }

  // ---- rendering ---------------------------------------------------------------------------

  render() {
    const space = this.c.activeSpace;
    if (this.header) {
      this.header.querySelector(".halcyon-space-icon").textContent = space.icon || "";
      this.header.querySelector(".halcyon-space-icon").hidden = !space.icon;
      this.header.querySelector(".halcyon-space-name").textContent = space.name;
    }
    if (this.dots) {
      this.dots.replaceChildren(
        ...Store.spaces.map(s =>
          this.html(
            "button",
            {
              class: "halcyon-space-dot",
              role: "tab",
              "data-space": s.id,
              "aria-selected": s.id == this.c.active ? "true" : "false",
              title: s.name,
              "aria-label": STRINGS.switchTo(s.name),
              style: `--hx-dot: ${Logic.swatchCSS(s.color)}`,
              onclick: () => this.c.switchTo(s.id),
              oncontextmenu: e => {
                e.preventDefault();
                this.openEditor(s.id, e.currentTarget);
              },
            },
            [this.html("span", { class: "halcyon-space-dot-icon", text: s.icon || "" })]
          )
        )
      );
    }
    if (this.editingId && this.panel?.state == "open") {
      this._fillEditor(Store.get(this.editingId), { keepFocus: true });
    }
  }

  // ---- editor ------------------------------------------------------------------------------

  _createEditor() {
    if (this.doc.getElementById("halcyon-space-editor")) {
      return;
    }
    const panel = this.doc.createXULElement("panel");
    panel.id = "halcyon-space-editor";
    panel.setAttribute("type", "arrow");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", STRINGS.editSpace);
    panel.addEventListener("popuphidden", () => {
      this.editingId = null;
      this._resetDelete();
    });

    const field = (label, control, extra = []) =>
      this.html("label", { class: "hx-field" }, [this.html("span", { class: "hx-label", text: label }), control, ...extra]);

    this.nameInput = this.html("input", {
      type: "text",
      maxlength: String(Logic.MAX_NAME),
      oninput: () => this._debounced("name", () => Store.update(this.editingId, { name: this.nameInput.value })),
      onkeydown: e => e.key == "Enter" && panel.hidePopup(),
    });
    this.iconInput = this.html("input", {
      type: "text",
      class: "hx-icon-input",
      maxlength: "8",
      placeholder: "∅",
      oninput: () => Store.update(this.editingId, { icon: this.iconInput.value }),
    });
    this.iconChoices = this.html(
      "div",
      { class: "hx-icon-choices" },
      Logic.ICON_CHOICES.map(icon =>
        this.html("button", {
          class: "hx-icon-choice",
          text: icon,
          onclick: () => {
            this.iconInput.value = icon;
            Store.update(this.editingId, { icon });
          },
        })
      )
    );

    this.wheelMarker = this.html("div", { class: "hx-wheel-marker" });
    this.wheel = this.html("div", { class: "hx-wheel", title: STRINGS.color }, [
      this.html("div", { class: "hx-wheel-center" }),
      this.wheelMarker,
    ]);
    const pickHue = e => {
      const r = this.wheel.getBoundingClientRect();
      const hue = Logic.hueFromPoint(e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2);
      const space = Store.get(this.editingId);
      const offset = (space.color.hue2 - space.color.hue + 360) % 360;
      Store.update(this.editingId, { color: { hue, hue2: (hue + offset) % 360 } });
    };
    this.wheel.addEventListener("pointerdown", e => {
      this.wheel.setPointerCapture(e.pointerId);
      pickHue(e);
    });
    this.wheel.addEventListener("pointermove", e => {
      if (this.wheel.hasPointerCapture(e.pointerId)) {
        pickHue(e);
      }
    });
    this.swatches = this.html(
      "div",
      { class: "hx-swatches" },
      Logic.PALETTE.map(hue =>
        this.html("button", {
          class: "hx-swatch",
          title: `${hue}°`,
          style: `background: ${Logic.swatchCSS({ hue, hue2: hue + 28 })}`,
          onclick: () => Store.update(this.editingId, { color: { hue, hue2: (hue + 28) % 360 } }),
        })
      )
    );
    this.chromaInput = this.html("input", {
      type: "range",
      min: "0",
      max: "0.1",
      step: "0.005",
      oninput: () => Store.update(this.editingId, { color: { chroma: Number(this.chromaInput.value) } }),
    });
    this.blendInput = this.html("input", {
      type: "range",
      min: "0",
      max: "120",
      step: "2",
      oninput: () => {
        const space = Store.get(this.editingId);
        Store.update(this.editingId, { color: { hue2: (space.color.hue + Number(this.blendInput.value)) % 360 } });
      },
    });
    this.grainInput = this.html("input", {
      type: "checkbox",
      onchange: () => Store.update(this.editingId, { color: { grain: this.grainInput.checked } }),
    });
    this.containerSelect = this.html("select", { onchange: () => this._onContainerChange() });
    this.deleteButton = this.html("button", {
      class: "hx-danger",
      text: STRINGS.deleteSpace,
      onclick: () => this._onDelete(),
    });

    const body = this.html("div", { class: "hx-editor" }, [
      this.html("h2", { class: "hx-title", text: STRINGS.editSpace }),
      field(STRINGS.name, this.nameInput),
      field(STRINGS.icon, this.iconInput, [this.iconChoices]),
      this.html("div", { class: "hx-field" }, [
        this.html("span", { class: "hx-label", text: STRINGS.color }),
        this.html("div", { class: "hx-color-row" }, [this.wheel, this.swatches]),
      ]),
      field(STRINGS.intensity, this.chromaInput),
      field(STRINGS.blend, this.blendInput),
      this.html("label", { class: "hx-field hx-check" }, [this.grainInput, this.html("span", { text: STRINGS.grain })]),
      field(STRINGS.container, this.containerSelect, [this.html("p", { class: "hx-hint", text: STRINGS.containerHint })]),
      this.html("div", { class: "hx-actions" }, [
        this.deleteButton,
        this.html("button", { class: "hx-primary", text: STRINGS.done, onclick: () => panel.hidePopup() }),
      ]),
    ]);
    panel.append(body);
    (this.doc.getElementById("mainPopupSet") ?? this.doc.documentElement).append(panel);
    this.panel = panel;
  }

  openEditor(spaceId, anchor) {
    const space = Store.get(spaceId);
    if (!space || !this.panel) {
      return;
    }
    this.editingId = spaceId;
    this._resetDelete();
    this._fillEditor(space);
    this.panel.openPopup(anchor, "after_start", 0, 0, false, false);
    this.win.setTimeout(() => this.nameInput.focus(), 0);
  }

  _fillEditor(space, { keepFocus = false } = {}) {
    if (!space) {
      this.panel.hidePopup();
      return;
    }
    const active = this.doc.activeElement;
    if (!(keepFocus && active == this.nameInput)) {
      this.nameInput.value = space.name;
    }
    if (!(keepFocus && active == this.iconInput)) {
      this.iconInput.value = space.icon;
    }
    this.chromaInput.value = String(space.color.chroma);
    this.blendInput.value = String((space.color.hue2 - space.color.hue + 360) % 360);
    this.grainInput.checked = space.color.grain;
    this.wheelMarker.style.transform = `rotate(${space.color.hue}deg)`;
    this.wheel.style.setProperty("--hx-current", Logic.swatchCSS(space.color));
    this.deleteButton.disabled = Store.spaces.length < 2;

    const options = [this.html("option", { value: "", text: STRINGS.noContainer })];
    let containers = [];
    try {
      containers = Store.containers();
    } catch (e) {
      // Containers unavailable (pref off).
    }
    for (const c of containers) {
      options.push(this.html("option", { value: c.name, text: c.name }));
    }
    const current = space.container?.name;
    if (current && !containers.some(c => c.name == current)) {
      options.push(this.html("option", { value: current, text: current }));
    }
    options.push(this.html("option", { value: "__new__", text: STRINGS.newContainer }));
    this.containerSelect.replaceChildren(...options);
    this.containerSelect.value = current ?? "";
  }

  _onContainerChange() {
    const value = this.containerSelect.value;
    const space = Store.get(this.editingId);
    if (value == "__new__") {
      Store.update(this.editingId, { container: { name: space.name, icon: "circle", color: "blue" } });
      Store.userContextIdFor(Store.get(this.editingId)); // create it now so it shows up
    } else if (!value) {
      Store.update(this.editingId, { container: null });
    } else {
      const c = Store.containers().find(x => x.name == value);
      Store.update(this.editingId, { container: c ? { name: c.name, icon: c.icon, color: c.color } : { name: value } });
    }
  }

  _onDelete() {
    if (!this._deleteArmed) {
      this._deleteArmed = true;
      this.deleteButton.textContent = STRINGS.confirmDelete;
      this.deleteButton.classList.add("hx-armed");
      return;
    }
    const id = this.editingId;
    this.panel.hidePopup();
    Store.delete(id);
  }

  _resetDelete() {
    this._deleteArmed = false;
    if (this.deleteButton) {
      this.deleteButton.textContent = STRINGS.deleteSpace;
      this.deleteButton.classList.remove("hx-armed");
    }
  }

  _debounced(key, fn) {
    this._timers ??= {};
    this.win.clearTimeout(this._timers[key]);
    this._timers[key] = this.win.setTimeout(fn, 150);
  }

  // ---- tab menu ----------------------------------------------------------------------------

  _createTabMenu() {
    const menu = this.doc.getElementById("tabContextMenu");
    if (!menu || this.doc.getElementById("halcyon-context-move-to-space")) {
      return;
    }
    const item = this.doc.createXULElement("menu");
    item.id = "halcyon-context-move-to-space";
    item.setAttribute("label", STRINGS.moveToSpace);
    const popup = this.doc.createXULElement("menupopup");
    item.append(popup);
    popup.addEventListener("popupshowing", e => {
      if (e.target != popup) {
        return;
      }
      const tab = this.win.TabContextMenu?.contextTab;
      const tabs = tab?.multiselected ? this.c.gBrowser.selectedTabs : tab ? [tab] : [];
      popup.replaceChildren(
        ...Store.spaces.map(s => {
          const entry = this.doc.createXULElement("menuitem");
          entry.setAttribute("label", s.icon ? `${s.icon}  ${s.name}` : s.name);
          entry.setAttribute("type", "radio");
          if (tab && this.c.spaceOf(tab) == s.id) {
            entry.setAttribute("checked", "true");
          }
          entry.addEventListener("command", () => this.c.moveTabs(tabs, s.id));
          return entry;
        })
      );
    });
    menu.addEventListener("popupshowing", e => {
      if (e.target == menu) {
        const tab = this.win.TabContextMenu?.contextTab;
        item.hidden = !tab || tab.pinned || Store.spaces.length < 2;
      }
    });
    const anchor = this.doc.getElementById("context_moveTabOptions");
    if (anchor) {
      anchor.after(item);
    } else {
      menu.append(item);
    }
  }
}
