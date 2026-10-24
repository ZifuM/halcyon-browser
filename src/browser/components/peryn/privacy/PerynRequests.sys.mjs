/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Generated from privacy/requests.toml by `hx requests --write`. Do not edit here.
// The every-request registry, for the Privacy Ledger: what each connection the browser makes
// on its own is for, and how to turn it off.

export const REQUESTS = Object.freeze([
  {
    "id": "remote-settings",
    "name": "Security and configuration lists (Remote Settings)",
    "purpose": "Certificate revocation (CRLite), add-on blocklist, tracker lists, search engine list. Signed by Mozilla and verified before use.",
    "hosts": [
      "firefox.settings.services.mozilla.com",
      "firefox-settings-attachments.cdn.mozilla.net"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "Not recommended: blocking revoked certificates and malicious add-ons depends on it."
  },
  {
    "id": "addon-updates",
    "name": "Add-on updates",
    "purpose": "Checks installed add-ons (including built-in ones) for security updates.",
    "hosts": [
      "versioncheck.addons.mozilla.org",
      "versioncheck-bg.addons.mozilla.org",
      "services.addons.mozilla.org",
      "addons.mozilla.org"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "about:addons > gear menu > untick Update Add-ons Automatically"
  },
  {
    "id": "media-plugins",
    "name": "Video-call and streaming plugins",
    "purpose": "Downloads the OpenH264 codec (video calls) and Widevine (DRM streaming, e.g. Netflix) and keeps them updated. Widevine comes through Google's component updater (update.googleapis.com, which redirects to a www.google.com or gvt1.com download), and the plugin list's Mozilla signature is checked against content-signature-2.cdn.mozilla.net.",
    "hosts": [
      "aus5.mozilla.org",
      "ciscobinary.openh264.org",
      "*.gvt1.com",
      "update.googleapis.com",
      "www.google.com",
      "content-signature-2.cdn.mozilla.net"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "about:config: media.gmp-provider.enabled = false (breaks some video calls and DRM sites)"
  },
  {
    "id": "safe-browsing",
    "name": "Phishing and malware protection (Safe Browsing)",
    "purpose": "Downloads hashed lists of dangerous sites; full hashes are requested only for matches. Needs a Google Safe Browsing API key, which unofficial builds don't have yet (open decision), so it is currently inert.",
    "hosts": [
      "safebrowsing.googleapis.com",
      "shavar.services.mozilla.com",
      "sb-ssl.google.com"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "Settings > Privacy & Security > untick Block dangerous and deceptive content"
  },
  {
    "id": "app-updates",
    "name": "App update check",
    "purpose": "Once a day, asks GitHub whether a newer release exists and shows a notification bar. Never downloads or installs anything by itself.",
    "hosts": [
      "api.github.com"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "about:config: peryn.updates.check.enabled = false"
  },
  {
    "id": "shield-lists",
    "name": "Shield filter list updates",
    "purpose": "Downloads the ad and tracker blocking lists (uBlock filters, EasyList, EasyPrivacy, Peter Lowe's) when each list's own expiry passes, typically every 1 to 5 days. No cookies, no identifiers; unchanged lists aren't re-downloaded.",
    "hosts": [
      "ublockorigin.github.io",
      "cdn.jsdelivr.net"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "about:config: peryn.shield.updates.enabled = false (the last downloaded lists keep blocking)"
  },
  {
    "id": "push",
    "name": "Web push notifications",
    "purpose": "Firefox keeps one connection open to Mozilla's push server from startup, whether or not any site has notification permission. It carries notifications from sites you've allowed and Mozilla's 'lists changed' signal for Remote Settings, so security lists update within minutes instead of once a day. The server sees a random per-profile ID, no browsing data.",
    "hosts": [
      "push.services.mozilla.com"
    ],
    "state": "on",
    "trigger": "background",
    "switch": "about:config: dom.push.connection.enabled = false (site notifications stop; Remote Settings falls back to its daily check)"
  },
  {
    "id": "sync",
    "name": "Mozilla account and Sync",
    "purpose": "Only after you sign in. End-to-end encrypted.",
    "hosts": [
      "accounts.firefox.com",
      "api.accounts.firefox.com",
      "profile.accounts.firefox.com",
      "token.services.mozilla.com",
      "*.sync.services.mozilla.com"
    ],
    "state": "on",
    "trigger": "user",
    "switch": "Settings > Sync > Sign out"
  },
  {
    "id": "search-suggestions",
    "name": "Search suggestions",
    "purpose": "What you type in the address bar is sent to your chosen search engine to suggest searches.",
    "hosts": [],
    "state": "on",
    "trigger": "user",
    "switch": "Settings > Search > untick Show search suggestions"
  },
  {
    "id": "certificate-status",
    "name": "Certificate status (OCSP)",
    "purpose": "When you open an HTTPS site, its certificate authority may be asked whether the certificate is still valid.",
    "hosts": [],
    "state": "on",
    "trigger": "user",
    "switch": "about:config: security.OCSP.enabled = 0 (CRLite still covers most revocations)"
  },
  {
    "id": "telemetry",
    "name": "Telemetry and usage pings",
    "purpose": "Usage and performance data sent to Mozilla.",
    "hosts": [
      "incoming.telemetry.mozilla.org"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "Not available: compiled out."
  },
  {
    "id": "experiments",
    "name": "Experiments, studies and remote rollouts",
    "purpose": "Remote changes to browser behaviour (Normandy, Nimbus).",
    "hosts": [
      "normandy.cdn.mozilla.net",
      "classify-client.services.mozilla.com"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "Not available: Normandy compiled out; nimbus.rollouts.enabled = false."
  },
  {
    "id": "captive-portal",
    "name": "Wi-Fi login and connectivity checks",
    "purpose": "Background requests that detect hotel or airport Wi-Fi login pages.",
    "hosts": [
      "firefox-portal-detection.com",
      "detectportal.firefox.com"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "about:config: network.captive-portal-service.enabled and network.connectivity-service.enabled = true"
  },
  {
    "id": "region",
    "name": "Region lookup",
    "purpose": "Guesses your country from your IP address.",
    "hosts": [
      "location.services.mozilla.com"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "about:config: browser.region.update.enabled = true"
  },
  {
    "id": "suggest",
    "name": "Firefox Suggest, weather and partner suggestions",
    "purpose": "Sponsored and partner suggestions in the address bar.",
    "hosts": [
      "merino.services.mozilla.com"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "Settings > Search"
  },
  {
    "id": "newtab-content",
    "name": "New-tab stories, sponsored tiles and ads",
    "purpose": "Recommended stories and sponsored content on the new tab page.",
    "hosts": [
      "ads.mozilla.org",
      "contile.services.mozilla.com",
      "firefox-api-proxy.cdn.mozilla.net",
      "spocs.getpocket.com"
    ],
    "state": "off",
    "trigger": "background",
    "switch": "Settings > Home"
  },
  {
    "id": "system-addon-updates",
    "name": "System add-on updates",
    "purpose": "Mozilla pushing updated built-in components between releases. Off: the browser changes only when you update it.",
    "hosts": [],
    "state": "off",
    "trigger": "background",
    "switch": "about:config: extensions.systemAddon.update.enabled = true"
  }
].map(entry => Object.freeze(entry)));

/** Whether `host` matches a registry host pattern (`*.example.com` covers subdomains only). */
export function hostMatches(pattern, host) {
  host = String(host).toLowerCase().replace(/\.$/, "");
  if (pattern.startsWith("*.")) {
    return host.endsWith(pattern.slice(1)) && host != pattern.slice(2);
  }
  return host == pattern;
}

/** The registry entry a host belongs to, or null if it isn't listed. */
export function classify(host) {
  return REQUESTS.find(entry => entry.hosts.some(pattern => hostMatches(pattern, host))) ?? null;
}
