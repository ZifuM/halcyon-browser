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

  await IOUtils.writeUTF8(PathUtils.join(OUT, "finished"), "ok");
  await sleep(500);
  Services.startup.quit(Ci.nsIAppStartup.eForceQuit);
}
