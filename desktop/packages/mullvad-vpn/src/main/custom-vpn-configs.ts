import { randomUUID } from 'crypto';
import { app, safeStorage } from 'electron';
import fs from 'fs/promises';
import path from 'path';

import {
  applyObfuscation,
  CustomVpnObfuscation,
  hasAmneziaParams,
  ICustomVpnConfig,
  MAX_CONFIG_SIZE,
  parseVpnConfig,
  readObfuscation,
  validateObfuscation,
  VpnConfigParseError,
} from '../shared/custom-vpn-config';
import log from '../shared/logging';
import { DaemonRpc } from './daemon-rpc';
import { IpcMainEventChannel } from './ipc-event-channel';

// Configs stored by older builds have no obfuscation fields.
interface IStoredConfig extends Omit<ICustomVpnConfig, 'obfuscation' | 'amneziaAvailable'> {
  obfuscation?: CustomVpnObfuscation;
  amneziaAvailable?: boolean;
  // Raw config file, encrypted with safeStorage when the OS supports it.
  config: string;
  encrypted: boolean;
  // Shadowsocks password, encrypted with safeStorage. `obfuscation` is stored in plain text and
  // sent to the renderer, so its password is always empty.
  shadowsocksPassword?: string;
}

function withoutPassword(obfuscation: CustomVpnObfuscation): CustomVpnObfuscation {
  return obfuscation.type === 'shadowsocks' ? { ...obfuscation, password: '' } : obfuscation;
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
        await this.daemonRpc.importCustomVpnConfig(this.daemonConfig(active));
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
    channel.handleSetObfuscation(({ id, obfuscation }) =>
      this.enqueue(() => this.setObfuscation(id, obfuscation)),
    );
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
    const obfuscation = readObfuscation(text);
    const stored: IStoredConfig = {
      id: randomUUID(),
      ...parsed,
      active: false,
      obfuscation: withoutPassword(obfuscation),
      shadowsocksPassword:
        obfuscation.type === 'shadowsocks' ? this.encryptSecret(obfuscation.password) : undefined,
      amneziaAvailable: hasAmneziaParams(text),
      encrypted: true,
      config: this.encryptSecret(text),
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
      await this.daemonRpc.importCustomVpnConfig(this.daemonConfig(target));
    } else {
      if (this.configs.some((config) => config.active)) await this.beforeDeactivate();
      await this.daemonRpc.clearCustomVpnSettings();
    }

    this.configs.forEach((config) => (config.active = config.id === id));
    await this.save();
  }

  private async setObfuscation(id: string, obfuscation: CustomVpnObfuscation) {
    const target = this.configs.find((config) => config.id === id);
    if (target?.protocol !== 'wireguard') {
      throw new Error('Obfuscation can only be set for WireGuard configs.');
    }
    // The renderer never gets the stored password, so an empty one keeps it.
    const password =
      obfuscation.type === 'shadowsocks' ? obfuscation.password || this.storedPassword(target) : '';
    const error = validateObfuscation(
      obfuscation.type === 'shadowsocks' ? { ...obfuscation, password } : obfuscation,
      this.amneziaAvailable(target),
    );
    if (error) throw new VpnConfigParseError(error);
    if (password && !safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available, so the password cannot be saved.');
    }

    const previous = { ...target };
    target.obfuscation = withoutPassword(obfuscation);
    target.shadowsocksPassword = password ? this.encryptSecret(password) : undefined;
    // The daemon only learns the method from the config text, so re-import the config in use.
    if (target.active) {
      try {
        await this.daemonRpc.importCustomVpnConfig(this.daemonConfig(target));
      } catch (e) {
        target.obfuscation = previous.obfuscation;
        target.shadowsocksPassword = previous.shadowsocksPassword;
        throw e;
      }
    }
    await this.save();
  }

  // The text sent to the daemon: the stored file with the chosen obfuscation written into it.
  private daemonConfig(config: IStoredConfig): string {
    const obfuscation = config.obfuscation ?? { type: 'off' };
    return applyObfuscation(
      this.decrypt(config),
      obfuscation.type === 'shadowsocks'
        ? { ...obfuscation, password: this.storedPassword(config) }
        : obfuscation,
    );
  }

  private encryptSecret(secret: string): string {
    return safeStorage.encryptString(secret).toString('base64');
  }

  private storedPassword(config: IStoredConfig): string {
    return config.shadowsocksPassword
      ? safeStorage.decryptString(Buffer.from(config.shadowsocksPassword, 'base64'))
      : '';
  }

  private amneziaAvailable(config: IStoredConfig): boolean {
    if (config.amneziaAvailable === undefined) {
      try {
        config.amneziaAvailable = hasAmneziaParams(this.decrypt(config));
      } catch {
        return false;
      }
    }
    return config.amneziaAvailable;
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

  private toMetadata(config: IStoredConfig): ICustomVpnConfig {
    const { id, name, protocol, endpoint, active } = config;
    return {
      id,
      name,
      protocol,
      endpoint,
      active,
      obfuscation: withoutPassword(config.obfuscation ?? { type: 'off' }),
      amneziaAvailable: protocol === 'wireguard' && this.amneziaAvailable(config),
    };
  }
}
