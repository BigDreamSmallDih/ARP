# Security

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" option on this
repository's Security tab, or contact the maintainer directly. Do not open a public issue for a
vulnerability.

## Scope and rules for this project

- No unauthorized Roblox account automation, exploits, or input automation. Roblox integration will be
  built only for experiences where it is officially permitted, and does not exist yet.
- No secrets in the repository. `.env` files are ignored by Git; `.env.example` contains only empty
  placeholders.
- Provider API keys exist only in the gateway process. They are held in a `Secret` that serialises as
  `[redacted]`, are sent only to the provider's own HTTPS endpoint in a request header, and never appear
  in responses, tool output, audit events, errors or logs.

## How the gateway protects itself

**Authentication.** Agents authenticate to `/mcp` with a per-agent bearer token, and the dashboard
authenticates to `/api/*` with a separate admin token. Tokens must be at least 32 characters and all
distinct. Configuration refuses to start if two credentials match.

**Token handling.** Tokens are reduced to SHA-256 digests at startup and compared with
`timingSafeEqual`. The authenticator checks every agent on every attempt so timing does not reveal
which agent matched. An unset or empty token is not a credential: the agent simply cannot connect.

**Sessions.** A session is bound to the agent that initialised it. Presenting another agent's valid
token with that session id is refused and audited. Sessions expire after an idle timeout, are capped by
`MAX_SESSIONS` overall and `MAX_SESSIONS_PER_AGENT` per agent, and are closed on shutdown.

**Permissions.** Every tool declares a required permission, checked before input is parsed or the
handler runs. Four are read-only. `providers:invoke`, which allows billable provider calls, is granted
to agents by name in the roster.

**Rate limiting.** Requests per client address per minute (`RATE_LIMIT_PER_MINUTE`, `/health`
excluded), failed authentications per client address per 15 minutes (`AUTH_FAILURE_LIMIT`), and provider
calls per calling agent per minute (`PROVIDER_CALLS_PER_MINUTE`). The failure lockout is checked before
the credential is compared, so it also stops token guessing. Refusals are `429` with `Retry-After`.
Limits are per process and in memory.

**Request size.** Bodies above `REQUEST_BODY_LIMIT_BYTES` are rejected. Tool inputs have their own
length limits (16,000 characters per message, 4,000 for a system prompt, 8,192 output tokens).

**Provider calls.** Every call has a timeout (`PROVIDER_TIMEOUT_MS`) and stops when the MCP client
cancels. Output tokens are capped by `PROVIDER_MAX_OUTPUT_TOKENS`. The gateway never retries. Error
messages contain only the HTTP status, never the provider's response body.

**Validation.** Environment variables, tool inputs, tool outputs, admin API query parameters and the
dashboard's reads of gateway responses are all validated with Zod.

**Error responses.** Clients receive a fixed code and message. Internal causes, stack traces and
credential values never appear in responses. Validation details are returned only for
`invalid_request`, where they describe the caller's own input.

**Logging.** Requests are logged without their headers, and `Authorization`, `X-Api-Key` and
`X-Goog-Api-Key` are also on the redaction list. Audit events record who did
what and the outcome, and never contain tokens or tool payloads. Failed authentications are kept in
a separate, smaller in-memory buffer so unauthenticated traffic cannot evict other events.

**Browser access.** CORS is off unless `DASHBOARD_ORIGIN` is set, and then allows only that exact
origin with `GET` and `OPTIONS`. The dashboard keeps the admin token in session storage only, so it is
cleared when the tab closes.

## Known gaps

Be aware of these before exposing a gateway to a network:

- **No TLS in the gateway.** Terminate TLS in a reverse proxy (see
  [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)). Bearer tokens and provider traffic must never cross an
  untrusted network unencrypted.
- **Rate limits and lockouts are per process.** They reset on restart. Behind a proxy, set
  `TRUST_PROXY=true`, and only then. With it off, every client behind the proxy shares one address, so
  one attacker's failed logins can lock out the owner. With it on, `X-Forwarded-For` is trusted only
  from loopback, so the proxy must run on the same host as the gateway; a proxy on another host makes
  every client look like that proxy. IPv6 clients are limited per /64 prefix, which can group unrelated
  clients that share a prefix.
- **A lockout also blocks the valid token** from that address until the window passes.
- **Usage and cost.** Token counts are in memory. Real spending limits must be set at the provider.
- **Provider integration is verified only by mocks in CI.** The optional live workflow is the only test
  against the real APIs.
- **No persistence.** Audit events and sessions are in memory and are lost on restart.
- **No token rotation tooling.** Rotate by changing the environment variable and restarting, which ends
  all sessions.
- **No protection for a compromised host.** Anyone who can read the process environment can read the
  tokens.

## Supply chain

- Dependencies install from a committed `package-lock.json` with `npm ci`.
- `scripts/verify-lockfile.mjs` runs before every install in CI. It fails if the lockfile is missing,
  has an unexpected format, or contains any package that is not from the npm registry or has no
  integrity hash.
- Workflows request `contents: read` only. The bootstrap workflow requests `contents: write` solely so
  it can commit the generated lockfile when asked.
- GitHub Actions are referenced by major version tag, not by commit SHA. Pin them to SHAs if your
  threat model requires it.
