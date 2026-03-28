use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use clap::Subcommand;
use clawdentity_core::{
    CliConfig, ConfigPathOptions, CoreError, CreateAgentInput, InviteRedeemInput, PairConfirmInput,
    PairStatusKind, PairStatusOptions, ProviderDoctorCheck, ProviderDoctorCheckStatus,
    ProviderDoctorOptions, ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestStatus,
    ProviderSetupOptions, ProviderSetupStatus, SqliteStore, confirm_pairing, create_agent,
    fetch_registry_metadata, get_config_dir, get_config_root_dir, get_provider, inspect_agent,
    persist_redeem_config, read_config, redeem_invite, resolve_config, resolve_openclaw_base_url,
    resolve_openclaw_hook_token, write_config,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::commands::pair::{build_local_pair_profile, resolve_pair_proxy_url};

const ONBOARDING_SESSION_FILE_NAME: &str = "onboarding-session.json";
const ONBOARDING_SESSION_VERSION: u32 = 1;
const DEFAULT_PLATFORM: &str = "openclaw";
const DEFAULT_PAIR_WAIT_SECONDS: u64 = 30;
const DEFAULT_PAIR_POLL_INTERVAL_SECONDS: u64 = 3;

const FAILURE_CODE_MISSING_REQUIRED_INPUT: &str = "ONBOARDING_REQUIRED_INPUT_MISSING";
const FAILURE_CODE_CONNECTOR_DOWN: &str = "ONBOARDING_CONNECTOR_DOWN";
const FAILURE_CODE_PEER_MISSING: &str = "ONBOARDING_PEER_MISSING";
const FAILURE_CODE_OPENCLAW_HOOK_400: &str = "ONBOARDING_OPENCLAW_HOOK_400";
const FAILURE_CODE_AGENT_OWNERSHIP_MISMATCH: &str = "ONBOARDING_AGENT_OWNERSHIP_MISMATCH";
const FAILURE_CODE_PROVIDER_UNHEALTHY: &str = "ONBOARDING_PROVIDER_UNHEALTHY";

#[derive(Debug, Clone, Subcommand)]
pub enum OnboardingCommand {
    Run {
        #[arg(long = "for", default_value = DEFAULT_PLATFORM)]
        platform: String,
        #[arg(long)]
        onboarding_code: Option<String>,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        peer_ticket: Option<String>,
        #[arg(long, default_value_t = DEFAULT_PAIR_WAIT_SECONDS)]
        pair_wait_seconds: u64,
        #[arg(long, default_value_t = DEFAULT_PAIR_POLL_INTERVAL_SECONDS)]
        pair_poll_interval_seconds: u64,
        #[arg(long)]
        repair: bool,
        #[arg(long)]
        reset: bool,
    },
    Status,
    Reset,
}

#[derive(Debug, Clone)]
struct OnboardingRunInput {
    platform: String,
    onboarding_code: Option<String>,
    display_name: Option<String>,
    agent_name: Option<String>,
    peer_ticket: Option<String>,
    pair_wait_seconds: u64,
    pair_poll_interval_seconds: u64,
    repair: bool,
    reset: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord, Default)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingState {
    #[default]
    CliReady,
    IdentityReady,
    ProviderReady,
    PairingPending,
    Paired,
    MessagingReady,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum PairingProgressState {
    #[default]
    WaitingForConfirm,
    ConfirmReceived,
    PeerSaved,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct OnboardingPairingProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<PairingProgressState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingFailure {
    code: String,
    message: String,
    remediation: String,
    at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingSession {
    version: u32,
    state: OnboardingState,
    platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pairing: Option<OnboardingPairingProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<OnboardingFailure>,
    updated_at: String,
}

impl Default for OnboardingSession {
    fn default() -> Self {
        Self {
            version: ONBOARDING_SESSION_VERSION,
            state: OnboardingState::CliReady,
            platform: DEFAULT_PLATFORM.to_string(),
            agent_name: None,
            display_name: None,
            pairing: None,
            last_error: None,
            updated_at: clawdentity_core::now_iso(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum OnboardingRunStatus {
    Ready,
    ActionRequired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OnboardingRunResult {
    status: OnboardingRunStatus,
    state: OnboardingState,
    message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    required_inputs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    peer_alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    remediation: Option<String>,
}

/// Execute onboarding state-machine commands.
pub async fn execute_onboarding_command(
    options: &ConfigPathOptions,
    command: OnboardingCommand,
    json_output: bool,
) -> Result<()> {
    match command {
        OnboardingCommand::Run {
            platform,
            onboarding_code,
            display_name,
            agent_name,
            peer_ticket,
            pair_wait_seconds,
            pair_poll_interval_seconds,
            repair,
            reset,
        } => {
            let input = OnboardingRunInput {
                platform,
                onboarding_code,
                display_name,
                agent_name,
                peer_ticket,
                pair_wait_seconds,
                pair_poll_interval_seconds,
                repair,
                reset,
            };
            execute_onboarding_run(options, input, json_output).await
        }
        OnboardingCommand::Status => {
            let session = load_onboarding_session(options)?;
            if json_output {
                println!("{}", serde_json::to_string_pretty(&session)?);
            } else {
                println!(
                    "Onboarding session [{}]: {}",
                    session.platform,
                    format_state_for_display(session.state)
                );
                if let Some(agent_name) = session.agent_name.as_deref() {
                    println!("Agent: {agent_name}");
                }
                if let Some(display_name) = session.display_name.as_deref() {
                    println!("Display name: {display_name}");
                }
                if let Some(pairing) = session.pairing.as_ref() {
                    if let Some(phase) = pairing.phase {
                        println!("Pairing phase: {}", format_pairing_phase_for_display(phase));
                    }
                    if let Some(ticket) = pairing.ticket.as_deref() {
                        println!("Ticket: {ticket}");
                    }
                    if let Some(peer_alias) = pairing.peer_alias.as_deref() {
                        println!("Peer alias: {peer_alias}");
                    }
                }
                if let Some(error) = session.last_error.as_ref() {
                    println!("Last error [{}]: {}", error.code, error.message);
                    println!("Fix: {}", error.remediation);
                }
                println!("Updated at: {}", session.updated_at);
            }
            Ok(())
        }
        OnboardingCommand::Reset => {
            reset_onboarding_session(options)?;
            if json_output {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&json!({
                        "reset": true,
                        "path": onboarding_session_path(options)?.to_string_lossy(),
                    }))?
                );
            } else {
                println!("Onboarding session reset.");
            }
            Ok(())
        }
    }
}

async fn execute_onboarding_run(
    options: &ConfigPathOptions,
    input: OnboardingRunInput,
    json_output: bool,
) -> Result<()> {
    let mut session = if input.reset {
        OnboardingSession::default()
    } else {
        load_onboarding_session(options)?
    };

    session.platform =
        normalize_non_empty(Some(&input.platform)).unwrap_or(DEFAULT_PLATFORM.to_string());
    if let Some(display_name) = normalize_non_empty(input.display_name.as_deref()) {
        session.display_name = Some(display_name);
    }
    if let Some(agent_name) = normalize_non_empty(input.agent_name.as_deref()) {
        session.agent_name = Some(agent_name);
    }
    if let Some(peer_ticket) = normalize_non_empty(input.peer_ticket.as_deref()) {
        session
            .pairing
            .get_or_insert_with(OnboardingPairingProgress::default)
            .ticket = Some(peer_ticket);
    }

    let result = match run_onboarding_flow(options, &input, &mut session).await {
        Ok(result) => result,
        Err(error) => {
            let (code, remediation) = classify_onboarding_error(&error);
            set_last_error(
                &mut session,
                code,
                error.to_string(),
                remediation.to_string(),
            );
            OnboardingRunResult {
                status: OnboardingRunStatus::ActionRequired,
                state: session.state,
                message: "Onboarding needs manual input or repair.".to_string(),
                required_inputs: vec![],
                ticket: session
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.ticket.clone()),
                peer_alias: session
                    .pairing
                    .as_ref()
                    .and_then(|pairing| pairing.peer_alias.clone()),
                failure_code: Some(code.to_string()),
                remediation: Some(remediation.to_string()),
            }
        }
    };

    session.updated_at = clawdentity_core::now_iso();
    save_onboarding_session(options, &session)?;

    if json_output {
        println!("{}", serde_json::to_string_pretty(&result)?);
    } else {
        println!(
            "Onboarding [{}]: {}",
            format_state_for_display(result.state),
            result.message
        );
        if !result.required_inputs.is_empty() {
            println!("Required input:");
            for required_input in &result.required_inputs {
                println!("- {required_input}");
            }
        }
        if let Some(ticket) = result.ticket.as_deref() {
            println!("Ticket: {ticket}");
        }
        if let Some(peer_alias) = result.peer_alias.as_deref() {
            println!("Peer alias: {peer_alias}");
        }
        if let Some(failure_code) = result.failure_code.as_deref() {
            println!("Failure code: {failure_code}");
        }
        if let Some(remediation) = result.remediation.as_deref() {
            println!("Fix: {remediation}");
        }
        if matches!(result.status, OnboardingRunStatus::Ready)
            && let Some(peer_alias) = result.peer_alias.as_deref()
        {
            println!("Ready to chat with {peer_alias}");
        }
    }

    Ok(())
}

async fn run_onboarding_flow(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
) -> Result<OnboardingRunResult> {
    session.state = OnboardingState::CliReady;
    clear_last_error(session);

    let mut config = ensure_config_ready(options).await?;
    session.display_name = session
        .display_name
        .clone()
        .or_else(|| normalize_non_empty(config.human_name.as_deref()));

    let missing_inputs = collect_missing_identity_inputs(&config, input, session);
    if !missing_inputs.is_empty() {
        set_last_error(
            session,
            FAILURE_CODE_MISSING_REQUIRED_INPUT,
            "missing mandatory onboarding inputs".to_string(),
            "Re-run with the required inputs shown in this response.".to_string(),
        );
        return Ok(action_required_result(
            session,
            "Missing required onboarding inputs.",
            missing_inputs,
        ));
    }

    ensure_identity_ready(options, input, session, &mut config).await?;
    session.state = OnboardingState::IdentityReady;

    let agent_name = session
        .agent_name
        .clone()
        .ok_or_else(|| anyhow!("agent name is required"))?;

    ensure_provider_ready(options, input, session, &agent_name)?;
    session.state = OnboardingState::ProviderReady;

    let pairing_result =
        ensure_pairing_ready(options, input, session, &agent_name, &config).await?;
    if let Some(result) = pairing_result {
        return Ok(result);
    }
    session.state = OnboardingState::Paired;

    let peer_alias = session
        .pairing
        .as_ref()
        .and_then(|pairing| pairing.peer_alias.clone())
        .ok_or_else(|| anyhow!("paired peer alias is missing"))?;
    ensure_messaging_ready(options, input, session, &agent_name, &peer_alias)?;
    session.state = OnboardingState::MessagingReady;

    clear_last_error(session);
    Ok(OnboardingRunResult {
        status: OnboardingRunStatus::Ready,
        state: session.state,
        message: format!("Ready to chat with peer alias `{peer_alias}`."),
        required_inputs: vec![],
        ticket: session
            .pairing
            .as_ref()
            .and_then(|pairing| pairing.ticket.clone()),
        peer_alias: Some(peer_alias),
        failure_code: None,
        remediation: None,
    })
}

async fn ensure_config_ready(options: &ConfigPathOptions) -> Result<CliConfig> {
    let mut config = read_config(options)?;
    if normalize_non_empty(Some(config.registry_url.as_str())).is_none() {
        config.registry_url = clawdentity_core::DEFAULT_REGISTRY_URL.to_string();
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;

    if let Ok(metadata) = fetch_registry_metadata(&client, &config.registry_url).await {
        config.registry_url = metadata.registry_url;
        if !metadata.proxy_url.trim().is_empty() {
            config.proxy_url = Some(metadata.proxy_url);
        }
    }

    let _ = write_config(&config, options)?;
    resolve_config(options).map_err(anyhow::Error::from)
}

async fn ensure_identity_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    config: &mut CliConfig,
) -> Result<()> {
    if config.api_key.is_none() {
        let onboarding_code = normalize_non_empty(input.onboarding_code.as_deref());
        let display_name = normalize_non_empty(
            input
                .display_name
                .as_deref()
                .or(session.display_name.as_deref()),
        );
        if onboarding_code.is_none() || display_name.is_none() {
            set_last_error(
                session,
                FAILURE_CODE_MISSING_REQUIRED_INPUT,
                "onboarding code and display name are required before identity setup".to_string(),
                "Re-run with --onboarding-code <clw_stp_...|clw_inv_...> --display-name <name>"
                    .to_string(),
            );
            return Err(anyhow!("missing required onboarding inputs"));
        }

        let result = run_blocking({
            let options = options.clone();
            let onboarding_code = onboarding_code.expect("validated onboarding code");
            let display_name = display_name.expect("validated display name");
            move || {
                redeem_invite(
                    &options,
                    InviteRedeemInput {
                        code: onboarding_code,
                        display_name,
                        api_key_name: None,
                        registry_url: None,
                    },
                )
                .map_err(anyhow::Error::from)
            }
        })
        .await?;

        let _ = run_blocking({
            let options = options.clone();
            let result = result.clone();
            move || persist_redeem_config(&options, &result).map_err(anyhow::Error::from)
        })
        .await?;
        *config = resolve_config(options)?;
    }

    if config.human_name.is_none() {
        let display_name = normalize_non_empty(
            input
                .display_name
                .as_deref()
                .or(session.display_name.as_deref()),
        );
        let Some(display_name) = display_name else {
            set_last_error(
                session,
                FAILURE_CODE_MISSING_REQUIRED_INPUT,
                "display name is required before agent creation".to_string(),
                "Re-run with --display-name <name>".to_string(),
            );
            return Err(anyhow!("missing required display name"));
        };

        config.human_name = Some(display_name.clone());
        let _ = write_config(config, options)?;
        session.display_name = Some(display_name);
    } else {
        session.display_name = normalize_non_empty(config.human_name.as_deref());
    }

    let agent_name = normalize_non_empty(input.agent_name.as_deref())
        .or_else(|| session.agent_name.clone())
        .ok_or_else(|| {
            set_last_error(
                session,
                FAILURE_CODE_MISSING_REQUIRED_INPUT,
                "agent name is required before identity setup".to_string(),
                "Re-run with --agent-name <name>".to_string(),
            );
            anyhow!("missing required agent name")
        })?;
    session.agent_name = Some(agent_name.clone());

    let state_options = options.with_registry_hint(config.registry_url.clone());
    let agent_exists = run_blocking({
        let state_options = state_options.clone();
        let agent_name = agent_name.clone();
        move || Ok(inspect_agent(&state_options, &agent_name).is_ok())
    })
    .await?;

    if !agent_exists {
        run_blocking({
            let state_options = state_options.clone();
            let agent_name = agent_name.clone();
            let platform = input.platform.clone();
            move || {
                create_agent(
                    &state_options,
                    CreateAgentInput {
                        name: agent_name,
                        framework: Some(platform),
                        ttl_days: None,
                    },
                )
                .map(|_| ())
                .map_err(anyhow::Error::from)
            }
        })
        .await?;
    }

    Ok(())
}

fn ensure_provider_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    agent_name: &str,
) -> Result<()> {
    let provider = get_provider(&input.platform)
        .ok_or_else(|| anyhow!("unknown provider `{}`", input.platform))?;
    let home_dir = options.home_dir.clone();

    let setup_result = provider.setup(&ProviderSetupOptions {
        home_dir: home_dir.clone(),
        agent_name: Some(agent_name.to_string()),
        ..ProviderSetupOptions::default()
    })?;

    if setup_result.status == ProviderSetupStatus::ActionRequired && !input.repair {
        set_last_error(
            session,
            FAILURE_CODE_CONNECTOR_DOWN,
            "provider setup requires additional action".to_string(),
            "Re-run with --repair to auto-recover connector runtime.".to_string(),
        );
    }

    let mut doctor_result = provider.doctor(&ProviderDoctorOptions {
        home_dir: home_dir.clone(),
        selected_agent: Some(agent_name.to_string()),
        include_connector_runtime_check: true,
        ..ProviderDoctorOptions::default()
    })?;

    if doctor_result.status == ProviderDoctorStatus::Unhealthy
        && input.repair
        && doctor_has_connector_failure(&doctor_result.checks)
    {
        let _ = provider.setup(&ProviderSetupOptions {
            home_dir: home_dir.clone(),
            agent_name: Some(agent_name.to_string()),
            ..ProviderSetupOptions::default()
        })?;
        doctor_result = provider.doctor(&ProviderDoctorOptions {
            home_dir,
            selected_agent: Some(agent_name.to_string()),
            include_connector_runtime_check: true,
            ..ProviderDoctorOptions::default()
        })?;
    }

    if doctor_result.status == ProviderDoctorStatus::Unhealthy {
        let (code, remediation) = classify_doctor_failures(&doctor_result.checks);
        set_last_error(
            session,
            code,
            "provider doctor is unhealthy".to_string(),
            remediation,
        );
        return Err(anyhow!("provider doctor is unhealthy"));
    }

    Ok(())
}

async fn ensure_pairing_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    agent_name: &str,
    config: &CliConfig,
) -> Result<Option<OnboardingRunResult>> {
    let state_options = options.with_registry_hint(config.registry_url.clone());
    let config_dir = get_config_dir(&state_options)?;
    let proxy_url = resolve_pair_proxy_url(config).await?;
    let profile = build_local_pair_profile(agent_name, config, &proxy_url)?;

    let explicit_ticket = normalize_non_empty(input.peer_ticket.as_deref());
    if let Some(ticket) = explicit_ticket {
        let ticket_for_confirm = ticket.clone();
        let confirm_result = run_blocking({
            let config_dir = config_dir.clone();
            let state_options = state_options.clone();
            let agent_name = agent_name.to_string();
            move || {
                let store = SqliteStore::open(&state_options)?;
                confirm_pairing(
                    &config_dir,
                    &store,
                    &agent_name,
                    PairConfirmInput::Ticket(ticket_for_confirm),
                    profile,
                )
                .map_err(anyhow::Error::from)
            }
        })
        .await?;

        let peer_alias = confirm_result.peer_alias.clone();
        session.pairing = Some(OnboardingPairingProgress {
            ticket: Some(ticket),
            peer_alias: peer_alias.clone(),
            phase: Some(if peer_alias.is_some() {
                PairingProgressState::PeerSaved
            } else {
                PairingProgressState::ConfirmReceived
            }),
        });
        emit_pairing_saved_notification(
            &config_dir,
            peer_alias.as_deref().unwrap_or("unknown-peer"),
            &confirm_result.responder_profile.agent_name,
            &confirm_result.responder_profile.human_name,
        )
        .await;

        if peer_alias.is_none() {
            set_last_error(
                session,
                FAILURE_CODE_PEER_MISSING,
                "pair confirm succeeded but peer alias was not persisted".to_string(),
                "Re-run `clawdentity pair status --ticket <ticket> <agent-name>` to persist peer state."
                    .to_string(),
            );
            return Ok(Some(action_required_result(
                session,
                "Pair confirmed but peer metadata was not persisted yet.",
                vec![],
            )));
        }

        clear_last_error(session);
        return Ok(None);
    }

    if let Some(existing_ticket) = session
        .pairing
        .as_ref()
        .and_then(|pairing| pairing.ticket.clone())
    {
        let wait_seconds = input.pair_wait_seconds;
        let poll_interval_seconds = input.pair_poll_interval_seconds;
        let status_ticket = existing_ticket.clone();
        let status = run_blocking({
            let config_dir = config_dir.clone();
            let state_options = state_options.clone();
            let agent_name = agent_name.to_string();
            let proxy_url = proxy_url.clone();
            move || {
                let store = SqliteStore::open(&state_options)?;
                clawdentity_core::get_pairing_status(
                    &config_dir,
                    &store,
                    &agent_name,
                    &proxy_url,
                    &status_ticket,
                    PairStatusOptions {
                        wait: true,
                        wait_seconds,
                        poll_interval_seconds,
                    },
                )
                .map_err(anyhow::Error::from)
            }
        })
        .await?;

        if status.status == PairStatusKind::Pending {
            session.state = OnboardingState::PairingPending;
            session.pairing = Some(OnboardingPairingProgress {
                ticket: Some(existing_ticket),
                peer_alias: None,
                phase: Some(PairingProgressState::WaitingForConfirm),
            });
            clear_last_error(session);
            return Ok(Some(action_required_result(
                session,
                "Waiting for peer confirmation. Share the ticket with the other user and re-run this command.",
                vec![],
            )));
        }

        let peer_alias = status.peer_alias.clone();
        session.pairing = Some(OnboardingPairingProgress {
            ticket: Some(existing_ticket),
            peer_alias: peer_alias.clone(),
            phase: Some(if peer_alias.is_some() {
                PairingProgressState::PeerSaved
            } else {
                PairingProgressState::ConfirmReceived
            }),
        });

        if let Some(responder_profile) = status.responder_profile.as_ref()
            && let Some(peer_alias) = peer_alias.as_deref()
        {
            emit_pairing_saved_notification(
                &config_dir,
                peer_alias,
                &responder_profile.agent_name,
                &responder_profile.human_name,
            )
            .await;
        }

        if peer_alias.is_none() {
            set_last_error(
                session,
                FAILURE_CODE_PEER_MISSING,
                "pair confirmed but peer alias was not persisted".to_string(),
                "Re-run with --repair to reconcile provider setup and pairing state.".to_string(),
            );
            return Ok(Some(action_required_result(
                session,
                "Pair confirmed, but local peer state is not ready yet.",
                vec![],
            )));
        }

        clear_last_error(session);
        return Ok(None);
    }

    let start_result = run_blocking({
        let config_dir = config_dir.clone();
        let agent_name = agent_name.to_string();
        let proxy_url = proxy_url.clone();
        move || {
            clawdentity_core::start_pairing(&config_dir, &agent_name, &proxy_url, profile, None)
                .map_err(anyhow::Error::from)
        }
    })
    .await?;

    session.state = OnboardingState::PairingPending;
    session.pairing = Some(OnboardingPairingProgress {
        ticket: Some(start_result.ticket.clone()),
        peer_alias: None,
        phase: Some(PairingProgressState::WaitingForConfirm),
    });
    clear_last_error(session);

    Ok(Some(action_required_result(
        session,
        "Pairing started. Share the ticket with the peer and ask them to run onboarding with --peer-ticket.",
        vec![],
    )))
}

fn ensure_messaging_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    agent_name: &str,
    peer_alias: &str,
) -> Result<()> {
    let provider = get_provider(&input.platform)
        .ok_or_else(|| anyhow!("unknown provider `{}`", input.platform))?;
    let home_dir = options.home_dir.clone();

    let mut doctor_result = provider.doctor(&ProviderDoctorOptions {
        home_dir: home_dir.clone(),
        selected_agent: Some(agent_name.to_string()),
        peer_alias: Some(peer_alias.to_string()),
        include_connector_runtime_check: true,
        ..ProviderDoctorOptions::default()
    })?;

    if doctor_result.status == ProviderDoctorStatus::Unhealthy
        && input.repair
        && doctor_has_connector_failure(&doctor_result.checks)
    {
        let _ = provider.setup(&ProviderSetupOptions {
            home_dir: home_dir.clone(),
            agent_name: Some(agent_name.to_string()),
            ..ProviderSetupOptions::default()
        })?;
        doctor_result = provider.doctor(&ProviderDoctorOptions {
            home_dir: home_dir.clone(),
            selected_agent: Some(agent_name.to_string()),
            peer_alias: Some(peer_alias.to_string()),
            include_connector_runtime_check: true,
            ..ProviderDoctorOptions::default()
        })?;
    }

    if doctor_result.status == ProviderDoctorStatus::Unhealthy {
        let (code, remediation) = classify_doctor_failures(&doctor_result.checks);
        set_last_error(
            session,
            code,
            "provider doctor is unhealthy".to_string(),
            remediation,
        );
        return Err(anyhow!("provider doctor is unhealthy"));
    }

    let mut relay_result = provider.relay_test(&ProviderRelayTestOptions {
        home_dir: home_dir.clone(),
        peer_alias: Some(peer_alias.to_string()),
        message: Some("hello from Clawdentity onboarding".to_string()),
        skip_preflight: false,
        ..ProviderRelayTestOptions::default()
    })?;

    if relay_result.status == ProviderRelayTestStatus::Failure && input.repair {
        let is_hook_400 = relay_result.http_status == Some(400);
        if is_hook_400 {
            let _ = provider.setup(&ProviderSetupOptions {
                home_dir,
                agent_name: Some(agent_name.to_string()),
                ..ProviderSetupOptions::default()
            })?;
            relay_result = provider.relay_test(&ProviderRelayTestOptions {
                home_dir: options.home_dir.clone(),
                peer_alias: Some(peer_alias.to_string()),
                message: Some("hello from Clawdentity onboarding".to_string()),
                skip_preflight: false,
                ..ProviderRelayTestOptions::default()
            })?;
        }
    }

    if relay_result.status == ProviderRelayTestStatus::Failure {
        if relay_result.http_status == Some(400) {
            set_last_error(
                session,
                FAILURE_CODE_OPENCLAW_HOOK_400,
                relay_result.message,
                "Run this command again with --repair to reconcile provider setup and hook runtime."
                    .to_string(),
            );
        } else {
            set_last_error(
                session,
                FAILURE_CODE_PROVIDER_UNHEALTHY,
                relay_result.message,
                relay_result
                    .remediation_hint
                    .unwrap_or_else(|| "Run with --repair and retry.".to_string()),
            );
        }
        return Err(anyhow!("provider relay test failed"));
    }

    clear_last_error(session);
    Ok(())
}

async fn emit_pairing_saved_notification(
    config_dir: &Path,
    peer_alias: &str,
    peer_agent_name: &str,
    peer_human_name: &str,
) {
    let Ok(openclaw_base_url) = resolve_openclaw_base_url(config_dir, None) else {
        return;
    };
    let Ok(hook_token) = resolve_openclaw_hook_token(config_dir, None) else {
        return;
    };
    let Ok(mut endpoint) = reqwest::Url::parse(&openclaw_base_url) else {
        return;
    };
    endpoint.set_path("/hooks/wake");

    let message = format!(
        "Clawdentity pairing accepted: {peer_agent_name} ({peer_human_name}) is saved as {peer_alias}."
    );

    let client = reqwest::Client::new();
    let mut request = client
        .post(endpoint)
        .json(&json!({ "message": message, "text": message }));
    if let Some(token) = hook_token {
        request = request.header("x-openclaw-token", token);
    }
    let _ = request.send().await;
}

fn action_required_result(
    session: &OnboardingSession,
    message: &str,
    required_inputs: Vec<String>,
) -> OnboardingRunResult {
    OnboardingRunResult {
        status: OnboardingRunStatus::ActionRequired,
        state: session.state,
        message: message.to_string(),
        required_inputs,
        ticket: session
            .pairing
            .as_ref()
            .and_then(|pairing| pairing.ticket.clone()),
        peer_alias: session
            .pairing
            .as_ref()
            .and_then(|pairing| pairing.peer_alias.clone()),
        failure_code: session.last_error.as_ref().map(|error| error.code.clone()),
        remediation: session
            .last_error
            .as_ref()
            .map(|error| error.remediation.clone()),
    }
}

fn doctor_has_connector_failure(checks: &[ProviderDoctorCheck]) -> bool {
    checks.iter().any(|check| {
        check.status == ProviderDoctorCheckStatus::Fail
            && matches!(
                check.id.as_str(),
                "state.connectorRuntime"
                    | "state.connectorInboundInbox"
                    | "state.openclawHookHealth"
            )
    })
}

fn classify_doctor_failures(checks: &[ProviderDoctorCheck]) -> (&'static str, String) {
    for check in checks {
        if check.status != ProviderDoctorCheckStatus::Fail {
            continue;
        }

        match check.id.as_str() {
            "state.connectorRuntime"
            | "state.connectorInboundInbox"
            | "state.openclawHookHealth" => {
                return (
                    FAILURE_CODE_CONNECTOR_DOWN,
                    "Run this command with --repair to restart connector runtime and rerun health checks."
                        .to_string(),
                );
            }
            "state.peers" => {
                return (
                    FAILURE_CODE_PEER_MISSING,
                    "Run onboarding again after peer confirmation, or pass --peer-ticket to confirm pairing."
                        .to_string(),
                );
            }
            _ => {}
        }
    }

    (
        FAILURE_CODE_PROVIDER_UNHEALTHY,
        "Resolve provider doctor failures, then rerun onboarding with --repair.".to_string(),
    )
}

fn classify_onboarding_error(error: &anyhow::Error) -> (&'static str, &'static str) {
    let message = error.to_string();
    if message.contains("connector startup blocked for agent") {
        return (
            FAILURE_CODE_AGENT_OWNERSHIP_MISMATCH,
            "Run onboarding with the correct --agent-name for this container/user.",
        );
    }
    if message.contains("missing required") {
        return (
            FAILURE_CODE_MISSING_REQUIRED_INPUT,
            "Provide the missing inputs and rerun the same onboarding command.",
        );
    }
    (
        FAILURE_CODE_PROVIDER_UNHEALTHY,
        "Run onboarding with --repair and follow remediation output.",
    )
}

fn set_last_error(
    session: &mut OnboardingSession,
    code: impl Into<String>,
    message: impl Into<String>,
    remediation: impl Into<String>,
) {
    session.last_error = Some(OnboardingFailure {
        code: code.into(),
        message: message.into(),
        remediation: remediation.into(),
        at: clawdentity_core::now_iso(),
    });
}

fn clear_last_error(session: &mut OnboardingSession) {
    session.last_error = None;
}

fn format_state_for_display(state: OnboardingState) -> &'static str {
    match state {
        OnboardingState::CliReady => "cli_ready",
        OnboardingState::IdentityReady => "identity_ready",
        OnboardingState::ProviderReady => "provider_ready",
        OnboardingState::PairingPending => "pairing_pending",
        OnboardingState::Paired => "paired",
        OnboardingState::MessagingReady => "messaging_ready",
    }
}

fn format_pairing_phase_for_display(phase: PairingProgressState) -> &'static str {
    match phase {
        PairingProgressState::WaitingForConfirm => "waiting_for_confirm",
        PairingProgressState::ConfirmReceived => "confirm_received",
        PairingProgressState::PeerSaved => "peer_saved",
    }
}

fn normalize_non_empty(value: Option<&str>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn collect_missing_identity_inputs(
    config: &CliConfig,
    input: &OnboardingRunInput,
    session: &OnboardingSession,
) -> Vec<String> {
    let mut required_inputs = Vec::new();
    if config.api_key.is_none() && normalize_non_empty(input.onboarding_code.as_deref()).is_none() {
        required_inputs.push("onboarding_code".to_string());
    }

    let display_name = normalize_non_empty(input.display_name.as_deref())
        .or_else(|| session.display_name.clone())
        .or_else(|| normalize_non_empty(config.human_name.as_deref()));
    if display_name.is_none() {
        required_inputs.push("display_name".to_string());
    }

    let agent_name = normalize_non_empty(input.agent_name.as_deref()).or_else(|| {
        session
            .agent_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    });
    if agent_name.is_none() {
        required_inputs.push("agent_name".to_string());
    }

    required_inputs
}

fn onboarding_session_path(options: &ConfigPathOptions) -> Result<PathBuf> {
    Ok(get_config_root_dir(options)?.join(ONBOARDING_SESSION_FILE_NAME))
}

fn load_onboarding_session(options: &ConfigPathOptions) -> Result<OnboardingSession> {
    let path = onboarding_session_path(options)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(OnboardingSession::default());
        }
        Err(source) => {
            return Err(CoreError::Io {
                path: path.clone(),
                source,
            }
            .into());
        }
    };

    if raw.trim().is_empty() {
        return Ok(OnboardingSession::default());
    }

    serde_json::from_str(&raw)
        .with_context(|| format!("failed to parse onboarding session at {}", path.display()))
}

fn save_onboarding_session(options: &ConfigPathOptions, session: &OnboardingSession) -> Result<()> {
    let path = onboarding_session_path(options)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "failed to create onboarding session directory {}",
                parent.display()
            )
        })?;
    }
    let payload = format!("{}\n", serde_json::to_string_pretty(session)?);
    fs::write(&path, payload)
        .with_context(|| format!("failed to write onboarding session {}", path.display()))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = fs::Permissions::from_mode(0o600);
        fs::set_permissions(&path, permissions)
            .with_context(|| format!("failed to secure onboarding session {}", path.display()))?;
    }
    Ok(())
}

fn reset_onboarding_session(options: &ConfigPathOptions) -> Result<()> {
    let path = onboarding_session_path(options)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(source) => Err(CoreError::Io { path, source }.into()),
    }
}

async fn run_blocking<F, T>(operation: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| anyhow!("blocking task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{
        FAILURE_CODE_CONNECTOR_DOWN, OnboardingRunInput, OnboardingSession, OnboardingState,
        classify_doctor_failures, collect_missing_identity_inputs, onboarding_session_path,
        save_onboarding_session,
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
        let checks = vec![ProviderDoctorCheck {
            id: "state.connectorRuntime".to_string(),
            label: "Connector runtime".to_string(),
            status: ProviderDoctorCheckStatus::Fail,
            message: "connector runtime is down".to_string(),
            remediation_hint: None,
            details: None,
        }];

        let (code, _) = classify_doctor_failures(&checks);
        assert_eq!(code, FAILURE_CODE_CONNECTOR_DOWN);
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
}
