/* Halcyon UI preview harness (CI only, never shipped). Loaded by halcyon-preview.cfg.
 *
 * Registers our layout's window hooks the way halcyon.manifest does (pointing at
 * resource://halcyon-preview/, which the .cfg maps to src/browser/components/halcyon/), then
 * scripts a session (Essentials, Pinned, Today tabs) and walks through the layout states. At
 * each state it writes <name>.ready to $HALCYON_PREVIEW_OUT and waits for run_preview.py to take
 * a screenshot and write <name>.done. Console errors go to console.log in the same folder. */

const OUT = Services.env.get("HALCYON_PREVIEW_OUT");
const SITE = Services.env.get("HALCYON_PREVIEW_SITE");
const LAYOUT = "resource://halcyon-preview/layout/HalcyonLayout.sys.mjs";

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
          } else if (/halcyon/i.test(message.message)) {
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
        if (/halcyon/i.test(text) || /halcyon/i.test(msg.filename || "")) {
          log(`[console.${msg.level}] ${text} (${msg.filename}:${msg.lineNumber})`);
        }
      }
    }, "console-api-log-event");
    for (const [category, method] of [
      ["browser-before-ui-startup", "HalcyonLayout.init"],
      ["browser-window-before-initial-xul-layout", "HalcyonLayout.beforeLayout"],
      ["browser-window-domcontentloaded", "HalcyonLayout.onDOMContentLoaded"],
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

  const { HalcyonLayout } = ChromeUtils.importESModule(LAYOUT);
  const layout = HalcyonLayout.forWindow(win);
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
      pinned: t.hasAttribute("halcyon-pinned"),
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
    copyLinkWidget: !!CustomizableUI.getWidget("halcyon-copy-link-button")?.provider,
    copyLinkAfterUrlbar:
      CustomizableUI.getWidgetIdsInArea("nav-bar").indexOf("halcyon-copy-link-button") ==
      CustomizableUI.getWidgetIdsInArea("nav-bar").indexOf("urlbar-container") + 1,
    toolbarSetupDone: Services.prefs.getBoolPref("halcyon.layout.toolbarSetupDone", false),
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
    compact: root.hasAttribute("halcyon-compact"),
    reveal: root.getAttribute("halcyon-reveal") || "",
  });
  doc.getElementById("halcyon-key-compact").doCommand();
  await sleep(1200);
  const afterToggle = compactState();
  await shot("04-compact");
  doc.getElementById("halcyon-edge-sidebar").dispatchEvent(new win.MouseEvent("mouseenter"));
  await sleep(900);
  const afterEdge = compactState();
  await shot("05-compact-sidebar");
  win.gURLBar.focus();
  await sleep(900);
  const afterFocus = compactState();
  await shot("06-compact-both");
  doc.getElementById("halcyon-edge-sidebar").dispatchEvent(new win.MouseEvent("mouseleave"));
  gBrowser.selectedBrowser.focus();
  await sleep(1000);
  const afterLeave = compactState();
  doc.getElementById("halcyon-key-compact").doCommand();
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
  const { HalcyonSpacesStore: Store } = ChromeUtils.importESModule(
    "resource://halcyon-preview/spaces/HalcyonSpacesStore.sys.mjs"
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
    header: doc.querySelector("#halcyon-space-header .halcyon-space-name")?.textContent,
    dots: doc.querySelectorAll(".halcyon-space-dot").length,
    visibleTodayTabs: gBrowser.visibleTabs.filter(t => !t.pinned).map(t => t.label),
    pinsInWork: Store.get(work.id).pins.map(p => p.title || p.url),
    hueOnWindow: root.style.getPropertyValue("--hx-space-hue"),
  });
  await shot("08-space-work");

  const header = doc.getElementById("halcyon-space-header");
  const editor = doc.getElementById("halcyon-space-editor");
  const editorShown = new Promise(resolve => editor.addEventListener("popupshown", resolve, { once: true }));
  spaces.ui.openEditor(work.id, header);
  await Promise.race([editorShown, sleep(3000)]);
  await sleep(400);
  await shot("09-space-editor");
  editor.hidePopup();
  await sleep(400);

  doc.getElementById("halcyon-key-space-next").doCommand();
  await sleep(900);
  const afterNext = Store.get(spaces.active)?.name;
  await shot("10-space-weekend");
  // Closing a Space's last tab keeps you in that Space (a fresh tab), not in another Space.
  const weekendId = spaces.active;
  gBrowser.removeTab(gBrowser.selectedTab);
  await sleep(800);
  const afterCloseLast = {
    stayed: spaces.active == weekendId,
    selectedInSpace: gBrowser.selectedTab.getAttribute("halcyon-space") == weekendId,
  };
  doc.getElementById("halcyon-key-space-1").doCommand();
  await sleep(900);
  // Another machine's changes arriving through Firefox Sync: its prefs engine writes the synced
  // pref, exactly like this. A new Space and a new Essential should appear here.
  const syncBranch = Services.prefs.getBranch("services.sync.prefs.sync.");
  const remote = structuredClone(Store.data);
  remote.spaces.push({ id: "s-laptop", name: "Laptop", icon: "💻", color: { hue: 200, hue2: 240, chroma: 0.05 }, pins: [] });
  remote.essentials.push({ id: "e-laptop", url: `${SITE}weather.html`, title: "Weather from the laptop" });
  Services.prefs.setStringPref("halcyon.spaces", JSON.stringify(remote));
  await sleep(1500);
  await report("sync", {
    syncedByFirefoxSync: syncBranch.getChildList("").includes("halcyon.spaces") && syncBranch.getBoolPref("halcyon.spaces"),
    dots: doc.querySelectorAll(".halcyon-space-dot").length,
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

  await IOUtils.writeUTF8(PathUtils.join(OUT, "finished"), "ok");
  await sleep(500);
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}

/** The command bar through its real wiring: Firefox's own keys, typing, Enter, the editor. */
async function commandBarScenario({ win, layout, open, sleep, shot, report }) {
  const doc = win.document;
  const { gBrowser } = win;
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const { HalcyonCommandIndex } = ChromeUtils.importESModule(
    "resource://halcyon-preview/commandbar/HalcyonCommandIndex.sys.mjs"
  );
  const { OmniIndex } = ChromeUtils.importESModule("resource://halcyon-preview/commandbar/OmniIndex.sys.mjs");
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
    title: "Halcyon on GitHub",
  });
  await HalcyonCommandIndex.ready();
  await HalcyonCommandIndex.loadPlaces();

  const input = doc.querySelector("#halcyon-commandbar .hx-cb-input");
  const rows = () =>
    [...doc.querySelectorAll("#halcyon-commandbar .hx-cb-row")].map(el => ({
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
  const isOpen = () => !doc.getElementById("halcyon-commandbar").hidden;

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
  const chip = doc.querySelector("#halcyon-commandbar .hx-cb-chip");
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
  await type("halcyon on");
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
  const userKey = doc.getElementById("halcyon-shortcut-copy-link");
  const first = { pref: Services.prefs.getStringPref("halcyon.shortcuts", ""), key: userKey?.getAttribute("key"), modifiers: userKey?.getAttribute("modifiers") };
  await record({ key: "r", code: "KeyR", ctrlKey: true });
  const asked = rows()[0]?.title && doc.querySelector("#halcyon-commandbar .hx-cb-sub")?.textContent;
  press("r", { code: "KeyR", ctrlKey: true });
  await sleep(300);
  const reloadKey = doc.getElementById("key_reload");
  const taken = { reloadDisabled: reloadKey.getAttribute("disabled") == "true", pref: Services.prefs.getStringPref("halcyon.shortcuts", "") };
  await shot("15-shortcut-taken");
  press("Enter");
  await sleep(100);
  press("Backspace");
  await sleep(300);
  const givenBack = { reloadDisabled: reloadKey.getAttribute("disabled") == "true", ours: !!doc.getElementById("halcyon-shortcut-copy-link") };
  press("Escape");
  await sleep(300);
  await report("shortcuts", { editorRows, first, asked, taken, givenBack });

  // Duplicate tabs: the same page is open in Personal and in Work.
  const pages = () => gBrowser.tabs.filter(t => !t.closing).map(t => t.linkedBrowser.currentURI.spec.replace(/#.*/, ""));
  const repeats = () => pages().filter((u, i, all) => all.indexOf(u) != i && !/^about:/.test(u)).length;
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
  Services.prefs.setBoolPref("halcyon.commandbar.enabled", false);
  await sleep(300);
  const off = {
    newTabCommand: newTabKey.getAttribute("command"),
    addressCommand: doc.getElementById("focusURLBar").getAttribute("command"),
  };
  Services.prefs.clearUserPref("halcyon.commandbar.enabled");
  await sleep(300);
  await report("commandbar-off", { off, backOn: !newTabKey.hasAttribute("command") });
}
