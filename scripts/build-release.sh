#!/bin/sh
# Builds dist/remember-tabs-v<version>.zip containing only the files the extension needs.
# Unzipping it gives a "remember-tabs" folder to use with "Load unpacked".
set -eu
cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' manifest.json | head -1)
OUT="dist/remember-tabs-v${VERSION}.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/remember-tabs" dist
cp -R manifest.json background.js lib sidepanel icons README.md "$STAGE/remember-tabs/"
find "$STAGE" -name '.DS_Store' -delete

rm -f "$OUT"
(cd "$STAGE" && COPYFILE_DISABLE=1 zip -qrX - remember-tabs) > "$OUT"
echo "Built $OUT"
unzip -l "$OUT"
