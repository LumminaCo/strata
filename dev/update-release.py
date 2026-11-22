"""Build the Tauri release config and the update manifest for signed releases."""

import json
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.parse import quote


def write_json(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content, indent=2) + "\n", encoding="utf-8")


def configure(platform, repository, version):
    key = os.environ["STRATA_UPDATER_PUBLIC_KEY"].strip()
    if not key or not os.environ.get("TAURI_SIGNING_PRIVATE_KEY"):
        raise SystemExit("Signed releases require the updater public and private keys.")

    config = json.loads(Path("apps/desktop/src-tauri/tauri.conf.json").read_text())
    workspace = tomllib.loads(Path("Cargo.toml").read_text())
    if version != config["version"] or version != workspace["workspace"]["package"]["version"]:
        raise SystemExit("The release tag must match the Tauri and Cargo workspace versions.")

    write_json(Path(".local/tauri-release.json"), {
        "bundle": {"createUpdaterArtifacts": platform != "linux"},
        "plugins": {
            "updater": {
                "pubkey": key,
                "endpoints": [f"https://github.com/{repository}/releases/latest/download/latest.json"],
                "requireSignedVersion": True,
                "windows": {"installMode": "passive"},
            },
        },
    })


def manifest(directory, repository, tag, version):
    artifacts = {
        "linux-x86_64-appimage": f"Strata_{version}_amd64.AppImage",
        "linux-x86_64-deb": f"Strata_{version}_amd64.deb",
        "windows-x86_64-nsis": f"Strata_{version}_x64-setup.exe",
        "darwin-aarch64-app": "Strata.app.tar.gz",
    }
    platforms = {}
    for target, filename in artifacts.items():
        bundle = directory / filename
        if not bundle.is_file() or not bundle.stat().st_size:
            raise SystemExit(f"Missing or empty update artifact: {bundle}")
        signature = (directory / f"{filename}.sig").read_text(encoding="utf-8").strip()
        if not signature:
            raise SystemExit(f"Missing signature content for {bundle}")
        platforms[target] = {
            "url": f"https://github.com/{repository}/releases/download/{tag}/{quote(filename)}",
            "signature": signature,
        }
    write_json(directory / "latest.json", {"version": version, "platforms": platforms})


if __name__ == "__main__":
    action, argument = sys.argv[1:]
    repository = os.environ["STRATA_RELEASE_REPOSITORY"]
    tag = os.environ["GITHUB_REF_NAME"]
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", repository, re.ASCII):
        raise SystemExit("STRATA_RELEASE_REPOSITORY must be a GitHub owner/repository.")
    if not re.fullmatch(r"v(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}", tag):
        raise SystemExit("Use a stable release tag in the form vMAJOR.MINOR.PATCH.")
    version = tag[1:]
    if action == "configure":
        configure(argument, repository, version)
    elif action == "manifest":
        manifest(Path(argument), repository, tag, version)
    else:
        raise SystemExit(f"Unknown release action: {action}")
