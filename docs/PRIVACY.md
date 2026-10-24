# The Privacy Ledger and privacy page

Peryn promises zero telemetry, and the Privacy Ledger lets you check that for yourself.

Open it from the command bar: **Privacy Ledger**, **Privacy and Security**, **Site Settings**,
**Clear Browsing Data** or **Every Connection the Browser Makes**.

## The Ledger

The Ledger is a record, kept only on this computer, of two things:

- **Every connection the browser makes by itself.** Each connection is matched against the
  [every-request list](EVERY-REQUEST.md), so you can see what it was for, how often it
  happened, when it last happened and how to turn it off. A connection that isn't on the list
  is shown separately, as something to report: it should never happen.
  - Requests from add-ons are listed under the add-on that made them.
  - Pages you visit are not listed. This is the browser's own traffic.
- **Trackers and ads blocked on each site**, by kind: trackers and ads, social media trackers,
  fingerprinters, cryptominers and tracking cookies. The counts come from Firefox's own
  content blocking log. Shield's blocks are counted as trackers and ads.

Rules the Ledger keeps:

- **Local only.** Nothing in it is ever sent anywhere. It lives in `peryn-ledger.json` in your
  profile, and *Export Ledger…* saves a copy wherever you choose.
- **30 days.** Older days drop off on their own. *Clear Ledger* empties it.
- **The per-site part follows history.** It's browsing history in all but name, so:
  - clearing history clears it;
  - forgetting a site forgets it;
  - nothing is kept for private windows;
  - with history turned off, only daily totals are kept.

### How it's checked

The network audit in CI runs the real build behind a recording proxy. It fails if the browser
connects anywhere not on the every-request list. Since C7 it also reads the Ledger the
browser wrote and fails if the Ledger is missing any host the proxy saw. That's the cycle's
exit criterion: "Ledger matches network audit".

The UI preview also checks it in the official Firefox:

- A request made by the browser itself shows up in the Ledger, as unlisted.
- A page's own requests don't.
- Firefox's real background traffic during the run (Remote Settings, Safe Browsing, push,
  plugin and add-on updates, Shield lists) all lands on the right entries.

## The privacy page

| Section | What's there |
| --- | --- |
| Overview | Real counts for today, 7 or 30 days. Which protection level is on. The sites with the most blocked. No privacy score, on purpose. |
| Ledger | The browser's connections by purpose, as above, with export and clear |
| Blocked on sites | Each site and what was blocked there |
| Every connection | The complete every-request list: what each connection is for, whether you've seen it in 30 days, and how to turn it off or back on |
| Protection | **Strict** (what Peryn ships) or **Balanced** (Firefox's standard), each saying what it changes and what may break. **Custom** shows when you've mixed your own. The sites where protection is off, with Remove. |
| This site | The site you're on: protection on or off, then camera, microphone, screen sharing, location, notifications, autoplay, pop-ups, storage and the rest, each Ask / Allow / Block. Clear this site's cookies and data. |
| Clear data | History and downloads, cookies and site data, cache, form entries, site settings, over the last hour, two hours, four hours, today or everything |

## Cookie banners and nags

Firefox 158 removed its own cookie-banner handling. Peryn hides consent pop-ups instead, with
the EasyList and uBlock cookie-notice lists, and blocks the scripts that show them. A site
that never gets an answer has no consent. Newsletter overlays and "allow notifications?"
prompts are hidden the same way. Chat and social widget lists are available but off. See
[SHIELD.md](SHIELD.md).

## Spaces with identity

Each Space can have its own **search engine** and **protection level** (Space editor >
Search engine, Protection). A Space set to "Your default" uses yours.

Firefox has one default search engine and one protection level for the whole browser, so
Peryn switches them to the Space you're in: when you change Space, or come back to a window
that shows another Space. If you change the engine or level by hand, the change goes to the
Space you're in if it has its own choice, and to your default if it doesn't.

Not done: an extension set per Space. Firefox can only turn add-ons on or off for the whole
browser, and switching them with the Space would restart them and lose their state. Listed as
an open question.

## Code

| Piece | File |
| --- | --- |
| Ledger rules (unit-tested) | `src/browser/components/peryn/privacy/PerynLedgerLogic.sys.mjs` |
| Ledger service and per-window block reader | `privacy/PerynLedger.sys.mjs` |
| The every-request list for the browser, generated from `privacy/requests.toml` by `hx requests --write` | `privacy/PerynRequests.sys.mjs` |
| The privacy page and its words | `privacy/PerynPrivacy.sys.mjs`, `privacy/PerynPrivacyLogic.sys.mjs` |
| Space identity | `spaces/PerynSpaceIdentity.sys.mjs` |
| Network audit with the Ledger comparison | `tools/audit/network_audit.py` |

No new Firefox patches (still 8 of 60). The existing Shield classifier patch only gained the new list names.
