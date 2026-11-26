export type CustomVpnProtocol = 'wireguard' | 'openvpn';

// Censorship bypass for an own WireGuard config. The daemon reads it from the Jev* keys in
// [Interface] (see docs/CENSORSHIP.md); the GUI writes those keys into the text it sends.
export type CustomVpnObfuscation =
  | { type: 'off' }
  | { type: 'junk' }
  | { type: 'amnezia' }
  | { type: 'udp2tcp'; endpoint: string }
  | { type: 'shadowsocks'; endpoint: string; password: string; cipher: string };

export type CustomVpnObfuscationType = CustomVpnObfuscation['type'];

export const DEFAULT_SHADOWSOCKS_CIPHER = 'chacha20-ietf-poly1305';
// The only ciphers the daemon's Shadowsocks client supports for own servers (AEAD).
export const SHADOWSOCKS_CIPHERS = ['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305'];

// Metadata sent to the renderer. The raw config (with private keys) never leaves the main process.
export interface ICustomVpnConfig {
  id: string;
  name: string;
  protocol: CustomVpnProtocol;
  endpoint: string;
  active: boolean;
  obfuscation: CustomVpnObfuscation;
  // The file has AmneziaWG parameters (Jc, S1, H1, ...), so the AmneziaWG method can be used.
  amneziaAvailable: boolean;
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

const JEV_KEYS = [
  'jevobfuscation',
  'jevobfuscationendpoint',
  'jevshadowsockspassword',
  'jevshadowsockscipher',
];
// AmneziaWG 1.0 keys plus the 1.5/2.0 additions (S3, S4, I1-I5), so none leak into a plain tunnel.
const AMNEZIA_KEY = /^(jc|jmin|jmax|s[1-4]|h[1-4]|i[1-5])$/;
const KEY_LINE = /^\s*(\w+)\s*=\s*(.*?)\s*$/;
const SECTION_LINE = /^\s*\[(\w+)\]\s*$/;

// Lowercased key/value pairs of the [Interface] section.
function interfaceKeys(text: string): Record<string, string> {
  const keys: Record<string, string> = {};
  let section = '';
  for (const line of splitConfigLines(text)) {
    const header = SECTION_LINE.exec(line);
    if (header) section = header[1].toLowerCase();
    const pair = KEY_LINE.exec(line);
    if (section === 'interface' && pair) keys[pair[1].toLowerCase()] = pair[2];
  }
  return keys;
}

export function hasAmneziaParams(text: string): boolean {
  // I1-I5 alone do not make an AmneziaWG config: the daemon ignores them.
  return Object.keys(interfaceKeys(text)).some(
    (key) => AMNEZIA_KEY.test(key) && !key.startsWith('i'),
  );
}

// The obfuscation a freshly imported file asks for: its Jev* keys, else AmneziaWG if it has
// AmneziaWG parameters, else off.
export function readObfuscation(text: string): CustomVpnObfuscation {
  const keys = interfaceKeys(text);
  const fallback: CustomVpnObfuscation = { type: hasAmneziaParams(text) ? 'amnezia' : 'off' };
  const endpoint = keys.jevobfuscationendpoint ?? '';
  let obfuscation: CustomVpnObfuscation;
  switch (keys.jevobfuscation?.toLowerCase()) {
    case 'off':
    case 'junk':
    case 'amnezia':
      obfuscation = { type: keys.jevobfuscation.toLowerCase() as 'off' | 'junk' | 'amnezia' };
      break;
    case 'udp2tcp':
      obfuscation = { type: 'udp2tcp', endpoint };
      break;
    case 'shadowsocks':
      obfuscation = {
        type: 'shadowsocks',
        endpoint,
        password: keys.jevshadowsockspassword ?? '',
        cipher: keys.jevshadowsockscipher || DEFAULT_SHADOWSOCKS_CIPHER,
      };
      break;
    default:
      return fallback;
  }
  return validateObfuscation(obfuscation, fallback.type === 'amnezia') ? fallback : obfuscation;
}

// host:port, IPv6 in brackets. No whitespace or comment characters: the value goes into the config.
export function isObfuscationEndpoint(value: string): boolean {
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(value);
  return match !== null && Number(match[2]) >= 1 && Number(match[2]) <= 65535;
}

// Returns an error message, or undefined when the obfuscation can be written into a config.
// This is the trust boundary for renderer input: a newline would inject config lines.
export function validateObfuscation(
  obfuscation: CustomVpnObfuscation,
  amneziaAvailable: boolean,
): string | undefined {
  switch (obfuscation.type) {
    case 'off':
    case 'junk':
      return undefined;
    case 'amnezia':
      return amneziaAvailable ? undefined : 'The config has no AmneziaWG parameters.';
    case 'udp2tcp':
    case 'shadowsocks':
      if (!isObfuscationEndpoint(obfuscation.endpoint)) {
        return 'The obfuscation server must be given as host:port.';
      }
      if (obfuscation.type === 'shadowsocks') {
        if (!/^[^\s#;]{1,256}$/.test(obfuscation.password)) {
          return 'The Shadowsocks password must not be empty or contain spaces, # or ;.';
        }
        if (!SHADOWSOCKS_CIPHERS.includes(obfuscation.cipher)) {
          return `The Shadowsocks cipher must be one of: ${SHADOWSOCKS_CIPHERS.join(', ')}.`;
        }
      }
      return undefined;
    default:
      return 'Unknown obfuscation method.';
  }
}

function obfuscationLines(obfuscation: CustomVpnObfuscation): string[] {
  switch (obfuscation.type) {
    case 'udp2tcp':
      return ['JevObfuscation = udp2tcp', `JevObfuscationEndpoint = ${obfuscation.endpoint}`];
    case 'shadowsocks':
      return [
        'JevObfuscation = shadowsocks',
        `JevObfuscationEndpoint = ${obfuscation.endpoint}`,
        `JevShadowsocksPassword = ${obfuscation.password}`,
        `JevShadowsocksCipher = ${obfuscation.cipher}`,
      ];
    default:
      return [`JevObfuscation = ${obfuscation.type}`];
  }
}

// Rewrites the Jev* keys in [Interface] to match the obfuscation. AmneziaWG keys are kept only
// for the AmneziaWG method, so a plain WireGuard server never sees AmneziaWG framing.
export function applyObfuscation(text: string, obfuscation: CustomVpnObfuscation): string {
  let section = '';
  const out: string[] = [];
  for (const line of splitConfigLines(text)) {
    const header = SECTION_LINE.exec(line);
    if (header) {
      section = header[1].toLowerCase();
      out.push(line);
      if (section === 'interface') out.push(...obfuscationLines(obfuscation));
      continue;
    }
    const key = KEY_LINE.exec(line)?.[1].toLowerCase();
    const drop =
      section === 'interface' &&
      key !== undefined &&
      (JEV_KEYS.includes(key) || (obfuscation.type !== 'amnezia' && AMNEZIA_KEY.test(key)));
    if (!drop) out.push(line);
  }
  return out.join('\n');
}

function splitConfigLines(text: string): string[] {
  return text.replace(/^\uFEFF/, '').split(/\r?\n/);
}
