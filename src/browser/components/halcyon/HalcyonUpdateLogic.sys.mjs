/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Pure update-check logic: no browser APIs, so it is unit-tested both in xpcshell and in Node
// (tests/js/test_update_logic.mjs).

/**
 * Compare dotted versions numerically ("0.10.0" > "0.9.3"). A leading "v" is ignored, and any
 * pre-release suffix ("1.2.0-beta.1") sorts before the plain release.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a, b) {
  const parse = v => {
    const [core, pre = ""] = String(v).trim().replace(/^v/i, "").split("-", 2);
    const nums = core.split(".").map(n => (/^\d+$/.test(n) ? parseInt(n, 10) : 0));
    return { nums, pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff) {
      return diff;
    }
  }
  if (pa.pre === pb.pre) {
    return 0;
  }
  if (!pa.pre) {
    return 1;
  }
  if (!pb.pre) {
    return -1;
  }
  return pa.pre < pb.pre ? -1 : 1;
}

/**
 * Turn a GitHub "latest release" API response into what we need, or null if unusable.
 * Only https links on github.com are accepted, so a tampered response can't send the user
 * to an arbitrary site.
 *
 * @param {object} data
 * @param {string} repo  "owner/repo"
 * @returns {{version: string, url: string} | null}
 */
export function parseRelease(data, repo) {
  if (!data || typeof data !== "object" || data.draft || data.prerelease) {
    return null;
  }
  const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
  if (!/^v?\d+(\.\d+)*(-[0-9A-Za-z.]+)?$/.test(tag)) {
    return null;
  }
  const expectedPrefix = `https://github.com/${repo}/releases/`;
  const url =
    typeof data.html_url === "string" && data.html_url.startsWith(expectedPrefix)
      ? data.html_url
      : `${expectedPrefix}latest`;
  return { version: tag.replace(/^v/i, ""), url };
}

/**
 * Should we check now?
 *
 * @param {object} opts
 * @param {boolean} opts.enabled       user setting
 * @param {boolean} opts.offline
 * @param {number} opts.nowSec
 * @param {number} opts.lastCheckSec   0 if never
 * @param {number} opts.intervalHours
 * @returns {boolean}
 */
export function shouldCheck({ enabled, offline, nowSec, lastCheckSec, intervalHours }) {
  if (!enabled || offline) {
    return false;
  }
  const interval = Math.max(1, Number(intervalHours) || 24) * 3600;
  // A clock that jumped backwards (lastCheck in the future) must not block checks forever.
  if (lastCheckSec > nowSec) {
    return true;
  }
  return nowSec - lastCheckSec >= interval;
}

/**
 * Should we show the bar for this release?
 *
 * @param {{version: string}} release
 * @param {string} currentVersion
 * @param {string} dismissedVersion   version the user said "Not now" to, or ""
 * @returns {boolean}
 */
export function shouldNotify(release, currentVersion, dismissedVersion) {
  if (!release || compareVersions(release.version, currentVersion) <= 0) {
    return false;
  }
  return release.version !== dismissedVersion;
}
