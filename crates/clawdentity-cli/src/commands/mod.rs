use clap::Subcommand;

pub mod connector;
pub mod group;
pub mod pair;
pub mod peer;
pub mod verify;

use crate::commands::connector::ConnectorCommand;
use crate::commands::group::GroupCommand;
use crate::commands::pair::PairCommand;
use crate::commands::peer::PeerCommand;

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
    Peer {
        #[command(subcommand)]
        command: PeerCommand,
    },
    Group {
        #[command(subcommand)]
        command: GroupCommand,
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
