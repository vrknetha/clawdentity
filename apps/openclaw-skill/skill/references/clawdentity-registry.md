# Clawdentity Registry Operations Reference

## Purpose

Document registry-side CLI commands that are outside the core relay setup journey: admin bootstrap, API key lifecycle, agent revocation, and auth refresh.

## Admin Bootstrap

Bootstrap creates the first admin human and API key on a fresh registry. This is a prerequisite before any invites can be created.

### Command

```
clawdentity admin bootstrap --bootstrap-secret <secret>
```

### Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--bootstrap-secret <secret>` | Yes | One-time bootstrap secret configured on registry server |
| `--display-name <name>` | No | Admin display name |
| `--api-key-name <name>` | No | Admin API key label |
| `--registry-url <url>` | No | Override registry URL |

### Expected Output

```
Admin bootstrap completed
Human DID: did:cdi:<authority>:human:01H...
API key name: <name>
API key token (shown once):
<token>
Internal service ID: <id>
Internal service name: proxy-pairing
Set proxy secrets BOOTSTRAP_INTERNAL_SERVICE_ID and BOOTSTRAP_INTERNAL_SERVICE_SECRET manually in Cloudflare before proxy deploy.
API key saved to local config
```

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `ADMIN_BOOTSTRAP_DISABLED` | Bootstrap is disabled on the registry |
| `ADMIN_BOOTSTRAP_UNAUTHORIZED` | Bootstrap secret is invalid |
| `ADMIN_BOOTSTRAP_ALREADY_COMPLETED` | Admin already exists; bootstrap is one-time |
| `ADMIN_BOOTSTRAP_INVALID` | Request payload is invalid |
| `CLI_ADMIN_BOOTSTRAP_SECRET_REQUIRED` | Bootstrap secret was not provided |
| `CLI_ADMIN_BOOTSTRAP_INVALID_REGISTRY_URL` | Registry URL is invalid |
| `CLI_ADMIN_BOOTSTRAP_REQUEST_FAILED` | Unable to connect to registry |
| `CLI_ADMIN_BOOTSTRAP_CONFIG_PERSISTENCE_FAILED` | Failed to save admin credentials locally |

### Behavioral Notes

- One-time operation: succeeds only on first call per registry.
- Automatically persists `registryUrl` and `apiKey` to local config.
- Registry must have `BOOTSTRAP_SECRET` environment variable set.
- Registry must also have deterministic service credentials configured:
  - `BOOTSTRAP_INTERNAL_SERVICE_ID`
  - `BOOTSTRAP_INTERNAL_SERVICE_SECRET`
- `BOOTSTRAP_INTERNAL_SERVICE_ID` must match proxy `BOOTSTRAP_INTERNAL_SERVICE_ID`.
- `BOOTSTRAP_INTERNAL_SERVICE_SECRET` must match proxy `BOOTSTRAP_INTERNAL_SERVICE_SECRET`.
- After bootstrap, admin can create invites with `clawdentity invite create`.

## API Key Lifecycle

### Create API key

```
clawdentity api-key create
```

Creates a new API key under the current authenticated human. Token is displayed once.

### List API keys

```
clawdentity api-key list
```

Lists all API keys for the current human with ID, name, and status.

### Revoke API key

```
clawdentity api-key revoke <api-key-id>
```

Revokes an API key by ID. The key becomes immediately unusable.

### Rotation workflow

1. `clawdentity api-key create` — note the new token.
2. `clawdentity config set apiKey <new-token>` — switch local config.
3. `clawdentity api-key revoke <old-key-id>` — deactivate old key.
4. `clawdentity config get apiKey` — verify new key is active.

### Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 401 | API key invalid or expired; re-authenticate |
| 403 | Insufficient permissions (admin required for some operations) |

## Agent Revocation

### Command

```
clawdentity agent revoke <agent-name>
```

Revokes a local agent identity via the registry. The agent's AIT will appear on the certificate revocation list (CRL).

### Behavioral Notes

- Reads agent DID from `~/.clawdentity/agents/<agent-name>/identity.json`.
- Requires `apiKey` configured in `~/.clawdentity/config.json`.
- Idempotent: repeat revocation calls succeed without error.
- CRL propagation lag: verifiers using cached `crl-claims.json` (15-minute TTL) may not see revocation immediately.
- Local credential files are not deleted; only registry-side revocation is performed.

### Error Codes

| HTTP Status | Meaning |
|-------------|---------|
| 401 | Authentication failed — API key invalid |
| 404 | Agent not found in registry |
| 409 | Agent cannot be revoked (already revoked or conflict) |

## Agent Auth Refresh

### Command

```
clawdentity agent auth refresh <agent-name>
```

Refreshes the agent's registry auth credentials using Claw proof (Ed25519 signature).

### What It Reads

- `~/.clawdentity/agents/<agent-name>/secret.key` — for signing the proof
- `~/.clawdentity/agents/<agent-name>/registry-auth.json` — current refresh token

### What It Writes

- `~/.clawdentity/agents/<agent-name>/registry-auth.json` — new access token and refresh token

### Behavioral Notes

- Uses atomic write (temp file + chmod 0600 + rename) to prevent corruption.
- Requires `registryUrl` configured in `~/.clawdentity/config.json`.
- After refresh, restart connector to pick up new credentials.
- If `registry-auth.json` is missing or empty, the agent must be re-created with `agent create`.

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `CLI_OPENCLAW_EMPTY_AGENT_CREDENTIALS` | Registry auth file is empty or missing |
| 401 | Refresh token expired or invalid — re-create agent |

## Invite Management (Admin)

### Create invite

```
clawdentity invite create
clawdentity invite create --expires-at <iso-8601> --registry-url <url>
```

Admin-only. Creates a registry invite code (`clw_inv_...`) for onboarding new users.

### Error Codes

| Error Code | Meaning |
|------------|---------|
| `CLI_INVITE_MISSING_LOCAL_CREDENTIALS` | API key not configured |
| `CLI_INVITE_CREATE_FAILED` | Invite creation failed |
| 401 | Authentication failed |
| 403 | Requires admin access |
| 400 | Invalid request |

## Connector Errors

| Error Code | Meaning | Recovery |
|---|---|---|
| `CLI_CONNECTOR_SERVICE_PLATFORM_INVALID` | Invalid platform argument | Use `auto`, `launchd`, or `systemd` |
| `CLI_CONNECTOR_SERVICE_PLATFORM_UNSUPPORTED` | OS unsupported for selected platform | Use a supported platform (macOS: launchd, Linux: systemd) |
| `CLI_CONNECTOR_SERVICE_INSTALL_FAILED` | Service install failed | Check permissions, systemd/launchd status |
| `CLI_CONNECTOR_PROXY_URL_REQUIRED` | Proxy URL unresolvable | Run `invite redeem` or set `CLAWDENTITY_PROXY_URL` / `CLAWDENTITY_PROXY_WS_URL` |
| `CLI_CONNECTOR_INVALID_REGISTRY_AUTH` | `registry-auth.json` corrupt or invalid | Run `clawdentity agent auth refresh <agent-name>` |
| `CLI_CONNECTOR_INVALID_AGENT_IDENTITY` | `identity.json` corrupt or invalid | Re-create agent with `clawdentity agent create <agent-name>` |
