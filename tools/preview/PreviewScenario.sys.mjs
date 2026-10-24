/* Peryn UI preview harness (CI only, never shipped). Loaded by peryn-preview.cfg.
 *
 * Registers our layout's window hooks the way peryn.manifest does (pointing at
 * resource://peryn-preview/, which the .cfg maps to src/browser/components/peryn/), then
 * scripts a session (Essentials, Pinned, Today tabs) and walks through the layout states. At
 * each state it writes <name>.ready to $PERYN_PREVIEW_OUT and waits for run_preview.py to take
 * a screenshot and write <name>.done. Console errors go to console.log in the same folder. */

const OUT = Services.env.get("PERYN_PREVIEW_OUT");
const SITE = Services.env.get("PERYN_PREVIEW_SITE");
const LAYOUT = "resource://peryn-preview/layout/PerynLayout.sys.mjs";

const consoleLines = [];
let flushQueued = false;

function log(line) {
  consoleLines.push(line);
  if (flushQueued) {
    return;
  }
  flushQueued = true;
  Promise.resolve().then(() => {
    flushQueued = false;
    IOUtils.writeUTF8(PathUtils.join(OUT, "console.log"), consoleLines.join("\n") + "\n").catch(() => {});
  });
}

export const PreviewScenario = {
  start() {
    IOUtils.writeUTF8(PathUtils.join(OUT, "started"), "").catch(() => {});
    Services.console.registerListener({
      observe(message) {
        try {
          if (message instanceof Ci.nsIScriptError) {
            if (!(message.flags & Ci.nsIScriptError.warningFlag)) {
              log(`[error] ${message.errorMessage} (${message.sourceName}:${message.lineNumber})`);
            }
          } else if (/peryn/i.test(message.message)) {
            log(`[console] ${message.message}`);
          }
        } catch (e) {
          // Never let logging break the run.
        }
      },
    });
    // console.error() from modules arrives here, not through the console service.
    Services.obs.addObserver(subject => {
      const msg = subject.wrappedJSObject;
      if (msg?.level == "error" || msg?.level == "warn") {
        const text = (msg.arguments || []).map(a => (a?.stack ? `${a}\n${a.stack}` : String(a))).join(" ");
        if (/peryn/i.test(text) || /peryn/i.test(msg.filename || "")) {
          log(`[console.${msg.level}] ${text} (${msg.filename}:${msg.lineNumber})`);
        }
      }
    }, "console-api-log-event");
    for (const [category, method] of [
      ["browser-before-ui-startup", "PerynLayout.init"],
      ["browser-window-before-initial-xul-layout", "PerynLayout.beforeLayout"],
      ["browser-window-domcontentloaded", "PerynLayout.onDOMContentLoaded"],
    ]) {
      Services.catMan.addCategoryEntry(category, LAYOUT, method, false, true);
    }
    Services.obs.addObserver(function onStartup(win) {
      Services.obs.removeObserver(onStartup, "browser-delayed-startup-finished");
      log("[scenario] first window ready");
      runScenario(win).catch(e => {
        log(`[scenario] ${e}\n${e.stack}`);
        IOUtils.writeUTF8(PathUtils.join(OUT, "finished"), "error").catch(() => {});
      });
    }, "browser-delayed-startup-finished");
  },
};

async function runScenario(win) {
  const { gBrowser } = win;
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const shot = async name => {
    await IOUtils.writeUTF8(PathUtils.join(OUT, `${name}.ready`), "");
    for (let i = 0; i < 600; i++) {
      if (await IOUtils.exists(PathUtils.join(OUT, `${name}.done`))) {
        return;
      }
      await sleep(100);
    }
    throw new Error(`no screenshot for ${name}`);
  };
  const report = async (name, value) =>
    IOUtils.writeUTF8(PathUtils.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));

  win.moveTo(0, 0);
  win.resizeTo(1440, 900);

  const { PerynLayout } = ChromeUtils.importESModule(LAYOUT);
  const layout = PerynLayout.forWindow(win);
  if (!layout) {
    throw new Error("layout did not attach to the window");
  }

  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  const open = page =>
    gBrowser.addTrustedTab(SITE + page, { triggeringPrincipal: principal, skipAnimation: true });
  const firstTab = gBrowser.selectedTab;

  const essentials = ["mail", "calendar", "music", "notes", "chat", "photos"].map(p => open(`${p}.html`));
  for (const tab of essentials) {
    gBrowser.pinTab(tab);
  }
  // New tabs open at the top of Today, so open them oldest first.
  const today = ["code", "weather", "recipes", "news"].map(p => open(`${p}.html`)).reverse();
  const pinned = ["docs", "design", "roadmap"].map(p => open(`${p}.html`));
  for (const tab of pinned) {
    layout.sections.setPinned(tab, true);
  }
  gBrowser.selectedTab = today[0];
  gBrowser.removeTab(firstTab);
  await sleep(4000);

  // Order check: Essentials, Pinned, then Today.
  await report("order", {
    tabs: gBrowser.tabs.map(t => ({
      title: t.label,
      essential: t.pinned,
      pinned: t.hasAttribute("peryn-pinned"),
    })),
  });

  const { CustomizableUI } = ChromeUtils.importESModule(
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs"
  );
  const navbar = win.document.getElementById("nav-bar-customization-target");
  await report("toolbar", {
    placements: CustomizableUI.getWidgetIdsInArea("nav-bar"),
    rendered: [...navbar.children].map(el => ({
      id: el.id,
      hidden: el.hidden || el.collapsed,
      width: Math.round(el.getBoundingClientRect().width),
    })),
    copyLinkWidget: !!CustomizableUI.getWidget("peryn-copy-link-button")?.provider,
    copyLinkAfterUrlbar:
      CustomizableUI.getWidgetIdsInArea("nav-bar").indexOf("peryn-copy-link-button") ==
      CustomizableUI.getWidgetIdsInArea("nav-bar").indexOf("urlbar-container") + 1,
    toolbarSetupDone: Services.prefs.getBoolPref("peryn.layout.toolbarSetupDone", false),
  });

  await shot("01-expanded-light");

  // New tab from "+ New Tab": lands at the top of Today.
  win.BrowserCommands.openTab();
  await sleep(1200);
  await report("new-tab", {
    index: gBrowser.tabs.indexOf(gBrowser.selectedTab),
    expected: gBrowser.pinnedTabCount + pinned.length,
  });
  gBrowser.removeTab(gBrowser.selectedTab);
  gBrowser.selectedTab = today[0];
  await sleep(800);

  Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
  await sleep(1500);
  await shot("02-expanded-dark");
  Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
  await sleep(800);

  win.SidebarController._state.launcherExpanded = false;
  await sleep(1200);
  await shot("03-rail");
  win.SidebarController._state.launcherExpanded = true;
  await sleep(1200);

  // Compact mode through the real wiring: the shortcut's <key>, the edge element, focus.
  const doc = win.document;
  const root = doc.documentElement;
  const compactState = () => ({
    compact: root.hasAttribute("peryn-compact"),
    reveal: root.getAttribute("peryn-reveal") || "",
  });
  doc.getElementById("peryn-key-compact").doCommand();
  await sleep(1200);
  const afterToggle = compactState();
  await shot("04-compact");
  doc.getElementById("peryn-edge-sidebar").dispatchEvent(new win.MouseEvent("mouseenter"));
  await sleep(900);
  const afterEdge = compactState();
  await shot("05-compact-sidebar");
  win.gURLBar.focus();
  await sleep(900);
  const afterFocus = compactState();
  await shot("06-compact-both");
  doc.getElementById("peryn-edge-sidebar").dispatchEvent(new win.MouseEvent("mouseleave"));
  gBrowser.selectedBrowser.focus();
  await sleep(1000);
  const afterLeave = compactState();
  doc.getElementById("peryn-key-compact").doCommand();
  await sleep(1000);
  await report("compact", { afterToggle, afterEdge, afterFocus, afterLeave, afterOff: compactState() });

  // Tab context menu on a Today tab.
  const menu = win.document.getElementById("tabContextMenu");
  const shown = new Promise(resolve => menu.addEventListener("popupshown", resolve, { once: true }));
  const rect = today[1].getBoundingClientRect();
  const x = win.mozInnerScreenX + rect.left + 40;
  const y = win.mozInnerScreenY + rect.top + rect.height / 2;
  const trigger = new win.MouseEvent("contextmenu", { bubbles: true, button: 2, screenX: x, screenY: y });
  today[1].dispatchEvent(trigger);
  if (menu.state != "open" && menu.state != "showing") {
    menu.openPopupAtScreen(x, y, true, trigger);
  }
  await Promise.race([shown, sleep(3000)]);
  if (menu.state != "open") {
    log("[scenario] context menu did not open from a synthesized click");
  }
  await sleep(500);
  await report("tab-menu", {
    open: menu.state == "open",
    items: [...menu.children]
      .filter(el => el.localName == "menuitem" || el.localName == "menu")
      .filter(el => !el.hidden && win.getComputedStyle(el).display != "none")
      .map(el => ({ id: el.id, label: el.label })),
  });
  await shot("07-tab-menu");
  menu.hidePopup();
  await sleep(500);

  // ---- Spaces (C4) ----
  const { PerynSpacesStore: Store } = ChromeUtils.importESModule(
    "resource://peryn-preview/spaces/PerynSpacesStore.sys.mjs"
  );
  const spaces = layout.spaces;
  Store.update(Store.spaces[0].id, { icon: "🏠" });
  const work = Store.create({ name: "Work", icon: "💼", color: { hue: 155, hue2: 195, chroma: 0.05 } });
  Store.create({ name: "Weekend", icon: "🎮", color: { hue: 25, hue2: 345, chroma: 0.06, grain: true } });
  await sleep(300);
  spaces.switchTo(work.id);
  await sleep(600);
  const workTabs = ["docs", "code", "roadmap"].map(p => open(`${p}.html`)).reverse();
  gBrowser.selectedTab = workTabs[0];
  layout.sections.setPinned(workTabs[2], true);
  await sleep(2500);
  await report("spaces", {
    names: Store.spaces.map(s => s.name),
    active: spaces.active == work.id,
    header: doc.querySelector("#peryn-space-header .peryn-space-name")?.textContent,
    dots: doc.querySelectorAll(".peryn-space-dot").length,
    visibleTodayTabs: gBrowser.visibleTabs.filter(t => !t.pinned).map(t => t.label),
    pinsInWork: Store.get(work.id).pins.map(p => p.title || p.url),
    hueOnWindow: root.style.getPropertyValue("--hx-space-hue"),
  });
  await shot("08-space-work");

  const header = doc.getElementById("peryn-space-header");
  const editor = doc.getElementById("peryn-space-editor");
  const editorShown = new Promise(resolve => editor.addEventListener("popupshown", resolve, { once: true }));
  spaces.ui.openEditor(work.id, header);
  await Promise.race([editorShown, sleep(3000)]);
  await sleep(400);
  await shot("09-space-editor");
  editor.hidePopup();
  await sleep(400);

  doc.getElementById("peryn-key-space-next").doCommand();
  await sleep(900);
  const afterNext = Store.get(spaces.active)?.name;
  await shot("10-space-weekend");
  // Closing a Space's last tab keeps you in that Space (a fresh tab), not in another Space.
  const weekendId = spaces.active;
  gBrowser.removeTab(gBrowser.selectedTab);
  await sleep(800);
  const afterCloseLast = {
    stayed: spaces.active == weekendId,
    selectedInSpace: gBrowser.selectedTab.getAttribute("peryn-space") == weekendId,
  };
  doc.getElementById("peryn-key-space-1").doCommand();
  await sleep(900);
  // Another machine's changes arriving through Firefox Sync: its prefs engine writes the synced
  // pref, exactly like this. A new Space and a new Essential should appear here.
  const syncBranch = Services.prefs.getBranch("services.sync.prefs.sync.");
  const remote = structuredClone(Store.data);
  remote.spaces.push({ id: "s-laptop", name: "Laptop", icon: "💻", color: { hue: 200, hue2: 240, chroma: 0.05 }, pins: [] });
  remote.essentials.push({ id: "e-laptop", url: `${SITE}weather.html`, title: "Weather from the laptop" });
  Services.prefs.setStringPref("peryn.spaces", JSON.stringify(remote));
  await sleep(1500);
  await report("sync", {
    syncedByFirefoxSync: syncBranch.getChildList("").includes("peryn.spaces") && syncBranch.getBoolPref("peryn.spaces"),
    dots: doc.querySelectorAll(".peryn-space-dot").length,
    laptopEssential: gBrowser.tabs.some(t => t.pinned && t.label.includes("Weather from the laptop")),
  });
  await shot("11-after-sync");

  await report("spaces-keys", {
    afterCloseLast,
    afterNext,
    afterJump1: Store.get(spaces.active)?.name,
    workTabsHiddenInPersonal: workTabs.every(t => t.hidden),
    selected: gBrowser.selectedTab.label,
  });

  // ---- Command bar (C5) ----
  await commandBarScenario({ win, layout, open, sleep, shot, report });

  // ---- Split view with up to four panes (C6) ----
  await splitScenario({ win, layout, open, sleep, shot, report });

  // ---- Glance (C6) ----
  await glanceScenario({ win, layout, open, sleep, shot, report });

  // ---- First-run welcome and Arc import (C6) ----
  await onboardingScenario({ win, layout, sleep, shot, report });

  await IOUtils.writeUTF8(PathUtils.join(OUT, "finished"), "ok");
  await sleep(500);
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}

/** The command bar through its real wiring: Firefox's own keys, typing, Enter, the editor. */
async function commandBarScenario({ win, layout, open, sleep, shot, report }) {
  const doc = win.document;
  const { gBrowser } = win;
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { PerynCommandIndex } = ChromeUtils.importESModule(
    "resource://peryn-preview/commandbar/PerynCommandIndex.sys.mjs"
  );
  const { OmniIndex } = ChromeUtils.importESModule("resource://peryn-preview/commandbar/OmniIndex.sys.mjs");
  const bar = layout.commandBar;

  // A history to search: a few pages you'd recognise, then thousands of others.
  const now = Date.now();
  const words = "rust github sydney weather recipe pasta news docs mozilla garden travel hotel music guitar review map".split(" ");
  const pages = [
    { url: "https://www.rust-lang.org/learn", title: "Learn Rust - Rust Programming Language" },
    { url: "https://developer.mozilla.org/en-US/docs/Web/CSS", title: "CSS: Cascading Style Sheets | MDN" },
    { url: "https://news.ycombinator.com/", title: "Hacker News" },
  ];
  for (let i = 0; i < 3000; i++) {
    const title = [0, 1, 2].map(k => words[(i * 7 + k * 13) % words.length]).join(" ") + ` ${i}`;
    pages.push({ url: `https://site${i % 300}.example/page/${i}`, title });
  }
  await PlacesUtils.history.insertMany(
    pages.map((p, i) => ({
      ...p,
      visits: Array.from({ length: i < 3 ? 12 : 1 }, (_, v) => ({ date: new Date(now - (i + v) * 60000) })),
    }))
  );
  await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    url: "https://github.com/ZifuM/halcyon-browser",
    title: "Peryn on GitHub",
  });
  await PerynCommandIndex.ready();
  await PerynCommandIndex.loadPlaces();

  const input = doc.querySelector("#peryn-commandbar .hx-cb-input");
  const rows = () =>
    [...doc.querySelectorAll("#peryn-commandbar .hx-cb-row")].map(el => ({
      type: el.dataset.type,
      kind: el.dataset.kind,
      title: el.querySelector(".hx-cb-title")?.textContent,
      kbd: el.querySelector(".hx-cb-kbd")?.textContent ?? "",
    }));
  const type = async text => {
    input.value = text;
    input.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
    await sleep(400);
  };
  const press = (key, extra = {}) =>
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }));
  const isOpen = () => !doc.getElementById("peryn-commandbar").hidden;

  // Ctrl/Cmd+T: Firefox's own key, now pointed at the bar.
  const newTabKey = doc.getElementById("key_newNavigatorTab");
  const tabsBefore = gBrowser.tabs.length;
  newTabKey.doCommand();
  await sleep(1200);
  const opened = { open: isOpen(), mode: bar.mode, focused: doc.activeElement == input, keyRetargeted: !newTabKey.hasAttribute("command") };
  await type("rust");
  const rustRows = rows();
  await shot("12-commandbar-rust");
  await type("@tabs ");
  const chip = doc.querySelector("#peryn-commandbar .hx-cb-chip");
  const tabsFilter = { chip: !chip.hidden && chip.textContent, rows: rows().map(r => r.kind) };
  press("Escape"); // clears the filter
  await type("> zoom");
  const zoomRows = rows();
  await shot("13-commandbar-actions");
  // ">" became an "Actions" chip: clear the text, then Backspace removes the chip.
  await type("");
  press("Backspace");
  await sleep(300);
  const chipCleared = chip.hidden;
  await type("peryn on");
  const bookmarkRows = rows();
  await type("learn rust");
  press("Enter");
  await sleep(2500);
  const afterEnter = {
    closed: !isOpen(),
    newTab: gBrowser.tabs.length == tabsBefore + 1,
    url: gBrowser.currentURI.spec,
  };

  // Ctrl/Cmd+L: the bar on this page's address.
  doc.getElementById("focusURLBar").doCommand();
  await sleep(800);
  const address = { open: isOpen(), mode: bar.mode, value: input.value };
  await type("news");
  const newsRows = rows();
  press("Escape");
  await sleep(300);
  const escapeCloses = !isOpen();

  // Measured in this Firefox's own WebAssembly engine: 100,000 entries, typing letter by letter.
  const big = await OmniIndex.load();
  let seed = 7;
  const rand = n => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const vocab = [];
  for (let i = 0; i < 3000; i++) {
    vocab.push(words[i % words.length].slice(0, 2 + (i % 5)) + String.fromCharCode(97 + (i % 26)) + (i > 200 ? i : ""));
  }
  const t0 = ChromeUtils.now();
  for (let i = 0; i < 100000; i++) {
    const title = Array.from({ length: 3 + rand(5) }, () => vocab[Math.min(vocab.length - 1, Math.floor(rand(vocab.length) * Math.random() ** 2))]).join(" ");
    big.add(2, title, `https://${vocab[rand(400)]}.example/${rand(100000)}`, rand(100), rand(365));
  }
  big.prepare();
  const buildMs = ChromeUtils.now() - t0;
  const times = [];
  for (const phrase of ["rust g", "github pull", "sydney weather", "ghub", "travel hotel", "news 42", "docs css"]) {
    for (let end = 1; end <= phrase.length; end++) {
      const t = ChromeUtils.now();
      big.query(phrase.slice(0, end), { limit: 9 });
      times.push(ChromeUtils.now() - t);
    }
  }
  times.sort((a, b) => a - b);
  await report("commandbar-perf", {
    native: big.native,
    items: big.size,
    buildMs: Math.round(buildMs),
    medianMs: +times[times.length >> 1].toFixed(2),
    p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
    worstMs: +times.at(-1).toFixed(2),
  });

  await report("commandbar", { opened, rustRows, tabsFilter, zoomRows, chipCleared, bookmarkRows, afterEnter, address, newsRows, escapeCloses });

  // Keyboard shortcut editor: give Copy Link Ctrl+Shift+U, then take Ctrl+R (asks first),
  // then give Ctrl+R back.
  bar.runAction("shortcuts");
  await sleep(800);
  await type("copy link");
  const editorRows = rows();
  await shot("14-shortcut-editor");
  const record = async combo => {
    press("Enter");
    await sleep(100);
    press(combo.key, combo);
    await sleep(300);
  };
  await record({ key: "U", code: "KeyU", ctrlKey: true, shiftKey: true });
  const userKey = doc.getElementById("peryn-shortcut-copy-link");
  const first = { pref: Services.prefs.getStringPref("peryn.shortcuts", ""), key: userKey?.getAttribute("key"), modifiers: userKey?.getAttribute("modifiers") };
  await record({ key: "r", code: "KeyR", ctrlKey: true });
  const asked = rows()[0]?.title && doc.querySelector("#peryn-commandbar .hx-cb-sub")?.textContent;
  press("r", { code: "KeyR", ctrlKey: true });
  await sleep(300);
  const reloadKey = doc.getElementById("key_reload");
  const taken = { reloadDisabled: reloadKey.getAttribute("disabled") == "true", pref: Services.prefs.getStringPref("peryn.shortcuts", "") };
  await shot("15-shortcut-taken");
  press("Enter");
  await sleep(100);
  press("Backspace");
  await sleep(300);
  const givenBack = { reloadDisabled: reloadKey.getAttribute("disabled") == "true", ours: !!doc.getElementById("peryn-shortcut-copy-link") };
  press("Escape");
  await sleep(300);
  await report("shortcuts", { editorRows, first, asked, taken, givenBack });

  // Duplicate tabs: the same page is open in Personal and in Work.
  // (Pinned tabs and Essentials are never closed, so count only the closable repeats.)
  const Logic = ChromeUtils.importESModule("resource://peryn-preview/commandbar/PerynCommandLogic.sys.mjs");
  const repeats = () =>
    Logic.findDuplicates(
      gBrowser.tabs.filter(t => !t.closing).map(t => ({
        url: t.linkedBrowser.currentURI.spec,
        essential: t.pinned,
        pinned: t.hasAttribute("peryn-pinned"),
        selected: t.selected,
        lastAccessed: t.lastAccessed,
      }))
    ).reduce((n, g) => n + g.close.length, 0);
  const repeatsBefore = repeats();
  newTabKey.doCommand();
  await sleep(800);
  await type("@duplicates ");
  const duplicateRows = rows();
  await shot("16-duplicates");
  press("Escape");
  press("Escape");
  await sleep(300);
  bar.runAction("close-duplicates");
  await sleep(800);
  await report("duplicates", { repeatsBefore, duplicateRows, repeatsAfter: repeats() });

  // Off switch: Firefox's keys go back to what they did.
  Services.prefs.setBoolPref("peryn.commandbar.enabled", false);
  await sleep(300);
  const off = {
    newTabCommand: newTabKey.getAttribute("command"),
    addressCommand: doc.getElementById("focusURLBar").getAttribute("command"),
  };
  Services.prefs.clearUserPref("peryn.commandbar.enabled");
  await sleep(300);
  await report("commandbar-off", { off, backOn: !newTabKey.hasAttribute("command") });
}

/** Split view: Firefox's two panes, then three and four through Peryn's grid. */
async function splitScenario({ win, layout, open, sleep, shot, report }) {
  const { gBrowser } = win;
  const doc = win.document;
  const split = layout.split;
  const panels = doc.getElementById("tabbrowser-tabpanels");
  const area = () => panels.getBoundingClientRect();
  const rectOf = tab => {
    const r = doc.getElementById(tab.linkedPanel).getBoundingClientRect();
    const a = area();
    // As fractions of the content area, rounded, so the checks don't depend on window size.
    const f = v => Math.round(v * 100) / 100;
    return { x: f((r.left - a.left) / a.width), y: f((r.top - a.top) / a.height), w: f(r.width / a.width), h: f(r.height / a.height) };
  };
  const state = () => ({
    perynSplit: panels.getAttribute("peryn-split") || "",
    panes: Number(panels.getAttribute("peryn-panes") || 0),
    active: !!gBrowser.activeSplitView,
    tabs: gBrowser.activeSplitView?.tabs.length ?? 0,
  });

  const tabs = ["code", "weather", "recipes", "news"].map(p => open(`${p}.html`));
  gBrowser.selectedTab = tabs[0];
  await sleep(1500);

  gBrowser.addTabSplitView([tabs[0], tabs[1]]);
  await sleep(1200);
  const two = { ...state(), rects: tabs.slice(0, 2).map(rectOf) };

  split.add([tabs[2]]);
  await sleep(1200);
  const three = { ...state(), rects: tabs.slice(0, 3).map(rectOf) };
  await shot("17-split-three");

  split.add([tabs[3]]);
  await sleep(1200);
  const four = { ...state(), rects: tabs.map(rectOf) };
  await shot("18-split-grid");

  const cycled = [split.cycleLayout(), split.cycleLayout(), split.cycleLayout()];
  await sleep(600);
  const divider = doc.querySelector('.peryn-split-divider[data-kind="x"]');
  const before = rectOf(tabs[0]).w;
  divider?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  await sleep(600);
  const resized = { hasDivider: !!divider, before, after: rectOf(tabs[0]).w };

  gBrowser.removeTab(tabs[3]);
  await sleep(1500);
  const afterClose = { ...state(), rects: tabs.slice(0, 3).map(rectOf) };

  split.separate();
  await sleep(1000);
  const separated = state();
  // A tab dropped on the page's bottom edge: the two stacked.
  gBrowser.selectedTab = tabs[0];
  await sleep(600);
  const canDrop = split.canDrop(tabs[1]);
  split.dropTab(tabs[1], "bottom");
  await sleep(1200);
  const dropped = { canDrop, ...state(), rects: tabs.slice(0, 2).map(rectOf) };
  split.separate();
  await sleep(600);
  await report("split", { two, three, four, cycled, resized, afterClose, separated, dropped });
  for (const tab of tabs.slice(0, 3)) {
    gBrowser.removeTab(tab);
  }
  await sleep(500);
}

/** Glance: a real Alt+click in a page, the card over the page, Esc, Expand, Split, backdrop. */
async function glanceScenario({ win, layout, open, sleep, shot, report }) {
  const { gBrowser } = win;
  const doc = win.document;
  const glance = layout.glance;
  const panelOf = tab => doc.getElementById(tab.linkedPanel);
  const parent = open("links.html");
  gBrowser.selectedTab = parent;
  await sleep(2000);

  // Is Glance's page-side code running in the page?
  let actorReady = "no actor";
  try {
    const actor = parent.linkedBrowser.browsingContext.currentWindowGlobal.getActor("PerynGlance");
    actorReady = await Promise.race([actor.sendQuery("Glance:Ping").then(r => (r?.ready ? "ready" : "bad reply")), sleep(3000).then(() => "timeout")]);
  } catch (e) {
    actorReady = `error: ${e}`;
  }
  let clickPath = "";
  // Record what reaches the browser side from the page.
  const openCalls = [];
  const realOpen = glance.open.bind(glance);
  glance.open = (url, options = {}) => {
    const call = { url, fromSelected: options.fromBrowser == gBrowser.selectedBrowser, hasPrincipal: !!options.triggeringPrincipal };
    try {
      const tab = realOpen(url, options);
      Object.defineProperty(call, "tab", { value: tab, enumerable: false });
      call.result = tab ? "opened" : "null";
      call.stillPreview = !!tab?.hasAttribute("peryn-glance");
    } catch (e) {
      call.result = `threw: ${e}`;
    }
    openCalls.push(call);
    return call.tab ?? null;
  };
  const sameController = win.PerynGlance === glance;
  // And what the browser-side actor receives.
  const parentGot = [];
  const { PerynGlanceParent } = ChromeUtils.importESModule("resource://peryn-preview/glance/PerynGlanceParent.sys.mjs");
  const realReceive = PerynGlanceParent.prototype.receiveMessage;
  PerynGlanceParent.prototype.receiveMessage = function (message) {
    let note = message.name;
    try {
      const browser = this.browsingContext.top.embedderElement;
      note += ` browser=${!!browser} controller=${!!browser?.ownerGlobal?.PerynGlance}`;
    } catch (e) {
      note += ` error=${e}`;
    }
    parentGot.push(note);
    return realReceive.call(this, message);
  };
  // Alt+click on the lead link, sent to the window like a real click. First a plain click on
  // the same link in a scratch tab tells us whether synthesized clicks reach pages at all, and
  // which way (straight through, or through async pan/zoom) works here.
  const area = doc.getElementById("tabbrowser-tabpanels").getBoundingClientRect();
  const x = area.left + area.width / 2;
  const y = area.top + 220;
  const alt = Ci.nsIDOMWindowUtils.MODIFIER_ALT ?? 1;
  const clickAt = (modifiers, isAsyncEnabled) => {
    for (const type of ["mousemove", "mousedown", "mouseup"]) {
      win.synthesizeMouseEvent(type, x, y, { button: 0, modifiers }, { isAsyncEnabled });
    }
  };
  const probe = { sync: false, async: false };
  if (typeof win.synthesizeMouseEvent == "function") {
    clickPath = "window";
    for (const mode of ["sync", "async"]) {
      const scratch = open("links.html");
      gBrowser.selectedTab = scratch;
      await sleep(1800);
      try {
        clickAt(0, mode == "async");
      } catch (e) {
        log(`[scenario] ${mode} click failed: ${e}`);
      }
      for (let i = 0; i < 20 && !scratch.linkedBrowser.currentURI.spec.endsWith("recipes.html"); i++) {
        await sleep(100);
      }
      probe[mode] = scratch.linkedBrowser.currentURI.spec.endsWith("recipes.html");
      gBrowser.removeTab(scratch);
    }
    gBrowser.selectedTab = parent;
    await sleep(800);
    try {
      clickAt(alt, !probe.sync && probe.async);
    } catch (e) {
      log(`[scenario] synthesizing the Alt+click failed: ${e}`);
    }
  }
  let viaClick = false;
  for (let i = 0; i < 30 && !glance.current; i++) {
    await sleep(100);
  }
  viaClick = !!glance.current;
  glance.open = realOpen;
  PerynGlanceParent.prototype.receiveMessage = realReceive;
  let childSaw = null;
  try {
    const actor = parent.linkedBrowser.browsingContext.currentWindowGlobal.getActor("PerynGlance");
    childSaw = (await Promise.race([actor.sendQuery("Glance:Ping"), sleep(3000).then(() => ({ timeout: true }))]))?.last ?? "nothing";
  } catch (e) {
    childSaw = `error: ${e}`;
  }
  await sleep(300);
  const afterOpen = openCalls.map(c => ({ ...c, currentNow: !!glance.current, selectedLabel: gBrowser.selectedTab.label }));
  const pageSaw = parent.linkedBrowser.contentTitle;
  const pageUrlAfter = parent.linkedBrowser.currentURI.spec;
  if (!viaClick) {
    log("[scenario] Alt+click did not reach the page; opening the preview directly");
    glance.open(SITE + "recipes.html");
  }
  await sleep(1500);
  const card = glance.current;
  const f = v => Math.round(v * 100) / 100;
  const rel = r => ({ x: f((r.left - area.left) / area.width), y: f((r.top - area.top) / area.height), w: f(r.width / area.width), h: f(r.height / area.height) });
  const hit = (px, py) => {
    const el = doc.elementFromPoint(px, py);
    return el?.localName == "browser" ? (gBrowser.getTabForBrowser(el) == card ? "card" : el == parent.linkedBrowser ? "page" : "other-browser") : el?.className || el?.localName || "";
  };
  const opened = {
    actorReady,
    clickPath,
    probe,
    pageSaw,
    sameController,
    childSaw,
    parentGot,
    openCalls: afterOpen,
    pageUrlAfter,
    viaClick,
    open: !!card,
    url: card?.linkedBrowser.currentURI.spec ?? "",
    parentSelected: gBrowser.selectedTab == parent,
    pageVisible: win.getComputedStyle(panelOf(parent)).visibility,
    pageLive: parent.linkedBrowser.docShellIsActive,
    card: card ? rel(panelOf(card).getBoundingClientRect()) : null,
    page: rel(panelOf(parent).getBoundingClientRect()),
    hiddenInSidebar: card ? win.getComputedStyle(card).display == "none" : false,
    atCentre: hit(area.left + area.width / 2, area.top + area.height / 2),
    atEdge: hit(area.left + 12, area.top + area.height / 2),
    controls: [...doc.querySelectorAll(".peryn-glance-button")].filter(b => b.getBoundingClientRect().width > 0).length,
  };
  await shot("19-glance");

  // Esc in the previewed page closes it.
  gBrowser.selectedBrowser.focus();
  await sleep(300);
  const focusBeforeEsc = Services.focus.focusedElement == card?.linkedBrowser ? "card" : Services.focus.focusedElement?.localName ?? "none";
  let cardActor = "no actor";
  try {
    const actor = card.linkedBrowser.browsingContext.currentWindowGlobal.getActor("PerynGlance");
    cardActor = await Promise.race([actor.sendQuery("Glance:Ping").then(r => (r?.ready ? "ready" : "bad")), sleep(3000).then(() => "timeout")]);
  } catch (e) {
    cardActor = `error: ${e}`;
  }
  const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(Ci.nsITextInputProcessor);
  tip.beginInputTransactionForTests(win);
  const esc = new win.KeyboardEvent("", { key: "Escape", code: "Escape", keyCode: 27 });
  tip.keydown(esc);
  tip.keyup(esc);
  for (let i = 0; i < 30 && glance.current; i++) {
    await sleep(100);
  }
  const escaped = { focusBeforeEsc, cardActor, closed: !glance.current, backOnPage: gBrowser.selectedTab == parent, removed: !card?.isConnected };
  if (glance.current) {
    glance.close();
  }
  await sleep(500);

  // Expand keeps it as a tab, next to the page.
  glance.open(SITE + "weather.html");
  await sleep(1500);
  const kept = glance.current;
  const at = tab => gBrowser.tabs.indexOf(tab);
  const positions = { before: [at(kept), at(parent)] };
  doc.querySelector(".peryn-glance-expand").click();
  await sleep(800);
  positions.after = [at(kept), at(parent)];
  const expanded = {
    positions,
    selected: gBrowser.selectedTab == kept,
    ordinary: !kept.hasAttribute("peryn-glance"),
    nextToPage: at(kept) == at(parent) + 1,
    inSidebar: win.getComputedStyle(kept).display != "none",
    cardGone: !doc.documentElement.hasAttribute("peryn-glance-open"),
  };
  gBrowser.removeTab(kept);
  gBrowser.selectedTab = parent;
  await sleep(800);

  // Split puts them side by side.
  glance.open(SITE + "news.html");
  await sleep(1500);
  doc.querySelector(".peryn-glance-split").click();
  await sleep(1500);
  const split = { active: !!gBrowser.activeSplitView, tabs: gBrowser.activeSplitView?.tabs.length ?? 0, hasPage: !!gBrowser.activeSplitView?.tabs.includes(parent) };
  await shot("20-glance-split");
  const splitTabs = [...(gBrowser.activeSplitView?.tabs ?? [])];
  layout.split.separate();
  await sleep(800);
  for (const tab of splitTabs) {
    if (tab != parent) {
      gBrowser.removeTab(tab);
    }
  }
  gBrowser.selectedTab = parent;
  await sleep(800);

  // A click beside the card closes it.
  glance.open(SITE + "code.html");
  await sleep(1500);
  doc.querySelector(".peryn-glance-backdrop").dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
  await sleep(800);
  const backdrop = { closed: !glance.current, backOnPage: gBrowser.selectedTab == parent };

  await report("glance", { opened, escaped, expanded, split, backdrop });
  gBrowser.removeTab(parent);
  await sleep(500);
}

/** The welcome: shown, an Arc import into Spaces, protection choice, Esc closes for good. */
async function onboardingScenario({ win, layout, sleep, shot, report }) {
  const doc = win.document;
  const ob = layout.onboarding;
  const { PerynSpacesStore: Store } = ChromeUtils.importESModule("resource://peryn-preview/spaces/PerynSpacesStore.sys.mjs");
  const arc = {
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, "top"],
          spaces: [
            "s1",
            { id: "s1", title: "Studio", containerIDs: ["pinned", "p1", "unpinned", "u1"], customInfo: { iconType: { emoji_v2: "🎨" } } },
          ],
          items: [
            "top", { id: "top", childrenIds: ["f1"], data: { itemContainer: { containerType: { topApps: {} } } } },
            "f1", { id: "f1", parentID: "top", childrenIds: [], title: "Photos", data: { tab: { savedURL: SITE + "photos.html", savedTitle: "Photos" } } },
            "p1", { id: "p1", childrenIds: ["t1", "t2"], data: { itemContainer: { containerType: { spaceItems: { _0: "s1" } } } } },
            "t1", { id: "t1", parentID: "p1", childrenIds: [], title: "Design", data: { tab: { savedURL: SITE + "design.html", savedTitle: "Design" } } },
            "t2", { id: "t2", parentID: "p1", childrenIds: [], title: "Roadmap", data: { tab: { savedURL: SITE + "roadmap.html", savedTitle: "Roadmap" } } },
          ],
        },
      ],
    },
  };
  const path = PathUtils.join(OUT, "StorableSidebar.json");
  await IOUtils.writeUTF8(path, JSON.stringify(arc));
  const spacesBefore = Store.spaces.length;
  Services.prefs.setBoolPref("peryn.onboarding.done", false);

  ob.show();
  await sleep(1200);
  const root = doc.getElementById("peryn-onboarding");
  const visible = step => {
    const el = root?.querySelector(`.peryn-ob-step[data-step="${step}"]`);
    return !!el && !el.hidden && el.getBoundingClientRect().height > 0;
  };
  const shown = { open: ob.isOpen, welcome: visible("welcome"), logo: (root?.querySelector(".peryn-ob-logo")?.naturalWidth ?? 0) > 0 };
  await shot("21-welcome");

  ob.go(1);
  const result = await ob.importFromArc({ path });
  await sleep(1500);
  const studio = Store.spaces.find(s => s.name == "Studio");
  const imported = {
    importStep: visible("import"),
    text: root.querySelector(".peryn-ob-status").textContent,
    spacesAdded: Store.spaces.length - spacesBefore,
    studioPins: studio?.pins.map(p => p.title) ?? [],
    studioIcon: studio?.icon ?? "",
    essential: Store.data.essentials.some(e => e.url.endsWith("photos.html")),
    ok: !!result,
  };
  await shot("22-import-arc");

  // Zen: a compressed session file like Zen 1.18+ writes.
  const zenPath = PathUtils.join(OUT, "zen-sessions.jsonlz4");
  await IOUtils.writeJSON(
    zenPath,
    {
      spaces: [{ uuid: "{z1}", name: "Reading", icon: "📚", position: 1000 }],
      tabs: [
        { entries: [{ url: SITE + "news.html", title: "News" }], index: 1, pinned: true, zenWorkspace: "{z1}" },
        { entries: [{ url: SITE + "music.html", title: "Music" }], index: 1, pinned: true, zenEssential: true },
        { entries: [{ url: SITE + "code.html", title: "Code" }], index: 1, pinned: false, zenWorkspace: "{z1}" },
      ],
    },
    { compress: true }
  );
  const zenResult = await ob.importFromZen({ path: zenPath });
  await sleep(800);
  const reading = Store.spaces.find(s => s.name == "Reading");
  imported.zen = {
    ok: !!zenResult,
    text: root.querySelector(".peryn-ob-status").textContent,
    pins: reading?.pins.map(p => p.title) ?? [],
    icon: reading?.icon ?? "",
    essential: Store.data.essentials.some(e => e.url.endsWith("music.html")),
  };

  ob.go(3);
  ob.setProtection("balanced");
  await sleep(300);
  const balanced = Services.prefs.getStringPref("browser.contentblocking.category", "");
  const pressed = root.querySelector('[data-group="protection"][aria-pressed="true"]')?.dataset.choice;
  ob.setProtection("strict");
  await sleep(300);
  const strict = Services.prefs.getStringPref("browser.contentblocking.category", "");

  win.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await sleep(500);
  await report("onboarding", {
    shown,
    imported,
    protection: { balanced, pressed, strict },
    closed: { open: ob.isOpen, done: Services.prefs.getBoolPref("peryn.onboarding.done", false) },
  });
}
