# Clawdentity Protocol Specification

**Version:** 0.1.0-draft  
**Status:** Draft  
**Authors:** Ravi Kiran (CAW Studios)  
**Date:** 2026-02-21  
**License:** MIT

---

## Abstract

Clawdentity defines a cryptographic identity and trust protocol for AI agent-to-agent communication. It enables agents to prove their identity, verify peers, establish mutual trust, and exchange messages through authenticated relay infrastructure — without exposing private keys, shared tokens, or backend services.

This document specifies the protocol's identity model, authentication mechanisms, message signing, relay transport, trust establishment, and revocation system.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Terminology](#2-terminology)
3. [Identity Model](#3-identity-model)
4. [Agent Identity Token (AIT)](#4-agent-identity-token-ait)
5. [HTTP Request Signing](#5-http-request-signing)
6. [Authentication Flow](#6-authentication-flow)
7. [Trust Establishment (Pairing)](#7-trust-establishment-pairing)
8. [Relay Transport](#8-relay-transport)
9. [Certificate Revocation](#9-certificate-revocation)
10. [Security Considerations](#10-security-considerations)
11. [Wire Formats](#11-wire-formats)
12. [Endpoints](#12-endpoints)
13. [Error Codes](#13-error-codes)
14. [IANA Considerations](#14-iana-considerations)
15. [References](#15-references)

---

## 1. Introduction

### 1.1 Problem Statement

Current AI agent frameworks rely on shared bearer tokens for inter-agent communication. This creates several problems:

- A single token leak compromises all agents
- No way to distinguish which agent sent a request
- Revoking one agent requires rotating the token for all
- No per-agent access control or rate limiting
- Backend services must be publicly exposed

### 1.2 Design Goals

Clawdentity addresses these problems with the following design goals:

1. **Individual identity** — Each agent has a unique cryptographic identity
2. **Proof of possession** — Every request proves the sender holds the private key
3. **Selective revocation** — One agent can be revoked without affecting others
4. **Zero-trust relay** — Agents communicate through authenticated proxies; backends stay private
5. **Human-anchored trust** — Trust originates from human approval, not agent self-certification
6. **Framework agnostic** — Works with any AI agent framework (OpenClaw, LangChain, CrewAI, etc.)

### 1.3 Architecture Overview

```
┌─────────────┐         ┌─────────────┐         ┌──────────────┐
│   Agent A    │         │  Registry   │         │   Agent B    │
│  (private)   │         │  (central)  │         │  (private)   │
└──────┬───────┘         └──────┬──────┘         └──────┬───────┘
       │                        │                        │
┌──────┴───────┐                │                ┌───────┴──────┐
│ Connector A  │                │                │ Connector B  │
│  (local)     │                │                │  (local)     │
└──────┬───────┘                │                └───────┬──────┘
       │  WebSocket             │                        │  WebSocket
┌──────┴───────┐                │                ┌───────┴──────┐
│   Proxy A    │◄───────────────┤────────────────│   Proxy B    │
│  (edge)      │                │                │  (edge)      │
└──────────────┘                │                └──────────────┘
                                │
                    ┌───────────┴───────────┐
                    │   .well-known/keys    │
                    │   /v1/crl             │
                    │   /v1/agents          │
                    └───────────────────────┘
```

**Components:**

- **Registry** — Central identity authority. Issues AITs, manages keys, publishes CRL.
- **Proxy** — Per-owner edge service. Verifies identity, enforces trust policy, relays messages.
- **Connector** — Local bridge between proxy and agent framework. Never exposed publicly.
- **Agent** — The AI agent itself. Has no knowledge of the protocol; the connector handles everything.

---

## 2. Terminology

| Term | Definition |
|------|-----------|
| **AIT** | Agent Identity Token. A JWT credential binding an agent DID to a public key. |
| **CRL** | Certificate Revocation List. A signed list of revoked AITs. |
| **DID** | Decentralized Identifier. A URI identifying a human or agent. |
| **Connector** | Local process that bridges the proxy relay to the agent framework. |
| **Proxy** | Edge service that authenticates requests and relays messages. |
| **Registry** | Central authority that issues identities and publishes signing keys. |
| **PoP** | Proof of Possession. A signature proving the sender holds the private key. |
| **Pairing** | Mutual trust establishment between two agents via ticket exchange. |
| **Trust Store** | Per-proxy database of known agents and approved pairs. |
| **ULID** | Universally Unique Lexicographically Sortable Identifier. |

**Key words:** "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHOULD", "MAY" are used as defined in [RFC 2119].

---

## 3. Identity Model

### 3.1 DID Format

Clawdentity uses a custom DID method: `did:claw`.

```
did:claw:<kind>:<ulid>
```

**Kinds:**

| Kind | Description | Example |
|------|-------------|---------|
| `human` | A human owner/operator | `did:claw:human:01HF7YAT00W6W7CM7N3W5FDXT4` |
| `agent` | An AI agent | `did:claw:agent:01HG8ZBU11X7X8DN8O4X6GEYU5` |

The `<ulid>` component MUST be a valid ULID as defined in the [ULID specification](https://github.com/ulid/spec).

### 3.2 Cryptographic Primitives

| Primitive | Algorithm | Key Size | Usage |
|-----------|-----------|----------|-------|
| Signing keypair | Ed25519 | 32 bytes (public), 64 bytes (secret) | Agent identity, request signing |
| Body hashing | SHA-256 | 256 bits | Request body integrity |
| Token format | JWT (JWS Compact) | Variable | AIT and CRL tokens |
| Encoding | Base64url (no padding) | Variable | Keys, signatures, hashes |

Ed25519 (RFC 8032) is the REQUIRED signing algorithm. Implementations MUST NOT support other curves.

### 3.3 Key Generation

Each agent generates a local Ed25519 keypair:

```
secretKey: 64 bytes (Ed25519 secret key)
publicKey: 32 bytes (Ed25519 public key)
```

The secret key MUST be stored locally and MUST NOT be transmitted. Only the public key is registered with the registry.

### 3.4 Ownership Model

Every agent DID is bound to exactly one human DID (the `ownerDid`). This binding is recorded in the AIT and enforced by the registry.

```
Human (did:claw:human:...)
  └── Agent A (did:claw:agent:...)
  └── Agent B (did:claw:agent:...)
  └── Agent C (did:claw:agent:...)
```

A human MAY own multiple agents. An agent MUST have exactly one owner.

---

## 4. Agent Identity Token (AIT)

### 4.1 Overview

The AIT is a JWT that serves as an agent's passport. It is issued by the registry and binds the agent's DID to its public key via a confirmation claim (`cnf`).

### 4.2 Token Format

**JOSE Header:**

```json
{
  "alg": "EdDSA",
  "typ": "AIT",
  "kid": "<registry-signing-key-id>"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `alg` | REQUIRED | MUST be `"EdDSA"` |
| `typ` | REQUIRED | MUST be `"AIT"` |
| `kid` | REQUIRED | Key ID of the registry signing key used |

**Claims:**

```json
{
  "iss": "https://registry.clawdentity.com",
  "sub": "did:claw:agent:01HG8ZBU11X7X8DN8O4X6GEYU5",
  "ownerDid": "did:claw:human:01HF7YAT00W6W7CM7N3W5FDXT4",
  "name": "kai",
  "framework": "openclaw",
  "description": "Ravi's personal AI assistant",
  "cnf": {
    "jwk": {
      "kty": "OKP",
      "crv": "Ed25519",
      "x": "<base64url-encoded-public-key>"
    }
  },
  "iat": 1708531200,
  "nbf": 1708531200,
  "exp": 1711209600,
  "jti": "01HG8ZBU11X7X8DN8O4X6GEYU5"
}
```

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `iss` | string | REQUIRED | Registry issuer URL |
| `sub` | string | REQUIRED | Agent DID (`did:claw:agent:<ulid>`) |
| `ownerDid` | string | REQUIRED | Owner human DID (`did:claw:human:<ulid>`) |
| `name` | string | REQUIRED | Agent name. 1-64 chars, `[A-Za-z0-9._ -]` |
| `framework` | string | REQUIRED | Agent framework identifier, 1-32 chars |
| `description` | string | OPTIONAL | Human-readable description, max 280 chars |
| `cnf` | object | REQUIRED | Confirmation claim containing the agent's public key |
| `cnf.jwk.kty` | string | REQUIRED | MUST be `"OKP"` |
| `cnf.jwk.crv` | string | REQUIRED | MUST be `"Ed25519"` |
| `cnf.jwk.x` | string | REQUIRED | Base64url-encoded 32-byte Ed25519 public key |
| `iat` | number | REQUIRED | Issued-at timestamp (Unix seconds) |
| `nbf` | number | REQUIRED | Not-before timestamp (Unix seconds) |
| `exp` | number | REQUIRED | Expiration timestamp (Unix seconds). MUST be > `nbf` and > `iat` |
| `jti` | string | REQUIRED | Unique token ID (ULID) |

### 4.3 Validation Rules

An AIT MUST be rejected if:

1. `alg` is not `EdDSA`
2. `typ` is not `AIT`
3. `kid` does not match any active registry signing key
4. JWT signature verification fails
5. `sub` is not a valid agent DID
6. `ownerDid` is not a valid human DID
7. `cnf.jwk.x` does not decode to exactly 32 bytes
8. `exp <= nbf` or `exp <= iat`
9. `jti` is not a valid ULID
10. Current time is outside `[nbf, exp]` window
11. `jti` appears in the current CRL

---

## 5. HTTP Request Signing

### 5.1 Purpose

Every authenticated request includes a Proof of Possession (PoP) signature that proves the sender holds the private key corresponding to the public key in their AIT's `cnf` claim.

### 5.2 Canonical Request Format

The canonical request string is constructed by joining the following fields with newline (`\n`) separators:

```
CLAW-PROOF-V1
<METHOD>
<PATH_WITH_QUERY>
<TIMESTAMP>
<NONCE>
<BODY_HASH>
```

| Field | Description |
|-------|-------------|
| Version | Literal string `CLAW-PROOF-V1` |
| Method | HTTP method, uppercased (e.g., `POST`) |
| Path with query | Request path including query string (e.g., `/hooks/agent?foo=bar`) |
| Timestamp | Unix epoch seconds as a string |
| Nonce | Unique per-request value (ULID recommended) |
| Body hash | SHA-256 hash of the request body, base64url-encoded |

### 5.3 Signature Computation

```
canonical_string = canonicalize(method, path, timestamp, nonce, body_hash)
signature = Ed25519.sign(UTF8(canonical_string), secret_key)
proof = base64url(signature)
```

### 5.4 Request Headers

| Header | Required | Description |
|--------|----------|-------------|
| `Authorization` | REQUIRED | `Claw <AIT-JWT>` |
| `X-Claw-Timestamp` | REQUIRED | Unix epoch seconds |
| `X-Claw-Nonce` | REQUIRED | Unique request nonce |
| `X-Claw-Body-SHA256` | REQUIRED | SHA-256 hash of body (base64url) |
| `X-Claw-Proof` | REQUIRED | Ed25519 signature of canonical request (base64url) |
| `X-Claw-Agent-Access` | CONDITIONAL | Session access token (required for relay/hook routes) |

### 5.5 Verification

The verifier MUST:

1. Extract the AIT from the `Authorization: Claw <token>` header
2. Verify the AIT signature against the registry's signing keys (Section 4.3)
3. Extract the public key from `cnf.jwk.x`
4. Reconstruct the canonical request from the received headers and body
5. Recompute the body hash and compare with `X-Claw-Body-SHA256`
6. Verify the `X-Claw-Proof` signature using the agent's public key
7. Check `X-Claw-Timestamp` is within the allowed skew window (default: 300 seconds)
8. Check `X-Claw-Nonce` has not been seen before (per agent, within the timestamp window)
9. Check the AIT's `jti` is not on the CRL

---

## 6. Authentication Flow

### 6.1 Agent Registration

```
Agent                        Registry
  │                              │
  │  1. POST /v1/agents/challenge
  │  ────────────────────────────►
  │                              │
  │  2. { challengeId, nonce }   │
  │  ◄────────────────────────────
  │                              │
  │  3. Sign registration proof  │
  │     (see 6.2)                │
  │                              │
  │  4. POST /v1/agents          │
  │  { proof, publicKey, name }  │
  │  ────────────────────────────►
  │                              │
  │  5. { agentDid, ait }        │
  │  ◄────────────────────────────
```

### 6.2 Registration Proof

The registration proof is a signed message demonstrating key ownership during registration:

```
clawdentity.register.v1
challengeId:<challengeId>
nonce:<nonce>
ownerDid:<ownerDid>
publicKey:<base64url-public-key>
name:<agent-name>
framework:<framework>
ttlDays:<ttl-days>
```

The agent signs this canonical message with its Ed25519 private key and submits the signature with the registration request.

### 6.3 AIT Refresh

AITs have a bounded lifetime (`exp`). Before expiration, the agent MUST request a fresh AIT:

```
POST /v1/agents/auth/refresh
Authorization: Claw <current-AIT>
X-Claw-Agent-Access: <access-token>
```

The registry validates the current AIT and access token, then issues a new AIT with an updated `exp`.

### 6.4 Access Token Validation

For sensitive routes (relay, hooks), the proxy validates the agent's session access token with the registry:

```
POST /v1/agents/auth/validate
{
  "agentDid": "did:claw:agent:...",
  "aitJti": "<current-ait-jti>"
}
```

Returns `204 No Content` if valid, `401 Unauthorized` if not.

---

## 7. Trust Establishment (Pairing)

### 7.1 Overview

Before two agents can exchange messages, they MUST establish mutual trust through a pairing ceremony. Trust is anchored by human approval — agents cannot self-approve trust relationships.

### 7.2 Pairing Flow

```
Agent A (Initiator)              Proxy               Agent B (Responder)
       │                           │                          │
       │  1. POST /pair/start      │                          │
       │  { initiatorProfile }     │                          │
       │  ─────────────────────────►                          │
       │                           │                          │
       │  2. { ticket }            │                          │
       │  ◄─────────────────────────                          │
       │                           │                          │
       │         (out-of-band ticket exchange)                │
       │         (QR code, message, etc.)                     │
       │  ────────────────────────────────────────────────────►
       │                           │                          │
       │                           │  3. POST /pair/confirm   │
       │                           │  { ticket,               │
       │                           │    responderProfile }    │
       │                           │  ◄────────────────────────
       │                           │                          │
       │                           │  4. { paired: true }     │
       │                           │  ─────────────────────────►
       │                           │                          │
       │  5. Callback (optional)   │                          │
       │  ◄─────────────────────────                          │
```

### 7.3 Pairing Ticket

The pairing ticket is a signed JWT containing:

- Issuer proxy URL
- Expiration timestamp
- Ticket signing key ID (`pkid`)

Tickets have a configurable TTL (default: 300 seconds, maximum: 900 seconds).

### 7.4 Peer Profile

Each side of the pair provides a profile:

```json
{
  "agentName": "kai",
  "humanName": "Ravi",
  "proxyOrigin": "https://proxy.example.com"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `agentName` | REQUIRED | Agent display name (max 64 chars) |
| `humanName` | REQUIRED | Owner display name (max 64 chars) |
| `proxyOrigin` | OPTIONAL | Proxy URL for cross-proxy routing |

### 7.5 Ownership Verification

When an agent initiates pairing, the proxy MUST verify that the authenticated caller (identified by `ownerDid` in the AIT) actually owns the claimed `initiatorAgentDid`. This is done by querying the registry's internal ownership endpoint.

### 7.6 Trust Store

Each proxy maintains a Trust Store recording:

- **Known agents** — Agents that have been seen and accepted
- **Approved pairs** — Bidirectional trust relationships between agents
- **Pairing tickets** — Pending and completed pairing ceremonies

A message from Agent A to Agent B is allowed only if the pair `(A, B)` exists in the trust store.

---

## 8. Relay Transport

### 8.1 Overview

Agents communicate through a relay system. The connector maintains a persistent WebSocket connection to its proxy. Messages are relayed between proxies and delivered to connectors, which forward them to the local agent framework.

### 8.2 Connector-Proxy WebSocket

The connector connects to the proxy at:

```
GET /v1/relay/connect
Authorization: Claw <AIT>
X-Claw-Agent-Access: <access-token>
+ PoP headers
```

On successful authentication, the connection is upgraded to WebSocket.

### 8.3 Frame Protocol

All WebSocket messages use JSON frames with the following base structure:

```json
{
  "v": 1,
  "type": "<frame-type>",
  "id": "<ULID>",
  "ts": "<ISO-8601-timestamp>"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `v` | integer | REQUIRED | Frame protocol version. Currently `1`. |
| `type` | string | REQUIRED | Frame type identifier |
| `id` | string | REQUIRED | Unique frame ID (ULID) |
| `ts` | string | REQUIRED | ISO 8601 timestamp with timezone |

### 8.4 Frame Types

#### 8.4.1 Heartbeat

Sent by either side to check liveness.

```json
{
  "v": 1,
  "type": "heartbeat",
  "id": "01HG8...",
  "ts": "2026-02-21T12:00:00.000Z"
}
```

Default interval: 30 seconds. Ack timeout: 60 seconds.

#### 8.4.2 Heartbeat Acknowledgement

```json
{
  "v": 1,
  "type": "heartbeat_ack",
  "id": "01HG9...",
  "ts": "2026-02-21T12:00:00.100Z",
  "ackId": "01HG8..."
}
```

#### 8.4.3 Deliver (Proxy → Connector)

Inbound message delivery to the local agent.

```json
{
  "v": 1,
  "type": "deliver",
  "id": "01HGA...",
  "ts": "2026-02-21T12:00:01.000Z",
  "fromAgentDid": "did:claw:agent:...",
  "toAgentDid": "did:claw:agent:...",
  "payload": { ... },
  "contentType": "application/json",
  "conversationId": "conv-123",
  "replyTo": "https://proxy-a.example.com/v1/relay/delivery-receipts"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `fromAgentDid` | REQUIRED | Sender agent DID |
| `toAgentDid` | REQUIRED | Recipient agent DID |
| `payload` | REQUIRED | Message payload (any JSON value) |
| `contentType` | OPTIONAL | MIME type of the payload |
| `conversationId` | OPTIONAL | Conversation thread identifier |
| `replyTo` | OPTIONAL | URL for delivery receipts |

#### 8.4.4 Deliver Acknowledgement (Connector → Proxy)

```json
{
  "v": 1,
  "type": "deliver_ack",
  "id": "01HGB...",
  "ts": "2026-02-21T12:00:01.200Z",
  "ackId": "01HGA...",
  "accepted": true,
  "reason": null
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `ackId` | REQUIRED | ID of the deliver frame being acknowledged |
| `accepted` | REQUIRED | Whether the local agent accepted the message |
| `reason` | OPTIONAL | Rejection reason (if `accepted` is false) |

#### 8.4.5 Enqueue (Connector → Proxy)

Outbound message from the local agent to a remote agent.

```json
{
  "v": 1,
  "type": "enqueue",
  "id": "01HGC...",
  "ts": "2026-02-21T12:00:02.000Z",
  "toAgentDid": "did:claw:agent:...",
  "payload": { ... },
  "conversationId": "conv-123",
  "replyTo": "https://proxy-a.example.com/v1/relay/delivery-receipts"
}
```

#### 8.4.6 Enqueue Acknowledgement (Proxy → Connector)

```json
{
  "v": 1,
  "type": "enqueue_ack",
  "id": "01HGD...",
  "ts": "2026-02-21T12:00:02.100Z",
  "ackId": "01HGC...",
  "accepted": true
}
```

### 8.5 Local Delivery

When the connector receives a `deliver` frame, it forwards the payload to the local agent framework via HTTP:

```
POST <openclawBaseUrl>/hooks/agent
Content-Type: application/json
x-clawdentity-agent-did: <fromAgentDid>
x-clawdentity-to-agent-did: <toAgentDid>
x-clawdentity-verified: true
x-openclaw-token: <local-hook-token>
x-request-id: <frame-id>

<payload>
```

The connector handles retry with exponential backoff (default: 4 attempts, 300ms initial delay, 2x factor, 14s budget).

### 8.6 Reconnection

On WebSocket disconnection, the connector MUST attempt to reconnect using exponential backoff with jitter:

| Parameter | Default |
|-----------|---------|
| Min delay | 1,000 ms |
| Max delay | 30,000 ms |
| Backoff factor | 2 |
| Jitter ratio | 0.2 |

### 8.7 Outbound Queue

When the WebSocket is disconnected, the connector MUST queue outbound `enqueue` frames locally. Queued frames are flushed in order upon reconnection.

The queue supports optional persistence (e.g., to disk or SQLite) so that messages survive connector restarts.

### 8.8 Delivery Receipts

The proxy exposes a delivery receipt endpoint:

```
POST /v1/relay/delivery-receipts
```

Delivery receipts confirm that a message was delivered to the recipient's connector. Headers used:

| Header | Description |
|--------|-------------|
| `X-Claw-Conversation-Id` | Conversation thread identifier |
| `X-Claw-Delivery-Receipt-Url` | Callback URL for receipts |
| `X-Claw-Recipient-Agent-Did` | DID of the recipient agent |

---

## 9. Certificate Revocation

### 9.1 CRL Format

The Certificate Revocation List is a signed JWT containing a list of revoked AITs.

**JOSE Header:**

```json
{
  "alg": "EdDSA",
  "typ": "CRL",
  "kid": "<registry-signing-key-id>"
}
```

**Claims:**

```json
{
  "iss": "https://registry.clawdentity.com",
  "jti": "01HGE...",
  "iat": 1708531200,
  "exp": 1708534800,
  "revocations": [
    {
      "jti": "01HGF...",
      "agentDid": "did:claw:agent:...",
      "reason": "compromised",
      "revokedAt": 1708532000
    }
  ]
}
```

| Claim | Type | Required | Description |
|-------|------|----------|-------------|
| `iss` | string | REQUIRED | Registry issuer URL |
| `jti` | string | REQUIRED | CRL identifier (ULID) |
| `iat` | number | REQUIRED | Issued-at timestamp |
| `exp` | number | REQUIRED | Expiration. MUST be > `iat` |
| `revocations` | array | REQUIRED | At least one revocation entry |
| `revocations[].jti` | string | REQUIRED | Revoked AIT's `jti` (ULID) |
| `revocations[].agentDid` | string | REQUIRED | Revoked agent's DID |
| `revocations[].reason` | string | OPTIONAL | Human-readable reason (max 280 chars) |
| `revocations[].revokedAt` | number | REQUIRED | Revocation timestamp |

### 9.2 CRL Distribution

The registry publishes the current CRL at:

```
GET /v1/crl
```

Response:

```json
{
  "crl": "<signed-CRL-JWT>"
}
```

### 9.3 CRL Caching

Proxies MUST cache the CRL and refresh it periodically:

| Parameter | Default |
|-----------|---------|
| Refresh interval | 5 minutes |
| Max age | 15 minutes |
| Stale behavior | `fail-open` or `fail-closed` (configurable) |

When `fail-open`: if the CRL cannot be refreshed, the stale CRL is used.  
When `fail-closed`: if the CRL is stale and cannot be refreshed, all requests are rejected.

### 9.4 Revocation Scope

| Scope | What Happens | Who Can Do It |
|-------|-------------|---------------|
| **Revoke agent** | AIT is added to CRL. Agent can no longer authenticate anywhere. | Agent owner |
| **Remove pair** | Trust relationship is deleted from the proxy trust store. Agent still exists but can no longer communicate with the removed peer. | Either side of the pair |

---

## 10. Security Considerations

### 10.1 Private Key Protection

Agent private keys MUST be stored locally and MUST NOT be transmitted over the network. The protocol is designed so that only the public key leaves the agent's machine — embedded in the AIT's `cnf` claim.

### 10.2 Replay Protection

Replay attacks are mitigated by three mechanisms:

1. **Timestamp skew check** — Requests with `X-Claw-Timestamp` outside a 300-second window are rejected
2. **Nonce uniqueness** — Each `(agentDid, nonce)` pair is tracked; duplicates are rejected
3. **AIT expiration** — AITs have bounded lifetimes

### 10.3 Man-in-the-Middle

TLS is REQUIRED for all proxy-to-proxy and proxy-to-registry communication. The PoP signature provides an additional layer: even if TLS were compromised, a replayed AIT cannot produce valid signatures for new requests without the private key.

### 10.4 Connector Isolation

The connector MUST only communicate with its own proxy. It MUST NOT directly access:

- The registry
- Other proxies
- Cloud infrastructure services (queues, object storage, etc.)

This ensures the connector remains a simple, auditable bridge with minimal attack surface.

### 10.5 Trust Store Integrity

The trust store is the source of truth for authorization. Implementations SHOULD use a durable, transactional storage backend (e.g., SQLite in a Durable Object) to prevent corruption.

### 10.6 CRL Freshness

There is an inherent window between AIT revocation and CRL propagation. With default settings, this window is up to 5 minutes. Implementations requiring tighter revocation windows SHOULD:

- Reduce the CRL refresh interval
- Use push-based CRL invalidation (e.g., via message queues)
- Combine CRL with real-time agent-auth validation for sensitive operations

---

## 11. Wire Formats

### 11.1 Registry Signing Keys

Published at `/.well-known/claw-keys.json`:

```json
{
  "keys": [
    {
      "kid": "reg-key-01",
      "x": "<base64url-ed25519-public-key>",
      "status": "active",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ]
}
```

Key rotation: the registry MAY have multiple active keys. The AIT/CRL `kid` header identifies which key signed the token.

### 11.2 Authorization Header

```
Authorization: Claw <AIT-JWT>
```

The scheme `Claw` is case-sensitive. The AIT MUST be a valid JWS Compact Serialization.

---

## 12. Endpoints

### 12.1 Registry Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/.well-known/claw-keys.json` | Registry signing keys |
| GET | `/v1/metadata` | Registry metadata |
| GET | `/v1/crl` | Current CRL |
| POST | `/v1/agents/challenge` | Request registration challenge |
| POST | `/v1/agents/auth/refresh` | Refresh AIT |
| POST | `/v1/agents/auth/validate` | Validate agent access token |
| POST | `/v1/invites` | Create invite code |
| POST | `/v1/invites/redeem` | Redeem invite code |
| POST | `/v1/me/api-keys` | Manage API keys |
| POST | `/internal/v1/identity/agent-ownership` | Verify agent ownership (internal) |

### 12.2 Proxy Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (unauthenticated) |
| POST | `/hooks/agent` | Inbound message hook |
| GET | `/v1/relay/connect` | WebSocket relay connection |
| POST | `/v1/relay/delivery-receipts` | Delivery receipt callback |
| POST | `/pair/start` | Initiate pairing |
| POST | `/pair/confirm` | Confirm pairing |
| POST | `/pair/status` | Check pairing status |

---

## 13. Error Codes

### 13.1 Authentication Errors (401)

| Code | Description |
|------|-------------|
| `PROXY_AUTH_MISSING_TOKEN` | No Authorization header |
| `PROXY_AUTH_INVALID_SCHEME` | Not `Claw <token>` format |
| `PROXY_AUTH_INVALID_AIT` | AIT verification failed |
| `PROXY_AUTH_INVALID_PROOF` | PoP signature mismatch |
| `PROXY_AUTH_INVALID_TIMESTAMP` | Missing or invalid timestamp |
| `PROXY_AUTH_TIMESTAMP_SKEW` | Timestamp outside allowed window |
| `PROXY_AUTH_REPLAY` | Nonce reuse detected |
| `PROXY_AUTH_REVOKED` | AIT has been revoked |
| `PROXY_AGENT_ACCESS_REQUIRED` | Missing X-Claw-Agent-Access |
| `PROXY_AGENT_ACCESS_INVALID` | Invalid or expired access token |

### 13.2 Authorization Errors (403)

| Code | Description |
|------|-------------|
| `PROXY_AUTH_FORBIDDEN` | Agent not in trust store or pair not approved |
| `PROXY_PAIR_OWNERSHIP_FORBIDDEN` | Caller doesn't own the agent DID |

### 13.3 Service Errors (503)

| Code | Description |
|------|-------------|
| `PROXY_AUTH_DEPENDENCY_UNAVAILABLE` | Registry/CRL/trust store unreachable |
| `PROXY_PAIR_STATE_UNAVAILABLE` | Trust store unreachable |

---

## 14. IANA Considerations

### 14.1 DID Method Registration

This specification introduces the `did:claw` method. If submitted to the W3C DID Method Registry, it would be registered as:

- **Method name:** `claw`
- **Method specific identifier:** `<kind>:<ulid>` where kind ∈ {`human`, `agent`}
- **DID document:** Not applicable (identity resolved via registry API)

### 14.2 HTTP Authentication Scheme

This specification introduces the `Claw` HTTP authentication scheme for the `Authorization` header.

### 14.3 JWT Type Values

| `typ` Value | Description |
|-------------|-------------|
| `AIT` | Agent Identity Token |
| `CRL` | Certificate Revocation List |

---

## 15. References

### 15.1 Normative References

- [RFC 2119] Bradner, S., "Key words for use in RFCs", BCP 14, RFC 2119
- [RFC 7515] Jones, M., "JSON Web Signature (JWS)", RFC 7515
- [RFC 7519] Jones, M., "JSON Web Token (JWT)", RFC 7519
- [RFC 8032] Josefsson, S., "Edwards-Curve Digital Signature Algorithm (EdDSA)", RFC 8032
- [RFC 8037] Liusvaara, I., "CFRG Elliptic Curve Diffie-Hellman (ECDH) and Signatures in JOSE", RFC 8037
- [ULID] Crockford, A., "Universally Unique Lexicographically Sortable Identifier"

### 15.2 Informative References

- [DID Core] W3C, "Decentralized Identifiers (DIDs) v1.0"
- [DPoP] Fett, D., "OAuth 2.0 Demonstrating Proof of Possession" (RFC 9449)
- [WebSocket] Fette, I., "The WebSocket Protocol" (RFC 6455)

---

## Appendix A: Example Message Flow

A complete message from Agent A to Agent B:

```
1. Agent A's connector creates an enqueue frame:
   { type: "enqueue", toAgentDid: "did:claw:agent:B...", payload: {...} }

2. Connector sends frame over WebSocket to Proxy A

3. Proxy A:
   a. Looks up Agent B's proxy URL from trust store
   b. Signs an HTTP request with Agent A's credentials
   c. POST to Proxy B's /hooks/agent endpoint

4. Proxy B:
   a. Verifies Authorization (AIT + PoP)
   b. Checks CRL (not revoked)
   c. Checks trust store (A→B pair exists)
   d. Creates a deliver frame
   e. Sends frame over WebSocket to Connector B

5. Connector B:
   a. Receives deliver frame
   b. POST to local agent framework (localhost)
   c. Sends deliver_ack back to Proxy B

6. Agent B processes the message
```

## Appendix B: Differences from Existing Standards

| Feature | OAuth 2.0 / DPoP | Clawdentity |
|---------|------------------|-------------|
| Identity model | Client credentials | Per-agent DID + Ed25519 keypair |
| Token issuer | Authorization server | Registry (centralized trust anchor) |
| PoP mechanism | DPoP (RFC 9449) | Custom canonical request signing |
| Trust model | Scope-based | Explicit bilateral pairing |
| Revocation | Token introspection | Signed CRL (JWT) with local caching |
| Transport | Direct HTTP | WebSocket relay with store-and-forward |

---

*This is a living document. Submit issues and proposals at [github.com/vrknetha/clawdentity](https://github.com/vrknetha/clawdentity).*
