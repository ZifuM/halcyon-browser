/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The command bar: a box in the middle of the window that opens on Ctrl/Cmd+T (new tab) and
 * Ctrl/Cmd+L (go somewhere from this tab), and searches open tabs in every Space, bookmarks,
 * history and actions as you type. It also hosts the keyboard-shortcut editor.
 *
 * One per window. Firefox's own new-tab and address-bar keys are pointed at it (and pointed
 * back when it's turned off), so menus, buttons and the address bar itself still work as usual.
 */

import * as Logic from "./HalcyonCommandLogic.sys.mjs";
import { HalcyonCommandIndex } from "./HalcyonCommandIndex.sys.mjs";
import { HalcyonShortcuts } from "./HalcyonShortcuts.sys.mjs";
import { HalcyonSpacesStore as Store } from "../spaces/HalcyonSpacesStore.sys.mjs";

const { KIND } = Logic;
const HTML_NS = "http://www.w3.org/1999/xhtml";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

export const STRINGS = Object.freeze({
  label: "Command bar",
  placeholderNewTab: "Search or enter address",
  placeholderAddress: "Go to…",
  placeholderShortcuts: "Find an action",
  search: "Search",
  searchWith: engine => `Search with ${engine}`,
  open: "Open",
  switchToTab: "Switch to Tab",
  inSpace: name => `in ${name}`,
  bookmark: "Bookmark",
  history: "History",
  action: "Action",
  space: "Space",
  footerOpen: "Open",
  footerOther: "Open in new tab",
  footerOtherCurrent: "Open here",
  footerFilter: "Filter",
  footerClose: "Close",
  noResults: "No matches",
  shortcutsTitle: "Keyboard Shortcuts",
  shortcutsHint: "Enter to change · Backspace to remove · Esc to go back",
  pressKeys: "Press the new shortcut…",
  replaces: label => `Replaces “${label}”. Press it again to confirm.`,
  none: "None",
});

/** Where Firefox's keys normally point, so they can be restored. */
const RETARGET = Object.freeze([
  { keyId: "key_newNavigatorTab", pref: Logic.PREFS.onNewTab, mode: "newtab" },
  { keyId: "focusURLBar", pref: Logic.PREFS.onAddressKey, mode: "address" },
  { keyId: "focusURLBar2", pref: Logic.PREFS.onAddressKey, mode: "address" },
]);
const ORIGINAL_COMMAND = "halcyon-original-command";

export class HalcyonCommandBar {
  /**
   * @param {Window} win
   * @param {object} [parts] the window's other controllers ({spaces, sections, compact})
   */
  constructor(win, parts = {}) {
    this.win = win;
    this.doc = win.document;
    this.parts = parts;
    this.mac = lazy.AppConstants.platform == "macosx";
    this.mode = null;
    this.rows = [];
    this.selected = 0;
    this.filter = null;
    this._frame = 0;
    this._onPref = () => this._applyPrefs();
    this._onKeyCommand = event => this._keyCommand(event);
    this.shortcuts = new HalcyonShortcuts(win, { mac: this.mac, run: id => this.runAction(id) });
  }

  get enabled() {
    return Services.prefs.getBoolPref(Logic.PREFS.enabled, true);
  }

  init() {
    this._build();
    this._applyPrefs();
    Services.prefs.addObserver("halcyon.commandbar.", this._onPref);
    this.shortcuts.init();
    // Start loading the index in the background (the first window does the work).
    this.win.setTimeout(() => HalcyonCommandIndex.ready().catch(console.error), 0);
  }

  uninit() {
    Services.prefs.removeObserver("halcyon.commandbar.", this._onPref);
    this._retarget(false);
    this.shortcuts.uninit();
    this.root?.remove();
  }

  // ---- Firefox's keys ----------------------------------------------------------------------

  _applyPrefs() {
    this._retarget(this.enabled);
    if (!this.enabled && this.isOpen) {
      this.close();
    }
  }

  /** Point (or point back) Firefox's new-tab and address keys. */
  _retarget(on) {
    for (const { keyId, pref, mode } of RETARGET) {
      const key = this.doc.getElementById(keyId);
      if (!key) {
        continue;
      }
      const want = on && Services.prefs.getBoolPref(pref, true);
      const taken = key.hasAttribute(ORIGINAL_COMMAND);
      if (want && !taken) {
        key.setAttribute(ORIGINAL_COMMAND, key.getAttribute("command") ?? "");
        // Without a `command`, the key fires its own command event, which we handle.
        key.removeAttribute("command");
        key.setAttribute("halcyon-mode", mode);
        key.addEventListener("command", this._onKeyCommand);
      } else if (!want && taken) {
        const original = key.getAttribute(ORIGINAL_COMMAND);
        if (original) {
          key.setAttribute("command", original);
        }
        key.removeAttribute(ORIGINAL_COMMAND);
        key.removeAttribute("halcyon-mode");
        key.removeEventListener("command", this._onKeyCommand);
      }
    }
  }

  _keyCommand(event) {
    const mode = event.currentTarget.getAttribute("halcyon-mode");
    if (this.isOpen && this.mode == mode) {
      // Pressing it again while open: the input keeps focus, select what's typed.
      this.input.select();
      return;
    }
    this.open(mode);
  }

  // ---- DOM ---------------------------------------------------------------------------------

  html(tag, attrs = {}, children = []) {
    const el = this.doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith("on")) {
        el.addEventListener(k.slice(2), v);
      } else if (v !== null && v !== undefined && v !== false) {
        el.setAttribute(k, v === true ? "" : v);
      }
    }
    el.append(...children);
    return el;
  }

  _build() {
    this.input = this.html("input", {
      class: "hx-cb-input",
      type: "text",
      role: "combobox",
      "aria-autocomplete": "list",
      "aria-expanded": "true",
      "aria-controls": "halcyon-commandbar-results",
      spellcheck: "false",
      oninput: () => this._scheduleUpdate(),
      onkeydown: e => this._onKeyDown(e),
    });
    this.chip = this.html("span", { class: "hx-cb-chip", hidden: true });
    this.list = this.html("div", {
      id: "halcyon-commandbar-results",
      class: "hx-cb-results",
      role: "listbox",
      "aria-label": STRINGS.label,
    });
    this.footer = this.html("div", { class: "hx-cb-footer" });
    this.panel = this.html("div", { class: "hx-cb-panel", role: "dialog", "aria-label": STRINGS.label }, [
      this.html("div", { class: "hx-cb-input-row" }, [this.html("span", { class: "hx-cb-glass" }), this.chip, this.input]),
      this.list,
      this.footer,
    ]);
    this.root = this.html("div", { id: "halcyon-commandbar", hidden: true }, [
      this.html("div", { class: "hx-cb-backdrop", onmousedown: () => this.close() }),
      this.panel,
    ]);
    this.input.addEventListener("blur", () => {
      // Clicking a row keeps focus (rows don't take it); anything else closes the bar.
      this.win.setTimeout(() => {
        if (this.isOpen && !this.root.contains(this.doc.activeElement) && !this._recording) {
          this.close({ restoreFocus: false });
        }
      }, 0);
    });
    (this.doc.body ?? this.doc.documentElement).append(this.root);
  }

  get isOpen() {
    return !!this.root && !this.root.hidden;
  }

  // ---- opening and closing -----------------------------------------------------------------

  /**
   * @param {"newtab"|"address"|"shortcuts"} mode
   */
  async open(mode = "newtab") {
    if (!this.enabled && mode != "shortcuts") {
      return;
    }
    this.mode = mode;
    this.filter = null;
    this.selected = 0;
    this._previousFocus = this.doc.activeElement;
    this.root.hidden = false;
    this.root.setAttribute("mode", mode);
    this.doc.documentElement.setAttribute("halcyon-commandbar-open", "true");
    const value = mode == "address" ? this._currentURL() : "";
    this.input.value = value;
    this.input.placeholder =
      mode == "address" ? STRINGS.placeholderAddress : mode == "shortcuts" ? STRINGS.placeholderShortcuts : STRINGS.placeholderNewTab;
    this.input.focus();
    this.input.select();
    this._renderFooter();
    await HalcyonCommandIndex.ready();
    if (this.mode != mode || !this.isOpen) {
      return;
    }
    HalcyonCommandIndex.refreshTabs(this.win, tab => this._spaceName(tab));
    this._searchEngine = await this._defaultEngine();
    this.update();
  }

  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) {
      return;
    }
    this._recording = null;
    this.root.hidden = true;
    this.doc.documentElement.removeAttribute("halcyon-commandbar-open");
    this.mode = null;
    this.rows = [];
    this.list.textContent = "";
    HalcyonCommandIndex.forgetTabs();
    if (restoreFocus) {
      this.win.gBrowser?.selectedBrowser?.focus();
    }
  }

  _currentURL() {
    const uri = this.win.gBrowser?.currentURI;
    if (!uri || ["about:blank", "about:newtab", "about:home"].includes(uri.spec)) {
      return "";
    }
    return uri.displaySpec ?? uri.spec;
  }

  _spaceName(tab) {
    try {
      const id = tab.getAttribute("halcyon-space");
      if (!id || tab.pinned) {
        return "";
      }
      return Store.spaces.length > 1 ? (Store.get(id)?.name ?? "") : "";
    } catch {
      return "";
    }
  }

  async _defaultEngine() {
    try {
      const service = lazy.SearchService ?? Services.search;
      return lazy.PrivateBrowsingUtils.isWindowPrivate(this.win)
        ? await service.getDefaultPrivate()
        : await service.getDefault();
    } catch (e) {
      console.error("Halcyon command bar: no search engine", e);
      return null;
    }
  }

  // ---- searching ---------------------------------------------------------------------------

  /** One query per frame, however fast the typing. */
  _scheduleUpdate() {
    if (this._frame) {
      return;
    }
    this._frame = this.win.requestAnimationFrame(() => {
      this._frame = 0;
      this.update();
    });
  }

  update() {
    if (!this.isOpen) {
      return;
    }
    if (this.mode == "shortcuts") {
      this._updateShortcutRows();
      return;
    }
    let text = this.input.value;
    let parsed = Logic.parseInput(text);
    // A filter typed in full becomes a chip, and the input keeps just the query.
    if (parsed.filter && !this.filter) {
      this.filter = parsed.filter;
      this.input.value = parsed.query;
      text = parsed.query;
    }
    if (this.filter) {
      parsed = { ...Logic.parseInput(text), kinds: this.filter.kinds, filter: this.filter };
      parsed.query = text.trim();
    }
    this.chip.hidden = !this.filter;
    this.chip.textContent = this.filter?.label ?? "";

    if (parsed.filterHint.length && !this.filter) {
      this.rows = parsed.filterHint.map(f => ({ type: "filter", filter: f }));
    } else {
      const unchangedAddress = this.mode == "address" && text == this._currentURL();
      const query = unchangedAddress ? "" : parsed.query;
      const hits = HalcyonCommandIndex.search(query, { kinds: parsed.kinds, limit: Logic.MAX_ROWS });
      this.rows = Logic.arrangeRows({
        query,
        hits,
        filtered: !!this.filter,
        isURL: Logic.looksLikeURL(query, { isKnownSuffix: host => this._isKnownSuffix(host) }),
      });
    }
    this.selected = 0;
    this._render();
  }

  // ---- rendering ---------------------------------------------------------------------------

  _render() {
    const rows = this.rows.map((row, i) => this._renderRow(row, i));
    if (!rows.length) {
      rows.push(this.html("div", { class: "hx-cb-empty" }, [STRINGS.noResults]));
    }
    this.list.replaceChildren(...rows);
    this._select(this.selected);
  }

  _rowParts(row) {
    switch (row.type) {
      case "search": {
        const engine = this._searchEngine?.name;
        return {
          icon: "chrome://global/skin/icons/search-glass.svg",
          title: row.text,
          sub: engine ? STRINGS.searchWith(engine) : STRINGS.search,
          kind: STRINGS.search,
        };
      }
      case "url":
        return { icon: "chrome://global/skin/icons/defaultFavicon.svg", title: row.text, sub: STRINGS.open, kind: "" };
      case "filter":
        return { icon: "chrome://global/skin/icons/filter.svg", title: row.filter.token, sub: row.filter.label, kind: "" };
      case "shortcut":
        return {
          icon: "chrome://global/skin/icons/settings.svg",
          title: row.action.title,
          sub: row.message ?? "",
          kind: "",
          kbd: row.recording ? STRINGS.pressKeys : row.display || STRINGS.none,
        };
    }
    const e = row.entry;
    switch (e.kind) {
      case KIND.tab:
        return {
          icon: e.data.tab.image || `page-icon:${e.url}`,
          title: e.title,
          sub: e.data.space ? `${this._prettyURL(e.url)} · ${STRINGS.inSpace(e.data.space)}` : this._prettyURL(e.url),
          kind: STRINGS.switchToTab,
        };
      case KIND.bookmark:
        return { icon: `page-icon:${e.url}`, title: e.title, sub: this._prettyURL(e.url), kind: STRINGS.bookmark };
      case KIND.history:
        return { icon: `page-icon:${e.url}`, title: e.title, sub: this._prettyURL(e.url), kind: "" };
      case KIND.space:
        return { icon: "", glyph: e.data.space.icon || "◆", title: e.title, sub: "", kind: STRINGS.space };
      case KIND.action:
        return {
          icon: "chrome://global/skin/icons/arrow-right.svg",
          title: e.title,
          sub: "",
          kind: STRINGS.action,
          kbd: this.shortcuts.displayFor(e.data.action),
        };
    }
    return { title: e.title, sub: e.url };
  }

  _prettyURL(url) {
    return String(url ?? "")
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/\/$/, "");
  }

  _renderRow(row, i) {
    const p = this._rowParts(row);
    const icon = p.glyph
      ? this.html("span", { class: "hx-cb-icon hx-cb-glyph" }, [p.glyph])
      : this.html("img", { class: "hx-cb-icon", src: p.icon || null, alt: "", onerror: e => e.target.classList.add("hx-cb-icon-missing") });
    return this.html(
      "div",
      {
        id: `halcyon-commandbar-row-${i}`,
        class: "hx-cb-row",
        role: "option",
        "data-type": row.type,
        "data-kind": row.entry?.kind ?? "",
        onmousedown: e => e.preventDefault(), // keep focus in the input
        onmousemove: () => this.selected != i && this._select(i),
        onclick: e => this.activate(i, { other: e.shiftKey || e.button == 1 || e.ctrlKey || e.metaKey }),
      },
      [
        icon,
        this.html("span", { class: "hx-cb-text" }, [
          this.html("span", { class: "hx-cb-title" }, [p.title ?? ""]),
          p.sub ? this.html("span", { class: "hx-cb-sub" }, [p.sub]) : "",
        ]),
        p.kind ? this.html("span", { class: "hx-cb-kind" }, [p.kind]) : "",
        p.kbd ? this.html("kbd", { class: "hx-cb-kbd" }, [p.kbd]) : "",
      ]
    );
  }

  _select(i) {
    const rows = this.list.querySelectorAll(".hx-cb-row");
    if (!rows.length) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    this.selected = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach((el, n) => el.setAttribute("aria-selected", n == this.selected ? "true" : "false"));
    const el = rows[this.selected];
    this.input.setAttribute("aria-activedescendant", el.id);
    el.scrollIntoView?.({ block: "nearest" });
  }

  _renderFooter() {
    const hint = (keys, label) =>
      this.html("span", { class: "hx-cb-hint" }, [this.html("kbd", {}, [keys]), " ", label]);
    const enter = this.mac ? "↩" : "Enter";
    const items =
      this.mode == "shortcuts"
        ? [this.html("span", { class: "hx-cb-hint" }, [STRINGS.shortcutsHint])]
        : [
            hint(enter, STRINGS.footerOpen),
            hint((this.mac ? "⇧" : "Shift+") + enter, this.mode == "address" ? STRINGS.footerOther : STRINGS.footerOtherCurrent),
            hint("@", STRINGS.footerFilter),
            hint("Esc", STRINGS.footerClose),
          ];
    this.footer.replaceChildren(...items);
  }

  // ---- keyboard ----------------------------------------------------------------------------

  _onKeyDown(e) {
    if (this._recording) {
      this._recordKey(e);
      return;
    }
    const accel = this.mac ? e.metaKey : e.ctrlKey;
    const move = step => {
      e.preventDefault();
      this._select((this.selected + step + this.rows.length) % Math.max(1, this.rows.length));
    };
    switch (e.key) {
      case "ArrowDown":
        move(1);
        return;
      case "ArrowUp":
        move(-1);
        return;
      case "n":
      case "j":
        if (e.ctrlKey && !e.altKey) {
          move(1);
        }
        return;
      case "p":
      case "k":
        if (e.ctrlKey && !e.altKey) {
          move(-1);
        }
        return;
      case "PageDown":
      case "End":
        if (e.key == "PageDown" || accel) {
          e.preventDefault();
          this._select(this.rows.length - 1);
        }
        return;
      case "PageUp":
      case "Home":
        if (e.key == "PageUp" || accel) {
          e.preventDefault();
          this._select(0);
        }
        return;
      case "Tab": {
        e.preventDefault();
        const row = this.rows[this.selected];
        if (row?.type == "filter") {
          this.activate(this.selected);
        } else {
          move(e.shiftKey ? -1 : 1);
        }
        return;
      }
      case "Enter":
        e.preventDefault();
        if (this._frame) {
          // Enter right after typing: answer the latest text first.
          this.win.cancelAnimationFrame(this._frame);
          this._frame = 0;
          this.update();
        }
        this.activate(this.selected, { other: e.shiftKey || e.altKey || accel });
        return;
      case "Escape":
        e.preventDefault();
        if (this.mode == "shortcuts" && this._cameFromBar) {
          this._cameFromBar = false;
          this.open("newtab");
        } else if (this.filter && !this.input.value) {
          this.filter = null;
          this.update();
        } else {
          this.close();
        }
        return;
      case "Backspace":
        if (this.mode == "shortcuts" && !e.ctrlKey && !e.metaKey && !e.altKey && !this.input.value) {
          const row = this.rows[this.selected];
          if (row?.type == "shortcut") {
            e.preventDefault();
            this.shortcuts.set(row.action.id, "");
            this.update();
          }
        } else if (this.filter && !this.input.value) {
          e.preventDefault();
          this.filter = null;
          this.update();
        }
    }
  }

  // ---- doing things ------------------------------------------------------------------------

  /**
   * Act on a row.
   *
   * @param {number} i
   * @param {object} [options]
   * @param {boolean} [options.other] the other disposition: in Ctrl/Cmd+T mode open here, in
   *   Ctrl/Cmd+L mode open in a new tab
   */
  activate(i, { other = false } = {}) {
    const row = this.rows[i];
    const newTab = (this.mode != "address") != other;
    if (!row) {
      // Nothing typed, nothing listed: Ctrl/Cmd+T then Enter still gives a new tab.
      if (this.mode == "newtab" && !this.input.value.trim()) {
        this.close({ restoreFocus: false });
        this.runAction("new-tab");
      }
      return;
    }
    switch (row.type) {
      case "filter":
        this.filter = row.filter;
        this.input.value = "";
        this.update();
        return;
      case "shortcut":
        this._startRecording(row);
        return;
      case "url":
        this.close({ restoreFocus: false });
        this._openURL(this._fixup(row.text), newTab);
        return;
      case "search":
        this.close({ restoreFocus: false });
        this._search(row.text, newTab);
        return;
    }
    const e = row.entry;
    this.close({ restoreFocus: false });
    switch (e.kind) {
      case KIND.tab:
        this._switchToTab(e.data);
        return;
      case KIND.bookmark:
      case KIND.history:
        this._openURL(e.url, newTab);
        return;
      case KIND.space:
        this.parts.spaces?.switchTo(e.data.space.id);
        return;
      case KIND.action:
        this.runAction(e.data.action.id);
    }
  }

  _isKnownSuffix(host) {
    try {
      return Services.eTLD.hasKnownPublicSuffixFromHost(host);
    } catch {
      return true;
    }
  }

  _fixup(text) {
    try {
      const flags = Ci.nsIURIFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = Services.uriFixup.getFixupURIInfo(text, flags);
      if (info.preferredURI) {
        return info.preferredURI.spec;
      }
    } catch {}
    return Logic.toURL(text);
  }

  _userContextId() {
    try {
      const spaces = this.parts.spaces;
      if (spaces) {
        return Store.userContextIdFor(spaces.activeSpace) || 0;
      }
    } catch {}
    return this.win.gBrowser?.selectedBrowser?.getAttribute("usercontextid") * 1 || 0;
  }

  _openURL(url, newTab, { postData = null } = {}) {
    const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
    const where = newTab ? "tab" : "current";
    const params = { triggeringPrincipal, postData, inBackground: false };
    if (newTab) {
      params.userContextId = this._userContextId();
    }
    this.win.openTrustedLinkIn(url, where, params);
    this.win.gBrowser?.selectedBrowser?.focus();
  }

  _search(text, newTab) {
    const engine = this._searchEngine;
    if (!engine) {
      this._openURL(this._fixup(text), newTab);
      return;
    }
    const submission = engine.getSubmission(text);
    this._openURL(submission.uri.spec, newTab, { postData: submission.postData });
  }

  _switchToTab({ tab, window }) {
    if (!tab?.isConnected || tab.closing) {
      return;
    }
    if (window != this.win) {
      window.focus();
    }
    window.gBrowser.selectedTab = tab;
    window.gBrowser.selectedBrowser.focus();
  }

  /** Run a built-in action by id. */
  runAction(id) {
    const action = Logic.actionById(id);
    if (!action) {
      return;
    }
    try {
      if (action.command) {
        const command = this.doc.getElementById(action.command);
        if (command && !command.hasAttribute("disabled")) {
          command.doCommand();
        }
        return;
      }
      this.handlers[action.run]?.call(this);
    } catch (e) {
      console.error(`Halcyon command bar: action ${id} failed`, e);
    }
  }

  get handlers() {
    const win = this.win;
    const gBrowser = win.gBrowser;
    const spaces = this.parts.spaces;
    return {
      newTab() {
        if (spaces) {
          spaces.openNewTab();
        } else {
          win.BrowserCommands.openTab();
        }
      },
      togglePin() {
        const tab = gBrowser.selectedTab;
        if (!tab.pinned) {
          this.parts.sections?.togglePinned(tab);
        }
      },
      toggleEssential() {
        this.parts.sections?.toggleEssential(gBrowser.selectedTab);
      },
      copyLink() {
        const uri = gBrowser.currentURI;
        if (uri && uri.spec != "about:blank") {
          Cc["@mozilla.org/widget/clipboardhelper;1"].getService(Ci.nsIClipboardHelper).copyString(uri.displaySpec);
        }
      },
      toggleCompact() {
        this.parts.compact?.toggle();
      },
      toggleSidebar() {
        win.SidebarController?.handleToolbarButtonClick();
      },
      newSpace() {
        spaces?.ui?.createSpace(null);
      },
      editSpace() {
        if (spaces?.ui) {
          const anchor = this.doc.querySelector(`.halcyon-space-dot[data-space="${spaces.active}"]`);
          spaces.ui.openEditor(spaces.active, anchor);
        }
      },
      nextSpace() {
        spaces?.next(1);
      },
      previousSpace() {
        spaces?.next(-1);
      },
      settings() {
        win.openPreferences();
      },
      editShortcuts() {
        this._cameFromBar = false;
        this.open("shortcuts");
      },
    };
  }

  // ---- keyboard shortcut editor ------------------------------------------------------------

  _updateShortcutRows() {
    const filter = this.input.value.trim().toLowerCase();
    const recording = this._recording?.action.id;
    this.rows = Logic.ACTIONS.filter(a => !filter || `${a.title} ${a.keywords}`.toLowerCase().includes(filter)).map(
      action => ({
        type: "shortcut",
        action,
        display: this.shortcuts.displayFor(action),
        recording: action.id == recording,
        message: "",
      })
    );
    this.selected = Math.min(this.selected, Math.max(0, this.rows.length - 1));
    this._render();
  }

  _startRecording(row) {
    this._recording = { action: row.action, pending: "" };
    row.recording = true;
    row.message = "";
    this._render();
  }

  _recordKey(e) {
    e.preventDefault();
    e.stopPropagation();
    const rec = this._recording;
    const row = this.rows.find(r => r.action?.id == rec.action.id);
    if (e.key == "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      this._recording = null;
      this._updateShortcutRows();
      return;
    }
    if ((e.key == "Backspace" || e.key == "Delete") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      this._recording = null;
      this.shortcuts.set(rec.action.id, "");
      this._updateShortcutRows();
      return;
    }
    const { shortcut, error } = Logic.shortcutFromEvent(e, { mac: this.mac });
    if (!shortcut) {
      if (error && row) {
        row.message = error;
        this._render();
      }
      return;
    }
    const conflicts = this.shortcuts.conflictsFor(shortcut, rec.action.id);
    if (conflicts.length && rec.pending != shortcut) {
      // Ask once: pressing the same shortcut again confirms.
      rec.pending = shortcut;
      if (row) {
        row.message = STRINGS.replaces(conflicts.map(c => c.label).join(", "));
        row.display = Logic.displayShortcut(shortcut, { mac: this.mac });
        this._render();
      }
      return;
    }
    this._recording = null;
    this.shortcuts.set(rec.action.id, shortcut);
    this._updateShortcutRows();
  }
}
