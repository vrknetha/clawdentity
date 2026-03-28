use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use clap::Subcommand;
use clawdentity_core::{
    ConfigPathOptions, PairConfirmInput, PairProfile, PairStatusKind, PairStatusOptions,
    SqliteStore, assert_ticket_issuer_matches_proxy, confirm_pairing, fetch_registry_metadata,
    get_config_dir, get_pairing_status, parse_pairing_ticket, persist_pairing_qr, resolve_config,
    start_pairing,
};

#[derive(Debug, Subcommand)]
pub enum PairCommand {
    Start {
        agent_name: String,
        #[arg(long)]
        ttl_seconds: Option<u64>,
        #[arg(long)]
        qr: bool,
        #[arg(long)]
        qr_output: Option<PathBuf>,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 300)]
        wait_seconds: u64,
        #[arg(long, default_value_t = 3)]
        poll_interval_seconds: u64,
    },
    Confirm {
        agent_name: String,
        #[arg(long)]
        ticket: Option<String>,
        #[arg(long)]
        qr_file: Option<PathBuf>,
    },
    Status {
        agent_name: String,
        #[arg(long)]
        ticket: String,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 300)]
        wait_seconds: u64,
        #[arg(long, default_value_t = 3)]
        poll_interval_seconds: u64,
    },
}

/// Execute pairing commands using the local state directory and configured proxy.
pub async fn execute_pair_command(
    options: &ConfigPathOptions,
    command: PairCommand,
    json: bool,
) -> Result<()> {
    dispatch_pair_command(options, command, json).await
}

#[rustfmt::skip]
async fn dispatch_pair_command(options: &ConfigPathOptions, command: PairCommand, json: bool) -> Result<()> {
    match command {
        PairCommand::Start { agent_name, ttl_seconds, qr, qr_output, wait, wait_seconds, poll_interval_seconds } =>
            dispatch_pair_start(options, json, PairStartCommandInput {
                agent_name,
                ttl_seconds,
                qr,
                qr_output,
                wait,
                wait_seconds,
                poll_interval_seconds,
            }).await,
        PairCommand::Confirm { agent_name, ticket, qr_file } =>
            execute_pair_confirm(options, json, agent_name, ticket, qr_file).await,
        PairCommand::Status { agent_name, ticket, wait, wait_seconds, poll_interval_seconds } =>
            dispatch_pair_status(options, json, agent_name, ticket, wait, wait_seconds, poll_interval_seconds).await,
    }
}

struct PairStartCommandInput {
    agent_name: String,
    ttl_seconds: Option<u64>,
    qr: bool,
    qr_output: Option<PathBuf>,
    wait: bool,
    wait_seconds: u64,
    poll_interval_seconds: u64,
}

async fn dispatch_pair_start(
    options: &ConfigPathOptions,
    json: bool,
    input: PairStartCommandInput,
) -> Result<()> {
    execute_pair_start(options, json, input).await
}

async fn dispatch_pair_status(
    options: &ConfigPathOptions,
    json: bool,
    agent_name: String,
    ticket: String,
    wait: bool,
    wait_seconds: u64,
    poll_interval_seconds: u64,
) -> Result<()> {
    execute_pair_status(
        options,
        json,
        agent_name,
        ticket,
        wait,
        wait_seconds,
        poll_interval_seconds,
    )
    .await
}

async fn execute_pair_start(
    options: &ConfigPathOptions,
    json: bool,
    input: PairStartCommandInput,
) -> Result<()> {
    let PairStartCommandInput {
        agent_name,
        ttl_seconds,
        qr,
        qr_output,
        wait,
        wait_seconds,
        poll_interval_seconds,
    } = input;
    let (state_options, config_dir, profile, proxy_url) =
        resolve_pair_context(options, &agent_name).await?;
    let mut start_result =
        start_pairing_for_agent(&config_dir, &agent_name, &proxy_url, profile, ttl_seconds).await?;

    maybe_persist_pair_qr(
        qr,
        &config_dir,
        &agent_name,
        qr_output.as_deref(),
        &mut start_result,
    )?;

    if wait {
        let status_result = wait_for_pair_confirmation(
            &state_options,
            &config_dir,
            &agent_name,
            &proxy_url,
            &start_result.ticket,
            wait_seconds,
            poll_interval_seconds,
        )
        .await?;
        return print_pair_start_with_status(json, &start_result, &status_result);
    }

    print_pair_start_only(json, &start_result)
}

async fn execute_pair_confirm(
    options: &ConfigPathOptions,
    json: bool,
    agent_name: String,
    ticket: Option<String>,
    qr_file: Option<PathBuf>,
) -> Result<()> {
    let (state_options, config_dir, profile, _) =
        resolve_pair_context(options, &agent_name).await?;
    let confirm_input = resolve_confirm_input(ticket, qr_file.clone())?;
    let result = run_blocking(move || {
        let store = SqliteStore::open(&state_options)?;
        confirm_pairing(&config_dir, &store, &agent_name, confirm_input, profile)
            .map_err(anyhow::Error::from)
    })
    .await?;

    remove_qr_file(qr_file);
    print_pair_confirm(json, &result)
}

async fn execute_pair_status(
    options: &ConfigPathOptions,
    json: bool,
    agent_name: String,
    ticket: String,
    wait: bool,
    wait_seconds: u64,
    poll_interval_seconds: u64,
) -> Result<()> {
    let (state_options, config_dir, _, proxy_url) =
        resolve_pair_context(options, &agent_name).await?;
    let ticket = parse_pairing_ticket(&ticket)?;
    assert_ticket_issuer_matches_proxy(&ticket, &proxy_url)?;

    let result = run_blocking(move || {
        let store = SqliteStore::open(&state_options)?;
        get_pairing_status(
            &config_dir,
            &store,
            &agent_name,
            &proxy_url,
            &ticket,
            PairStatusOptions {
                wait,
                wait_seconds,
                poll_interval_seconds,
            },
        )
        .map_err(anyhow::Error::from)
    })
    .await?;

    print_pair_status(json, &result)
}

async fn resolve_pair_context(
    options: &ConfigPathOptions,
    agent_name: &str,
) -> Result<(ConfigPathOptions, PathBuf, PairProfile, String)> {
    let config = resolve_config(options)?;
    let state_options = options.with_registry_hint(config.registry_url.clone());
    let config_dir = get_config_dir(&state_options)?;
    let proxy_url = resolve_pair_proxy_url(&config).await?;
    let profile = build_local_pair_profile(agent_name, &config, &proxy_url)?;
    Ok((state_options, config_dir, profile, proxy_url))
}

async fn start_pairing_for_agent(
    config_dir: &std::path::Path,
    agent_name: &str,
    proxy_url: &str,
    profile: PairProfile,
    ttl_seconds: Option<u64>,
) -> Result<clawdentity_core::PairStartResult> {
    let config_dir = config_dir.to_path_buf();
    let agent_name = agent_name.to_string();
    let proxy_url = proxy_url.to_string();
    run_blocking(move || {
        start_pairing(&config_dir, &agent_name, &proxy_url, profile, ttl_seconds)
            .map_err(anyhow::Error::from)
    })
    .await
}

async fn wait_for_pair_confirmation(
    state_options: &ConfigPathOptions,
    config_dir: &std::path::Path,
    agent_name: &str,
    proxy_url: &str,
    ticket: &str,
    wait_seconds: u64,
    poll_interval_seconds: u64,
) -> Result<clawdentity_core::PairStatusResult> {
    let state_options = state_options.clone();
    let config_dir = config_dir.to_path_buf();
    let agent_name = agent_name.to_string();
    let proxy_url = proxy_url.to_string();
    let ticket = ticket.to_string();
    run_blocking(move || {
        let store = SqliteStore::open(&state_options)?;
        get_pairing_status(
            &config_dir,
            &store,
            &agent_name,
            &proxy_url,
            &ticket,
            PairStatusOptions {
                wait: true,
                wait_seconds,
                poll_interval_seconds,
            },
        )
        .map_err(anyhow::Error::from)
    })
    .await
}

fn maybe_persist_pair_qr(
    qr: bool,
    config_dir: &std::path::Path,
    agent_name: &str,
    qr_output: Option<&std::path::Path>,
    start_result: &mut clawdentity_core::PairStartResult,
) -> Result<()> {
    if !qr {
        return Ok(());
    }

    let now_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs() as i64;
    start_result.qr_path = Some(persist_pairing_qr(
        config_dir,
        agent_name,
        &start_result.ticket,
        qr_output,
        now_seconds,
    )?);
    Ok(())
}

fn print_pair_start_with_status(
    json: bool,
    start_result: &clawdentity_core::PairStartResult,
    status_result: &clawdentity_core::PairStatusResult,
) -> Result<()> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "start": start_result,
                "status": status_result,
            }))?
        );
    } else {
        print_start_result(start_result);
        print_status_result(status_result, true);
    }
    Ok(())
}

fn print_pair_start_only(
    json: bool,
    start_result: &clawdentity_core::PairStartResult,
) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(start_result)?);
    } else {
        print_start_result(start_result);
    }
    Ok(())
}

fn print_pair_confirm(json: bool, result: &clawdentity_core::PairConfirmResult) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
    } else {
        print_confirm_result(result);
    }
    Ok(())
}

fn print_pair_status(json: bool, result: &clawdentity_core::PairStatusResult) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string_pretty(result)?);
    } else {
        print_status_result(result, false);
    }
    Ok(())
}

fn remove_qr_file(qr_file: Option<PathBuf>) {
    if let Some(path) = qr_file {
        let _ = fs::remove_file(path);
    }
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

fn resolve_confirm_input(
    ticket: Option<String>,
    qr_file: Option<PathBuf>,
) -> Result<PairConfirmInput> {
    match (ticket, qr_file) {
        (Some(ticket), None) => Ok(PairConfirmInput::Ticket(ticket)),
        (None, Some(path)) => Ok(PairConfirmInput::QrFile(path)),
        (Some(_), Some(_)) => bail!("pass either --ticket or --qr-file, not both"),
        (None, None) => bail!("pair confirm requires either --ticket or --qr-file"),
    }
}

pub(crate) fn build_local_pair_profile(
    agent_name: &str,
    config: &clawdentity_core::CliConfig,
    proxy_url: &str,
) -> Result<PairProfile> {
    let human_name = config
        .human_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("humanName is required; complete onboarding first"))?;
    Ok(PairProfile {
        agent_name: agent_name.trim().to_string(),
        human_name: human_name.to_string(),
        proxy_origin: Some(proxy_origin(proxy_url)?),
    })
}

fn proxy_origin(proxy_url: &str) -> Result<String> {
    let parsed = reqwest::Url::parse(proxy_url)?;
    Ok(parsed.origin().unicode_serialization())
}

pub(crate) async fn resolve_pair_proxy_url(config: &clawdentity_core::CliConfig) -> Result<String> {
    if let Ok(env_proxy) = std::env::var("CLAWDENTITY_PROXY_URL") {
        let trimmed = env_proxy.trim();
        if !trimmed.is_empty() {
            return Ok(reqwest::Url::parse(trimmed)?.to_string());
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()?;
    let metadata = fetch_registry_metadata(&client, &config.registry_url).await?;

    if let Some(saved_proxy_url) = config
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let normalized_saved = reqwest::Url::parse(saved_proxy_url)?.to_string();
        let normalized_metadata = reqwest::Url::parse(&metadata.proxy_url)?.to_string();
        if normalized_saved != normalized_metadata {
            bail!(
                "proxyUrl mismatch: local config has {normalized_saved}, registry metadata has {normalized_metadata}"
            );
        }
        return Ok(normalized_saved);
    }

    Ok(reqwest::Url::parse(&metadata.proxy_url)?.to_string())
}

fn print_start_result(result: &clawdentity_core::PairStartResult) {
    println!("Pairing ticket created");
    println!("Ticket: {}", result.ticket);
    println!("Initiator Agent DID: {}", result.initiator_agent_did);
    println!(
        "Initiator Agent Name: {}",
        result.initiator_profile.agent_name
    );
    println!(
        "Initiator Human Name: {}",
        result.initiator_profile.human_name
    );
    println!("Expires At: {}", result.expires_at);
    if let Some(qr_path) = result.qr_path.as_ref() {
        println!("QR File: {}", qr_path.display());
    }
}

fn print_confirm_result(result: &clawdentity_core::PairConfirmResult) {
    println!("Pairing confirmed");
    println!("Initiator Agent DID: {}", result.initiator_agent_did);
    println!(
        "Initiator Agent Name: {}",
        result.initiator_profile.agent_name
    );
    println!(
        "Initiator Human Name: {}",
        result.initiator_profile.human_name
    );
    println!("Responder Agent DID: {}", result.responder_agent_did);
    println!(
        "Responder Agent Name: {}",
        result.responder_profile.agent_name
    );
    println!(
        "Responder Human Name: {}",
        result.responder_profile.human_name
    );
    println!("Paired: {}", if result.paired { "true" } else { "false" });
    if let Some(peer_alias) = result.peer_alias.as_deref() {
        println!("Peer alias saved: {peer_alias}");
    }
}

fn print_status_result(result: &clawdentity_core::PairStatusResult, waited: bool) {
    if waited && result.status == PairStatusKind::Confirmed {
        println!("Pairing confirmed");
    }
    println!(
        "Status: {}",
        match result.status {
            PairStatusKind::Pending => "pending",
            PairStatusKind::Confirmed => "confirmed",
        }
    );
    println!("Initiator Agent DID: {}", result.initiator_agent_did);
    println!(
        "Initiator Agent Name: {}",
        result.initiator_profile.agent_name
    );
    println!(
        "Initiator Human Name: {}",
        result.initiator_profile.human_name
    );
    if let Some(responder_agent_did) = result.responder_agent_did.as_deref() {
        println!("Responder Agent DID: {responder_agent_did}");
    }
    if let Some(responder_profile) = result.responder_profile.as_ref() {
        println!("Responder Agent Name: {}", responder_profile.agent_name);
        println!("Responder Human Name: {}", responder_profile.human_name);
    }
    println!("Expires At: {}", result.expires_at);
    if let Some(confirmed_at) = result.confirmed_at.as_deref() {
        println!("Confirmed At: {confirmed_at}");
    }
    if let Some(peer_alias) = result.peer_alias.as_deref() {
        println!("Peer alias saved: {peer_alias}");
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use clawdentity_core::CliConfig;

    use super::{build_local_pair_profile, proxy_origin, resolve_confirm_input};

    #[test]
    fn build_profile_requires_human_name() {
        let config = CliConfig {
            registry_url: "https://registry.clawdentity.com".to_string(),
            proxy_url: Some("https://proxy.clawdentity.com".to_string()),
            api_key: None,
            human_name: Some("Alice".to_string()),
        };
        let profile = build_local_pair_profile("alpha", &config, "https://proxy.clawdentity.com")
            .expect("profile");
        assert_eq!(profile.agent_name, "alpha");
        assert_eq!(profile.human_name, "Alice");
        assert_eq!(
            profile.proxy_origin.as_deref(),
            Some("https://proxy.clawdentity.com")
        );
    }

    #[test]
    fn confirm_input_requires_one_source() {
        assert!(resolve_confirm_input(None, None).is_err());
        assert!(
            resolve_confirm_input(Some("ticket".to_string()), Some(PathBuf::from("/tmp/x")))
                .is_err()
        );
    }

    #[test]
    fn proxy_origin_keeps_only_origin() {
        let origin = proxy_origin("https://proxy.clawdentity.com/hooks/agent").expect("origin");
        assert_eq!(origin, "https://proxy.clawdentity.com");
    }
}
