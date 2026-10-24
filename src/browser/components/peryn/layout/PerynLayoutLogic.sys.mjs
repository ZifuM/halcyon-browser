/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pure logic for the window layout: pref names, the Pinned/Today section rules and compact
// mode's reveal state. No Firefox APIs, so the unit tests run it directly.

export const PREFS = Object.freeze({
  enabled: "peryn.layout.enabled",
  newTabPosition: "peryn.tabs.newTabPosition",
  compact: "peryn.layout.compact",
  hideDelayMs: "peryn.layout.compact.hideDelayMs",
});

export const DEFAULT_HIDE_DELAY_MS = 300;

/** Stylesheets, relative to the layout modules, in load order. */
export const STYLESHEETS = Object.freeze([
  "peryn-tokens.css",
  "peryn-layout.css",
  "peryn-compact.css",
  "../spaces/peryn-spaces.css",
  "../commandbar/peryn-commandbar.css",
  "../split/peryn-split.css",
]);

/** Session-store key that marks a tab as pinned to the sidebar (not an Essential). */
export const PINNED_TAB_VALUE = "peryn-pinned";
/** Attribute on pinned-to-sidebar tabs (styling + ordering). */
export const PINNED_ATTR = "peryn-pinned";

// ---- Pinned / Today sections --------------------------------------------------------------
//
// Order in the sidebar: Essentials (Firefox pinned tabs, their own container), then Pinned,
// then "+ New Tab", then Today. Pinned tabs are always the first standalone tabs after the
// Essentials. Tabs in a tab group or split view are always Today.

/**
 * Whether a tab belongs in the Pinned section after the user moved it. Dropping a tab
 * among pinned tabs pins it; dropping a pinned tab among Today tabs unpins it; dropping on the
 * boundary keeps it as it was.
 *
 * @param {object} args
 * @param {boolean} args.wasPinned  the tab's section before the move
 * @param {boolean|null} args.prevPinned  the section of the standalone tab now before it
 *   (null: no tab before it, i.e. it's first after the Essentials)
 * @param {boolean|null} args.nextPinned  same for the tab now after it (null: it's last)
 */
export function pinnedAfterMove({ wasPinned, prevPinned, nextPinned }) {
  if (wasPinned) {
    // Now after a Today tab: moved into Today.
    return prevPinned !== false;
  }
  // Now before a pinned tab: moved into Pinned.
  return nextPinned === true;
}

/**
 * Where a newly opened tab goes: "after-pinned" moves it to the top of Today, null leaves it
 * where Firefox put it.
 *
 * With `position` "top" (the default, as in Arc) every new tab opens at the top of Today, right
 * under "+ New Tab". With "firefox", Firefox's placement is kept, except that a tab never lands
 * inside Pinned (Firefox opens a link right after the tab it came from, which for a pinned tab
 * is inside Pinned). Restored tabs and tabs opened into a group or split view are left alone.
 */
export function placementForNewTab({ restoring, grouped, prevPinned, nextPinned, position = "top" }) {
  if (restoring || grouped) {
    return null;
  }
  if (position == "top" || prevPinned === true || nextPinned === true) {
    return "after-pinned";
  }
  return null;
}

/** Whether "Pin to sidebar" applies to a tab. */
export function canPinToSidebar(tab) {
  return !tab.pinned && !tab.group && !tab.splitview;
}

// ---- Compact mode -------------------------------------------------------------------------

/** Parts of the chrome compact mode can hide. */
export const CHROME_PARTS = Object.freeze(["sidebar", "toolbar"]);

/**
 * Tracks why each part of the chrome is revealed in compact mode. A part shows while it has
 * at least one reason (pointer over it or its edge, keyboard focus inside it, a menu or panel
 * opened from it, a shortcut). Losing the last reason hides it after a short delay, so moving
 * the pointer across a gap doesn't make it flicker; gaining one shows it at once.
 */
export class RevealState {
  /**
   * @param {object} options
   * @param {(revealed: Set<string>) => void} options.onChange called with the parts now shown
   * @param {number} [options.hideDelayMs]
   * @param {Function} [options.setTimeout]
   * @param {Function} [options.clearTimeout]
   */
  constructor({
    onChange,
    hideDelayMs = DEFAULT_HIDE_DELAY_MS,
    setTimeout = globalThis.setTimeout,
    clearTimeout = globalThis.clearTimeout,
  }) {
    this.onChange = onChange;
    this.hideDelayMs = hideDelayMs;
    this._setTimeout = setTimeout;
    this._clearTimeout = clearTimeout;
    this.reasons = new Map(CHROME_PARTS.map(p => [p, new Set()]));
    this.revealed = new Set();
    this.timers = new Map();
  }

  add(part, reason) {
    this._check(part);
    this.reasons.get(part).add(reason);
    this._cancelHide(part);
    if (!this.revealed.has(part)) {
      this.revealed.add(part);
      this._notify();
    }
  }

  remove(part, reason) {
    this._check(part);
    const reasons = this.reasons.get(part);
    if (!reasons.delete(reason) || reasons.size) {
      return;
    }
    this._cancelHide(part);
    this.timers.set(
      part,
      this._setTimeout(() => {
        this.timers.delete(part);
        if (!this.reasons.get(part).size && this.revealed.delete(part)) {
          this._notify();
        }
      }, this.hideDelayMs)
    );
  }

  /** Hide everything now (compact mode turned off, or Escape). */
  reset() {
    for (const part of CHROME_PARTS) {
      this.reasons.get(part).clear();
      this._cancelHide(part);
    }
    if (this.revealed.size) {
      this.revealed.clear();
      this._notify();
    }
  }

  has(part) {
    return this.revealed.has(part);
  }

  _cancelHide(part) {
    const timer = this.timers.get(part);
    if (timer !== undefined) {
      this._clearTimeout(timer);
      this.timers.delete(part);
    }
  }

  _check(part) {
    if (!this.reasons.has(part)) {
      throw new Error(`unknown chrome part: ${part}`);
    }
  }

  _notify() {
    this.onChange(new Set(this.revealed));
  }
}

/** The value of the root `peryn-reveal` attribute for a set of revealed parts. */
export function revealAttribute(revealed) {
  return CHROME_PARTS.filter(p => revealed.has(p)).join(" ");
}
