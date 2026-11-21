use ipnetwork::{IpNetwork, Ipv4Network, Ipv6Network};
use mullvad_types::CustomTunnelEndpoint;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::{future::Future, net::IpAddr, pin::Pin, sync::Arc};
use talpid_error::ErrorExt;

use talpid_types::net::wireguard::TunnelParameters;
use tokio::sync::Mutex;

use mullvad_daemon_relay_selector::relay_selector::RelaySelectorIO;
use mullvad_relay_selector::{GetRelay, WireguardConfig};
use mullvad_types::{
    endpoint::MullvadEndpoint,
    location::GeoIpLocation,
    relay_constraints::{GeographicLocationConstraint, RelaySettings},
    settings::{Settings, TunnelOptions},
};
use talpid_core::tunnel_state_machine::TunnelParametersGenerator;
use talpid_types::net::{
    ALLOWED_LAN_MULTICAST_NETS, ALLOWED_LAN_NETS, ipnetwork_sub::IpNetworkSub,
    obfuscation::Obfuscators, wireguard,
};
use talpid_types::{net::IpAvailability, tunnel::ParameterGenerationError};

use crate::device::{AccountManagerHandle, Error as DeviceError, PrivateAccountAndDevice};

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("Not logged in on a valid device")]
    NoAuthDetails,

    #[error("Failed to select a matching relay")]
    SelectRelay(#[from] mullvad_relay_selector::Error),

    #[error("Failed to resolve hostname for custom relay")]
    ResolveCustomHostname,

    #[error("Failed to get device data")]
    Device(#[from] DeviceError),

    #[error("Custom VPN config has no IPv4 interface address")]
    CustomVpnNoIpv4,
}

/// Tunnel parameters that connect directly to a custom VPN server, without a Mullvad relay.
/// Like upstream custom tunnel endpoints, the peer endpoint is what the firewall allows.
#[cfg(feature = "custom-vpn")]
fn custom_vpn_tunnel_parameters(
    config: &wireguard::CustomVpnConfig,
    tunnel_options: TunnelOptions,
) -> Result<TunnelParameters, Error> {
    let ipv4 = config
        .tunnel
        .ips
        .iter()
        .find_map(|ip| match ip {
            IpAddr::V4(ip) => Some(*ip),
            IpAddr::V6(_) => None,
        })
        .ok_or(Error::CustomVpnNoIpv4)?;
    // shortcut: imported configs carry no gateway, so assume x.y.z.1 (wg-easy, PiVPN, Proton,
    // Mullvad all use it). It is the default DNS and ping target; set custom DNS if it differs.
    let [a, b, c, _] = ipv4.octets();
    let ipv4_gateway = Ipv4Addr::new(a, b, c, 1);

    let peer = config.peers.first();
    if config.peers.len() > 1 {
        log::warn!("Custom VPN has several peers; standalone mode only uses the first");
    }

    let mut options = tunnel_options.wireguard.into_talpid_tunnel_options();
    // Quantum resistance and DAITA need a Mullvad relay.
    options.quantum_resistant = false;
    options.daita = false;
    // The server's MTU (wg-quick `MTU =`) wins; a too-large MTU silently drops TLS traffic.
    options.mtu = config.tunnel.mtu.or(options.mtu);

    Ok(wireguard::TunnelParameters {
        connection: wireguard::ConnectionConfig {
            tunnel: wireguard::TunnelConfig {
                private_key: config.tunnel.private_key.clone(),
                addresses: config.tunnel.ips.clone(),
            },
            peer: wireguard::PeerConfig {
                public_key: peer.public_key.clone(),
                allowed_ips: peer.allowed_ip.clone(),
                endpoint: peer.endpoint,
                psk: None,
                constant_packet_size: false,
            },
            exit_peer: None,
            ipv4_gateway,
            ipv6_gateway: None,
            routes: None,
            #[cfg(target_os = "linux")]
            fwmark: Some(mullvad_types::TUNNEL_FWMARK),
        },
        options,
        generic_options: tunnel_options.generic,
        obfuscation: None,
        custom_vpn: None,
    })
}

#[derive(Clone)]
pub(crate) struct ParametersGenerator(Arc<Mutex<InnerParametersGenerator>>);

struct InnerParametersGenerator {
    relay_selector: RelaySelectorIO,
    custom_endpoint: Option<CustomTunnelEndpoint>,
    tunnel_options: TunnelOptions,
    account_manager: AccountManagerHandle,
    #[cfg(feature = "custom-vpn")]
    custom_vpn: Option<talpid_types::net::wireguard::CustomVpnConfig>,

    last_generated_relays: Option<LastSelectedRelays>,
}

impl ParametersGenerator {
    /// Constructs a new tunnel parameters generator.
    pub fn new(
        account_manager: AccountManagerHandle,
        relay_selector: RelaySelectorIO,
        relay_settings: RelaySettings,
        tunnel_options: TunnelOptions,
        #[cfg(feature = "custom-vpn")] custom_vpn: Option<
            talpid_types::net::wireguard::CustomVpnConfig,
        >,
    ) -> Self {
        Self(Arc::new(Mutex::new(InnerParametersGenerator {
            tunnel_options,
            relay_selector,
            custom_endpoint: relay_settings.as_custom_tunnel_endpoint().cloned(),
            account_manager,
            #[cfg(feature = "custom-vpn")]
            custom_vpn,
            last_generated_relays: None,
        })))
    }

    /// Sets the tunnel options to use when generating new tunnel parameters.
    pub async fn set_tunnel_options(&self, tunnel_options: &TunnelOptions) {
        let mut inner = self.0.lock().await;
        inner.tunnel_options = tunnel_options.clone();
        inner.relay_selector.clear_relay_queue();
    }

    /// Updates generator state from full settings and keeps relay-selector config in sync.
    pub async fn set_settings(&self, settings: Settings) {
        let mut inner = self.0.lock().await;
        inner.custom_endpoint = settings.relay_settings.as_custom_tunnel_endpoint().cloned();
        inner.relay_selector.set_config(settings);
    }

    /// Sets the custom VPN config to use when generating new tunnel parameters.
    #[cfg(feature = "custom-vpn")]
    pub async fn set_custom_vpn(
        &self,
        config: Option<talpid_types::net::wireguard::CustomVpnConfig>,
    ) {
        self.0.lock().await.custom_vpn = config;
    }

    pub async fn last_relay_was_overridden(&self) -> bool {
        let inner = self.0.lock().await;
        let Some(relays) = inner.last_generated_relays.as_ref() else {
            return false;
        };
        relays.server_override
    }

    /// Gets the location associated with the last generated tunnel parameters.
    pub async fn get_last_location(&self) -> Option<GeoIpLocation> {
        let inner = self.0.lock().await;

        let relays = inner.last_generated_relays.as_ref()?;

        let (entry, exit) = match &relays.config {
            WireguardConfig::Singlehop { exit } => (None, exit),
            WireguardConfig::Multihop { exit, entry } => (Some(entry), exit),
        };
        let location = exit.location.clone();

        Some(GeoIpLocation {
            latitude: location.latitude,
            longitude: location.longitude,
            ipv4: None,
            ipv6: None,
            mullvad_exit_ip: true,
            city: Some(location.city),
            country: location.country,
            location: Some(GeographicLocationConstraint::Hostname(
                location.country_code,
                location.city_code,
                exit.hostname.clone(),
            )),
            entry_city: entry.map(|relay| relay.location.city.clone()),
            entry_country: entry.map(|relay| relay.location.country.clone()),
            entry_location: entry.map(|relay| {
                GeographicLocationConstraint::Hostname(
                    relay.location.country_code.clone(),
                    relay.location.city_code.clone(),
                    relay.hostname.clone(),
                )
            }),
        })
    }
}

/// Private networks that may point to Mullvad services in the VPN tunnel.
const ALLOWED_IN_TUNNEL_LAN_NETS: [IpNetwork; 2] = [
    // Net including the relay IPv4 gateway. Used for DNS, tunnel config service, and connectivity
    // check.
    // This also includes SOCKS5 proxies.
    // Reserve all of `10/8` in case new services are added.
    IpNetwork::V4(Ipv4Network::new_checked(Ipv4Addr::new(10, 0, 0, 0), 8).unwrap()),
    // Net including the relay IPv6 gateway.
    IpNetwork::V6(
        Ipv6Network::new_checked(
            Ipv6Addr::new(0xfc00, 0xbbbb, 0xbbbb, 0xbb01, 0, 0, 0, 0),
            64,
        )
        .unwrap(),
    ),
];

/// Remove the private networks that must not be reachable through a Mullvad tunnel from
/// `allowed_ips`.
///
/// [`ALLOWED_IN_TUNNEL_LAN_NETS`] is allowlisted, since those ranges are legitimately used in
/// Mullvad tunnels. Other traffic is likely just LAN traffic leaking into the tunnel.
fn subtract_lan_nets(allowed_ips: &[IpNetwork]) -> Vec<IpNetwork> {
    // `sub_all` cannot mix address families.
    let blocked = |ipv4: bool| -> Vec<IpNetwork> {
        let exceptions: Vec<IpNetwork> = ALLOWED_IN_TUNNEL_LAN_NETS
            .iter()
            .copied()
            .filter(|net| net.is_ipv4() == ipv4)
            .collect();

        ALLOWED_LAN_NETS
            .iter()
            .chain(ALLOWED_LAN_MULTICAST_NETS.iter())
            .filter(|net| net.is_ipv4() == ipv4)
            .flat_map(|lan_net| lan_net.sub_all(exceptions.clone()))
            .collect()
    };
    let (blocked_v4, blocked_v6) = (blocked(true), blocked(false));

    allowed_ips
        .iter()
        .flat_map(|allowed_ip| {
            let blocked = if allowed_ip.is_ipv4() {
                &blocked_v4
            } else {
                &blocked_v6
            };
            allowed_ip.sub_all(blocked.clone())
        })
        .collect()
}

impl InnerParametersGenerator {
    async fn generate(
        &mut self,
        retry_attempt: u32,
        ip_availability: IpAvailability,
    ) -> Result<TunnelParameters, Error> {
        // An enabled own config is exclusive: connect straight to the user's WireGuard server,
        // whatever the account state. No relay selection, no device data, no Mullvad API.
        #[cfg(feature = "custom-vpn")]
        if let Some(config) = self.custom_vpn.as_ref() {
            self.last_generated_relays = None;
            return custom_vpn_tunnel_parameters(config, self.tunnel_options.clone());
        }

        // Custom tunnel endpoints bypass relay selection entirely.
        if let Some(endpoint) = self.custom_endpoint.as_ref() {
            self.last_generated_relays = None;
            return endpoint
                .to_tunnel_parameters(self.tunnel_options.clone())
                .map_err(|e| {
                    log::error!("Failed to resolve hostname for custom tunnel config: {}", e);
                    Error::ResolveCustomHostname
                });
        }

        let data = self.device().await?;

        self.relay_selector.set_ip_availability(ip_availability);
        if retry_attempt == 0 {
            self.relay_selector.clear_relay_queue();
        }

        let GetRelay {
            endpoint,
            obfuscator,
            inner,
            server_override,
        } = self.relay_selector.next_relay()?;

        self.last_generated_relays = Some(LastSelectedRelays {
            config: inner,
            server_override,
        });

        Ok(self.create_wireguard_tunnel_parameters(endpoint, data, obfuscator))
    }

    fn create_wireguard_tunnel_parameters(
        &self,
        mut endpoint: MullvadEndpoint,
        data: PrivateAccountAndDevice,
        obfuscator_config: Option<Obfuscators>,
    ) -> TunnelParameters {
        let tunnel_ipv4 = data.device.wg_data.addresses.ipv4_address.ip();
        let tunnel_ipv6 = data.device.wg_data.addresses.ipv6_address.ip();
        let tunnel = wireguard::TunnelConfig {
            private_key: data.device.wg_data.private_key,
            addresses: vec![IpAddr::from(tunnel_ipv4), IpAddr::from(tunnel_ipv6)],
        };

        // Deliberately filter out private IP ranges but keep the routes, to prevent unexpected
        // LAN traffic in the tunnel.
        let routes = Some(
            endpoint
                .exit_peer
                .iter()
                .chain(std::iter::once(&endpoint.peer))
                .flat_map(|peer| peer.allowed_ips.iter())
                .copied()
                .collect(),
        );

        for peer in endpoint
            .exit_peer
            .iter_mut()
            .chain(std::iter::once(&mut endpoint.peer))
        {
            peer.allowed_ips = subtract_lan_nets(&peer.allowed_ips);
        }

        wireguard::TunnelParameters {
            connection: wireguard::ConnectionConfig {
                tunnel,
                peer: endpoint.peer,
                exit_peer: endpoint.exit_peer,
                ipv4_gateway: endpoint.ipv4_gateway,
                ipv6_gateway: Some(endpoint.ipv6_gateway),
                routes,
                #[cfg(target_os = "linux")]
                fwmark: Some(mullvad_types::TUNNEL_FWMARK),
            },
            options: self
                .tunnel_options
                .wireguard
                .clone()
                .into_talpid_tunnel_options(),
            generic_options: self.tunnel_options.generic.clone(),
            obfuscation: obfuscator_config,
            // Own configs are never nested in a Mullvad tunnel; `generate` returns early for them.
            #[cfg(feature = "custom-vpn")]
            custom_vpn: None,
        }
    }

    async fn device(&self) -> Result<PrivateAccountAndDevice, Error> {
        let device_state = self.account_manager.data().await?;
        device_state.into_device().ok_or(Error::NoAuthDetails)
    }
}

impl TunnelParametersGenerator for ParametersGenerator {
    fn generate(
        &mut self,
        retry_attempt: u32,
        ip_availability: IpAvailability,
    ) -> Pin<Box<dyn Future<Output = Result<TunnelParameters, ParameterGenerationError>>>> {
        let generator = self.0.clone();
        Box::pin(async move {
            let mut inner = generator.lock().await;
            inner
                .generate(retry_attempt, ip_availability)
                .await
                .inspect_err(|error| {
                    log::error!(
                        "{}",
                        error.display_chain_with_msg("Failed to generate tunnel parameters")
                    );
                })
                .map_err(ParameterGenerationError::from)
        })
    }
}

impl From<Error> for ParameterGenerationError {
    fn from(error: Error) -> Self {
        match error {
            Error::SelectRelay(mullvad_relay_selector::Error::NoBridge) => {
                ParameterGenerationError::NoMatchingBridgeRelay
            }
            Error::ResolveCustomHostname => {
                ParameterGenerationError::CustomTunnelHostResolutionError
            }
            Error::SelectRelay(mullvad_relay_selector::Error::IpVersionUnavailable { family }) => {
                ParameterGenerationError::IpVersionUnavailable { family }
            }
            Error::SelectRelay(mullvad_relay_selector::Error::NoRelayEntry(_)) => {
                ParameterGenerationError::NoMatchingRelayEntry
            }
            Error::SelectRelay(mullvad_relay_selector::Error::NoRelayExit(_)) => {
                ParameterGenerationError::NoMatchingRelayExit
            }
            Error::NoAuthDetails
            | Error::SelectRelay(_)
            | Error::Device(_)
            | Error::CustomVpnNoIpv4 => {
                ParameterGenerationError::NoMatchingRelay
            }
        }
    }
}

/// Contains all relays that were selected last time when tunnel parameters were generated.
///
/// Represents all relays generated for a WireGuard tunnel.
/// The traffic flow can look like this:
///     client -> obfuscator -> entry -> exit -> internet
/// But for most users, it will look like this:
///     client -> entry -> internet
struct LastSelectedRelays {
    config: WireguardConfig,
    server_override: bool,
}

#[cfg(test)]
mod test {
    use super::*;

    fn allowed_ips(nets: &[&str]) -> Vec<IpNetwork> {
        nets.iter().map(|net| net.parse().unwrap()).collect()
    }

    fn covers(nets: &[IpNetwork], ip: &str) -> bool {
        let ip: IpAddr = ip.parse().unwrap();
        nets.iter().any(|net| net.contains(ip))
    }

    /// Test whether private IPs are subtracted correctly.
    #[test]
    fn test_disallowed_tun_ip_ranges() {
        let result = subtract_lan_nets(&allowed_ips(&["0.0.0.0/0", "::/0"]));

        for ip in ["192.168.1.1", "172.16.0.1", "169.254.0.1", "fe80::1"] {
            assert!(!covers(&result, ip), "{ip} must not be reachable in tunnel");
        }
        for ip in ["1.2.3.4", "2606:4700::1111"] {
            assert!(covers(&result, ip), "{ip} must remain reachable in tunnel");
        }
    }

    /// Standalone custom VPN params connect straight to the user's peer, with no Mullvad parts.
    #[cfg(feature = "custom-vpn")]
    #[test]
    fn test_custom_vpn_standalone_parameters() {
        let config = wireguard::CustomVpnConfig {
            enabled: true,
            name: None,
            tunnel: wireguard::CustomVpnTunnelConfig {
                private_key: wireguard::PrivateKey::new_from_random(),
                ips: vec!["10.8.0.2".parse().unwrap(), "fd00::2".parse().unwrap()],
                dns: vec![],
                mtu: None,
            },
            peers: vec1::vec1![wireguard::CustomVpnPeerConfig {
                public_key: wireguard::PrivateKey::new_from_random().public_key(),
                allowed_ip: allowed_ips(&["0.0.0.0/0", "::/0"]),
                endpoint: "203.0.113.7:51820".parse().unwrap(),
            }],
        };
        let mut options = TunnelOptions::default();
        options.wireguard.quantum_resistant = mullvad_types::wireguard::QuantumResistantState::On;

        let params = custom_vpn_tunnel_parameters(&config, options).unwrap();

        assert_eq!(
            params.get_next_hop_endpoints()[0].address,
            "203.0.113.7:51820".parse().unwrap()
        );
        assert_eq!(params.connection.ipv4_gateway, Ipv4Addr::new(10, 8, 0, 1));
        assert!(params.connection.exit_peer.is_none());
        assert!(params.custom_vpn.is_none());
        assert!(!params.options.quantum_resistant);
        assert!(params.obfuscation.is_none());
    }

    /// Test legit private IPs in Mullvad tunnels.
    ///
    /// - IPv4 gateway/DNS: 10.64.0.1
    /// - SOCKS proxies: 10.124.0.0/23
    /// - Possible future range: 10.128.0.1
    /// - Adblocking DNS: 100.64.0.1
    #[test]
    fn test_allowed_mullvad_tun_ip_ranges() {
        let result = subtract_lan_nets(&allowed_ips(&["0.0.0.0/0", "::/0"]));

        for ip in ["10.64.0.1", "10.124.0.2", "10.128.0.1", "100.64.0.1"] {
            assert!(covers(&result, ip), "{ip} must be reachable in tunnel");
        }
    }
}
