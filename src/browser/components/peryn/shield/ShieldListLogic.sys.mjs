/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Shield filter lists: catalog, preprocessing and update timing. No browser APIs, so the same
// code runs in the browser, in Node tests (tests/js/) and in the CI list assembler
// (tools/shield/assemble.mjs) that feeds the Rust test harness (crates/shield-check).

const UASSETS = "https://ublockorigin.github.io/uAssets/";
const UASSETS_CDN = "https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/";
// The github.io site serves the repository's gh-pages branch, where third-party lists sit
// directly in thirdparties/; the CDN mirrors master, where they're in subfolders.
const both = (pagesPath, masterPath = pagesPath) => [UASSETS + pagesPath, UASSETS_CDN + masterPath];

/**
 * The lists Shield knows about. `defaultEnabled` mirrors uBlock Origin's default selection.
 * `engine` is the classifier feature whose engine the list feeds (see the Shield feature in
 * patches/toolkit/components/content-classifier/ContentClassifierService.cpp.patch).
 */
export const SHIELD_LISTS = Object.freeze([
  {
    id: "ublock-filters",
    name: "uBlock filters",
    category: "ads",
    defaultEnabled: true,
    urls: both("filters/filters.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "ublock-badware",
    name: "uBlock filters – Badware risks",
    category: "security",
    defaultEnabled: true,
    urls: both("filters/badware.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "ublock-privacy",
    name: "uBlock filters – Privacy",
    category: "privacy",
    defaultEnabled: true,
    urls: both("filters/privacy.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "ublock-quick-fixes",
    name: "uBlock filters – Quick fixes",
    category: "ads",
    defaultEnabled: true,
    urls: both("filters/quick-fixes.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "ublock-unbreak",
    name: "uBlock filters – Unbreak",
    category: "ads",
    defaultEnabled: true,
    urls: both("filters/unbreak.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "easylist",
    name: "EasyList",
    category: "ads",
    defaultEnabled: true,
    urls: both("thirdparties/easylist.txt", "thirdparties/easylist/easylist.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "easyprivacy",
    name: "EasyPrivacy",
    category: "privacy",
    defaultEnabled: true,
    urls: both("thirdparties/easyprivacy.txt", "thirdparties/easylist/easyprivacy.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "peter-lowe",
    name: "Peter Lowe's Ad and tracking server list",
    category: "ads",
    defaultEnabled: true,
    format: "hosts",
    // Only on master (the github.io site doesn't carry it).
    urls: [UASSETS_CDN + "thirdparties/pgl.yoyo.org/as/serverlist"],
    license: "McRae General Public License",
    homepage: "https://pgl.yoyo.org/adservers/",
  },
  // Cookie notices and nags (C7). Firefox 158 no longer has its own cookie-banner handling, so
  // these hide consent pop-ups and block the scripts that show them: without an answer, a site
  // has no consent. They're on by default.
  {
    id: "easylist-cookies",
    name: "EasyList Cookie notices",
    category: "annoyances",
    defaultEnabled: true,
    urls: both("thirdparties/easylist-cookies.txt", "thirdparties/easylist/easylist-cookies.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "ublock-cookies",
    name: "uBlock filters – Cookie notices",
    category: "annoyances",
    defaultEnabled: true,
    urls: both("filters/annoyances-cookies.txt"),
    license: "GPL-3.0",
    homepage: "https://github.com/uBlockOrigin/uAssets",
  },
  {
    id: "easylist-newsletters",
    name: "EasyList Newsletter pop-ups",
    category: "annoyances",
    defaultEnabled: true,
    urls: both("thirdparties/easylist-newsletters.txt", "thirdparties/easylist/easylist-newsletters.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "easylist-notifications",
    name: "EasyList Notification prompts",
    category: "annoyances",
    defaultEnabled: true,
    urls: both("thirdparties/easylist-notifications.txt", "thirdparties/easylist/easylist-notifications.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "easylist-chat",
    name: "EasyList Chat widgets",
    category: "annoyances",
    defaultEnabled: false,
    urls: both("thirdparties/easylist-chat.txt", "thirdparties/easylist/easylist-chat.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
  {
    id: "easylist-social",
    name: "EasyList Social widgets",
    category: "annoyances",
    defaultEnabled: false,
    urls: both("thirdparties/easylist-social.txt", "thirdparties/easylist/easylist-social.txt"),
    license: "GPL-3.0 OR CC-BY-SA-3.0",
    homepage: "https://easylist.to/",
  },
]);

/**
 * Values for `!#if` preprocessor tokens. We run Firefox's adblock engine (not uBlock Origin),
 * on desktop, without uBO-only capabilities such as HTML filtering. Unknown tokens are false.
 */
export const PREPROCESSOR_ENV = Object.freeze({
  env_firefox: true,
  env_gecko: true,
  env_chromium: false,
  env_edge: false,
  env_safari: false,
  env_mobile: false,
  env_mv3: false,
  ext_ublock: false,
  ext_ubol: false,
  adguard: false,
  cap_html_filtering: false,
  cap_ipaddress: false,
  cap_user_stylesheet: false,
});

export const MAX_INCLUDE_DEPTH = 3;

/**
 * Evaluate a `!#if` expression: tokens, `!`, `&&`, `||`, parentheses.
 *
 * @param {string} expr
 * @param {Record<string, boolean>} env
 * @returns {boolean}
 */
export function evalCondition(expr, env = PREPROCESSOR_ENV) {
  const tokens = expr.match(/\(|\)|!|&&|\|\||[A-Za-z0-9_]+/g) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function primary() {
    const tok = next();
    if (tok === "!") {
      return !primary();
    }
    if (tok === "(") {
      const value = or();
      if (next() !== ")") {
        throw new Error(`Unbalanced parentheses in "!#if ${expr}"`);
      }
      return value;
    }
    if (tok === undefined || !/^[A-Za-z0-9_]+$/.test(tok)) {
      throw new Error(`Bad token in "!#if ${expr}"`);
    }
    return env[tok] === true;
  }
  function and() {
    let value = primary();
    while (peek() === "&&") {
      next();
      value = primary() && value;
    }
    return value;
  }
  function or() {
    let value = and();
    while (peek() === "||") {
      next();
      value = and() || value;
    }
    return value;
  }
  const result = or();
  if (pos !== tokens.length) {
    throw new Error(`Trailing tokens in "!#if ${expr}"`);
  }
  return result;
}

/** Convert one hosts-file line ("0.0.0.0 ads.example.com") to a filter, or null. */
export function hostsLineToFilter(line) {
  const m = /^\s*(?:0\.0\.0\.0|127\.0\.0\.1)\s+([A-Za-z0-9.-]+)\s*(?:#.*)?$/.exec(line);
  if (!m) {
    return null;
  }
  const host = m[1].toLowerCase();
  if (host === "localhost" || host === "0.0.0.0" || !host.includes(".")) {
    return null;
  }
  return `||${host}^`;
}

/**
 * Resolve an `!#include` target against the including list's URL. Only files in the same
 * directory or below are allowed, so a list can't pull in arbitrary URLs.
 *
 * @returns {string | null}
 */
export function resolveInclude(name, baseUrl) {
  const target = name.trim();
  if (!/^[A-Za-z0-9._/-]+$/.test(target) || target.includes("..") || target.startsWith("/")) {
    return null;
  }
  const base = new URL(baseUrl);
  const dir = base.href.slice(0, base.href.lastIndexOf("/") + 1);
  return dir + target;
}

/**
 * Turn one downloaded list into engine-ready rule lines: evaluate `!#if` blocks, expand
 * `!#include` (recursively, same directory only), convert hosts-format lists, drop comments.
 *
 * @param {object} opts
 * @param {string} opts.url            where `text` came from (base for includes)
 * @param {string} opts.text
 * @param {"adblock"|"hosts"} [opts.format]
 * @param {(url: string) => Promise<string>} opts.fetchText   used for includes
 * @param {Record<string, boolean>} [opts.env]
 * @param {number} [opts.depth]
 * @param {(url: string, error: Error) => void} [opts.onIncludeError]
 *   Called when an include can't be fetched; the rest of the list is kept. Without it the
 *   error propagates and the whole list fails.
 * @returns {Promise<string[]>}
 */
export async function assembleList({
  url,
  text,
  format = "adblock",
  fetchText,
  env = PREPROCESSOR_ENV,
  depth = 0,
  onIncludeError,
}) {
  const out = [];
  // Stack of {active, taken}: `active` = lines here are kept; `taken` = an earlier branch ran.
  const stack = [];
  const isActive = () => stack.every(frame => frame.active);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("!#if ")) {
      const parentActive = isActive();
      const cond = parentActive && evalCondition(line.slice(5), env);
      stack.push({ active: cond, taken: cond, parentActive });
      continue;
    }
    if (line === "!#else") {
      const frame = stack.at(-1);
      if (frame) {
        frame.active = frame.parentActive && !frame.taken;
        frame.taken = true;
      }
      continue;
    }
    if (line === "!#endif") {
      stack.pop();
      continue;
    }
    if (!isActive()) {
      continue;
    }
    if (line.startsWith("!#include ")) {
      const target = resolveInclude(line.slice(10), url);
      if (target && depth < MAX_INCLUDE_DEPTH) {
        let included;
        try {
          included = await fetchText(target);
        } catch (e) {
          if (!onIncludeError) {
            throw e;
          }
          onIncludeError(target, e);
          continue;
        }
        out.push(
          ...(await assembleList({
            url: target,
            text: included,
            format,
            fetchText,
            env,
            depth: depth + 1,
            onIncludeError,
          }))
        );
      }
      continue;
    }
    if (!line || line.startsWith("!") || line.startsWith("[Adblock")) {
      continue;
    }
    if (format === "hosts") {
      if (line.startsWith("#")) {
        continue;
      }
      const filter = hostsLineToFilter(line);
      if (filter) {
        out.push(filter);
      }
      continue;
    }
    out.push(line);
  }
  return out;
}

/** "! Expires: 5 days" / "4 hours" -> hours, clamped to [4, 168]; default 24. */
export function parseExpiresHours(text) {
  const head = text.slice(0, 4096);
  const m = /^!\s*Expires:\s*(\d+)\s*(day|days|hour|hours|h|d)\b/im.exec(head);
  if (!m) {
    return 24;
  }
  const n = parseInt(m[1], 10);
  const hours = /^d/i.test(m[2]) ? n * 24 : n;
  return Math.min(168, Math.max(4, hours));
}

/**
 * Should a list be re-downloaded now?
 *
 * @param {{fetchedAtSec?: number, expiresHours?: number} | undefined} meta
 * @param {number} nowSec
 * @returns {boolean}
 */
export function isStale(meta, nowSec) {
  if (!meta?.fetchedAtSec || meta.fetchedAtSec > nowSec) {
    return true;
  }
  return nowSec - meta.fetchedAtSec >= (meta.expiresHours ?? 24) * 3600;
}

/** Lists enabled for this user: default selection, overridden per list by prefs. */
export function enabledLists(getOverride) {
  return SHIELD_LISTS.filter(list => {
    const override = getOverride(list.id);
    return override === undefined ? list.defaultEnabled : override;
  });
}
