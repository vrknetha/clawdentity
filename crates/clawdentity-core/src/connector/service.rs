use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::config::{ConfigPathOptions, get_config_dir};
use crate::error::{CoreError, Result};

const SERVICE_LOG_DIR_NAME: &str = "service-logs";
const FILE_MODE: u32 = 0o600;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnectorServicePlatform {
    Launchd,
    Systemd,
}

impl ConnectorServicePlatform {
/// TODO(clawdentity): document `as_str`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Launchd => "launchd",
            Self::Systemd => "systemd",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorServiceInstallInput {
    pub agent_name: String,
    pub platform: Option<String>,
    pub proxy_ws_url: Option<String>,
    pub openclaw_base_url: Option<String>,
    pub openclaw_hook_path: Option<String>,
    pub openclaw_hook_token: Option<String>,
    pub executable_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorServiceUninstallInput {
    pub agent_name: String,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorServiceInstallResult {
    pub platform: String,
    pub service_name: String,
    pub service_file_path: PathBuf,
    pub output_log_path: PathBuf,
    pub error_log_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorServiceUninstallResult {
    pub platform: String,
    pub service_name: String,
    pub service_file_path: PathBuf,
}

/// TODO(clawdentity): document `parse_connector_service_platform`.
pub fn parse_connector_service_platform(value: Option<&str>) -> Result<ConnectorServicePlatform> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return detect_current_platform();
    };

    match value.to_ascii_lowercase().as_str() {
        "auto" => detect_current_platform(),
        "launchd" => Ok(ConnectorServicePlatform::Launchd),
        "systemd" => Ok(ConnectorServicePlatform::Systemd),
        _ => Err(CoreError::InvalidInput(
            "platform must be one of: auto, launchd, systemd".to_string(),
        )),
    }
}

/// TODO(clawdentity): document `sanitize_service_segment`.
pub fn sanitize_service_segment(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut previous_dash = false;
    for character in value.chars() {
        let is_allowed = character.is_ascii_alphanumeric() || character == '-' || character == '_';
        if is_allowed {
            output.push(character);
            previous_dash = false;
        } else if !previous_dash {
            output.push('-');
            previous_dash = true;
        }
    }

    let trimmed = output.trim_matches('-').trim_matches('.');
    if trimmed.is_empty() {
        "connector".to_string()
    } else {
        trimmed.to_string()
    }
}

fn detect_current_platform() -> Result<ConnectorServicePlatform> {
    #[cfg(target_os = "macos")]
    {
        return Ok(ConnectorServicePlatform::Launchd);
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(ConnectorServicePlatform::Systemd);
    }

    #[allow(unreachable_code)]
    Err(CoreError::InvalidInput(
        "connector service is only supported on macOS and Linux".to_string(),
    ))
}

fn parse_agent_name(value: &str) -> Result<String> {
    let candidate = value.trim();
    if candidate.is_empty() {
        return Err(CoreError::InvalidInput(
            "agent name is required".to_string(),
        ));
    }
    if candidate == "." || candidate == ".." {
        return Err(CoreError::InvalidInput(
            "agent name must not be . or ..".to_string(),
        ));
    }
    if candidate.len() > 64 {
        return Err(CoreError::InvalidInput(
            "agent name must be <= 64 characters".to_string(),
        ));
    }
    let valid = candidate
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.');
    if !valid {
        return Err(CoreError::InvalidInput(
            "agent name contains invalid characters".to_string(),
        ));
    }
    Ok(candidate.to_string())
}

fn service_name_for_agent(agent_name: &str) -> Result<String> {
    let agent_name = parse_agent_name(agent_name)?;
    Ok(sanitize_service_segment(&format!(
        "clawdentity-connector-{agent_name}"
    )))
}

fn resolve_home_dir(options: &ConfigPathOptions) -> Result<PathBuf> {
    if let Some(home_dir) = &options.home_dir {
        return Ok(home_dir.clone());
    }
    dirs::home_dir().ok_or(CoreError::HomeDirectoryUnavailable)
}

fn resolve_executable_path(override_path: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(path) = override_path {
        return Ok(path);
    }
    std::env::current_exe().map_err(|error| {
        CoreError::InvalidInput(format!(
            "unable to resolve current executable path: {}",
            error
        ))
    })
}

fn build_connector_start_args(input: &ConnectorServiceInstallInput) -> Vec<String> {
    let mut args = vec![
        "connector".to_string(),
        "start".to_string(),
        input.agent_name.clone(),
    ];
    if let Some(proxy_ws_url) = input
        .proxy_ws_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--proxy-ws-url".to_string());
        args.push(proxy_ws_url.to_string());
    }
    if let Some(openclaw_base_url) = input
        .openclaw_base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--openclaw-base-url".to_string());
        args.push(openclaw_base_url.to_string());
    }
    if let Some(openclaw_hook_path) = input
        .openclaw_hook_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--openclaw-hook-path".to_string());
        args.push(openclaw_hook_path.to_string());
    }
    if let Some(openclaw_hook_token) = input
        .openclaw_hook_token
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--openclaw-hook-token".to_string());
        args.push(openclaw_hook_token.to_string());
    }
    args
}

fn run_process(program: &str, args: &[String], ignore_failure: bool) -> Result<()> {
    let output = Command::new(program).args(args).output().map_err(|error| {
        CoreError::InvalidInput(format!("failed to run `{program}`: {}", error))
    })?;
    if output.status.success() || ignore_failure {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if stderr.is_empty() {
        format!("`{program}` returned status {}", output.status)
    } else {
        format!("`{program}` failed: {stderr}")
    };
    Err(CoreError::InvalidInput(message))
}

fn quote_systemd_argument(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn create_systemd_service_file_content(
    command: &[String],
    working_directory: &Path,
    output_log_path: &Path,
    error_log_path: &Path,
    agent_name: &str,
) -> String {
    let exec_start = command
        .iter()
        .map(|arg| quote_systemd_argument(arg))
        .collect::<Vec<_>>()
        .join(" ");
    [
        "[Unit]".to_string(),
        format!("Description=Clawdentity connector ({agent_name})"),
        "After=network-online.target".to_string(),
        "Wants=network-online.target".to_string(),
        String::new(),
        "[Service]".to_string(),
        "Type=simple".to_string(),
        format!("ExecStart={exec_start}"),
        "Restart=always".to_string(),
        "RestartSec=2".to_string(),
        format!(
            "WorkingDirectory={}",
            quote_systemd_argument(&working_directory.display().to_string())
        ),
        format!("StandardOutput=append:{}", output_log_path.display()),
        format!("StandardError=append:{}", error_log_path.display()),
        String::new(),
        "[Install]".to_string(),
        "WantedBy=default.target".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn create_launchd_plist_content(
    label: &str,
    command: &[String],
    working_directory: &Path,
    output_log_path: &Path,
    error_log_path: &Path,
) -> String {
    let command_items = command
        .iter()
        .map(|arg| format!("    <string>{}</string>", escape_xml(arg)))
        .collect::<Vec<_>>()
        .join("\n");
    [
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>".to_string(),
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">".to_string(),
        "<plist version=\"1.0\">".to_string(),
        "<dict>".to_string(),
        "  <key>Label</key>".to_string(),
        format!("  <string>{}</string>", escape_xml(label)),
        "  <key>ProgramArguments</key>".to_string(),
        "  <array>".to_string(),
        command_items,
        "  </array>".to_string(),
        "  <key>RunAtLoad</key>".to_string(),
        "  <true/>".to_string(),
        "  <key>KeepAlive</key>".to_string(),
        "  <true/>".to_string(),
        "  <key>WorkingDirectory</key>".to_string(),
        format!(
            "  <string>{}</string>",
            escape_xml(&working_directory.display().to_string())
        ),
        "  <key>StandardOutPath</key>".to_string(),
        format!(
            "  <string>{}</string>",
            escape_xml(&output_log_path.display().to_string())
        ),
        "  <key>StandardErrorPath</key>".to_string(),
        format!(
            "  <string>{}</string>",
            escape_xml(&error_log_path.display().to_string())
        ),
        "</dict>".to_string(),
        "</plist>".to_string(),
        String::new(),
    ]
    .join("\n")
}

fn write_service_file(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CoreError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    }
    fs::write(path, contents).map_err(|source| CoreError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(FILE_MODE)).map_err(|source| {
            CoreError::Io {
                path: path.to_path_buf(),
                source,
            }
        })?;
    }
    Ok(())
}

/// TODO(clawdentity): document `install_connector_service`.
#[allow(clippy::too_many_lines)]
pub fn install_connector_service(
    options: &ConfigPathOptions,
    input: ConnectorServiceInstallInput,
) -> Result<ConnectorServiceInstallResult> {
    let platform = parse_connector_service_platform(input.platform.as_deref())?;
    let service_name = service_name_for_agent(&input.agent_name)?;
    let config_dir = get_config_dir(options)?;
    let home_dir = resolve_home_dir(options)?;
    let logs_dir = config_dir.join(SERVICE_LOG_DIR_NAME);
    fs::create_dir_all(&logs_dir).map_err(|source| CoreError::Io {
        path: logs_dir.clone(),
        source,
    })?;

    let output_log_path = logs_dir.join(format!("{service_name}.out.log"));
    let error_log_path = logs_dir.join(format!("{service_name}.err.log"));
    let executable = resolve_executable_path(input.executable_path.clone())?;
    let mut command = vec![executable.display().to_string()];
    command.extend(build_connector_start_args(&input));

    match platform {
        ConnectorServicePlatform::Systemd => {
            let service_dir = home_dir.join(".config/systemd/user");
            let service_file_path = service_dir.join(format!("{service_name}.service"));
            let service_contents = create_systemd_service_file_content(
                &command,
                &home_dir,
                &output_log_path,
                &error_log_path,
                &input.agent_name,
            );
            write_service_file(&service_file_path, &service_contents)?;
            run_process(
                "systemctl",
                &["--user".to_string(), "daemon-reload".to_string()],
                false,
            )?;
            run_process(
                "systemctl",
                &[
                    "--user".to_string(),
                    "enable".to_string(),
                    "--now".to_string(),
                    format!("{service_name}.service"),
                ],
                false,
            )?;

            Ok(ConnectorServiceInstallResult {
                platform: platform.as_str().to_string(),
                service_name,
                service_file_path,
                output_log_path,
                error_log_path,
            })
        }
        ConnectorServicePlatform::Launchd => {
            let launch_agents_dir = home_dir.join("Library/LaunchAgents");
            let label = format!("com.clawdentity.{service_name}");
            let service_file_path = launch_agents_dir.join(format!("{label}.plist"));
            let plist_contents = create_launchd_plist_content(
                &label,
                &command,
                &home_dir,
                &output_log_path,
                &error_log_path,
            );
            write_service_file(&service_file_path, &plist_contents)?;

            run_process(
                "launchctl",
                &[
                    "unload".to_string(),
                    "-w".to_string(),
                    service_file_path.display().to_string(),
                ],
                true,
            )?;
            run_process(
                "launchctl",
                &[
                    "load".to_string(),
                    "-w".to_string(),
                    service_file_path.display().to_string(),
                ],
                false,
            )?;

            Ok(ConnectorServiceInstallResult {
                platform: platform.as_str().to_string(),
                service_name,
                service_file_path,
                output_log_path,
                error_log_path,
            })
        }
    }
}

/// TODO(clawdentity): document `uninstall_connector_service`.
#[allow(clippy::too_many_lines)]
pub fn uninstall_connector_service(
    options: &ConfigPathOptions,
    input: ConnectorServiceUninstallInput,
) -> Result<ConnectorServiceUninstallResult> {
    let platform = parse_connector_service_platform(input.platform.as_deref())?;
    let service_name = service_name_for_agent(&input.agent_name)?;
    let home_dir = resolve_home_dir(options)?;

    let service_file_path = match platform {
        ConnectorServicePlatform::Systemd => home_dir
            .join(".config/systemd/user")
            .join(format!("{service_name}.service")),
        ConnectorServicePlatform::Launchd => {
            let label = format!("com.clawdentity.{service_name}");
            home_dir
                .join("Library/LaunchAgents")
                .join(format!("{label}.plist"))
        }
    };

    match platform {
        ConnectorServicePlatform::Systemd => {
            let _ = run_process(
                "systemctl",
                &[
                    "--user".to_string(),
                    "disable".to_string(),
                    "--now".to_string(),
                    format!("{service_name}.service"),
                ],
                true,
            );
            let _ = fs::remove_file(&service_file_path);
            let _ = run_process(
                "systemctl",
                &["--user".to_string(), "daemon-reload".to_string()],
                true,
            );
        }
        ConnectorServicePlatform::Launchd => {
            let _ = run_process(
                "launchctl",
                &[
                    "unload".to_string(),
                    "-w".to_string(),
                    service_file_path.display().to_string(),
                ],
                true,
            );
            let _ = fs::remove_file(&service_file_path);
        }
    }

    Ok(ConnectorServiceUninstallResult {
        platform: platform.as_str().to_string(),
        service_name,
        service_file_path,
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        ConnectorServiceInstallInput, create_launchd_plist_content,
        create_systemd_service_file_content, parse_connector_service_platform,
        sanitize_service_segment,
    };

    #[test]
    fn sanitize_service_segment_replaces_non_alnum_sequences() {
        let sanitized = sanitize_service_segment("clawdentity connector!!alpha");
        assert_eq!(sanitized, "clawdentity-connector-alpha");
    }

    #[test]
    fn parse_platform_allows_explicit_values() {
        assert_eq!(
            parse_connector_service_platform(Some("launchd")).expect("launchd"),
            super::ConnectorServicePlatform::Launchd
        );
        assert_eq!(
            parse_connector_service_platform(Some("systemd")).expect("systemd"),
            super::ConnectorServicePlatform::Systemd
        );
    }

    #[test]
    fn generated_service_templates_include_connector_start_args() {
        let input = ConnectorServiceInstallInput {
            agent_name: "alpha".to_string(),
            platform: Some("systemd".to_string()),
            proxy_ws_url: Some("wss://proxy.example/v1/relay/connect".to_string()),
            openclaw_base_url: Some("http://127.0.0.1:18789".to_string()),
            openclaw_hook_path: Some("/hooks/agent".to_string()),
            openclaw_hook_token: Some("token".to_string()),
            executable_path: Some("/tmp/clawdentity".into()),
        };
        let command = {
            let mut args = vec!["/tmp/clawdentity".to_string()];
            args.extend(super::build_connector_start_args(&input));
            args
        };
        let systemd = create_systemd_service_file_content(
            &command,
            Path::new("/tmp"),
            Path::new("/tmp/out.log"),
            Path::new("/tmp/err.log"),
            "alpha",
        );
        assert!(systemd.contains("connector\" \"start\" \"alpha"));
        assert!(systemd.contains("--openclaw-hook-token"));

        let launchd = create_launchd_plist_content(
            "com.clawdentity.clawdentity-connector-alpha",
            &command,
            Path::new("/tmp"),
            Path::new("/tmp/out.log"),
            Path::new("/tmp/err.log"),
        );
        assert!(launchd.contains("<string>connector</string>"));
        assert!(launchd.contains("<string>--proxy-ws-url</string>"));
    }
}
