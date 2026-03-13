use std::path::PathBuf;

use clap::Subcommand;

pub mod connector;
pub mod install;
pub mod pair;
pub mod provider;
pub mod verify;

use crate::commands::connector::ConnectorCommand;
use crate::commands::pair::PairCommand;

#[derive(Debug, Subcommand)]
pub enum Commands {
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
    Pair {
        #[command(subcommand)]
        command: PairCommand,
    },
    Provider {
        #[command(subcommand)]
        command: ProviderCommand,
    },
    Install {
        /// Target platform (auto-detect if not specified)
        #[arg(long = "for", alias = "platform")]
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
    Verify {
        token_or_file: String,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
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
pub enum AgentCommand {
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
pub enum AgentAuthCommand {
    Refresh { name: String },
    Revoke { name: String },
}

#[derive(Debug, Subcommand)]
pub enum ApiKeyCommand {
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
pub enum InviteCommand {
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
pub enum AdminCommand {
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
pub enum ProviderCommand {
    Doctor {
        #[arg(long = "for")]
        platform: Option<String>,
        #[arg(long)]
        peer: Option<String>,
        #[arg(long)]
        platform_state_dir: Option<PathBuf>,
        #[arg(long)]
        connector_base_url: Option<String>,
        #[arg(long)]
        skip_connector_runtime: bool,
    },
    Setup {
        #[arg(long = "for")]
        platform: Option<String>,
        #[arg(long)]
        agent_name: Option<String>,
        #[arg(long)]
        platform_base_url: Option<String>,
        #[arg(long)]
        webhook_host: Option<String>,
        #[arg(long)]
        webhook_port: Option<u16>,
        #[arg(long)]
        webhook_token: Option<String>,
        #[arg(long)]
        connector_base_url: Option<String>,
        #[arg(long)]
        connector_url: Option<String>,
        #[arg(long)]
        relay_transform_peers_path: Option<String>,
    },
    RelayTest {
        #[arg(long = "for")]
        platform: Option<String>,
        #[arg(long)]
        peer: Option<String>,
        #[arg(long)]
        platform_state_dir: Option<PathBuf>,
        #[arg(long)]
        platform_base_url: Option<String>,
        #[arg(long)]
        webhook_token: Option<String>,
        #[arg(long)]
        connector_base_url: Option<String>,
        #[arg(long)]
        message: Option<String>,
        #[arg(long)]
        session_id: Option<String>,
        #[arg(long)]
        no_preflight: bool,
    },
    Status {
        #[arg(long = "for")]
        platform: Option<String>,
    },
}
