use serde::Serialize;
use serde_json::Value;
use std::net::IpAddr;
use std::sync::Arc;

use crate::transport::{
    build_tailnet_http_client, inspect_pi_web, is_tailscale_ip, tailnet_http_client,
    tailnet_ip_for_hostname, tailscale_command, tailscale_status, validate_tailnet_url,
    DeviceStatus,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TailnetPeer {
    id: String,
    name: String,
    host: String,
    dns_name: Option<String>,
    ip: String,
    os: Option<String>,
    online: bool,
    is_self: bool,
    pi_web: bool,
    requires_auth: bool,
    url: String,
    latency_ms: Option<u128>,
    version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TailnetScan {
    available: bool,
    tailnet: Option<String>,
    peers: Vec<TailnetPeer>,
    message: Option<String>,
}
pub(crate) const MAX_DISCOVERED_TAILNET_PEERS: usize = 256;
pub(crate) const MAX_TAILNET_SERVICE_PROBES: usize = 32;
pub(crate) const MAX_TAILNET_PROBE_CONCURRENCY: usize = 8;
#[tauri::command]
pub(crate) async fn probe_device(url: String) -> Result<DeviceStatus, String> {
    let base = validate_tailnet_url(&url)?;
    // Tailscale Serve can take several seconds for the first TLS handshake.
    let client = tailnet_http_client(&base).await?;
    let mut status = tokio::time::timeout(
        std::time::Duration::from_secs(12),
        inspect_pi_web(&client, &url),
    )
    .await
    .unwrap_or(DeviceStatus {
        state: "offline".into(),
        latency_ms: None,
        version: None,
        error: Some("连接超时，请检查 Tailscale 路由".into()),
    });
    // Attach tailnet diagnostics so the card shows *why* it is unreachable.
    if status.state == "offline" {
        if let Some(host) = base.host_str() {
            let note = match tailnet_ip_for_hostname(host).await {
                Ok(Some(ip)) => format!("（Tailscale 节点 IP：{ip}）"),
                Ok(None) => {
                    "（tailscale status 中未找到该节点，或本机 Tailscale 未运行）".to_owned()
                }
                Err(error) => format!("（tailscale status 不可用：{error}）"),
            };
            status.error = Some(format!("{} {}", status.error.unwrap_or_default(), note));
        }
    }
    Ok(status)
}
pub(crate) type PeerValue = (String, String, Option<String>, String, Option<String>, bool);
pub(crate) type ProbeInput = (
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    bool,
    String,
);

pub(crate) fn peer_from_value(id: &str, value: &Value, is_self: bool) -> Option<PeerValue> {
    let dns = value
        .get("DNSName")
        .and_then(Value::as_str)
        .map(|s| s.trim_end_matches('.').to_owned());
    // Display name: the DNSName's first label reflects renames made in the
    // Tailscale admin console; HostName is the machine's self-reported OS
    // hostname and never updates.
    let name = dns
        .as_deref()
        .and_then(|s| s.split('.').next())
        .filter(|s| !s.is_empty())
        .or_else(|| value.get("HostName").and_then(Value::as_str))?
        .to_owned();
    let ips = value.get("TailscaleIPs").and_then(Value::as_array)?;
    let ip = ips
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|value| value.parse::<IpAddr>().ok())
        .filter(|ip| is_tailscale_ip(*ip))
        .find(IpAddr::is_ipv4)
        .or_else(|| {
            ips.iter()
                .filter_map(Value::as_str)
                .filter_map(|value| value.parse::<IpAddr>().ok())
                .find(|ip| is_tailscale_ip(*ip))
        })?
        .to_string();
    let os = value.get("OS").and_then(Value::as_str).map(|s| match s {
        "macOS" | "darwin" => "macOS".to_owned(),
        other => other.to_owned(),
    });
    let online = is_self
        || value
            .get("Online")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    Some((
        if id.is_empty() {
            name.clone()
        } else {
            id.to_owned()
        },
        name,
        dns,
        ip,
        os,
        online,
    ))
}

pub(crate) fn tailnet_origin(host: &str, port: u16) -> String {
    if host.parse::<std::net::Ipv6Addr>().is_ok() {
        format!("https://[{host}]:{port}")
    } else {
        format!("https://{host}:{port}")
    }
}

#[tauri::command]
pub(crate) async fn discover_tailscale(
    port: Option<u16>,
    probe_services: Option<bool>,
) -> Result<TailnetScan, String> {
    let probe_services = probe_services.unwrap_or(true);
    if tailscale_command().is_none() {
        return Ok(TailnetScan {
            available: false,
            tailnet: None,
            peers: vec![],
            message: Some("未找到 Tailscale。请先安装适用于当前系统的 Tailscale 客户端。".into()),
        });
    };
    let root = match tailscale_status().await {
        Ok(root) => root,
        Err(message) => {
            return Ok(TailnetScan {
                available: false,
                tailnet: None,
                peers: vec![],
                message: Some(message),
            })
        }
    };
    let tailnet = root
        .pointer("/CurrentTailnet/Name")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    let mut raw: Vec<(String, &Value, bool)> = Vec::new();
    if let Some(me) = root.get("Self") {
        raw.push(("self".into(), me, true));
    }
    if let Some(peers) = root.get("Peer").and_then(Value::as_object) {
        raw.extend(peers.iter().map(|(id, peer)| (id.clone(), peer, false)));
    }
    let mut peers = Vec::new();
    let mut probe_inputs: Vec<ProbeInput> = Vec::new();
    let mut probe_states: Vec<Option<DeviceStatus>> = Vec::new();
    let mut probe_tasks = tokio::task::JoinSet::new();
    let probe_permits = Arc::new(tokio::sync::Semaphore::new(MAX_TAILNET_PROBE_CONCURRENCY));
    let service_port = port.unwrap_or(30141);
    let mut discovered_peers = 0usize;
    let mut peer_limit_reached = false;
    let mut probe_limit_reached = false;
    for (id, value, is_self) in raw {
        let Some((peer_id, name, dns, ip, os, online)) = peer_from_value(&id, value, is_self)
        else {
            continue;
        };
        if !online {
            continue;
        }
        if discovered_peers >= MAX_DISCOVERED_TAILNET_PEERS {
            peer_limit_reached = true;
            break;
        }
        discovered_peers += 1;
        let host = dns.clone().unwrap_or_else(|| ip.clone());
        // Discovery mode checks the PiHub HTTPS endpoint. SSH setup mode must
        // never probe the application port because a new node has no server
        // yet; it only enumerates online Tailnet peers for bootstrap.
        if probe_services && probe_inputs.len() < MAX_TAILNET_SERVICE_PROBES {
            let probe_host = dns.as_deref().unwrap_or(&ip);
            let url = tailnet_origin(probe_host, service_port);
            let parsed = validate_tailnet_url(&url)?;
            let verified_ip = ip
                .parse::<IpAddr>()
                .ok()
                .filter(|ip| is_tailscale_ip(*ip))
                .ok_or("tailscale status 返回了非法节点地址")?;
            let client = build_tailnet_http_client(&parsed, Some(verified_ip))?;
            probe_inputs.push((peer_id, name, host, dns, ip, os, is_self, url.clone()));
            let index = probe_states.len();
            probe_states.push(None);
            let permits = Arc::clone(&probe_permits);
            probe_tasks.spawn(async move {
                let Ok(_permit) = permits.acquire_owned().await else {
                    return (
                        index,
                        DeviceStatus {
                            state: "offline".into(),
                            latency_ms: None,
                            version: None,
                            error: None,
                        },
                    );
                };
                // DERP-relayed nodes need several seconds per TLS handshake; a
                // short timeout here permanently hides slow-but-working servers.
                let status = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    inspect_pi_web(&client, &url),
                )
                .await
                .unwrap_or(DeviceStatus {
                    state: "offline".into(),
                    latency_ms: None,
                    version: None,
                    error: None,
                });
                (index, status)
            });
        } else {
            probe_limit_reached |= probe_services;
            let url = dns
                .as_deref()
                .map(|dns_host| tailnet_origin(dns_host, service_port))
                .unwrap_or_default();
            peers.push(TailnetPeer {
                id: peer_id,
                name,
                host,
                dns_name: dns,
                ip,
                os,
                online,
                is_self,
                pi_web: false,
                requires_auth: false,
                url,
                latency_ms: None,
                version: None,
            });
        }
    }
    while let Some(joined) = probe_tasks.join_next().await {
        let (index, status) = joined.map_err(|error| error.to_string())?;
        probe_states[index] = Some(status);
    }
    for ((peer_id, name, host, dns, ip, os, is_self, url), status) in
        probe_inputs.into_iter().zip(probe_states)
    {
        let result = status.unwrap_or(DeviceStatus {
            state: "offline".into(),
            latency_ms: None,
            version: None,
            error: None,
        });
        let requires_auth = result.state == "auth";
        peers.push(TailnetPeer {
            id: peer_id,
            name,
            host,
            dns_name: dns,
            ip,
            os,
            online: true,
            is_self,
            pi_web: result.state == "online" || requires_auth,
            requires_auth,
            url,
            latency_ms: result.latency_ms,
            version: result.version,
        });
    }
    peers.sort_by_key(|peer| (!peer.pi_web, !peer.is_self, peer.name.to_lowercase()));
    let mut notices = Vec::new();
    if peer_limit_reached {
        notices.push(format!(
            "节点较多，仅显示前 {MAX_DISCOVERED_TAILNET_PEERS} 个在线节点"
        ));
    }
    if probe_limit_reached {
        notices.push(format!(
            "仅探测前 {MAX_TAILNET_SERVICE_PROBES} 个在线节点的 PiHub 服务"
        ));
    }
    Ok(TailnetScan {
        available: true,
        tailnet,
        peers,
        message: (!notices.is_empty()).then(|| notices.join("；")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailnet_origin_brackets_ipv6() {
        assert_eq!(
            tailnet_origin("fd7a:115c:a1e0::7", 30141),
            "https://[fd7a:115c:a1e0::7]:30141"
        );
        assert_eq!(
            tailnet_origin("peer.example.ts.net", 30141),
            "https://peer.example.ts.net:30141"
        );
    }
}
