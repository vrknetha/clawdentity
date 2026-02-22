use std::path::PathBuf;

use clap::Subcommand;

pub mod connector;
pub mod install;

use crate::commands::connector::ConnectorCommand;

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
    Refresh {
        name: String,
    },
    Revoke {
        name: String,
    },
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
pub enum OpenclawCommand {
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
