use std::path::{Path, PathBuf};

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

pub(super) struct OpenclawAsset {
    pub(super) path: PathBuf,
    pub(super) bytes: &'static [u8],
    pub(super) install_note: &'static str,
}

pub(super) fn openclaw_assets(openclaw_dir: &Path) -> [OpenclawAsset; 6] {
    [
        OpenclawAsset {
            path: skill_root(openclaw_dir).join("SKILL.md"),
            bytes: SKILL_MD.as_bytes(),
            install_note: "installed OpenClaw skill guide",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-environment.md"),
            bytes: REFERENCE_ENVIRONMENT.as_bytes(),
            install_note: "installed OpenClaw skill environment reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-protocol.md"),
            bytes: REFERENCE_PROTOCOL.as_bytes(),
            install_note: "installed OpenClaw skill protocol reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir)
                .join("references")
                .join("clawdentity-registry.md"),
            bytes: REFERENCE_REGISTRY.as_bytes(),
            install_note: "installed OpenClaw skill registry reference",
        },
        OpenclawAsset {
            path: skill_root(openclaw_dir).join(RELAY_MODULE_FILE_NAME),
            bytes: RELAY_MODULE,
            install_note: "installed OpenClaw relay transform bundle",
        },
        OpenclawAsset {
            path: transform_target_path(openclaw_dir),
            bytes: RELAY_MODULE,
            install_note: "installed OpenClaw hook relay transform",
        },
    ]
}
