// Tests for the update notifier, run with:
//   node --import ./tests/js/register.mjs --test tests/js/
import "./globals.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import * as Timer from "./mocks/Timer.mjs";
import * as Tracker from "./mocks/BrowserWindowTracker.mjs";

ChromeUtils._preload("resource://gre/modules/Timer.sys.mjs", Timer);
ChromeUtils._preload("resource:///modules/BrowserWindowTracker.sys.mjs", Tracker);

const { compareVersions, parseRelease, shouldCheck, shouldNotify } = await import(
  "moz-src:///browser/components/peryn/PerynUpdateLogic.sys.mjs"
);
const { PerynUpdates } = await import("moz-src:///browser/components/peryn/PerynUpdates.sys.mjs");

// ---- pure logic -------------------------------------------------------------

test("compareVersions orders numerically and handles v-prefix and pre-releases", () => {
  assert.ok(compareVersions("0.10.0", "0.9.3") > 0);
  assert.equal(compareVersions("v1.2", "1.2.0"), 0);
  assert.ok(compareVersions("1.2.0-beta.1", "1.2.0") < 0);
  assert.ok(compareVersions("1.2.0", "1.2.0-rc.1") > 0);
  assert.ok(compareVersions("1.2.0-alpha", "1.2.0-beta") < 0);
  assert.ok(compareVersions("2.0", "10.0") < 0);
});

test("parseRelease accepts real releases and rejects drafts, bad tags and foreign links", () => {
  const good = { tag_name: "v0.2.0", html_url: "https://github.com/owner/repo/releases/tag/v0.2.0" };
  assert.deepEqual(parseRelease(good, "owner/repo"), { version: "0.2.0", url: good.html_url });
  assert.equal(parseRelease({ ...good, draft: true }, "owner/repo"), null);
  assert.equal(parseRelease({ ...good, prerelease: true }, "owner/repo"), null);
  assert.equal(parseRelease({ ...good, tag_name: "nightly" }, "owner/repo"), null);
  assert.equal(parseRelease(null, "owner/repo"), null);
  const evil = parseRelease({ ...good, html_url: "https://evil.example/download" }, "owner/repo");
  assert.equal(evil.url, "https://github.com/owner/repo/releases/latest");
});

test("shouldCheck respects the switch, offline mode, the interval and clock jumps", () => {
  const base = { enabled: true, offline: false, nowSec: 100000, lastCheckSec: 0, intervalHours: 24 };
  assert.equal(shouldCheck(base), true);
  assert.equal(shouldCheck({ ...base, enabled: false }), false);
  assert.equal(shouldCheck({ ...base, offline: true }), false);
  assert.equal(shouldCheck({ ...base, lastCheckSec: base.nowSec - 3600 }), false);
  assert.equal(shouldCheck({ ...base, lastCheckSec: base.nowSec - 25 * 3600 }), true);
  assert.equal(shouldCheck({ ...base, lastCheckSec: base.nowSec + 999 }), true);
});

test("shouldNotify only for newer, non-dismissed versions", () => {
  assert.equal(shouldNotify({ version: "0.2.0" }, "0.1.0", ""), true);
  assert.equal(shouldNotify({ version: "0.1.0" }, "0.1.0", ""), false);
  assert.equal(shouldNotify({ version: "0.0.9" }, "0.1.0", ""), false);
  assert.equal(shouldNotify({ version: "0.2.0" }, "0.1.0", "0.2.0"), false);
  assert.equal(shouldNotify(null, "0.1.0", ""), false);
});

// ---- the notifier, with mocked Firefox APIs -----------------------------------

let fetchCalls;
let notifications;
let opened;

function fakeWindow() {
  return {
    openTrustedLinkIn: (url, where) => opened.push({ url, where }),
    gNotificationBox: {
      PRIORITY_INFO_MEDIUM: 2,
      getNotificationWithValue: id => notifications.find(n => n.id === id) ?? null,
      appendNotification: async (id, opts, buttons) => {
        notifications.push({ id, opts, buttons });
      },
    },
  };
}

function mockFetch(status, body) {
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url, options });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

const RELEASE = { tag_name: "v0.2.0", html_url: "https://github.com/owner/repo/releases/tag/v0.2.0" };

beforeEach(() => {
  Services.prefs._reset();
  Services.io.offline = false;
  fetchCalls = [];
  notifications = [];
  opened = [];
  globalThis.__testWindow = fakeWindow();
});

test("a newer release shows the bar; the request carries no cookies or referrer", async () => {
  mockFetch(200, RELEASE);
  await PerynUpdates.maybeCheck();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://api.github.com/repos/owner/repo/releases/latest");
  assert.equal(fetchCalls[0].options.credentials, "omit");
  assert.equal(fetchCalls[0].options.referrerPolicy, "no-referrer");
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].opts.label, /Testy 0\.2\.0 is available\. You're on 0\.1\.0/);
  assert.ok(Services.prefs.getIntPref("peryn.updates.lastCheckSeconds", 0) > 0);
});

test("'See what's new' opens the release page; 'Not now' silences that version", async () => {
  mockFetch(200, RELEASE);
  await PerynUpdates.maybeCheck();
  const [see, notNow] = notifications[0].buttons;
  see.callback();
  assert.deepEqual(opened, [{ url: RELEASE.html_url, where: "tab" }]);
  notNow.callback();
  assert.equal(Services.prefs.getStringPref("peryn.updates.dismissedVersion", ""), "0.2.0");

  notifications = [];
  Services.prefs.setIntPref("peryn.updates.lastCheckSeconds", 0);
  await PerynUpdates.maybeCheck();
  assert.equal(notifications.length, 0, "dismissed version must not reappear");
});

test("nothing happens when switched off, offline, recently checked, or up to date", async () => {
  mockFetch(200, RELEASE);
  Services.prefs.setBoolPref("peryn.updates.check.enabled", false);
  await PerynUpdates.maybeCheck();
  assert.equal(fetchCalls.length, 0, "switched off: no request at all");

  Services.prefs._reset();
  Services.io.offline = true;
  await PerynUpdates.maybeCheck();
  assert.equal(fetchCalls.length, 0, "offline: no request");

  Services.io.offline = false;
  Services.prefs.setIntPref("peryn.updates.lastCheckSeconds", Math.floor(Date.now() / 1000) - 60);
  await PerynUpdates.maybeCheck();
  assert.equal(fetchCalls.length, 0, "within the interval: no request");

  Services.prefs._reset();
  mockFetch(200, { tag_name: "v0.1.0", html_url: RELEASE.html_url });
  await PerynUpdates.maybeCheck();
  assert.equal(fetchCalls.length, 1);
  assert.equal(notifications.length, 0, "same version: no bar");
});

test("no releases yet (404) or a network error is silent", async () => {
  mockFetch(404, { message: "Not Found" });
  await PerynUpdates.maybeCheck();
  assert.equal(notifications.length, 0);

  Services.prefs._reset();
  globalThis.fetch = async () => {
    throw new TypeError("NetworkError");
  };
  await assert.doesNotReject(PerynUpdates.maybeCheck());
  assert.equal(notifications.length, 0);
});

test("init checks once and schedules an hourly re-check", async () => {
  mockFetch(200, RELEASE);
  PerynUpdates.init();
  await new Promise(r => setImmediate(r));
  assert.equal(fetchCalls.length, 1);
  assert.equal(Timer.intervals.at(-1).ms, 3600000);
});
