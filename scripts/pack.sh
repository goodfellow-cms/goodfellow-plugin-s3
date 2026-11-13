#!/usr/bin/env bash
# Packs the release into the folder given, emptied first so nothing else in it is uploaded with it, and prints the
# package's name, the file's name and its digest as `key=value` lines, which the publish workflow adds to its
# outputs. CI runs it on every change, so a release that can't be packed shows before its version is tagged.
# `.npmrc`'s `ignore-scripts` keeps npm from running any script of the package's own while packing.
set -euo pipefail

dest=${1:?Give the folder to pack into.}
rm -rf "$dest"
# npm pack writes only into a folder that's there already.
mkdir -p "$dest"
name=$(node -p 'require("./package.json").name')
tarball=$(npm pack --json --pack-destination "$dest" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8"))[0].filename')
digest="sha512-$(openssl dgst -sha512 -binary "$dest/$tarball" | base64 -w0)"
echo "name=$name"
echo "tarball=$tarball"
echo "digest=$digest"
