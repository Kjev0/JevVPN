export type CustomVpnProtocol = 'wireguard' | 'openvpn';

// Metadata sent to the renderer. The raw config (with private keys) never leaves the main process.
export interface ICustomVpnConfig {
  id: string;
  name: string;
  protocol: CustomVpnProtocol;
  endpoint: string;
  active: boolean;
}

export interface IParsedVpnConfig {
  name: string;
  protocol: CustomVpnProtocol;
  endpoint: string;
}

export class VpnConfigParseError extends Error {}

export const MAX_CONFIG_SIZE = 256 * 1024;

// Parses and validates a WireGuard (wg-quick) or OpenVPN client config.
export function parseVpnConfig(fileName: string, text: string): IParsedVpnConfig {
  if (text.length > MAX_CONFIG_SIZE) {
    throw new VpnConfigParseError('The file is too large to be a VPN configuration.');
  }

  const name = fileName.replace(/\.(conf|ovpn)$/i, '').trim() || 'Imported config';
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[#;].*$/, '').trim())
    .filter((line) => line !== '');

  if (lines.some((line) => /^\[interface\]$/i.test(line))) {
    return { name, protocol: 'wireguard', endpoint: parseWireguard(lines) };
  }

  if (lines.some((line) => /^(client|remote\s+\S+)/i.test(line))) {
    return { name, protocol: 'openvpn', endpoint: parseOpenVpn(lines) };
  }

  throw new VpnConfigParseError('The file is neither a WireGuard nor an OpenVPN configuration.');
}

function parseWireguard(lines: string[]): string {
  let section = '';
  const iface: Record<string, string> = {};
  const peers: Array<Record<string, string>> = [];

  for (const line of lines) {
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      if (section === 'peer') peers.push({});
      continue;
    }
    const pair = /^(\w+)\s*=\s*(.+)$/.exec(line);
    // Never echo the line: it may contain the private key.
    if (!pair) throw new VpnConfigParseError('The WireGuard config contains an invalid line.');
    const target = section === 'interface' ? iface : section === 'peer' ? peers.at(-1) : undefined;
    if (target) target[pair[1].toLowerCase()] = pair[2].trim();
  }

  if (!isWireguardKey(iface.privatekey)) {
    throw new VpnConfigParseError('The [Interface] section is missing a valid PrivateKey.');
  }
  if (!iface.address) {
    throw new VpnConfigParseError('The [Interface] section is missing an Address.');
  }
  if (peers.length === 0) {
    throw new VpnConfigParseError('The config has no [Peer] section.');
  }
  if (!peers.every((peer) => isWireguardKey(peer.publickey))) {
    throw new VpnConfigParseError('Every [Peer] needs a valid PublicKey.');
  }
  const endpoint = peers.find((peer) => peer.endpoint)?.endpoint;
  if (!endpoint) {
    throw new VpnConfigParseError('No [Peer] has an Endpoint.');
  }
  return endpoint;
}

function parseOpenVpn(lines: string[]): string {
  const remote = lines.map((line) => /^remote\s+(\S+)(?:\s+(\d+))?/i.exec(line)).find(Boolean);
  if (!remote) {
    throw new VpnConfigParseError('The OpenVPN config has no "remote" server.');
  }
  return `${remote[1]}:${remote[2] ?? '1194'}`;
}

function isWireguardKey(key?: string): boolean {
  return key !== undefined && /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/.test(key);
}
