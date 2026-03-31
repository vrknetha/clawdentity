use anyhow::Result;
use clap::{Subcommand, ValueEnum};
use clawdentity_core::{
    ConfigPathOptions, GroupCreateInput, GroupInspectInput, GroupJoinInput,
    GroupJoinTokenCreateInput, GroupMembersListInput, GroupRole, create_group,
    create_group_join_token, inspect_group, join_group, list_group_members,
};

#[derive(Debug, Subcommand)]
pub enum GroupCommand {
    Create {
        name: String,
        #[arg(long)]
        agent_name: String,
    },
    Inspect {
        group_id: String,
        #[arg(long)]
        agent_name: String,
    },
    JoinToken {
        #[command(subcommand)]
        command: GroupJoinTokenCommand,
    },
    Join {
        group_join_token: String,
        #[arg(long)]
        agent_name: String,
    },
    Members {
        #[command(subcommand)]
        command: GroupMembersCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum GroupJoinTokenCommand {
    Create {
        group_id: String,
        #[arg(long)]
        agent_name: String,
        #[arg(long)]
        role: Option<CliGroupRole>,
        #[arg(long)]
        expires_in_seconds: Option<u32>,
        #[arg(long)]
        max_uses: Option<u32>,
    },
}

#[derive(Debug, Subcommand)]
pub enum GroupMembersCommand {
    List {
        group_id: String,
        #[arg(long)]
        agent_name: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum CliGroupRole {
    Member,
    Admin,
}

impl From<CliGroupRole> for GroupRole {
    fn from(value: CliGroupRole) -> Self {
        match value {
            CliGroupRole::Member => Self::Member,
            CliGroupRole::Admin => Self::Admin,
        }
    }
}

fn role_label(role: GroupRole) -> &'static str {
    match role {
        GroupRole::Member => "member",
        GroupRole::Admin => "admin",
    }
}

fn print_json_or_human<T>(json: bool, value: &T, render_human: impl FnOnce(&T)) -> Result<()>
where
    T: serde::Serialize,
{
    if json {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        render_human(value);
    }
    Ok(())
}

async fn execute_group_create(
    options: &ConfigPathOptions,
    name: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = create_group(options, GroupCreateInput { agent_name, name })
        .await
        .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Group created");
        println!("ID: {}", value.group.id);
        println!("Name: {}", value.group.name);
    })
}

async fn execute_group_inspect(
    options: &ConfigPathOptions,
    group_id: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = inspect_group(
        options,
        GroupInspectInput {
            agent_name,
            group_id,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Group");
        println!("ID: {}", value.group.id);
        println!("Name: {}", value.group.name);
    })
}

async fn execute_group_join_token_create(
    options: &ConfigPathOptions,
    input: GroupJoinTokenCommand,
    json: bool,
) -> Result<()> {
    let GroupJoinTokenCommand::Create {
        group_id,
        agent_name,
        role,
        expires_in_seconds,
        max_uses,
    } = input;

    let result = create_group_join_token(
        options,
        GroupJoinTokenCreateInput {
            agent_name,
            group_id,
            role: role.map(GroupRole::from),
            expires_in_seconds,
            max_uses,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Group join token created");
        println!("Token: {}", value.group_join_token.token);
        println!("Group ID: {}", value.group_join_token.group_id);
        println!("Role: {}", role_label(value.group_join_token.role));
        println!("Max Uses: {}", value.group_join_token.max_uses);
        println!("Expires At: {}", value.group_join_token.expires_at);
    })
}

async fn execute_group_join(
    options: &ConfigPathOptions,
    group_join_token: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = join_group(
        options,
        GroupJoinInput {
            agent_name,
            group_join_token,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        if value.joined {
            println!("Group joined");
        } else {
            println!("Agent is already in the group");
        }
        println!("Group ID: {}", value.group_id);
        println!("Agent DID: {}", value.agent_did);
        println!("Role: {}", role_label(value.role));
    })
}

async fn execute_group_members(
    options: &ConfigPathOptions,
    input: GroupMembersCommand,
    json: bool,
) -> Result<()> {
    let GroupMembersCommand::List {
        group_id,
        agent_name,
    } = input;
    let result = list_group_members(
        options,
        GroupMembersListInput {
            agent_name,
            group_id,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Group members");
        println!("Group ID: {}", value.group.id);
        if value.members.is_empty() {
            println!("- none");
        }
        for member in &value.members {
            println!("- {} ({})", member.agent_did, role_label(member.role));
        }
    })
}

/// TODO(clawdentity): document `execute_group_command`.
pub async fn execute_group_command(
    options: &ConfigPathOptions,
    command: GroupCommand,
    json: bool,
) -> Result<()> {
    match command {
        GroupCommand::Create { name, agent_name } => {
            execute_group_create(options, name, agent_name, json).await
        }
        GroupCommand::Inspect {
            group_id,
            agent_name,
        } => execute_group_inspect(options, group_id, agent_name, json).await,
        GroupCommand::JoinToken { command } => {
            execute_group_join_token_create(options, command, json).await
        }
        GroupCommand::Join {
            group_join_token,
            agent_name,
        } => execute_group_join(options, group_join_token, agent_name, json).await,
        GroupCommand::Members { command } => execute_group_members(options, command, json).await,
    }
}
