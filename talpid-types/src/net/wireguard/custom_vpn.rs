//! Types for the user-provided custom WireGuard VPN.
use std::net::{IpAddr, SocketAddr};

use ipnetwork::IpNetwork;
use serde::{Deserialize, Serialize};
use vec1::Vec1;

use super::{PrivateKey, PublicKey};
use crate::net::obfuscation::AmneziaParams;

/// Censorship circumvention for an own VPN config (wg-quick `JevObfuscation`, AmneziaWG keys).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomVpnObfuscation {
    #[default]
    Off,
    /// Junk packets before each handshake; works with any WireGuard server.
    JunkPackets,
    /// AmneziaWG wire format; needs an AmneziaWG server with the same parameters.
    Amnezia(AmneziaParams),
    /// WireGuard over TCP; needs `tcp2udp` (mullvad/udp-over-tcp) at `endpoint`.
    Udp2Tcp { endpoint: SocketAddr },
    /// WireGuard over Shadowsocks UDP; needs a Shadowsocks server at `endpoint`.
    Shadowsocks {
        endpoint: SocketAddr,
        password: String,
        cipher: String,
    },
}

/// Human-readable summary. Never includes the Shadowsocks password.
impl std::fmt::Display for CustomVpnObfuscation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str("off"),
            Self::JunkPackets => f.write_str("junk packets"),
            Self::Amnezia(p) => write!(
                f,
                "amneziawg (jc={}, jmin={}, jmax={}, s1={}, s2={}, h1={}, h2={}, h3={}, h4={})",
                p.jc, p.jmin, p.jmax, p.s1, p.s2, p.h1, p.h2, p.h3, p.h4
            ),
            Self::Udp2Tcp { endpoint } => write!(f, "udp2tcp via {endpoint}"),
            Self::Shadowsocks {
                endpoint, cipher, ..
            } => write!(f, "shadowsocks via {endpoint} ({cipher})"),
        }
    }
}
/// Custom VPN tunnel interface configuration (WireGuard-based).
///
/// `ips` are the interface addresses, matching wg-quick `Address = ...`
/// lines.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomVpnTunnelConfig {
    pub private_key: PrivateKey,
    pub ips: Vec<IpAddr>,
    /// DNS resolvers from wg-quick `DNS = ...`, used inside the tunnel.
    #[serde(default)]
    pub dns: Vec<IpAddr>,
    /// Tunnel MTU from wg-quick `MTU = ...`.
    #[serde(default)]
    pub mtu: Option<u16>,
    /// Censorship circumvention method, from AmneziaWG/`Jev*` keys in `[Interface]`.
    #[serde(default)]
    pub obfuscation: CustomVpnObfuscation,
}

/// Custom VPN peer configuration (WireGuard-based).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomVpnPeerConfig {
    pub public_key: PublicKey,
    pub allowed_ip: Vec<IpNetwork>,
    pub endpoint: SocketAddr,
}

/// Custom VPN configuration (WireGuard-based).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomVpnConfig {
    pub enabled: bool,
    pub name: Option<String>,
    pub tunnel: CustomVpnTunnelConfig,
    pub peers: Vec1<CustomVpnPeerConfig>,
}

/// Custom VPN configs (WireGuard-based).
#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomVpnSettings {
    pub configs: Vec<CustomVpnConfig>,
}

impl CustomVpnSettings {
    /// The config to use, which is the first enabled config, if any.
    pub fn active(&self) -> Option<&CustomVpnConfig> {
        self.configs.iter().find(|config| config.enabled)
    }
}

/// A custom VPN config as exchanged with a client. The private key is
/// optional: when submitted, an omitted key keeps the stored one; see
/// [`CustomVpnConfigUpdate::resolve`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomVpnConfigUpdate {
    pub enabled: bool,
    pub name: Option<String>,
    pub tunnel: CustomVpnTunnelUpdate,
    pub peers: Vec1<CustomVpnPeerConfig>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomVpnTunnelUpdate {
    pub private_key: Option<PrivateKey>,
    pub ips: Vec<IpAddr>,
    pub dns: Vec<IpAddr>,
    pub mtu: Option<u16>,
    /// `None` keeps the obfuscation of the same server's stored config.
    pub obfuscation: Option<CustomVpnObfuscation>,
}

impl From<CustomVpnConfig> for CustomVpnConfigUpdate {
    fn from(config: CustomVpnConfig) -> Self {
        CustomVpnConfigUpdate {
            enabled: config.enabled,
            name: config.name,
            tunnel: CustomVpnTunnelUpdate {
                private_key: Some(config.tunnel.private_key),
                ips: config.tunnel.ips,
                dns: config.tunnel.dns,
                mtu: config.tunnel.mtu,
                obfuscation: Some(config.tunnel.obfuscation),
            },
            peers: config.peers,
        }
    }
}

impl CustomVpnConfigUpdate {
    /// Resolve the update into a full config. The update's key is used when
    /// present, otherwise the key of `existing`. Errors if there is neither.
    pub fn resolve(self, existing: Option<&CustomVpnConfig>) -> Result<CustomVpnConfig, String> {
        let private_key = match self.tunnel.private_key {
            Some(key) => key,
            None => existing
                .map(|config| config.tunnel.private_key.clone())
                .ok_or_else(|| {
                    "cannot set config without a private key: no existing key to keep".to_owned()
                })?,
        };

        let same_server = existing.filter(|config| config.peers == self.peers);
        Ok(CustomVpnConfig {
            enabled: self.enabled,
            name: self.name,
            tunnel: CustomVpnTunnelConfig {
                private_key,
                ips: self.tunnel.ips,
                // Updates over gRPC carry no DNS/MTU, so keep the stored ones of the same server.
                dns: match self.tunnel.dns.is_empty() {
                    true => same_server.map(|c| c.tunnel.dns.clone()).unwrap_or_default(),
                    false => self.tunnel.dns,
                },
                mtu: self.tunnel.mtu.or(same_server.and_then(|c| c.tunnel.mtu)),
                obfuscation: self
                    .tunnel
                    .obfuscation
                    .or_else(|| same_server.map(|c| c.tunnel.obfuscation.clone()))
                    .unwrap_or_default(),
            },
            peers: self.peers,
        })
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn config(obfuscation: CustomVpnObfuscation) -> CustomVpnConfig {
        CustomVpnConfig {
            enabled: true,
            name: None,
            tunnel: CustomVpnTunnelConfig {
                private_key: PrivateKey::from([7; 32]),
                ips: vec!["10.0.0.2".parse().unwrap()],
                dns: vec![],
                mtu: None,
                obfuscation,
            },
            peers: vec1::vec1![CustomVpnPeerConfig {
                public_key: PublicKey::from([1; 32]),
                allowed_ip: vec!["0.0.0.0/0".parse().unwrap()],
                endpoint: "1.2.3.4:51820".parse().unwrap(),
            }],
        }
    }

    fn update_without_obfuscation(config: &CustomVpnConfig) -> CustomVpnConfigUpdate {
        let mut update = CustomVpnConfigUpdate::from(config.clone());
        update.tunnel.obfuscation = None;
        update
    }

    #[test]
    fn resolve_inherits_obfuscation_from_same_server() {
        let existing = config(CustomVpnObfuscation::Udp2Tcp {
            endpoint: "1.2.3.4:443".parse().unwrap(),
        });
        let resolved = update_without_obfuscation(&existing)
            .resolve(Some(&existing))
            .unwrap();
        assert_eq!(resolved.tunnel.obfuscation, existing.tunnel.obfuscation);
    }

    #[test]
    fn resolve_does_not_inherit_obfuscation_from_other_server() {
        let existing = config(CustomVpnObfuscation::JunkPackets);
        let mut other = existing.clone();
        other.peers[0].endpoint = "5.6.7.8:51820".parse().unwrap();
        let resolved = update_without_obfuscation(&other)
            .resolve(Some(&existing))
            .unwrap();
        assert_eq!(resolved.tunnel.obfuscation, CustomVpnObfuscation::Off);
    }

    #[test]
    fn resolve_prefers_update_obfuscation() {
        let existing = config(CustomVpnObfuscation::JunkPackets);
        let mut update = CustomVpnConfigUpdate::from(existing.clone());
        update.tunnel.obfuscation = Some(CustomVpnObfuscation::Off);
        let resolved = update.resolve(Some(&existing)).unwrap();
        assert_eq!(resolved.tunnel.obfuscation, CustomVpnObfuscation::Off);
    }

    #[test]
    fn display_hides_shadowsocks_password() {
        let obfuscation = CustomVpnObfuscation::Shadowsocks {
            endpoint: "1.2.3.4:8388".parse().unwrap(),
            password: "hunter2".to_owned(),
            cipher: "aes-256-gcm".to_owned(),
        };
        let shown = obfuscation.to_string();
        assert!(!shown.contains("hunter2"), "{shown}");
        assert!(shown.contains("aes-256-gcm"), "{shown}");
    }
}
