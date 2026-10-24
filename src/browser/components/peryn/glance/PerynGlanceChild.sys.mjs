/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Glance, in the page: Alt+click (Option+click on macOS) on a link asks the browser to open it
 * in a floating preview instead of following it here. Esc is passed on so a preview can close;
 * the browser ignores it for pages that aren't one, and the page still sees the key.
 */

const PREF_ENABLED = "peryn.glance.enabled";

/** The http(s) link an event happened on, if any (works inside shadow DOM). */
export function linkFromEvent(event) {
  for (const node of event.composedPath()) {
    if (node.localName == "a" || node.localName == "area") {
      const href = String(node.href ?? "");
      return /^https?:/i.test(href) ? href : null;
    }
  }
  return null;
}

export function isGlanceClick(event) {
  return (
    event.type == "click" &&
    event.button == 0 &&
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.defaultPrevented
  );
}

export class PerynGlanceChild extends JSWindowActorChild {
  receiveMessage(message) {
    // Lets the browser check that previews can be opened from this page.
    if (message.name == "Glance:Ping") {
      return { ready: true, last: this._last ?? null };
    }
    return null;
  }

  handleEvent(event) {
    // TEMPORARY (C6 diagnosis): what the last event looked like, for the preview's ping.
    this._last = { type: event.type, alt: event.altKey, button: event.button, prevented: event.defaultPrevented, link: event.type == "click" ? linkFromEvent(event) : null };
    if (event.type == "keydown") {
      if (event.key == "Escape" && !event.repeat && !event.defaultPrevented && !event.altKey) {
        this.sendAsyncMessage("Glance:Escape");
      }
      return;
    }
    if (!isGlanceClick(event) || !Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      return;
    }
    const url = linkFromEvent(event);
    if (!url) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage("Glance:Open", { url, referrer: this.document.location.href });
  }
}
