# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
# Generated from branding/overlay/configure.sh by `hx import`.

MOZ_APP_DISPLAYNAME={{NAME}}
MOZ_MACBUNDLE_ID={{MACBUNDLE_ID}}
# Report ourselves as Firefox (".. Gecko/20100101 Firefox/158.0"), exactly like the release we're
# built on. Otherwise Gecko puts our own name in place of the Firefox token, and sites that sniff
# for it (Google, YouTube) serve old-browser pages. It's also better for privacy: a browser with
# a rare user agent is easier to fingerprint. (Only settable here or in confvars.sh.)
MOZ_APP_UA_NAME=Firefox
