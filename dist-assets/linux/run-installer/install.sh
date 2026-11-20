#!/usr/bin/env bash
# Installs JevVPN from the unpacked .run payload: the .deb's files (root/) plus the deb's
# maintainer scripts. Every created file and directory is recorded in a manifest so that
# /opt/JevVPN/uninstall.sh removes exactly what was installed.
set -eu

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
prefix=/opt/JevVPN
helper_dir="$prefix/run-installer"
manifest="$helper_dir/manifest"

# Arch package names for what the .deb leaves to the system: Electron's shared libraries and
# the tools the app and daemon call at runtime.
arch_deps=(
    alsa-lib at-spi2-core dbus gtk3 iputils libdrm libnotify libsecret libxkbcommon libxss
    libxtst mesa nss xdg-utils
)

start=1
deps=1
for arg in "$@"; do
    case "$arg" in
        --no-start) start=0 ;;
        --no-deps) deps=0 ;;
        --uninstall) exec "$prefix/uninstall.sh" "$@" ;;
        -h|--help) echo "Run the .run file with --help for usage."; exit 0 ;;
        *) echo "Unknown option: $arg (see --help)" >&2; exit 1 ;;
    esac
done

die() {
    echo "Error: $*" >&2
    exit 1
}

[[ "$(id -u)" -eq 0 ]] || die "the installer must run as root (use sudo)."
[[ "$(uname -m)" == x86_64 ]] || die "this installer is for x86_64 only."

# Same policy as the Windows installer: the official app uses the same binary names.
if [[ -e "/opt/Mullvad VPN" || -e /usr/lib/systemd/system/mullvad-daemon.service ||
    -e /etc/systemd/system/mullvad-daemon.service ]]; then
    die "the official Mullvad VPN app is installed. Uninstall it first; JevVPN cannot be installed alongside it."
fi

upgrade=0
if [[ -f "$manifest" ]]; then
    upgrade=1
elif [[ -e "$prefix" ]]; then
    die "$prefix exists but was not installed by this installer. Remove the jevvpn package first (apt remove jevvpn / dnf remove jevvpn)."
elif [[ -e /usr/bin/mullvad-daemon ]]; then
    die "/usr/bin/mullvad-daemon already exists (another Mullvad-based app?). Remove it first."
fi

# Runtime dependencies.
if command -v pacman >/dev/null; then
    if ((deps)); then
        mapfile -t missing < <(pacman -T "${arch_deps[@]}" || true)
        if ((${#missing[@]})); then
            echo "Installing missing dependencies with pacman: ${missing[*]}"
            pacman -S --needed --noconfirm "${missing[@]}" ||
                die "pacman could not install: ${missing[*]}. Run 'pacman -Syu' and try again, or use --no-deps."
        fi
    else
        echo "Skipping dependency installation (--no-deps). JevVPN needs: ${arch_deps[*]}"
    fi
elif command -v apt-get >/dev/null || command -v dnf >/dev/null; then
    echo "Note: on Debian/Ubuntu and Fedora the .deb / .rpm package is preferred; it installs the same files."
    echo "This installer does not install dependencies here. The daemon needs libdbus-1; the GUI needs GTK 3, NSS, libnotify, libXScrnSaver and libsecret."
fi

if ((upgrade)); then
    echo "Upgrading the existing JevVPN installation"
    bash "$here/before-install.sh"
    "$prefix/uninstall.sh" --upgrade
fi

created=()
write_manifest() {
    if [[ -d "$helper_dir" ]]; then
        printf '%s\n' "${created[@]}" "f $manifest" >"$manifest"
    fi
}
# Written even if the install fails halfway, so uninstall.sh can clean up.
trap write_manifest EXIT

make_dir() {
    if [[ ! -e "$1" ]]; then
        mkdir -m 755 "$1"
        created+=("d $1")
    fi
}

echo "Installing JevVPN to $prefix"
cd "$here/root"
while IFS= read -r -d '' dir; do
    make_dir "/$dir"
done < <(find . -mindepth 1 -type d -printf '%P\0')
make_dir "$helper_dir"
while IFS= read -r -d '' file; do
    cp -a --remove-destination "$file" "/$file"
    created+=("f /$file")
done < <(find . -mindepth 1 \( -type f -o -type l \) -printf '%P\0')

install -m 755 "$here/before-remove.sh" "$here/after-remove.sh" "$helper_dir/"
install -m 755 "$here/uninstall.sh" "$prefix/uninstall.sh"
created+=("f $helper_dir/before-remove.sh" "f $helper_dir/after-remove.sh" "f $prefix/uninstall.sh")

# What the .deb's after-install.sh does, minus the parts that need a running systemd.
chmod u+s /usr/bin/mullvad-exclude
if [[ -f "$prefix/chrome-sandbox" ]]; then
    chmod 4755 "$prefix/chrome-sandbox"
fi
if [[ -e /etc/apparmor.d/abi/4.0 ]]; then
    echo "Creating apparmor profile"
    cp "$prefix/resources/apparmor_jevvpn" /etc/apparmor.d/jevvpn
    created+=("f /etc/apparmor.d/jevvpn")
    apparmor_parser -r /etc/apparmor.d/jevvpn || echo "Failed to reload apparmor profile"
fi
write_manifest

if command -v update-desktop-database >/dev/null; then
    update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi

if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null; then
    systemctl daemon-reload
    systemctl enable /usr/lib/systemd/system/jevvpn-daemon.service
    systemctl enable /usr/lib/systemd/system/jevvpn-early-boot-blocking.service
    if ((start)); then
        systemctl start jevvpn-daemon.service || echo "Failed to start jevvpn-daemon.service"
    fi
else
    echo "systemd is not running; the JevVPN service was not enabled or started."
fi

echo "JevVPN is installed. Start it from your app menu or run /opt/JevVPN/jevvpn."
echo "To uninstall: sudo /opt/JevVPN/uninstall.sh"
