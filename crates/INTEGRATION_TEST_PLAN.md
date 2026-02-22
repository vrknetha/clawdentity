# Clawdentity — Cross-Platform Integration Test Strategy

Date: 2026-02-22
Status: Draft

## Goal
Simulate real multi-agent scenarios in Linux containers. Two+ Clawdentity agents running as separate processes, communicating through the actual proxy, pairing, exchanging messages, verifying trust — the full protocol loop.

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          docker-compose                                    │
│                                                                            │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────────────────┐ │
│  │  openclaw    │ │  picoclaw   │ │  nanobot    │ │   mock-registry      │ │
│  │  (node:22)   │ │  (golang)   │ │  (python)   │ │   (rust/axum)        │ │
│  │  :3001       │ │  :18794     │ │  :18795     │ │   :3000              │ │
│  │  gateway +   │ │  Go app +   │ │  Python +   │ │   /agents /crl /keys │ │
│  │  connector   │ │  connector  │ │  connector  │ └──────────────────────┘ │
│  └──────┬───────┘ └──────┬──────┘ └──────┬──────┘                          │
│         │                │               │                                 │
│  ┌──────┴────────┐ ┌─────┴───────┐                                        │
│  │ nanoclaw-h    │ │ nanoclaw-q  │                                         │
│  │ (node:22)     │ │ (node:22)   │                                         │
│  │ hustcc TS +   │ │ qwibitai +  │                                         │
│  │ connector     │ │ connector   │                                         │
│  │ :18796        │ │ :18797      │                                         │
│  └──────┬────────┘ └──────┬──────┘                                         │
│         │                 │                                                │
│         ▼                 ▼                                                │
│  ┌─────────────────────────────────────────────┐                           │
│  │              mock-proxy                     │                           │
│  │  WebSocket relay + SSE + poll               │                           │
│  │  :8080                                      │                           │
│  └─────────────────────────────────────────────┘                           │
│                                                                            │
│  ┌─────────────────────────────────────────────┐                           │
│  │            test-runner                      │                           │
│  │  Orchestrates cross-platform scenarios      │                           │
│  │  via exec into all 5 platform containers    │                           │
│  └─────────────────────────────────────────────┘                           │
└────────────────────────────────────────────────────────────────────────────┘
```

### Platform Containers (5 real agent platforms)

| Container | Platform | Runtime | Webhook Port | Language | Delivery Mode |
|-----------|----------|---------|-------------|----------|---------------|
| `openclaw` | OpenClaw | Node 22 | :3001 | JS/TS | bidirectional webhook |
| `picoclaw` | PicoClaw | Go 1.22 | :18794 | Go | bidirectional webhook |
| `nanobot` | NanoBot | Python 3.12 | :18795 | Python | bidirectional webhook |
| `nanoclaw-h` | NanoClaw (hustcc) | Node 22 | :18796 | TypeScript | bidirectional webhook |
| `nanoclaw-q` | NanoClaw (qwibitai) | Node 22 | :18797 | TypeScript | bidirectional webhook |

Each container runs:
1. The actual platform application (OpenClaw gateway, PicoClaw server, etc.)
2. Clawdentity binary (cross-compiled musl) as the connector
3. Platform configured with bidirectional webhook channel (inbound + outbound)
4. Own identity (DID) registered with mock-registry

### Bidirectional Webhook Contract (all platforms)

Same HTTP server, same port, two routes — follows OpenClaw's existing pattern:

**Inbound** (relay → platform):
```
POST /webhook
Headers: x-clawdentity-agent-did, x-clawdentity-to-agent-did, x-clawdentity-verified, x-request-id
Body: { "content": "...", ...relay payload }
```

**Outbound** (platform → relay):
```
POST /send
Body: { "to": "<did>", "content": "<message>", "peer": "<alias>" }
Response: 202 Accepted
→ Forwards to connector at http://127.0.0.1:18791/outbound
```

No exec/shell calls for sending. Full HTTP API for both directions.

This tests the **real integration path**: proxy → connector → webhook POST → platform message bus → agent processes message.

### Why real platforms, not mocks
Generic "agent-a/agent-b" containers only test the CLI in isolation. The whole point of Clawdentity is cross-platform agent-to-agent messaging. If OpenClaw's webhook handler has a bug parsing the headers, or PicoClaw's Go channel drops the `x-clawdentity-verified` header, we need to catch that here — not after shipping.

## Components

### 1. Mock Registry (`tests/integration/mock-registry/`)
Lightweight HTTP server implementing the Clawdentity Registry API:
- `POST /agents/register` — accept registration, return AIT
- `GET /agents/:did` — return agent public key + metadata
- `GET /crl` — return revocation list (empty or seeded)
- `GET /keys` — return registry signing keys
- `POST /agents/:did/revoke` — add to CRL

**Implementation:** Rust (axum), in-memory state, ~200 lines.

### 2. Mock Proxy (`tests/integration/mock-proxy/`)
WebSocket + HTTP relay server:
- `GET /ws` — WebSocket upgrade, relay messages between connected agents
- `GET /sse/:did` — SSE stream for agent
- `GET /poll/:did` — poll endpoint, return queued messages
- `POST /relay` — accept outbound message, route to recipient's connection

**Implementation:** Rust (axum + tokio-tungstenite), ~300 lines.

### 3. Platform Dockerfiles

#### `Dockerfile.openclaw`
```dockerfile
FROM node:22-alpine
RUN npm install -g openclaw@latest
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
COPY tests/integration/configs/openclaw.json /root/.openclaw/openclaw.json
COPY tests/integration/entrypoints/openclaw.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

#### `Dockerfile.picoclaw`
```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY vendor/picoclaw/ .
RUN go build -o /picoclaw ./cmd/picoclaw

FROM alpine:3.21
COPY --from=build /picoclaw /usr/local/bin/
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
COPY tests/integration/configs/picoclaw.yaml /etc/picoclaw/config.yaml
COPY tests/integration/entrypoints/picoclaw.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

#### `Dockerfile.nanobot`
```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY vendor/nanobot/ .
RUN pip install -e .
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
COPY tests/integration/configs/nanobot.yaml /etc/nanobot/config.yaml
COPY tests/integration/entrypoints/nanobot.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

#### `Dockerfile.nanoclaw-hustcc`
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY vendor/nano-claw-hustcc/ .
RUN npm install && npm run build
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
COPY tests/integration/configs/nanoclaw-hustcc.json /etc/nanoclaw/config.json
COPY tests/integration/entrypoints/nanoclaw-hustcc.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

#### `Dockerfile.nanoclaw-qwibitai`
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY vendor/nanoclaw-qwibitai/ .
RUN npm install && npm run build
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
COPY tests/integration/configs/nanoclaw-qwibitai.json /etc/nanoclaw/config.json
COPY tests/integration/entrypoints/nanoclaw-qwibitai.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
```

### 4. Entrypoint Scripts
Each platform entrypoint:
1. Initializes clawdentity identity (`clawdentity init && clawdentity register`)
2. Starts the platform application in background
3. Starts the connector (`clawdentity listen --webhook http://localhost:<port>/webhook/clawdentity &`)
4. Sleeps forever (test-runner exec's in)

### 5. Test Runner
Shell scripts that orchestrate scenarios by exec'ing into platform containers.

## Build Pipeline

### Cross-compilation (M1 Mac → Linux x86_64)
```bash
# One-time setup
rustup target add x86_64-unknown-linux-musl
brew install filosottile/musl-cross/musl-cross

# Build
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc \
  cargo build --release --target x86_64-unknown-linux-musl \
  --manifest-path crates/Cargo.toml -p clawdentity-cli
```

### Dockerfile (`tests/integration/Dockerfile.agent`)
```dockerfile
FROM alpine:3.21
RUN apk add --no-cache ca-certificates sqlite
COPY target/x86_64-unknown-linux-musl/release/clawdentity /usr/local/bin/
RUN chmod +x /usr/local/bin/clawdentity
ENTRYPOINT ["sleep", "infinity"]
```

### docker-compose.yml (`tests/integration/docker-compose.yml`)
```yaml
x-clawdentity-env: &clawdentity-env
  CLAWDENTITY_REGISTRY_URL: http://mock-registry:3000
  CLAWDENTITY_PROXY_URL: ws://mock-proxy:8080/ws

services:
  mock-registry:
    build:
      context: .
      dockerfile: Dockerfile.mock-registry
    ports: ["3000:3000"]
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:3000/health"]
      interval: 2s
      retries: 5

  mock-proxy:
    build:
      context: .
      dockerfile: Dockerfile.mock-proxy
    ports: ["8080:8080"]
    depends_on:
      mock-registry:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "--spider", "http://localhost:8080/health"]
      interval: 2s
      retries: 5

  openclaw:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.openclaw
    environment:
      <<: *clawdentity-env
      CLAWDENTITY_HOME: /root/.clawdentity
      PLATFORM: openclaw
    ports: ["3001:3001"]
    depends_on:
      mock-proxy:
        condition: service_healthy

  picoclaw:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.picoclaw
    environment:
      <<: *clawdentity-env
      CLAWDENTITY_HOME: /root/.clawdentity
      PLATFORM: picoclaw
    ports: ["18794:18794"]
    depends_on:
      mock-proxy:
        condition: service_healthy

  nanobot:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.nanobot
    environment:
      <<: *clawdentity-env
      CLAWDENTITY_HOME: /root/.clawdentity
      PLATFORM: nanobot
    ports: ["18795:18795"]
    depends_on:
      mock-proxy:
        condition: service_healthy

  nanoclaw-h:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.nanoclaw-hustcc
    environment:
      <<: *clawdentity-env
      CLAWDENTITY_HOME: /root/.clawdentity
      PLATFORM: nanoclaw-hustcc
    ports: ["18796:18796"]
    depends_on:
      mock-proxy:
        condition: service_healthy

  nanoclaw-q:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.nanoclaw-qwibitai
    environment:
      <<: *clawdentity-env
      CLAWDENTITY_HOME: /root/.clawdentity
      PLATFORM: nanoclaw-qwibitai
    ports: ["18797:18797"]
    depends_on:
      mock-proxy:
        condition: service_healthy

  test-runner:
    build:
      context: ../..
      dockerfile: tests/integration/Dockerfile.runner
    depends_on:
      - openclaw
      - picoclaw
      - nanobot
      - nanoclaw-h
      - nanoclaw-q
    environment:
      <<: *clawdentity-env
    volumes:
      - ./scenarios:/scenarios:ro
    entrypoint: ["/bin/sh", "-c", "sleep 5 && /scenarios/run-all.sh"]
```

## Test Scenarios

### Phase 1: Identity & Basics (per-platform)

#### Scenario 1: Identity Lifecycle (all 5 platforms)
```
# Run on EACH platform container — verify clawdentity works everywhere
for platform in openclaw picoclaw nanobot nanoclaw-h nanoclaw-q; do
  exec_in $platform clawdentity whoami --json    # DID exists (set up by entrypoint)
  exec_in $platform clawdentity doctor           # all checks green
done
```

#### Scenario 2: Pairing — All Platforms Pair With Each Other
```
# Full mesh: every platform pairs with every other (10 pairs for 5 platforms)
# OpenClaw ↔ PicoClaw
TICKET=$(exec_in openclaw clawdentity pair start --json | jq -r .ticket)
exec_in picoclaw clawdentity pair confirm "$TICKET"
# OpenClaw ↔ NanoBot
TICKET=$(exec_in openclaw clawdentity pair start --json | jq -r .ticket)
exec_in nanobot clawdentity pair confirm "$TICKET"
# ... repeat for all 10 combinations
# Verify peer counts
for platform in openclaw picoclaw nanobot nanoclaw-h nanoclaw-q; do
  PEERS=$(exec_in $platform clawdentity peers list --json | jq length)
  assert_eq "$PEERS" "4" "$platform should have 4 peers"
done
```

### Phase 2: Cross-Platform Messaging

#### Scenario 3: OpenClaw → PicoClaw (webhook to webhook)
```
# OpenClaw agent sends message to PicoClaw agent
DID_PICO=$(exec_in picoclaw clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_PICO" "hello from openclaw"
sleep 2
# Verify PicoClaw's webhook received it and routed to message bus
exec_in picoclaw clawdentity inbox list --json | jq -e '.[] | select(.content == "hello from openclaw")'
# Verify PicoClaw's platform log shows the message was processed
exec_in picoclaw cat /var/log/picoclaw/clawdentity.log | grep "hello from openclaw"
```

#### Scenario 4: NanoBot → OpenClaw (Python → Node)
```
DID_OC=$(exec_in openclaw clawdentity whoami --json | jq -r .did)
exec_in nanobot clawdentity send "$DID_OC" "hello from nanobot"
sleep 2
# Verify OpenClaw gateway received via webhook channel
exec_in openclaw clawdentity inbox list --json | jq -e '.[] | select(.content == "hello from nanobot")'
```

#### Scenario 5: Round-Trip — OpenClaw ↔ NanoClaw hustcc
```
DID_OC=$(exec_in openclaw clawdentity whoami --json | jq -r .did)
DID_NC=$(exec_in nanoclaw-h clawdentity whoami --json | jq -r .did)
# OpenClaw → NanoClaw
exec_in openclaw clawdentity send "$DID_NC" "ping from openclaw"
sleep 2
exec_in nanoclaw-h clawdentity inbox list --json | jq -e '.[] | select(.content == "ping from openclaw")'
# NanoClaw → OpenClaw (reply)
exec_in nanoclaw-h clawdentity send "$DID_OC" "pong from nanoclaw"
sleep 2
exec_in openclaw clawdentity inbox list --json | jq -e '.[] | select(.content == "pong from nanoclaw")'
```

#### Scenario 6: Full Mesh Messaging (every platform → every other)
```
# 20 messages total (5 platforms × 4 targets each)
PLATFORMS="openclaw picoclaw nanobot nanoclaw-h nanoclaw-q"
for sender in $PLATFORMS; do
  for receiver in $PLATFORMS; do
    [ "$sender" = "$receiver" ] && continue
    DID_R=$(exec_in $receiver clawdentity whoami --json | jq -r .did)
    exec_in $sender clawdentity send "$DID_R" "cross-platform: $sender→$receiver"
  done
done
sleep 5
# Verify each platform received exactly 4 messages
for platform in $PLATFORMS; do
  COUNT=$(exec_in $platform clawdentity inbox list --json | jq length)
  assert_ge "$COUNT" "4" "$platform should have ≥4 messages"
done
```

### Phase 3: Webhook Delivery Verification

#### Scenario 7: Webhook Headers Contract (per platform)
```
# Verify each platform's webhook handler correctly parses ALL required headers
# Send message to each platform, then check platform-specific logs for:
# - x-clawdentity-agent-did parsed correctly
# - x-clawdentity-to-agent-did matches local DID
# - x-clawdentity-verified == "true"
# - x-request-id present and logged
# - Content-Type: application/json
for platform in openclaw picoclaw nanobot nanoclaw-h nanoclaw-q; do
  exec_in $platform cat /var/log/clawdentity-webhook.log | \
    jq -e '.headers["x-clawdentity-verified"] == "true"'
done
```

#### Scenario 8: Webhook Auth Token Rejection
```
# Configure picoclaw with a shared secret token
exec_in picoclaw sh -c 'echo "clawdentity_token: secret123" >> /etc/picoclaw/config.yaml'
# Restart picoclaw webhook listener
# Send message from openclaw (no token configured) → should get 401
DID_PICO=$(exec_in picoclaw clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_PICO" "should fail auth"
sleep 2
# Verify message was NOT delivered
exec_in picoclaw clawdentity inbox list --json | jq -e 'map(select(.content == "should fail auth")) | length == 0'
```

### Phase 4: Resilience & Edge Cases

#### Scenario 9: Offline Platform → Outbox → Reconnect → Deliver
```
# Stop nanobot's connector (simulate offline)
exec_in nanobot pkill -f "clawdentity listen"
# OpenClaw sends message to nanobot
DID_NB=$(exec_in nanobot clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_NB" "you were offline"
# Message should be in openclaw's outbox or proxy's queue
sleep 2
# Restart nanobot's connector
exec_in nanobot clawdentity listen --webhook http://localhost:18795/webhook/clawdentity &
sleep 3
# Verify nanobot eventually receives it
exec_in nanobot clawdentity inbox list --json | jq -e '.[] | select(.content == "you were offline")'
```

#### Scenario 10: Burst — 50 Messages OpenClaw → PicoClaw
```
DID_PICO=$(exec_in picoclaw clawdentity whoami --json | jq -r .did)
for i in $(seq 1 50); do
  exec_in openclaw clawdentity send "$DID_PICO" "burst-$i"
done
sleep 10
# All 50 arrived, in order
COUNT=$(exec_in picoclaw clawdentity inbox list --limit 100 --json | jq '[.[] | select(.content | startswith("burst-"))] | length')
assert_eq "$COUNT" "50" "all 50 burst messages received"
```

#### Scenario 11: Trust Verification Across Platforms
```
# NanoClaw qwibitai sends to OpenClaw
DID_OC=$(exec_in openclaw clawdentity whoami --json | jq -r .did)
exec_in nanoclaw-q clawdentity send "$DID_OC" "trust me"
sleep 2
# OpenClaw verifies the message signature
MSG_ID=$(exec_in openclaw clawdentity inbox list --json | jq -r '.[-1].id')
exec_in openclaw clawdentity verify "$MSG_ID"   # should pass

# Revoke nanoclaw-q at registry
DID_NQ=$(exec_in nanoclaw-q clawdentity whoami --json | jq -r .did)
curl -s -X POST "http://mock-registry:3000/agents/$DID_NQ/revoke"
# Force CRL refresh
exec_in openclaw clawdentity doctor --refresh-crl
# Verify again — should now fail
exec_in openclaw clawdentity verify "$MSG_ID" && exit 1 || echo "correctly rejected revoked agent"
```

#### Scenario 12: Key Rotation Mid-Conversation
```
# OpenClaw rotates keys, re-registers, then messages PicoClaw
exec_in openclaw clawdentity keypair rotate
exec_in openclaw clawdentity register --update
DID_PICO=$(exec_in picoclaw clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_PICO" "post-rotation msg"
sleep 2
# PicoClaw should receive and verify with new key
MSG_ID=$(exec_in picoclaw clawdentity inbox list --json | jq -r '.[-1].id')
exec_in picoclaw clawdentity verify "$MSG_ID"   # should pass with rotated key
```

### Phase 5: Platform-Specific Integration

#### Scenario 13: OpenClaw Agent Processes Clawdentity Message
```
# Verify OpenClaw gateway actually routes the webhook payload into the agent's session
# This tests the full OpenClaw pipeline: webhook → channel adapter → agent context
DID_OC=$(exec_in openclaw clawdentity whoami --json | jq -r .did)
exec_in picoclaw clawdentity send "$DID_OC" "process this in openclaw agent"
sleep 3
# Check OpenClaw session logs for the message
exec_in openclaw cat /root/.openclaw/agents/main/sessions/*/transcript.jsonl | \
  jq -e 'select(.content | contains("process this in openclaw agent"))'
```

#### Scenario 14: PicoClaw Channel Integration
```
# Verify PicoClaw's Go channel adapter registered and processes messages
# through PicoClaw's existing message bus (not just clawdentity inbox)
exec_in picoclaw cat /var/log/picoclaw/channels.log | grep "clawdentity channel initialized"
DID_PICO=$(exec_in picoclaw clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_PICO" "go channel test"
sleep 2
# Verify it hit PicoClaw's internal message handler
exec_in picoclaw cat /var/log/picoclaw/messages.log | grep "go channel test"
```

#### Scenario 15: NanoBot Python Channel Integration
```
# Same as above but for NanoBot's Python async handler
exec_in nanobot python -c "from nanobot.channels import ClawdentityChannel; print('import ok')"
DID_NB=$(exec_in nanobot clawdentity whoami --json | jq -r .did)
exec_in openclaw clawdentity send "$DID_NB" "python channel test"
sleep 2
exec_in nanobot cat /var/log/nanobot/messages.log | grep "python channel test"
```

#### Scenario 16: Service Install (systemd in Ubuntu container)
```
# Use a separate Ubuntu 24.04 container with systemd
exec_in ubuntu-agent clawdentity service install --platform linux
exec_in ubuntu-agent systemctl --user status clawdentity-connector
exec_in ubuntu-agent systemctl --user stop clawdentity-connector
```

## CI Integration

### GitHub Actions workflow (`.github/workflows/integration.yml`)
```yaml
name: Integration Tests
on:
  push:
    branches: [main, develop]
    paths: ['crates/**', 'tests/integration/**']
  pull_request:
    branches: [main, develop]
    paths: ['crates/**', 'tests/integration/**']

jobs:
  integration:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: x86_64-unknown-linux-musl

      - name: Install musl tools
        run: sudo apt-get install -y musl-tools

      - name: Build linux binary
        run: |
          cargo build --release --target x86_64-unknown-linux-musl \
            --manifest-path crates/Cargo.toml -p clawdentity-cli

      - name: Build and run integration tests
        working-directory: tests/integration
        run: |
          docker compose up --build --abort-on-container-exit \
            --exit-code-from test-runner

      - name: Collect logs on failure
        if: failure()
        working-directory: tests/integration
        run: docker compose logs > /tmp/integration-logs.txt

      - name: Upload logs
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: integration-logs
          path: /tmp/integration-logs.txt
```

## Test Runner Script Structure

```
tests/integration/
├── docker-compose.yml
├── Dockerfile.agent
├── Dockerfile.mock-registry
├── Dockerfile.mock-proxy
├── mock-registry/
│   └── src/main.rs          # axum mock registry
├── mock-proxy/
│   └── src/main.rs          # axum mock proxy
├── scenarios/
│   ├── run-all.sh           # orchestrator
│   ├── 01-identity.sh
│   ├── 02-pairing.sh
│   ├── 03-messaging-ws.sh
│   ├── 04-messaging-poll.sh
│   ├── 05-offline-outbox.sh
│   ├── 06-trust-verify.sh
│   ├── 07-webhook.sh
│   ├── 08-burst.sh
│   ├── 09-cross-platform.sh
│   ├── 10-concurrent-pair.sh
│   ├── 11-key-rotation.sh
│   └── 12-service.sh
└── lib/
    ├── assert.sh            # test assertions (pass/fail/eq)
    ├── helpers.sh           # wait_for, exec_in, get_did
    └── colors.sh            # output formatting
```

### `run-all.sh` pattern:
```bash
#!/bin/sh
set -e
PASS=0; FAIL=0; SKIP=0

for scenario in /scenarios/[0-9]*.sh; do
  echo "━━━ Running: $(basename $scenario) ━━━"
  if sh "$scenario"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
  fi
done

echo "━━━━━━━━━━━━━━━━━━━━━"
echo "PASS: $PASS  FAIL: $FAIL  SKIP: $SKIP"
[ "$FAIL" -eq 0 ] || exit 1
```

### Individual scenario pattern:
```bash
#!/bin/sh
. /scenarios/lib/assert.sh
. /scenarios/lib/helpers.sh

# Setup
DID_A=$(exec_in agent-a clawdentity init --json | jq -r .did)
DID_B=$(exec_in agent-b clawdentity init --json | jq -r .did)

# Register both
exec_in agent-a clawdentity register
exec_in agent-b clawdentity register

# Pair
TICKET=$(exec_in agent-a clawdentity pair start --json | jq -r .ticket)
exec_in agent-b clawdentity pair confirm "$TICKET"

# Verify
PEERS_A=$(exec_in agent-a clawdentity peers list --json | jq length)
assert_eq "$PEERS_A" "1" "agent-a should have 1 peer"

echo "PASS: pairing flow"
```

## Implementation Order

1. **Mock registry** (axum, in-memory) — ~2 hours
2. **Mock proxy** (axum + tungstenite) — ~3 hours
3. **Dockerfiles + compose** — ~1 hour
4. **Test helpers** (assert.sh, helpers.sh) — ~1 hour
5. **Scenarios 1-4** (identity, pairing, messaging) — ~2 hours
6. **Scenarios 5-8** (offline, trust, webhook, burst) — ~3 hours
7. **CI workflow** — ~1 hour
8. **Scenarios 9-12** (advanced) — ~2 hours

**Total estimate: ~15 hours of implementation**

## Local Development

```bash
# Run locally (M1 Mac with Docker Desktop)
cd tests/integration

# Build the musl binary first
source $HOME/.cargo/env
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=x86_64-linux-musl-gcc \
  cargo build --release --target x86_64-unknown-linux-musl \
  --manifest-path ../../crates/Cargo.toml -p clawdentity-cli

# Run all scenarios
docker compose up --build --abort-on-container-exit

# Run single scenario for debugging
docker compose up -d agent-a agent-b mock-registry mock-proxy
docker compose exec agent-a clawdentity init
docker compose exec agent-a clawdentity register
# ... manually test
docker compose down
```

## Open Questions
- [ ] Should mock-registry persist state to disk (for restart scenarios)?
- [ ] Do we need ARM64 containers too (for M-series CI runners)?
- [ ] Should we test against the real registry in a separate "smoke test" job?
- [ ] Add chaos testing (random network partitions via `tc netem`)?
