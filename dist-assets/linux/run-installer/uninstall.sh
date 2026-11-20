#!/usr/bin/env bash
# Uninstalls a JevVPN installed by the .run installer: runs the .deb's before-remove.sh and
# after-remove.sh, then deletes exactly the files and directories listed in the manifest.
# Settings in /etc/jevvpn and logs in /var/log/jevvpn are kept, like `apt remove`.
set -eu

prefix=/opt/JevVPN
helper_dir="$prefix/run-installer"
manifest="$helper_dir/manifest"

action=remove
for arg in "$@"; do
    case "$arg" in
        --upgrade) action=upgrade ;; # used by install.sh: keep the device logged in
        --uninstall | --no-start) ;;
        -h | --help) echo "Usage: sudo $0   (removes JevVPN)"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Error: uninstalling JevVPN must run as root (use sudo)." >&2
    exit 1
fi
if [[ ! -f "$manifest" ]]; then
    echo "Error: $manifest is missing; JevVPN was not installed by the .run installer." >&2
    exit 1
fi

mapfile -t entries <"$manifest"

bash "$helper_dir/before-remove.sh" "$action"
bash "$helper_dir/after-remove.sh" "$action"

dirs=()
for entry in "${entries[@]}"; do
    path="${entry#? }"
    case "$entry" in
        "f "*) rm -f "$path" ;;
        "d "*) dirs+=("$path") ;;
    esac
done
# Deepest directories first; directories that still hold other files are kept.
for ((i = ${#dirs[@]} - 1; i >= 0; i--)); do
    rmdir --ignore-fail-on-non-empty "${dirs[i]}" 2>/dev/null || true
done

if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl daemon-reload || true
fi
if [[ "$action" == remove ]]; then
    echo "JevVPN has been uninstalled. Settings in /etc/jevvpn and logs in /var/log/jevvpn were kept."
fi
