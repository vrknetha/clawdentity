use tempfile::TempDir;

use super::{
    FAILURE_CODE_CONNECTOR_DOWN, FAILURE_CODE_PROVIDER_UNHEALTHY, OnboardingRunInput,
    OnboardingSession, OnboardingState, classify_doctor_failures, collect_missing_identity_inputs,
    onboarding_session_path, save_onboarding_session,
};
use clawdentity_core::{
    CliConfig, ConfigPathOptions, ProviderDoctorCheck, ProviderDoctorCheckStatus,
};

#[test]
fn onboarding_session_path_is_under_clawdentity_root() {
    let temp = TempDir::new().expect("temp dir");
    let options = ConfigPathOptions {
        home_dir: Some(temp.path().to_path_buf()),
        registry_url_hint: None,
    };

    let path = onboarding_session_path(&options).expect("session path");
    assert!(path.ends_with(".clawdentity/onboarding-session.json"));
}

#[test]
fn save_session_persists_json() {
    let temp = TempDir::new().expect("temp dir");
    let options = ConfigPathOptions {
        home_dir: Some(temp.path().to_path_buf()),
        registry_url_hint: None,
    };

    let session = OnboardingSession {
        state: OnboardingState::ProviderReady,
        ..OnboardingSession::default()
    };
    save_onboarding_session(&options, &session).expect("save");
    let raw = std::fs::read_to_string(onboarding_session_path(&options).expect("path"))
        .expect("read session");
    assert!(raw.contains("\"state\": \"provider_ready\""));
}

#[test]
fn doctor_failure_classifies_connector_runtime_code() {
    for check_id in ["state.connectorRuntime", "connector.runtime"] {
        let checks = vec![ProviderDoctorCheck {
            id: check_id.to_string(),
            label: "Connector runtime".to_string(),
            status: ProviderDoctorCheckStatus::Fail,
            message: "connector runtime is down".to_string(),
            remediation_hint: None,
            details: None,
        }];

        let (code, _) = classify_doctor_failures(&checks);
        assert_eq!(code, FAILURE_CODE_CONNECTOR_DOWN);
    }
}

#[test]
fn doctor_failure_classifies_webhook_health_as_provider_unhealthy() {
    let checks = vec![ProviderDoctorCheck {
        id: "webhook.health".to_string(),
        label: "Webhook health".to_string(),
        status: ProviderDoctorCheckStatus::Fail,
        message: "provider endpoint is unreachable".to_string(),
        remediation_hint: None,
        details: None,
    }];

    let (code, remediation) = classify_doctor_failures(&checks);
    assert_eq!(code, FAILURE_CODE_PROVIDER_UNHEALTHY);
    assert!(remediation.contains("provider runtime endpoint"));
}

#[test]
fn collect_missing_identity_inputs_requires_onboarding_display_and_agent() {
    let config = CliConfig {
        registry_url: "http://localhost:8788".to_string(),
        proxy_url: Some("http://localhost:8787".to_string()),
        api_key: None,
        human_name: None,
    };
    let input = OnboardingRunInput {
        platform: "openclaw".to_string(),
        onboarding_code: None,
        display_name: None,
        agent_name: None,
        peer_ticket: None,
        pair_wait_seconds: 30,
        pair_poll_interval_seconds: 3,
        repair: false,
        reset: false,
    };
    let session = OnboardingSession::default();
    let missing = collect_missing_identity_inputs(&config, &input, &session);
    assert_eq!(
        missing,
        vec!["onboarding_code", "display_name", "agent_name"]
    );
}

#[test]
fn collect_missing_identity_inputs_uses_existing_session_and_config_values() {
    let config = CliConfig {
        registry_url: "http://localhost:8788".to_string(),
        proxy_url: Some("http://localhost:8787".to_string()),
        api_key: Some("token".to_string()),
        human_name: Some("Alex".to_string()),
    };
    let input = OnboardingRunInput {
        platform: "openclaw".to_string(),
        onboarding_code: None,
        display_name: None,
        agent_name: None,
        peer_ticket: None,
        pair_wait_seconds: 30,
        pair_poll_interval_seconds: 3,
        repair: false,
        reset: false,
    };
    let session = OnboardingSession {
        agent_name: Some("alpha-local".to_string()),
        ..OnboardingSession::default()
    };
    let missing = collect_missing_identity_inputs(&config, &input, &session);
    assert!(missing.is_empty());
}
