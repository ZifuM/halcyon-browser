# Every request the browser makes on its own

The goal: a complete, public list of every connection the browser opens without the user
navigating somewhere, each with a reason and an off switch. In cycle C1 a CI network audit will
launch the browser, record its traffic, and fail the build on anything not listed here.

Status: **draft from source review (C0)**. Not yet verified by the network audit.

## Turned off by default

| Connection | Firefox default | Ours | Turn back on |
| --- | --- | --- | --- |
| Telemetry, usage and health pings | on | compiled out + prefs off | not available |
| Normandy experiments and studies | on | compiled out | not available |
| Nimbus feature rollouts | on | off | `nimbus.rollouts.enabled` |
| Crash reports | ask / auto | not built (opt-in reporting later) | — |
| Captive-portal detection (`detectportal.firefox.com`) | on | off | `network.captive-portal-service.enabled` |
| Connectivity checks | on | off | `network.connectivity-service.enabled` |
| Region lookup | on | off | `browser.region.update.enabled` |
| New-tab stories, sponsored tiles, weather | on | off | Settings > Home |
| Firefox Suggest / trending / partner suggestions | partly on | off | Settings > Search |
| Speculative connections and DNS/link prefetch | on | off | see `prefs/50-quiet-network.toml` |
| AI model downloads (translations, link previews, PDF alt text, chatbot) | on demand | blocked until AI is enabled | Settings > AI Controls |
| Mozilla updater | on | not built (own update server in C1) | — |

## Still on (needed for security or user-requested features)

| Connection | Why it stays | Off switch |
| --- | --- | --- |
| Remote Settings (certificate revocation/CRLite, add-on and plugin blocklists, tracker lists) | Security: revoked certificates and malicious add-ons must be blocked | Not recommended; `services.settings.server` |
| Safe Browsing (hashed URL prefixes via Mozilla's proxy) | Phishing and malware protection. **Open decision:** keep Mozilla's, proxy via our server, or offer a choice | Settings > Privacy > Deceptive content |
| Add-on update checks | Security updates for installed add-ons | about:addons > gear > Update automatically |
| Search suggestions (to the chosen search engine) | Feature the user sees while typing | Settings > Search > Provide search suggestions |
| Sync (only if signed in) | User-chosen | Sign out |
