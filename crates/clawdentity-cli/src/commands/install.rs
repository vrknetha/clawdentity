use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::{Result, anyhow};
use clawdentity_core::{
    InstallOptions, VerifyOptions, all_providers, detect_platform, get_provider,
};

#[allow(clippy::too_many_lines)]
pub(crate) fn execute_install_command(
    home_dir: Option<PathBuf>,
    json: bool,
    platform: Option<String>,
    port: Option<u16>,
    token: Option<String>,
    list: bool,
) -> Result<()> {
    if list {
        let providers = all_providers();
        if json {
            let payload = providers
                .into_iter()
                .map(|provider| {
                    let detection = provider.detect();
                    serde_json::json!({
                        "name": provider.name(),
                        "displayName": provider.display_name(),
                        "detected": detection.detected,
                        "confidence": detection.confidence,
                        "evidence": detection.evidence,
                        "defaultWebhookHost": provider.default_webhook_host(),
                        "defaultWebhookPort": provider.default_webhook_port(),
                        "configPath": provider
                            .config_path()
                            .map(|path| path.to_string_lossy().to_string()),
                    })
                })
                .collect::<Vec<_>>();
            println!("{}", serde_json::to_string_pretty(&payload)?);
        } else {
            for provider in providers {
                let detection = provider.detect();
                println!("{} ({})", provider.display_name(), provider.name(),);
                println!(
                    "  detected: {} (confidence {:.2})",
                    if detection.detected { "yes" } else { "no" },
                    detection.confidence
                );
                println!(
                    "  default webhook: {}:{}",
                    provider.default_webhook_host(),
                    provider.default_webhook_port()
                );
                if let Some(config_path) = provider.config_path() {
                    println!("  config path: {}", config_path.display());
                }
                if detection.evidence.is_empty() {
                    println!("  evidence: none");
                } else {
                    for evidence in detection.evidence {
                        println!("  evidence: {evidence}");
                    }
                }
            }
        }
        return Ok(());
    }

    let is_auto_detected = platform.is_none();

    let provider = if let Some(platform_name) = platform.as_deref() {
        get_provider(platform_name).ok_or_else(|| {
            let available = all_providers()
                .into_iter()
                .map(|provider| provider.name().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow!("unknown provider `{platform_name}`. Available providers: {available}")
        })?
    } else {
        detect_platform().ok_or_else(|| {
            anyhow!(
                "no supported provider detected. Run `clawdentity install --list` and pick one with `--for`."
            )
        })?
    };

    if is_auto_detected && !json && !confirm_install(provider.display_name(), provider.name())? {
        println!("Installation cancelled.");
        return Ok(());
    }

    let install_result = provider.install(&InstallOptions {
        home_dir: home_dir.clone(),
        webhook_port: port,
        webhook_host: None,
        webhook_token: token,
        connector_url: None,
    })?;
    let verify_result = provider.verify(&VerifyOptions {
        home_dir: home_dir.clone(),
    })?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "provider": {
                    "name": provider.name(),
                    "displayName": provider.display_name(),
                },
                "install": install_result,
                "verify": verify_result,
            }))?
        );
    } else {
        println!(
            "Installed {} ({})",
            provider.display_name(),
            provider.name()
        );
        for note in install_result.notes {
            println!("- {note}");
        }
        println!(
            "Verification: {}",
            if verify_result.healthy {
                "healthy"
            } else {
                "unhealthy"
            }
        );
        for (name, passed, detail) in verify_result.checks {
            println!(
                "- [{}] {}: {}",
                if passed { "pass" } else { "fail" },
                name,
                detail
            );
        }
    }

    if !verify_result.healthy {
        return Err(anyhow!(
            "{} ({}) verification is unhealthy; fix failed checks and rerun install",
            provider.display_name(),
            provider.name()
        ));
    }

    Ok(())
}

fn confirm_install(display_name: &str, name: &str) -> Result<bool> {
    print!("Detected platform: {display_name} ({name}). Continue install? [y/N]: ");
    io::stdout().flush()?;

    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    Ok(matches!(
        answer.trim().to_ascii_lowercase().as_str(),
        "y" | "yes"
    ))
}
