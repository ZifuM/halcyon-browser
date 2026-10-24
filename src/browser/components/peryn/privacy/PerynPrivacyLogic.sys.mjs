/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * The privacy page's words and rules, free of browser objects so they can be unit-tested:
 * what each protection level changes and may break, the clear-data choices, which site
 * permissions come first, and plain-language counts. No privacy score, on purpose: real
 * counts from the Ledger say more than a number out of 100.
 */

export const SECTIONS = Object.freeze([
  { id: "overview", label: "Overview" },
  { id: "ledger", label: "Ledger" },
  { id: "blocked", label: "Blocked on sites" },
  { id: "every", label: "Every connection" },
  { id: "protection", label: "Protection" },
  { id: "site", label: "This site" },
  { id: "clear", label: "Clear data" },
]);

/** Firefox's tracking protection categories, described for people. */
export const PRESETS = Object.freeze({
  strict: {
    category: "strict",
    title: "Strict",
    note: "What Peryn ships",
    changes: [
      "Blocks known trackers, social media trackers, cryptominers and fingerprinters in every window",
      "Blocks tracking cookies and keeps every other cookie inside the site that set it",
      "Blocks email trackers in web mail",
    ],
    breaks: [
      "Some “sign in with” buttons, embedded videos or comment sections",
      "Fix a site with the shield in the address bar; it turns protection off there only",
    ],
  },
  standard: {
    category: "standard",
    title: "Balanced",
    note: "Firefox's standard protection",
    changes: [
      "Blocks social media trackers, cryptominers and fingerprinters",
      "Keeps cookies inside the site that set them (Total Cookie Protection)",
      "Blocks other known trackers in private windows only",
    ],
    breaks: ["Rarely breaks anything; some trackers can load in normal windows"],
  },
  custom: {
    category: "custom",
    title: "Custom",
    note: "Your own mix",
    changes: ["Set each protection yourself in Firefox's settings"],
    breaks: ["Depends on what you turn on"],
  },
});

export const PRESET_PREF = "browser.contentblocking.category";

export function presetFor(category) {
  return PRESETS[category] ?? PRESETS.custom;
}

/** Time ranges for clearing data (Sanitizer.TIMESPAN_* values). */
export const RANGES = Object.freeze([
  { id: "hour", label: "Last hour", timespan: 1 },
  { id: "2hours", label: "Last two hours", timespan: 2 },
  { id: "4hours", label: "Last four hours", timespan: 3 },
  { id: "today", label: "Today", timespan: 4 },
  { id: "everything", label: "Everything", timespan: 0 },
]);

/** What can be cleared (Firefox's Sanitizer item names in 158). */
export const CLEAR_ITEMS = Object.freeze([
  { id: "browsingHistoryAndDownloads", label: "History and downloads", note: "Also clears the Ledger's per-site counts", checked: true },
  { id: "cookiesAndStorage", label: "Cookies and site data", note: "Signs you out of sites", checked: true },
  { id: "cache", label: "Cached images and files", note: "Sites may load slower the first time", checked: true },
  { id: "formdata", label: "Saved form entries", note: "", checked: false },
  { id: "siteSettings", label: "Site settings", note: "Permissions and exceptions go back to asking", checked: false },
]);

/** The site permissions people look for first; the rest follow in Firefox's order. */
export const PERMISSION_ORDER = Object.freeze([
  "camera",
  "microphone",
  "screen",
  "geo",
  "desktop-notification",
  "autoplay-media",
  "popup",
  "persistent-storage",
  "xr",
  "midi",
  "midi-sysex",
  "speaker",
]);

export function orderPermissions(ids) {
  const rank = id => {
    const i = PERMISSION_ORDER.indexOf(id);
    return i < 0 ? PERMISSION_ORDER.length : i;
  };
  return [...ids].sort((a, b) => rank(a) - rank(b) || (ids.indexOf(a) - ids.indexOf(b)));
}

/** "1,234" */
export function formatCount(n) {
  return new Intl.NumberFormat("en").format(Math.max(0, Math.floor(n || 0)));
}

/** "3 min ago", "yesterday" */
export function ago(time, now = Date.now()) {
  if (!time) {
    return "never";
  }
  const seconds = Math.round((time - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) {
    return rtf.format(seconds, "second");
  }
  if (abs < 3600) {
    return rtf.format(Math.round(seconds / 60), "minute");
  }
  if (abs < 86400) {
    return rtf.format(Math.round(seconds / 3600), "hour");
  }
  return rtf.format(Math.round(seconds / 86400), "day");
}

/** The overview's headline sentences, from a Ledger summary. */
export function overviewLines(summary) {
  const listed = summary.connections.filter(c => c.seen > 0);
  const lines = [];
  const days = summary.days == 1 ? "today" : `in the last ${summary.days} days`;
  lines.push(
    summary.blockedCount
      ? `${formatCount(summary.blockedCount)} trackers blocked ${days}.`
      : `Nothing blocked ${days} yet.`
  );
  const total = listed.reduce((a, c) => a + c.seen, 0);
  lines.push(
    total
      ? `The browser connected on its own ${formatCount(total)} times ${days}, for ${listed.length} listed purposes.`
      : `The browser hasn't connected anywhere on its own ${days}.`
  );
  if (summary.unknown.length) {
    lines.push(`${summary.unknown.length} connection${summary.unknown.length == 1 ? " isn't" : "s aren't"} on the list. That shouldn't happen: please report it.`);
  }
  return lines;
}
