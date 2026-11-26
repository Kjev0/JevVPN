//! AmneziaWG wire format, client side.
//!
//! Turns the plain WireGuard datagrams of the local WireGuard instance into the format that an
//! [amneziawg-go](https://github.com/amnezia-vpn/amneziawg-go) server expects, and back:
//!
//! - Every handshake initiation is preceded by `jc` datagrams of random bytes, each between `jmin`
//!   (inclusive) and `jmax` (exclusive) bytes long, as in `Device.JunkPackets`.
//! - Handshake initiations and responses are prefixed by `s1` and `s2` random bytes.
//! - The 4 byte little endian message type (1 to 4) is replaced by `h1` to `h4`.
//!
//! amneziawg-go computes `mac1` over the message with its replaced type, so `mac1` of handshake
//! messages is recomputed whenever the type changes.
//!
//! With [AmneziaParams::JUNK_ONLY] only junk packets are added, which any standard WireGuard
//! server ignores.
//!
//! Not supported (AmneziaWG 1.5/2.0): `S3`/`S4` (cookie/data padding), `H1`-`H4` ranges, `I1`-`I5`
//! signature packets, header protection keys and random trailers. Rewriting the type also
//! invalidates `mac2`, so a server that is under load and demands cookies will not accept
//! handshakes while the type is replaced.

use std::{borrow::Cow, io, net::SocketAddr, sync::Arc};

use async_trait::async_trait;
use rand::{Rng, RngCore};
use talpid_net::bypass::{BypassSocket, SocketBypass};
use talpid_types::net::{obfuscation::AmneziaParams, wireguard::PublicKey};
use tokio::net::UdpSocket;

use crate::{
    socket::create_remote_socket,
    transport::ObfuscatedTransport,
    wireguard::{
        COOKIE_REPLY, COOKIE_REPLY_SIZE, DATA, DATA_OVERHEAD_SIZE, HANDSHAKE_INITIATION,
        HANDSHAKE_INITIATION_SIZE, HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, mac1_key,
        set_message_mac1, verify_message_mac1,
    },
};

#[derive(Debug, Clone)]
pub struct Settings {
    /// Remote AmneziaWG (or plain WireGuard) server.
    pub server_addr: SocketAddr,
    pub params: AmneziaParams,
    /// Public key of the local WireGuard instance, which incoming handshakes are addressed to.
    pub client_public_key: PublicKey,
    /// Public key of the server, which outgoing handshakes are addressed to.
    pub server_public_key: PublicKey,
}

impl Settings {
    /// The overhead (in bytes) that this obfuscation protocol adds to every data packet.
    pub fn packet_overhead(&self) -> u16 {
        // Only handshakes are padded.
        0
    }
}

/// A plain WireGuard datagram in AmneziaWG format.
#[derive(Debug)]
pub struct Obfuscated<'a> {
    /// Junk datagrams to send before `packet`.
    pub junk: Vec<Vec<u8>>,
    pub packet: Cow<'a, [u8]>,
}

/// Translates between plain WireGuard and AmneziaWG datagrams. Performs no I/O.
pub struct Codec {
    params: AmneziaParams,
    /// `mac1` key of messages to the server.
    tx_mac1_key: [u8; 32],
    /// `mac1` key of messages to the client.
    rx_mac1_key: [u8; 32],
}

impl Codec {
    pub fn new(settings: &Settings) -> Self {
        Self {
            params: settings.params,
            tx_mac1_key: mac1_key(&settings.server_public_key),
            rx_mac1_key: mac1_key(&settings.client_public_key),
        }
    }

    /// Convert a datagram from the local WireGuard instance. Returns `None` if it is not a
    /// WireGuard message.
    pub fn obfuscate<'a>(&self, packet: &'a mut [u8]) -> Option<Obfuscated<'a>> {
        let p = &self.params;
        let mut junk = vec![];
        let (header, padding) = match (message_type(packet)?, packet.len()) {
            (HANDSHAKE_INITIATION, HANDSHAKE_INITIATION_SIZE) => {
                junk = self.junk(&mut rand::rng());
                (p.h1, p.s1)
            }
            (HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE) => (p.h2, p.s2),
            (COOKIE_REPLY, COOKIE_REPLY_SIZE) => (p.h3, 0),
            (DATA, len) if len >= DATA_OVERHEAD_SIZE => (p.h4, 0),
            _ => return None,
        };

        let has_mac1 = packet[0] == HANDSHAKE_INITIATION || packet[0] == HANDSHAKE_RESPONSE;
        if u32::from(packet[0]) != header {
            packet[..4].copy_from_slice(&header.to_le_bytes());
            if has_mac1 {
                set_message_mac1(packet, &self.tx_mac1_key);
            }
        }

        let packet = if padding == 0 {
            Cow::Borrowed(packet)
        } else {
            let mut padded = vec![0u8; usize::from(padding) + packet.len()];
            rand::rng().fill_bytes(&mut padded[..usize::from(padding)]);
            padded[usize::from(padding)..].copy_from_slice(packet);
            Cow::Owned(padded)
        };
        Some(Obfuscated { junk, packet })
    }

    /// Convert a datagram from the server in place, returning the length of the plain WireGuard
    /// message now at the start of `packet`. Returns `None` for anything that is not an
    /// AmneziaWG message with these parameters, which should be dropped.
    ///
    /// The checks follow `DeterminePacketTypeAndPadding` in amneziawg-go.
    pub fn deobfuscate(&self, packet: &mut [u8]) -> Option<usize> {
        let p = &self.params;
        let header_at = |offset: usize| -> Option<u32> {
            let bytes = packet.get(offset..offset + 4)?;
            Some(u32::from_le_bytes(bytes.try_into().unwrap()))
        };
        let size = packet.len();
        let (s1, s2) = (usize::from(p.s1), usize::from(p.s2));

        let (wg_type, header, offset, len) = if size == s1 + HANDSHAKE_INITIATION_SIZE
            && header_at(s1) == Some(p.h1)
        {
            (HANDSHAKE_INITIATION, p.h1, s1, HANDSHAKE_INITIATION_SIZE)
        } else if size == s2 + HANDSHAKE_RESPONSE_SIZE && header_at(s2) == Some(p.h2) {
            (HANDSHAKE_RESPONSE, p.h2, s2, HANDSHAKE_RESPONSE_SIZE)
        } else if size == COOKIE_REPLY_SIZE && header_at(0) == Some(p.h3) {
            (COOKIE_REPLY, p.h3, 0, COOKIE_REPLY_SIZE)
        } else if size >= DATA_OVERHEAD_SIZE && header_at(0) == Some(p.h4) {
            (DATA, p.h4, 0, size)
        } else {
            return None;
        };

        let message = &mut packet[offset..offset + len];
        if header != u32::from(wg_type) {
            let has_mac1 = wg_type == HANDSHAKE_INITIATION || wg_type == HANDSHAKE_RESPONSE;
            if has_mac1 && !verify_message_mac1(message, &self.rx_mac1_key) {
                return None;
            }
            message[..4].copy_from_slice(&u32::from(wg_type).to_le_bytes());
            if has_mac1 {
                set_message_mac1(message, &self.rx_mac1_key);
            }
        }

        packet.copy_within(offset..offset + len, 0);
        Some(len)
    }

    /// `jc` datagrams of random bytes, as in `Device.JunkPackets` of amneziawg-go.
    fn junk(&self, rng: &mut impl RngCore) -> Vec<Vec<u8>> {
        let (min, max) = (usize::from(self.params.jmin), usize::from(self.params.jmax));
        (0..self.params.jc)
            .map(|_| {
                let len = if max > min {
                    rng.random_range(min..max)
                } else {
                    min
                };
                let mut buf = vec![0u8; len];
                rng.fill_bytes(&mut buf);
                buf
            })
            .collect()
    }
}

/// The plain WireGuard type of a message: the first byte, followed by 3 zero bytes.
fn message_type(packet: &[u8]) -> Option<u8> {
    match packet.get(..4)? {
        &[wg_type, 0, 0, 0] => Some(wg_type),
        _ => None,
    }
}

/// Sends and receives AmneziaWG datagrams to and from the server.
pub struct Amnezia {
    remote_socket: BypassSocket<UdpSocket>,
    server_addr: SocketAddr,
    codec: Codec,
}

impl Amnezia {
    pub async fn new(bypass: Arc<dyn SocketBypass>, settings: &Settings) -> crate::Result<Self> {
        let remote_socket = create_remote_socket(&bypass, settings.server_addr.is_ipv4()).await?;
        Ok(Self {
            remote_socket,
            server_addr: settings.server_addr,
            codec: Codec::new(settings),
        })
    }
}

#[async_trait]
impl ObfuscatedTransport for Amnezia {
    async fn send(&self, packet: &mut [u8]) -> io::Result<()> {
        let Some(obfuscated) = self.codec.obfuscate(packet) else {
            log::trace!("Dropping outgoing datagram that is not a WireGuard message");
            return Ok(());
        };
        for junk in &obfuscated.junk {
            self.remote_socket.send_to(junk, self.server_addr).await?;
        }
        self.remote_socket
            .send_to(&obfuscated.packet, self.server_addr)
            .await
            .map(drop)
    }

    async fn recv(&self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            let (n, from) = self.remote_socket.recv_from(buf).await?;
            if from != self.server_addr {
                continue;
            }
            match self.codec.deobfuscate(&mut buf[..n]) {
                Some(len) => return Ok(len),
                None => log::trace!("Dropping unrecognized AmneziaWG datagram"),
            }
        }
    }

    fn packet_overhead(&self) -> u16 {
        0
    }
}

#[cfg(test)]
mod test {
    use super::*;

    const AWG: AmneziaParams = AmneziaParams {
        jc: 5,
        jmin: 50,
        jmax: 100,
        s1: 37,
        s2: 21,
        h1: 0x1234_5678,
        h2: 0x2345_6789,
        h3: 0x3456_789a,
        h4: 0x4567_89ab,
    };

    fn client_key() -> PublicKey {
        PublicKey::from_base64("8Ka2l4T0tVrSR5pkcsvRG++mBlxfuf8XOxpqBkOCikU=").unwrap()
    }

    fn server_key() -> PublicKey {
        PublicKey::from_base64("4EkA4c160oQgN/YaNR9GN3gLMevXEfx5hnlc9jYmw14=").unwrap()
    }

    fn settings(params: AmneziaParams, server_addr: SocketAddr) -> Settings {
        Settings {
            server_addr,
            params,
            client_public_key: client_key(),
            server_public_key: server_key(),
        }
    }

    fn codec(params: AmneziaParams) -> Codec {
        Codec::new(&settings(params, "127.0.0.1:1".parse().unwrap()))
    }

    /// The codec of the server, which sees the roles of the keys swapped.
    fn server_codec(params: AmneziaParams) -> Codec {
        let mut settings = settings(params, "127.0.0.1:1".parse().unwrap());
        std::mem::swap(
            &mut settings.client_public_key,
            &mut settings.server_public_key,
        );
        Codec::new(&settings)
    }

    /// A plain WireGuard message of type `wg_type` and length `len` with random contents, and a
    /// valid `mac1` for `to` if it is a handshake.
    fn message(wg_type: u8, len: usize, to: &PublicKey) -> Vec<u8> {
        let mut packet = vec![0u8; len];
        rand::rng().fill_bytes(&mut packet[4..]);
        packet[0] = wg_type;
        if wg_type == HANDSHAKE_INITIATION || wg_type == HANDSHAKE_RESPONSE {
            set_message_mac1(&mut packet, &mac1_key(to));
        }
        packet
    }

    fn all_messages(to: &PublicKey) -> Vec<Vec<u8>> {
        vec![
            message(HANDSHAKE_INITIATION, HANDSHAKE_INITIATION_SIZE, to),
            message(HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, to),
            message(COOKIE_REPLY, COOKIE_REPLY_SIZE, to),
            message(DATA, DATA_OVERHEAD_SIZE, to),
            message(DATA, 1400, to),
        ]
    }

    #[test]
    fn round_trip_through_server() {
        let (client, server) = (codec(AWG), server_codec(AWG));
        for original in all_messages(&server_key()) {
            let mut packet = original.clone();
            let wire = client.obfuscate(&mut packet).unwrap().packet.into_owned();
            assert_ne!(wire[..], original[..]);

            let mut received = wire.clone();
            let len = server.deobfuscate(&mut received).unwrap();
            assert_eq!(&received[..len], &original[..]);
            // amneziawg-go checks `mac1` with the replaced header in place
            if original[0] <= HANDSHAKE_RESPONSE {
                let offset = wire.len() - original.len();
                assert!(verify_message_mac1(&wire[offset..], &mac1_key(&server_key())));
            }
        }
    }

    #[test]
    fn wire_format() {
        let client = codec(AWG);
        let cases = [
            (HANDSHAKE_INITIATION, HANDSHAKE_INITIATION_SIZE, AWG.s1, AWG.h1),
            (HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, AWG.s2, AWG.h2),
            (COOKIE_REPLY, COOKIE_REPLY_SIZE, 0, AWG.h3),
            (DATA, 200, 0, AWG.h4),
        ];
        for (wg_type, len, padding, header) in cases {
            let original = message(wg_type, len, &server_key());
            let mut packet = original.clone();
            let obfuscated = client.obfuscate(&mut packet).unwrap();
            let wire = &obfuscated.packet;
            let padding = usize::from(padding);
            assert_eq!(wire.len(), padding + len);
            assert_eq!(wire[padding..padding + 4], header.to_le_bytes());
            // Everything but the header (and `mac1`) is unchanged
            let end = if wg_type <= HANDSHAKE_RESPONSE { len - 32 } else { len };
            assert_eq!(wire[padding + 4..padding + end], original[4..end]);
            // Only initiations are preceded by junk
            let junk = if wg_type == HANDSHAKE_INITIATION { 5 } else { 0 };
            assert_eq!(obfuscated.junk.len(), junk);
        }
    }

    #[test]
    fn junk_count_and_size() {
        let client = codec(AWG);
        for _ in 0..200 {
            let junk = client.junk(&mut rand::rng());
            assert_eq!(junk.len(), usize::from(AWG.jc));
            for packet in junk {
                assert!((50..100).contains(&packet.len()), "{}", packet.len());
            }
        }
        let fixed = codec(AmneziaParams {
            jc: 2,
            jmin: 64,
            jmax: 64,
            ..AWG
        });
        assert!(fixed.junk(&mut rand::rng()).iter().all(|p| p.len() == 64));
        let none = codec(AmneziaParams { jc: 0, ..AWG });
        assert!(none.junk(&mut rand::rng()).is_empty());
    }

    #[test]
    fn junk_only_keeps_plain_wireguard() {
        let client = codec(AmneziaParams::JUNK_ONLY);
        for original in all_messages(&server_key()) {
            let mut packet = original.clone();
            let obfuscated = client.obfuscate(&mut packet).unwrap();
            assert_eq!(obfuscated.packet[..], original[..]);
            assert!(matches!(obfuscated.packet, Cow::Borrowed(_)));

            let mut received = original.clone();
            assert_eq!(client.deobfuscate(&mut received), Some(original.len()));
            assert_eq!(received, original);
        }
        let mut init = message(HANDSHAKE_INITIATION, HANDSHAKE_INITIATION_SIZE, &server_key());
        let junk = client.obfuscate(&mut init).unwrap().junk;
        assert_eq!(junk.len(), 4);
        assert!(junk.iter().all(|p| (40..70).contains(&p.len())));
    }

    #[test]
    fn padding_is_stripped() {
        let (client, server) = (codec(AWG), server_codec(AWG));
        let original = message(HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, &client_key());
        let mut packet = original.clone();
        let mut wire = server.obfuscate(&mut packet).unwrap().packet.into_owned();
        assert_eq!(wire.len(), usize::from(AWG.s2) + HANDSHAKE_RESPONSE_SIZE);
        let len = client.deobfuscate(&mut wire).unwrap();
        assert_eq!(len, HANDSHAKE_RESPONSE_SIZE);
        assert_eq!(&wire[..len], &original[..]);
    }

    #[test]
    fn unknown_packets_are_dropped() {
        let (client, server) = (codec(AWG), server_codec(AWG));
        let wire = |original: Vec<u8>| {
            let mut packet = original;
            server.obfuscate(&mut packet).unwrap().packet.into_owned()
        };
        let response = wire(message(
            HANDSHAKE_RESPONSE,
            HANDSHAKE_RESPONSE_SIZE,
            &client_key(),
        ));

        let mut too_long = response.clone();
        too_long.push(0);
        let mut bad_mac1 = response.clone();
        bad_mac1[usize::from(AWG.s2) + 12] ^= 1;
        let mut wrong_key = message(HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, &server_key());
        let wrong_key = codec(AWG).obfuscate(&mut wrong_key).unwrap().packet.into_owned();
        let mut short_data = wire(message(DATA, 100, &client_key()));
        short_data.truncate(DATA_OVERHEAD_SIZE - 1);

        let rejected = [
            // Plain WireGuard is not accepted when the headers are replaced
            message(HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, &client_key()),
            message(DATA, 200, &client_key()),
            too_long,
            bad_mac1,
            wrong_key,
            short_data,
            vec![],
            b"hello".to_vec(),
            vec![0xff; 300],
        ];
        for mut packet in rejected {
            assert_eq!(client.deobfuscate(&mut packet), None);
        }

        let mut outgoing = [
            vec![],
            b"hi".to_vec(),
            vec![9u8; 200],
            message(HANDSHAKE_INITIATION, 100, &server_key()),
        ];
        for packet in &mut outgoing {
            assert!(client.obfuscate(packet).is_none());
        }
    }

    /// Fake WireGuard client -> proxy -> fake AmneziaWG server, and back.
    #[tokio::test]
    async fn loopback() {
        let wg_socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();

        let proxy = crate::create_local_socket_obfuscator(&crate::Settings::Amnezia(settings(
            AWG,
            server.local_addr().unwrap(),
        )))
        .await
        .unwrap();
        let proxy_addr = proxy.endpoint();
        tokio::spawn(proxy.run());

        let init = message(HANDSHAKE_INITIATION, HANDSHAKE_INITIATION_SIZE, &server_key());
        wg_socket.send_to(&init, proxy_addr).await.unwrap();

        let mut buf = vec![0u8; 2000];
        for _ in 0..AWG.jc {
            let (n, _) = server.recv_from(&mut buf).await.unwrap();
            assert!((50..100).contains(&n), "junk of {n} bytes");
        }
        let (n, proxy_remote) = server.recv_from(&mut buf).await.unwrap();
        let s1 = usize::from(AWG.s1);
        assert_eq!(n, s1 + HANDSHAKE_INITIATION_SIZE);
        assert_eq!(buf[s1..s1 + 4], AWG.h1.to_le_bytes());
        let len = server_codec(AWG).deobfuscate(&mut buf[..n]).unwrap();
        assert_eq!(&buf[..len], &init[..]);

        let response = message(HANDSHAKE_RESPONSE, HANDSHAKE_RESPONSE_SIZE, &client_key());
        let mut packet = response.clone();
        let wire = server_codec(AWG).obfuscate(&mut packet).unwrap().packet;
        // Garbage from the server is dropped, not forwarded
        server.send_to(b"garbage", proxy_remote).await.unwrap();
        server.send_to(&wire, proxy_remote).await.unwrap();

        let (n, _) = wg_socket.recv_from(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], &response[..]);
        assert_eq!(buf[..4], [HANDSHAKE_RESPONSE, 0, 0, 0]);
    }
}
