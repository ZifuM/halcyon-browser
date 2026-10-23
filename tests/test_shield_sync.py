"""Shield's list ids live in two places that must agree: the C++ feature table (patch) and the JS
catalog. A list missing from the C++ side would download but never block; one missing from the JS
side would always be empty. Also checks the prefs point the classifier at the Shield feature."""

from __future__ import annotations

import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATCH = ROOT / "patches/toolkit/components/content-classifier/ContentClassifierService.cpp.patch"
CATALOG = ROOT / "src/browser/components/halcyon/shield/ShieldListLogic.sys.mjs"


def cpp_list_ids() -> list[str]:
    added = "\n".join(line[1:] for line in PATCH.read_text().splitlines() if line.startswith("+"))
    block = re.search(r"kShieldListIds\[\]\s*=\s*\{(.*?)\};", added, re.S)
    assert block, "kShieldListIds not found in the patch"
    return re.findall(r'"shield-([a-z0-9-]+)"_ns', block.group(1))


def js_list_ids() -> list[str]:
    text = CATALOG.read_text()
    catalog = text[text.index("export const SHIELD_LISTS"): text.index("export const PREPROCESSOR_ENV")]
    return re.findall(r'^\s*id: "([a-z0-9-]+)",', catalog, re.M)


class ShieldSyncTests(unittest.TestCase):
    def test_list_ids_match(self):
        self.assertEqual(cpp_list_ids(), js_list_ids())
        self.assertGreaterEqual(len(js_list_ids()), 8)

    def test_feature_registered_in_patch(self):
        added = PATCH.read_text()
        self.assertIn('+    {"shield"_ns, Span<const nsLiteralCString>(kShieldListIds),', added)

    def test_prefs_enable_the_shield_engine(self):
        with open(ROOT / "prefs/60-shield.toml", "rb") as fh:
            prefs = {p["name"]: p["value"] for p in tomllib.load(fh)["pref"]}
        self.assertIs(prefs["privacy.trackingprotection.content.protection.enabled"], True)
        self.assertEqual(prefs["privacy.trackingprotection.content.protection.engines"], "shield")
        self.assertEqual(prefs["privacy.trackingprotection.content.protection.engines.pbmode"], "shield")

    def test_list_hosts_are_in_the_registry(self):
        # Every list downloads from the two base URLs (`both(path)` in the catalog).
        bases = re.findall(r'^const UASSETS(?:_CDN)? = "https://([^"/]+)/', CATALOG.read_text(), re.M)
        self.assertEqual(len(bases), 2)
        self.assertNotIn("urls: [", CATALOG.read_text(), "lists must use both(...) so hosts stay known")
        hosts = set(bases)
        with open(ROOT / "privacy/requests.toml", "rb") as fh:
            entries = tomllib.load(fh)["request"]
        shield = next(e for e in entries if e["id"] == "shield-lists")
        self.assertEqual(hosts, set(shield["hosts"]))


if __name__ == "__main__":
    unittest.main()
