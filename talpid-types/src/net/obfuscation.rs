use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use vec1::Vec1;

use super::{Endpoint, TransportProtocol};

/// AmneziaWG obfuscation parameters (wg-quick keys `Jc`, `Jmin`, `Jmax`, `S1`, `S2`, `H1`-`H4`).
/// With `s1 = s2 = 0` and `h1..h4 = 1..4` the wire format is plain WireGuard plus junk
/// packets before each handshake, which any standard WireGuard server ignores.
#[derive(Clone, Copy, Eq, PartialEq, Hash, Deserialize, Serialize, Debug)]
pub struct AmneziaParams {
    /// Number of junk packets sent before each handshake initiation.
    pub jc: u8,
    /// Minimum and maximum size in bytes of each junk packet.
    pub jmin: u16,
    pub jmax: u16,
    /// Random padding bytes prepended to handshake initiation (`s1`) and response (`s2`).
    pub s1: u16,
    pub s2: u16,
    /// Message type headers replacing WireGuard's 1 (init), 2 (response), 3 (cookie), 4 (data).
    pub h1: u32,
    pub h2: u32,
    pub h3: u32,
    pub h4: u32,
}

impl AmneziaParams {
    /// Junk packets only: compatible with every standard WireGuard server.
    pub const JUNK_ONLY: Self = Self {
        jc: 4,
        jmin: 40,
        jmax: 70,
        s1: 0,
        s2: 0,
        h1: 1,
        h2: 2,
        h3: 3,
        h4: 4,
    };
}

/// Available obfuscation configuration types.
#[derive(Clone, Eq, PartialEq, Debug)]
pub enum Obfuscators {
    /// A single obfuscation method
    Single(ObfuscatorConfig),
    /// Try multiple obfuscation methods (using `multiplexer` obfuscation).
    ///
    /// They are tested in the following order: `direct`, `config.0`, then
    /// the remaining configs in `configs.1` in order.
    Multiplexer {
        /// Optional direct connection (no obfuscation) to try along with `configs`.
        direct: Option<SocketAddr>,
        /// Obfuscation configurations to try.
        configs: Vec1<ObfuscatorConfig>,
    },
}

#[derive(Clone, Eq, PartialEq, Hash, Deserialize, Serialize, Debug)]
pub enum ObfuscatorConfig {
    Udp2Tcp {
        endpoint: SocketAddr,
    },
    Shadowsocks {
        endpoint: SocketAddr,
    },
    Quic {
        hostname: String,
        endpoint: SocketAddr,
        auth_token: String,
    },
    Lwo {
        endpoint: SocketAddr,
        version: LwoVersion,
    },
    /// AmneziaWG wire format towards a (self-hosted) WireGuard/AmneziaWG server at `endpoint`.
    Amnezia {
        endpoint: SocketAddr,
        params: AmneziaParams,
    },
    /// Shadowsocks towards a self-hosted server, with its own password and cipher.
    CustomShadowsocks {
        endpoint: SocketAddr,
        password: String,
        /// Shadowsocks AEAD cipher name, e.g. `chacha20-ietf-poly1305`.
        cipher: String,
    },
}

/// The version of the LWO protocol.
#[derive(Clone, Copy, Eq, PartialEq, Hash, Deserialize, Serialize, Debug)]
#[serde(rename_all = "snake_case")]
pub enum LwoVersion {
    V1,
    V2,
}

impl Obfuscators {
    /// Return all potential endpoints that this obfuscation configuration might connect to.
    ///
    /// For single obfuscators, return one endpoint. For `Obfuscators::Multiplexer`, return
    /// all possible endpoints (direct + all obfuscated methods) that the multiplexer
    /// might use, with duplicates removed.
    pub fn endpoints(&self) -> Vec<Endpoint> {
        match self {
            Obfuscators::Single(config) => vec![config.endpoint()],
            Obfuscators::Multiplexer { direct, configs } => {
                let mut endpoints = vec![];
                if let Some(direct) = direct {
                    endpoints.push(Endpoint {
                        address: *direct,
                        protocol: TransportProtocol::Udp,
                    });
                }
                endpoints.extend(configs.iter().map(|cfg| cfg.endpoint()));

                endpoints.sort();
                endpoints.dedup();

                endpoints
            }
        }
    }

    pub fn obfuscator_configs(&self) -> Vec<ObfuscatorConfig> {
        match self {
            Obfuscators::Single(config) => vec![config.clone()],
            Obfuscators::Multiplexer { configs, .. } => configs.to_vec(),
        }
    }

    /// Return the socket address of the direct/plain wireguard connection inside
    /// the multiplexer, if present.
    pub fn direct(&self) -> Option<SocketAddr> {
        match self {
            Obfuscators::Single(_) => None,
            Obfuscators::Multiplexer { direct, .. } => *direct,
        }
    }
}

impl ObfuscatorConfig {
    /// Return obfuscation endpoint, i.e. the first remote hop that will be connected to
    pub fn endpoint(&self) -> Endpoint {
        match self {
            ObfuscatorConfig::Udp2Tcp { endpoint } => Endpoint {
                address: *endpoint,
                protocol: TransportProtocol::Tcp,
            },
            ObfuscatorConfig::Shadowsocks { endpoint }
            | ObfuscatorConfig::CustomShadowsocks { endpoint, .. }
            | ObfuscatorConfig::Amnezia { endpoint, .. } => Endpoint {
                address: *endpoint,
                protocol: TransportProtocol::Udp,
            },
            ObfuscatorConfig::Quic { endpoint, .. } => Endpoint {
                address: *endpoint,
                protocol: TransportProtocol::Udp,
            },
            ObfuscatorConfig::Lwo { endpoint, .. } => Endpoint {
                address: *endpoint,
                protocol: TransportProtocol::Udp,
            },
        }
    }
}
