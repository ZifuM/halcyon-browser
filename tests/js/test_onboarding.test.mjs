// Tests for first run: reading Arc's sidebar file, merging it into Spaces, and when the welcome
// shows itself.
import "./globals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const Arc = await import("moz-src:///browser/components/peryn/onboarding/PerynArcImport.sys.mjs");
const Onboarding = await import("moz-src:///browser/components/peryn/onboarding/PerynOnboarding.sys.mjs");
const Logic = await import("moz-src:///browser/components/peryn/spaces/PerynSpacesLogic.sys.mjs");

// A small StorableSidebar.json in Arc's shape: flat lists alternating ids and objects.
const tab = (id, parentID, url, title, savedTitle = title) => [id, { id, parentID, childrenIds: [], title, data: { tab: { savedURL: url, savedTitle } } }];
const folder = (id, parentID, title, childrenIds) => [id, { id, parentID, childrenIds, title, data: { list: {} } }];
const container = (id, containerType, childrenIds) => [id, { id, parentID: null, childrenIds, title: null, data: { itemContainer: { containerType } } }];
const color = (red, green, blue) => ({ color: { _0: { red, green, blue, alpha: 1 } } });

function arcFile() {
  const items = [
    ...container("top", { topApps: { _0: { default: {} } } }, ["fav1", "fav2", "favBad"]),
    ...tab("fav1", "top", "https://mail.example/", null, "Inbox"),
    ...tab("fav2", "top", "https://calendar.example/", "Calendar"),
    ...tab("favBad", "top", "arc://boosts", "A Boost"),
    ...container("pinWork", { spaceItems: { _0: "work" } }, ["t1", "f1", "t3"]),
    ...tab("t1", "pinWork", "https://github.com/", "GitHub"),
    ...folder("f1", "pinWork", "Docs", ["t2", "f2"]),
    ...tab("t2", "f1", "https://docs.example/a", "Doc A"),
    ...folder("f2", "f1", "Nested", ["t4"]),
    ...tab("t4", "f2", "https://docs.example/b", "", "Doc B"),
    ...tab("t3", "pinWork", "https://github.com/", "GitHub again"),
    ...container("todayWork", { spaceItems: { _0: "work" } }, ["t5"]),
    ...tab("t5", "todayWork", "https://news.example/", "Today's news"),
    ...container("pinHome", { spaceItems: { _0: "home" } }, ["t6"]),
    ...tab("t6", "pinHome", "https://recipes.example/", "Recipes"),
  ];
  const spaces = [
    "work",
    {
      id: "work",
      title: "Work",
      containerIDs: ["pinned", "pinWork", "unpinned", "todayWork"],
      customInfo: {
        iconType: { emoji_v2: "💼" },
        windowTheme: { background: { single: { _0: { style: { color: { _0: { blendedGradient: { _0: { baseColors: [color(0.1, 0.4, 0.95), color(0.6, 0.2, 0.9)] } } } } } } } } },
      },
    },
    "home",
    { id: "home", title: "Personal", containerIDs: ["pinned", "pinHome", "unpinned", "x"], customInfo: { iconType: { emoji: 127968 } } },
  ];
  return {
    sidebar: {
      containers: [{ global: {} }, { spaces, items, topAppsContainerIDs: [{ default: true }, "top"] }],
    },
    version: 1,
  };
}

test("Arc: Spaces with their pinned tabs (folders flattened), emoji and colour", () => {
  const parsed = Arc.parseArcSidebar(JSON.stringify(arcFile()));
  assert.equal(parsed.spaces.length, 2);
  const [work, home] = parsed.spaces;
  assert.equal(work.name, "Work");
  assert.equal(work.icon, "💼");
  assert.deepEqual(
    work.pins.map(p => [p.url, p.title]),
    [
      ["https://github.com/", "GitHub"],
      ["https://docs.example/a", "Doc A"],
      ["https://docs.example/b", "Doc B"],
    ],
    "nested folders flattened in order; the repeated GitHub tab once; today's tabs left out"
  );
  assert.ok(work.color.hue > 230 && work.color.hue < 290, `blue hue, got ${work.color.hue}`);
  assert.notEqual(work.color.hue2, work.color.hue, "gradient's second colour");
  assert.equal(home.icon, "🏠", "older files store the emoji as a code point");
  assert.equal(home.color, null);
});

test("Arc: Favorites become Essentials; non-web items are skipped and counted", () => {
  const parsed = Arc.parseArcSidebar(arcFile());
  assert.deepEqual(
    parsed.essentials.map(e => [e.url, e.title]),
    [
      ["https://mail.example/", "Inbox"],
      ["https://calendar.example/", "Calendar"],
    ]
  );
  assert.equal(parsed.skipped, 1);
});

test("Arc: newer files wrap entries as {value} and may only link children to parents", () => {
  const file = arcFile();
  const c = file.sidebar.containers[1];
  const wrap = list => list.map(x => (typeof x == "string" ? x : { value: x }));
  for (const item of c.items) {
    if (typeof item == "object" && item.id == "pinHome") item.childrenIds = [];
  }
  const synced = { sidebarSyncState: { container: { value: { spaces: wrap(c.spaces), items: wrap(c.items) } } } };
  const parsed = Arc.parseArcSidebar(synced);
  assert.deepEqual(parsed.spaces.map(s => s.name), ["Work", "Personal"]);
  assert.equal(parsed.spaces[1].pins[0].url, "https://recipes.example/");
  // Without topAppsContainerIDs, the topApps container is found by its type.
  assert.equal(parsed.essentials.length, 2);
});

test("Arc: a file that isn't Arc's gives a clear message", () => {
  assert.throws(() => Arc.parseArcSidebar("not json"), /isn't JSON/);
  assert.throws(() => Arc.parseArcSidebar({ hello: 1 }), /no Spaces/);
  assert.throws(() => Arc.parseArcSidebar({ spaces: [], items: [] }), /no Spaces or Favorites/);
});

test("Arc: loops in the item tree don't hang", () => {
  const file = { spaces: [{ id: "s", title: "S", containerIDs: ["pinned", "a"] }], items: [
    { id: "a", childrenIds: ["b"], data: { list: {} } },
    { id: "b", childrenIds: ["a", "t"], data: { list: {} } },
    { id: "t", data: { tab: { savedURL: "https://x.test/" } } },
  ] };
  assert.deepEqual(Arc.parseArcSidebar(file).spaces[0].pins.map(p => p.url), ["https://x.test/"]);
});

test("colour hues: red, green, blue land where OKLCH puts them; greys have none", () => {
  assert.ok(Math.abs(Arc.hueOf({ red: 1, green: 0, blue: 0 }) - 29) <= 2);
  assert.ok(Math.abs(Arc.hueOf({ red: 0, green: 1, blue: 0 }) - 142) <= 2);
  assert.ok(Math.abs(Arc.hueOf({ red: 0, green: 0, blue: 1 }) - 264) <= 2);
  assert.equal(Arc.hueOf({ red: 0.5, green: 0.5, blue: 0.5 }), null);
});

let seed = 1;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

test("merge: a new profile's lone Personal Space is replaced by Arc's Spaces", () => {
  const parsed = Arc.parseArcSidebar(arcFile());
  const { data, added, dropped } = Arc.mergeArcImport(Logic.defaultData(), parsed, random);
  assert.deepEqual(data.spaces.map(s => s.name), ["Work", "Personal"]);
  assert.deepEqual(added, { spaces: 2, pins: 4, essentials: 2 });
  assert.equal(dropped, 0);
  assert.equal(data.spaces[0].icon, "💼");
  assert.equal(data.essentials.length, 2);
  const ids = [...data.spaces.flatMap(s => s.pins), ...data.essentials].map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, "every launcher has its own id");
  assert.equal(Logic.serialize(data), Logic.serialize(Logic.normalizeData(data)), "valid Spaces data");
});

test("merge: with your own Spaces, Arc's are added after them and names don't clash", () => {
  let mine = Logic.defaultData();
  mine = Logic.updateSpace(mine, "s-personal", { pins: [{ id: "p-mine", url: "https://mine.test/", title: "Mine" }] });
  mine = { ...mine, essentials: [{ id: "p-e", url: "https://mail.example/", title: "Mail" }] };
  const { data, added } = Arc.mergeArcImport(mine, Arc.parseArcSidebar(arcFile()), random);
  assert.deepEqual(data.spaces.map(s => s.name), ["Personal", "Work", "Personal (Arc)"]);
  assert.equal(data.spaces[0].pins[0].url, "https://mine.test/");
  assert.deepEqual(data.essentials.map(e => e.url), ["https://mail.example/", "https://calendar.example/"], "an Essential you have already isn't doubled");
  assert.equal(added.essentials, 1);
});

test("merge: the Spaces limit is respected and what didn't fit is counted", () => {
  const many = { spaces: Array.from({ length: Logic.MAX_SPACES + 2 }, (_, i) => ({ name: `S${i}`, icon: "", color: null, pins: [{ url: `https://s${i}.test/`, title: "" }] })), essentials: [] };
  const { data, added, dropped } = Arc.mergeArcImport(Logic.defaultData(), many, random);
  assert.equal(data.spaces.length, Logic.MAX_SPACES);
  assert.equal(added.spaces, Logic.MAX_SPACES);
  assert.equal(dropped, 4);
});

test("import summary reads naturally", () => {
  assert.equal(
    Onboarding.importSummary({ added: { spaces: 2, pins: 4, essentials: 1 }, dropped: 0 }),
    "Imported 2 Spaces, 4 pinned tabs and 1 Favorite (now Essentials) from Arc."
  );
  assert.equal(
    Onboarding.importSummary({ added: { spaces: 1, pins: 0, essentials: 0 }, dropped: 1 }, 2),
    "Imported 1 Space from Arc. 3 items were left out (over the limits, or not a web page)."
  );
  assert.equal(Onboarding.importSummary({ added: { spaces: 0, pins: 0, essentials: 0 }, dropped: 0 }), "Nothing new to import from Arc.");
});

test("the welcome shows itself once, in the first normal window", () => {
  assert.ok(Onboarding.shouldShow({ done: false, isPrivate: false, otherWindows: 0 }));
  assert.ok(!Onboarding.shouldShow({ done: true, isPrivate: false, otherWindows: 0 }));
  assert.ok(!Onboarding.shouldShow({ done: false, isPrivate: true, otherWindows: 0 }));
  assert.ok(!Onboarding.shouldShow({ done: false, isPrivate: false, otherWindows: 1 }));
  assert.deepEqual(Onboarding.STEPS, ["welcome", "import", "look", "protection", "default"]);
  assert.equal(Onboarding.PROTECTION.balanced, "standard");
  assert.equal(Onboarding.THEMES.dark, "firefox-compact-dark@mozilla.org");
});

// ---- Zen ---------------------------------------------------------------------------------

const Zen = await import("moz-src:///browser/components/peryn/onboarding/PerynZenImport.sys.mjs");

const zenTab = (url, extra = {}) => ({ entries: [{ url: "https://old.example/", title: "Old" }, { url, title: `T ${url.split("/")[2]}` }], index: 2, ...extra });

function zenFile() {
  return {
    spaces: [
      { uuid: "{b}", name: "Work", icon: "💻", position: 2000, theme: { gradientColors: [{ c: [40, 90, 240] }, { c: [140, 60, 230] }] } },
      { uuid: "{a}", name: "Home", icon: "chrome://browser/skin/zen-icons/heart.svg", position: 1000 },
    ],
    tabs: [
      zenTab("https://mail.example/", { pinned: true, zenEssential: true, zenWorkspace: null }),
      zenTab("https://github.com/", { pinned: true, zenWorkspace: "{b}" }),
      zenTab("https://docs.example/", { pinned: true, zenWorkspace: "{b}", groupId: "f1" }),
      zenTab("https://news.example/", { pinned: false, zenWorkspace: "{b}" }),
      zenTab("https://recipes.example/", { pinned: true, zenWorkspace: "{a}" }),
      zenTab("about:newtab", { pinned: true, zenWorkspace: "{a}" }),
      zenTab("https://github.com/", { pinned: true, zenWorkspace: "{b}" }),
    ],
    folders: [{ id: "f1", name: "Docs", workspaceId: "{b}" }],
  };
}

test("Zen: Spaces in Zen's order, pinned tabs per Space, Essentials", () => {
  const parsed = Zen.parseZenSession(zenFile());
  assert.deepEqual(parsed.spaces.map(s => s.name), ["Home", "Work"]);
  const [home, work] = parsed.spaces;
  assert.equal(home.icon, "", "Zen's own SVG icons don't carry over");
  assert.equal(work.icon, "💻");
  assert.ok(work.color.hue > 230 && work.color.hue < 300, `blue, got ${work.color.hue}`);
  assert.deepEqual(work.pins.map(p => p.url), ["https://github.com/", "https://docs.example/"], "folders flattened, unpinned left out, repeats once");
  assert.equal(work.pins[0].title, "T github.com", "the tab's current page, not its history");
  assert.deepEqual(home.pins.map(p => p.url), ["https://recipes.example/"]);
  assert.deepEqual(parsed.essentials.map(e => e.url), ["https://mail.example/"]);
  assert.equal(parsed.skipped, 1, "about:newtab");
});

test("Zen: older session files keep tabs under windows and flags under attributes", () => {
  const old = { windows: [{ tabs: [zenTab("https://a.example/", { attributes: { zenEssential: "true" } }), zenTab("https://b.example/", { pinned: true, zenWorkspace: "{x}" })] }], spaces: [{ uuid: "{x}", name: "Main" }] };
  const parsed = Zen.parseZenSession(old);
  assert.deepEqual(parsed.essentials.map(e => e.url), ["https://a.example/"]);
  assert.deepEqual(parsed.spaces[0].pins.map(p => p.url), ["https://b.example/"]);
});

test("Zen: a file that isn't Zen's gives a clear message; merge names clashes (Zen)", () => {
  assert.throws(() => Zen.parseZenSession(null), /isn't Zen's/);
  assert.throws(() => Zen.parseZenSession({ hello: [1, 2] }), /no Spaces or tabs/);
  let mine = Logic.updateSpace(Logic.defaultData(), "s-personal", { name: "Home", pins: [{ id: "p-x", url: "https://x.test/", title: "" }] });
  const { data } = Arc.mergeImport(mine, Zen.parseZenSession(zenFile()), { source: "Zen", random });
  assert.deepEqual(data.spaces.map(s => s.name), ["Home", "Home (Zen)", "Work"]);
});
