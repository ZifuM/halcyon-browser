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
CATALOG = ROOT / "src/browser/components/peryn/shield/ShieldListLogic.sys.mjs"
CC = ROOT / "patches/toolkit/components/content-classifier"
SHIELD_SRC = ROOT / "src/browser/components/peryn/shield"


def added_lines(patch: Path) -> str:
    return "\n".join(line[1:] for line in patch.read_text(encoding="utf-8").splitlines() if line.startswith("+"))


def cpp_list_ids() -> list[str]:
    added = "\n".join(line[1:] for line in PATCH.read_text(encoding="utf-8").splitlines() if line.startswith("+"))
    block = re.search(r"kShieldListIds\[\]\s*=\s*\{(.*?)\};", added, re.S)
    assert block, "kShieldListIds not found in the patch"
    return re.findall(r'"shield-([a-z0-9-]+)"_ns', block.group(1))


def js_list_ids() -> list[str]:
    text = CATALOG.read_text(encoding="utf-8")
    catalog = text[text.index("export const SHIELD_LISTS"): text.index("export const PREPROCESSOR_ENV")]
    return re.findall(r'^\s*id: "([a-z0-9-]+)",', catalog, re.M)


class ShieldSyncTests(unittest.TestCase):
    def test_list_ids_match(self):
        self.assertEqual(cpp_list_ids(), js_list_ids())
        self.assertGreaterEqual(len(js_list_ids()), 8)

    def test_feature_registered_in_patch(self):
        added = PATCH.read_text(encoding="utf-8")
        self.assertIn('+    {"shield"_ns, Span<const nsLiteralCString>(kShieldListIds),', added)

    def test_prefs_enable_the_shield_engine(self):
        with open(ROOT / "prefs/60-shield.toml", "rb") as fh:
            prefs = {p["name"]: p["value"] for p in tomllib.load(fh)["pref"]}
        self.assertIs(prefs["privacy.trackingprotection.content.protection.enabled"], True)
        self.assertEqual(prefs["privacy.trackingprotection.content.protection.engines"], "shield")
        self.assertEqual(prefs["privacy.trackingprotection.content.protection.engines.pbmode"], "shield")

    def test_list_hosts_are_in_the_registry(self):
        # Every list downloads from the two base URLs (`both(path)` in the catalog).
        bases = re.findall(r'^const UASSETS(?:_CDN)? = "https://([^"/]+)/', CATALOG.read_text(encoding="utf-8"), re.M)
        self.assertEqual(len(bases), 2)
        self.assertNotIn("urls: [", CATALOG.read_text(encoding="utf-8"), "lists must use both(...) so hosts stay known")
        hosts = set(bases)
        with open(ROOT / "privacy/requests.toml", "rb") as fh:
            entries = tomllib.load(fh)["request"]
        shield = next(e for e in entries if e["id"] == "shield-lists")
        self.assertEqual(hosts, set(shield["hosts"]))


class ElementHidingSyncTests(unittest.TestCase):
    """The element-hiding call chain crosses four patched files and a JS actor; a name that
    drifts in one of them would only show up in a full build."""

    def test_ffi_functions_are_called_by_the_engine_wrapper(self):
        rust = added_lines(CC / "content_classifier_engine/src/lib.rs.patch")
        header = added_lines(CC / "content_classifier_engine/ContentClassifierEngine.h.patch")
        exported = set(re.findall(r'pub unsafe extern "C" fn (content_classifier_engine_\w+)', rust))
        self.assertEqual(
            exported,
            {"content_classifier_engine_url_cosmetic_resources",
             "content_classifier_engine_hidden_class_id_selectors"},
        )
        for name in exported:
            self.assertIn(name + "(", header)

    def test_service_implements_the_idl_methods(self):
        idl = added_lines(CC / "nsIContentClassifierService.idl.patch")
        cpp = added_lines(CC / "ContentClassifierService.cpp.patch")
        header = added_lines(CC / "content_classifier_engine/ContentClassifierEngine.h.patch")
        for js_name, cpp_name in [("getCosmeticResources", "GetCosmeticResources"),
                                  ("getHiddenClassIdSelectors", "GetHiddenClassIdSelectors")]:
            self.assertIn(js_name + "(", idl)
            self.assertIn(f"ContentClassifierService::{cpp_name}(", cpp)
        for method in ("UrlCosmeticResources", "HiddenClassIdSelectors"):
            self.assertIn(f"nsresult {method}(", header)
            self.assertIn(f"engine->{method}(", cpp)

    def test_parent_actor_calls_the_idl_methods(self):
        parent = (SHIELD_SRC / "ShieldCosmeticParent.sys.mjs").read_text(encoding="utf-8")
        self.assertIn("classifier.getCosmeticResources(", parent)
        self.assertIn("classifier.getHiddenClassIdSelectors(", parent)

    def test_new_modules_are_in_moz_build(self):
        listed = set(re.findall(r'"(\w+\.sys\.mjs)"', (SHIELD_SRC / "moz.build").read_text(encoding="utf-8")))
        present = {p.name for p in SHIELD_SRC.glob("*.sys.mjs")}
        self.assertEqual(listed, present)

    def test_actor_registered_at_startup(self):
        manifest = (ROOT / "src/browser/components/peryn/peryn.manifest").read_text(encoding="utf-8")
        self.assertIn("category browser-before-ui-startup "
                      "moz-src:///browser/components/peryn/shield/ShieldCosmetic.sys.mjs "
                      "ShieldCosmetic.init", manifest)


if __name__ == "__main__":
    unittest.main()
