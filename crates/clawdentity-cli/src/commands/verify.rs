use anyhow::Result;
use clawdentity_core::{
    ConfigPathOptions, SqliteStore, resolve_config, verify_ait_token_with_registry,
};

/// Verify an AIT token or token file against registry keys and revocation data.
pub fn execute_verify_command(
    options: &ConfigPathOptions,
    token_or_file: &str,
    json: bool,
) -> Result<()> {
    let config = resolve_config(options)?;
    let state_options = options.with_registry_hint(config.registry_url.clone());
    let store = SqliteStore::open(&state_options)?;
    let result = verify_ait_token_with_registry(&store, &config.registry_url, token_or_file)?;

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "passed": result.passed,
                "reason": result.reason,
                "claims": result.claims,
            }))?
        );
    } else if result.passed {
        println!("token verified");
        println!("Reason: {}", result.reason);
        if let Some(claims) = result.claims.as_ref() {
            println!("Issuer: {}", claims.iss);
            println!("Subject: {}", claims.sub);
            println!("Owner DID: {}", claims.owner_did);
            println!("JTI: {}", claims.jti);
            println!("Expires At: {}", claims.exp);
        }
    } else {
        println!("invalid token");
        println!("Reason: {}", result.reason);
        if let Some(claims) = result.claims.as_ref() {
            println!("Subject: {}", claims.sub);
            println!("JTI: {}", claims.jti);
        }
        std::process::exit(1);
    }

    Ok(())
}
