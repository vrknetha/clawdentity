use anyhow::Result;
use clap::Subcommand;
use clawdentity_core::{
    ConfigPathOptions, GroupCreateInput, GroupInspectInput, GroupJoinInput,
    GroupJoinTokenCreateInput, GroupJoinTokenResetInput, GroupJoinTokenRevokeInput,
    GroupMembersListInput, GroupRole, create_group, create_group_join_token, inspect_group,
    join_group, list_group_members, reset_group_join_token, revoke_group_join_token,
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
    Current {
        group_id: String,
        #[arg(long)]
        agent_name: String,
    },
    Reset {
        group_id: String,
        #[arg(long)]
        agent_name: String,
    },
    Revoke {
        group_id: String,
        #[arg(long)]
        agent_name: String,
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
    match input {
        GroupJoinTokenCommand::Current {
            group_id,
            agent_name,
        } => execute_group_join_token_current(options, group_id, agent_name, json).await,
        GroupJoinTokenCommand::Reset {
            group_id,
            agent_name,
        } => execute_group_join_token_reset(options, group_id, agent_name, json).await,
        GroupJoinTokenCommand::Revoke {
            group_id,
            agent_name,
        } => execute_group_join_token_revoke(options, group_id, agent_name, json).await,
    }
}

async fn execute_group_join_token_current(
    options: &ConfigPathOptions,
    group_id: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = create_group_join_token(
        options,
        GroupJoinTokenCreateInput {
            agent_name,
            group_id,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Current group join token");
        println!("Token: {}", value.group_join_token.token);
        println!("Group ID: {}", value.group_join_token.group_id);
        println!("Role: {}", role_label(value.group_join_token.role));
        println!("Created At: {}", value.group_join_token.created_at);
    })
}

async fn execute_group_join_token_reset(
    options: &ConfigPathOptions,
    group_id: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = reset_group_join_token(
        options,
        GroupJoinTokenResetInput {
            agent_name,
            group_id,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!("Group join token reset");
        println!("Token: {}", value.group_join_token.token);
        println!("Group ID: {}", value.group_join_token.group_id);
        println!("Role: {}", role_label(value.group_join_token.role));
        println!("Created At: {}", value.group_join_token.created_at);
    })
}

async fn execute_group_join_token_revoke(
    options: &ConfigPathOptions,
    group_id: String,
    agent_name: String,
    json: bool,
) -> Result<()> {
    let result = revoke_group_join_token(
        options,
        GroupJoinTokenRevokeInput {
            agent_name,
            group_id,
        },
    )
    .await
    .map_err(anyhow::Error::from)?;
    print_json_or_human(json, &result, |value| {
        println!(
            "{}",
            if value.revoked {
                "Group join token revoked"
            } else {
                "No active group join token"
            }
        );
        println!("Group ID: {}", value.group_id);
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
            println!(
                "- {} / {} ({})",
                member.display_name,
                member.agent_name,
                role_label(member.role)
            );
            println!("  DID: {}", member.agent_did);
            println!("  Human DID: {}", member.human_did);
            println!("  Framework: {}", member.framework);
            println!("  Status: {}", member.status);
            println!("  Joined At: {}", member.joined_at);
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
