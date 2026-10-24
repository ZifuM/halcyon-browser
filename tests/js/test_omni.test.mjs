// Tests for the command bar's index: the WebAssembly build of crates/omni-index through its
// JavaScript wrapper, and the JavaScript fallback. Build the module first:
//   python3 tools/omni/build_wasm.py
import "./globals.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const { OmniIndex, SimpleIndex, KIND, ALL_KINDS } = await import(
  "moz-src:///browser/components/peryn/commandbar/OmniIndex.sys.mjs"
);

const WASM = fileURLToPath(
  new URL("../../src/browser/components/peryn/commandbar/omni_index.wasm", import.meta.url)
);
const bytes = await readFile(WASM);
const makeWasm = () => OmniIndex.fromBytes(bytes);

function fill(index) {
  return [
    index.add(KIND.history, "GitHub: Let's build from here", "https://github.com/", 80, 1),
    index.add(KIND.history, "Rust Programming Language", "https://www.rust-lang.org/learn", 40, 10),
    index.add(KIND.tab, "Pull requests · halcyon-browser", "https://github.com/ZifuM/halcyon-browser/pulls", 10, 0),
    index.add(KIND.bookmark, "Mozilla Developer Network", "https://developer.mozilla.org/en-US/", 30, 30),
    index.add(KIND.action, "New Space", "create add workspace", 50, 0),
    index.add(KIND.history, "Café menu — 東京", "https://café.example/", 1, 1),
  ];
}

for (const [name, make] of [
  ["wasm", makeWasm],
  ["fallback", async () => new SimpleIndex()],
]) {
  test(`${name}: every word must match, open tabs first`, async () => {
    const index = await make();
    const ids = fill(index);
    assert.equal(index.size, 6);
    const github = index.query("github").map(h => h.id);
    assert.deepEqual(github.slice(0, 2), [ids[2], ids[0]]);
    assert.deepEqual(index.query("rust learn").map(h => h.id), [ids[1]]);
    assert.deepEqual(index.query("rust banana"), []);
  });

  test(`${name}: kinds filter, limits, empty query`, async () => {
    const index = await make();
    const ids = fill(index);
    assert.deepEqual(index.query("git", { kinds: 1 << KIND.tab }).map(h => h.id), [ids[2]]);
    assert.equal(index.query("e", { limit: 2 }).length, 2);
    assert.equal(index.query("").at(0).id, ids[2], "nothing typed: tabs first");
    assert.deepEqual(index.query("workspace", { kinds: 1 << KIND.action }).map(h => h.id), [ids[4]]);
  });

  test(`${name}: non-ASCII text, removal, touch`, async () => {
    const index = await make();
    const ids = fill(index);
    assert.deepEqual(index.query("CAFÉ").map(h => h.id), [ids[5]]);
    assert.deepEqual(index.query("東京").map(h => h.id), [ids[5]]);
    assert.equal(index.remove(ids[5]), true);
    assert.equal(index.remove(ids[5]), false);
    assert.deepEqual(index.query("café"), []);
    const a = index.add(KIND.history, "Notes A", "https://a.example/", 1, 100);
    const b = index.add(KIND.history, "Notes B", "https://b.example/", 50, 1);
    assert.equal(index.query("notes")[0].id, b);
    index.touch(a, 100, 0);
    assert.equal(index.query("notes")[0].id, a);
  });

  test(`${name}: unknown kinds are rejected`, async () => {
    const index = await make();
    assert.throws(() => index.add(9, "x", "y"), /unknown kind/);
  });
}

test("wasm: memory growth keeps strings and results intact", async () => {
  const index = await makeWasm();
  const long = "ø".repeat(5000);
  for (let i = 0; i < 20000; i++) {
    index.add(KIND.history, `Page ${i} ${long.slice(0, i % 50)}`, `https://site${i % 97}.example/p/${i}`, i % 100, i % 30);
  }
  index.add(KIND.history, `needle ${long}`, "https://needle.example/", 5, 5);
  index.prepare();
  const hits = index.query("needle");
  assert.equal(hits.length, 1);
  assert.equal(index.query("site71 p/4242").length, 1);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.add(KIND.tab, "after clear", "https://x.example/"), 0);
});

test("load(): falls back to the JavaScript index when the module can't be read", async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const fallback = await OmniIndex.load({ readBytes: async () => Promise.reject(new Error("missing")) });
    assert.equal(fallback.native, false);
    const real = await OmniIndex.load({ readBytes: async () => bytes });
    assert.equal(real.native, true);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
});

test("wasm: keystroke latency over a large history", async () => {
  const index = await makeWasm();
  const words = "rust github sydney weather recipe pasta news docs mozilla firefox garden travel hotel music guitar review map pull request issue".split(" ");
  let seed = 7;
  const rand = n => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % n;
  };
  const n = Number(process.env.OMNI_ITEMS ?? 100000);
  const build = performance.now();
  for (let i = 0; i < n; i++) {
    const title = Array.from({ length: 2 + rand(5) }, () => words[rand(words.length)] + (rand(3) ? "" : rand(1000))).join(" ");
    index.add(KIND.history, title, `https://${words[rand(words.length)]}${rand(400)}.example/${rand(100000)}`, rand(100), rand(365));
  }
  index.prepare();
  const buildMs = performance.now() - build;
  const times = [];
  for (const phrase of ["rust g", "github pull", "sydney weather", "ghub", "travel hotel map", "news 42"]) {
    for (let end = 1; end <= phrase.length; end++) {
      const t = performance.now();
      index.query(phrase.slice(0, end), { kinds: ALL_KINDS, limit: 10 });
      times.push(performance.now() - t);
    }
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`  ${n} items built in ${buildMs.toFixed(0)} ms; per keystroke median ${times[times.length >> 1].toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, worst ${times.at(-1).toFixed(2)} ms`);
  // Generous for shared CI machines; the native benchmark has the tight budget.
  assert.ok(p95 < 25, `p95 ${p95.toFixed(1)} ms`);
});
