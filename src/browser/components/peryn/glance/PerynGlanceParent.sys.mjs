/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/** Glance, in the browser: hands a page's request to that window's Glance controller. */

export class PerynGlanceParent extends JSWindowActorParent {
  receiveMessage(message) {
    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.ownerGlobal;
    const glance = win?.PerynGlance;
    if (!glance) {
      return;
    }
    switch (message.name) {
      case "Glance:Open":
        glance.open(message.data.url, {
          fromBrowser: browser,
          triggeringPrincipal: this.manager.documentPrincipal,
          referrer: message.data.referrer,
        });
        break;
      case "Glance:Escape":
        glance.closeFor(browser);
        break;
    }
  }
}
