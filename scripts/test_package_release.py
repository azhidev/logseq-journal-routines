import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from package_release import FILES, ROOT, package


class MarketplaceManifestTests(unittest.TestCase):
    def test_proposal_uses_official_fields_and_supported_graph_target(self):
        manifest = json.loads((ROOT / "marketplace/packages/logseq-journal-routines/manifest.json").read_text())
        allowed = {"title", "description", "author", "repo", "icon", "theme",
                   "sponsors", "web", "effect", "supportsDB", "supportsDBOnly"}
        self.assertLessEqual(set(manifest), allowed)
        for key in ("title", "description", "author", "repo"):
            self.assertIsInstance(manifest[key], str)
            self.assertTrue(manifest[key].strip())
        self.assertEqual(manifest["repo"], "azhidev/logseq-journal-routines")
        plugin = json.loads((ROOT / "package.json").read_text())
        self.assertEqual(manifest["title"], plugin["logseq"]["title"])
        self.assertEqual(manifest["icon"], "icon.png")
        self.assertTrue((ROOT / manifest["icon"]).is_file())
        for key in ("effect", "supportsDB", "supportsDBOnly"):
            self.assertIs(manifest[key], False)
        for key in ("theme", "web"):
            self.assertIs(manifest.get(key, False), False)


class ReleasePackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        manifest = {
            "version": "0.5.0", "main": "index.html", "icon": "./icon.png",
            "logseq": {"id": "journal-routines"},
        }
        (self.root / "package.json").write_text(json.dumps(manifest))
        (self.root / "package-lock.json").write_text(json.dumps({
            "version": "0.5.0", "packages": {"": {"version": "0.5.0"}},
        }))
        (self.root / "dist").mkdir()
        for name in FILES[1:]:
            (self.root / name).write_text("stale" if name == "dist/index.js" else name)
        (self.root / "secret-dev-file.txt").write_text("not installed")

    def build(self, *args, **kwargs):
        self.assertEqual(args[0], ["npm", "run", "build"])
        self.assertEqual(kwargs, {"cwd": self.root, "check": True})
        (self.root / "dist/index.js").write_text("fresh build")

    def test_allowlist_fresh_bundle_and_deterministic_bytes(self):
        with patch("package_release.subprocess.run", side_effect=self.build) as build:
            output = package(self.root, "v0.5.0")
            first = output.read_bytes()
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(archive.namelist(), list(FILES))
                self.assertIsNone(archive.testzip())
                self.assertEqual(archive.read("dist/index.js"), b"fresh build")
                self.assertEqual(json.loads(archive.read("package.json"))["logseq"]["id"],
                                 "journal-routines")
                for entry in archive.infolist():
                    self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                    self.assertEqual(entry.external_attr >> 16, 0o100644)
            (self.root / "dist/index.js").touch()
            self.assertEqual(package(self.root).read_bytes(), first)
            self.assertEqual(build.call_count, 2)

    def test_bad_tag_and_lock_fail_before_build(self):
        with patch("package_release.subprocess.run") as build:
            with self.assertRaisesRegex(ValueError, "Tag must match"):
                package(self.root, "v0.5.1")
            (self.root / "package-lock.json").write_text(json.dumps({
                "version": "0.5.1", "packages": {"": {"version": "0.5.1"}},
            }))
            with self.assertRaisesRegex(ValueError, "package-lock"):
                package(self.root)
            build.assert_not_called()

    def test_failed_build_does_not_package_stale_bundle(self):
        with patch("package_release.subprocess.run",
                   side_effect=subprocess.CalledProcessError(1, "npm")):
            with self.assertRaises(subprocess.CalledProcessError):
                package(self.root)
        self.assertFalse((self.root / "release").exists())

    def test_missing_or_empty_runtime_file_fails(self):
        with patch("package_release.subprocess.run", side_effect=self.build):
            (self.root / "icon.png").unlink()
            with self.assertRaises(FileNotFoundError):
                package(self.root)
            (self.root / "icon.png").write_bytes(b"")
            with self.assertRaisesRegex(ValueError, "not be empty"):
                package(self.root)
        self.assertFalse((self.root / "release").exists())

    def test_versions_keep_manifest_and_identity_without_migration(self):
        with patch("package_release.subprocess.run", side_effect=self.build):
            for version in ("0.5.0-alpha.1", "0.5.0", "0.5.1"):
                manifest = json.loads((self.root / "package.json").read_text())
                manifest["version"] = version
                (self.root / "package.json").write_text(json.dumps(manifest))
                (self.root / "package-lock.json").write_text(json.dumps({
                    "version": version, "packages": {"": {"version": version}},
                }))
                with zipfile.ZipFile(package(self.root, f"v{version}")) as archive:
                    self.assertEqual(json.loads(archive.read("package.json")), manifest)
            manifest["logseq"]["id"] = "different-plugin"
            (self.root / "package.json").write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "identity"):
                package(self.root)
