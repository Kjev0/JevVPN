#!/usr/bin/env bash
# Builds the self-extracting JevVPN installer from the .deb:
#   make-run-installer.sh dist/JevVPN-<version>_amd64.deb dist/JevVPN-<version>_x86_64.run
# The .run is header.sh followed by a tar.xz of the deb's files and the install scripts.
set -eu

if [[ $# -ne 2 ]]; then
    echo "Usage: $0 <package.deb> <output.run>" >&2
    exit 1
fi
deb="$(realpath "$1")"
out="$2"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
linux_assets="$(dirname "$here")"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir "$work/root"
dpkg-deb -x "$deb" "$work/root"
cp "$here/install.sh" "$here/uninstall.sh" "$linux_assets/before-install.sh" \
    "$linux_assets/before-remove.sh" "$linux_assets/after-remove.sh" "$work/"

version="$(dpkg-deb -f "$deb" Version)"
archive_line=$(($(wc -l <"$here/header.sh") + 1))
sed -e "s/@ARCHIVE_LINE@/$archive_line/g" -e "s/@VERSION@/$version/g" "$here/header.sh" >"$out"
tar -C "$work" --owner=0 --group=0 --numeric-owner --sort=name -cf - . | xz -T0 -6 >>"$out"
chmod +x "$out"
echo "Built $out"
