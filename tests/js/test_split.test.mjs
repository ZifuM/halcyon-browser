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
