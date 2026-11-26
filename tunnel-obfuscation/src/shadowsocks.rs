//! Shadowsocks obfuscation

use crate::{socket::create_remote_socket, transport::ObfuscatedTransport};

use async_trait::async_trait;
use shadowsocks::{
    ProxySocket,
    config::{ServerConfig, ServerConfigError, ServerType},
    context::Context,
    crypto::CipherKind,
    relay::{Address, udprelay::proxy_socket::UdpSocketType},
};
use std::{io, net::SocketAddr, sync::Arc};
use talpid_net::bypass::{BypassSocket, SocketBypass};
use tokio::net::UdpSocket;

const SHADOWSOCKS_CIPHER: CipherKind = CipherKind::AES_256_GCM;
const SHADOWSOCKS_PASSWORD: &str = "mullvad";

type Result<T> = std::result::Result<T, Error>;

type ShadowSocket = BypassSocket<ProxySocket<shadowsocks::net::UdpSocket>>;

#[derive(thiserror::Error, Debug)]
pub enum Error {
    /// Server config error
    #[error("Server config error")]
    ServerConfig(#[from] ServerConfigError),
    /// Unknown or non-AEAD cipher
    #[error("Unsupported Shadowsocks cipher: {0}")]
    UnsupportedCipher(String),
}

pub struct Shadowsocks {
    socket: ShadowSocket,
    shadowsocks_endpoint: SocketAddr,
    wireguard_endpoint: Address,
    packet_overhead: u16,
}

#[derive(Debug, Clone)]
pub struct Settings {
    /// Remote Shadowsocks endpoint
    pub shadowsocks_endpoint: SocketAddr,
    /// Remote WireGuard endpoint
    pub wireguard_endpoint: SocketAddr,
    /// Password and cipher of a self-hosted server. `None` means Mullvad's relays.
    pub credentials: Option<Credentials>,
}

#[derive(Clone)]
pub struct Credentials {
    pub password: String,
    /// Shadowsocks AEAD cipher name, e.g. `chacha20-ietf-poly1305`.
    pub cipher: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials")
            .field("cipher", &self.cipher)
            .finish_non_exhaustive()
    }
}

impl Settings {
    /// The overhead (in bytes) that this obfuscation protocol adds to every packet.
    pub fn packet_overhead(&self) -> u16 {
        // This math relies on the packet structure of Shadowsocks AEAD UDP packets.
        // https://shadowsocks.org/doc/aead.html
        // Those packets look like this: [salt][address][payload][tag]
        // An invalid cipher fails in `Shadowsocks::new`, so its overhead does not matter.
        let cipher = self.cipher().unwrap_or(SHADOWSOCKS_CIPHER);
        debug_assert!(cipher.is_aead());

        let overhead = cipher.salt_len()
            + Address::SocketAddress(self.wireguard_endpoint).serialized_len()
            + cipher.tag_len();

        u16::try_from(overhead).expect("packet overhead is less than u16::MAX")
    }

    /// The cipher to use. Only AEAD ciphers are accepted, which `packet_overhead` assumes.
    fn cipher(&self) -> Result<CipherKind> {
        let Some(credentials) = &self.credentials else {
            return Ok(SHADOWSOCKS_CIPHER);
        };
        match credentials.cipher.parse::<CipherKind>() {
            Ok(cipher) if cipher.is_aead() => Ok(cipher),
            _ => Err(Error::UnsupportedCipher(credentials.cipher.clone())),
        }
    }

    fn password(&self) -> &str {
        self.credentials
            .as_ref()
            .map_or(SHADOWSOCKS_PASSWORD, |credentials| &credentials.password)
    }
}

impl Shadowsocks {
    pub async fn new(bypass: Arc<dyn SocketBypass>, settings: &Settings) -> crate::Result<Self> {
        let remote_socket =
            create_remote_socket(&bypass, settings.shadowsocks_endpoint.is_ipv4()).await?;

        let socket = settings
            .cipher()
            .and_then(|cipher| {
                wrap_shadowsocks(
                    remote_socket,
                    settings.shadowsocks_endpoint,
                    settings.password(),
                    cipher,
                )
            })
            .map_err(crate::Error::CreateShadowsocksObfuscator)?;

        Ok(Shadowsocks {
            socket,
            shadowsocks_endpoint: settings.shadowsocks_endpoint,
            wireguard_endpoint: Address::SocketAddress(settings.wireguard_endpoint),
            packet_overhead: settings.packet_overhead(),
        })
    }
}

/// Wrap the remote socket in a Shadowsocks [ProxySocket].
///
/// This performs no I/O; the socket has already been excluded from tunnel traffic by
/// [create_remote_socket].
fn wrap_shadowsocks(
    remote_socket: BypassSocket<UdpSocket>,
    shadowsocks_endpoint: SocketAddr,
    password: &str,
    cipher: CipherKind,
) -> Result<ShadowSocket> {
    let ss_context = Context::new_shared(ServerType::Local);
    let ss_config = ServerConfig::new(shadowsocks_endpoint, password, cipher)?;
    let guard = remote_socket.guard;
    let socket = ProxySocket::from_socket(
        UdpSocketType::Client,
        ss_context,
        &ss_config,
        // wrap the tokio socket
        shadowsocks::net::UdpSocket::from(remote_socket.socket),
    );
    Ok(BypassSocket { socket, guard })
}

#[async_trait]
impl ObfuscatedTransport for Shadowsocks {
    async fn send(&self, packet: &mut [u8]) -> io::Result<()> {
        self.socket
            .send_to(self.shadowsocks_endpoint, &self.wireguard_endpoint, packet)
            .await
            .map_err(|error| {
                log::trace!("Failed to write to Shadowsocks client: {error}");
                io::Error::other(error)
            })
            .map(drop)
    }

    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let (n, rx_addr, addr, _ctrl) =
                self.socket.recv_from(buf).await.map_err(io::Error::other)?;

            if rx_addr != self.shadowsocks_endpoint {
                log::trace!("Ignoring packet from unexpected Shadowsocks server: {rx_addr}");
                continue;
            }
            if addr != self.wireguard_endpoint {
                log::trace!("Ignoring packet from unexpected source: {addr}");
                continue;
            }

            return Ok(n);
        }
    }

    fn packet_overhead(&self) -> u16 {
        self.packet_overhead
    }
}

#[cfg(test)]
mod test {
    use super::*;

    fn settings(cipher: Option<&str>) -> Settings {
        Settings {
            shadowsocks_endpoint: "1.2.3.4:443".parse().unwrap(),
            wireguard_endpoint: "127.0.0.1:51820".parse().unwrap(),
            credentials: cipher.map(|cipher| Credentials {
                password: "secret".to_owned(),
                cipher: cipher.to_owned(),
            }),
        }
    }

    #[test]
    fn custom_credentials() {
        assert_eq!(settings(None).cipher().unwrap(), SHADOWSOCKS_CIPHER);
        assert_eq!(settings(None).password(), SHADOWSOCKS_PASSWORD);

        let custom = settings(Some("chacha20-ietf-poly1305"));
        assert_eq!(custom.cipher().unwrap(), CipherKind::CHACHA20_POLY1305);
        assert_eq!(custom.password(), "secret");
        // salt + IPv4 address + tag
        assert_eq!(custom.packet_overhead(), 32 + 7 + 16);
        assert_eq!(
            settings(Some("aes-128-gcm")).packet_overhead(),
            16 + 7 + 16
        );
        assert!(!format!("{custom:?}").contains("secret"));

        // Stream ciphers have a different overhead and are insecure
        for cipher in ["rc4-md5", "aes-256-cfb", "nonsense", ""] {
            assert!(settings(Some(cipher)).cipher().is_err(), "{cipher}");
        }
    }
}
