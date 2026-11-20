#!/bin/sh
# JevVPN @VERSION@ self-extracting installer for x86_64 Linux with systemd.
# Usage: sudo ./JevVPN-@VERSION@_x86_64.run [--no-start] [--no-deps] [--uninstall] [--help]
# Built by dist-assets/linux/run-installer/make-run-installer.sh. A tar.xz payload follows this header.
set -eu

for arg in "$@"; do
    case "$arg" in
        -h|--help) ;;
        *) continue ;;
    esac
    cat <<'EOF'
JevVPN @VERSION@ installer

Usage: sudo ./JevVPN-@VERSION@_x86_64.run [options]

  --no-start   Install, but do not start the JevVPN service (e.g. in containers)
  --no-deps    Do not install missing runtime dependencies with pacman (Arch)
  --uninstall  Remove a JevVPN installed by this installer (same as /opt/JevVPN/uninstall.sh)
  --help       Show this help

Set TMPDIR to unpack somewhere other than /var/tmp (needs about 400 MB).
EOF
    exit 0
done

if [ "$(id -u)" -ne 0 ]; then
    echo "The JevVPN installer must run as root. Try: sudo $0 $*" >&2
    exit 1
fi

for arg in "$@"; do
    if [ "$arg" = "--uninstall" ]; then
        if [ -x /opt/JevVPN/uninstall.sh ]; then
            exec /opt/JevVPN/uninstall.sh "$@"
        fi
        echo "JevVPN was not installed by this installer (/opt/JevVPN/uninstall.sh is missing)." >&2
        exit 1
    fi
done

for tool in tar xz tail mktemp; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "The installer needs '$tool', which is not installed." >&2
        exit 1
    fi
done

tmp=$(mktemp -d "${TMPDIR:-/var/tmp}/jevvpn-run.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "Unpacking JevVPN @VERSION@..."
tail -n +@ARCHIVE_LINE@ "$0" | tar -xJ -C "$tmp"
status=0
bash "$tmp/install.sh" "$@" || status=$?
exit "$status"
