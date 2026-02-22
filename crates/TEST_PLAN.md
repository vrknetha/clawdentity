# Clawdentity Rust CLI — Test Plan with Edge Cases

## Identity & Crypto
- Keypair with corrupted secret.key file
- Expired AIT (past expiry timestamp)
- AIT signed with wrong key (key mismatch)
- DID with invalid format (did:cdi: missing parts)
- DID with unknown registry host
- ULID parsing edge cases (too short, invalid chars)
- Ed25519 signature with tampered payload (single bit flip)
- Base64url vs base64 encoding mismatches

## Config & State
- First run with no ~/.clawdentity/ directory
- Corrupted config.toml (invalid TOML)
- Missing required fields in config
- Switching between prod/dev/local registries mid-session
- ENV vars overriding config file values
- Two CLI instances writing config simultaneously
- Config with unicode paths / spaces in home directory

## SQLite & Messages
- Send while offline → outbox queues → deliver on reconnect
- Outbox retry with max retries exhausted
- Duplicate message ID (idempotency check)
- SQLite DB locked by another process
- DB file corrupted / truncated
- Inbox query with 100K+ messages (pagination)
- Message with empty payload
- Message with 10MB payload (size limits)
- Concurrent reads/writes (WAL mode stress)
- DB migration on version upgrade (schema change)

## Proxy Connection
- Proxy unreachable on first connect
- WebSocket drops mid-message delivery
- WebSocket reconnect with exponential backoff (verify delays)
- SSE stream interrupted, auto-resume
- Proxy returns 429 (rate limit) → backoff
- Proxy returns 503 → retry vs give up
- Poll mode with no new messages (empty response)
- Poll mode with proxy timeout
- Switch from WebSocket to SSE fallback automatically
- Listen with --webhook but local endpoint is down
- Two clawdentity listen instances for same agent (conflict)

## Pairing
- Pair start → ticket expires before confirm
- Pair confirm with invalid/tampered ticket
- Pair confirm with already-used ticket
- Both agents try pair start simultaneously
- Pair with self (same DID)
- Network drop during pair confirm handshake
- QR code with max-length ticket data
- Pair recover when no pending pairing exists
- Pair with agent on different registry

## Trust & Verification
- Verify message from revoked agent
- CRL cache expired → refresh fails (network down)
- Registry signing keys rotated mid-verification
- Lookup agent that doesn't exist
- Revoke agent that was never trusted
- Revoke already-revoked agent (idempotent?)
- Peer with updated public key (key rotation)

## API Keys & Invites
- Create API key with duplicate name
- Revoke already-revoked key
- Use revoked key for auth (should fail)
- Redeem invite code twice
- Redeem expired invite code
- Create invite without admin privileges

## Service (launchd/systemd)
- Install service when already installed
- Uninstall service that doesn't exist
- Service status when daemon crashed
- Service install without root/sudo (permission error)
- Service with non-standard ~/.clawdentity path

## Doctor & Diagnostics
- Registry reachable but returns errors
- Proxy reachable but WebSocket upgrade fails
- Valid config but expired AIT
- Valid AIT but peer trust store empty
- CRL stale beyond threshold
- Multiple issues simultaneously (all checks fail)
- Doctor output in JSON mode for automation

## Cross-platform & Integration
- Two agents on same machine (different CLAWDENTITY_HOME)
- Agent A on OpenClaw, Agent B on NanoBot (via exec)
- Message from unknown agent (not in peers table)
- Large burst of messages (100 in 1 second)
- Clock skew between agents (timestamp validation)
