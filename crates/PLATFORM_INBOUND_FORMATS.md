# Platform Inbound Formats (Phase 2)

This document captures the inbound gateway contract for each requested platform repo, focused on HTTP ingress where it exists.

OpenClaw reference pattern (for comparison): `deliverToOpenclawHook()` sends `POST` JSON with headers:
- `x-clawdentity-agent-did`
- `x-clawdentity-to-agent-did`
- `x-clawdentity-verified`
- `x-openclaw-token` (optional)
- `x-request-id`

Source: `packages/connector/src/runtime/openclaw.ts:94`, `packages/connector/src/runtime/openclaw.ts:109`

## 1) NanoBot Python (`/Users/ravikiranvemula/Workdir/nanobot`)

Status: no inbound HTTP webhook gateway is implemented in the active channel stack.

1. HTTP endpoint path + port
- None for inbound webhook delivery.
- `nanobot gateway --port` only prints a port in CLI logs; it does not start an HTTP listener.
- Source: `/Users/ravikiranvemula/Workdir/nanobot/nanobot/cli/commands.py:326`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/cli/commands.py:344`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/cli/commands.py:418`

2. Exact JSON payload shape
- HTTP: N/A (no inbound HTTP route).
- Closest inbound transport is WebSocket from the WhatsApp bridge:
  - Bridge emits:
```json
{
  "type": "message",
  "id": "string",
  "sender": "string",
  "pn": "string",
  "content": "string",
  "timestamp": "number",
  "isGroup": "boolean"
}
```
  - `type` is required for dispatch; supported values include `message`, `status`, `qr`, `error`.
  - Source: `/Users/ravikiranvemula/Workdir/nanobot/bridge/src/server.ts:16`, `/Users/ravikiranvemula/Workdir/nanobot/bridge/src/server.ts:36`, `/Users/ravikiranvemula/Workdir/nanobot/bridge/src/whatsapp.ts:20`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/channels/whatsapp.py:102`

3. HTTP headers it expects/checks
- None (no inbound HTTP handler).

4. Auth for inbound webhook calls
- None for HTTP (no inbound HTTP).
- WebSocket bridge auth is optional token handshake:
  - First frame must be `{"type":"auth","token":"..."}` when bridge token is configured.
  - Source: `/Users/ravikiranvemula/Workdir/nanobot/bridge/src/server.ts:43`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/channels/whatsapp.py:46`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/config/schema.py:19`

5. How inbound message routes into the agent loop
- Bridge message -> `WhatsAppChannel._handle_bridge_message()` -> `BaseChannel._handle_message()` -> `MessageBus.publish_inbound()` -> `AgentLoop.run()` consumes inbound queue.
- Source: `/Users/ravikiranvemula/Workdir/nanobot/nanobot/channels/whatsapp.py:94`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/channels/base.py:86`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/bus/queue.py:20`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/agent/loop.py:229`

Notes:
- Slack config has `webhook_path` field, but runtime uses Socket Mode and not an HTTP route.
- Source: `/Users/ravikiranvemula/Workdir/nanobot/nanobot/config/schema.py:148`, `/Users/ravikiranvemula/Workdir/nanobot/nanobot/channels/slack.py:38`, `/Users/ravikiranvemula/Workdir/nanobot/README.md:475`

## 2) PicoClaw Go (`/Users/ravikiranvemula/Workdir/picoclaw`)

Status: HTTP webhook is implemented for multiple channels; JSON webhook contract below is for LINE channel.

1. HTTP endpoint path + port
- LINE webhook server binds `webhook_host:webhook_port`, default `0.0.0.0:18791`.
- Default path: `/webhook/line`.
- Source: `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:90`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:96`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/config/defaults.go:79`

2. Exact JSON payload shape
- Root payload (must parse as JSON):
```json
{
  "events": [
    {
      "type": "string",
      "replyToken": "string",
      "source": {
        "type": "string",
        "userId": "string",
        "groupId": "string",
        "roomId": "string"
      },
      "message": {
        "id": "string",
        "type": "string",
        "text": "string",
        "quoteToken": "string",
        "mention": {
          "mentionees": [
            {
              "index": "number",
              "length": "number",
              "type": "string",
              "userId": "string"
            }
          ]
        },
        "contentProvider": {
          "type": "string"
        }
      },
      "timestamp": "number"
    }
  ]
}
```
- Runtime-required semantics:
  - Top-level JSON parse must succeed (`400` otherwise).
  - `events[*].type` must be `"message"` to be processed (others ignored).
  - `events[*].message` must parse as JSON object (`lineMessage`) or event is dropped.
  - `replyToken`, `quoteToken`, `mention`, `contentProvider` are optional at runtime.
- Source: `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:199`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:232`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:247`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:267`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:279`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:296`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:304`

3. HTTP headers it expects/checks
- Requires `X-Line-Signature`.
- Method must be `POST`.
- Source: `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:178`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:192`

4. Auth for inbound webhook calls
- HMAC-SHA256 over raw request body using `channel_secret`; base64 result must match `X-Line-Signature`.
- Channel startup also requires configured `channel_secret` + `channel_access_token`.
- Source: `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:58`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:218`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:224`

5. How inbound HTTP message routes into the agent loop
- `webhookHandler()` parses body -> dispatches `processEvent()` goroutines -> `HandleMessage()` builds `bus.InboundMessage` -> `MessageBus.PublishInbound()` -> `AgentLoop.Run()` consumes and processes.
- Source: `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:177`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/line.go:214`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/channels/base.go:84`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/bus/bus.go:24`, `/Users/ravikiranvemula/Workdir/picoclaw/pkg/agent/loop.go:153`

## 3) NanoClaw hustcc (`/Users/ravikiranvemula/Workdir/nano-claw-hustcc`)

Status: no inbound HTTP webhook gateway is implemented.

1. HTTP endpoint path + port
- None.
- `GatewayServer` is an orchestrator for channel adapters and message bus; no `listen()`/HTTP server setup exists there.
- Source: `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/gateway/server.ts:18`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/gateway/server.ts:101`

2. Exact JSON payload shape
- HTTP: N/A (no inbound HTTP route).
- Internal normalized inbound schema is `ChannelMessage`:
  - Required: `id`, `sessionId`, `userId`, `content`, `channelType`, `timestamp`
  - Optional: `metadata`
- Source: `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/types.ts:102`

3. HTTP headers it expects/checks
- None (no inbound HTTP handler).

4. Auth for inbound webhook calls
- None for HTTP (no inbound HTTP).
- Channel auth is platform-native credentials/tokens:
  - Telegram token
  - Discord bot token
  - DingTalk clientId/clientSecret
- Source: `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/telegram.ts:40`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/discord.ts:40`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/dingtalk.ts:41`

5. How inbound message routes into the agent loop
- Channel SDK callback builds `ChannelMessage` -> emits `message` event.
- `ChannelManager` forwards to `MessageBus.publish()`.
- `GatewayServer` subscribes via `subscribeAll()` and runs `handleMessage()`.
- `handleMessage()` creates `AgentLoop` and calls `processMessage(content)`, then sends response back via `ChannelManager.sendMessage()`.
- Source: `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/telegram.ts:158`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/discord.ts:188`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/dingtalk.ts:214`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/channels/manager.ts:34`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/bus/index.ts:66`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/gateway/server.ts:48`, `/Users/ravikiranvemula/Workdir/nano-claw-hustcc/src/gateway/server.ts:150`

## 4) NanoClaw qwibitai (`/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai`)

Status: no inbound HTTP webhook gateway is implemented.

1. HTTP endpoint path + port
- None.
- Runtime is `node dist/index.js` with channel-driven ingress, not an HTTP server.
- Source: `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/launchd/com.nanoclaw.plist:7`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:412`

2. Exact JSON payload shape
- HTTP: N/A (no inbound HTTP route).
- Inbound normalized message persisted to DB is `NewMessage`:
  - Required: `id`, `chat_jid`, `sender`, `sender_name`, `content`, `timestamp`
  - Optional: `is_from_me`, `is_bot_message`
- Source: `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/types.ts:44`

3. HTTP headers it expects/checks
- None (no inbound HTTP handler).

4. Auth for inbound webhook calls
- None for HTTP (no inbound HTTP).
- Inbound auth is WhatsApp/Baileys session auth state (`useMultiFileAuthState`, signal key store), not HTTP signature/header auth.
- Source: `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/channels/whatsapp.ts:56`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/channels/whatsapp.ts:58`

5. How inbound message routes into the agent loop
- Baileys `messages.upsert` callback creates `NewMessage` and invokes `onMessage`.
- `onMessage` callback stores to SQLite (`storeMessage`).
- Main loop polls `getNewMessages()` / `getMessagesSince()`, formats prompt, and dispatches to `runAgent()`.
- `runAgent()` calls `runContainerAgent()` for assistant execution and sends output back through the channel.
- Source: `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/channels/whatsapp.ts:147`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/channels/whatsapp.ts:189`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:430`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/db.ts:239`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:298`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:355`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:219`, `/Users/ravikiranvemula/Workdir/nanoclaw-qwibitai/src/index.ts:265`

## Cross-platform conclusion

- Of the four requested repos, only PicoClaw (LINE channel) currently exposes a JSON HTTP webhook contract suitable for direct inbound HTTP relay.
- NanoBot, nano-claw-hustcc, and nanoclaw-qwibitai currently ingest via SDK/WebSocket/event streams rather than HTTP webhook endpoints.
