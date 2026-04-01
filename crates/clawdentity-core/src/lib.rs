//! Core Clawdentity library modules and public exports.

pub mod connector;
pub mod constants;
pub mod db;
pub mod error;
pub mod http;
pub mod identity;
pub mod pairing;
pub mod providers;
pub mod registry;
pub mod runtime;
pub mod verify;

// Backward-compatible module aliases for the previous flat layout.
pub use connector::client as connector_client;
pub use connector::frames as connector_frames;
pub use connector::service;
pub use db::inbound as db_inbound;
pub use db::outbound as db_outbound;
pub use db::peers as db_peers;
pub use db::verify_cache as db_verify_cache;
pub use identity::config;
pub use identity::did;
pub use identity::signing;
pub use pairing::peers;
pub use pairing::qr;
pub use providers as provider;
pub use providers::hermes as provider_hermes;
pub use providers::nanobot as provider_nanobot;
pub use providers::nanoclaw as provider_nanoclaw;
pub use providers::openclaw as provider_openclaw;
pub use providers::picoclaw as provider_picoclaw;
pub use registry::admin;
pub use registry::agent;
pub use registry::api_key;
pub use registry::crl;
pub use registry::group;
pub use registry::invite;
pub use runtime::auth as runtime_auth;
pub use runtime::openclaw as runtime_openclaw;
pub use runtime::relay as runtime_relay;
pub use runtime::replay as runtime_replay;
pub use runtime::server as runtime_server;
pub use runtime::trusted_receipts as runtime_trusted_receipts;

pub use admin::{
    AdminApiKey, AdminBootstrapInput, AdminBootstrapResult, AdminHuman, AdminInternalService,
    bootstrap_admin, persist_bootstrap_config,
};
pub use agent::{
    AgentAuthRefreshResult, AgentAuthRevokeResult, AgentCreateResult, AgentIdentityRecord,
    AgentInspectResult, CreateAgentInput, create_agent, inspect_agent, refresh_agent_auth,
    revoke_agent_auth,
};
pub use api_key::{
    ApiKeyCreateInput, ApiKeyCreateResult, ApiKeyListInput, ApiKeyListResult, ApiKeyMetadata,
    ApiKeyRevokeInput, ApiKeyRevokeResult, ApiKeyWithToken, create_api_key, list_api_keys,
    revoke_api_key,
};
pub use config::{
    CliConfig, CliStateKind, ConfigKey, ConfigPathOptions, DEFAULT_REGISTRY_URL, get_config_dir,
    get_config_file_path, get_config_root_dir, get_config_value, read_config, resolve_config,
    resolve_state_kind_from_registry_url, set_config_value, write_config,
};
pub use connector_client::{
    ConnectorClient, ConnectorClientMetricsSnapshot, ConnectorClientOptions, ConnectorClientSender,
    spawn_connector_client,
};
pub use connector_frames::{
    CONNECTOR_FRAME_VERSION, ConnectorFrame, DeliverAckFrame, DeliverFrame, EnqueueAckFrame,
    EnqueueFrame, HeartbeatAckFrame, HeartbeatFrame, ReceiptFrame, ReceiptStatus, new_frame_id,
    now_iso, parse_frame, serialize_frame, validate_frame,
};
pub use crl::{
    CRL_CACHE_TTL_MS, CrlClaims, CrlRevocation, CrlVerificationKey, is_jti_revoked, load_crl_claims,
};
pub use db::{SQLITE_FILE_NAME, SqliteStore, now_utc_ms};
pub use db_inbound::{
    InboundDeadLetterItem, InboundEvent, InboundPendingItem, append_inbound_event,
    dead_letter_count, delete_pending, get_pending, list_dead_letter, list_inbound_events,
    list_pending_due, mark_pending_attempt, move_pending_to_dead_letter, pending_count,
    purge_dead_letter, replay_dead_letter, upsert_pending,
};
pub use db_outbound::{
    EnqueueOutboundInput, OutboundDeadLetterItem, OutboundQueueItem, delete_outbound,
    enqueue_outbound, list_outbound, list_outbound_dead_letter, move_outbound_to_dead_letter,
    outbound_count, outbound_dead_letter_count, outbound_queue_stats, requeue_outbound_retry,
    take_due_outbound,
};
pub use db_peers::{
    PeerRecord, UpsertPeerInput, delete_peer, get_peer_by_alias, get_peer_by_did, list_peers,
    upsert_peer,
};
pub use db_verify_cache::{
    VerifyCacheEntry, delete_verify_cache_entry, get_verify_cache_entry, purge_verify_cache_before,
    upsert_verify_cache_entry,
};
pub use did::{
    DidEntity, ParsedDid, did_authority_from_url, make_agent_did, make_did, make_human_did,
    new_agent_did, new_human_did, normalize_did_authority, parse_agent_did, parse_did,
    parse_group_id, parse_human_did,
};
pub use error::{CoreError, Result};
pub use group::{
    GroupCreateInput, GroupCreateResult, GroupInspectInput, GroupInspectResult, GroupJoinInput,
    GroupJoinResult, GroupJoinTokenCreateInput, GroupJoinTokenCreateResult, GroupJoinTokenRecord,
    GroupMemberRecord, GroupMembersListGroup, GroupMembersListInput, GroupMembersListResult,
    GroupRecord, GroupRole, create_group, create_group_join_token,
    fetch_group_member_dids_with_agent_auth, fetch_group_name_with_agent_auth, inspect_group,
    join_group, list_group_members,
};
pub use identity::{
    LocalIdentity, PublicIdentityView, decode_secret_key, init_identity, read_identity,
};
pub use invite::{
    InviteCreateInput, InviteCreateResult, InviteRecord, InviteRedeemInput, InviteRedeemResult,
    create_invite, persist_redeem_config, redeem_invite,
};
pub use pairing::{
    DEFAULT_STATUS_POLL_INTERVAL_SECONDS, DEFAULT_STATUS_WAIT_SECONDS, PAIR_CONFIRM_PATH,
    PAIR_START_PATH, PAIR_STATUS_PATH, PAIRING_TICKET_PREFIX, PairConfirmInput, PairConfirmResult,
    PairProfile, PairStartResult, PairStatusKind, PairStatusOptions, PairStatusResult,
    assert_ticket_issuer_matches_proxy, confirm_pairing, get_pairing_status, parse_pairing_ticket,
    parse_pairing_ticket_issuer_origin, persist_confirmed_peer_from_profile_and_proxy_origin,
    start_pairing,
};
pub use peers::{
    PeerEntry, PeersConfig, PersistPeerInput, derive_peer_alias_base, load_peers_config,
    persist_peer, resolve_peer_alias, sync_openclaw_relay_peers_snapshot,
};
pub use provider::{
    DetectionResult, InboundMessage, InboundRequest, InstallOptions, InstallResult,
    PlatformProvider, ProviderDoctorCheck, ProviderDoctorCheckStatus, ProviderDoctorOptions,
    ProviderDoctorResult, ProviderDoctorStatus, ProviderRelayTestOptions, ProviderRelayTestResult,
    ProviderRelayTestStatus, ProviderSetupOptions, ProviderSetupResult, ProviderSetupStatus,
    VerifyOptions, VerifyResult as ProviderVerifyResult, all_providers, detect_platform,
    get_provider,
};
pub use provider_openclaw::{
    DoctorCheckStatus, DoctorStatus, OPENCLAW_AGENT_FILE_NAME, OPENCLAW_CONNECTORS_FILE_NAME,
    OPENCLAW_DEFAULT_BASE_URL, OPENCLAW_RELAY_RUNTIME_FILE_NAME, OpenclawConnectorAssignment,
    OpenclawConnectorsConfig, OpenclawDoctorCheck, OpenclawDoctorOptions, OpenclawDoctorResult,
    OpenclawRelayRuntimeConfig, OpenclawRelayTestOptions, OpenclawRelayTestResult,
    OpenclawRelayWebsocketTestOptions, OpenclawRelayWebsocketTestResult, RelayCheckStatus,
    load_connector_assignments, load_relay_runtime_config, openclaw_agent_name_path,
    openclaw_connectors_path, openclaw_relay_runtime_path, read_selected_openclaw_agent,
    resolve_connector_base_url, resolve_openclaw_base_url, resolve_openclaw_hook_token,
    run_openclaw_doctor, run_openclaw_relay_test, run_openclaw_relay_websocket_test,
    save_connector_assignment, save_relay_runtime_config, write_selected_openclaw_agent,
};
pub use qr::{
    PAIRING_QR_DIR_NAME, PAIRING_QR_MAX_AGE_SECONDS, decode_ticket_from_png, encode_ticket_qr_png,
    persist_pairing_qr,
};
pub use registry::{
    RegisterIdentityResult, RegistryAgentProfile, RegistryMetadata, fetch_registry_agent_profile,
    fetch_registry_metadata, register_identity,
};
pub use runtime_auth::{RelayConnectHeaders, build_relay_connect_headers};
pub use runtime_openclaw::{OpenclawRuntimeConfig, check_openclaw_gateway_health};
pub use runtime_relay::{
    FlushOutboundResult, OutboundRetryPolicy, OutboundSendObservation, SentOutboundFrame,
    flush_outbound_queue_to_relay, flush_outbound_queue_to_relay_with_send_observer,
    flush_outbound_queue_to_relay_with_sent_observer,
};
pub use runtime_replay::{
    PurgeResult, ReplayResult, purge_dead_letter_messages, replay_dead_letter_messages,
};
pub use runtime_server::{RuntimeServerState, create_runtime_router, run_runtime_server};
pub use runtime_trusted_receipts::TrustedReceiptsStore;
pub use service::{
    ConnectorServiceInstallInput, ConnectorServiceInstallResult, ConnectorServicePlatform,
    ConnectorServiceUninstallInput, ConnectorServiceUninstallResult, install_connector_service,
    parse_connector_service_platform, sanitize_service_segment, uninstall_connector_service,
};
pub use signing::{
    SignHttpRequestInput, SignedRequest, X_CLAW_BODY_SHA256, X_CLAW_NONCE, X_CLAW_PROOF,
    X_CLAW_TIMESTAMP, canonicalize_request, hash_body_sha256_base64url, sign_http_request,
};
pub use verify::{
    REGISTRY_KEYS_CACHE_TTL_MS, RegistrySigningKey, RegistryVerificationKey, VerifiedAitClaims,
    VerifyResult, expected_issuer_for_registry, verify_ait_token_with_registry,
};
