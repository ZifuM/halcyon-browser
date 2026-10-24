"""The layout component is wired in through a manifest and moz.build lists, and its tests run
against stub Firefox APIs; these checks catch the wiring drifting from the files."""

from __future__ import annotations

import re
import tomllib
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAYOUT = ROOT / "src/browser/components/halcyon/layout"
MANIFEST = ROOT / "src/browser/components/halcyon/halcyon.manifest"
MODULE_URL = "moz-src:///browser/components/halcyon/layout/HalcyonLayout.sys.mjs"


class LayoutWiringTests(unittest.TestCase):
    def test_every_layout_file_is_packaged(self):
        listed = set(re.findall(r'"([\w.-]+\.(?:sys\.mjs|css))"', (LAYOUT / "moz.build").read_text(encoding="utf-8")))
        present = {p.name for p in LAYOUT.iterdir() if p.suffix in (".css", ".mjs")}
        self.assertEqual(listed, present)

    def test_layout_dir_is_built(self):
        self.assertIn('"layout"', (ROOT / "src/browser/components/halcyon/moz.build").read_text(encoding="utf-8"))
        self.assertIn('"spaces"', (ROOT / "src/browser/components/halcyon/moz.build").read_text(encoding="utf-8"))

    def test_every_spaces_file_is_packaged(self):
        spaces = ROOT / "src/browser/components/halcyon/spaces"
        listed = set(re.findall(r'"([\w.-]+\.(?:sys\.mjs|css|svg))"', (spaces / "moz.build").read_text(encoding="utf-8")))
        present = {p.name for p in spaces.iterdir() if p.suffix in (".css", ".mjs", ".svg")}
        self.assertEqual(listed, present)

    def test_window_hooks_are_registered(self):
        manifest = MANIFEST.read_text(encoding="utf-8")
        module = (LAYOUT / "HalcyonLayout.sys.mjs").read_text(encoding="utf-8")
        for category, method in [
            ("browser-before-ui-startup", "init"),
            ("browser-window-before-initial-xul-layout", "beforeLayout"),
            ("browser-window-domcontentloaded", "onDOMContentLoaded"),
        ]:
            self.assertIn(f"category {category} {MODULE_URL} HalcyonLayout.{method}", manifest)
            self.assertRegex(module, rf"\n  {method}\(")

    def test_preview_registers_the_same_hooks(self):
        scenario = (ROOT / "tools/preview/PreviewScenario.sys.mjs").read_text(encoding="utf-8")
        manifest_hooks = re.findall(
            rf"category (browser-[\w-]+) {re.escape(MODULE_URL)} (HalcyonLayout\.\w+)", MANIFEST.read_text(encoding="utf-8"))
        for category, method in manifest_hooks:
            self.assertIn(f'["{category}", "{method}"]', scenario)

    def test_modules_import_each_other_relatively(self):
        # The preview harness loads them from resource://, so absolute moz-src imports of our
        # own layout modules would break it.
        for path in [*LAYOUT.glob("*.sys.mjs"), *(LAYOUT.parent / "spaces").glob("*.sys.mjs")]:
            text = path.read_text(encoding="utf-8")
            self.assertNotRegex(text, r'from "moz-src:///browser/components/halcyon/(layout|spaces)/', path.name)

    def test_layout_prefs_are_declared(self):
        logic = (LAYOUT / "HalcyonLayoutLogic.sys.mjs").read_text(encoding="utf-8") + (LAYOUT.parent / "spaces/HalcyonSpacesLogic.sys.mjs").read_text(encoding="utf-8")
        names = re.findall(r'"(halcyon\.[\w.]+)"', logic)
        declared = set()
        for f in (ROOT / "prefs").glob("*.toml"):
            with open(f, "rb") as fh:
                declared |= {p["name"] for p in tomllib.load(fh).get("pref", [])}
        for name in names:
            self.assertIn(name, declared, f"{name} has no default in prefs/")


if __name__ == "__main__":
    unittest.main()
