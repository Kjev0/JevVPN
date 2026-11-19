#!/usr/bin/env bash
set -eu

echo "Running before-remove.sh"
# SIGTERM for some reason causes the app to crash sometimes and SIGINT works as expected.
pkill -2 -x "mullvad-gui" || true
sleep 0.5
pkill -9 -x "mullvad-gui" || true

is_number_re='^[0-9]+$'
# Check if we're running during an upgrade step on Fedora
# https://fedoraproject.org/wiki/Packaging:Scriptlets#Syntax
if [[ "$1" =~ $is_number_re ]] && [ "$1" -gt 0 ]; then
    exit 0;
fi

if [[ "$1" == "upgrade" ]]; then
    exit 0;
fi

# the user might've disabled or stopped the service themselves already
systemctl stop jevvpn-daemon.service || true
systemctl disable jevvpn-daemon.service || true
systemctl stop jevvpn-early-boot-blocking.service || true
systemctl disable jevvpn-early-boot-blocking.service || true

/opt/JevVPN/resources/mullvad-setup reset-firewall || echo "Failed to reset firewall"
/opt/JevVPN/resources/mullvad-setup remove-device || echo "Failed to remove device from account"
