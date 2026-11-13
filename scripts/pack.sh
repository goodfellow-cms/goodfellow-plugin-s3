#!/usr/bin/env bash
# Packs the release into the folder given and prints the package's name, the file's name and its digest as
# `key=value` lines, which the publish workflow adds to its outputs. CI runs it on every change, so a release that
# can't be packed shows before its version is tagged, and a maintainer can run it from anywhere to compare a digest:
# `bash scripts/pack.sh "$(mktemp -d)"`. `.npmrc`'s `ignore-scripts` keeps npm from running any script of the
# package's own while packing.
set -euo pipefail

dest=${1:?Give the folder to pack into.}
# npm pack writes only into a folder that's there already.
mkdir -p "$dest"
dest=$(cd "$dest" && pwd)
# Only earlier packs are cleared, so that only this one is uploaded: a folder holding anything else is refused,
# never emptied, in case it's the wrong one.
if [ -n "$(find "$dest" -mindepth 1 -maxdepth 1 ! \( -type f -name '*.tgz' \) -print -quit)" ]; then
  echo "$dest holds more than packed releases. Give an empty folder." >&2
  exit 1
fi
find "$dest" -mindepth 1 -maxdepth 1 -type f -name '*.tgz' -delete

cd "$(dirname "$0")/.."
name=$(node -p 'require("./package.json").name')
tarball=$(npm pack --json --pack-destination "$dest" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].filename')
# openssl's own base64, which reads the same on Linux and macOS.
digest="sha512-$(openssl dgst -sha512 -binary "$dest/$tarball" | openssl base64 -A)"
echo "name=$name"
echo "tarball=$tarball"
echo "digest=$digest"
