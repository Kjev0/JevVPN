import { describe, expect, it } from 'vitest';

import {
  applyObfuscation,
  hasAmneziaParams,
  parseVpnConfig,
  readObfuscation,
  validateObfuscation,
} from '../../src/shared/custom-vpn-config';

// Synthetic, well-formed keys (not real credentials).
const KEY_A = 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=';
const KEY_B = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';

const plain = `[Interface]
PrivateKey = ${KEY_A}
Address = 10.0.0.2/32

[Peer]
PublicKey = ${KEY_B}
AllowedIPs = 0.0.0.0/0
Endpoint = 203.0.113.7:51820`;

const amnezia = plain.replace(
  'Address = 10.0.0.2/32',
  'Address = 10.0.0.2/32\njc = 4\nJmin = 40\nJmax = 70\nS1 = 0\nH1 = 1',
);

describe('AmneziaWG detection', () => {
  it('finds AmneziaWG keys in [Interface] only, case-insensitively', () => {
    expect(hasAmneziaParams(plain)).toBe(false);
    expect(hasAmneziaParams(amnezia)).toBe(true);
    expect(hasAmneziaParams(plain.replace('[Peer]', '[Peer]\nJc = 4'))).toBe(false);
    expect(hasAmneziaParams(plain.replace('Address', '# Jc = 4\nAddress'))).toBe(false);
  });

  it('defaults new imports to AmneziaWG or off', () => {
    expect(readObfuscation(plain)).toEqual({ type: 'off' });
    expect(readObfuscation(amnezia)).toEqual({ type: 'amnezia' });
  });
});

describe('readObfuscation', () => {
  it('honours Jev* keys in the file', () => {
    const text = applyObfuscation(plain, {
      type: 'shadowsocks',
      endpoint: 'ss.example.com:8388',
      password: 'pw',
      cipher: 'aes-256-gcm',
    });
    expect(readObfuscation(text)).toEqual({
      type: 'shadowsocks',
      endpoint: 'ss.example.com:8388',
      password: 'pw',
      cipher: 'aes-256-gcm',
    });
    expect(readObfuscation(plain.replace('Address', 'JevObfuscation = JUNK\nAddress'))).toEqual({
      type: 'junk',
    });
  });

  it('falls back when the Jev* keys are unusable', () => {
    const noServer = plain.replace('Address', 'JevObfuscation = udp2tcp\nAddress');
    expect(readObfuscation(noServer)).toEqual({ type: 'off' });
    const noAmnezia = plain.replace('Address', 'JevObfuscation = amnezia\nAddress');
    expect(readObfuscation(noAmnezia)).toEqual({ type: 'off' });
  });
});

describe('applyObfuscation', () => {
  it('writes the keys into [Interface] and keeps the config valid', () => {
    const text = applyObfuscation(plain, { type: 'udp2tcp', endpoint: '[2001:db8::1]:443' });
    expect(text).toContain(
      '[Interface]\nJevObfuscation = udp2tcp\nJevObfuscationEndpoint = [2001:db8::1]:443\n',
    );
    expect(parseVpnConfig('a.conf', text).endpoint).toBe('203.0.113.7:51820');
  });

  it('replaces earlier Jev* keys instead of adding more', () => {
    const once = applyObfuscation(plain, { type: 'junk' });
    const twice = applyObfuscation(once, { type: 'off' });
    expect(twice.match(/JevObfuscation/g)).toHaveLength(1);
    expect(twice).toContain('JevObfuscation = off');
  });

  it('keeps AmneziaWG keys only for the AmneziaWG method', () => {
    expect(applyObfuscation(amnezia, { type: 'amnezia' })).toMatch(/Jmin = 40/);
    const junk = applyObfuscation(amnezia, { type: 'junk' });
    expect(hasAmneziaParams(junk)).toBe(false);
    expect(junk).toContain('Address = 10.0.0.2/32');
  });
});

describe('validateObfuscation', () => {
  const ss = { type: 'shadowsocks' as const, endpoint: 'a.example:1', password: 'p', cipher: 'c' };

  it('accepts valid settings', () => {
    expect(validateObfuscation({ type: 'off' }, false)).toBeUndefined();
    expect(validateObfuscation({ type: 'amnezia' }, true)).toBeUndefined();
    expect(validateObfuscation(ss, false)).toBeUndefined();
  });

  it('rejects input that could inject config lines', () => {
    expect(validateObfuscation({ type: 'amnezia' }, false)).toBeDefined();
    expect(validateObfuscation({ type: 'udp2tcp', endpoint: 'a:1\n[Peer]' }, false)).toBeDefined();
    expect(validateObfuscation({ type: 'udp2tcp', endpoint: 'a:70000' }, false)).toBeDefined();
    expect(validateObfuscation({ ...ss, password: 'a\nPostUp = x' }, false)).toBeDefined();
    expect(validateObfuscation({ ...ss, password: '' }, false)).toBeDefined();
    expect(validateObfuscation({ ...ss, cipher: 'x y' }, false)).toBeDefined();
  });
});
