use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{Result, anyhow};
use clawdentity_core::{
    ProviderDoctorOptions, ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestStatus,
    ProviderSetupOptions, all_providers, detect_platform, get_provider,
};

use crate::commands::ProviderCommand;

#[allow(clippy::too_many_lines)]
pub(crate) fn execute_provider_command(
    home_dir: Option<PathBuf>,
    json: bool,
    command: ProviderCommand,
) -> Result<()> {
    match command {
        ProviderCommand::Doctor {
            platform,
            peer,
            platform_state_dir,
            connector_base_url,
            skip_connector_runtime,
        } => {
            let provider = resolve_provider_instance(platform)?;
            let result = provider.doctor(&ProviderDoctorOptions {
                home_dir,
                platform_state_dir,
                selected_agent: None,
                peer_alias: peer,
                connector_base_url,
                include_connector_runtime_check: !skip_connector_runtime,
            })?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!(
                    "Provider doctor [{}]: {}",
                    result.platform,
                    match result.status {
                        ProviderDoctorStatus::Healthy => "healthy",
                        ProviderDoctorStatus::Unhealthy => "unhealthy",
                    }
                );
                for check in result.checks {
                    println!("- [{}] {}: {}", check.id, check.label, check.message);
                    if let Some(remediation_hint) = check.remediation_hint {
                        println!("  fix: {remediation_hint}");
                    }
                }
            }
        }
        ProviderCommand::Setup {
            platform,
            agent_name,
            platform_base_url,
            webhook_host,
            webhook_port,
            webhook_token,
            connector_base_url,
            connector_url,
            relay_transform_peers_path,
        } => {
            let provider = resolve_provider_instance(platform)?;
            let agent_name = if let Some(agent_name) = agent_name {
                Some(agent_name)
            } else if json {
                None
            } else {
                prompt_optional("Agent name (optional for most providers): ")?
            };

            let result = provider.setup(&ProviderSetupOptions {
                home_dir,
                agent_name,
                platform_base_url,
                webhook_host,
                webhook_port,
                webhook_token,
                connector_base_url,
                connector_url,
                relay_transform_peers_path,
            })?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("Provider setup completed: {}", result.platform);
                for note in result.notes {
                    println!("- {note}");
                }
                for path in result.updated_paths {
                    println!("- updated: {path}");
                }
            }
        }
        ProviderCommand::RelayTest {
            platform,
            peer,
            platform_state_dir,
            platform_base_url,
            webhook_token,
            connector_base_url,
            message,
            session_id,
            no_preflight,
        } => {
            let provider = resolve_provider_instance(platform)?;
            let result = provider.relay_test(&ProviderRelayTestOptions {
                home_dir,
                platform_state_dir,
                peer_alias: peer,
                platform_base_url,
                webhook_token,
                connector_base_url,
                message,
                session_id,
                skip_preflight: no_preflight,
            })?;
            if json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!(
                    "Provider relay-test [{}]: {} ({})",
                    result.platform,
                    result.message,
                    match result.status {
                        ProviderRelayTestStatus::Success => "success",
                        ProviderRelayTestStatus::Failure => "failure",
                    }
                );
                println!("Endpoint: {}", result.endpoint);
                if let Some(peer_alias) = result.peer_alias {
                    println!("Peer: {peer_alias}");
                }
                if let Some(http_status) = result.http_status {
                    println!("HTTP: {http_status}");
                }
                if let Some(remediation_hint) = result.remediation_hint {
                    println!("Hint: {remediation_hint}");
                }
            }
        }
        ProviderCommand::Status { platform } => {
            if let Some(platform) = platform {
                let provider = get_provider(&platform).ok_or_else(|| {
                    let available = all_providers()
                        .into_iter()
                        .map(|provider| provider.name().to_string())
                        .collect::<Vec<_>>()
                        .join(", ");
                    anyhow!("unknown platform `{platform}`. Available: {available}")
                })?;
                let detection = provider.detect();
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "requestedPlatform": provider.name(),
                            "displayName": provider.display_name(),
                            "detected": detection.detected,
                            "confidence": detection.confidence,
                            "evidence": detection.evidence,
                            "defaultWebhookHost": provider.default_webhook_host(),
                            "defaultWebhookPort": provider.default_webhook_port(),
                            "configPath": provider.config_path().map(|path| path.to_string_lossy().to_string()),
                        }))?
                    );
                } else {
                    println!(
                        "Provider: {} ({})",
                        provider.display_name(),
                        provider.name()
                    );
                    println!(
                        "Detected: {} (confidence {:.2})",
                        if detection.detected { "yes" } else { "no" },
                        detection.confidence
                    );
                    println!(
                        "Default webhook: {}:{}",
                        provider.default_webhook_host(),
                        provider.default_webhook_port()
                    );
                    if let Some(config_path) = provider.config_path() {
                        println!("Config path: {}", config_path.display());
                    }
                    if detection.evidence.is_empty() {
                        println!("Evidence: none");
                    } else {
                        for evidence in detection.evidence {
                            println!("Evidence: {evidence}");
                        }
                    }
                }
            } else if let Some(provider) = detect_platform() {
                let detection = provider.detect();
                if json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "detectedPlatform": provider.name(),
                            "displayName": provider.display_name(),
                            "confidence": detection.confidence,
                            "evidence": detection.evidence,
                            "defaultWebhookHost": provider.default_webhook_host(),
                            "defaultWebhookPort": provider.default_webhook_port(),
                            "configPath": provider.config_path().map(|path| path.to_string_lossy().to_string()),
                        }))?
                    );
                } else {
                    println!(
                        "Detected platform: {} ({})",
                        provider.display_name(),
                        provider.name()
                    );
                    println!("Confidence: {:.2}", detection.confidence);
                    for evidence in detection.evidence {
                        println!("- {evidence}");
                    }
                }
            } else if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "detectedPlatform": serde_json::Value::Null,
                        "message": "no supported platform detected",
                    }))?
                );
            } else {
                println!("No supported platform detected.");
            }
        }
    }

    Ok(())
}

fn resolve_provider_instance(
    platform: Option<String>,
) -> Result<Box<dyn clawdentity_core::PlatformProvider>> {
    if let Some(platform) = platform {
        return get_provider(&platform).ok_or_else(|| {
            let available = all_providers()
                .into_iter()
                .map(|provider| provider.name().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow!("unknown platform `{platform}`. Available platforms: {available}")
        });
    }

    detect_platform().ok_or_else(|| {
        anyhow!("no supported platform detected. Pass `--for <platform>` to select one explicitly.")
    })
}

fn prompt_optional(prompt: &str) -> Result<Option<String>> {
    print!("{prompt}");
    io::stdout().flush()?;
    let mut input = String::new();
    io::stdin().read_line(&mut input)?;
    let value = input.trim().to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}
