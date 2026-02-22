use anyhow::Result;
use clagram_core::{
    ConfigPathOptions, ConnectorServiceInstallInput, ConnectorServiceUninstallInput,
    install_connector_service, uninstall_connector_service,
};
use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum ConnectorCommand {
    Service {
        #[command(subcommand)]
        command: ConnectorServiceCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum ConnectorServiceCommand {
    Install {
        name: String,
        #[arg(long)]
        platform: Option<String>,
        #[arg(long)]
        proxy_ws_url: Option<String>,
        #[arg(long)]
        openclaw_base_url: Option<String>,
        #[arg(long)]
        openclaw_hook_path: Option<String>,
        #[arg(long)]
        openclaw_hook_token: Option<String>,
    },
    Uninstall {
        name: String,
        #[arg(long)]
        platform: Option<String>,
    },
}

pub fn execute_connector_command(
    options: &ConfigPathOptions,
    command: ConnectorCommand,
    json: bool,
) -> Result<()> {
    match command {
        ConnectorCommand::Service { command } => match command {
            ConnectorServiceCommand::Install {
                name,
                platform,
                proxy_ws_url,
                openclaw_base_url,
                openclaw_hook_path,
                openclaw_hook_token,
            } => {
                let result = install_connector_service(
                    options,
                    ConnectorServiceInstallInput {
                        agent_name: name,
                        platform,
                        proxy_ws_url,
                        openclaw_base_url,
                        openclaw_hook_path,
                        openclaw_hook_token,
                        executable_path: None,
                    },
                )?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Connector service installed ({}): {}",
                        result.platform, result.service_name
                    );
                    println!("Service file: {}", result.service_file_path.display());
                    println!("Logs (stdout): {}", result.output_log_path.display());
                    println!("Logs (stderr): {}", result.error_log_path.display());
                }
            }
            ConnectorServiceCommand::Uninstall { name, platform } => {
                let result = uninstall_connector_service(
                    options,
                    ConnectorServiceUninstallInput {
                        agent_name: name,
                        platform,
                    },
                )?;
                if json {
                    println!("{}", serde_json::to_string_pretty(&result)?);
                } else {
                    println!(
                        "Connector service uninstalled ({}): {}",
                        result.platform, result.service_name
                    );
                    println!(
                        "Service file removed: {}",
                        result.service_file_path.display()
                    );
                }
            }
        },
    }

    Ok(())
}
