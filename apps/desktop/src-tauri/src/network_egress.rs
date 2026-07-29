//! Native egress DNS policy shared by model and cloud transports.

use std::error::Error;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};

use reqwest::dns::{Addrs, Name, Resolve, Resolving};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct RestrictedDnsResolver;

impl Resolve for RestrictedDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        Box::pin(resolve_restricted(name.as_str().to_owned()))
    }
}

async fn resolve_restricted(host: String) -> Result<Addrs, Box<dyn Error + Send + Sync>> {
    let lookup_host = host.clone();
    let addresses = tokio::task::spawn_blocking(move || {
        (lookup_host.as_str(), 0)
            .to_socket_addrs()
            .map(|addresses| addresses.collect::<Vec<_>>())
    })
    .await
    .map_err(|_| resolution_error("DNS resolution task failed"))?
    .map_err(|_| resolution_error("DNS resolution failed"))?;

    let allowed = addresses
        .into_iter()
        .filter(|address| address_is_allowed_for_host(&host, address.ip()))
        .collect::<Vec<_>>();
    if allowed.is_empty() {
        return Err(resolution_error(
            "DNS resolution did not return an allowed network address",
        ));
    }

    Ok(Box::new(allowed.into_iter()))
}

fn resolution_error(message: &'static str) -> Box<dyn Error + Send + Sync> {
    Box::new(io::Error::new(io::ErrorKind::PermissionDenied, message))
}

pub(crate) fn host_is_explicit_loopback(host: &str) -> bool {
    let normalized = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
        .trim_end_matches('.');
    normalized.eq_ignore_ascii_case("localhost")
        || normalized
            .to_ascii_lowercase()
            .strip_suffix(".localhost")
            .is_some_and(|prefix| !prefix.is_empty())
        || normalized.parse::<IpAddr>().is_ok_and(ip_is_loopback)
}

pub(crate) fn literal_ip_is_allowed(host: &str) -> bool {
    let normalized = normalized_ip_literal(host);
    normalized
        .parse::<IpAddr>()
        .is_ok_and(|address| ip_is_loopback(address) || ip_is_public(address))
}

pub(crate) fn host_is_ip_literal(host: &str) -> bool {
    normalized_ip_literal(host).parse::<IpAddr>().is_ok()
}

fn normalized_ip_literal(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host)
}

fn address_is_allowed_for_host(host: &str, address: IpAddr) -> bool {
    if host_is_explicit_loopback(host) {
        ip_is_loopback(address)
    } else {
        ip_is_public(address)
    }
}

fn ip_is_loopback(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => address.is_loopback(),
        IpAddr::V6(address) => {
            address.is_loopback()
                || address
                    .to_ipv4_mapped()
                    .is_some_and(|address| address.is_loopback())
        }
    }
}

fn ip_is_public(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => ipv4_is_public(address),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(ipv4_is_public)
            .unwrap_or_else(|| ipv6_is_public(address)),
    }
}

fn ipv4_is_public(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    if first == 0
        || first == 10
        || first == 127
        || first >= 224
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 168)
        || (first == 198 && (18..=19).contains(&second))
    {
        return false;
    }

    !matches!(
        (first, second, third),
        (192, 0, 0) | (192, 0, 2) | (192, 88, 99) | (198, 51, 100) | (203, 0, 113)
    )
}

fn ipv6_is_public(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    let is_global_unicast = segments[0] & 0xe000 == 0x2000;
    let is_documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
    let is_benchmarking = segments[0] == 0x2001 && segments[1] == 0x0002 && segments[2] == 0;

    is_global_unicast && !is_documentation && !is_benchmarking
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_loopback_answers_for_explicit_local_hosts() {
        assert!(host_is_explicit_loopback("localhost"));
        assert!(host_is_explicit_loopback("ollama.localhost"));
        assert!(host_is_explicit_loopback("127.12.3.4"));
        assert!(address_is_allowed_for_host(
            "ollama.localhost",
            "127.0.0.1".parse().expect("valid address")
        ));
        assert!(!address_is_allowed_for_host(
            "ollama.localhost",
            "8.8.8.8".parse().expect("valid address")
        ));
    }

    #[test]
    fn rejects_private_link_local_documentation_and_mapped_loopback_addresses() {
        for address in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.168.0.1",
            "198.18.0.1",
            "203.0.113.1",
            "::",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fe80::1",
            "2001:db8::1",
        ] {
            assert!(
                !address_is_allowed_for_host(
                    "models.example",
                    address.parse().expect("valid address")
                ),
                "{address} should be rejected for a remote host"
            );
        }
    }

    #[test]
    fn allows_public_ipv4_and_ipv6_addresses() {
        for address in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            assert!(
                address_is_allowed_for_host(
                    "models.example",
                    address.parse().expect("valid address")
                ),
                "{address} should be allowed for a remote host"
            );
        }
    }

    #[test]
    fn validates_literal_addresses_before_reqwest_can_bypass_dns() {
        assert!(literal_ip_is_allowed("127.0.0.1"));
        assert!(literal_ip_is_allowed("8.8.8.8"));
        assert!(literal_ip_is_allowed("[::ffff:127.0.0.1]"));
        assert!(!literal_ip_is_allowed("169.254.169.254"));
        assert!(!literal_ip_is_allowed("[fc00::1]"));
    }
}
