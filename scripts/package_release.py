"""Build and package the installed plugin using only Python's standard library."""

import argparse
import json
from pathlib import Path
import re
import subprocess
import zipfile


FILES = ("package.json", "index.html", "icon.png", "dist/index.js", "LICENSE")
ROOT = Path(__file__).resolve().parent.parent


def package(root, tag=None):
    manifest = json.loads((root / "package.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("Expected a release version without build metadata")
    if tag is not None and tag != f"v{version}":
        raise ValueError(f"Tag must match package.json: v{version}")
    if lock["version"] != version or lock["packages"][""]["version"] != version:
        raise ValueError("package-lock.json version must match package.json")
    if manifest["logseq"]["id"] != "journal-routines":
        raise ValueError("Keep the installed plugin identity journal-routines")
    if manifest["main"] != "index.html" or manifest["icon"] != "./icon.png":
        raise ValueError("Review the release allowlist if entrypoint/assets change")

    # Always rebuild: never package a stale Git-ignored bundle.
    subprocess.run(["npm", "run", "build"], cwd=root, check=True)
    contents = [(name, (root / name).read_bytes()) for name in FILES]
    if any(not data for _, data in contents):
        raise ValueError("Release files must not be empty")
    output = root / "release" / f"journal-routines-{version}.zip"
    output.parent.mkdir(exist_ok=True)
    # Fixed order, timestamp, permissions and no compression: identical input
    # bytes give identical ZIP bytes across platforms/zlib versions. The bundle
    # is small, so avoiding compression is a deliberate reproducibility tradeoff.
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, data in contents:
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, data)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="Require this tag to match the package version")
    args = parser.parse_args()
    print(package(ROOT, args.tag))
