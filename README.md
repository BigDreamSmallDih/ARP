# AI Roblox Player

A cloud-first platform where several AI agents (ChatGPT, Claude, Gemini) will eventually cooperate as
gaming companions in Roblox experiences where such integration is officially permitted.

The center of the design is a **Central MCP Gateway**: one authenticated Model Context Protocol server
that agents connect to, with an agent identity and permission model, sessions, an audit trail, and a
tool registry.

## Status: Phase 2 (provider integration)

What exists and what does not, stated plainly:

| Area | State |
| --- | --- |
| MCP gateway (Streamable HTTP, sessions, auth, audit, errors) | Implemented |
| Provider adapters for OpenAI, Anthropic Claude and Google Gemini | Implemented with `fetch` against the official REST APIs. Verified by mocked unit tests; **not yet run against the real APIs** (see [docs/TESTING.md](docs/TESTING.md)) |
| `send_message` tool routing a message to the provider behind an agent | Implemented |
| Provider state (`unconfigured`, `configured`, `connecting`, `connected`, `error`) | Implemented. `connected` only after a real authenticated call succeeded |
| Rate limiting, authentication lockout, request size limit | Implemented, per process, in memory |
| Dashboard (Overview, AI Agents, MCP Gateway, System Health, Settings) | Implemented; shows provider state and model |
| HTTPS | Reverse proxy examples in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) and `deploy/Caddyfile`; not tested by CI |
| Streaming, model tool calling, conversation memory, AI identity | Not implemented (later phases) |
| Roblox integration of any kind | **Not implemented** |
| Supabase persistence | Not implemented. Schema and configuration only |
| Offline support / service worker in the dashboard | Not implemented. Manifest and icons only |

## Repository layout

```
apps/dashboard/      React + Vite dashboard (PWA manifest and icons, no service worker yet)
backend/gateway/     Fastify server: config, sessions, MCP over HTTP, admin API, rate limiting
backend/agents/      Agent roster, agent registry, OpenAI / Claude / Gemini provider adapters
backend/security/    Token digests, permission checks, audit log, rate limiter, Secret wrapper
packages/shared/     Zod schemas and error model shared by backend and dashboard
packages/mcp/        Tool definitions, tool execution pipeline, MCP server factory
supabase/            SQL migration and notes (not wired in yet)
docs/                PROVIDERS.md, DEPLOYMENT.md, TESTING.md
deploy/              Caddyfile example for HTTPS
.github/workflows/   bootstrap.yml (lockfile), ci.yml, integration.yml (manual, real providers)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together, [SECURITY.md](SECURITY.md) for
the security model, [docs/PROVIDERS.md](docs/PROVIDERS.md) to configure providers,
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) to deploy behind HTTPS, and [docs/TESTING.md](docs/TESTING.md)
for what is tested and how.

## Getting started without a local development environment

Everything installs, tests and builds on GitHub Actions. You need nothing installed on your own device.

1. **Push to a `phase-1/**` branch.** The **Bootstrap lockfile** workflow starts by itself. It
   resolves dependencies, writes `package-lock.json`, checks the lockfile, reinstalls with `npm ci`,
   then runs lint, typecheck, tests and both builds. You can also start it from the Actions tab once
   the workflow file exists on the default branch.
2. **Read the results.** The run summary lists each check, and the end of every failed log appears as
   an annotation on the run. The `bootstrap-reports` artifact holds the full logs.
3. **Review the lockfile.** When every check passes, the workflow commits `package-lock.json` to that
   branch as a bot commit, so the lockfile appears in the pull request diff. Manual runs commit only
   with `commit_lockfile` enabled, and replace an existing lockfile only with `regenerate` enabled.
4. **Use the regular CI.** With a lockfile committed, `ci.yml` runs on every pull request and every
   push to `main`. It verifies the lockfile and installs with `npm ci`.

If a lockfile is not committed yet, `ci.yml` fails at its first step with a message saying so. That
is expected.

## Running locally (optional)

Only needed if you develop on a machine with Node.js 20.19 or newer.

```sh
cp .env.example .env     # then fill in secrets; empty values mean "unset"
npm ci
npm run dev:gateway      # http://127.0.0.1:8787
npm run dev:dashboard    # proxies /api and /health to the gateway
npm run lint && npm run typecheck && npm test && npm run build
```

## Configuration

All configuration comes from environment variables, validated at startup. The gateway exits with a list
of problems if any value is invalid, and the messages never contain secret values. `.env.example`
documents every variable. The important ones:

| Variable | Purpose |
| --- | --- |
| `GATEWAY_ADMIN_TOKEN` | Bearer token for `/api/*`, used by the dashboard. Unset disables the admin API |
| `GATEWAY_TOKEN_CHATGPT`, `_CLAUDE`, `_GEMINI` | Bearer token each agent uses to connect to `/mcp`. All tokens must differ and be 32+ characters |
| `OPENAI_API_KEY` + `OPENAI_MODEL`, `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL`, `GEMINI_API_KEY` + `GEMINI_MODEL` | A provider works only when both its key and model are set. There are no default models. See [docs/PROVIDERS.md](docs/PROVIDERS.md) |
| `RATE_LIMIT_PER_MINUTE`, `AUTH_FAILURE_LIMIT`, `PROVIDER_CALLS_PER_MINUTE` | Request, failed-login and provider-call limits |
| `TRUST_PROXY` | `true` only behind your own reverse proxy |
| `DASHBOARD_ORIGIN` | Browser origin allowed to call the gateway, when the dashboard is hosted separately |

Generate a token with `openssl rand -hex 32`. Never commit a `.env` file.

## Connecting an MCP client

The gateway speaks MCP over Streamable HTTP at `POST /mcp` and answers with plain JSON. A client
authenticates with `Authorization: Bearer <agent token>`, sends `initialize`, and then includes the
returned `Mcp-Session-Id` header on every request. A session belongs to the agent that created it and
expires after the idle timeout.

Tools:

| Tool | Permission | Returns |
| --- | --- | --- |
| `get_system_status` | `system:read` | Uptime, component and provider state, session usage, warnings |
| `get_registered_agents` | `agents:read` | Agents, permissions and credential state; optional `provider` filter |
| `get_gateway_info` | `gateway:read` | Version, transport, auth scheme, tools, session limits |
| `get_session_status` | `session:read` | The caller's own session |
| `send_message` | `providers:invoke` | Sends one message to the provider behind the named agent and returns its reply. **Billable** |

Every response is validated against a Zod schema before it is returned.

## Admin API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness: status, version, uptime |
| `GET /api/status` | admin token | Same data as `get_system_status` |
| `GET /api/agents` | admin token | Registered agents |
| `GET /api/gateway` | admin token | Same data as `get_gateway_info` |
| `GET /api/audit?limit=` | admin token | Recent audit events, newest first |
| `POST /api/providers/{openai,anthropic,gemini}/verify` | admin token | Checks the provider key with a free request and updates the provider state |

## Dashboard hosting

`npm run build:dashboard` produces static files in `apps/dashboard/dist`. Serve them from the same origin
as the gateway, or from another host with `DASHBOARD_ORIGIN` set on the gateway. A dashboard served
over HTTPS cannot call a gateway over plain HTTP. The admin token is typed into Settings and kept in
session storage only.

## Known limitations

- Audit events, sessions, provider state, usage counters and rate-limit windows live in memory and are
  lost on restart. The gateway cannot run as multiple instances yet.
- The gateway has no TLS of its own; use a reverse proxy ([docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).
- The adapters have been tested only against mocked responses in CI. Run the manual
  `Provider integration tests` workflow with your own keys to check them against the real APIs.
- Each message is one stateless, non-streaming provider call.
- The gateway does not serve the dashboard; they deploy separately.
- The dashboard cannot trigger provider verification yet; use the `verify` endpoint.

## License

MIT. See [LICENSE](LICENSE).
