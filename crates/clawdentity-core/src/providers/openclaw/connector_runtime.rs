use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

use crate::config::ConfigPathOptions;
use crate::error::{CoreError, Result};
use crate::provider::{check_connector_runtime, resolve_command_path};

use super::setup::connector_port_from_base_url;

const CONNECTOR_STARTUP_POLL_ATTEMPTS: usize = 20;
const CONNECTOR_STARTUP_POLL_DELAY: Duration = Duration::from_millis(250);
const CLI_BINARY_NAME: &str = "clawdentity";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ConnectorRuntimeEnsureResult {
    pub status: ConnectorRuntimeEnsureStatus,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ConnectorRuntimeEnsureStatus {
    Ready,
    ActionRequired,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalConnectorTarget {
    pub(super) bind: IpAddr,
    pub(super) port: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum ConnectorRuntimeTarget {
    Local(LocalConnectorTarget),
    External { host: String },
}

pub(super) fn ensure_local_connector_runtime(
    state_options: &ConfigPathOptions,
    agent_name: &str,
    connector_base_url: &str,
) -> Result<ConnectorRuntimeEnsureResult> {
    ensure_local_connector_runtime_with(
        state_options,
        agent_name,
        connector_base_url,
        spawn_connector_runtime,
        check_connector_runtime,
        thread::sleep,
    )
}

pub(super) fn ensure_local_connector_runtime_with<Launch, Probe, Sleep>(
    state_options: &ConfigPathOptions,
    agent_name: &str,
    connector_base_url: &str,
    launch: Launch,
    mut probe: Probe,
    sleep: Sleep,
) -> Result<ConnectorRuntimeEnsureResult>
where
    Launch: Fn(&ConfigPathOptions, &str, &LocalConnectorTarget) -> Result<()>,
    Probe: FnMut(&str) -> Result<(bool, String)>,
    Sleep: Fn(Duration),
{
    match classify_connector_runtime_target(connector_base_url)? {
        ConnectorRuntimeTarget::External { host: _ } => {
            let (healthy, message) = probe(connector_base_url)?;
            if healthy {
                return Ok(ConnectorRuntimeEnsureResult {
                    status: ConnectorRuntimeEnsureStatus::Ready,
                    notes: vec![format!(
                        "verified external connector runtime at `{connector_base_url}` ({message})"
                    )],
                });
            }

            Ok(ConnectorRuntimeEnsureResult {
                status: ConnectorRuntimeEnsureStatus::ActionRequired,
                notes: vec![format!(
                    "relay setup was saved, but the external connector runtime at `{connector_base_url}` is not ready ({message}). Start or fix that connector runtime, then run `clawdentity provider doctor --for openclaw`."
                )],
            })
        }
        ConnectorRuntimeTarget::Local(target) => {
            let (healthy, initial_message) = probe(connector_base_url)?;
            if healthy {
                return Ok(ConnectorRuntimeEnsureResult {
                    status: ConnectorRuntimeEnsureStatus::Ready,
                    notes: vec![format!(
                        "verified local connector runtime at `{connector_base_url}` ({initial_message})"
                    )],
                });
            }

            launch(state_options, agent_name, &target)?;
            let mut last_message = initial_message;
            for _ in 0..CONNECTOR_STARTUP_POLL_ATTEMPTS {
                sleep(CONNECTOR_STARTUP_POLL_DELAY);
                let (healthy, message) = probe(connector_base_url)?;
                if healthy {
                    return Ok(ConnectorRuntimeEnsureResult {
                        status: ConnectorRuntimeEnsureStatus::Ready,
                        notes: vec![format!(
                            "started local connector runtime for `{agent_name}` at `{connector_base_url}`"
                        )],
                    });
                }
                last_message = message;
            }

            Ok(ConnectorRuntimeEnsureResult {
                status: ConnectorRuntimeEnsureStatus::ActionRequired,
                notes: vec![format!(
                    "relay setup was saved, but the local connector runtime at `{connector_base_url}` is still unavailable ({last_message}). Run `clawdentity connector start {agent_name}`, then `clawdentity provider doctor --for openclaw`."
                )],
            })
        }
    }
}

pub(super) fn classify_connector_runtime_target(
    connector_base_url: &str,
) -> Result<ConnectorRuntimeTarget> {
    let parsed = url::Url::parse(connector_base_url.trim()).map_err(|_| CoreError::InvalidUrl {
        context: "connectorBaseUrl",
        value: connector_base_url.to_string(),
    })?;
    let Some(host) = parsed.host_str() else {
        return Err(CoreError::InvalidUrl {
            context: "connectorBaseUrl",
            value: connector_base_url.to_string(),
        });
    };

    let host = host.trim().to_ascii_lowercase();
    let Some(port) = connector_port_from_base_url(connector_base_url) else {
        return Err(CoreError::InvalidUrl {
            context: "connectorBaseUrl",
            value: connector_base_url.to_string(),
        });
    };

    let target = match host.as_str() {
        "localhost" => ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
        }),
        "127.0.0.1" => ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port,
        }),
        "0.0.0.0" => ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            port,
        }),
        "::1" => ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: IpAddr::V6(Ipv6Addr::LOCALHOST),
            port,
        }),
        _ => ConnectorRuntimeTarget::External { host },
    };

    Ok(target)
}

fn spawn_connector_runtime(
    state_options: &ConfigPathOptions,
    agent_name: &str,
    target: &LocalConnectorTarget,
) -> Result<()> {
    let executable = resolve_cli_executable()?;
    let mut command = Command::new(executable);
    if let Some(home_dir) = &state_options.home_dir {
        command.arg("--home-dir").arg(home_dir);
    }
    command
        .arg("connector")
        .arg("start")
        .arg(agent_name)
        .arg("--bind")
        .arg(target.bind.to_string())
        .arg("--port")
        .arg(target.port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    command.spawn().map(|_| ()).map_err(|error| {
        CoreError::InvalidInput(format!("failed to start local connector runtime: {error}"))
    })
}

fn resolve_cli_executable() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("CLAWDENTITY_CLI_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return Ok(PathBuf::from(trimmed));
        }
    }

    if let Ok(path) = std::env::current_exe()
        && path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| value.contains(CLI_BINARY_NAME))
            .unwrap_or(false)
    {
        return Ok(path);
    }

    resolve_command_path(CLI_BINARY_NAME, None).ok_or_else(|| {
        CoreError::InvalidInput(
            "unable to resolve the clawdentity CLI for local connector startup".to_string(),
        )
    })
}
