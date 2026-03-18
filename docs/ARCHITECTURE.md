# Clawdentity Architecture

Deep technical reference for the full Clawdentity monorepo (TypeScript apps/packages and Rust crates).

For quick start and product framing, see `../README.md`.

---

## Table of Contents

- [1) System Overview](#1-system-overview)
  - [Why Clawdentity Exists](#why-clawdentity-exists)
  - [Monorepo Runtime Topology](#monorepo-runtime-topology)
  - [Agent-to-Agent Communication: Complete Flow](#agent-to-agent-communication-complete-flow)
  - [Verification Pipeline](#verification-pipeline)
  - [Operator Controls](#operator-controls)
- [2) Apps Architecture](#2-apps-architecture)
  - [Registry API (`apps/registry`)](#registry-api-appsregistry)
  - [Proxy Relay (`apps/proxy`)](#proxy-relay-appsproxy)
  - [OpenClaw Skill (`apps/openclaw-skill`)](#openclaw-skill-appsopenclaw-skill)
  - [Deployment Model](#deployment-model)
- [3) Packages Architecture](#3-packages-architecture)
  - [Protocol (`packages/protocol`)](#protocol-packagesprotocol)
  - [SDK (`packages/sdk`)](#sdk-packagessdk)
  - [Connector (`packages/connector`)](#connector-packagesconnector)
  - [Common (`packages/common`)](#common-packagescommon)
- [4) Rust Implementation](#4-rust-implementation)
  - [Workspace Scope](#workspace-scope)
  - [Module Dependency Graph](#module-dependency-graph)
  - [Rust Data Flows](#rust-data-flows)
  - [Rust Types, Storage, and Security](#rust-types-storage-and-security)
  - [Provider and Runtime Model](#provider-and-runtime-model)
- [5) Integration Points](#5-integration-points)
  - [TypeScript SDK <-> Rust Runtime](#typescript-sdk---rust-runtime)
  - [Registry/Proxy Contract Reuse](#registryproxy-contract-reuse)
  - [CLI Runtime Boundary](#cli-runtime-boundary)
  - [Skill and OpenClaw Boundary](#skill-and-openclaw-boundary)
  - [Cross-Ecosystem Testing Strategy](#cross-ecosystem-testing-strategy)
- [MVP Goals](#mvp-goals)

---

## 1) System Overview

### Why Clawdentity Exists

OpenClaw webhooks provide transport but rely on a shared hook token. Shared-token models make per-agent identity, revocation, and auditability difficult.

Clawdentity adds a cryptographic identity and policy layer in front of webhook delivery:

- each agent has a DID + signed AIT (Agent Identity Token)
- every relay request carries proof-of-possession signatures
- proxy verification happens before OpenClaw receives traffic
- revocation and trust controls can be applied per identity

### Monorepo Runtime Topology

```text
Human Operator
  |
  | uses CLI + onboarding
  v
+--------------------------+
| crates/clawdentity-cli   |
+-------------+------------+
              |
              | identity bootstrap / invite / pairing / config
              v
+--------------------------+      +--------------------------+
| apps/registry            |<---->| packages/sdk             |
| Cloudflare Worker (API)  |      | TS sign/verify/auth libs |
+-------------+------------+      +--------------------------+
              |
              | issues AIT, keys, CRL, invite/API key metadata
              v
+--------------------------+
| apps/proxy               |
| Cloudflare Worker relay  |
+-------------+------------+
              |
              | verified forwarding
              v
+--------------------------+
| OpenClaw gateway         |
| (localhost/private)      |
+--------------------------+

Rust runtime side:
- crates/clawdentity-core: local identity/connector/runtime/provider stack
- crates/clawdentity-cli: Rust CLI control plane and daemon entrypoint
```

### Agent-to-Agent Communication: Complete Flow

#### Overview

```text
+--------------------------------------------------------------------------+
|                           CLAWDENTITY REGISTRY                            |
| Issues identities (AIT), keys, CRL, invites, API keys, pairing metadata  |
+-----------------------+-------------------------------+------------------+
                        |                               |
                 issues AIT/auth                 issues AIT/auth
                        |                               |
         +--------------v-------------+   +-------------v--------------+
         | Agent Alice                 |   | Agent Bob                  |
         | DID + local private key     |   | DID + local private key    |
         +--------------+-------------+   +-------------+--------------+
                        |                               |
                 signs every request             signs every request
                        |                               |
                        +---------------+---------------+
                                        |
                                        v
                           +-----------------------------+
                           | Alice Proxy (apps/proxy)    |
                           | verify AIT/PoP/replay/CRL   |
                           | enforce trust + rate limit  |
                           +--------------+--------------+
                                          |
                                   forward if valid
                                          |
                                          v
                           +-----------------------------+
                           | Alice OpenClaw (localhost)  |
                           +-----------------------------+
```

#### Step 1: Human Onboarding (Starter Pass or Invite)

Hosted public onboarding uses GitHub OAuth to mint a one-time starter pass. Private and self-hosted
operators can still create invite codes for controlled onboarding.

```text
Hosted public path:
User -> registry OAuth -> starter pass -> redeem -> persist API key + human config

Private/self-hosted path:
Admin -> registry: create invite
Operator -> registry: redeem invite
Operator local state: persist API key + human config
```

Security notes:
- starter passes are one-time codes tied to a GitHub account and limited to one agent ever
- invite codes are intended for controlled onboarding and may expire
- API key is displayed once and stored locally

#### Step 2: Agent Identity Creation (Challenge-Response)

```text
CLI on operator machine:
1) generate Ed25519 keypair (private key stays local)
2) POST /v1/agents/challenge with public key
3) sign challenge with private key
4) POST /v1/agents with challenge signature
5) persist {identity, ait, auth} under ~/.clawdentity
```

Typical persisted artifacts:

```text
~/.clawdentity/.../agents/<name>/
  - secret.key
  - public.key
  - ait.jwt
  - identity.json
  - registry-auth.json
```

AIT claims used throughout flows:

| Claim | Purpose |
|------|---------|
| `sub` | Agent DID (`did:cdi:<authority>:agent:<ulid>`) |
| `ownerDid` | Owning human DID |
| `cnf.jwk.x` | Public key material for PoP verification |
| `jti` | Token identifier for revocation checks |
| `iss` | Registry issuer |
| `exp` | Credential expiry |

#### Step 3: Peer Routing Setup (Out-of-Band Metadata)

Operators exchange non-secret routing metadata (alias, DID, proxy URL), then configure peer routing.

No private keys or hook secrets are exchanged between peers.

#### Step 4: First Message (Bob -> Alice)

Bob connector/relay transform builds signed request:

- `Authorization: Claw <AIT>`
- `X-Claw-Timestamp`
- `X-Claw-Nonce`
- `X-Claw-Body-SHA256`
- `X-Claw-Proof`
- optional agent-access token for proxy policy checks

Alice proxy validates before forwarding to OpenClaw hook endpoint.

### Verification Pipeline

| Check | Failure code | HTTP | Meaning |
|------|---------------|------|---------|
| AIT signature | `PROXY_AUTH_INVALID_AIT` | 401 | forged/tampered identity token |
| Timestamp skew | `PROXY_AUTH_TIMESTAMP_SKEW` | 401 | stale/future request |
| PoP signature | `PROXY_AUTH_INVALID_PROOF` | 401 | signer lacks key ownership |
| Nonce replay | `PROXY_AUTH_REPLAY` | 401 | replay attempt |
| CRL revocation | `PROXY_AUTH_REVOKED` | 401 | revoked identity |
| Trust policy | `PROXY_AUTH_FORBIDDEN` | 403 | valid identity, not trusted target |
| Agent access token | `PROXY_AGENT_ACCESS_INVALID` | 401 | auth token invalid/expired |
| Rate limit | `PROXY_RATE_LIMIT_EXCEEDED` | 429 | per-agent quota exceeded |

### Operator Controls

Sender-side controls (owner/admin):
- registry-level revoke (`DELETE /v1/agents/:id`) for ecosystem-wide invalidation

Receiver-side controls (callee gateway owner):
- local trust allow/deny for immediate local enforcement

Key distinction:
- global revoke authority stays with owner/admin through registry
- receiver can block locally without globally revoking foreign identities

---

## 2) Apps Architecture

### Registry API (`apps/registry`)

Primary responsibilities:
- issue and refresh agent identity artifacts
- manage humans, invites, API keys, revocations
- publish verification metadata (keys/CRL)
- provide health/version/environment endpoint for deployment checks

Implementation profile:
- Hono app on Cloudflare Workers
- D1 (SQLite) via Drizzle schema/migrations
- environment split via Wrangler (`dev`, `production`)

Core domain entities:
- humans
- agents
- revocations
- api_keys
- invites

### Proxy Relay (`apps/proxy`)

Primary responsibilities:
- receive signed relay traffic
- verify AIT + request PoP + nonce/timestamp
- enforce trust policy and rate limits
- forward verified requests to local OpenClaw gateway with hook token injection

Operational behavior:
- shields OpenClaw from direct internet exposure
- supports local/dev/fresh Wrangler run modes
- can inject sanitized identity metadata into forwarded message payloads

### OpenClaw Skill (`apps/openclaw-skill`)

Primary responsibilities:
- provide OpenClaw skill instructions and relay transform script payloads
- integrate with the Rust installer (`clawdentity install --for openclaw`)
- enable peer-directed message relay from OpenClaw workflows
- preserve OpenClaw-owned config and auth semantics while layering Clawdentity relay assets on top

Installed artifacts include:
- `~/.openclaw/skills/clawdentity-openclaw-relay/SKILL.md`
- `~/.openclaw/skills/clawdentity-openclaw-relay/references/*`
- `~/.openclaw/hooks/transforms/relay-to-peer.mjs`

### Deployment Model

Repository uses pnpm workspaces + Nx orchestration.

Deployed services:
- registry Worker (`apps/registry`) with D1 migrations before deploy
- proxy Worker (`apps/proxy`)

Local operator/developer flows:
- `pnpm dev:registry` / `pnpm dev:registry:local`
- `pnpm dev:proxy` / `pnpm dev:proxy:local` / `pnpm dev:proxy:fresh`

CI/deploy expectations:
- quality gates before deployment
- health checks validate deployed `version` and environment status

---

## 3) Packages Architecture

The `packages/` layer defines reusable runtime and protocol contracts shared across deployable apps and tooling.

### Protocol (`packages/protocol`)

Role:
- canonical source for DID formats, token/claim types, relay proof fields, and endpoint contracts

Design implications:
- protocol changes are compatibility changes
- registry/proxy/CLI/runtime must evolve in lockstep with protocol package updates

### SDK (`packages/sdk`)

Role:
- high-level developer primitives for auth, signing, verification, key handling, and registry interaction

Typical usage:
- registry/proxy app logic reuse
- client-side or tooling-side verification and auth helpers
- testing utilities (`@clawdentity/sdk/testing` export)

### Connector (`packages/connector`)

Role:
- TypeScript connector client/runtime primitives for relay connectivity and transport operations

Design concerns:
- frame and transport semantics must remain consistent with proxy/runtime expectations
- connector state and retry behavior should avoid delivery loss and replay ambiguity

### Common (`packages/common`)

Role:
- shared utility layer: errors, small reusable helpers, shared validation/types

Design rule:
- keep common package narrow and dependency-light to avoid accidental coupling

---

## 4) Rust Implementation

This section preserves the Rust architecture model originally documented for `crates/clawdentity-core` and `crates/clawdentity-cli`, now integrated into monorepo-level docs.

### Workspace Scope

Rust workspace members:
- `clawdentity-core`
- `clawdentity-cli`
- `tests/local/mock-registry`
- `tests/local/mock-proxy`

Logical runtime path:

```text
Agent <-> Connector <-> Registry <-> Relay <-> Provider <-> Platform
```

Implemented crate roles:
- `clawdentity-core`: identity, registry client, connector, runtime, providers, pairing, db, verify
- `clawdentity-cli`: command surface and daemon start path

### Module Dependency Graph

High-level source dependency direction:

```text
                  +-------------------+
                  |      error        |
                  +---------+---------+
                            |
+-----------+     +---------v---------+     +----------------+
| constants |---->|      identity     |<----|    registry    |
+-----------+     +----+---------+----+     +--------+-------+
                       |         |                   |
+-----------+          |         |                   |
|   http    |----------+         |                   |
+-----------+                    |                   v
                                 |             +-----+------+
                           +-----+------+      |     db      |
                           |    verify   |<----+------------+
                           +-----+------+            ^
                                 ^                   |
                                 |             +-----+------+
                           +-----+------+      |   pairing   |
                           |  providers  |------+------------+
                           +-----+------+            ^
                                 ^                   |
                                 +-----------+-------+
                                             |
                                       +-----+------+
                                       |  connector  |
                                       +-----+------+
                                             |
                                       +-----v------+
                                       |   runtime   |
                                       +------------+
```

Structural rules enforced by Rust tests (`clawdentity-core/tests/structural.rs`):
- `providers` cannot import `runtime`
- `connector` cannot import `providers`
- no `.unwrap()` outside tests
- no Rust source file above 800 lines

### Rust Data Flows

#### Registration flow

```text
agent create
 -> generate Ed25519 keypair
 -> POST /v1/agents/challenge
 -> sign canonical challenge proof
 -> POST /v1/agents
 -> persist agent artifacts under ~/.clawdentity state path
```

#### Pairing flow

```text
POST /pair/start
 -> sign /pair/start request
 -> receive ticket (+ optional QR persistence)

POST /pair/confirm
 -> parse ticket/QR
 -> sign /pair/confirm
 -> persist peer alias + proxy URL in SQLite
 -> optionally sync OpenClaw peer snapshot
```

#### Message relay flow

Outbound path:

```text
POST /v1/outbound (runtime)
 -> enqueue outbound row
 -> relay flush to websocket enqueue frame
 -> proxy routes to destination
```

Inbound path:

```text
websocket Deliver frame
 -> connector forwards to provider hook
 -> success: append delivered event
 -> failure: persist inbound_pending + negative ack
```

Connector lifecycle:

```text
connector start
 -> resolve agent material + proxy URL + signed headers
 -> spawn websocket client (heartbeat + reconnect)
 -> run runtime HTTP server (/v1/status, /v1/outbound, dead-letter APIs)
 -> inbound loop + outbound flush loop
 -> graceful shutdown on signal
```

For OpenClaw specifically, `connector start` is the manual/advanced runtime path. The normal recovery order is:
- `openclaw onboard` if OpenClaw has not been initialized yet
- `openclaw doctor --fix` if `openclaw.json` or device/auth state is broken
- `clawdentity install --for openclaw` and `clawdentity provider setup --for openclaw --agent-name <agent-name>` once OpenClaw itself is healthy
- `openclaw dashboard` for a quick local UI check

### Rust Types, Storage, and Security

Identity/signing:
- DID format: `did:cdi:<authority>:{human|agent}:<ULID>`
- signing primitive: Ed25519
- proof headers: timestamp/nonce/body-hash/proof signature

Storage model (`rusqlite`, WAL mode):
- `schema_migrations`
- `peers`
- `outbound_queue`
- `outbound_dead_letter`
- `inbound_pending`
- `inbound_dead_letter`
- `inbound_events`
- `verify_cache`

Migration approach:
- embedded SQL migrations applied at startup
- idempotency tracked via `schema_migrations`

Verification model:
- fetch keys from `/.well-known/claw-keys.json`
- verify signed CRL and revocation status
- cache verification payloads with TTL in `verify_cache`

### Provider and Runtime Model

Provider abstraction (`PlatformProvider` trait):
- detect/install/verify/doctor/setup/relay-test + inbound formatting hooks

Current provider implementations:
- OpenClaw
- PicoClaw
- NanoBot
- NanoClaw

Operational invariants:
- structural tests enforce architecture constraints
- `/v1/status` is primary runtime health endpoint
- local mock services (`mock-registry`, `mock-proxy`) support integration harness coverage

---

## 5) Integration Points

### TypeScript SDK <-> Rust Runtime

Shared contract surfaces:
- DID syntax and identity semantics
- AIT claims, issuer/subject constraints, and expiry rules
- proof header canonicalization expectations
- CRL and key-discovery behavior

Practical consequence:
- any protocol or claim-shape change must update both ecosystems and test fixtures together

### Registry/Proxy Contract Reuse

Both TypeScript and Rust implementations consume the same logical API surfaces:
- registry metadata
- agent challenge/register flows
- invite/API key/admin bootstrap endpoints
- pairing and trust policy endpoints
- verification key/CRL retrieval endpoints

The proxy is the security choke point regardless of client implementation language.

### CLI Runtime Boundary

Current state:
- Rust CLI (`crates/clawdentity-cli`) is the only supported operator surface
- release automation, pairing, verification, provider install/setup, and connector runtime ship from the same binary

Runtime rule:
- command UX, config path semantics, and JSON contracts must stay stable across interactive and daemon-style Rust command paths
- OpenClaw skill assets remain source-controlled under `apps/openclaw-skill`, then are copied into Rust-owned release assets before publish

### Skill and OpenClaw Boundary

Integration responsibilities split as:
- skill package provides OpenClaw-native workflow surface
- CLI installs/updates skill artifacts
- connector/runtime performs authenticated relay transport
- proxy validates identity/policy before OpenClaw hook delivery

OpenClaw hook token handling rule:
- keep hook token private on gateway/proxy side
- never share hook token across peer operators

### Cross-Ecosystem Testing Strategy

TypeScript side:
- Vitest for package/app tests
- Hono apps tested via `app.request()` with mocked bindings

Rust side:
- `cargo test` with structural gates + unit/integration coverage
- mock-registry and mock-proxy crates for local relay/identity scenarios

Monorepo baseline validation:
- `pnpm build`
- `cargo check`

---

## MVP Goals

1. Create agent identity (local keypair + registry-issued AIT)
2. Send signed relay requests with replay resistance
3. Verify identity and policy at proxy before OpenClaw delivery
4. Revoke compromised identities with bounded propagation delay
5. Support operator-friendly discovery and first-contact pairing
