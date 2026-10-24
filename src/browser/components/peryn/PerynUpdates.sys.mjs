/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Update notifier. Ownership promise #7: the user controls updates.
//   * At most once per `peryn.updates.check.intervalHours`, asks GitHub for the latest release.
//   * If it is newer, shows a notification bar with a link to the release page.
//   * Never downloads or installs anything. "Not now" silences that version for good.
//   * `peryn.updates.check.enabled = false` stops all checks (listed in docs/EVERY-REQUEST.md).
// The request carries no cookies, no referrer and no identifiers.

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { PerynBuildInfo } from "moz-src:///browser/components/peryn/PerynBuildInfo.sys.mjs";
import {
  parseRelease,
  shouldCheck,
  shouldNotify,
} from "moz-src:///browser/components/peryn/PerynUpdateLogic.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "checkEnabled",
  "peryn.updates.check.enabled",
  true
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "intervalHours",
  "peryn.updates.check.intervalHours",
  24
);

const PREF_LAST_CHECK = "peryn.updates.lastCheckSeconds";
const PREF_DISMISSED = "peryn.updates.dismissedVersion";
const NOTIFICATION_ID = "peryn-update-available";
const RECHECK_EVERY_MS = 60 * 60 * 1000; // look again hourly; shouldCheck() enforces the interval
const REQUEST_TIMEOUT_MS = 15000;

export const PerynUpdates = {
  _timer: null,

  init() {
    this.maybeCheck();
    if (!this._timer) {
      this._timer = lazy.setInterval(() => this.maybeCheck(), RECHECK_EVERY_MS);
    }
  },

  async maybeCheck() {
    const nowSec = Math.floor(Date.now() / 1000);
    const due = shouldCheck({
      enabled: lazy.checkEnabled && !!PerynBuildInfo.updateRepo,
      offline: Services.io.offline,
      nowSec,
      lastCheckSec: Services.prefs.getIntPref(PREF_LAST_CHECK, 0),
      intervalHours: lazy.intervalHours,
    });
    if (!due) {
      return;
    }
    Services.prefs.setIntPref(PREF_LAST_CHECK, nowSec);
    let release = null;
    try {
      release = await this.fetchLatest();
    } catch (e) {
      console.warn("Update check failed:", e);
      return;
    }
    const dismissed = Services.prefs.getStringPref(PREF_DISMISSED, "");
    if (shouldNotify(release, PerynBuildInfo.version, dismissed)) {
      await this.showNotification(release);
    }
  },

  async fetchLatest() {
    const repo = PerynBuildInfo.updateRepo;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = lazy.setTimeout(() => reject(new Error("timed out")), REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([
        fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          headers: { Accept: "application/vnd.github+json" },
        }),
        timeout,
      ]);
      if (!response.ok) {
        return null; // 404 = no releases yet
      }
      return parseRelease(await response.json(), repo);
    } finally {
      lazy.clearTimeout(timer);
    }
  },

  async showNotification(release) {
    const win = lazy.BrowserWindowTracker.getTopWindow();
    if (!win?.gNotificationBox) {
      return;
    }
    const box = win.gNotificationBox;
    if (box.getNotificationWithValue(NOTIFICATION_ID)) {
      return;
    }
    const buttons = [
      {
        label: "See what's new",
        accessKey: "S",
        primary: true,
        callback() {
          win.openTrustedLinkIn(release.url, "tab");
        },
      },
      {
        label: "Not now",
        accessKey: "N",
        callback() {
          Services.prefs.setStringPref(PREF_DISMISSED, release.version);
        },
      },
    ];
    await box.appendNotification(
      NOTIFICATION_ID,
      {
        label: `${PerynBuildInfo.name} ${release.version} is available. You're on ${PerynBuildInfo.version}.`,
        priority: box.PRIORITY_INFO_MEDIUM,
      },
      buttons
    );
  },
};
