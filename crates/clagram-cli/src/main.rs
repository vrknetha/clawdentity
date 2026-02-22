use std::path::PathBuf;

use anyhow::Result;
use clagram_core::{
    CliConfig, ConfigKey, ConfigPathOptions, CreateAgentInput, create_agent,
    fetch_registry_metadata, get_config_file_path, get_config_value, init_identity, inspect_agent,
    read_config, read_identity, refresh_agent_auth, register_identity, resolve_config,
    revoke_agent_auth, set_config_value, write_config,
};
use clap::{CommandFactory, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "clagram", about = "Clagram CLI", version)]
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
            let client = reqwest::Client::new();
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
                let config = resolve_config(&options)?;
                let state_options = options.with_registry_hint(config.registry_url);
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
                    let config = resolve_config(&options)?;
                    let state_options = options.with_registry_hint(config.registry_url);
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
                    let config = resolve_config(&options)?;
                    let state_options = options.with_registry_hint(config.registry_url);
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
                let client = reqwest::Client::new();
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
        None => {
            let mut command = Cli::command();
            command.print_help()?;
            println!();
        }
    }

    Ok(())
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
