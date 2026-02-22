use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use serde_json::json;

use crate::error::{CoreError, Result};
use crate::provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, VerifyResult, command_exists, default_webhook_url, health_check,
    join_url_path, read_text, upsert_env_var, write_text,
};

const PROVIDER_NAME: &str = "nanoclaw";
const PROVIDER_DISPLAY_NAME: &str = "NanoClaw";
const NANOCLAW_BINARY: &str = "nanoclaw";
const NANOCLAW_WEBHOOK_PATH: &str = "/v1/inbound";
const NANOCLAW_SKILL_COMMAND: [&str; 3] = [
    "tsx",
    "scripts/apply-skill.ts",
    ".claude/skills/add-webhook",
];

#[derive(Debug, Clone, Default)]
pub struct NanoclawProvider {
    project_root_override: Option<PathBuf>,
    path_override: Option<Vec<PathBuf>>,
}

impl NanoclawProvider {
    fn project_root(&self) -> Option<PathBuf> {
        self.project_root_override
            .clone()
            .or_else(|| std::env::current_dir().ok())
    }

    fn install_project_root(&self, opts: &InstallOptions) -> Result<PathBuf> {
        if let Some(project_root) = opts.home_dir.as_ref() {
            return Ok(project_root.clone());
        }

        self.project_root().ok_or(CoreError::InvalidInput(
            "unable to resolve project root".to_string(),
        ))
    }

    fn resolve_webhook_url(&self, opts: &InstallOptions) -> Result<String> {
        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return join_url_path(connector_url, NANOCLAW_WEBHOOK_PATH, "connectorUrl");
        }

        let host = opts
            .webhook_host
            .as_deref()
            .unwrap_or(self.default_webhook_host());
        let port = opts.webhook_port.unwrap_or(self.default_webhook_port());
        default_webhook_url(host, port, NANOCLAW_WEBHOOK_PATH)
    }

    #[cfg(test)]
    fn with_test_context(project_root: PathBuf, path_override: Vec<PathBuf>) -> Self {
        Self {
            project_root_override: Some(project_root),
            path_override: Some(path_override),
        }
    }
}

impl PlatformProvider for NanoclawProvider {
    fn name(&self) -> &str {
        PROVIDER_NAME
    }

    fn display_name(&self) -> &str {
        PROVIDER_DISPLAY_NAME
    }

    fn detect(&self) -> DetectionResult {
        let mut evidence = Vec::new();
        let mut confidence: f32 = 0.0;

        if let Some(project_root) = self.project_root() {
            let claude_dir = project_root.join(".claude");
            if claude_dir.is_dir() {
                evidence.push(format!("found {}/", claude_dir.display()));
                confidence += 0.45;
            }

            let skills_dir = claude_dir.join("skills");
            if skills_dir.is_dir() {
                evidence.push(format!("found {}/", skills_dir.display()));
                confidence += 0.3;
            }

            if project_root.join("scripts/apply-skill.ts").is_file() {
                evidence.push("found scripts/apply-skill.ts".to_string());
                confidence += 0.1;
            }
        }

        if command_exists(NANOCLAW_BINARY, self.path_override.as_deref()) {
            evidence.push("nanoclaw binary in PATH".to_string());
            confidence += 0.15;
        }

        DetectionResult {
            detected: confidence > 0.0,
            confidence: confidence.min(1.0),
            evidence,
        }
    }

    fn format_inbound(&self, message: &InboundMessage) -> InboundRequest {
        InboundRequest {
            headers: HashMap::new(),
            body: json!({
                "userId": message.sender_did,
                "content": message.content,
            }),
        }
    }

    fn default_webhook_port(&self) -> u16 {
        18794
    }

    fn config_path(&self) -> Option<PathBuf> {
        self.project_root()
            .map(|project_root| project_root.join(".env"))
    }

    fn install(&self, opts: &InstallOptions) -> Result<InstallResult> {
        let project_root = self.install_project_root(opts)?;
        let env_path = project_root.join(".env");

        let command_output = Command::new("npx")
            .args(NANOCLAW_SKILL_COMMAND)
            .current_dir(&project_root)
            .output()
            .map_err(|error| {
                CoreError::InvalidInput(format!("failed to run nanoclaw skill installer: {error}"))
            })?;

        if !command_output.status.success() {
            let stderr = String::from_utf8_lossy(&command_output.stderr)
                .trim()
                .to_string();
            return Err(CoreError::InvalidInput(format!(
                "nanoclaw skill installer failed: {}",
                if stderr.is_empty() {
                    "unknown error".to_string()
                } else {
                    stderr
                }
            )));
        }

        let webhook_url = self.resolve_webhook_url(opts)?;

        let mut env_contents = read_text(&env_path)?.unwrap_or_default();
        env_contents = upsert_env_var(&env_contents, "CLAWDENTITY_WEBHOOK_URL", &webhook_url);

        if let Some(token) = opts
            .webhook_token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env_contents = upsert_env_var(&env_contents, "CLAWDENTITY_WEBHOOK_TOKEN", token);
        }

        if let Some(connector_url) = opts
            .connector_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            env_contents =
                upsert_env_var(&env_contents, "CLAWDENTITY_CONNECTOR_URL", connector_url);
        }

        write_text(&env_path, &env_contents)?;

        Ok(InstallResult {
            platform: self.name().to_string(),
            config_updated: true,
            service_installed: true,
            notes: vec![
                "applied .claude skill add-webhook".to_string(),
                format!("updated {}", env_path.display()),
            ],
        })
    }

    fn verify(&self) -> Result<VerifyResult> {
        let (healthy, detail) =
            health_check(self.default_webhook_host(), self.default_webhook_port())?;
        Ok(VerifyResult {
            healthy,
            checks: vec![("health".to_string(), healthy, detail)],
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use tempfile::TempDir;

    use crate::provider::{InboundMessage, PlatformProvider};

    use super::NanoclawProvider;

    #[test]
    fn detection_checks_project_structure_and_path() {
        let project_root = TempDir::new().expect("temp project");
        std::fs::create_dir_all(project_root.path().join(".claude/skills")).expect("skills dir");
        std::fs::create_dir_all(project_root.path().join("scripts")).expect("scripts dir");
        std::fs::write(
            project_root.path().join("scripts/apply-skill.ts"),
            "// noop\n",
        )
        .expect("script");

        let bin_dir = TempDir::new().expect("temp bin");
        std::fs::write(bin_dir.path().join("nanoclaw"), "#!/bin/sh\n").expect("binary");

        let provider = NanoclawProvider::with_test_context(
            project_root.path().to_path_buf(),
            vec![bin_dir.path().to_path_buf()],
        );
        let detection = provider.detect();

        assert!(detection.detected);
        assert!(detection.confidence > 0.8);
        assert!(
            detection
                .evidence
                .iter()
                .any(|entry| entry.contains("found scripts/apply-skill.ts"))
        );
    }

    #[test]
    fn format_inbound_uses_body_payload_shape() {
        let provider = NanoclawProvider::default();

        let request = provider.format_inbound(&InboundMessage {
            sender_did: "did:claw:sender".to_string(),
            recipient_did: "did:claw:recipient".to_string(),
            content: "hello".to_string(),
            request_id: Some("req-123".to_string()),
            metadata: HashMap::new(),
        });

        assert!(request.headers.is_empty());
        assert_eq!(
            request.body.get("userId").and_then(|value| value.as_str()),
            Some("did:claw:sender")
        );
        assert_eq!(
            request.body.get("content").and_then(|value| value.as_str()),
            Some("hello")
        );
    }

    #[test]
    fn config_path_points_to_project_env_file() {
        let project_root = TempDir::new().expect("temp project");
        let provider =
            NanoclawProvider::with_test_context(project_root.path().to_path_buf(), Vec::new());

        assert_eq!(
            provider.config_path(),
            Some(project_root.path().join(".env"))
        );
    }
}
