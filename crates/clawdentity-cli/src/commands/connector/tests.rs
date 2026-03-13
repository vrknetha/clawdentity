use anyhow::anyhow;
use chrono::{Duration as ChronoDuration, Utc};
use clawdentity_core::agent::AgentAuthRecord;

use super::runtime_config::{agent_access_requires_refresh, normalize_proxy_ws_url};
use super::{build_deliver_ack_reason, normalize_hook_path};

#[test]
fn normalizes_hook_path_with_leading_slash() {
    assert_eq!(normalize_hook_path("hooks/agent"), "/hooks/agent");
    assert_eq!(normalize_hook_path("/hooks/agent"), "/hooks/agent");
}

#[test]
fn normalizes_proxy_http_url_to_ws_connect_route() {
    let resolved = normalize_proxy_ws_url("http://127.0.0.1:13371").expect("proxy ws url");
    assert_eq!(resolved, "ws://127.0.0.1:13371/v1/relay/connect");
}

#[test]
fn preserves_ws_url_when_already_websocket() {
    let resolved =
        normalize_proxy_ws_url("wss://proxy.example/v1/relay/connect").expect("proxy ws url");
    assert_eq!(resolved, "wss://proxy.example/v1/relay/connect");
}

#[test]
fn deliver_ack_reason_is_none_when_delivery_and_persistence_succeed() {
    let reason = build_deliver_ack_reason(None, None);
    assert!(reason.is_none());
}

#[test]
fn deliver_ack_reason_reports_persistence_failure() {
    let persistence_error = anyhow!("sqlite unavailable");
    let reason = build_deliver_ack_reason(None, Some(&persistence_error));
    assert_eq!(
        reason.as_deref(),
        Some("failed to persist inbound delivery result: sqlite unavailable")
    );
}

#[test]
fn deliver_ack_reason_combines_delivery_and_persistence_failures() {
    let delivery_error = anyhow!("openclaw hook returned HTTP 500");
    let persistence_error = anyhow!("sqlite unavailable");
    let reason = build_deliver_ack_reason(Some(&delivery_error), Some(&persistence_error));
    assert_eq!(
        reason.as_deref(),
        Some(
            "openclaw hook returned HTTP 500; failed to persist inbound delivery result: sqlite unavailable"
        )
    );
}

fn sample_auth_record(access_token: &str, expires_at: chrono::DateTime<Utc>) -> AgentAuthRecord {
    AgentAuthRecord {
        token_type: "Bearer".to_string(),
        access_token: access_token.to_string(),
        access_expires_at: expires_at.to_rfc3339(),
        refresh_token: "refresh-token".to_string(),
        refresh_expires_at: (expires_at + ChronoDuration::days(7)).to_rfc3339(),
    }
}

#[test]
fn agent_access_refreshes_when_token_missing() {
    let now = Utc::now();
    let record = sample_auth_record("", now + ChronoDuration::minutes(10));
    assert!(agent_access_requires_refresh(&record, now));
}

#[test]
fn agent_access_refreshes_when_token_is_near_expiry() {
    let now = Utc::now();
    let record = sample_auth_record("clw_agt_access", now + ChronoDuration::seconds(30));
    assert!(agent_access_requires_refresh(&record, now));
}

#[test]
fn agent_access_is_reused_when_token_is_still_fresh() {
    let now = Utc::now();
    let record = sample_auth_record("clw_agt_access", now + ChronoDuration::minutes(10));
    assert!(!agent_access_requires_refresh(&record, now));
}
