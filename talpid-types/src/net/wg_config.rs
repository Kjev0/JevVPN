//! Parser for the `wg-quick` config file format (sans some fields, see below).
//!
//! The parser is exposed as `impl FromStr for CustomVpnConfig`, so a `.conf` file can be
//! parsed with `CustomVpnConfig::from_str(...)`. Peer `Endpoint`s must be IP addresses
//! and ports; hostnames are not resolved.

use std::net::IpAddr;
use std::str::FromStr;

use ipnetwork::IpNetwork;

use crate::net::obfuscation::AmneziaParams;
use crate::net::proxy::ShadowsocksCipher;
use crate::net::wireguard::{
    CustomVpnConfig, CustomVpnObfuscation, CustomVpnPeerConfig, CustomVpnTunnelConfig, InvalidKey,
    PrivateKey, PublicKey,
};

/// Cipher used when `JevObfuscation = shadowsocks` has no `JevShadowsocksCipher`.
pub const DEFAULT_SHADOWSOCKS_CIPHER: &str = "chacha20-ietf-poly1305";

/// Errors produced when parsing a wg-quick config into a [`CustomVpnConfig`].
#[derive(Debug, thiserror::Error)]
pub enum WgConfigParseError {
    #[error("Unknown section: '{0}' (expected [Interface] or [Peer])")]
    UnknownSection(String),
    // NOTE: These errors must not include values, since they may contain the private key.
    #[error("Key '{key}' outside of any section on line {line}")]
    OrphanKeyValue { key: String, line: usize },
    #[error("Missing '=' on line {0}")]
    MissingEquals(usize),
    #[error("Missing required field '{0}'")]
    MissingField(&'static str),
    #[error("Duplicate field '{0}'")]
    DuplicateField(&'static str),
    #[error("Missing [Peer] section")]
    MissingPeer,
    #[error("Invalid PrivateKey: {0}")]
    InvalidPrivateKey(#[source] InvalidKey),
    #[error("Invalid PublicKey: {0}")]
    InvalidPublicKey(#[source] InvalidKey),
    #[error("Invalid Address '{value}': {source}")]
    InvalidAddress {
        value: String,
        #[source]
        source: ipnetwork::IpNetworkError,
    },
    #[error("Invalid AllowedIPs entry '{value}': {source}")]
    InvalidAllowedIp {
        value: String,
        #[source]
        source: ipnetwork::IpNetworkError,
    },
    #[error("Invalid Endpoint '{0}' (expected <host>:<port>)")]
    InvalidEndpoint(String),
    #[error("Invalid MTU '{0}'")]
    InvalidMtu(String),
    #[error("Invalid {key} '{value}'")]
    InvalidObfuscationValue { key: String, value: String },
    #[error("Invalid obfuscation settings: {0}")]
    InvalidObfuscation(String),
    #[error("AmneziaWG key '{0}' is not supported (only Jc, Jmin, Jmax, S1, S2, H1-H4)")]
    UnsupportedAmneziaKey(String),
}

#[derive(Default)]
struct InterfaceBuilder {
    private_key: Option<PrivateKey>,
    addresses: Vec<IpNetwork>,
    dns: Vec<IpAddr>,
    mtu: Option<u16>,
    /// Set as soon as any AmneziaWG key is seen; missing keys keep the `JUNK_ONLY` values.
    amnezia: Option<AmneziaParams>,
    jev_obfuscation: Option<String>,
    jev_endpoint: Option<String>,
    // Never put this in an error: it is a secret.
    shadowsocks_password: Option<String>,
    shadowsocks_cipher: Option<String>,
}

#[derive(Default)]
struct PeerBuilder {
    public_key: Option<PublicKey>,
    allowed_ips: Vec<IpNetwork>,
    endpoint: Option<String>,
}

enum Section {
    None,
    Interface,
    Peer,
}

/// Recognized fields:
/// * `[Interface]`: `PrivateKey`, `Address` - the first address is taken as the
///   tunnel IP; any CIDR suffix is stripped.
/// * `[Peer]`: `PublicKey`, `AllowedIPs`, `Endpoint` - `Endpoint` is stored as a
///   `<host>:<port>` string, and host must be an IP literal.
///
/// * `[Interface]` obfuscation: AmneziaWG `Jc`, `Jmin`, `Jmax`, `S1`, `S2`, `H1`-`H4` (any of
///   them selects AmneziaWG unless `JevObfuscation` says otherwise; non-zero `S3`/`S4` and
///   `H` ranges are rejected, `I1`-`I5` are ignored), and `JevObfuscation =
///   off|junk|amnezia|udp2tcp|shadowsocks`, `JevObfuscationEndpoint = <ip>:<port>`,
///   `JevShadowsocksPassword`, `JevShadowsocksCipher`. A `#` in a value starts a comment.
///
/// Other wg-quick fields (`ListenPort`, `PresharedKey`,
/// `PersistentKeepalive`, `PreUp`/`PostUp`/`PreDown`/`PostDown`, etc.) are
/// accepted but ignored. At least one `[Peer]` section is required.
///
/// Keys and section names are matched case-insensitively. Lines starting with
/// `#` and trailing `#`-comments are stripped. Blank lines are ignored.
impl FromStr for CustomVpnConfig {
    type Err = WgConfigParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        use WgConfigParseError as E;

        let mut section = Section::None;
        let mut interface = InterfaceBuilder::default();
        let mut peers: Vec<PeerBuilder> = Vec::new();

        for (line_index, raw_line) in s.lines().enumerate() {
            let line_number = line_index + 1;
            let line = raw_line
                .split_once('#')
                .map_or(raw_line, |(before, _)| before);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                section = parse_section_header(header.trim())?;
                if matches!(section, Section::Peer) {
                    peers.push(PeerBuilder::default());
                }
                continue;
            }

            let (key, value) = line.split_once('=').ok_or(E::MissingEquals(line_number))?;
            let key = key.trim();
            let value = value.trim();

            match section {
                Section::None => {
                    return Err(E::OrphanKeyValue {
                        key: key.to_owned(),
                        line: line_number,
                    });
                }
                Section::Interface => handle_interface_line(&mut interface, key, value)?,
                Section::Peer => {
                    let peer = peers
                        .last_mut()
                        .expect("Section::Peer implies a peer builder");
                    handle_peer_line(peer, key, value)?;
                }
            }
        }

        finalize(interface, peers)
    }
}

fn parse_section_header(header: &str) -> Result<Section, WgConfigParseError> {
    if header.eq_ignore_ascii_case("Interface") {
        Ok(Section::Interface)
    } else if header.eq_ignore_ascii_case("Peer") {
        Ok(Section::Peer)
    } else {
        Err(WgConfigParseError::UnknownSection(header.to_owned()))
    }
}

fn handle_interface_line(
    interface: &mut InterfaceBuilder,
    key: &str,
    value: &str,
) -> Result<(), WgConfigParseError> {
    use WgConfigParseError as E;

    if key.eq_ignore_ascii_case("PrivateKey") {
        if interface.private_key.is_some() {
            return Err(E::DuplicateField("PrivateKey"));
        }
        interface.private_key = Some(PrivateKey::from_base64(value).map_err(E::InvalidPrivateKey)?);
    } else if key.eq_ignore_ascii_case("Address") {
        for addr in value.split(',') {
            let addr = addr.trim();
            if addr.is_empty() {
                continue;
            }
            let net = addr
                .parse::<IpNetwork>()
                .map_err(|source| E::InvalidAddress {
                    value: addr.to_owned(),
                    source,
                })?;
            interface.addresses.push(net);
        }
    } else if key.eq_ignore_ascii_case("DNS") {
        // wg-quick also allows search domains here; only IP addresses are resolvers.
        interface
            .dns
            .extend(value.split(',').filter_map(|entry| entry.trim().parse::<IpAddr>().ok()));
    } else if key.eq_ignore_ascii_case("MTU") {
        interface.mtu = Some(
            value
                .trim()
                .parse()
                .map_err(|_| E::InvalidMtu(value.trim().to_owned()))?,
        );
    } else if key.eq_ignore_ascii_case("JevObfuscation") {
        interface.jev_obfuscation = Some(value.to_ascii_lowercase());
    } else if key.eq_ignore_ascii_case("JevObfuscationEndpoint") {
        interface.jev_endpoint = Some(value.to_owned());
    } else if key.eq_ignore_ascii_case("JevShadowsocksPassword") {
        interface.shadowsocks_password = Some(value.to_owned());
    } else if key.eq_ignore_ascii_case("JevShadowsocksCipher") {
        interface.shadowsocks_cipher = Some(value.to_owned());
    } else {
        handle_amnezia_line(interface, key, value)?;
    }
    Ok(())
}

/// Parse AmneziaWG keys; other keys are ignored.
fn handle_amnezia_line(
    interface: &mut InterfaceBuilder,
    key: &str,
    value: &str,
) -> Result<(), WgConfigParseError> {
    let invalid = || WgConfigParseError::InvalidObfuscationValue {
        key: key.to_owned(),
        value: value.to_owned(),
    };
    let lower = key.to_ascii_lowercase();
    match lower.as_str() {
        // AmneziaWG 1.5 signature packets, sent before the junk. The server needs none of them.
        "i1" | "i2" | "i3" | "i4" | "i5" => return Ok(()),
        // AmneziaWG 2.0 cookie/data padding: only the plain WireGuard value 0 is supported.
        "s3" | "s4" => {
            return match value.parse::<u16>().map_err(|_| invalid())? {
                0 => Ok(()),
                _ => Err(WgConfigParseError::UnsupportedAmneziaKey(key.to_owned())),
            };
        }
        "jc" | "jmin" | "jmax" | "s1" | "s2" | "h1" | "h2" | "h3" | "h4" => (),
        _ => return Ok(()),
    }
    let params = interface.amnezia.get_or_insert(AmneziaParams::JUNK_ONLY);
    match lower.as_str() {
        "jc" => params.jc = value.parse().map_err(|_| invalid())?,
        "jmin" => params.jmin = value.parse().map_err(|_| invalid())?,
        "jmax" => params.jmax = value.parse().map_err(|_| invalid())?,
        "s1" => params.s1 = value.parse().map_err(|_| invalid())?,
        "s2" => params.s2 = value.parse().map_err(|_| invalid())?,
        header => {
            // AmneziaWG 2.0 allows `H1 = <min>-<max>`; only single values are supported.
            let parsed = match value.split_once('-') {
                Some((min, max)) if min.trim() == max.trim() => min.trim().parse(),
                Some(_) => return Err(WgConfigParseError::UnsupportedAmneziaKey(key.to_owned())),
                None => value.parse(),
            }
            .map_err(|_| invalid())?;
            match header {
                "h1" => params.h1 = parsed,
                "h2" => params.h2 = parsed,
                "h3" => params.h3 = parsed,
                _ => params.h4 = parsed,
            }
        }
    }
    Ok(())
}

/// Build the obfuscation from the AmneziaWG and `Jev*` keys of `[Interface]`.
fn parse_obfuscation(
    interface: &InterfaceBuilder,
) -> Result<CustomVpnObfuscation, WgConfigParseError> {
    use WgConfigParseError as E;

    if let Some(params) = &interface.amnezia {
        validate_amnezia(params)?;
    }
    let endpoint = || {
        let value = interface.jev_endpoint.as_deref().ok_or_else(|| {
            E::InvalidObfuscation("JevObfuscationEndpoint = <ip>:<port> is required".to_owned())
        })?;
        value.parse().map_err(|_| E::InvalidObfuscationValue {
            key: "JevObfuscationEndpoint".to_owned(),
            value: value.to_owned(),
        })
    };

    let method = match interface.jev_obfuscation.as_deref() {
        Some(method) => method,
        None if interface.amnezia.is_some() => "amnezia",
        None => "off",
    };
    Ok(match method {
        "off" => CustomVpnObfuscation::Off,
        "junk" => CustomVpnObfuscation::JunkPackets,
        "amnezia" => CustomVpnObfuscation::Amnezia(interface.amnezia.ok_or_else(|| {
            E::InvalidObfuscation(
                "JevObfuscation = amnezia needs AmneziaWG keys (Jc, Jmin, Jmax, S1, S2, H1-H4)"
                    .to_owned(),
            )
        })?),
        "udp2tcp" => CustomVpnObfuscation::Udp2Tcp {
            endpoint: endpoint()?,
        },
        "shadowsocks" => {
            let cipher = interface
                .shadowsocks_cipher
                .as_deref()
                .unwrap_or(DEFAULT_SHADOWSOCKS_CIPHER);
            let invalid_cipher = || E::InvalidObfuscationValue {
                key: "JevShadowsocksCipher".to_owned(),
                value: cipher.to_owned(),
            };
            let kind = ShadowsocksCipher::new(cipher)
                .map_err(|_| invalid_cipher())?
                .kind();
            // The Shadowsocks client only supports (non-2022) AEAD ciphers.
            if !kind.is_aead() {
                return Err(invalid_cipher());
            }
            let password = interface
                .shadowsocks_password
                .clone()
                .filter(|password| !password.is_empty())
                .ok_or_else(|| {
                    E::InvalidObfuscation("JevShadowsocksPassword is required".to_owned())
                })?;
            CustomVpnObfuscation::Shadowsocks {
                endpoint: endpoint()?,
                password,
                cipher: kind.to_string(),
            }
        }
        other => {
            return Err(E::InvalidObfuscation(format!(
                "JevObfuscation '{other}' is unknown (expected off, junk, amnezia, udp2tcp or \
                 shadowsocks)"
            )));
        }
    })
}

/// The checks amneziawg-go applies, plus the length ambiguity AmneziaWG forbids.
fn validate_amnezia(params: &AmneziaParams) -> Result<(), WgConfigParseError> {
    let invalid = |msg: String| Err(WgConfigParseError::InvalidObfuscation(msg));
    if params.jmin > params.jmax {
        return invalid(format!(
            "Jmin ({}) must not be greater than Jmax ({})",
            params.jmin, params.jmax
        ));
    }
    let headers = [params.h1, params.h2, params.h3, params.h4];
    if (0..4).any(|i| headers[i + 1..].contains(&headers[i])) {
        return invalid("H1, H2, H3 and H4 must all differ".to_owned());
    }
    // A padded initiation (148 + S1) must not have the length of a padded response (92 + S2).
    if u32::from(params.s1) + 56 == u32::from(params.s2) {
        return invalid("S1 + 56 must not equal S2".to_owned());
    }
    Ok(())
}

fn handle_peer_line(
    peer: &mut PeerBuilder,
    key: &str,
    value: &str,
) -> Result<(), WgConfigParseError> {
    use WgConfigParseError as E;

    if key.eq_ignore_ascii_case("PublicKey") {
        if peer.public_key.is_some() {
            return Err(E::DuplicateField("PublicKey"));
        }
        peer.public_key = Some(PublicKey::from_base64(value).map_err(E::InvalidPublicKey)?);
    } else if key.eq_ignore_ascii_case("AllowedIPs") {
        for entry in value.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let net = entry
                .parse::<IpNetwork>()
                .map_err(|source| E::InvalidAllowedIp {
                    value: entry.to_owned(),
                    source,
                })?;
            peer.allowed_ips.push(net);
        }
    } else if key.eq_ignore_ascii_case("Endpoint") {
        if peer.endpoint.is_some() {
            return Err(E::DuplicateField("Endpoint"));
        }
        let trimmed = value.trim();
        if trimmed.is_empty() || !trimmed.contains(':') {
            return Err(E::InvalidEndpoint(trimmed.to_owned()));
        }
        peer.endpoint = Some(trimmed.to_owned());
    }
    Ok(())
}

fn finalize(
    interface: InterfaceBuilder,
    peers: Vec<PeerBuilder>,
) -> Result<CustomVpnConfig, WgConfigParseError> {
    use WgConfigParseError as E;

    let obfuscation = parse_obfuscation(&interface)?;
    let private_key = interface.private_key.ok_or(E::MissingField("PrivateKey"))?;
    if interface.addresses.is_empty() {
        return Err(E::MissingField("Address"));
    }
    let tunnel_ips: Vec<_> = interface.addresses.iter().map(|net| net.ip()).collect();

    if peers.is_empty() {
        return Err(E::MissingPeer);
    }
    let peers = peers
        .into_iter()
        .map(|peer| {
            let public_key = peer.public_key.ok_or(E::MissingField("PublicKey"))?;
            if peer.allowed_ips.is_empty() {
                return Err(E::MissingField("AllowedIPs"));
            }
            let endpoint = peer.endpoint.ok_or(E::MissingField("Endpoint"))?;

            Ok(CustomVpnPeerConfig {
                public_key,
                allowed_ip: peer.allowed_ips,
                endpoint: endpoint
                    .parse()
                    .map_err(|_| WgConfigParseError::InvalidEndpoint(endpoint))?,
            })
        })
        .collect::<Result<Vec<_>, WgConfigParseError>>()?;

    let peers = vec1::Vec1::try_from_vec(peers).expect("checked that peers is non-empty");

    Ok(CustomVpnConfig {
        enabled: false,
        name: None,
        tunnel: CustomVpnTunnelConfig {
            private_key,
            ips: tunnel_ips,
            dns: interface.dns,
            mtu: interface.mtu,
            obfuscation,
        },
        peers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::assert_matches;

    const PRIV: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const PUB: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBE=";

    fn sample_config() -> String {
        format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2/24

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 1.2.3.4:51820
"
        )
    }

    #[test]
    fn happy_path() {
        let config = CustomVpnConfig::from_str(&sample_config()).unwrap();
        assert_eq!(config.tunnel.ips.len(), 1);
        assert_eq!(config.tunnel.ips[0].to_string(), "10.0.0.2");
        assert_eq!(config.peers.len(), 1);
        assert_eq!(config.peers[0].allowed_ip.len(), 2);
        assert_eq!(config.peers[0].endpoint, "1.2.3.4:51820".parse().unwrap());
    }

    #[test]
    fn mixed_ip_families() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2/24, fd00::2/64

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = 1.2.3.4:51820
"
        );
        let config = CustomVpnConfig::from_str(&input).unwrap();
        let ips: Vec<String> = config.tunnel.ips.iter().map(ToString::to_string).collect();
        assert_eq!(ips, vec!["10.0.0.2", "fd00::2"]);
    }

    #[test]
    fn keys_are_case_insensitive() {
        let input = format!(
            "\
[interface]
privatekey = {PRIV}
address = 10.0.0.2

[PEER]
PUBLICKEY = {PUB}
allowedips = 0.0.0.0/0
ENDPOINT = 1.2.3.4:51820
"
        );
        CustomVpnConfig::from_str(&input).unwrap();
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let input = format!(
            "\
# top-level comment
[Interface]
PrivateKey = {PRIV} # inline comment
Address = 10.0.0.2

# between sections

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
"
        );
        CustomVpnConfig::from_str(&input).unwrap();
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2
ListenPort = 51820
DNS = 1.1.1.1
MTU = 1420

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
PersistentKeepalive = 25
"
        );
        CustomVpnConfig::from_str(&input).unwrap();
    }

    #[test]
    fn dns_and_mtu_are_parsed() {
        let input = format!(
            "[Interface]
PrivateKey = {PRIV}
Address = fd03:1337::254/64, 10.13.37.254/24
DNS = 95.215.19.53, 2001:67c:2354:2::53, example.internal
MTU = 1280

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
"
        );
        let config = CustomVpnConfig::from_str(&input).unwrap();
        assert_eq!(
            config.tunnel.dns,
            vec![
                "95.215.19.53".parse::<IpAddr>().unwrap(),
                "2001:67c:2354:2::53".parse().unwrap()
            ]
        );
        assert_eq!(config.tunnel.mtu, Some(1280));
    }

    #[test]
    fn missing_address_is_rejected() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
"
        );
        assert_matches!(
            CustomVpnConfig::from_str(&input).unwrap_err(),
            WgConfigParseError::MissingField("Address"),
        );
    }

    #[test]
    fn duplicate_private_key_is_rejected() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
PrivateKey = {PRIV}
Address = 10.0.0.2

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
"
        );
        assert_matches!(
            CustomVpnConfig::from_str(&input).unwrap_err(),
            WgConfigParseError::DuplicateField("PrivateKey"),
        );
    }

    #[test]
    fn multiple_peers_are_parsed() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2

[Peer]
PublicKey = {PUB}
AllowedIPs = 10.100.0.0/24, fd00:100::/64
Endpoint = 1.2.3.4:51820

[Peer]
PublicKey = {PRIV}
AllowedIPs = 10.200.0.0/24
Endpoint = [2001:db8::1]:51820
"
        );
        let config = CustomVpnConfig::from_str(&input).unwrap();
        assert_eq!(config.peers.len(), 2);

        assert_eq!(
            config.peers[0].public_key,
            PublicKey::from_base64(PUB).unwrap()
        );
        assert_eq!(
            config.peers[0].allowed_ip,
            vec![
                "10.100.0.0/24".parse().unwrap(),
                "fd00:100::/64".parse().unwrap()
            ]
        );
        assert_eq!(config.peers[0].endpoint, "1.2.3.4:51820".parse().unwrap());

        assert_eq!(
            config.peers[1].public_key,
            PublicKey::from_base64(PRIV).unwrap()
        );
        assert_eq!(
            config.peers[1].allowed_ip,
            vec!["10.200.0.0/24".parse().unwrap()]
        );
        assert_eq!(
            config.peers[1].endpoint,
            "[2001:db8::1]:51820".parse().unwrap()
        );
    }

    #[test]
    fn empty_peer_section_is_rejected() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2

[Peer]
"
        );
        assert_matches!(
            CustomVpnConfig::from_str(&input).unwrap_err(),
            WgConfigParseError::MissingField("PublicKey"),
        );
    }

    #[test]
    fn unknown_section_is_rejected() {
        let input = format!(
            "\
[Interface]
PrivateKey = {PRIV}
Address = 10.0.0.2

[Bogus]
Foo = bar

[Peer]
PublicKey = {PUB}
AllowedIPs = 0.0.0.0/0
Endpoint = 1.2.3.4:51820
"
        );
        assert_matches!(
        CustomVpnConfig::from_str(&input).unwrap_err(),
        WgConfigParseError::UnknownSection(ref s) if s == "Bogus",
        );
    }

    /// Parse `sample_config()` with `interface_lines` added to `[Interface]`.
    fn parse_with(interface_lines: &str) -> Result<CustomVpnConfig, WgConfigParseError> {
        let input = sample_config().replacen(
            "[Interface]\n",
            &format!("[Interface]\n{interface_lines}\n"),
            1,
        );
        CustomVpnConfig::from_str(&input)
    }

    fn obfuscation(interface_lines: &str) -> CustomVpnObfuscation {
        parse_with(interface_lines).unwrap().tunnel.obfuscation
    }

    #[test]
    fn obfuscation_defaults_to_off() {
        assert_eq!(obfuscation(""), CustomVpnObfuscation::Off);
    }

    #[test]
    fn all_amnezia_keys_are_parsed() {
        let parsed = obfuscation(
            "Jc = 5\njmin = 50\nJMAX = 1000\nS1 = 15\nS2 = 18\nH1 = 1234\nH2 = 5678\nH3 = 91011\nH4 = 121314",
        );
        assert_eq!(
            parsed,
            CustomVpnObfuscation::Amnezia(AmneziaParams {
                jc: 5,
                jmin: 50,
                jmax: 1000,
                s1: 15,
                s2: 18,
                h1: 1234,
                h2: 5678,
                h3: 91011,
                h4: 121314,
            })
        );
    }

    #[test]
    fn missing_amnezia_keys_default_to_junk_only() {
        let parsed = obfuscation("Jc = 8\nH1 = 77");
        assert_eq!(
            parsed,
            CustomVpnObfuscation::Amnezia(AmneziaParams {
                jc: 8,
                h1: 77,
                ..AmneziaParams::JUNK_ONLY
            })
        );
    }

    #[test]
    fn amnezia_2_0_plain_values_and_signatures_are_accepted() {
        let parsed = obfuscation("Jc = 3\nS3 = 0\nS4 = 0\nH1 = 9-9\nI1 = <b 0xf6ab3267>");
        assert_eq!(
            parsed,
            CustomVpnObfuscation::Amnezia(AmneziaParams {
                jc: 3,
                h1: 9,
                ..AmneziaParams::JUNK_ONLY
            })
        );
    }

    #[test]
    fn unsupported_amnezia_2_0_values_are_rejected() {
        for line in ["S3 = 10", "S4 = 1", "H1 = 100-200"] {
            assert_matches!(
                parse_with(line).unwrap_err(),
                WgConfigParseError::UnsupportedAmneziaKey(_),
                "{line}"
            );
        }
    }

    #[test]
    fn invalid_amnezia_values_are_rejected() {
        for line in ["Jc = 300", "Jc = many", "Jmin = -1", "S1 = 70000", "H4 = x"] {
            assert_matches!(
                parse_with(line).unwrap_err(),
                WgConfigParseError::InvalidObfuscationValue { .. },
                "{line}"
            );
        }
        for lines in ["Jmin = 80\nJmax = 70", "H1 = 2", "S1 = 10\nS2 = 66"] {
            assert_matches!(
                parse_with(lines).unwrap_err(),
                WgConfigParseError::InvalidObfuscation(_),
                "{lines}"
            );
        }
    }

    #[test]
    fn jev_obfuscation_methods_are_parsed() {
        assert_eq!(obfuscation("JevObfuscation = off"), CustomVpnObfuscation::Off);
        assert_eq!(
            obfuscation("jevobfuscation = JUNK"),
            CustomVpnObfuscation::JunkPackets
        );
        assert_eq!(
            obfuscation("JevObfuscation = udp2tcp\nJevObfuscationEndpoint = 1.2.3.4:443"),
            CustomVpnObfuscation::Udp2Tcp {
                endpoint: "1.2.3.4:443".parse().unwrap()
            }
        );
        assert_eq!(
            obfuscation(
                "JevObfuscation = shadowsocks\nJevObfuscationEndpoint = [2001:db8::1]:8388\n\
                 JevShadowsocksPassword = s3cret\nJevShadowsocksCipher = aes-256-gcm"
            ),
            CustomVpnObfuscation::Shadowsocks {
                endpoint: "[2001:db8::1]:8388".parse().unwrap(),
                password: "s3cret".to_owned(),
                cipher: "aes-256-gcm".to_owned(),
            }
        );
    }

    #[test]
    fn shadowsocks_cipher_defaults_to_chacha20() {
        let parsed = obfuscation(
            "JevObfuscation = shadowsocks\nJevObfuscationEndpoint = 1.2.3.4:8388\n\
             JevShadowsocksPassword = pw",
        );
        let CustomVpnObfuscation::Shadowsocks { cipher, .. } = parsed else {
            panic!("expected shadowsocks, got {parsed:?}");
        };
        assert_eq!(cipher, DEFAULT_SHADOWSOCKS_CIPHER);
    }

    #[test]
    fn jev_obfuscation_overrides_amnezia_keys() {
        assert_eq!(
            obfuscation("Jc = 4\nH1 = 5\nJevObfuscation = off"),
            CustomVpnObfuscation::Off
        );
        assert_eq!(
            obfuscation("JevObfuscation = junk\nJc = 4"),
            CustomVpnObfuscation::JunkPackets
        );
    }

    #[test]
    fn invalid_jev_settings_are_rejected() {
        let invalid_settings = [
            "JevObfuscation = vless",
            "JevObfuscation = amnezia",
            "JevObfuscation = udp2tcp",
            "JevObfuscation = shadowsocks\nJevObfuscationEndpoint = 1.2.3.4:8388",
        ];
        for lines in invalid_settings {
            assert_matches!(
                parse_with(lines).unwrap_err(),
                WgConfigParseError::InvalidObfuscation(_),
                "{lines}"
            );
        }
        let invalid_values = [
            "JevObfuscation = udp2tcp\nJevObfuscationEndpoint = example.com",
            "JevObfuscation = shadowsocks\nJevObfuscationEndpoint = 1.2.3.4:1\n\
             JevShadowsocksPassword = pw\nJevShadowsocksCipher = rot13",
            "JevObfuscation = shadowsocks\nJevObfuscationEndpoint = 1.2.3.4:1\n\
             JevShadowsocksPassword = pw\nJevShadowsocksCipher = aes-256-cfb",
        ];
        for lines in invalid_values {
            assert_matches!(
                parse_with(lines).unwrap_err(),
                WgConfigParseError::InvalidObfuscationValue { .. },
                "{lines}"
            );
        }
    }

    #[test]
    fn errors_never_contain_the_shadowsocks_password() {
        let error = parse_with(
            "JevObfuscation = shadowsocks\nJevShadowsocksPassword = hunter2\n\
             JevObfuscationEndpoint = nope",
        )
        .unwrap_err();
        assert!(!error.to_string().contains("hunter2"), "{error}");
    }
}
