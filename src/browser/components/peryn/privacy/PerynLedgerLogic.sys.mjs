/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The Privacy Ledger's rules, free of browser objects so they can be unit-tested.
 *
 * The Ledger keeps two things, on this computer only:
 *   - every connection the browser (or a built-in or installed add-on) makes by itself,
 *     matched against the every-request registry, so you can see what each one is for;
 *   - how many trackers were blocked on each site, by kind.
 * It's kept per day for RETAIN_DAYS days. The per-site part is browsing history in all but
 * name, so it's cleared with history, and not kept at all when history is off or in private
 * windows.
 */

export const VERSION = 1;
export const RETAIN_DAYS = 30;
export const RECENT_LIMIT = 500;
export const MAX_HOSTS_PER_DAY = 2000;
export const MAX_SITES_PER_DAY = 5000;

/** Kinds of blocking, from Firefox's content blocking log flags (nsIWebProgressListener). */
export const BLOCK_KINDS = Object.freeze({
  tracker: "Trackers",
  social: "Social media trackers",
  fingerprinter: "Fingerprinters",
  cryptominer: "Cryptominers",
  cookie: "Tracking cookies",
  ads: "Ads and other content (Shield)",
});

/** nsIWebProgressListener flag values (stable across Firefox releases). */
export const FLAGS = Object.freeze({
  STATE_BLOCKED_TRACKING_CONTENT: 0x00001000,
  STATE_BLOCKED_FINGERPRINTING_CONTENT: 0x00000040,
  STATE_BLOCKED_CRYPTOMINING_CONTENT: 0x00000800,
  STATE_BLOCKED_SOCIALTRACKING_CONTENT: 0x00010000,
  STATE_COOKIES_BLOCKED_TRACKER: 0x20000000,
  STATE_COOKIES_BLOCKED_SOCIALTRACKER: 0x01000000,
  STATE_BLOCKED_EMAILTRACKING_CONTENT: 0x00000400,
});

/** The kind a blocked entry in the content blocking log counts as, or null if it isn't one. */
export function kindOfFlag(flag) {
  const f = Number(flag) >>> 0;
  if (f & FLAGS.STATE_BLOCKED_FINGERPRINTING_CONTENT) {
    return "fingerprinter";
  }
  if (f & FLAGS.STATE_BLOCKED_CRYPTOMINING_CONTENT) {
    return "cryptominer";
  }
  if (f & FLAGS.STATE_BLOCKED_SOCIALTRACKING_CONTENT) {
    return "social";
  }
  if (f & (FLAGS.STATE_BLOCKED_TRACKING_CONTENT | FLAGS.STATE_BLOCKED_EMAILTRACKING_CONTENT)) {
    return "tracker";
  }
  if (f & (FLAGS.STATE_COOKIES_BLOCKED_TRACKER | FLAGS.STATE_COOKIES_BLOCKED_SOCIALTRACKER)) {
    return "cookie";
  }
  return null;
}

/**
 * Whether a request was made by the browser itself rather than a page.
 *
 * @param {object} info
 * @param {boolean} info.inContentBrowsingContext  the request belongs to a tab or frame
 * @param {"none"|"system"|"addon"|"content"} info.loadingPrincipal  who asked for it
 * @returns {"browser"|"addon"|null}
 */
export function madeBy({ inContentBrowsingContext, loadingPrincipal }) {
  if (loadingPrincipal == "addon") {
    return "addon";
  }
  if (!inContentBrowsingContext && (loadingPrincipal == "none" || loadingPrincipal == "system")) {
    return "browser";
  }
  return null;
}

/** "2026-10-24" for a time, in local time (days as the person lives them). */
export function dayOf(time) {
  const d = new Date(time);
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function emptyState() {
  return { version: VERSION, days: {} };
}

const isObject = v => v && typeof v == "object" && !Array.isArray(v);

/** Validate stored data; anything unusable is dropped. Never throws. */
export function normalizeState(raw) {
  let input = raw;
  if (typeof input == "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = null;
    }
  }
  const state = emptyState();
  if (!isObject(input) || !isObject(input.days)) {
    return state;
  }
  const count = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  for (const [day, value] of Object.entries(input.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isObject(value)) {
      continue;
    }
    const out = { connections: {}, blocked: {}, blockedTotal: {} };
    for (const [host, c] of Object.entries(isObject(value.connections) ? value.connections : {})) {
      if (isObject(c) && count(c.count)) {
        out.connections[host] = {
          count: count(c.count),
          by: c.by == "addon" ? "addon" : "browser",
          entry: typeof c.entry == "string" ? c.entry : null,
          addon: typeof c.addon == "string" ? c.addon : null,
          last: count(c.last),
        };
      }
    }
    for (const [site, kinds] of Object.entries(isObject(value.blocked) ? value.blocked : {})) {
      if (isObject(kinds)) {
        const k = {};
        for (const [kind, n] of Object.entries(kinds)) {
          if (kind in BLOCK_KINDS && count(n)) {
            k[kind] = count(n);
          }
        }
        if (Object.keys(k).length) {
          out.blocked[site] = k;
        }
      }
    }
    for (const [kind, n] of Object.entries(isObject(value.blockedTotal) ? value.blockedTotal : {})) {
      if (kind in BLOCK_KINDS && count(n)) {
        out.blockedTotal[kind] = count(n);
      }
    }
    state.days[day] = out;
  }
  return state;
}

function dayRecord(state, time) {
  const day = dayOf(time);
  state.days[day] ??= { connections: {}, blocked: {}, blockedTotal: {} };
  return state.days[day];
}

/**
 * Note a browser-made connection.
 *
 * @param {object} conn {host, by: "browser"|"addon", entry (registry id or null), addon, time}
 * @returns {boolean} false when the day is full and the host was new (still counted in recent)
 */
export function recordConnection(state, { host, by = "browser", entry = null, addon = null, time }) {
  const day = dayRecord(state, time);
  let c = day.connections[host];
  if (!c) {
    if (Object.keys(day.connections).length >= MAX_HOSTS_PER_DAY) {
      return false;
    }
    c = day.connections[host] = { count: 0, by, entry, addon, last: 0 };
  }
  c.count++;
  c.last = time;
  return true;
}

/**
 * Note blocking on a site. `counts` is {kind: n} for what's new since the last note for the
 * same page (see blockDelta). `site` null keeps only the day's totals (history off).
 */
export function recordBlocked(state, { site, counts, time }) {
  const day = dayRecord(state, time);
  let added = 0;
  for (const [kind, n] of Object.entries(counts)) {
    if (!(kind in BLOCK_KINDS) || !(n > 0)) {
      continue;
    }
    day.blockedTotal[kind] = (day.blockedTotal[kind] ?? 0) + n;
    added += n;
    if (site) {
      if (!day.blocked[site] && Object.keys(day.blocked).length >= MAX_SITES_PER_DAY) {
        continue;
      }
      day.blocked[site] ??= {};
      day.blocked[site][kind] = (day.blocked[site][kind] ?? 0) + n;
    }
  }
  return added;
}

/**
 * What a page's content blocking log adds since it was last read. Firefox keeps one log per
 * page with running counts, so each read reports the whole page so far.
 *
 * @param {object|string} log  {origin: [[flag, blocked, count], ...]} (as getContentBlockingLog)
 * @param {Map<string, number>} seen  per origin|kind counts already recorded for this page
 * @returns {{counts: object, origins: string[]}}
 */
export function blockDelta(log, seen) {
  let parsed = log;
  if (typeof parsed == "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = {};
    }
  }
  const counts = {};
  const origins = new Set();
  for (const [origin, entries] of Object.entries(isObject(parsed) ? parsed : {})) {
    if (!Array.isArray(entries)) {
      continue;
    }
    for (const entry of entries) {
      if (!Array.isArray(entry)) {
        continue;
      }
      const [flag, blocked, count = 1] = entry;
      const kind = blocked ? kindOfFlag(flag) : null;
      if (!kind) {
        continue;
      }
      const key = `${origin}|${kind}`;
      const total = Math.max(1, Number(count) || 1);
      const fresh = total - (seen.get(key) ?? 0);
      if (fresh > 0) {
        seen.set(key, total);
        counts[kind] = (counts[kind] ?? 0) + fresh;
        origins.add(origin);
      }
    }
  }
  return { counts, origins: [...origins] };
}

/** Drop days older than `keep` days before `now`. */
export function prune(state, now, keep = RETAIN_DAYS) {
  const cutoff = dayOf(now - keep * 86400000);
  for (const day of Object.keys(state.days)) {
    if (day < cutoff) {
      delete state.days[day];
    }
  }
  return state;
}

/** Forget every site (history cleared); totals and browser connections stay. */
export function forgetSites(state, matches = () => true) {
  for (const day of Object.values(state.days)) {
    for (const site of Object.keys(day.blocked)) {
      if (matches(site)) {
        delete day.blocked[site];
      }
    }
  }
  return state;
}

/** The days in range, newest first. */
function daysIn(state, now, days) {
  const from = dayOf(now - (days - 1) * 86400000);
  return Object.entries(state.days)
    .filter(([day]) => day >= from)
    .sort(([a], [b]) => (a < b ? 1 : -1));
}

/**
 * What the Ledger shows: connections grouped by registry entry (unknown hosts on their own),
 * blocked totals by kind, and the sites with the most blocked.
 *
 * @param {Array} registry the REQUESTS list
 */
export function summarize(state, { now, days = 7, registry = [] } = {}) {
  const byEntry = new Map();
  const unknown = new Map();
  const addons = new Map();
  const blockedTotal = {};
  const sites = new Map();
  for (const [, day] of daysIn(state, now, days)) {
    for (const [host, c] of Object.entries(day.connections)) {
      if (c.by == "addon") {
        const a = addons.get(c.addon ?? "?") ?? { addon: c.addon, count: 0, hosts: new Set(), last: 0 };
        a.count += c.count;
        a.hosts.add(host);
        a.last = Math.max(a.last, c.last);
        addons.set(c.addon ?? "?", a);
      } else if (c.entry) {
        const e = byEntry.get(c.entry) ?? { id: c.entry, count: 0, hosts: new Set(), last: 0 };
        e.count += c.count;
        e.hosts.add(host);
        e.last = Math.max(e.last, c.last);
        byEntry.set(c.entry, e);
      } else {
        const u = unknown.get(host) ?? { host, count: 0, last: 0 };
        u.count += c.count;
        u.last = Math.max(u.last, c.last);
        unknown.set(host, u);
      }
    }
    for (const [kind, n] of Object.entries(day.blockedTotal)) {
      blockedTotal[kind] = (blockedTotal[kind] ?? 0) + n;
    }
    for (const [site, kinds] of Object.entries(day.blocked)) {
      const s = sites.get(site) ?? { site, total: 0, kinds: {} };
      for (const [kind, n] of Object.entries(kinds)) {
        s.kinds[kind] = (s.kinds[kind] ?? 0) + n;
        s.total += n;
      }
      sites.set(site, s);
    }
  }
  const info = new Map(registry.map(r => [r.id, r]));
  const connections = registry
    .map(r => {
      const seen = byEntry.get(r.id);
      return { ...r, seen: seen?.count ?? 0, seenHosts: seen ? [...seen.hosts].sort() : [], last: seen?.last ?? 0 };
    })
    .concat([...byEntry.values()].filter(e => !info.has(e.id)).map(e => ({ id: e.id, name: e.id, seen: e.count, seenHosts: [...e.hosts], last: e.last })));
  return {
    days,
    connections,
    unknown: [...unknown.values()].sort((a, b) => b.count - a.count),
    addons: [...addons.values()].map(a => ({ ...a, hosts: [...a.hosts].sort() })).sort((a, b) => b.count - a.count),
    blockedTotal,
    blockedCount: Object.values(blockedTotal).reduce((a, b) => a + b, 0),
    topSites: [...sites.values()].sort((a, b) => b.total - a.total).slice(0, 50),
  };
}

/** Every host the browser connected to on its own in the range (for checks against the audit). */
export function hostsSeen(state, { now, days = RETAIN_DAYS } = {}) {
  const hosts = new Set();
  for (const [, day] of daysIn(state, now, days)) {
    for (const host of Object.keys(day.connections)) {
      hosts.add(host);
    }
  }
  return [...hosts].sort();
}
