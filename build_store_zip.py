#!/usr/bin/env python3
"""Build the Edge Add-ons store ZIP from this repository.

Only the files the extension actually needs at runtime are included, so test
fixtures (which contain their own manifest.json) never end up in the package.

Usage:  python build_store_zip.py
Output: pawchive-downloader-store-<version>.zip (next to this script)
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Everything the extension needs at runtime. Keep this list minimal:
# extra manifest.json files anywhere in the package make Edge validation fail.
INCLUDE = [
    "manifest.json",
    "background.js",
    "lang.js",
    "redirect.js",
    "offscreen.html",
    "offscreen.js",
    "_locales/",
    "content/",
    "icons/",
    "mini/",
    "popup/",
]


def wanted(rel):
    rel = rel.replace("\\", "/")
    return any(rel == e or rel.startswith(e) for e in INCLUDE if e.endswith("/")) or rel in INCLUDE


def main():
    with open(os.path.join(HERE, "manifest.json"), encoding="utf-8") as f:
        version = json.load(f)["version"]
    out = os.path.join(HERE, f"pawchive-downloader-{version}.zip")
    if os.path.exists(out):
        os.remove(out)

    count = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(HERE):
            dirs[:] = [d for d in sorted(dirs) if d not in (".git",)]
            for name in sorted(files):
                full = os.path.join(root, name)
                rel = os.path.relpath(full, HERE).replace("\\", "/")
                if not wanted(rel):
                    continue
                z.write(full, rel)
                count += 1

    with zipfile.ZipFile(out) as z:
        manifests = [n for n in z.namelist() if n.endswith("manifest.json")]
    if len(manifests) != 1:
        print(f"ERROR: expected exactly 1 manifest.json, found {manifests}")
        sys.exit(1)

    # Copy the finished package into the sibling 打包 folder when present
    # (repo layout: .../pawchive-downloader/项目目录/<this repo>, so ../../打包).
    pkg_dir = os.path.normpath(os.path.join(HERE, "..", "..", "打包"))
    if os.path.isdir(pkg_dir):
        import shutil
        shutil.copy2(out, os.path.join(pkg_dir, os.path.basename(out)))
        print("copied to:", os.path.join(pkg_dir, os.path.basename(out)))
    print(f"OK: {out} ({count} files, version {version}, 1 manifest)")


if __name__ == "__main__":
    main()
