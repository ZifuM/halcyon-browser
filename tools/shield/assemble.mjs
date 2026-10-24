// Assemble Shield's filter lists exactly as the browser does (same module), for the Rust harness.
//
//   node tools/shield/assemble.mjs --out DIR                  # download (CI)
//   node tools/shield/assemble.mjs --out DIR --source-dir uAssets-checkout   # offline
//   add --all to include lists that are off by default
//
// Writes DIR/<list-id>.txt (one engine rule per line) and prints a summary. Exits 1 if any
// enabled list can't be fetched from either of its URLs.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const logicPath = path.join(here, "../../src/browser/components/peryn/shield/ShieldListLogic.sys.mjs");
const { SHIELD_LISTS, assembleList } = await import(logicPath);

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = opt("--out");
const sourceDir = opt("--source-dir");
const includeAll = args.includes("--all");
if (!outDir) {
  console.error("usage: assemble.mjs --out DIR [--source-dir DIR] [--all]");
  process.exit(2);
}

const MIRROR_PREFIXES = ["https://ublockorigin.github.io/uAssets/", "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/"];

async function fetchText(url) {
  if (sourceDir) {
    const prefix = MIRROR_PREFIXES.find(p => url.startsWith(p));
    if (!prefix) {
      throw new Error(`--source-dir can't map ${url}`);
    }
    const file = path.join(sourceDir, url.slice(prefix.length));
    if (!existsSync(file)) {
      throw new Error(`missing ${file}`);
    }
    return readFileSync(file, "utf8");
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  return response.text();
}

mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const list of SHIELD_LISTS) {
  if (!list.defaultEnabled && !includeAll) {
    continue;
  }
  let text = null;
  let usedUrl = null;
  const errors = [];
  for (const url of list.urls) {
    try {
      text = await fetchText(url);
      usedUrl = url;
      break;
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (text === null) {
    failed++;
    console.log(`FAIL ${list.id}: ${errors.join("; ")}`);
    continue;
  }
  const includeErrors = [];
  const rules = await assembleList({
    url: usedUrl,
    text,
    format: list.format,
    onIncludeError: (u, e) => includeErrors.push(`${u}: ${e.message}`),
    fetchText: async u => {
      // Includes come from the same mirror as their parent; fall back to the other mirror.
      try {
        return await fetchText(u);
      } catch (e) {
        const other = MIRROR_PREFIXES.find(p => !u.startsWith(p));
        const current = MIRROR_PREFIXES.find(p => u.startsWith(p));
        if (sourceDir || !other || !current) {
          throw e;
        }
        return fetchText(other + u.slice(current.length));
      }
    },
  });
  writeFileSync(path.join(outDir, `${list.id}.txt`), rules.join("\n") + "\n");
  if (includeErrors.length) {
    failed++;
    console.log(`FAIL ${list.id}: includes not fetched: ${includeErrors.join("; ")}`);
  } else {
    console.log(`ok   ${list.id.padEnd(20)} ${String(rules.length).padStart(7)} rules  (${usedUrl})`);
  }
}
process.exit(failed ? 1 : 0);
