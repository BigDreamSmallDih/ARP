# AI Roblox Player

A cloud-first platform where several AI agents (ChatGPT, Claude, Gemini) will eventually cooperate as
gaming companions in Roblox experiences where such integration is officially permitted.

The center of the design is a **Central MCP Gateway**: one authenticated Model Context Protocol server
that agents connect to, with an agent identity and permission model, sessions, an audit trail, and a
tool registry.

## Status: Phase 1 (foundation)

What exists and what does not, stated plainly:

| Area | State |
| --- | --- |
| MCP gateway (Streamable HTTP, sessions, auth, audit, errors) | Implemented |
| Tool registry with four read-only demonstration tools | Implemented |
| Dashboard (Overview, AI Agents, MCP Gateway, System Health, Settings) | Implemented |
| Provider adapters for OpenAI, Anthropic, Gemini | **Placeholders.** They report whether an API key is set and refuse every call |
| Real provider API calls | Not implemented |
| Roblox integration of any kind | **Not implemented** |
| Supabase persistence | Not implemented. Schema and configuration only |
| Offline support / service worker in the dashboard | Not implemented. Manifest and icons only |

The dashboard shows a provider as at most "Key set, not verified". It never shows "connected", because
nothing connects to a provider yet.

## Repository layout

```
apps/dashboard/      React + Vite dashboard (PWA manifest and icons, no service worker yet)
backend/gateway/     Fastify server: config, sessions, MCP over HTTP, admin API
backend/agents/      Agent roster, agent registry, placeholder provider adapters
backend/security/    Token digests, permission checks, audit log
packages/shared/     Zod schemas and error model shared by backend and dashboard
packages/mcp/        Tool definitions, tool execution pipeline, MCP server factory
supabase/            SQL migration and notes (not wired in yet)
.github/workflows/   bootstrap.yml (lockfile + full check) and ci.yml
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the pieces fit together and [SECURITY.md](SECURITY.md)
for the security model.

## Getting started without a local development environment

Everything installs, tests and builds on GitHub Actions. You need nothing installed on your own device.

1. **Run the bootstrap workflow.** In the repository, open Actions, choose **Bootstrap lockfile**, and
   run it on the branch that holds this code. It resolves dependencies, writes `package-lock.json`,
   checks the lockfile, reinstalls with `npm ci`, then runs lint, typecheck, tests and both builds.
2. **Read the results.** The run summary lists each check. The `bootstrap-reports` artifact holds the
   full logs and the `package-lock` artifact holds the lockfile.
3. **Commit the lockfile.** When everything passes, run the workflow again on a non-default branch
   with `commit_lockfile` enabled. It resolves dependencies again, runs every check against the new
   lockfile, and commits `package-lock.json` to that branch only if all of them pass. If a lockfile is
   already committed and you want to replace it, also enable `regenerate`.
4. **Use the regular CI.** With a lockfile committed, `ci.yml` runs on every push to `main` and every
   pull request. It verifies the lockfile and installs with `npm ci`.

Until a lockfile is committed, `ci.yml` fails at its first step with a message saying so. That is
expected.

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
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Only checked for presence in Phase 1 |
| `DASHBOARD_ORIGIN` | Browser origin allowed to call the gateway, when the dashboard is hosted separately |

Generate a token with `openssl rand -hex 32`. Never commit a `.env` file.

## Connecting an MCP client

The gateway speaks MCP over Streamable HTTP at `POST /mcp` and answers with plain JSON. A client
authenticates with `Authorization: Bearer <agent token>`, sends `initialize`, and then includes the
returned `Mcp-Session-Id` header on every request. A session belongs to the agent that created it and
expires after the idle timeout.

Tools available in Phase 1, all read-only:

| Tool | Permission | Returns |
| --- | --- | --- |
| `get_system_status` | `system:read` | Uptime, component and provider state, session usage, warnings |
| `get_registered_agents` | `agents:read` | Agents, permissions and credential state; optional `provider` filter |
| `get_gateway_info` | `gateway:read` | Version, transport, auth scheme, tools, session limits |
| `get_session_status` | `session:read` | The caller's own session |

Every response is validated against a Zod schema before it is returned.

## Admin API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | none | Liveness: status, version, uptime |
| `GET /api/status` | admin token | Same data as `get_system_status` |
| `GET /api/agents` | admin token | Registered agents |
| `GET /api/gateway` | admin token | Same data as `get_gateway_info` |
| `GET /api/audit?limit=` | admin token | Recent audit events, newest first |

## Dashboard hosting

`npm run build:dashboard` produces static files in `apps/dashboard/dist`. Serve them from the same origin
as the gateway, or from another host with `DASHBOARD_ORIGIN` set on the gateway. A dashboard served
over HTTPS cannot call a gateway over plain HTTP. The admin token is typed into Settings and kept in
session storage only.

## Known limitations

- Audit events live in memory, bounded by `AUDIT_BUFFER_SIZE`, and are lost on restart.
- Sessions live in memory, so a restart ends them and the gateway cannot run as multiple instances yet.
- There is no rate limiting. Tokens are long random secrets, but put the gateway behind a proxy that
  limits request rates and terminates TLS.
- The gateway does not serve the dashboard; they deploy separately.
- Every Phase 1 permission is read-only and identical for all three agents.

## License

MIT. See [LICENSE](LICENSE).
