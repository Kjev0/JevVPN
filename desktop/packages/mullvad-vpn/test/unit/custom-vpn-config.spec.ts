import { describe, expect, it } from 'vitest';

import { parseVpnConfig, VpnConfigParseError } from '../../src/shared/custom-vpn-config';

// Synthetic, well-formed keys (not real credentials).
const KEY_A = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const KEY_B = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const wireguard = `
# home router
[Interface]
PrivateKey = ${KEY_A}
Address = 10.0.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = ${KEY_B}
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.7:51820
`;

const openvpn = `
client
dev tun
proto udp
remote vpn.example.com 443
<ca>
-----BEGIN CERTIFICATE-----
-----END CERTIFICATE-----
</ca>
`;

describe('parseVpnConfig', () => {
  it('parses a WireGuard config', () => {
    expect(parseVpnConfig('home.conf', wireguard)).toEqual({
      name: 'home',
      protocol: 'wireguard',
      endpoint: '203.0.113.7:51820',
    });
  });

  it('parses an OpenVPN config and defaults the port', () => {
    expect(parseVpnConfig('work.ovpn', openvpn).endpoint).toBe('vpn.example.com:443');
    expect(parseVpnConfig('w.ovpn', 'client\nremote 198.51.100.1').endpoint).toBe(
      '198.51.100.1:1194',
    );
  });

  it('rejects WireGuard configs with a bad key or no peer', () => {
    expect(() => parseVpnConfig('a.conf', wireguard.replace(KEY_A, 'nope'))).toThrow(
      VpnConfigParseError,
    );
    expect(() => parseVpnConfig('a.conf', wireguard.split('[Peer]')[0])).toThrow(/Peer/);
  });

  it('accepts a UTF-8 BOM', () => {
    expect(parseVpnConfig('home.conf', '\uFEFF' + wireguard.trimStart()).protocol).toBe(
      'wireguard',
    );
  });

  it('never echoes key material in errors', () => {
    const broken = wireguard.replace(`PrivateKey = ${KEY_A}`, `PrivateKey: ${KEY_A}`);
    expect(() => parseVpnConfig('a.conf', broken)).toThrow(VpnConfigParseError);
    expect(() => parseVpnConfig('a.conf', broken)).not.toThrow(KEY_A);
  });

  it('rejects OpenVPN configs without a remote and unrelated files', () => {
    expect(() => parseVpnConfig('a.ovpn', 'client\ndev tun')).toThrow(/remote/);
    expect(() => parseVpnConfig('a.txt', 'hello world')).toThrow(VpnConfigParseError);
  });
});
