pub mod agent;
pub mod config;
pub mod did;
pub mod error;
pub mod identity;
pub mod registry;
pub mod signing;

pub use agent::{
    AgentAuthRefreshResult, AgentAuthRevokeResult, AgentCreateResult, AgentIdentityRecord,
    AgentInspectResult, CreateAgentInput, create_agent, inspect_agent, refresh_agent_auth,
    revoke_agent_auth,
};
pub use config::{
    CliConfig, CliStateKind, ConfigKey, ConfigPathOptions, DEFAULT_REGISTRY_URL, get_config_dir,
    get_config_file_path, get_config_root_dir, get_config_value, read_config, resolve_config,
    resolve_state_kind_from_registry_url, set_config_value, write_config,
};
pub use did::{ParsedDid, make_did_for_registry_host, parse_did};
pub use error::{CoreError, Result};
pub use identity::{
    LocalIdentity, PublicIdentityView, decode_secret_key, init_identity, read_identity,
};
pub use registry::{
    RegisterIdentityResult, RegistryMetadata, fetch_registry_metadata, register_identity,
};
pub use signing::{
    SignHttpRequestInput, SignedRequest, X_CLAW_BODY_SHA256, X_CLAW_NONCE, X_CLAW_PROOF,
    X_CLAW_TIMESTAMP, canonicalize_request, hash_body_sha256_base64url, sign_http_request,
};
