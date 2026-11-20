import { randomUUID } from 'crypto';
import { app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import {
  ICustomVpnConfig,
  MAX_CONFIG_SIZE,
  parseVpnConfig,
  VpnConfigParseError,
} from '../shared/custom-vpn-config';
import log from '../shared/logging';
import { DaemonRpc } from './daemon-rpc';
import { IpcMainEventChannel } from './ipc-event-channel';

interface IStoredConfig extends ICustomVpnConfig {
  // Raw config file, encrypted with safeStorage when the OS supports it.
  config: string;
  encrypted: boolean;
}

// Imported WireGuard/OpenVPN configs. WireGuard configs are activated through the daemon's
// custom VPN support; OpenVPN configs are stored but the daemon cannot tunnel them.
export default class CustomVpnConfigs {
  private configs: IStoredConfig[] = [];
  private readonly filePath = path.join(app.getPath('userData'), 'custom-vpn-configs.json');

  // Every operation runs through this chain so concurrent IPC calls cannot interleave.
  private queue: Promise<unknown> = this.load();
  private readonly loaded = this.queue;

  public constructor(
    private daemonRpc: DaemonRpc,
    private onChange: () => void,
    // Runs before the active config is turned off, while the daemon still tunnels to it.
    private beforeDeactivate: () => Promise<void>,
  ) {}

  // Resolves once the stored configs have been read from disk.
  public whenLoaded(): Promise<unknown> {
    return this.loaded;
  }

  // An active WireGuard config means the daemon tunnels directly to it, without Mullvad relays.
  public hasActiveWireguard(): boolean {
    return this.configs.some((config) => config.active && config.protocol === 'wireguard');
  }

  // The daemon may have lost the active config (older builds imported it disabled, CLI clear,
  // settings reset). Re-import it so connecting never falls back to Mullvad relays.
  public syncWithDaemon(): Promise<void> {
    return this.enqueue(async () => {
      const active = this.configs.find(
        (config) => config.active && config.protocol === 'wireguard',
      );
      if (!active || (await this.daemonRpc.hasEnabledCustomVpn())) return;
      try {
        await this.daemonRpc.importCustomVpnConfig(this.decrypt(active));
      } catch (e) {
        log.error(`Failed to re-apply the active custom VPN config: ${(e as Error).message}`);
        active.active = false;
        await this.save();
      }
    });
  }

  public registerIpcListeners() {
    const channel = IpcMainEventChannel.customVpnConfigs;
    channel.handleGet(() => this.enqueue(() => this.metadata()));
    channel.handleImportFile((filePath) => this.enqueue(() => this.importFile(filePath)));
    channel.handleRemove((id) => this.enqueue(() => this.remove(id)));
    channel.handleSetActive((id) => this.enqueue(() => this.setActive(id)));
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load() {
    try {
      const configs: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!Array.isArray(configs)) throw new Error('not an array');
      this.configs = configs.filter(
        (config): config is IStoredConfig =>
          typeof config?.id === 'string' &&
          typeof config.config === 'string' &&
          (config.protocol === 'wireguard' || config.protocol === 'openvpn'),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Do not log the error message: JSON.parse errors can quote file contents.
        log.error('Failed to read custom VPN configs: file is unreadable or malformed');
      }
    }
  }

  private async importFile(filePath: string): Promise<ICustomVpnConfig> {
    if (!/\.(conf|ovpn)$/i.test(filePath)) {
      throw new VpnConfigParseError('Only .conf and .ovpn files can be imported.');
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > MAX_CONFIG_SIZE) {
      throw new VpnConfigParseError('The file is not a valid VPN configuration.');
    }
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = parseVpnConfig(path.basename(filePath), text);
    // Configs hold private keys, so refuse to store them in plain text.
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        'Secure storage is not available on this system, so the config cannot be saved.',
      );
    }
    const stored: IStoredConfig = {
      id: randomUUID(),
      ...parsed,
      active: false,
      encrypted: true,
      config: safeStorage.encryptString(text).toString('base64'),
    };
    this.configs.push(stored);
    await this.save();
    return this.toMetadata(stored);
  }

  private async remove(id: string) {
    if (this.configs.find((config) => config.id === id)?.active) {
      await this.setActive(undefined);
    }
    this.configs = this.configs.filter((config) => config.id !== id);
    await this.save();
  }

  private async setActive(id?: string) {
    const target = this.configs.find((config) => config.id === id);
    if (id !== undefined && !target) {
      throw new Error('The custom VPN config no longer exists.');
    }
    if (target?.protocol === 'openvpn') {
      throw new Error('The JevVPN service only supports WireGuard tunnels.');
    }

    if (target) {
      await this.daemonRpc.importCustomVpnConfig(this.decrypt(target));
    } else {
      if (this.configs.some((config) => config.active)) await this.beforeDeactivate();
      await this.daemonRpc.clearCustomVpnSettings();
    }

    this.configs.forEach((config) => (config.active = config.id === id));
    await this.save();
  }

  private decrypt(config: IStoredConfig): string {
    return config.encrypted
      ? safeStorage.decryptString(Buffer.from(config.config, 'base64'))
      : config.config;
  }

  private async save() {
    // Write then rename so a crash mid-write cannot truncate the stored configs.
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(this.configs), { mode: 0o600 });
    await fs.rename(tmpPath, this.filePath);
    IpcMainEventChannel.customVpnConfigs.notify?.(this.metadata());
    this.onChange();
  }

  private metadata(): ICustomVpnConfig[] {
    return this.configs.map((config) => this.toMetadata(config));
  }

  private toMetadata({ id, name, protocol, endpoint, active }: IStoredConfig): ICustomVpnConfig {
    return { id, name, protocol, endpoint, active };
  }
}
