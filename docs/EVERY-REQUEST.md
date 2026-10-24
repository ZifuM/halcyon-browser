# Every request the browser makes on its own

<!-- Generated from privacy/requests.toml by `hx requests --write`. Do not edit here. -->

This is the complete list of connections Peryn can open without you navigating
somewhere. The network audit in CI launches the browser with a fresh profile, records
every connection it attempts while idle, and fails the build if anything is not on this
page, or if something listed as turned off still connects.

## On by default, may happen in the background

| Connection | What it's for | Hosts | Turn it off |
| --- | --- | --- | --- |
| Security and configuration lists (Remote Settings) | Certificate revocation (CRLite), add-on blocklist, tracker lists, search engine list. Signed by Mozilla and verified before use. | `firefox.settings.services.mozilla.com`, `firefox-settings-attachments.cdn.mozilla.net` | Not recommended: blocking revoked certificates and malicious add-ons depends on it. |
| Add-on updates | Checks installed add-ons (including built-in ones) for security updates. | `versioncheck.addons.mozilla.org`, `versioncheck-bg.addons.mozilla.org`, `services.addons.mozilla.org`, `addons.mozilla.org` | about:addons > gear menu > untick Update Add-ons Automatically |
| Video-call and streaming plugins | Downloads the OpenH264 codec (video calls) and Widevine (DRM streaming, e.g. Netflix) and keeps them updated. | `aus5.mozilla.org`, `ciscobinary.openh264.org`, `*.gvt1.com` | about:config: media.gmp-provider.enabled = false (breaks some video calls and DRM sites) |
| Phishing and malware protection (Safe Browsing) | Downloads hashed lists of dangerous sites; full hashes are requested only for matches. Needs a Google Safe Browsing API key, which unofficial builds don't have yet (open decision), so it is currently inert. | `safebrowsing.googleapis.com`, `shavar.services.mozilla.com`, `sb-ssl.google.com` | Settings > Privacy & Security > untick Block dangerous and deceptive content |
| App update check | Once a day, asks GitHub whether a newer release exists and shows a notification bar. Never downloads or installs anything by itself. | `api.github.com` | about:config: peryn.updates.check.enabled = false |
| Shield filter list updates | Downloads the ad and tracker blocking lists (uBlock filters, EasyList, EasyPrivacy, Peter Lowe's) when each list's own expiry passes, typically every 1 to 5 days. No cookies, no identifiers; unchanged lists aren't re-downloaded. | `ublockorigin.github.io`, `cdn.jsdelivr.net` | about:config: peryn.shield.updates.enabled = false (the last downloaded lists keep blocking) |

## Only after you do something

| Connection | What it's for | Hosts | Turn it off |
| --- | --- | --- | --- |
| Web push notifications | Keeps a connection open only for sites you've allowed to send notifications. | `push.services.mozilla.com` | Settings > Privacy & Security > Permissions > Notifications |
| Mozilla account and Sync | Only after you sign in. End-to-end encrypted. | `accounts.firefox.com`, `api.accounts.firefox.com`, `profile.accounts.firefox.com`, `token.services.mozilla.com`, `*.sync.services.mozilla.com` | Settings > Sync > Sign out |
| Search suggestions | What you type in the address bar is sent to your chosen search engine to suggest searches. | varies | Settings > Search > untick Show search suggestions |
| Certificate status (OCSP) | When you open an HTTPS site, its certificate authority may be asked whether the certificate is still valid. | varies | about:config: security.OCSP.enabled = 0 (CRLite still covers most revocations) |

## Turned off (Firefox does these; we don't)

| Connection | What it's for | Hosts | Turn it back on |
| --- | --- | --- | --- |
| Telemetry and usage pings | Usage and performance data sent to Mozilla. | `incoming.telemetry.mozilla.org` | Not available: compiled out. |
| Experiments, studies and remote rollouts | Remote changes to browser behaviour (Normandy, Nimbus). | `normandy.cdn.mozilla.net`, `classify-client.services.mozilla.com` | Not available: Normandy compiled out; nimbus.rollouts.enabled = false. |
| Wi-Fi login and connectivity checks | Background requests that detect hotel or airport Wi-Fi login pages. | `firefox-portal-detection.com`, `detectportal.firefox.com` | about:config: network.captive-portal-service.enabled and network.connectivity-service.enabled = true |
| Region lookup | Guesses your country from your IP address. | `location.services.mozilla.com` | about:config: browser.region.update.enabled = true |
| Firefox Suggest, weather and partner suggestions | Sponsored and partner suggestions in the address bar. | `merino.services.mozilla.com` | Settings > Search |
| New-tab stories, sponsored tiles and ads | Recommended stories and sponsored content on the new tab page. | `ads.mozilla.org`, `contile.services.mozilla.com`, `firefox-api-proxy.cdn.mozilla.net`, `spocs.getpocket.com` | Settings > Home |
| System add-on updates | Mozilla pushing updated built-in components between releases. Off: the browser changes only when you update it. | varies | about:config: extensions.systemAddon.update.enabled = true |
