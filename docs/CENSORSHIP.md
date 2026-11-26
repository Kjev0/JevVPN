# Censorship bypass

Some networks block VPNs. ISPs in Russia, Iran and China do it, as do many hotel and company
networks. They use deep packet inspection (DPI), which recognises WireGuard by its fixed message
types and packet sizes, or they block every UDP port except DNS. JevVPN has two sets of tools for
this:

1. **Mullvad servers:** Settings > VPN settings > Anti-censorship. These are Mullvad's own
   methods (UDP-over-TCP, Shadowsocks, QUIC, LWO, WireGuard port). Mullvad's relays run the
   server side for you, so you only pick one. The screen is visible once you are logged in and the
   service is running.
2. **Your own WireGuard configs:** Settings > VPN configs. Open the menu (the three dots) on a
   WireGuard config and choose **Obfuscation**. The methods are described below. Most of them need
   software on your server, because obfuscation only works when both ends speak the same disguise.

> **No method guarantees that you get through.** Censors change their filters often. Russia in
> particular blocks new methods within weeks and also blocks whole IP ranges of hosting providers.
> A method that works today can stop tomorrow. Keep a second method and a second server ready.

## Methods for your own configs

| Method | Server side needed | Works against |
|---|---|---|
| Off | none | nothing; plain WireGuard |
| Junk packets | none, works with any WireGuard server | simple DPI that only looks at the first packet |
| AmneziaWG | an AmneziaWG server | DPI that recognises WireGuard |
| UDP-over-TCP | `tcp2udp` from mullvad/udp-over-tcp | networks that block UDP |
| Shadowsocks | a Shadowsocks server with UDP relay | DPI that recognises WireGuard, some IP blocks |

The service runs every method as a small local proxy in front of WireGuard. The kill switch is
not changed: the firewall still allows only the one server address that the tunnel uses (the
WireGuard peer, or the UDP-over-TCP/Shadowsocks server).

### Junk packets

Before each handshake, JevVPN sends 4 UDP packets of random data (40 to 69 bytes) to the server. A
normal WireGuard server ignores packets it cannot decrypt, so this works with **any** WireGuard
server, for example Njalla, your router, or a commercial provider. A DPI box that classifies a flow
by its first packet then sees random data instead of a WireGuard handshake.

This is the weakest method. It does not change the handshake itself, so a filter that looks at
more than the first packet still recognises WireGuard. Try it first because it costs nothing.

### AmneziaWG

[AmneziaWG](https://github.com/amnezia-vpn/amneziawg-go) is a WireGuard fork made for Russia. It
adds junk packets, random padding in front of the handshake, and its own message type numbers, so
the packets no longer look like WireGuard. Both ends must use the same parameters.

- **Server:** run `amneziawg-go` / `amneziawg-tools`, or set up a server with the
  [Amnezia app](https://amnezia.org) (it installs AmneziaWG on your VPS over SSH).
- **Client:** import the config that the server gives you. It has extra lines in `[Interface]`
  such as `Jc`, `Jmin`, `Jmax`, `S1`, `S2`, `H1` to `H4`. JevVPN detects them and picks AmneziaWG
  for the config automatically. Configs without these lines cannot use the AmneziaWG method.

Supported: the AmneziaWG 1.0 parameters `Jc`, `Jmin`, `Jmax`, `S1`, `S2`, `H1`-`H4`. Not
supported yet (AmneziaWG 1.5/2.0): `S3`/`S4` other than 0, `H` ranges such as `H1 = 100-200`
(import fails with an error), and the `I1`-`I5` signature packets (ignored, the server does not
need them).

### UDP-over-TCP

WireGuard packets are sent over one TCP connection, for example on port 443. Use this when the
network blocks UDP. TCP-in-TCP is slower, especially on lossy links. The traffic is not disguised,
so DPI that looks inside TCP can still recognise it.

Server side ([mullvad/udp-over-tcp](https://github.com/mullvad/udp-over-tcp)), on the same machine
as WireGuard (listening on UDP 51820):

```
tcp2udp --tcp-listen 0.0.0.0:443 --udp-forward 127.0.0.1:51820
```

In JevVPN, enter the server as `your-server:443`.

### Shadowsocks

WireGuard packets are encrypted again and sent through a Shadowsocks server's UDP relay. To a DPI
box the traffic looks like random data. JevVPN asks the Shadowsocks server to forward the packets
to `127.0.0.1:51820`, so WireGuard must listen on UDP port 51820 on the same machine.

Server side, for example [shadowsocks-rust](https://github.com/shadowsocks/shadowsocks-rust)
`ssserver -c config.json` with UDP enabled and no plugin:

```json
{
  "server": "0.0.0.0",
  "server_port": 8388,
  "password": "a-long-random-password",
  "method": "chacha20-ietf-poly1305",
  "mode": "tcp_and_udp"
}
```

Do not use an ACL that blocks loopback addresses. In JevVPN, enter the server as
`your-server:8388`, the same password and the same cipher. The password cannot contain spaces, `#`
or `;`.

## Writing the settings into a config file

The GUI stores the method with the config and writes it into `[Interface]` when it hands the config
to the service. You can also write the keys yourself, for example when you import with the CLI
(`mullvad custom-vpn import <file>`, if your build includes the CLI). A method chosen in the GUI
replaces these keys when the config is turned on.

```ini
[Interface]
PrivateKey = ...
Address = 10.0.0.2/32
JevObfuscation = shadowsocks          # off | junk | amnezia | udp2tcp | shadowsocks
JevObfuscationEndpoint = ss.example.com:8388
JevShadowsocksPassword = a-long-random-password
JevShadowsocksCipher = chacha20-ietf-poly1305
```

`JevObfuscationEndpoint` is needed for `udp2tcp` and `shadowsocks`. Host names are resolved when
the config is imported. When a file has AmneziaWG keys and no `JevObfuscation`, AmneziaWG is used.

## Denmark (YouSee and other ISPs)

Danish ISPs, YouSee among them, block sites on court order by changing their DNS answers. They do
not block WireGuard. JevVPN sends DNS through the tunnel to the DNS server in your config (or to
Mullvad's DNS on Mullvad servers), so these DNS blocks no longer apply while you are connected. You
do not need an obfuscation method for that.

If a site is still blocked when you are connected, check that the config has a `DNS =` line. If it
has none, add one, for example the DNS server of your VPN provider.
