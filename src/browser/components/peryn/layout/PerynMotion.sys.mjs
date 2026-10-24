/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Shared motion for layout changes: panes and cards glide from where they were to where they
 * end up, instead of jumping. Everything animates transform and opacity only (the compositor
 * runs those without re-laying out the page), durations and easing come from the design
 * tokens in peryn-tokens.css, and with reduced motion the tokens are 0 so nothing moves.
 *
 * FLIP: record where elements are, make the change, then animate each one from its old box to
 * its new one.
 */

const MAX_MS = 600;

/** A CSS time ("200ms", "0.2s") in milliseconds; 0 for anything unreadable. */
export function parseTime(value) {
  const match = /^\s*(-?[\d.]+)\s*(ms|s)\s*$/.exec(String(value ?? ""));
  if (!match) {
    return 0;
  }
  const ms = Number(match[1]) * (match[2] == "s" ? 1000 : 1);
  return Number.isFinite(ms) ? Math.min(MAX_MS, Math.max(0, ms)) : 0;
}

/**
 * Keyframes that move a box from `before` to where it now is (`after`), or null when there's
 * nothing to animate (no change, or a box that had no size).
 */
export function flipFrames(before, after) {
  if (!before || !after || before.width <= 0 || before.height <= 0 || after.width <= 0 || after.height <= 0) {
    return null;
  }
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  const sx = before.width / after.width;
  const sy = before.height / after.height;
  const still = Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01;
  if (still) {
    return null;
  }
  const r = n => Math.round(n * 1000) / 1000;
  return [
    { transformOrigin: "0 0", transform: `translate(${r(dx)}px, ${r(dy)}px) scale(${r(sx)}, ${r(sy)})` },
    { transformOrigin: "0 0", transform: "none" },
  ];
}

/** Keyframes for a box that wasn't on screen before: a short grow-and-fade in. */
export const ENTER_FRAMES = Object.freeze([
  { opacity: 0, transform: "scale(0.97)" },
  { opacity: 1, transform: "none" },
]);

export class Motion {
  constructor(win) {
    this.win = win;
  }

  _token(name) {
    try {
      return this.win.getComputedStyle(this.win.document.documentElement).getPropertyValue(name).trim();
    } catch {
      return "";
    }
  }

  duration(token = "--hx-duration") {
    return parseTime(this._token(token));
  }

  easing(token = "--hx-ease-out") {
    return this._token(token) || "ease-out";
  }

  _rects(elements) {
    return new Map(elements.filter(Boolean).map(el => [el, el.getBoundingClientRect()]));
  }

  /**
   * Run `change()`, then animate `elements` from their old boxes to their new ones. Elements
   * in `enter` (newly shown; a hidden panel still has a box) and elements that had no box
   * before fade in instead. Returns the animations (empty when motion is off).
   */
  flip(elements, change, { duration = this.duration(), easing = this.easing("--hx-ease-spring"), enter = [] } = {}) {
    if (!duration) {
      change();
      return [];
    }
    const before = this._rects(elements);
    change();
    const animations = [];
    for (const [el, old] of before) {
      if (!el.isConnected) {
        continue;
      }
      const now = el.getBoundingClientRect();
      const entering = enter.includes(el) || !(old.width > 0 && old.height > 0);
      const frames = entering ? (now.width > 0 ? ENTER_FRAMES : null) : flipFrames(old, now);
      if (frames) {
        animations.push(el.animate(frames, { duration, easing }));
      }
    }
    return animations;
  }

  /** Animate elements out; resolves when done (at once when motion is off). */
  async leave(elements, frames, { duration = this.duration("--hx-duration-fast"), easing = this.easing() } = {}) {
    if (!duration) {
      return;
    }
    const animations = elements.filter(Boolean).map(el => el.animate(frames, { duration, easing, fill: "forwards" }));
    await Promise.race([
      Promise.all(animations.map(a => a.finished.catch(() => {}))),
      new Promise(resolve => this.win.setTimeout(resolve, duration + 100)),
    ]);
    // Cancel so the elements don't stay faded if they're reused.
    for (const a of animations) {
      a.cancel();
    }
  }
}
