#!/usr/bin/env bash
# Smoke test for the .run installer, run as root inside a throwaway container without systemd:
#   docker run --rm -v "$PWD:/w" archlinux:latest bash /w/dist-assets/linux/run-installer/test-in-container.sh /w/dist/JevVPN-<version>_x86_64.run
set -eux

run="$1"

"$run" --help
"$run" --no-start

test -x /opt/JevVPN/jevvpn
test -x /opt/JevVPN/mullvad-gui
test -u /usr/bin/mullvad-exclude
test -u /opt/JevVPN/chrome-sandbox
test -f /usr/lib/systemd/system/jevvpn-daemon.service
test -f /usr/lib/systemd/system/jevvpn-early-boot-blocking.service
test -f /usr/share/applications/jevvpn.desktop
test -x /opt/JevVPN/uninstall.sh
mullvad-daemon --version
mullvad --version

if command -v pacman >/dev/null; then
    # On Arch the installer pulled in the dependencies, so every library must resolve.
    if find /opt/JevVPN -maxdepth 1 -type f \( -name mullvad-gui -o -name '*.so*' \) \
        -exec ldd {} + | grep 'not found'; then
        echo "Unresolved libraries after installing the Arch dependencies" >&2
        exit 1
    fi
fi

# Installing over an existing install upgrades it in place.
"$run" --no-start --no-deps
test -x /opt/JevVPN/jevvpn

"$run" --uninstall --no-start
test ! -e /opt/JevVPN
test ! -e /usr/bin/mullvad
test ! -e /usr/bin/mullvad-daemon
test ! -L /usr/bin/mullvad-problem-report
test ! -e /usr/lib/systemd/system/jevvpn-daemon.service
test ! -e /usr/share/applications/jevvpn.desktop
test ! -e /usr/share/icons/hicolor/512x512/apps/jevvpn.png
echo "run installer test passed"
