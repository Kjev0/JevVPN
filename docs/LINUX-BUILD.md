# Building JevVPN .deb / .rpm on WSL2 Ubuntu

Source tree: this repository (fork of mullvadvpn-app, GPL-3.0).
Output: `dist/JevVPN-<version>_amd64.deb` and `dist/JevVPN-<version>_x86_64.rpm`.

## 1. Install WSL2 + Ubuntu (Windows, admin PowerShell)

```powershell
wsl --install -d Ubuntu
# reboot if asked, then open "Ubuntu" from the Start menu and create a Linux user
wsl --set-default-version 2
```

Give WSL at least 8 GB RAM if the build gets OOM-killed (`%UserProfile%\.wslconfig`, `[wsl2]` / `memory=8GB`, then `wsl --shutdown`).

## 2. Copy the source into the Linux filesystem

Do not build from `/mnt/e/...`: it is slow, loses exec bits and may carry CRLF line endings that break the packaging scripts.

```bash
mkdir -p ~/src
rsync -a --exclude target --exclude node_modules --exclude dist \
  /mnt/<drive>/path/to/jevvpn/ ~/src/jevvpn/
cd ~/src/jevvpn
# Make sure shell scripts and unit files have LF endings and are executable
sudo apt install -y dos2unix
find dist-assets/linux build.sh scripts -type f -exec dos2unix -q {} +
chmod +x build.sh dist-assets/linux/*.sh dist-assets/linux/daemon/*
```

## 3. System packages

```bash
sudo apt update
sudo apt install -y build-essential gcc libdbus-1-dev rpm protobuf-compiler libprotobuf-dev \
  git curl pkg-config podman
```

- `gcc libdbus-1-dev` - daemon build.
- `rpm` - rpm packaging (fpm via electron-builder).
- `protobuf-compiler` - gRPC code generation in `mullvad-management-interface` (needs protoc >= 3.15; Ubuntu 22.04+ is fine).
- `podman` - only needed if the desktop gRPC bindings in `desktop/packages/management-interface/dist` must be regenerated.

## 4. Rust (version pinned by `rust-toolchain.toml`, currently 1.100.0)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
source "$HOME/.cargo/env"
cd ~/src/jevvpn && rustup show   # installs the pinned toolchain
```

## 5. Node via Volta (versions from `desktop/package.json` "volta" section)

```bash
curl https://get.volta.sh | bash
source ~/.bashrc
volta install node@24.21.0 npm@12.2.0
node --version   # v24.21.0
```

## 6. Build

```bash
cd ~/src/jevvpn
./build.sh --optimize        # or plain ./build.sh for a faster, larger build
ls dist/
```

`build.sh` builds the Rust binaries, copies them to `dist-assets/linux/` subdirs, runs `npm run ci` in `desktop/`, then `npm run pack:linux` (electron-builder + fpm, driven by `desktop/packages/mullvad-vpn/tasks/distribution.cjs`).

Daemon-only packages (no GUI): `cargo install cargo-deb cargo-generate-rpm` then `./build.sh --daemon-only`. Those use `mullvad-daemon/Cargo.toml` `[package.metadata.deb]` / `generate-rpm` sections, which also reference the unit files listed below.

## 7. Install / test (Ubuntu with systemd)

WSL2 needs systemd enabled (`/etc/wsl.conf`: `[boot]` / `systemd=true`, then `wsl --shutdown`). A real VM is a better test target for the firewall/tunnel.

```bash
sudo apt install ./dist/JevVPN-*_amd64.deb
systemctl status jevvpn-daemon.service
mullvad status
```

## Linux identity used by the packaging assets

| Item | Value |
|---|---|
| Install dir | `/opt/JevVPN` (electron-builder productName `JevVPN`) |
| systemd units | `jevvpn-daemon.service`, `jevvpn-early-boot-blocking.service` |
| Settings / cache / logs | `/etc/jevvpn`, `/var/cache/jevvpn`, `/var/log/jevvpn` |
| Management socket | `/var/run/jevvpn` |
| AppArmor profile | `/etc/apparmor.d/jevvpn` (source `dist-assets/linux/apparmor_jevvpn`) |
| GUI user config | `~/.config/JevVPN`, autostart `~/.config/autostart/jevvpn.desktop` |
| Binaries (unchanged) | `/usr/bin/mullvad`, `/usr/bin/mullvad-daemon`, `/usr/bin/mullvad-exclude`, `/usr/bin/mullvad-problem-report`, `/opt/JevVPN/mullvad-gui`, `/opt/JevVPN/resources/mullvad-setup` |

Note: because binary names under `/usr/bin` are unchanged, the JevVPN .deb/.rpm cannot be installed alongside the official Mullvad VPN Linux package (file conflicts). Uninstall one before installing the other.

## Files in `dist-assets/linux/` that `distribution.cjs` must reference

| File | Used for |
|---|---|
| `jevvpn-daemon.service` (renamed from `mullvad-daemon.service`) | `=/usr/lib/systemd/system/jevvpn-daemon.service` in deb + rpm fpm args |
| `jevvpn-early-boot-blocking.service` (renamed from `mullvad-early-boot-blocking.service`) | `=/usr/lib/systemd/system/jevvpn-early-boot-blocking.service` in deb + rpm fpm args |
| `apparmor_jevvpn` (renamed from `apparmor_mullvad`) | `extraResources` |
| `mullvad-gui-launcher.sh` (name unchanged) | `extraFiles`, renamed in afterPack |
| `problem-report-link` (name unchanged, points to `/opt/JevVPN/resources/mullvad-problem-report`) | `=/usr/bin/mullvad-problem-report` |
| `before-install.sh`, `before-remove.sh`, `after-install.sh`, `after-remove.sh`, `post-transaction.sh` (names unchanged) | fpm scripts |

The rpm `--directories=/opt/Mullvad VPN/` argument in `distribution.cjs` must become `--directories=/opt/JevVPN/`.
