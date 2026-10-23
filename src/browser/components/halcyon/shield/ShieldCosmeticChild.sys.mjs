/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Content side of Shield's element hiding. Runs in every http(s) frame; never exposes anything
// to the page (the sheets are user-level and the observer lives in this privileged scope).
// See ShieldCosmeticLogic for the overall flow.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ShieldCosmeticLogic: "moz-src:///browser/components/halcyon/shield/ShieldCosmeticLogic.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/** Batch DOM changes for this long before a generic lookup. */
const MUTATION_DELAY_MS = 150;

export class ShieldCosmeticChild extends JSWindowActorChild {
  constructor() {
    super();
    this._doc = null;
    this._exceptions = [];
    this._generic = false;
    this._collector = null;
    this._observer = null;
    this._timer = null;
    this._querying = false;
  }

  handleEvent(event) {
    const doc = this.document;
    // Events from other documents in this frame's tree belong to their own actors.
    if (!doc || event.target != doc) {
      return;
    }
    switch (event.type) {
      case "DOMDocElementInserted":
        this._start(doc);
        break;
      case "DOMContentLoaded":
        this._startGeneric(doc);
        break;
    }
  }

  didDestroy() {
    this._stop();
  }

  _loadSheet(css) {
    if (!css) {
      return;
    }
    const win = this.contentWindow;
    if (!win) {
      return;
    }
    try {
      const utils = win.windowUtils;
      utils.loadSheetUsingURIString(
        lazy.ShieldCosmeticLogic.stylesheetDataURI(css),
        utils.USER_SHEET
      );
    } catch (e) {
      // The document went away.
    }
  }

  async _start(doc) {
    this._stop();
    this._doc = doc;
    let site;
    try {
      site = await this.sendQuery("ShieldCosmetic:Site", { url: doc.documentURI });
    } catch (e) {
      return; // Actor destroyed (navigation).
    }
    if (!site || this._doc != doc) {
      return;
    }
    this._loadSheet(site.css);
    this._exceptions = site.exceptions;
    this._generic = !site.generichide;
    if (this._generic && doc.readyState != "loading") {
      this._startGeneric(doc);
    }
  }

  _startGeneric(doc) {
    if (!this._generic || this._doc != doc || this._collector) {
      return;
    }
    this._collector = new lazy.ShieldCosmeticLogic.TokenCollector();
    for (const el of doc.querySelectorAll("[id],[class]")) {
      this._collector.addElement(el);
    }
    this._flush();

    const win = doc.defaultView;
    if (!win || !doc.documentElement) {
      return;
    }
    this._observer = new win.MutationObserver(records => this._onMutations(records));
    this._observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "id"],
    });
  }

  _onMutations(records) {
    const collector = this._collector;
    if (!collector) {
      return;
    }
    for (const record of records) {
      if (record.type == "attributes") {
        collector.addElement(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType != 1) {
          continue;
        }
        collector.addElement(node);
        if (node.firstElementChild) {
          for (const el of node.querySelectorAll("[id],[class]")) {
            collector.addElement(el);
          }
        }
      }
    }
    if (collector.full) {
      this._observer?.disconnect();
      this._observer = null;
    }
    if (collector.hasPending && !this._timer) {
      this._timer = lazy.setTimeout(() => {
        this._timer = null;
        this._flush();
      }, MUTATION_DELAY_MS);
    }
  }

  async _flush() {
    const collector = this._collector;
    if (!collector || this._querying || !collector.hasPending) {
      return;
    }
    const doc = this._doc;
    this._querying = true;
    try {
      while (collector.hasPending && this._doc == doc) {
        const { classes, ids } = collector.take();
        const css = await this.sendQuery("ShieldCosmetic:Generic", {
          classes,
          ids,
          exceptions: this._exceptions,
        });
        if (this._doc == doc) {
          this._loadSheet(css);
        }
      }
    } catch (e) {
      // Actor destroyed.
    } finally {
      this._querying = false;
    }
  }

  _stop() {
    this._observer?.disconnect();
    this._observer = null;
    if (this._timer) {
      lazy.clearTimeout(this._timer);
      this._timer = null;
    }
    this._collector = null;
    this._doc = null;
    this._exceptions = [];
    this._generic = false;
  }
}
