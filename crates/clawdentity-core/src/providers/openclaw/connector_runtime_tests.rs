use std::path::PathBuf;
use std::sync::Mutex;

use super::connector_runtime::{
    ConnectorRuntimeEnsureResult, ConnectorRuntimeEnsureStatus, ConnectorRuntimeTarget,
    LocalConnectorTarget, classify_connector_runtime_target, ensure_local_connector_runtime_with,
};
use crate::config::ConfigPathOptions;

#[test]
fn classify_connector_runtime_target_marks_loopback_hosts_local() {
    assert_eq!(
        classify_connector_runtime_target("http://127.0.0.1:19400").expect("local"),
        ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: "127.0.0.1".parse().expect("ip"),
            port: 19400,
        })
    );
    assert_eq!(
        classify_connector_runtime_target("http://localhost:19400").expect("localhost"),
        ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: "127.0.0.1".parse().expect("ip"),
            port: 19400,
        })
    );
    assert_eq!(
        classify_connector_runtime_target("http://0.0.0.0:19400").expect("any"),
        ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: "0.0.0.0".parse().expect("ip"),
            port: 19400,
        })
    );
}

#[test]
fn classify_connector_runtime_target_marks_non_loopback_hosts_external() {
    assert_eq!(
        classify_connector_runtime_target("http://host.docker.internal:19400").expect("external"),
        ConnectorRuntimeTarget::External {
            host: "host.docker.internal".to_string(),
        }
    );
    assert_eq!(
        classify_connector_runtime_target("https://relay.example.test:24444").expect("external"),
        ConnectorRuntimeTarget::External {
            host: "relay.example.test".to_string(),
        }
    );
}

#[test]
fn classify_connector_runtime_target_accepts_implicit_default_ports() {
    assert_eq!(
        classify_connector_runtime_target("http://localhost").expect("implicit http"),
        ConnectorRuntimeTarget::Local(LocalConnectorTarget {
            bind: "127.0.0.1".parse().expect("ip"),
            port: 80,
        })
    );
    assert_eq!(
        classify_connector_runtime_target("https://relay.example.test").expect("implicit https"),
        ConnectorRuntimeTarget::External {
            host: "relay.example.test".to_string(),
        }
    );
}

#[test]
fn local_connector_autostart_runs_when_probe_starts_unhealthy() {
    let launch_calls = Mutex::new(Vec::<String>::new());
    let probe_calls = Mutex::new(0usize);

    let result = ensure_local_connector_runtime_with(
        &ConfigPathOptions {
            home_dir: Some(PathBuf::from("/tmp/home")),
            registry_url_hint: None,
        },
        "alpha",
        "http://127.0.0.1:19400",
        |_, agent_name, target| {
            launch_calls
                .lock()
                .expect("launch lock")
                .push(format!("{agent_name}@{}:{}", target.bind, target.port));
            Ok(())
        },
        |_| {
            let mut calls = probe_calls.lock().expect("probe lock");
            *calls += 1;
            if *calls >= 2 {
                Ok((true, "connector websocket is connected".to_string()))
            } else {
                Ok((false, "connector status request failed".to_string()))
            }
        },
        |_| {},
    )
    .expect("autostart result");

    assert_eq!(
        result,
        ConnectorRuntimeEnsureResult {
            status: ConnectorRuntimeEnsureStatus::Ready,
            notes: vec![
                "started local connector runtime for `alpha` at `http://127.0.0.1:19400`"
                    .to_string()
            ],
        }
    );
    assert_eq!(
        launch_calls.lock().expect("launch lock").as_slice(),
        ["alpha@127.0.0.1:19400"]
    );
    assert_eq!(*probe_calls.lock().expect("probe lock"), 2);
}

#[test]
fn external_connector_target_skips_autostart() {
    let result = ensure_local_connector_runtime_with(
        &ConfigPathOptions {
            home_dir: None,
            registry_url_hint: None,
        },
        "alpha",
        "http://host.docker.internal:19400",
        |_, _, _| Ok(()),
        |_| Ok((false, "connector status request failed".to_string())),
        |_| {},
    )
    .expect("skip result");

    assert_eq!(
        result,
        ConnectorRuntimeEnsureResult {
            status: ConnectorRuntimeEnsureStatus::ActionRequired,
            notes: vec![
                "relay setup was saved, but the external connector runtime at `http://host.docker.internal:19400` is not ready (connector status request failed). Start or fix that connector runtime, then run `clawdentity provider doctor --for openclaw`."
                    .to_string()
            ],
        }
    );
}

#[test]
fn external_connector_target_is_ready_when_probe_passes() {
    let result = ensure_local_connector_runtime_with(
        &ConfigPathOptions {
            home_dir: None,
            registry_url_hint: None,
        },
        "alpha",
        "https://relay.example.test:24444",
        |_, _, _| Ok(()),
        |_| Ok((true, "connector websocket is connected".to_string())),
        |_| {},
    )
    .expect("ready result");

    assert_eq!(
        result,
        ConnectorRuntimeEnsureResult {
            status: ConnectorRuntimeEnsureStatus::Ready,
            notes: vec![
                "verified external connector runtime at `https://relay.example.test:24444` (connector websocket is connected)"
                    .to_string()
            ],
        }
    );
}
