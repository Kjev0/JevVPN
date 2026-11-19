#!/usr/bin/env bash
set -eu

chmod u+s "/usr/bin/mullvad-exclude"

systemctl enable "/usr/lib/systemd/system/jevvpn-daemon.service"
systemctl start jevvpn-daemon.service || echo "Failed to start jevvpn-daemon.service"
systemctl enable "/usr/lib/systemd/system/jevvpn-early-boot-blocking.service"

# Check if the system supports a new-enough AppArmor version.
function supported_apparmor() {
    [[ -e /etc/apparmor.d/abi/4.0 ]]
}

if supported_apparmor; then
    # Install our AppArmor profile and try to reload AppArmor.
    # The AppArmor profile allow Electron sandbox to work.
    # This disables user namespace restrictions.
    echo "Creating apparmor profile"
    cp /opt/JevVPN/resources/apparmor_jevvpn /etc/apparmor.d/jevvpn
    apparmor_parser -r /etc/apparmor.d/jevvpn || echo "Failed to reload apparmor profile"
fi
