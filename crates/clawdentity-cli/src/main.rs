mod commands;

use std::io::{self, Write};
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, anyhow};
use clap::{CommandFactory, Parser, Subcommand};
use clawdentity_core::{
    AdminBootstrapInput, ApiKeyCreateInput, ApiKeyListInput, ApiKeyRevokeInput, CliConfig,
    ConfigKey, ConfigPathOptions, CreateAgentInput, InstallOptions, InviteCreateInput,
    InviteRedeemInput, OpenclawDoctorOptions, OpenclawRelayRuntimeConfig, OpenclawRelayTestOptions,
    OpenclawRelayWebsocketTestOptions, RelayCheckStatus, SqliteStore, all_providers,
    bootstrap_admin, create_agent, create_api_key, create_invite, detect_platform,
    fetch_registry_metadata, get_config_dir, get_config_file_path, get_config_value, get_provider,
    init_identity, inspect_agent, list_api_keys, persist_bootstrap_config, persist_redeem_config,
    read_config, read_identity, redeem_invite, refresh_agent_auth, register_identity,
    resolve_config, revoke_agent_auth, revoke_api_key, run_openclaw_doctor,
    run_openclaw_relay_test, run_openclaw_relay_websocket_test, save_connector_assignment,
    save_relay_runtime_config, set_config_value, write_config, write_selected_openclaw_agent,
};

use crate::commands::connector::{ConnectorCommand, execute_connector_command};

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

#[derive(Debug, Subcommand)]
enum Commands {
    Init {
        #[arg(long)]
        registry_url: Option<String>,
    },
    Whoami,
    Register {
        #[arg(long)]
        registry_url: Option<String>,
    },
    Agent {
        #[command(subcommand)]
        command: AgentCommand,
    },
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    ApiKey {
        #[command(subcommand)]
        command: ApiKeyCommand,
    },
    Invite {
        #[command(subcommand)]
        command: InviteCommand,
    },
    Admin {
        #[command(subcommand)]
        command: AdminCommand,
    },
    Connector {
        #[command(subcommand)]
        command: ConnectorCommand,
    },
    Openclaw {
        #[command(subcommand)]
        command: OpenclawCommand,
    },
    Install {
        /// Target platform (auto-detect if not specified)
        #[arg(long, alias = "for")]
        platform: Option<String>,
        /// Webhook port override
        #[arg(long)]
        port: Option<u16>,
        /// Webhook auth token
        #[arg(long)]
        token: Option<String>,
        /// List available platforms
        #[arg(long)]
        list: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ConfigCommand {
    Init {
        #[arg(long)]
        registry_url: Option<String>,
    },
    Set {
        key: String,
        value: String,
    },
    Get {
        key: String,
    },
    Show,
}

#[derive(Debug, Subcommand)]
enum AgentCommand {
    Create {
        name: String,
        #[arg(long)]
        framework: Option<String>,
        #[arg(long)]
        ttl_days: Option<u32>,
    },
    Inspect {
        name: String,
    },
    Auth {
        #[command(subcommand)]
        command: AgentAuthCommand,
    },
}

#[derive(Debug, Subcommand)]
enum AgentAuthCommand {
    Refresh { name: String },
    Revoke { name: String },
}

#[derive(Debug, Subcommand)]
enum ApiKeyCommand {
    Create {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        registry_url: Option<String>,
    },
    List {
        #[arg(long)]
        registry_url: Option<String>,
    },
    Revoke {
        id: String,
        #[arg(long)]
        registry_url: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum InviteCommand {
    Create {
        #[arg(long)]
        expires_at: Option<String>,
        #[arg(long)]
        registry_url: Option<String>,
    },
    Redeem {
        code: String,
        #[arg(long)]
        display_name: String,
        #[arg(long)]
        api_key_name: Option<String>,
        #[arg(long)]
        registry_url: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum AdminCommand {
    Bootstrap {
        #[arg(long)]
        bootstrap_secret: String,
        #[arg(long)]
        display_name: Option<String>,
        #[arg(long)]
        api_key_name: Option<String>,
        #[arg(long)]
        registry_url: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
enum OpenclawCommand {
    Setup {
        agent_name: String,
        #[arg(long)]
        openclaw_base_url: Option<String>,
        #[arg(long)]
        openclaw_hook_token: Option<String>,
        #[arg(long)]
        relay_transform_peers_path: Option<String>,
        #[arg(long)]
        connector_base_url: Option<String>,
    },
    Doctor {
        #[arg(long)]
        peer: Option<String>,
        #[arg(long)]
        openclaw_dir: Option<PathBuf>,
        #[arg(long)]
        connector_base_url: Option<String>,
        #[arg(long)]
        skip_connector_runtime: bool,
    },
    RelayTest {
        #[arg(long)]
        peer: Option<String>,
        #[arg(long)]
        openclaw_dir: Option<PathBuf>,
        #[arg(long)]
        openclaw_base_url: Option<String>,
        #[arg(long)]
        hook_token: Option<String>,
        #[arg(long)]
        message: Option<String>,
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long)]
        no_preflight: bool,
    },
    RelayWsTest {
        #[arg(long)]
        peer: Option<String>,
        #[arg(long)]
        openclaw_dir: Option<PathBuf>,
        #[arg(long)]
        connector_base_url: Option<String>,
        #[arg(long)]
        no_preflight: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    init_logging();
    let cli = Cli::parse();
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
                let created = create_agent(
                    &options,
                    CreateAgentInput {
                        name,
                        framework,
                        ttl_days,
                    },
                )?;
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
                let inspect = inspect_agent(&state_options, &name)?;
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
                    let result = refresh_agent_auth(&state_options, &name)?;
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
                    let result = revoke_agent_auth(&state_options, &name)?;
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
                let result = create_api_key(&options, ApiKeyCreateInput { name, registry_url })?;
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
                let result = list_api_keys(&options, ApiKeyListInput { registry_url })?;
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
                let result = revoke_api_key(&options, ApiKeyRevokeInput { id, registry_url })?;
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
                let result = create_invite(
                    &options,
                    InviteCreateInput {
                        expires_at,
                        registry_url,
                    },
                )?;
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
                let result = redeem_invite(
                    &options,
                    InviteRedeemInput {
                        code,
                        display_name,
                        api_key_name,
                        registry_url,
                    },
                )?;
                let _ = persist_redeem_config(&options, &result)?;
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
                let result = bootstrap_admin(
                    &options,
                    AdminBootstrapInput {
                        bootstrap_secret,
                        display_name,
                        api_key_name,
                        registry_url,
                    },
                )?;
                let _ = persist_bootstrap_config(&options, &result)?;
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
            execute_connector_command(&state_options, command, cli.json)?;
        }
        Some(Commands::Install {
            platform,
            port,
            token,
            list,
        }) => {
            execute_install_command(cli.home_dir.clone(), cli.json, platform, port, token, list)?;
        }
        Some(Commands::Openclaw { command }) => match command {
            OpenclawCommand::Setup {
                agent_name,
                openclaw_base_url,
                openclaw_hook_token,
                relay_transform_peers_path,
                connector_base_url,
            } => {
                let state_options = resolve_state_options(&options)?;
                let config_dir = get_config_dir(&state_options)?;
                let marker_path = write_selected_openclaw_agent(&config_dir, &agent_name)?;
                let resolved_base_url = clawdentity_core::resolve_openclaw_base_url(
                    &config_dir,
                    openclaw_base_url.as_deref(),
                )?;
                let existing_runtime = clawdentity_core::load_relay_runtime_config(&config_dir)?;
                let runtime_path = save_relay_runtime_config(
                    &config_dir,
                    OpenclawRelayRuntimeConfig {
                        openclaw_base_url: resolved_base_url,
                        openclaw_hook_token: openclaw_hook_token.or_else(|| {
                            existing_runtime
                                .as_ref()
                                .and_then(|cfg| cfg.openclaw_hook_token.clone())
                        }),
                        relay_transform_peers_path: relay_transform_peers_path.or_else(|| {
                            existing_runtime
                                .as_ref()
                                .and_then(|cfg| cfg.relay_transform_peers_path.clone())
                        }),
                        updated_at: None,
                    },
                )?;

                let connector_assignment_path = if let Some(base_url) = connector_base_url {
                    Some(save_connector_assignment(
                        &config_dir,
                        &agent_name,
                        &base_url,
                    )?)
                } else {
                    None
                };

                if cli.json {
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&serde_json::json!({
                            "agentNamePath": marker_path,
                            "runtimeConfigPath": runtime_path,
                            "connectorAssignmentPath": connector_assignment_path,
                        }))?
                    );
                } else {
                    println!("OpenClaw setup state updated");
                    println!("Selected agent marker: {}", marker_path.display());
                    println!("Relay runtime config: {}", runtime_path.display());
                    if let Some(path) = connector_assignment_path {
                        println!("Connector assignment: {}", path.display());
                    }
                }
            }
            OpenclawCommand::Doctor {
                peer,
                openclaw_dir,
                connector_base_url,
                skip_connector_runtime,
            } => {
                let state_options = resolve_state_options(&options)?;
                let config_dir = get_config_dir(&state_options)?;
                let store = SqliteStore::open(&state_options)?;
                let result = run_openclaw_doctor(
                    &config_dir,
                    &store,
                    OpenclawDoctorOptions {
                        home_dir: cli.home_dir.clone(),
                        openclaw_dir,
                        peer_alias: peer,
                        connector_base_url,
                        include_connector_runtime_check: !skip_connector_runtime,
                        ..OpenclawDoctorOptions::default()
                    },
                )?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!("Doctor status: {:?}", result.status);
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
                let state_options = resolve_state_options(&options)?;
                let config_dir = get_config_dir(&state_options)?;
                let store = SqliteStore::open(&state_options)?;
                let result = run_openclaw_relay_test(
                    &config_dir,
                    &store,
                    OpenclawRelayTestOptions {
                        home_dir: cli.home_dir.clone(),
                        openclaw_dir,
                        peer_alias: peer,
                        openclaw_base_url,
                        hook_token,
                        message,
                        session_id,
                        skip_preflight: no_preflight,
                    },
                )?;
                if cli.json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Relay test: {} ({})",
                        result.message,
                        match result.status {
                            RelayCheckStatus::Success => "success",
                            RelayCheckStatus::Failure => "failure",
                        }
                    );
                    println!("Peer: {}", result.peer_alias);
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

fn execute_install_command(
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
            anyhow!(
                "unknown platform `{}`. Available platforms: {}",
                platform_name,
                available
            )
        })?
    } else {
        detect_platform().ok_or_else(|| {
            anyhow!(
                "no supported platform detected. Run `clawdentity install --list` and pick one with `--for`."
            )
        })?
    };

    if is_auto_detected && !json && !confirm_install(provider.display_name(), provider.name())? {
        println!("Installation cancelled.");
        return Ok(());
    }

    let install_result = provider.install(&InstallOptions {
        home_dir,
        webhook_port: port,
        webhook_host: None,
        webhook_token: token,
        connector_url: None,
    })?;
    let verify_result = provider.verify()?;

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
