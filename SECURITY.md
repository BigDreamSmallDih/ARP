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
- Provider calls are not implemented. Provider API keys are not loaded into memory beyond a
  "key is present" flag.

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
handler runs. Phase 1 has read-only permissions only.

**Validation.** Environment variables, tool inputs, tool outputs, admin API query parameters and the
dashboard's reads of gateway responses are all validated with Zod.

**Error responses.** Clients receive a fixed code and message. Internal causes, stack traces and
credential values never appear in responses. Validation details are returned only for
`invalid_request`, where they describe the caller's own input.

**Logging.** Requests are logged with the `Authorization` header redacted. Audit events record who did
what and the outcome, and never contain tokens or tool payloads. Failed authentications are kept in
a separate, smaller in-memory buffer so unauthenticated traffic cannot evict other events.

**Browser access.** CORS is off unless `DASHBOARD_ORIGIN` is set, and then allows only that exact
origin with `GET` and `OPTIONS`. The dashboard keeps the admin token in session storage only, so it is
cleared when the tab closes.

## What Phase 1 does not do

Be aware of these before exposing a gateway to a network:

- **No rate limiting or lockout.** Run the gateway behind a reverse proxy or platform that limits
  request rates.
- **No TLS.** Terminate TLS in front of the gateway. Bearer tokens must never travel over plain HTTP on
  an untrusted network.
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
