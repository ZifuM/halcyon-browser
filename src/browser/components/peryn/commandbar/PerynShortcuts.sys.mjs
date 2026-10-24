/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Custom keyboard shortcuts for the command bar's actions, one window at a time.
 *
 * The user's choices live in the `peryn.shortcuts` pref as { actionId: "accel+shift+K" }
 * (canonical form, see PerynCommandLogic). Each window turns them into a <keyset>. When a
 * shortcut is one Firefox already uses, the user is asked to confirm, and Firefox's key is
 * disabled in that window while the custom one exists; removing the shortcut gives it back.
 */

import * as Logic from "./PerynCommandLogic.sys.mjs";

const KEYSET_ID = "peryn-shortcuts-keyset";
const DISABLED_BY = "peryn-disabled-by";

export class PerynShortcuts {
  /**
   * @param {Window} win
   * @param {object} options
   * @param {boolean} options.mac
   * @param {(actionId: string) => void} options.run
   */
  constructor(win, { mac = false, run }) {
    this.win = win;
    this.doc = win.document;
    this.mac = mac;
    this.run = run;
    this._onPref = () => this.build();
  }

  init() {
    Services.prefs.addObserver(Logic.PREFS.shortcuts, this._onPref);
    this.build();
  }

  uninit() {
    Services.prefs.removeObserver(Logic.PREFS.shortcuts, this._onPref);
    this._teardown();
  }

  get user() {
    return Logic.readShortcuts(Services.prefs.getStringPref(Logic.PREFS.shortcuts, "{}"), { mac: this.mac });
  }

  get effective() {
    return Logic.effectiveShortcuts(this.user, { mac: this.mac });
  }

  /** Change one action's shortcut ("" removes it). Takes it away from any other action. */
  set(actionId, shortcut) {
    const user = this.user;
    const canonical = shortcut ? Logic.normalizeShortcut(shortcut, { mac: this.mac }) : "";
    if (canonical) {
      for (const [id, value] of Object.entries(this.effective)) {
        if (id != actionId && value == canonical) {
          user[id] = "";
        }
      }
    }
    user[actionId] = canonical;
    // An empty entry only matters when it removes a default.
    for (const [id, value] of Object.entries(user)) {
      if (value === "" && !Logic.actionById(id)?.shortcut) {
        delete user[id];
      }
    }
    Services.prefs.setStringPref(Logic.PREFS.shortcuts, JSON.stringify(user));
  }

  /** Text for an action's shortcut: the custom one, else Firefox's own, else "". */
  displayFor(action) {
    const custom = this.effective[action.id];
    if (custom) {
      return Logic.displayShortcut(custom, { mac: this.mac });
    }
    if (custom === undefined && action.key) {
      const key = this.doc.getElementById(action.key);
      if (key && key.getAttribute("disabled") != "true") {
        const shortcut = Logic.shortcutOfKey(this._attrs(key), { mac: this.mac });
        return Logic.displayShortcut(shortcut, { mac: this.mac });
      }
    }
    return "";
  }

  _attrs(key) {
    return {
      key: key.getAttribute("key"),
      keycode: key.getAttribute("keycode"),
      modifiers: key.getAttribute("modifiers"),
    };
  }

  /** Firefox's keys in this window, with their shortcuts. */
  firefoxKeys() {
    const out = [];
    for (const key of this.doc.querySelectorAll("key")) {
      if (key.closest(`#${KEYSET_ID}`) || key.hasAttribute("internal")) {
        continue;
      }
      const shortcut = Logic.shortcutOfKey(this._attrs(key), { mac: this.mac });
      if (!shortcut) {
        continue;
      }
      out.push({
        id: key.id,
        element: key,
        shortcut,
        // Disabled by one of our shortcuts still counts: it's that shortcut's to give back.
        disabled: key.getAttribute("disabled") == "true" && !key.hasAttribute(DISABLED_BY),
        label: this._labelFor(key),
      });
    }
    return out;
  }

  _labelFor(key) {
    if (key.id) {
      const item = this.doc.querySelector(`menuitem[key="${this.win.CSS.escape(key.id)}"], toolbarbutton[key="${this.win.CSS.escape(key.id)}"]`);
      const label = item?.getAttribute("label") || item?.label;
      if (label) {
        return label;
      }
      const action = Logic.ACTIONS.find(a => a.key == key.id);
      if (action) {
        return action.title;
      }
    }
    const command = key.getAttribute("command");
    return command || key.id || "Firefox";
  }

  /** What already uses `shortcut`, apart from action `exceptId` itself. */
  conflictsFor(shortcut, exceptId) {
    const own = Logic.actionById(exceptId)?.key;
    const firefox = Logic.findConflicts(
      shortcut,
      this.firefoxKeys().filter(k => k.id != own && k.element.getAttribute(DISABLED_BY) != exceptId)
    );
    const ours = Object.entries(this.effective)
      .filter(([id, value]) => id != exceptId && value == shortcut)
      .map(([id]) => ({ id, label: Logic.actionById(id).title }));
    return [...ours, ...firefox.filter(k => !k.element.hasAttribute(DISABLED_BY))];
  }

  _teardown() {
    this.doc.getElementById(KEYSET_ID)?.remove();
    for (const key of this.doc.querySelectorAll(`key[${DISABLED_BY}]`)) {
      key.removeAttribute("disabled");
      key.removeAttribute(DISABLED_BY);
    }
  }

  /** (Re)create this window's keyset from the pref. */
  build() {
    this._teardown();
    const effective = this.effective;
    if (!Object.keys(effective).length) {
      return;
    }
    const firefox = this.firefoxKeys();
    const keyset = this.doc.createXULElement("keyset");
    keyset.id = KEYSET_ID;
    for (const [actionId, shortcut] of Object.entries(effective)) {
      const parsed = Logic.parseShortcut(shortcut, { mac: this.mac });
      if (!parsed) {
        continue;
      }
      const key = this.doc.createXULElement("key");
      key.id = `peryn-shortcut-${actionId}`;
      if (parsed.key) {
        key.setAttribute("key", parsed.key);
      } else {
        key.setAttribute("keycode", parsed.keycode);
      }
      if (parsed.modifiers.length) {
        key.setAttribute("modifiers", parsed.modifiers.join(","));
      }
      key.addEventListener("command", () => this.run(actionId));
      keyset.append(key);
      for (const other of firefox) {
        if (other.shortcut == shortcut && !other.disabled) {
          other.element.setAttribute("disabled", "true");
          other.element.setAttribute(DISABLED_BY, actionId);
        }
      }
    }
    this.doc.documentElement.append(keyset);
  }
}
