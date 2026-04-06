use super::*;

pub(super) async fn ensure_config_ready(options: &ConfigPathOptions) -> Result<CliConfig> {
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

#[allow(clippy::too_many_lines)]
pub(super) async fn ensure_identity_ready(
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

#[allow(clippy::too_many_lines)]
pub(super) async fn ensure_provider_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    agent_name: &str,
) -> Result<()> {
    let home_dir = options.home_dir.clone();
    let platform = input.platform.clone();
    let agent_name = agent_name.to_string();
    let repair = input.repair;

    let (setup_status, doctor_result) = run_blocking(move || {
        let provider =
            get_provider(&platform).ok_or_else(|| anyhow!("unknown provider `{platform}`"))?;
        let setup_result = provider.setup(&ProviderSetupOptions {
            home_dir: home_dir.clone(),
            agent_name: Some(agent_name.clone()),
            ..ProviderSetupOptions::default()
        })?;

        let mut doctor_result = provider.doctor(&ProviderDoctorOptions {
            home_dir: home_dir.clone(),
            selected_agent: Some(agent_name.clone()),
            include_connector_runtime_check: true,
            ..ProviderDoctorOptions::default()
        })?;

        if doctor_result.status == ProviderDoctorStatus::Unhealthy
            && repair
            && doctor_has_connector_failure(&doctor_result.checks)
        {
            let _ = provider.setup(&ProviderSetupOptions {
                home_dir: home_dir.clone(),
                agent_name: Some(agent_name.clone()),
                ..ProviderSetupOptions::default()
            })?;
            doctor_result = provider.doctor(&ProviderDoctorOptions {
                home_dir,
                selected_agent: Some(agent_name),
                include_connector_runtime_check: true,
                ..ProviderDoctorOptions::default()
            })?;
        }

        Ok((setup_result.status, doctor_result))
    })
    .await?;

    if setup_status == ProviderSetupStatus::ActionRequired && !input.repair {
        set_last_error(
            session,
            FAILURE_CODE_CONNECTOR_DOWN,
            "provider setup requires additional action".to_string(),
            "Re-run with --repair to auto-recover connector runtime.".to_string(),
        );
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

#[allow(clippy::too_many_lines)]
pub(super) async fn ensure_pairing_ready(
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

    Ok(None)
}

#[allow(clippy::too_many_lines)]
pub(super) async fn ensure_messaging_ready(
    options: &ConfigPathOptions,
    input: &OnboardingRunInput,
    session: &mut OnboardingSession,
    agent_name: &str,
    peer_alias: &str,
) -> Result<()> {
    let home_dir = options.home_dir.clone();
    let platform = input.platform.clone();
    let agent_name = agent_name.to_string();
    let peer_alias = peer_alias.to_string();
    let repair = input.repair;

    let (doctor_result, relay_result) = run_blocking(move || {
        let provider =
            get_provider(&platform).ok_or_else(|| anyhow!("unknown provider `{platform}`"))?;

        let mut doctor_result = provider.doctor(&ProviderDoctorOptions {
            home_dir: home_dir.clone(),
            selected_agent: Some(agent_name.clone()),
            peer_alias: Some(peer_alias.clone()),
            include_connector_runtime_check: true,
            ..ProviderDoctorOptions::default()
        })?;

        if doctor_result.status == ProviderDoctorStatus::Unhealthy
            && repair
            && doctor_has_connector_failure(&doctor_result.checks)
        {
            let _ = provider.setup(&ProviderSetupOptions {
                home_dir: home_dir.clone(),
                agent_name: Some(agent_name.clone()),
                ..ProviderSetupOptions::default()
            })?;
            doctor_result = provider.doctor(&ProviderDoctorOptions {
                home_dir: home_dir.clone(),
                selected_agent: Some(agent_name.clone()),
                peer_alias: Some(peer_alias.clone()),
                include_connector_runtime_check: true,
                ..ProviderDoctorOptions::default()
            })?;
        }

        if doctor_result.status == ProviderDoctorStatus::Unhealthy {
            return Ok((doctor_result, None));
        }

        let mut relay_result = provider.relay_test(&ProviderRelayTestOptions {
            home_dir: home_dir.clone(),
            peer_alias: Some(peer_alias.clone()),
            message: Some("hello from Clawdentity onboarding".to_string()),
            skip_preflight: false,
            ..ProviderRelayTestOptions::default()
        })?;

        if relay_result.status == ProviderRelayTestStatus::Failure && repair {
            let is_hook_400 = relay_result.http_status == Some(400);
            if is_hook_400 {
                let _ = provider.setup(&ProviderSetupOptions {
                    home_dir: home_dir.clone(),
                    agent_name: Some(agent_name.clone()),
                    ..ProviderSetupOptions::default()
                })?;
                relay_result = provider.relay_test(&ProviderRelayTestOptions {
                    home_dir,
                    peer_alias: Some(peer_alias),
                    message: Some("hello from Clawdentity onboarding".to_string()),
                    skip_preflight: false,
                    ..ProviderRelayTestOptions::default()
                })?;
            }
        }

        Ok((doctor_result, Some(relay_result)))
    })
    .await?;

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

    let relay_result =
        relay_result.ok_or_else(|| anyhow!("provider relay test result was not produced"))?;

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

pub(super) async fn emit_pairing_saved_notification(
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
    endpoint.set_path("/hooks/agent");

    let message = format!(
        "Clawdentity pairing accepted: {peer_agent_name} ({peer_human_name}) is saved as {peer_alias}."
    );

    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(PAIRING_NOTIFICATION_TIMEOUT_SECONDS))
        .build()
    else {
        return;
    };
    let mut request = client
        .post(endpoint)
        .json(&json!({ "message": message, "content": message }));
    if let Some(token) = hook_token {
        request = request.header("x-openclaw-token", token);
    }
    let _ = request.send().await;
}
