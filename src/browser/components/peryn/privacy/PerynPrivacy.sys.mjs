/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The privacy page: a sheet over the page area with the Ledger, what was blocked on which
 * sites, every connection the browser can make, the protection level, this site's
 * permissions, and clearing data. One controller per window; the command bar opens it
 * (Privacy Ledger, Privacy and Security, Site Settings, Clear Browsing Data).
 */

import * as Logic from "./PerynPrivacyLogic.sys.mjs";
import { PerynLedger } from "./PerynLedger.sys.mjs";
import { REQUESTS } from "./PerynRequests.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentBlockingAllowList: "resource://gre/modules/ContentBlockingAllowList.sys.mjs",
  Sanitizer: "resource:///modules/Sanitizer.sys.mjs",
  SiteDataManager: "resource:///modules/SiteDataManager.sys.mjs",
  SitePermissions: "resource:///modules/SitePermissions.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PUBLIC_LIST = "https://github.com/ZifuM/halcyon-browser/blob/main/docs/EVERY-REQUEST.md";

export const STRINGS = Object.freeze({
  title: "Privacy",
  close: "Close (Esc)",
  range: { 1: "Today", 7: "7 days", 30: "30 days" },
  export: "Export Ledger…",
  clearLedger: "Clear Ledger",
  live: "Just now",
  unlistedTitle: "Not on the list",
  unlistedNote: "Every connection the browser makes on its own should be on the list below. These aren't. Please report them.",
  addonsTitle: "Made by add-ons",
  noSite: "Open a website to see its settings.",
  protectionOff: "Protection is off for this site",
  protectionOn: "Protection is on for this site",
  turnOff: "Turn off protection here",
  turnOn: "Turn protection back on",
  clearSite: "Clear cookies and data for this site",
  clearNow: "Clear",
  cleared: "Cleared.",
  exceptions: "Sites where protection is off",
  noExceptions: "None. Turn protection off for a site from the shield in the address bar, or from This site.",
  remove: "Remove",
  firefoxSettings: "All of Firefox's privacy settings…",
});

export class PerynPrivacy {
  constructor(win, parts = {}) {
    this.win = win;
    this.doc = win.document;
    this.gBrowser = win.gBrowser;
    this.parts = parts;
    this.section = "overview";
    this.days = 7;
    this.handleKey = this.handleKey.bind(this);
  }

  init() {
    PerynLedger.init();
  }

  uninit() {
    this._unsubscribe?.();
    this.root?.remove();
  }

  get isOpen() {
    return !!this.root && !this.root.hidden;
  }

  open(section = "overview") {
    if (!this.root) {
      this._build();
    }
    this.root.hidden = false;
    this.win.addEventListener("keydown", this.handleKey, true);
    this._unsubscribe ??= PerynLedger.subscribe(() => this._scheduleRefresh());
    this.show(section);
  }

  close() {
    if (this.root) {
      this.root.hidden = true;
    }
    this.win.removeEventListener("keydown", this.handleKey, true);
    this._unsubscribe?.();
    this._unsubscribe = null;
  }

  handleKey(event) {
    if (event.key == "Escape" && this.isOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  show(section) {
    this.section = Logic.SECTIONS.some(s => s.id == section) ? section : "overview";
    for (const button of this.root.querySelectorAll(".peryn-pv-nav button")) {
      button.setAttribute("aria-current", String(button.dataset.section == this.section));
    }
    this.render({ toTop: true });
  }

  _scheduleRefresh() {
    if (!this.isOpen || this._refreshTimer || !["overview", "ledger", "blocked", "every"].includes(this.section)) {
      return;
    }
    this._refreshTimer = this.win.setTimeout(() => {
      this._refreshTimer = null;
      this.render();
    }, 500);
  }

  render({ toTop = false } = {}) {
    const body = this.root.querySelector(".peryn-pv-body");
    const scroll = body.scrollTop;
    body.replaceChildren(...this[`_render_${this.section}`]());
    body.scrollTop = toTop ? 0 : scroll;
  }

  // ---- building blocks ---------------------------------------------------------------------

  _el(tag, attrs = {}, children = []) {
    const el = this.doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v == "function") {
        el.addEventListener(k, v);
      } else if (k == "text") {
        el.textContent = v;
      } else if (v !== null && v !== undefined && v !== false) {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children.filter(c => c !== null && c !== undefined && c !== false));
    return el;
  }

  _h(text, level = 2) {
    return this._el(`h${level}`, { text });
  }

  _p(text, cls = "") {
    return this._el("p", { class: cls || null, text });
  }

  _rangePicker() {
    return this._el(
      "div",
      { class: "peryn-pv-range", role: "group", "aria-label": "Time range" },
      [1, 7, 30].map(d =>
        this._el("button", {
          text: STRINGS.range[d],
          "aria-pressed": String(this.days == d),
          click: () => {
            this.days = d;
            this.render();
          },
        })
      )
    );
  }

  _build() {
    const e = (...a) => this._el(...a);
    this.root = e("div", { id: "peryn-privacy", hidden: true, role: "dialog", "aria-modal": "true", "aria-label": STRINGS.title }, [
      e("div", { class: "peryn-pv-backdrop", mousedown: () => this.close() }),
      e("div", { class: "peryn-pv-sheet" }, [
        e("nav", { class: "peryn-pv-nav", "aria-label": STRINGS.title }, [
          e("h1", { text: STRINGS.title }),
          ...Logic.SECTIONS.map(s => e("button", { "data-section": s.id, text: s.label, click: () => this.show(s.id) })),
        ]),
        e("div", { class: "peryn-pv-body", tabindex: "-1" }),
        e("button", { class: "peryn-pv-close", title: STRINGS.close, "aria-label": STRINGS.close, click: () => this.close() }),
      ]),
    ]);
    this.doc.getElementById("tabbrowser-tabbox").append(this.root);
  }

  // ---- sections ----------------------------------------------------------------------------

  _render_overview() {
    const summary = PerynLedger.summary({ days: this.days });
    const preset = Logic.presetFor(Services.prefs.getStringPref(Logic.PRESET_PREF, "custom"));
    const kinds = Object.entries(summary.blockedTotal).sort((a, b) => b[1] - a[1]);
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Overview"), this._rangePicker()]),
      ...Logic.overviewLines(summary).map((line, i) => this._p(line, i == 0 ? "peryn-pv-lead" : "")),
      kinds.length
        ? this._el(
            "ul",
            { class: "peryn-pv-kinds" },
            kinds.map(([kind, n]) =>
              this._el("li", {}, [this._el("strong", { text: Logic.formatCount(n) }), this._el("span", { text: ` ${kindLabel(kind)}` })])
            )
          )
        : null,
      this._el("p", { class: "peryn-pv-muted" }, [`Protection: ${preset.title} (${preset.note}). `, this._link("Change", () => this.show("protection"))]),
      summary.topSites.length ? this._h("Most blocked", 3) : null,
      summary.topSites.length ? this._siteList(summary.topSites.slice(0, 5)) : null,
      this._p("The Ledger is kept only on this computer, for 30 days. Nothing in it is ever sent anywhere.", "peryn-pv-muted"),
    ];
  }

  _render_ledger() {
    const summary = PerynLedger.summary({ days: this.days });
    const seen = summary.connections.filter(c => c.seen > 0).sort((a, b) => b.last - a.last);
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Ledger"), this._rangePicker()]),
      this._p("Every connection the browser made by itself, and what it was for. Pages you visit aren't listed; this is the browser's own traffic.", "peryn-pv-muted"),
      summary.unknown.length
        ? this._el("section", { class: "peryn-pv-warn" }, [
            this._h(STRINGS.unlistedTitle, 3),
            this._p(STRINGS.unlistedNote),
            this._el("ul", {}, summary.unknown.map(u => this._el("li", { text: `${u.host} — ${Logic.formatCount(u.count)}×, ${Logic.ago(u.last)}` }))),
          ])
        : null,
      seen.length
        ? this._el(
            "ul",
            { class: "peryn-pv-entries" },
            seen.map(c =>
              this._el("li", {}, [
                this._el("div", { class: "peryn-pv-entry-head" }, [
                  this._el("strong", { text: c.name }),
                  this._el("span", { class: "peryn-pv-count", text: `${Logic.formatCount(c.seen)}× · ${Logic.ago(c.last)}` }),
                ]),
                this._p(c.purpose ?? "", "peryn-pv-muted"),
                this._el("code", { text: c.seenHosts.join(", ") }),
              ])
            )
          )
        : this._p("No connections yet in this range."),
      summary.addons.length ? this._h(STRINGS.addonsTitle, 3) : null,
      summary.addons.length
        ? this._el("ul", { class: "peryn-pv-entries" }, summary.addons.map(a => this._el("li", {}, [this._el("strong", { text: a.addon ?? "Unknown add-on" }), this._el("code", { text: a.hosts.join(", ") })])))
        : null,
      this._el("div", { class: "peryn-pv-actions" }, [
        this._el("button", { text: STRINGS.export, click: () => this.exportLedger() }),
        this._el("button", { class: "peryn-pv-quiet", text: STRINGS.clearLedger, click: () => this.clearLedger() }),
      ]),
    ];
  }

  _render_blocked() {
    const summary = PerynLedger.summary({ days: this.days });
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Blocked on sites"), this._rangePicker()]),
      this._p("Trackers blocked on each site you visited. Kept only while history is on; cleared with history; never kept for private windows.", "peryn-pv-muted"),
      summary.topSites.length ? this._siteList(summary.topSites) : this._p("Nothing blocked in this range."),
    ];
  }

  _siteList(sites) {
    return this._el(
      "ul",
      { class: "peryn-pv-sites" },
      sites.map(s =>
        this._el("li", {}, [
          this._el("strong", { text: s.site }),
          this._el("span", { class: "peryn-pv-count", text: Logic.formatCount(s.total) }),
          this._el("span", { class: "peryn-pv-muted", text: Object.entries(s.kinds).map(([k, n]) => `${n} ${kindLabel(k).toLowerCase()}`).join(", ") }),
        ])
      )
    );
  }

  _render_every() {
    const summary = PerynLedger.summary({ days: 30 });
    const seen = new Map(summary.connections.map(c => [c.id, c]));
    const group = (title, list) => [
      this._h(title, 3),
      this._el(
        "ul",
        { class: "peryn-pv-entries" },
        list.map(r =>
          this._el("li", { "data-state": r.state }, [
            this._el("div", { class: "peryn-pv-entry-head" }, [
              this._el("strong", { text: r.name }),
              this._el("span", { class: "peryn-pv-count", text: seen.get(r.id)?.seen ? `seen ${Logic.formatCount(seen.get(r.id).seen)}× in 30 days` : "not seen in 30 days" }),
            ]),
            this._p(r.purpose, "peryn-pv-muted"),
            r.hosts.length ? this._el("code", { text: r.hosts.join(", ") }) : null,
            this._p(`${r.state == "on" ? "Turn off" : "Turn back on"}: ${r.switch}`, "peryn-pv-switch"),
          ])
        )
      ),
    ];
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Every connection")]),
      this._el("p", { class: "peryn-pv-muted" }, [
        "The complete list of connections the browser can open without you going somewhere. The build fails if it ever connects anywhere not on this list. ",
        this._link("The same list online", () => this._openTab(PUBLIC_LIST)),
      ]),
      ...group("On, may happen in the background", REQUESTS.filter(r => r.state == "on" && r.trigger == "background")),
      ...group("Only after you do something", REQUESTS.filter(r => r.state == "on" && r.trigger == "user")),
      ...group("Turned off", REQUESTS.filter(r => r.state == "off")),
    ];
  }

  _render_protection() {
    const current = Services.prefs.getStringPref(Logic.PRESET_PREF, "custom");
    const presets = ["strict", "standard"].map(id => Logic.PRESETS[id]);
    const exceptions = this._exceptions();
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Protection")]),
      this._p("Ads are blocked at every level. The level decides how strictly trackers are.", "peryn-pv-muted"),
      this._el(
        "div",
        { class: "peryn-pv-presets", role: "radiogroup" },
        [...presets, ...(current == "custom" ? [Logic.PRESETS.custom] : [])].map(p =>
          this._el(
            "button",
            {
              class: "peryn-pv-preset",
              role: "radio",
              "aria-checked": String(current == p.category),
              disabled: p.category == "custom",
              click: () => {
                Services.prefs.setStringPref(Logic.PRESET_PREF, p.category);
                this.render();
              },
            },
            [
              this._el("span", { class: "peryn-pv-preset-title", text: p.title }),
              this._el("span", { class: "peryn-pv-muted", text: p.note }),
              this._el("span", { class: "peryn-pv-label", text: "Changes" }),
              this._el("ul", {}, p.changes.map(t => this._el("li", { text: t }))),
              this._el("span", { class: "peryn-pv-label", text: "May break" }),
              this._el("ul", {}, p.breaks.map(t => this._el("li", { text: t }))),
            ]
          )
        )
      ),
      this._h(STRINGS.exceptions, 3),
      exceptions.length
        ? this._el(
            "ul",
            { class: "peryn-pv-sites" },
            exceptions.map(ex =>
              this._el("li", {}, [
                this._el("strong", { text: ex.host }),
                this._el("button", {
                  class: "peryn-pv-quiet",
                  text: STRINGS.remove,
                  click: () => {
                    Services.perms.removeFromPrincipal(ex.principal, ex.type);
                    this.render();
                  },
                }),
              ])
            )
          )
        : this._p(STRINGS.noExceptions, "peryn-pv-muted"),
      this._el("p", {}, [this._link(STRINGS.firefoxSettings, () => this.win.openPreferences("privacy-trackingprotection"))]),
    ];
  }

  _exceptions() {
    const out = [];
    try {
      for (const perm of Services.perms.getAllByTypes(["trackingprotection", "trackingprotection-pb"])) {
        out.push({ host: perm.principal.host || perm.principal.origin, principal: perm.principal, type: perm.type });
      }
    } catch {}
    return out.sort((a, b) => a.host.localeCompare(b.host));
  }

  _render_site() {
    const browser = this.gBrowser.selectedBrowser;
    const principal = browser.contentPrincipal;
    const SP = lazy.SitePermissions;
    let supported = false;
    try {
      supported = SP.isSupportedPrincipal(principal);
    } catch {}
    if (!supported) {
      return [this._el("header", { class: "peryn-pv-head" }, [this._h("This site")]), this._p(STRINGS.noSite)];
    }
    const host = principal.host;
    const states = new Map(SP.getAllByPrincipal(principal).map(p => [p.id, p.state]));
    const ids = Logic.orderPermissions(SP.listPermissions().filter(id => SP.getPermissionLabel(id)));
    const protectedHere = !lazy.ContentBlockingAllowList.includes(browser);
    const rows = ids.map(id => {
      const current = states.get(id) ?? SP.UNKNOWN;
      const options = SP.getAvailableStates(id);
      return this._el("li", {}, [
        this._el("label", { for: `peryn-pv-perm-${id}`, text: SP.getPermissionLabel(id) }),
        this._el(
          "select",
          {
            id: `peryn-pv-perm-${id}`,
            "data-permission": id,
            change: event => {
              const state = Number(event.target.value);
              if (state == SP.UNKNOWN) {
                SP.removeFromPrincipal(principal, id, browser);
              } else {
                SP.setForPrincipal(principal, id, state);
              }
            },
          },
          options.map(state => {
            const option = this._el("option", { value: String(state), text: SP.getMultichoiceStateLabel(id, state) });
            option.selected = state == current;
            return option;
          })
        ),
      ]);
    });
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h(host)]),
      this._el("div", { class: "peryn-pv-site-protection", "data-on": String(protectedHere) }, [
        this._el("strong", { text: protectedHere ? STRINGS.protectionOn : STRINGS.protectionOff }),
        this._el("button", {
          text: protectedHere ? STRINGS.turnOff : STRINGS.turnOn,
          click: () => {
            if (protectedHere) {
              lazy.ContentBlockingAllowList.add(browser);
            } else {
              lazy.ContentBlockingAllowList.remove(browser);
            }
            browser.reload();
            this.render();
          },
        }),
      ]),
      this._el("ul", { class: "peryn-pv-perms" }, rows),
      this._el("div", { class: "peryn-pv-actions" }, [
        this._el("button", {
          class: "peryn-pv-quiet",
          text: STRINGS.clearSite,
          click: async event => {
            event.target.disabled = true;
            try {
              await lazy.SiteDataManager.remove(host);
              event.target.textContent = STRINGS.cleared;
            } catch (e) {
              console.error("Peryn privacy: clearing site data failed", e);
              event.target.disabled = false;
            }
          },
        }),
      ]),
    ];
  }

  _render_clear() {
    let range = "hour";
    const boxes = Logic.CLEAR_ITEMS.map(item => {
      const box = this._el("input", { type: "checkbox", id: `peryn-pv-clear-${item.id}`, "data-item": item.id });
      box.checked = item.checked;
      return this._el("li", {}, [box, this._el("label", { for: box.id }, [this._el("span", { text: item.label }), item.note ? this._el("span", { class: "peryn-pv-muted", text: item.note }) : null])]);
    });
    const status = this._el("p", { class: "peryn-pv-muted", role: "status" });
    return [
      this._el("header", { class: "peryn-pv-head" }, [this._h("Clear data")]),
      this._el(
        "div",
        { class: "peryn-pv-range", role: "radiogroup", "aria-label": "Time range" },
        Logic.RANGES.map(r =>
          this._el("button", {
            text: r.label,
            "data-range": r.id,
            "aria-pressed": String(r.id == range),
            click: event => {
              range = r.id;
              for (const b of event.target.parentNode.children) {
                b.setAttribute("aria-pressed", String(b.dataset.range == range));
              }
            },
          })
        )
      ),
      this._el("ul", { class: "peryn-pv-checks" }, boxes),
      this._el("div", { class: "peryn-pv-actions" }, [
        this._el("button", {
          class: "peryn-pv-danger",
          text: STRINGS.clearNow,
          click: async () => {
            const items = boxes.map(li => li.querySelector("input")).filter(b => b.checked).map(b => b.dataset.item);
            status.textContent = await this.clearData(items, range);
          },
        }),
      ]),
      status,
    ];
  }

  // ---- actions -----------------------------------------------------------------------------

  /** Clear data of the given kinds over a range; returns what to say. */
  async clearData(items, rangeId) {
    if (!items.length) {
      return "Choose something to clear.";
    }
    const range = Logic.RANGES.find(r => r.id == rangeId) ?? Logic.RANGES[0];
    try {
      const S = lazy.Sanitizer;
      const options = range.timespan == 0 ? { ignoreTimespan: true } : { ignoreTimespan: false, range: S.getClearRange(range.timespan) };
      await S.sanitize(items, options);
      return `Cleared: ${items.map(id => Logic.CLEAR_ITEMS.find(i => i.id == id)?.label.toLowerCase()).join(", ")} (${range.label.toLowerCase()}).`;
    } catch (e) {
      console.error("Peryn privacy: clearing data failed", e);
      return "Couldn't clear everything. Try again, or use Firefox's settings.";
    }
  }

  async exportLedger() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
    picker.init(this.win.browsingContext, STRINGS.export, Ci.nsIFilePicker.modeSave);
    picker.defaultString = `peryn-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    const result = await new Promise(resolve => picker.open(resolve));
    if (result == Ci.nsIFilePicker.returnCancel || !picker.file) {
      return null;
    }
    await IOUtils.writeUTF8(picker.file.path, PerynLedger.exportText());
    return picker.file.path;
  }

  clearLedger() {
    PerynLedger.clear();
    this.render();
  }

  _link(text, run) {
    return this._el("button", { class: "peryn-pv-link", text, click: run });
  }

  _openTab(url) {
    this.gBrowser.selectedTab = this.gBrowser.addTrustedTab(url, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    this.close();
  }
}

function kindLabel(kind) {
  return {
    tracker: "Trackers and ads",
    social: "Social media trackers",
    fingerprinter: "Fingerprinters",
    cryptominer: "Cryptominers",
    cookie: "Tracking cookies",
    ads: "Ads",
  }[kind] ?? kind;
}
