mod commands;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, anyhow};
use clap::{CommandFactory, Parser};
use clawdentity_core::{
    AdminBootstrapInput, ApiKeyCreateInput, ApiKeyListInput, ApiKeyRevokeInput, CliConfig,
    ConfigKey, ConfigPathOptions, CreateAgentInput, InviteCreateInput, InviteRedeemInput,
    OpenclawRelayWebsocketTestOptions, ProviderDoctorOptions, ProviderDoctorStatus,
    ProviderRelayTestOptions, ProviderRelayTestStatus, ProviderSetupOptions, RelayCheckStatus,
    SqliteStore, all_providers, bootstrap_admin, create_agent, create_api_key, create_invite,
    detect_platform, fetch_registry_metadata, get_config_dir, get_config_file_path,
    get_config_value, get_provider, init_identity, inspect_agent, list_api_keys,
    persist_bootstrap_config, persist_redeem_config, read_config, read_identity, redeem_invite,
    refresh_agent_auth, register_identity, resolve_config, revoke_agent_auth, revoke_api_key,
    run_openclaw_relay_websocket_test, set_config_value, write_config,
};

use crate::commands::connector::execute_connector_command;
use crate::commands::install::execute_install_command;
use crate::commands::provider::execute_provider_command;
use crate::commands::{
    AdminCommand, AgentAuthCommand, AgentCommand, ApiKeyCommand, Commands, ConfigCommand,
    InviteCommand, OpenclawCommand,
};

#[derive(Debug, Parser)]
#[command(name = "clawdentity", about = "Clawdentity CLI", version)]
struct Cli {
    #[arg(long, global = true)]
    json: bool,
    #[arg(long, global = true)]
    home_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Option<Commands>,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();
    run(cli).await
}

async fn run(cli: Cli) -> Result<()> {
    let options = ConfigPathOptions {
        home_dir: cli.home_dir.clone(),
        registry_url_hint: None,
    };

    match cli.command {
        Some(Commands::Init { registry_url }) => {
            let identity = init_identity(&options, registry_url)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&identity.public_view())?);
            } else {
                println!("Initialized identity");
                println!("DID: {}", identity.did);
                println!("Public Key: {}", identity.public_key);
                println!("Registry URL: {}", identity.registry_url);
            }
        }
        Some(Commands::Whoami) => {
            let config = resolve_config(&options)?;
            let state_options = options.with_registry_hint(config.registry_url);
            let identity = read_identity(&state_options)?;
            if cli.json {
                println!("{}", serde_json::to_string_pretty(&identity.public_view())?);
            } else {
                println!("DID: {}", identity.did);
                println!("Public Key: {}", identity.public_key);
                println!("Registry URL: {}", identity.registry_url);
            }
        }
        Some(Commands::Register { registry_url }) => {
            let mut config = resolve_config(&options)?;
            if let Some(override_registry_url) = registry_url {
                config.registry_url = override_registry_url;
                let _ = write_config(&config, &options)?;
            }
            let state_options = options.with_registry_hint(config.registry_url.clone());
            let identity = read_identity(&state_options)?;
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()?;
            let metadata = fetch_registry_metadata(&client, &config.registry_url).await?;
            let result = register_identity(&client, &metadata.registry_url, &identity).await?;

            if cli.json {
                println!("{}", serde_json::to_string_pretty(&result)?);
            } else {
                println!("Register status: {}", result.status);
                println!("Registry URL: {}", result.registry_url);
                println!("Message: {}", result.message);
            }
        }
        Some(Commands::Agent { command }) => match command {
            AgentCommand::Create {
                name,
                framework,
                ttl_days,
            } => {
                let options_for_create = options.clone();
                let created = run_blocking(move || {
                    Ok(create_agent(
                        &options_for_create,
                        CreateAgentInput {
                            name,
                            framework,
                            ttl_days,
                        },
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&created)?);
                } else {
                    println!("Agent created: {}", created.name);
                    println!("DID: {}", created.did);
                    println!("Framework: {}", created.framework);
                    println!("Expires At: {}", created.expires_at);
                }
            }
            AgentCommand::Inspect { name } => {
                let state_options = resolve_state_options(&options)?;
                let inspect =
                    run_blocking(move || Ok(inspect_agent(&state_options, &name)?)).await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&inspect)?);
                } else {
                    println!("DID: {}", inspect.did);
                    println!("Owner: {}", inspect.owner_did);
                    println!("Expires: {}", inspect.expires_at);
                    println!("Key ID: {}", inspect.key_id);
                    println!("Public Key: {}", inspect.public_key);
                    println!("Framework: {}", inspect.framework);
                }
            }
            AgentCommand::Auth { command } => match command {
                AgentAuthCommand::Refresh { name } => {
                    let state_options = resolve_state_options(&options)?;
                    let result =
                        run_blocking(move || Ok(refresh_agent_auth(&state_options, &name)?))
                            .await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else {
                        println!("Agent auth refresh: {}", result.name);
                        println!("Status: {}", result.status);
                        println!("Message: {}", result.message);
                    }
                }
                AgentAuthCommand::Revoke { name } => {
                    let state_options = resolve_state_options(&options)?;
                    let result =
                        run_blocking(move || Ok(revoke_agent_auth(&state_options, &name)?)).await?;
                    if cli.json {
                        println!("{}", serde_json::to_string_pretty(&result)?);
                    } else {
                        println!("Agent auth revoke: {}", result.name);
                        println!("Status: {}", result.status);
                        println!("Message: {}", result.message);
                    }
                }
            },
        },
        Some(Commands::Config { command }) => match command {
            ConfigCommand::Init { registry_url } => {
                let mut config = read_config(&options)?;
                if let Some(url) = registry_url {
                    config.registry_url = url;
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
                let path = write_config(&config, &options)?;
                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "path": path,
                            "config": mask_api_key(&config)
                        }))?
                    );
                } else {
                    println!("Initialized config at {}", path.display());
                }
            }
            ConfigCommand::Set { key, value } => {
                let key = ConfigKey::parse(&key)?;
                let config = set_config_value(key, value, &options)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&mask_api_key(&config))?);
                } else {
                    println!("Set {}", key.as_str());
                }
            }
            ConfigCommand::Get { key } => {
                let key = ConfigKey::parse(&key)?;
                let value = get_config_value(key, &options)?;
                if let Some(value) = value {
                    if key == ConfigKey::ApiKey {
                        println!("********");
                    } else {
                        println!("{value}");
                    }
                } else {
                    println!("(not set)");
                }
            }
            ConfigCommand::Show => {
                let config = resolve_config(&options)?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&mask_api_key(&config))?);
                } else {
                    println!("{}", serde_json::to_string_pretty(&mask_api_key(&config))?);
                    let path = get_config_file_path(&options)?;
                    println!("Path: {}", path.display());
                }
            }
        },
        Some(Commands::ApiKey { command }) => match command {
            ApiKeyCommand::Create { name, registry_url } => {
                let options_for_create = options.clone();
                let result = run_blocking(move || {
                    Ok(create_api_key(
                        &options_for_create,
                        ApiKeyCreateInput { name, registry_url },
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("API key created");
                    println!("ID: {}", result.api_key.id);
                    println!("Name: {}", result.api_key.name);
                    println!("Status: {}", result.api_key.status);
                    println!("Created At: {}", result.api_key.created_at);
                    println!(
                        "Last Used At: {}",
                        result.api_key.last_used_at.as_deref().unwrap_or("never")
                    );
                    println!("Token (shown once):");
                    println!("{}", result.api_key.token);
                }
            }
            ApiKeyCommand::List { registry_url } => {
                let options_for_list = options.clone();
                let result = run_blocking(move || {
                    Ok(list_api_keys(
                        &options_for_list,
                        ApiKeyListInput { registry_url },
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else if result.api_keys.is_empty() {
                    println!("No API keys found.");
                } else {
                    for api_key in result.api_keys {
                        println!(
                            "{} | {} | {} | created {} | last used {}",
                            api_key.id,
                            api_key.name,
                            api_key.status,
                            api_key.created_at,
                            api_key.last_used_at.as_deref().unwrap_or("never")
                        );
                    }
                }
            }
            ApiKeyCommand::Revoke { id, registry_url } => {
                let options_for_revoke = options.clone();
                let result = run_blocking(move || {
                    Ok(revoke_api_key(
                        &options_for_revoke,
                        ApiKeyRevokeInput { id, registry_url },
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("API key revoked: {}", result.api_key_id);
                }
            }
        },
        Some(Commands::Invite { command }) => match command {
            InviteCommand::Create {
                expires_at,
                registry_url,
            } => {
                let options_for_create = options.clone();
                let result = run_blocking(move || {
                    Ok(create_invite(
                        &options_for_create,
                        InviteCreateInput {
                            expires_at,
                            registry_url,
                        },
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("Invite created");
                    println!("Code: {}", result.invite.code);
                    if let Some(id) = result.invite.id {
                        println!("ID: {id}");
                    }
                    println!(
                        "Expires At: {}",
                        result.invite.expires_at.as_deref().unwrap_or("never")
                    );
                }
            }
            InviteCommand::Redeem {
                code,
                display_name,
                api_key_name,
                registry_url,
            } => {
                let options_for_redeem = options.clone();
                let result = run_blocking(move || {
                    Ok(redeem_invite(
                        &options_for_redeem,
                        InviteRedeemInput {
                            code,
                            display_name,
                            api_key_name,
                            registry_url,
                        },
                    )?)
                })
                .await?;
                let options_for_persist = options.clone();
                let result_for_persist = result.clone();
                let _ = run_blocking(move || {
                    Ok(persist_redeem_config(
                        &options_for_persist,
                        &result_for_persist,
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("Invite redeemed");
                    println!("Human name: {}", result.human_name);
                    if let Some(api_key_name) = result.api_key_name {
                        println!("API key name: {api_key_name}");
                    }
                    println!("API key token (shown once):");
                    println!("{}", result.api_key_token);
                    println!("API key saved to local config");
                }
            }
        },
        Some(Commands::Admin { command }) => match command {
            AdminCommand::Bootstrap {
                bootstrap_secret,
                display_name,
                api_key_name,
                registry_url,
            } => {
                let options_for_bootstrap = options.clone();
                let result = run_blocking(move || {
                    Ok(bootstrap_admin(
                        &options_for_bootstrap,
                        AdminBootstrapInput {
                            bootstrap_secret,
                            display_name,
                            api_key_name,
                            registry_url,
                        },
                    )?)
                })
                .await?;
                let options_for_persist = options.clone();
                let result_for_persist = result.clone();
                let _ = run_blocking(move || {
                    Ok(persist_bootstrap_config(
                        &options_for_persist,
                        &result_for_persist,
                    )?)
                })
                .await?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("Admin bootstrap completed");
                    println!("Human DID: {}", result.human.did);
                    println!("API key name: {}", result.api_key.name);
                    println!("API key token (shown once):");
                    println!("{}", result.api_key.token);
                    println!("Internal service ID: {}", result.internal_service.id);
                    println!("Internal service name: {}", result.internal_service.name);
                    println!("API key saved to local config");
                }
            }
        },
        Some(Commands::Connector { command }) => {
            let state_options = resolve_state_options(&options)?;
            execute_connector_command(&state_options, command, cli.json).await?;
        }
        Some(Commands::Install {
            platform,
            port,
            token,
            list,
        }) => {
            execute_install_command(cli.home_dir.clone(), cli.json, platform, port, token, list)?;
        }
        Some(Commands::Provider { command }) => {
            execute_provider_command(cli.home_dir.clone(), cli.json, command)?;
        }
        Some(Commands::Openclaw { command }) => match command {
            OpenclawCommand::Setup {
                agent_name,
                openclaw_base_url,
                openclaw_hook_token,
                relay_transform_peers_path,
                connector_base_url,
            } => {
                let provider = resolve_provider_instance(Some("openclaw".to_string()))?;
                let result = provider.setup(&ProviderSetupOptions {
                    home_dir: cli.home_dir.clone(),
                    agent_name: Some(agent_name),
                    platform_base_url: openclaw_base_url,
                    webhook_host: None,
                    webhook_port: None,
                    webhook_token: openclaw_hook_token,
                    connector_base_url,
                    connector_url: None,
                    relay_transform_peers_path,
                })?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("OpenClaw setup completed");
                    for note in result.notes {
                        println!("- {note}");
                    }
                    for path in result.updated_paths {
                        println!("- updated: {path}");
                    }
                }
            }
            OpenclawCommand::Doctor {
                peer,
                openclaw_dir,
                connector_base_url,
                skip_connector_runtime,
            } => {
                let provider = resolve_provider_instance(Some("openclaw".to_string()))?;
                let result = provider.doctor(&ProviderDoctorOptions {
                    home_dir: cli.home_dir.clone(),
                    platform_state_dir: openclaw_dir,
                    selected_agent: None,
                    peer_alias: peer,
                    connector_base_url,
                    include_connector_runtime_check: !skip_connector_runtime,
                })?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Doctor status: {}",
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
            OpenclawCommand::RelayTest {
                peer,
                openclaw_dir,
                openclaw_base_url,
                hook_token,
                message,
                session_id,
                no_preflight,
            } => {
                let provider = resolve_provider_instance(Some("openclaw".to_string()))?;
                let result = provider.relay_test(&ProviderRelayTestOptions {
                    home_dir: cli.home_dir.clone(),
                    platform_state_dir: openclaw_dir,
                    peer_alias: peer,
                    platform_base_url: openclaw_base_url,
                    webhook_token: hook_token,
                    connector_base_url: None,
                    message,
                    session_id,
                    skip_preflight: no_preflight,
                })?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Relay test: {} ({})",
                        result.message,
                        match result.status {
                            ProviderRelayTestStatus::Success => "success",
                            ProviderRelayTestStatus::Failure => "failure",
                        }
                    );
                    if let Some(peer_alias) = result.peer_alias {
                        println!("Peer: {peer_alias}");
                    }
                    println!("Endpoint: {}", result.endpoint);
                    if let Some(remediation_hint) = result.remediation_hint {
                        println!("Hint: {remediation_hint}");
                    }
                }
            }
            OpenclawCommand::RelayWsTest {
                peer,
                openclaw_dir,
                connector_base_url,
                no_preflight,
            } => {
                let state_options = resolve_state_options(&options)?;
                let config_dir = get_config_dir(&state_options)?;
                let store = SqliteStore::open(&state_options)?;
                let result = run_openclaw_relay_websocket_test(
                    &config_dir,
                    &store,
                    OpenclawRelayWebsocketTestOptions {
                        home_dir: cli.home_dir.clone(),
                        openclaw_dir,
                        peer_alias: peer,
                        connector_base_url,
                        skip_preflight: no_preflight,
                    },
                )?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Relay websocket test: {} ({})",
                        result.message,
                        match result.status {
                            RelayCheckStatus::Success => "success",
                            RelayCheckStatus::Failure => "failure",
                        }
                    );
                    println!("Peer: {}", result.peer_alias);
                    println!("Status URL: {}", result.connector_status_url);
                    if let Some(remediation_hint) = result.remediation_hint {
                        println!("Hint: {remediation_hint}");
                    }
                }
            }
        },
        None => {
            let mut command = Cli::command();
            command.print_help()?;
            println!();
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
            anyhow!(
                "unknown platform `{}`. Available platforms: {}",
                platform,
                available
            )
        });
    }

    detect_platform().ok_or_else(|| {
        anyhow!("no supported platform detected. Pass `--for <platform>` to select one explicitly.")
    })
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

fn resolve_state_options(options: &ConfigPathOptions) -> Result<ConfigPathOptions> {
    let config = resolve_config(options)?;
    Ok(options.with_registry_hint(config.registry_url))
}

fn mask_api_key(config: &CliConfig) -> CliConfig {
    if config.api_key.is_none() {
        return config.clone();
    }

    CliConfig {
        registry_url: config.registry_url.clone(),
        proxy_url: config.proxy_url.clone(),
        api_key: Some("********".to_string()),
        human_name: config.human_name.clone(),
    }
}

fn init_logging() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_target(false)
        .try_init();
}

#[cfg(test)]
mod tests {
    use clap::CommandFactory;

    use super::Cli;

    #[test]
    fn clap_configuration_is_valid() {
        Cli::command().debug_assert();
    }
}
