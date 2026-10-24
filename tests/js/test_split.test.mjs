// Tests for split view rules: layouts per pane count, the grid each produces, dividers.
import "./globals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const Logic = await import("moz-src:///browser/components/peryn/split/PerynSplitLogic.sys.mjs");

test("layouts per pane count, defaults first, cycling wraps", () => {
  assert.equal(Logic.layoutFor(2, ""), "columns");
  assert.equal(Logic.layoutFor(3, "grid"), "main", "grid needs four panes");
  assert.equal(Logic.layoutFor(4, "rows"), "rows");
  assert.equal(Logic.layoutFor(5, "grid"), null);
  assert.equal(Logic.nextLayout(3, "main"), "columns");
  assert.equal(Logic.nextLayout(3, "rows"), "main");
  assert.equal(Logic.nextLayout(2, "columns"), "rows");
});

test("two side-by-side panes stay Firefox's own split view", () => {
  assert.ok(Logic.isNative(2, "columns"));
  assert.ok(Logic.isNative(2, "nonsense"), "unknown layout falls back to columns");
  assert.ok(!Logic.isNative(2, "rows"));
  assert.ok(!Logic.isNative(3, "columns"));
});

test("every layout has one area per pane and valid tracks", () => {
  for (const [panes, layouts] of Object.entries(Logic.LAYOUTS)) {
    for (const layout of layouts) {
      const grid = Logic.gridFor(Number(panes), layout);
      const names = new Set(grid.areas.join(" ").replace(/"/g, "").split(/\s+/));
      assert.deepEqual([...names].sort(), Logic.AREAS.slice(0, Number(panes)), `${panes}:${layout}`);
      const cols = grid.areas[0].replace(/"/g, "").split(/\s+/).length;
      assert.equal(grid.columns.split("minmax").length - 1, cols, `${panes}:${layout} columns`);
      assert.equal(grid.rows.split("minmax").length - 1, grid.areas.length, `${panes}:${layout} rows`);
      assert.ok(Logic.LAYOUT_LABELS[layout]);
    }
  }
});

test("main layout: one large pane on the left, two stacked on the right", () => {
  const grid = Logic.gridFor(3, "main", { x: 0.6, y: 0.3 });
  assert.deepEqual(grid.areas, ['"a b"', '"a c"']);
  assert.equal(grid.columns, "minmax(0, 0.6fr) minmax(0, 0.4fr)");
  assert.match(grid.rows, /0\.3fr.*0\.7fr/);
  assert.deepEqual(grid.dividers, ["x", "y-right"]);
});

test("dividers stay between 20% and 80%", () => {
  assert.equal(Logic.ratioFromPointer(50, 1000), Logic.MIN_RATIO);
  assert.equal(Logic.ratioFromPointer(990, 1000), Logic.MAX_RATIO);
  assert.equal(Logic.ratioFromPointer(400, 1000), 0.4);
  assert.equal(Logic.ratioFromPointer(10, 0), 0.5);
  assert.equal(Logic.clampRatio("x"), 0.5);
  const grid = Logic.gridFor(4, "grid", { x: 0.05, y: 2 });
  assert.equal(grid.columns, "minmax(0, 0.2fr) minmax(0, 0.8fr)");
});

test("saved state is read defensively", () => {
  assert.deepEqual(Logic.readState(""), { layout: "", x: 0.5, y: 0.5 });
  assert.deepEqual(Logic.readState("{bad"), { layout: "", x: 0.5, y: 0.5 });
  assert.deepEqual(Logic.readState('{"layout":"grid","x":0.3,"y":0.9}'), { layout: "grid", x: 0.3, y: 0.8 });
  assert.deepEqual(Logic.readState("[1,2]"), { layout: "", x: 0.5, y: 0.5 });
});

test("joinable: unpinned tabs not already split, four panes at most", () => {
  const t = (extra = {}) => ({ pinned: false, splitview: null, closing: false, ...extra });
  const a = t(), b = t(), c = t(), d = t(), e = t();
  assert.deepEqual(Logic.joinable([a, b], [c, d, e]), [c, d]);
  assert.deepEqual(Logic.joinable([a, b, c, d], [e]), []);
  assert.deepEqual(Logic.joinable([a], [t({ pinned: true }), t({ splitview: {} }), t({ closing: true }), a, b]), [b]);
});

// ---- motion (shared with Glance) -------------------------------------------------------------

const Motion = await import("moz-src:///browser/components/peryn/layout/PerynMotion.sys.mjs");

test("motion: CSS times from the tokens, capped and defensive", () => {
  assert.equal(Motion.parseTime("200ms"), 200);
  assert.equal(Motion.parseTime(" 0.25s "), 250);
  assert.equal(Motion.parseTime("0ms"), 0);
  assert.equal(Motion.parseTime("9s"), 600);
  assert.equal(Motion.parseTime(""), 0);
  assert.equal(Motion.parseTime("var(--x)"), 0);
});

test("motion: FLIP keyframes map the new box back onto the old one", () => {
  const before = { left: 0, top: 0, width: 1000, height: 800 };
  const after = { left: 500, top: 0, width: 500, height: 400 };
  const [from, to] = Motion.flipFrames(before, after);
  assert.equal(from.transform, "translate(-500px, 0px) scale(2, 2)");
  assert.equal(from.transformOrigin, "0 0");
  assert.equal(to.transform, "none");
  assert.equal(Motion.flipFrames(after, { ...after, left: 500.4 }), null, "no visible change");
  assert.equal(Motion.flipFrames({ left: 0, top: 0, width: 0, height: 0 }, after), null);
});

function fakeWin(duration) {
  return {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: name => (name.startsWith("--hx-duration") ? duration : "linear") }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}
function box(rect) {
  return {
    rect,
    isConnected: true,
    animations: [],
    getBoundingClientRect() {
      return this.rect;
    },
    animate(frames, options) {
      this.animations.push({ frames, options });
      return { finished: Promise.resolve(), cancel() {} };
    },
  };
}

test("motion: elements glide from old to new boxes; new ones fade in; off means no animation", () => {
  const moved = box({ left: 0, top: 0, width: 1000, height: 800 });
  const added = box({ left: 0, top: 0, width: 1000, height: 800 });
  const m = new Motion.Motion(fakeWin("200ms"));
  m.flip([moved, added], () => {
    moved.rect = { left: 0, top: 0, width: 500, height: 800 };
    added.rect = { left: 500, top: 0, width: 500, height: 800 };
  }, { enter: [added] });
  assert.match(moved.animations[0].frames[0].transform, /scale\(2, 1\)/);
  assert.equal(moved.animations[0].options.duration, 200);
  assert.deepEqual(added.animations[0].frames, Motion.ENTER_FRAMES);

  const still = box({ left: 0, top: 0, width: 10, height: 10 });
  let changed = false;
  new Motion.Motion(fakeWin("0ms")).flip([still], () => (changed = true));
  assert.ok(changed && still.animations.length == 0, "reduced motion: change only");
});

test("drag to split: nearest edge wins, and decides order and layout", () => {
  assert.equal(Logic.dropZone(50, 400, 1000, 800), "left");
  assert.equal(Logic.dropZone(950, 400, 1000, 800), "right");
  assert.equal(Logic.dropZone(500, 30, 1000, 800), "top");
  assert.equal(Logic.dropZone(500, 790, 1000, 800), "bottom");
  assert.equal(Logic.dropZone(300, 100, 1000, 800), "top", "closer to the top than the left");
  assert.deepEqual(Logic.splitForZone("left"), { first: "dropped", layout: "columns" });
  assert.deepEqual(Logic.splitForZone("bottom"), { first: "page", layout: "rows" });
  assert.deepEqual(Logic.zoneBox("right"), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.equal(Logic.TAB_DROP_TYPE, "application/x-moz-tabbrowser-tab");
});
