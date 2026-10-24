/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Pure helpers for Shield's element hiding (cosmetic filtering). No Firefox APIs here, so the
// unit tests run them directly.
//
// How element hiding works:
//   1. When a page's document element appears, the child actor asks the parent for the page's
//      site resources. The parent asks the content classifier service, which looks them up in
//      the same adblock engines that block network requests (getCosmeticResources). It answers
//      with a stylesheet of site-specific and generic non-class/id selectors.
//   2. Once the DOM is parsed, and as it changes, the child sends the classes and ids it hasn't
//      seen yet; the parent answers with a stylesheet of the generic rules that match them
//      (getHiddenClassIdSelectors), unless the page has a $generichide exception.
//   3. Sheets are user-level and !important, so a page's own CSS can't un-hide an element.

/** Selectors per rule. Each rule wraps its group in :is(), whose forgiving parsing drops an
 * invalid selector instead of the whole rule, so one bad list entry can't disable its group. */
export const SELECTORS_PER_RULE = 256;

/** At most this many new classes + ids go into one generic lookup. */
export const MAX_TOKENS_PER_QUERY = 2048;

/** Stop collecting once a page has produced this many distinct tokens (infinite-scroll pages
 * with generated class names would otherwise grow forever). */
export const MAX_TOKENS_PER_PAGE = 20000;

/**
 * A selector that could escape its rule (`{`, `}`), open a comment or contain a NUL is dropped.
 * Lists are trusted, but a stylesheet that can be broken out of could restyle any page.
 */
export function isSafeSelector(selector) {
  return (
    typeof selector == "string" &&
    selector.length > 0 &&
    selector.length <= 4096 &&
    !/[{}\0]/.test(selector) &&
    !selector.includes("/*") &&
    !selector.includes("*/") &&
    !/<\/?style/i.test(selector)
  );
}

/** Pseudo-elements aren't allowed inside :is(); those selectors get a rule of their own. */
function hasPseudoElement(selector) {
  return /::[a-z-]+/i.test(selector);
}

/**
 * The stylesheet text that hides `selectors` (iterable of strings). Duplicates and unsafe
 * selectors are dropped. Returns "" when nothing is left to hide.
 */
export function buildHideStylesheet(selectors) {
  const grouped = [];
  const alone = [];
  const seen = new Set();
  for (const selector of selectors) {
    const s = typeof selector == "string" ? selector.trim() : selector;
    if (!isSafeSelector(s) || seen.has(s)) {
      continue;
    }
    seen.add(s);
    (hasPseudoElement(s) ? alone : grouped).push(s);
  }
  const rules = [];
  for (let i = 0; i < grouped.length; i += SELECTORS_PER_RULE) {
    const group = grouped.slice(i, i + SELECTORS_PER_RULE).join(",\n");
    rules.push(`:is(${group}) { display: none !important; }`);
  }
  for (const s of alone) {
    rules.push(`${s} { display: none !important; }`);
  }
  return rules.join("\n");
}

/** A `data:` URI for a stylesheet, for nsIDOMWindowUtils.loadSheetUsingURIString. */
export function stylesheetDataURI(css) {
  return "data:text/css;charset=utf-8," + encodeURIComponent(css);
}

/**
 * Tracks the classes and ids already sent for one document, and hands out only new ones.
 */
export class TokenCollector {
  constructor({ maxPerQuery = MAX_TOKENS_PER_QUERY, maxPerPage = MAX_TOKENS_PER_PAGE } = {}) {
    this.maxPerQuery = maxPerQuery;
    this.maxPerPage = maxPerPage;
    this.seenClasses = new Set();
    this.seenIds = new Set();
    this.pendingClasses = [];
    this.pendingIds = [];
  }

  get seenCount() {
    return this.seenClasses.size + this.seenIds.size;
  }

  get full() {
    return this.seenCount >= this.maxPerPage;
  }

  /** Record the classes and ids of one element (anything with `id` and `classList`). */
  addElement(element) {
    if (this.full) {
      return;
    }
    const id = element.id;
    if (id && typeof id == "string" && !this.seenIds.has(id)) {
      this.seenIds.add(id);
      this.pendingIds.push(id);
    }
    const classList = element.classList;
    if (classList) {
      for (const c of classList) {
        if (c && !this.seenClasses.has(c)) {
          this.seenClasses.add(c);
          this.pendingClasses.push(c);
        }
      }
    }
  }

  get hasPending() {
    return this.pendingClasses.length > 0 || this.pendingIds.length > 0;
  }

  /** Take up to maxPerQuery pending tokens: { classes, ids }. */
  take() {
    let budget = this.maxPerQuery;
    const classes = this.pendingClasses.splice(0, budget);
    budget -= classes.length;
    const ids = this.pendingIds.splice(0, Math.max(0, budget));
    return { classes, ids };
  }
}

/**
 * Small time-limited cache, for site resources keyed by origin. Engine rebuilds after a list
 * update aren't signalled to content, so entries simply expire.
 */
export class ExpiringCache {
  constructor({ maxEntries = 64, ttlMs = 60_000, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }
    if (this.now() - entry.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
  }

  clear() {
    this.map.clear();
  }
}

/**
 * The cache key for a page's site resources: scheme + host + port. Returns null for pages
 * element hiding doesn't apply to (anything but http and https).
 */
export function cacheKeyForURL(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol != "http:" && parsed.protocol != "https:") {
    return null;
  }
  return parsed.origin;
}
