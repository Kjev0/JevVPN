#!/usr/bin/env bash
set -eu

if which systemctl &> /dev/null && systemctl is-system-running | grep -vq offline &> /dev/null; then
    if systemctl status jevvpn-daemon &> /dev/null; then
        /opt/JevVPN/resources/mullvad-setup prepare-restart || true
        systemctl stop jevvpn-daemon.service
        systemctl disable jevvpn-daemon.service
        systemctl disable jevvpn-early-boot-blocking.service || true
        cp /var/log/jevvpn/daemon.log /var/log/jevvpn/old-install-daemon.log \
            || echo "Failed to copy old daemon log"
    fi
fi

rm -f /var/cache/jevvpn/relays.json
rm -f /var/cache/jevvpn/api-ip-address.txt
