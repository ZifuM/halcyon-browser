"""Tests for the hx toolchain. Runs offline against a tiny fake Firefox repository.

    python3 -m unittest discover -s tests      (from the project root)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from hx import build, config, engine, prefs, upstream  # noqa: E402
from hx.util import HxError, rmtree  # noqa: E402

GIT_ENV = {
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1",
}


def sh(cwd: Path, *args: str) -> str:
    res = subprocess.run(args, cwd=cwd, env={**os.environ, **GIT_ENV}, text=True,
                         capture_output=True, check=True)
    return res.stdout


def write(path: Path, text: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(text, bytes):
        path.write_bytes(text)
    else:
        path.write_text(textwrap.dedent(text).lstrip("\n"), encoding="utf-8", newline="\n")


UPSTREAM_FILES = {
    "browser/branding/unofficial/configure.sh": "MOZ_APP_DISPLAYNAME=Nightly\n",
    "browser/branding/unofficial/pref/firefox-branding.js": 'pref("startup.homepage_welcome_url", "");\n',
    "browser/branding/unofficial/locales/en-US/brand.ftl": "-brand-short-name = Nightly\n",
    "browser/moz.configure": 'imply_option("MOZ_PLACES", True)\nimply_option("MOZ_NORMANDY", True)\n'
                             'imply_option("MOZ_PROFILE_MIGRATOR", True)\n',
    "moz.configure": 'option("--disable-tests", help="x")\noption(env="MOZ_PGO", help="y")\n',
    "toolkit/moz.configure": 'option(\n    "--enable-crashreporter",\n    default=True,\n)\n'
                             'project_flag(\n    env="MOZ_APP_VENDOR",\n    nargs=1,\n)\n',
    "build/moz.configure/init.configure": 'option(\n    "--with-app-name",\n    nargs=1,\n)\n',
    "modules/libpref/init/all.js": 'pref("a.b", true);\n',
    "modules/libpref/init/StaticPrefList.yaml": "- name: c.d\n  type: bool\n  value: false\n",
    "browser/app/profile/firefox.js": 'pref("e.f", 1);\n',
    "browser/extensions/newtab/lib/ActivityStream.sys.mjs": 'const PREFS = new Map([["showSponsored", true]]);\n',
}


class Fixture(unittest.TestCase):
    """Builds a fake upstream repo tagged as Firefox 158.0.1 and a project pointing at it."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hx-test-"))
        self.up = self.tmp / "upstream"
        self.up.mkdir()
        sh(self.up, "git", "init", "-q", "-b", "main")
        for rel, text in UPSTREAM_FILES.items():
            write(self.up / rel, text)
        write(self.up / "browser/branding/unofficial/default16.png", b"\x89PNG-fake")
        sh(self.up, "git", "add", "-A")
        sh(self.up, "git", "commit", "-qm", "base")
        sh(self.up, "git", "tag", "FIREFOX_158_0_1_RELEASE")

        self.root = self.tmp / "proj"
        write(self.root / "project.toml", f"""
            [identity]
            name = "Testy"
            app_name = "testy"
            vendor = "Testy"
            bundle_id = "app.testy.browser"
            homepage = "https://testy.invalid"
            [version]
            display = "0.1.0"
            [upstream]
            firefox = "158.0.1"
            repo = "{self.up.as_uri()}"
            channel = "release"
            [policy]
            patch_budget = 2
            security_sla_hours = 72
        """)
        write(self.root / "branding/overlay/configure.sh", "MOZ_APP_DISPLAYNAME={{NAME}}\n")
        write(self.root / "branding/overlay/locales/en-US/brand.ftl", "-brand-short-name = {{NAME}}\n")
        write(self.root / "branding/overlay/default16.png", b"\x89PNG-ours")
        write(self.root / "prefs/10-test.toml", """
            [meta]
            title = "Test prefs"
            [[pref]]
            name = "a.b"
            value = false
            why = "because"
            [[pref]]
            name = "c.d"
            value = "x\\"y"
            why = "quotes survive"
            [[pref]]
            name = "browser.newtabpage.activity-stream.showSponsored"
            value = false
            why = "short key"
            upstream = "browser/extensions/newtab/lib/ActivityStream.sys.mjs"
            match = "showSponsored"
        """)
        write(self.root / "src/browser/components/testy/Thing.sys.mjs", "export const x = 1;\n")
        for name, text in {
            "common": "ac_add_options --with-app-name={{APP_NAME}}\nac_add_options --disable-tests\n",
            "linux": "", "macos": "", "windows": "ac_add_options --target=x86_64-pc-windows-msvc\n",
            "release": "ac_add_options MOZ_PGO=1\n", "dev": "", "artifact": "",
        }.items():
            write(self.root / f"configs/{name}.mozconfig", text)
        (self.root / "patches").mkdir()
        self.project = config.load(self.root)

    def tearDown(self):
        rmtree(self.tmp)

    def ready(self) -> engine.ImportReport:
        engine.download(self.project)
        return engine.import_changes(self.project)


class ConfigTests(Fixture):
    def test_tag_and_tokens(self):
        self.assertEqual(config.firefox_tag("158.0.1"), "FIREFOX_158_0_1_RELEASE")
        self.assertEqual(config.firefox_tag("159.0"), "FIREFOX_159_0_RELEASE")
        tok = self.project.tokens()
        self.assertEqual((tok["DISTRIBUTION_ID"], tok["MACBUNDLE_ID"]), ("app.testy", "browser"))
        with self.assertRaises(config.ConfigError):
            config.firefox_tag("158.0b3")

    def test_bump_preserves_file(self):
        config.set_firefox_version(self.root, "159.0")
        text = (self.root / "project.toml").read_text()
        self.assertIn('firefox = "159.0"', text)
        self.assertIn("[policy]", text)
        self.assertEqual(config.load(self.root).firefox_version, "159.0")


class UpstreamTests(unittest.TestCase):
    def test_parse_release_tags_only(self):
        out = "\n".join([
            "a\trefs/tags/FIREFOX_158_0_RELEASE", "b\trefs/tags/FIREFOX_158_0_1_RELEASE",
            "c\trefs/tags/FIREFOX_159_0b3_RELEASE", "d\trefs/tags/FIREFOX_153_0esr_RELEASE",
            "e\trefs/tags/FIREFOX_158_0_1_RELEASE^{}", "f\trefs/tags/FIREFOX_157_0_RELEASE",
        ])
        versions = upstream.release_versions(out)
        self.assertEqual([str(v) for v in versions], ["157.0", "158.0", "158.0.1"])

    def test_status_kind(self):
        V = upstream.Version.parse
        self.assertEqual(upstream.UpstreamStatus(V("158.0"), V("158.0.1")).kind, "point")
        self.assertEqual(upstream.UpstreamStatus(V("158.0.1"), V("159.0")).kind, "major")
        self.assertFalse(upstream.UpstreamStatus(V("159.0"), V("159.0")).behind)


class PrefsTests(Fixture):
    def test_compile_never_locks_and_escapes(self):
        js = prefs.compile_js(prefs.load_groups(self.root / "prefs"), "Testy")
        self.assertIn('pref("a.b", false);', js)
        self.assertIn('pref("c.d", "x\\"y");', js)
        self.assertNotIn("lockPref", js)
        self.assertNotIn("sticky", js)

    def test_rejects_bad_entries(self):
        cases = {
            "float": 'name = "x.y"\nvalue = 1.5\nwhy = "w"',
            "no-why": 'name = "x.y"\nvalue = true\nwhy = " "',
            "unknown-key": 'name = "x.y"\nvalue = true\nwhy = "w"\nlocked = true',
            "match-without-upstream": 'name = "x.y"\nvalue = true\nwhy = "w"\nmatch = "y"',
        }
        for label, body in cases.items():
            with self.subTest(label):
                d = self.tmp / f"p-{label}"
                write(d / "a.toml", "[[pref]]\n" + body + "\n")
                with self.assertRaises(HxError):
                    prefs.load_groups(d)

    def test_duplicate_across_files(self):
        write(self.root / "prefs/20-dup.toml", '[[pref]]\nname = "a.b"\nvalue = true\nwhy = "w"\n')
        with self.assertRaisesRegex(HxError, "both"):
            prefs.load_groups(self.root / "prefs")

    def test_audit(self):
        engine.download(self.project)
        write(self.root / "prefs/20-more.toml", '[[pref]]\nname = "no.such.pref"\nvalue = 1\nwhy = "w"\n')
        result = prefs.audit(prefs.load_groups(self.root / "prefs"), self.project.engine)
        self.assertEqual(result.verified["a.b"], "modules/libpref/init/all.js")
        self.assertEqual(result.verified["c.d"], "modules/libpref/init/StaticPrefList.yaml")
        self.assertIn("as 'showSponsored'", result.verified["browser.newtabpage.activity-stream.showSponsored"])
        self.assertEqual([p.name for p in result.unverified], ["no.such.pref"])


class EngineTests(Fixture):
    def test_import_builds_branding_prefs_and_src(self):
        report = self.ready()
        eng = self.project.engine
        brand = eng / "browser/branding/testy"
        self.assertEqual((brand / "configure.sh").read_text(), "MOZ_APP_DISPLAYNAME=Testy\n")
        self.assertEqual((brand / "default16.png").read_bytes(), b"\x89PNG-ours")
        pref_js = (brand / "pref/firefox-branding.js").read_text()
        self.assertTrue(pref_js.startswith('pref("startup.homepage_welcome_url", "");'))
        self.assertIn('pref("a.b", false);', pref_js)
        self.assertTrue((eng / "browser/components/testy/Thing.sys.mjs").is_file())
        self.assertEqual((report.src_files, report.prefs), (1, 3))
        self.assertEqual(engine.status(self.project), [])

    def test_tmpl_files_are_rendered_and_protected(self):
        write(self.root / "src/browser/components/testy/Info.sys.mjs.tmpl",
              'export const v = "{{DISPLAY_VERSION}}", n = "{{NAME}}";\n')
        self.ready()
        out = self.project.engine / "browser/components/testy/Info.sys.mjs"
        self.assertEqual(out.read_text(), 'export const v = "0.1.0", n = "Testy";\n')
        self.assertFalse(out.with_name("Info.sys.mjs.tmpl").exists())
        with self.assertRaisesRegex(HxError, "Edit the template"):
            engine.export(self.project, ["browser/components/testy/Info.sys.mjs"])

    def test_own_prefs_must_be_read_by_src(self):
        write(self.root / "prefs/90-own.toml",
              '[[pref]]\nname = "testy.feature"\nvalue = true\nwhy = "w"\nown = true\n')
        engine.download(self.project)
        groups = prefs.load_groups(self.root / "prefs")
        result = prefs.audit(groups, self.project.engine, self.root / "src")
        self.assertIn("testy.feature", [p.name for p in result.unverified])
        write(self.root / "src/browser/components/testy/Feature.sys.mjs",
              'Services.prefs.getBoolPref("testy.feature", true);\n')
        result = prefs.audit(groups, self.project.engine, self.root / "src")
        self.assertEqual(result.verified["testy.feature"], "src/ (own)")

    def test_src_may_not_shadow_upstream(self):
        write(self.root / "src/browser/moz.configure", "nope\n")
        engine.download(self.project)
        with self.assertRaisesRegex(HxError, "would replace an upstream file"):
            engine.import_changes(self.project)

    def test_export_roundtrip(self):
        self.ready()
        eng = self.project.engine
        target = eng / "browser/moz.configure"
        target.write_text(target.read_text().replace('imply_option("MOZ_NORMANDY", True)\n', ""), newline="\n")
        write(eng / "browser/components/testy/New.sys.mjs", "export {};\n")
        self.assertEqual(sorted(engine.status(self.project)),
                         ["browser/components/testy/New.sys.mjs", "browser/moz.configure"])
        written = engine.export(self.project, [], all_dirty=True)
        self.assertIn("patches/browser/moz.configure.patch", written)
        self.assertIn("src/browser/components/testy/New.sys.mjs", written)
        self.assertEqual(engine.status(self.project), [])

        report = engine.import_changes(self.project)  # fresh reset + re-apply
        self.assertEqual(report.patches_applied, ["browser/moz.configure"])
        self.assertNotIn("MOZ_NORMANDY", target.read_text())
        self.assertTrue((eng / "browser/components/testy/New.sys.mjs").is_file())

        target.write_text(target.read_text() + "# reverted later\n", newline="\n")
        engine.export(self.project, ["browser/moz.configure"])
        self.assertIn("reverted later", (self.root / "patches/browser/moz.configure.patch").read_text())

    def test_unexported_edits_block_import(self):
        self.ready()
        (self.project.engine / "browser/moz.configure").write_text("edited\n", newline="\n")
        with self.assertRaisesRegex(HxError, "not exported"):
            engine.import_changes(self.project)
        engine.import_changes(self.project, force=True)
        self.assertNotEqual((self.project.engine / "browser/moz.configure").read_text(), "edited\n")

    def test_branding_edits_must_go_to_overlay(self):
        self.ready()
        with self.assertRaisesRegex(HxError, "generated branding"):
            engine.export(self.project, ["browser/branding/testy/configure.sh"])

    def test_conflicting_patch_after_rebase_is_reported(self):
        self.ready()
        t = self.project.engine / "browser/moz.configure"
        t.write_text(t.read_text().replace('"MOZ_NORMANDY", True', '"MOZ_NORMANDY", False'), newline="\n")
        engine.export(self.project, ["browser/moz.configure"])
        # Upstream releases 159.0 with a conflicting change on the same line.
        f = self.up / "browser/moz.configure"
        f.write_text(f.read_text().replace('"MOZ_NORMANDY", True', '"MOZ_NORMANDY", "maybe"'), newline="\n")
        sh(self.up, "git", "commit", "-qam", "upstream change")
        sh(self.up, "git", "tag", "FIREFOX_159_0_RELEASE")
        config.set_firefox_version(self.root, "159.0")
        project = config.load(self.root)
        # Without the old base, git can't merge: clean hunks apply and the rest go to a .rej file.
        engine.download(project, force=True)
        with self.assertRaisesRegex(HxError, r"\.rej"):
            engine.import_changes(project)
        # `hx rebase` also fetches the previous tag, which gives real conflict markers.
        engine.download(project, force=True, also_fetch=["FIREFOX_158_0_1_RELEASE"])
        with self.assertRaisesRegex(HxError, "conflict markers"):
            engine.import_changes(project)
        # Resolve the conflict in place, export it, and the next import succeeds.
        t = project.engine / "browser/moz.configure"
        self.assertIn("<<<<<<<", t.read_text())
        t.write_text('imply_option("MOZ_PLACES", True)\nimply_option("MOZ_PROFILE_MIGRATOR", True)\n', newline="\n")
        engine.export(project, ["browser/moz.configure"])
        report = engine.import_changes(project)
        self.assertEqual(report.patches_applied, ["browser/moz.configure"])
        self.assertNotIn("NORMANDY", t.read_text())
        self.assertEqual(engine.status(project), [])

    def test_patch_budget(self):
        self.ready()
        eng = self.project.engine
        for rel in ("moz.configure", "toolkit/moz.configure", "modules/libpref/init/all.js"):
            (eng / rel).write_text((eng / rel).read_text() + "# change\n", newline="\n")
        engine.export(self.project, [], all_dirty=True)
        with self.assertRaisesRegex(HxError, "exceeds the budget"):
            engine.import_changes(self.project)
        engine.import_changes(self.project, allow_over_budget=True)

    def test_rmtree_removes_read_only_files(self):
        target = self.tmp / "ro" / "file"
        write(target, "x")
        os.chmod(target, 0o444)
        rmtree(self.tmp / "ro")
        self.assertFalse((self.tmp / "ro").exists())

    def test_download_refuses_version_mismatch(self):
        engine.download(self.project)
        engine.download(self.project)  # same version: no-op
        config.set_firefox_version(self.root, "159.0")
        with self.assertRaisesRegex(HxError, "--force"):
            engine.download(config.load(self.root))


class MozconfigTests(Fixture):
    def test_compose_renders_tokens(self):
        text = build.compose_mozconfig(self.project, "windows", "release")
        self.assertIn("--with-app-name=testy", text)
        self.assertIn("--target=x86_64-pc-windows-msvc", text)
        self.assertIn("MOZ_PGO=1", text)

    def test_validate_options_against_upstream(self):
        engine.download(self.project)
        self.assertEqual(build.validate_mozconfigs(self.project), [])
        with open(self.root / "configs/dev.mozconfig", "a") as fh:
            fh.write("ac_add_options --enable-imaginary\nac_add_options MOZ_FAKE=1\n"
                     "ac_add_options --disable-crashreporter\n")
        problems = build.validate_mozconfigs(self.project)
        self.assertTrue(any("--enable-imaginary" in p for p in problems))
        self.assertTrue(any("MOZ_FAKE" in p for p in problems))
        self.assertFalse(any("crashreporter" in p for p in problems))


if __name__ == "__main__":
    unittest.main()


class SrcListingTests(unittest.TestCase):
    def test_missing_listed_files_are_reported_with_how_to_build(self):
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp)
            write(src / "a/moz.build", 'MOZ_SRC_FILES += [\n    "Here.sys.mjs",\n    "omni_index.wasm",\n    "Info.sys.mjs",\n]\n')
            write(src / "a/Here.sys.mjs", "")
            write(src / "a/Info.sys.mjs.tmpl", "")
            with self.assertRaises(HxError) as caught:
                engine._check_src_listings(src)
            message = str(caught.exception)
            self.assertIn("src/a/omni_index.wasm", message)
            self.assertIn("build_wasm.py", message)
            self.assertNotIn("Here.sys.mjs", message)
            self.assertNotIn("Info.sys.mjs", message)
            write(src / "a/omni_index.wasm", b"\0asm")
            engine._check_src_listings(src)  # complete: no error


class UserAgentTests(unittest.TestCase):
    def test_reports_itself_as_firefox(self):
        # Without this, Gecko replaces the "Firefox/<version>" token with our own name and sites
        # like Google and YouTube treat the browser as outdated.
        # configure only accepts it implied by the application's moz.configure (our patch).
        patch = (ROOT / "patches/browser/moz.configure.patch").read_text(encoding="utf-8")
        self.assertIn('+imply_option("MOZ_APP_UA_NAME", "Firefox")', patch)
        for path in ["configs/common.mozconfig", "branding/overlay/configure.sh"]:
            self.assertNotIn("MOZ_APP_UA_NAME", (ROOT / path).read_text(encoding="utf-8"), path)
