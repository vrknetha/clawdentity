use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

use crate::error::{CoreError, Result};
use crate::providers::resolve_command_path;

const OPENCLAW_BINARY: &str = "openclaw";

fn openclaw_command(command_path: &Path, config_path: &Path, openclaw_dir: &Path) -> Command {
    let mut command = Command::new(command_path);
    command.env("OPENCLAW_CONFIG_PATH", config_path);
    command.env("OPENCLAW_STATE_DIR", openclaw_dir);
    command
}

fn format_command(command_path: &Path, args: &[&str]) -> String {
    let mut parts = Vec::with_capacity(args.len() + 1);
    parts.push(command_path.display().to_string());
    parts.extend(args.iter().map(|arg| arg.to_string()));
    parts.join(" ")
}

fn command_error(command_path: &Path, args: &[&str], output: &std::process::Output) -> CoreError {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let message = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "unknown error".to_string()
    };
    CoreError::CommandFailed {
        command: format_command(command_path, args),
        message,
    }
}

/// Resolve the `openclaw` binary used by install and setup flows.
pub fn ensure_openclaw_cli_available(path_override: Option<&[PathBuf]>) -> Result<PathBuf> {
    resolve_command_path(OPENCLAW_BINARY, path_override).ok_or_else(|| {
        CoreError::InvalidInput(
            "OpenClaw CLI is required for the OpenClaw provider flow. Install OpenClaw and ensure the `openclaw` command is on PATH, then retry.".to_string(),
        )
    })
}

/// Run `openclaw config set` with a JSON payload against the target profile.
pub fn run_openclaw_config_set_json(
    command_path: &Path,
    config_path: &Path,
    openclaw_dir: &Path,
    path: &str,
    value: &Value,
) -> Result<()> {
    let rendered = serde_json::to_string(value)?;
    let args = ["config", "set", path, rendered.as_str(), "--strict-json"];
    let output = openclaw_command(command_path, config_path, openclaw_dir)
        .args(args)
        .output()
        .map_err(|error| CoreError::CommandFailed {
            command: format_command(command_path, &args),
            message: error.to_string(),
        })?;
    if !output.status.success() {
        return Err(command_error(command_path, &args, &output));
    }
    Ok(())
}
