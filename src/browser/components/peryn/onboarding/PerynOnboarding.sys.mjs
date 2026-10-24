/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * First run: a short welcome over the first window. Bring your things over (from another
 * browser through Firefox's import wizard, or from Arc: Spaces, pinned tabs and Favorites),
 * pick a look, pick how strict protection is, and choose whether Peryn is the default
 * browser. Every step can be skipped; it's shown once, and the command bar's "Welcome and
 * Import" brings it back. Nothing here sends anything anywhere.
 */

import { PerynSpacesStore as Store } from "../spaces/PerynSpacesStore.sys.mjs";
import { ARC_PATHS, parseArcSidebar, mergeImport } from "./PerynArcImport.sys.mjs";
import { ZEN_PATHS, parseZenSession } from "./PerynZenImport.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  MigrationUtils: "resource:///modules/MigrationUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  ShellService: "moz-src:///browser/components/shell/ShellService.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";

export const PREFS = Object.freeze({
  done: "peryn.onboarding.done",
});

export const STEPS = Object.freeze(["welcome", "import", "look", "protection", "default"]);

export const THEMES = Object.freeze({
  auto: "default-theme@mozilla.org",
  light: "firefox-compact-light@mozilla.org",
  dark: "firefox-compact-dark@mozilla.org",
});

export const PROTECTION = Object.freeze({
  pref: "browser.contentblocking.category",
  strict: "strict",
  balanced: "standard",
});

/** Whether a window should show the welcome on its own. */
export function shouldShow({ done, isPrivate, otherWindows }) {
  return !done && !isPrivate && otherWindows == 0;
}

/** A one-line summary of an import from Arc or Zen. */
export function importSummary({ added, dropped }, skipped = 0, source = "Arc") {
  const n = (count, one, many) => `${count} ${count == 1 ? one : many}`;
  const parts = [];
  if (added.spaces) {
    parts.push(n(added.spaces, "Space", "Spaces"));
  }
  if (added.pins) {
    parts.push(n(added.pins, "pinned tab", "pinned tabs"));
  }
  if (added.essentials) {
    parts.push(source == "Arc" ? n(added.essentials, "Favorite (now Essentials)", "Favorites (now Essentials)") : n(added.essentials, "Essential", "Essentials"));
  }
  let text = parts.length ? `Imported ${joinList(parts)} from ${source}.` : `Nothing new to import from ${source}.`;
  const left = dropped + skipped;
  if (left) {
    text += ` ${n(left, "item was", "items were")} left out (over the limits, or not a web page).`;
  }
  return text;
}

function joinList(parts) {
  return parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export const STRINGS = Object.freeze({
  welcomeTitle: "Welcome to Peryn",
  welcomeText:
    "A calm browser that blocks ads and trackers, sends no telemetry, and keeps your tabs in a sidebar. A few quick choices and you're set; you can skip any of them.",
  start: "Get started",
  importTitle: "Bring your things",
  importText: "Bookmarks, history and passwords come over with Firefox's import. From Arc or Zen, your Spaces, pinned tabs and Favorites or Essentials come over too.",
  importBrowser: "From another browser…",
  importBrowserHint: "Chrome, Edge, Firefox, Safari, Brave and others",
  importArc: "From Arc",
  importArcHint: "Spaces, pinned tabs and Favorites",
  arcPick: "Choose Arc's StorableSidebar.json",
  importZen: "From Zen",
  importZenHint: "Spaces, pinned tabs and Essentials (quit Zen first)",
  zenPick: "Choose Zen's zen-sessions.jsonlz4 (in your Zen profile folder)",
  lookTitle: "Pick a look",
  lookText: "Follow your system, or keep it light or dark.",
  auto: "Match system",
  light: "Light",
  dark: "Dark",
  protectionTitle: "How strict should protection be?",
  protectionText: "Ads are blocked either way. Strict also blocks trackers that some sites need to work properly; you can relax it for a single site from the shield in the address bar.",
  strict: "Strict",
  strictHint: "Recommended. Blocks trackers, fingerprinters and cross-site cookies.",
  balanced: "Balanced",
  balancedHint: "Firefox's standard protection. Fewer sites need a fix.",
  defaultTitle: "Make Peryn your default browser?",
  defaultText: "Links from other apps would open here. This is the only time Peryn asks.",
  makeDefault: "Make default",
  alreadyDefault: "Peryn is already your default browser.",
  notNow: "Not now",
  next: "Next",
  skip: "Skip",
  back: "Back",
  done: "Start browsing",
  close: "Close",
});

export class PerynOnboarding {
  constructor(win, parts = {}) {
    this.win = win;
    this.doc = win.document;
    this.parts = parts;
    this.step = 0;
    this.handleKey = this.handleKey.bind(this);
  }

  init() {
    const isPrivate = lazy.PrivateBrowsingUtils.isWindowPrivate(this.win);
    const otherWindows = [...Services.wm.getEnumerator("navigator:browser")].filter(w => w != this.win).length;
    if (shouldShow({ done: Services.prefs.getBoolPref(PREFS.done, false), isPrivate, otherWindows })) {
      // After the window has painted and restored its tabs.
      this.win.setTimeout(() => this.show(), 700);
    }
  }

  uninit() {
    this.root?.remove();
  }

  get isOpen() {
    return !!this.root && !this.root.hidden;
  }

  show(step = 0) {
    if (!this.root) {
      this._build();
    }
    this.root.hidden = false;
    this.win.addEventListener("keydown", this.handleKey, true);
    this.go(step);
  }

  /** Close, and don't show again on its own. */
  close() {
    Services.prefs.setBoolPref(PREFS.done, true);
    if (this.root) {
      this.root.hidden = true;
    }
    this.win.removeEventListener("keydown", this.handleKey, true);
  }

  handleKey(event) {
    if (event.key == "Escape" && this.isOpen) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  go(step) {
    const target = Math.max(0, Math.min(STEPS.length - 1, step));
    this.root.setAttribute("direction", target < this.step ? "back" : "forward");
    this.step = target;
    const name = STEPS[this.step];
    for (const page of this.root.querySelectorAll(".peryn-ob-step")) {
      page.hidden = page.dataset.step != name;
    }
    this.root.querySelectorAll(".peryn-ob-dot").forEach((dot, i) => dot.toggleAttribute("current", i == this.step));
    if (name == "default") {
      this._refreshDefault();
    }
    this.root.querySelector(`.peryn-ob-step[data-step="${name}"] button`)?.focus();
  }

  next() {
    if (this.step >= STEPS.length - 1) {
      this.close();
    } else {
      this.go(this.step + 1);
    }
  }

  // ---- actions ---------------------------------------------------------------------------

  importFromBrowser() {
    try {
      lazy.MigrationUtils.showMigrationWizard(this.win, {
        entrypoint: lazy.MigrationUtils.MIGRATION_ENTRYPOINTS.FIRSTRUN,
      });
    } catch (e) {
      console.error("Peryn onboarding: import wizard failed", e);
    }
  }

  /** Arc's file where Arc keeps it on this OS, if it's there. */
  async findArcFile() {
    try {
      if (lazy.AppConstants.platform == "macosx") {
        const lib = Services.dirsvc.get("ULibDir", Ci.nsIFile).path;
        const path = PathUtils.join(lib, "Application Support", ...ARC_PATHS.macosx);
        return (await IOUtils.exists(path)) ? path : null;
      }
      if (lazy.AppConstants.platform == "win") {
        const local = Services.dirsvc.get("LocalAppData", Ci.nsIFile).path;
        const packages = PathUtils.join(local, "Packages");
        if (!(await IOUtils.exists(packages))) {
          return null;
        }
        for (const dir of await IOUtils.getChildren(packages)) {
          if (PathUtils.filename(dir).startsWith(ARC_PATHS.winPackagePrefix)) {
            const path = PathUtils.join(dir, ...ARC_PATHS.win);
            if (await IOUtils.exists(path)) {
              return path;
            }
          }
        }
      }
    } catch (e) {
      console.error("Peryn onboarding: looking for Arc failed", e);
    }
    return null;
  }

  pickArcFile() {
    return new Promise(resolve => {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(this.win.browsingContext, STRINGS.arcPick, Ci.nsIFilePicker.modeOpen);
      picker.appendFilter("Arc sidebar (StorableSidebar.json)", "StorableSidebar.json;*.json");
      picker.open(result => resolve(result == Ci.nsIFilePicker.returnOK ? picker.file.path : null));
    });
  }

  /** Import Spaces, pinned tabs and Favorites from Arc's file (found, or picked). */
  async importFromArc({ path = null } = {}) {
    const status = this.root?.querySelector(".peryn-ob-status");
    const say = text => {
      if (status) {
        status.textContent = text;
      }
    };
    path ??= (await this.findArcFile()) ?? (await this.pickArcFile());
    if (!path) {
      say("");
      return null;
    }
    try {
      const parsed = parseArcSidebar(await IOUtils.readUTF8(path));
      const result = mergeImport(Store.data, parsed, { source: "Arc" });
      Store.set(result.data, { imported: "arc" });
      const text = importSummary(result, parsed.skipped, "Arc");
      say(text);
      return { ...result, text };
    } catch (e) {
      say(e.message.startsWith("This isn't") || e.message.startsWith("Arc's") ? e.message : "Couldn't read that file.");
      console.error("Peryn onboarding: Arc import failed", e);
      return null;
    }
  }

  /** Zen's session file in its most recently used profile, if Zen is installed. */
  async findZenFile() {
    try {
      const platform = lazy.AppConstants.platform;
      let root;
      if (platform == "win") {
        root = PathUtils.join(Services.dirsvc.get("AppData", Ci.nsIFile).path, ...ZEN_PATHS.win);
      } else if (platform == "macosx") {
        root = PathUtils.join(Services.dirsvc.get("ULibDir", Ci.nsIFile).path, "Application Support", ...ZEN_PATHS.macosx);
      } else {
        root = PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, ...ZEN_PATHS.linux);
      }
      if (!(await IOUtils.exists(root))) {
        return null;
      }
      let best = null;
      for (const dir of await IOUtils.getChildren(root)) {
        for (const name of ZEN_PATHS.sessionFiles) {
          const path = PathUtils.join(dir, name);
          const info = await IOUtils.stat(path).catch(() => null);
          if (info?.type == "regular" && (!best || info.lastModified > best.at)) {
            best = { path, at: info.lastModified };
          }
          if (info) {
            break; // the newer file name wins within a profile
          }
        }
      }
      return best?.path ?? null;
    } catch (e) {
      console.error("Peryn onboarding: looking for Zen failed", e);
      return null;
    }
  }

  pickZenFile() {
    return new Promise(resolve => {
      const picker = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
      picker.init(this.win.browsingContext, STRINGS.zenPick, Ci.nsIFilePicker.modeOpen);
      picker.appendFilter("Zen session (zen-sessions.jsonlz4, sessionstore.jsonlz4)", "*.jsonlz4");
      picker.open(result => resolve(result == Ci.nsIFilePicker.returnOK ? picker.file.path : null));
    });
  }

  /** Import Spaces, pinned tabs and Essentials from Zen's session file (found, or picked). */
  async importFromZen({ path = null } = {}) {
    const status = this.root?.querySelector(".peryn-ob-status");
    const say = text => {
      if (status) {
        status.textContent = text;
      }
    };
    path ??= (await this.findZenFile()) ?? (await this.pickZenFile());
    if (!path) {
      say("");
      return null;
    }
    try {
      // Zen's session files are Firefox's compressed JSON (mozLz4).
      const json = await IOUtils.readJSON(path, { decompress: true });
      const parsed = parseZenSession(json);
      const result = mergeImport(Store.data, parsed, { source: "Zen" });
      Store.set(result.data, { imported: "zen" });
      const text = importSummary(result, parsed.skipped, "Zen");
      say(text);
      return { ...result, text };
    } catch (e) {
      say(/^(This isn't|Zen's)/.test(e.message) ? e.message : "Couldn't read Zen's session file. Quit Zen and try again.");
      console.error("Peryn onboarding: Zen import failed", e);
      return null;
    }
  }

  async setLook(choice) {
    const id = THEMES[choice];
    if (!id) {
      return;
    }
    try {
      const addon = await lazy.AddonManager.getAddonByID(id);
      await addon?.enable();
    } catch (e) {
      console.error("Peryn onboarding: theme change failed", e);
    }
    this._mark("look", choice);
  }

  setProtection(choice) {
    const value = PROTECTION[choice];
    if (value) {
      Services.prefs.setStringPref(PROTECTION.pref, value);
      this._mark("protection", choice);
    }
  }

  async makeDefault() {
    try {
      await lazy.ShellService.setAsDefault();
    } catch (e) {
      console.error("Peryn onboarding: setting the default browser failed", e);
    }
    this._refreshDefault();
  }

  _isDefault() {
    try {
      return lazy.ShellService.isDefaultBrowser(false, true);
    } catch {
      return false;
    }
  }

  _refreshDefault() {
    const page = this.root.querySelector('.peryn-ob-step[data-step="default"]');
    const isDefault = this._isDefault();
    page.querySelector(".peryn-ob-default-ask").hidden = isDefault;
    page.querySelector(".peryn-ob-default-done").hidden = !isDefault;
  }

  /** Show which choice is in effect. */
  _mark(group, choice) {
    for (const button of this.root?.querySelectorAll(`[data-group="${group}"]`) ?? []) {
      button.setAttribute("aria-pressed", String(button.dataset.choice == choice));
    }
  }

  // ---- building ---------------------------------------------------------------------------

  _el(tag, attrs = {}, children = []) {
    const el = this.doc.createElementNS(HTML_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v == "function") {
        el.addEventListener(k, v);
      } else if (k == "text") {
        el.textContent = v;
      } else if (v !== null && v !== undefined) {
        el.setAttribute(k, v);
      }
    }
    el.append(...children);
    return el;
  }

  _choice(group, choice, label, hint, run) {
    return this._el(
      "button",
      { class: "peryn-ob-choice", "data-group": group, "data-choice": choice, "aria-pressed": "false", click: run },
      [this._el("span", { class: "peryn-ob-choice-label", text: label }), hint ? this._el("span", { class: "peryn-ob-choice-hint", text: hint }) : ""]
    );
  }

  _step(name, title, text, body, actions) {
    return this._el("section", { class: "peryn-ob-step", "data-step": name, hidden: "true", "aria-labelledby": `peryn-ob-${name}-title` }, [
      this._el("h1", { id: `peryn-ob-${name}-title`, text: title }),
      this._el("p", { class: "peryn-ob-text", text }),
      body,
      this._el("div", { class: "peryn-ob-actions" }, actions),
    ]);
  }

  _build() {
    const e = (...a) => this._el(...a);
    const next = (label = STRINGS.next) => e("button", { class: "peryn-ob-primary", text: label, click: () => this.next() });
    const skip = () => e("button", { class: "peryn-ob-quiet", text: STRINGS.skip, click: () => this.next() });
    const back = () => e("button", { class: "peryn-ob-quiet", text: STRINGS.back, click: () => this.go(this.step - 1) });

    const steps = [
      e("section", { class: "peryn-ob-step peryn-ob-welcome", "data-step": "welcome", hidden: "true", "aria-labelledby": "peryn-ob-welcome-title" }, [
        e("img", { class: "peryn-ob-logo", src: "chrome://branding/content/about-logo.svg", alt: "" }),
        e("h1", { id: "peryn-ob-welcome-title", text: STRINGS.welcomeTitle }),
        e("p", { class: "peryn-ob-text", text: STRINGS.welcomeText }),
        e("div", { class: "peryn-ob-actions" }, [next(STRINGS.start)]),
      ]),
      this._step(
        "import",
        STRINGS.importTitle,
        STRINGS.importText,
        e("div", { class: "peryn-ob-choices" }, [
          this._choice("import", "browser", STRINGS.importBrowser, STRINGS.importBrowserHint, () => this.importFromBrowser()),
          this._choice("import", "arc", STRINGS.importArc, STRINGS.importArcHint, () => this.importFromArc()),
          this._choice("import", "zen", STRINGS.importZen, STRINGS.importZenHint, () => this.importFromZen()),
          e("p", { class: "peryn-ob-status", role: "status" }),
        ]),
        [back(), skip(), next()]
      ),
      this._step(
        "look",
        STRINGS.lookTitle,
        STRINGS.lookText,
        e("div", { class: "peryn-ob-choices peryn-ob-row" }, [
          this._choice("look", "auto", STRINGS.auto, "", () => this.setLook("auto")),
          this._choice("look", "light", STRINGS.light, "", () => this.setLook("light")),
          this._choice("look", "dark", STRINGS.dark, "", () => this.setLook("dark")),
        ]),
        [back(), skip(), next()]
      ),
      this._step(
        "protection",
        STRINGS.protectionTitle,
        STRINGS.protectionText,
        e("div", { class: "peryn-ob-choices" }, [
          this._choice("protection", "strict", STRINGS.strict, STRINGS.strictHint, () => this.setProtection("strict")),
          this._choice("protection", "balanced", STRINGS.balanced, STRINGS.balancedHint, () => this.setProtection("balanced")),
        ]),
        [back(), skip(), next()]
      ),
      this._step(
        "default",
        STRINGS.defaultTitle,
        STRINGS.defaultText,
        e("div", { class: "peryn-ob-choices" }, [
          e("div", { class: "peryn-ob-default-ask" }, [
            e("button", { class: "peryn-ob-primary", text: STRINGS.makeDefault, click: () => this.makeDefault() }),
          ]),
          e("p", { class: "peryn-ob-default-done", hidden: "true", text: STRINGS.alreadyDefault }),
        ]),
        [back(), next(STRINGS.done)]
      ),
    ];

    this.root = e("div", { id: "peryn-onboarding", hidden: "true", role: "dialog", "aria-modal": "true", "aria-label": STRINGS.welcomeTitle }, [
      e("div", { class: "peryn-ob-backdrop" }),
      e("div", { class: "peryn-ob-card" }, [
        e("button", { class: "peryn-ob-close", title: STRINGS.close, "aria-label": STRINGS.close, click: () => this.close() }),
        ...steps,
        e("div", { class: "peryn-ob-dots", "aria-hidden": "true" }, STEPS.map(() => e("span", { class: "peryn-ob-dot" }))),
      ]),
    ]);
    // The protection in effect now (Peryn ships strict).
    const category = Services.prefs.getStringPref(PROTECTION.pref, "");
    this.doc.documentElement.append(this.root);
    this._mark("protection", category == PROTECTION.balanced ? "balanced" : "strict");
  }
}
