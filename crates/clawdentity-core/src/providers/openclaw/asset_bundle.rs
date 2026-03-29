use std::path::{Path, PathBuf};

use crate::providers::read_text;

use super::{skill_root, transform_target_path};

pub const SKILL_DIR_NAME: &str = "clawdentity-openclaw-relay";
pub const RELAY_MODULE_FILE_NAME: &str = "relay-to-peer.mjs";
pub const RELAY_RUNTIME_FILE_NAME: &str = "clawdentity-relay.json";
pub const RELAY_PEERS_FILE_NAME: &str = "clawdentity-peers.json";

const SKILL_MD: &str = include_str!("../../../assets/openclaw-skill/skill/SKILL.md");
const REFERENCE_ENVIRONMENT: &str =
    include_str!("../../../assets/openclaw-skill/skill/references/clawdentity-environment.md");
const REFERENCE_PROTOCOL: &str =
    include_str!("../../../assets/openclaw-skill/skill/references/clawdentity-protocol.md");
const REFERENCE_REGISTRY: &str =
    include_str!("../../../assets/openclaw-skill/skill/references/clawdentity-registry.md");
const RELAY_MODULE: &[u8] =
    include_bytes!("../../../assets/openclaw-skill/transform/relay-to-peer.mjs");
const DEFAULT_SITE_BASE_URL: &str = "https://clawdentity.com";
const SITE_BASE_URL_ENV: &str = "CLAWDENTITY_SITE_BASE_URL";

pub(super) struct OpenclawAsset {
    pub(super) path: PathBuf,
    pub(super) bytes: Vec<u8>,
    pub(super) install_note: &'static str,
}

fn trim_trailing_slash(value: &str) -> &str {
    value.trim_end_matches('/')
}

fn strip_unquoted_inline_comment(raw_value: &str) -> &str {
    let mut in_single_quotes = false;
    let mut in_double_quotes = false;

    for (index, ch) in raw_value.char_indices() {
        match ch {
            '\'' if !in_double_quotes => in_single_quotes = !in_single_quotes,
            '"' if !in_single_quotes => in_double_quotes = !in_double_quotes,
            '#' if !in_single_quotes
                && !in_double_quotes
                && raw_value[..index]
                    .chars()
                    .last()
                    .is_some_and(char::is_whitespace) =>
            {
                return raw_value[..index].trim_end();
            }
            _ => {}
        }
    }

    raw_value
}

fn parse_env_value(contents: &str, key: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let (line_key, raw_value) = line.split_once('=')?;
        if line_key.trim() != key {
            return None;
        }

        let value = strip_unquoted_inline_comment(raw_value)
            .trim()
            .trim_matches('"')
            .trim_matches('\'');
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn resolve_site_base_url(openclaw_dir: &Path) -> crate::error::Result<String> {
    if let Ok(value) = std::env::var(SITE_BASE_URL_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Ok(trim_trailing_slash(trimmed).to_string());
        }
    }

    let env_path = openclaw_dir.join(".env");
    let env_contents = read_text(&env_path)?.unwrap_or_default();
    Ok(parse_env_value(&env_contents, SITE_BASE_URL_ENV)
        .map(|value| trim_trailing_slash(&value).to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_SITE_BASE_URL.to_string()))
}

fn render_skill_markdown(site_base_url: &str) -> String {
    [
        (
            "https://clawdentity.com/skill.md",
            format!("{site_base_url}/skill.md"),
        ),
        (
            "https://clawdentity.com/install.sh",
            format!("{site_base_url}/install.sh"),
        ),
        (
            "https://clawdentity.com/install.ps1",
            format!("{site_base_url}/install.ps1"),
        ),
        ("<skill-origin>/install.sh", format!("{site_base_url}/install.sh")),
        (
            "<skill-origin>/install.ps1",
            format!("{site_base_url}/install.ps1"),
        ),
    ]
    .into_iter()
    .fold(SKILL_MD.to_string(), |rendered, (from, to)| {
        rendered.replace(from, &to)
    })
}

pub(super) fn openclaw_assets(openclaw_dir: &Path) -> crate::error::Result<Vec<OpenclawAsset>> {
    let skill_markdown = render_skill_markdown(&resolve_site_base_url(openclaw_dir)?);
    Ok(vec![
        OpenclawAsset {
            path: skill_root(openclaw_dir).join("SKILL.md"),
            bytes: skill_markdown.into_bytes(),
            install_note: "installed OpenClaw skill guide",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-environment.md"),
            bytes: REFERENCE_ENVIRONMENT.as_bytes().to_vec(),
            install_note: "installed OpenClaw skill environment reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-protocol.md"),
            bytes: REFERENCE_PROTOCOL.as_bytes().to_vec(),
            install_note: "installed OpenClaw skill protocol reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-registry.md"),
            bytes: REFERENCE_REGISTRY.as_bytes().to_vec(),
            install_note: "installed OpenClaw skill registry reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir).join(RELAY_MODULE_FILE_NAME),
            bytes: RELAY_MODULE.to_vec(),
            install_note: "installed OpenClaw relay transform bundle",
        },
        OpenclawAsset {
            path: transform_target_path(openclaw_dir),
            bytes: RELAY_MODULE.to_vec(),
            install_note: "installed OpenClaw hook relay transform",
        },
    ])
}
