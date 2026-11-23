# Architecture

## Overview

```
 MCP clients (ChatGPT, Claude, Gemini agents)         Browser
            │  Bearer agent token                        │  Bearer admin token
            ▼                                            ▼
   POST/GET/DELETE /mcp                       GET /health, /api/*
            │                                            │
            └──────────────┐          ┌──────────────────┘
                           ▼          ▼
                     backend/gateway (Fastify)
        ┌────────────┬─────────────┬──────────────┬─────────────┐
        │ config     │ SessionStore│ McpGateway   │ services    │
        └────────────┴──────┬──────┴──────┬───────┴──────┬──────┘
                            │             │              │
                   backend/agents   packages/mcp   backend/security
                   (roster,         (tools, exec   (tokens, perms,
                    registry,        pipeline,      audit log, rate
                    adapters)        McpServer)     limiter, Secret)
                        │                └──────────┬──────┘
                        ▼                           │
              OpenAI / Anthropic / Gemini      packages/shared
              (HTTPS, key held backend-only)  (Zod schemas, GatewayError)
```

Dependencies point one way: `shared` ← `security` ← `agents` and `mcp` ← `gateway`. The dashboard
depends only on `shared`, so `shared` stays free of Node-only imports.

## Packages

**`packages/shared`** holds the Zod schemas for everything that crosses a boundary (system status,
agents, gateway info, session status, audit events, error bodies) and the `GatewayError` class with its
error codes and HTTP status mapping. The backend validates against these schemas before responding, and
the dashboard validates against the same schemas when it reads responses.

**`backend/security`** has small, independent pieces: SHA-256 token digests compared with
`timingSafeEqual`, permission checks, the `AuditLog` (a bounded in-memory trail that also calls a
listener so the gateway can write each event to its structured log), `RateLimiter` (a fixed-window
counter per key with bounded memory), and `Secret`, a wrapper that stays `[redacted]` under
`JSON.stringify`, string conversion and `util.inspect`.

**`backend/agents`** has the static agent roster, the `AgentRegistry` that authenticates a bearer token
to an agent identity and resolves an agent to its provider adapter, and the provider adapters. See
[Provider adapters](#provider-adapters).

**`packages/mcp`** defines tools and runs them. A tool is a name, a required permission, Zod input and
output schemas, and a handler that talks to the gateway through the `GatewayServices` interface rather
than reaching into gateway internals. `executeTool` is the single pipeline every call goes through.
`createMcpServer` registers the tools on an official SDK `McpServer`.

**`backend/gateway`** wires everything: environment validation, session tracking, the Fastify routes,
the MCP-over-HTTP handler, request and authentication rate limiting, CORS for the dashboard origin, and
error mapping.

**`apps/dashboard`** is a React single-page app with hash routing. It polls the gateway, validates each
response, and models connection state explicitly (loading, unreachable, token needed, token rejected,
admin API disabled, ready) instead of showing stale or invented data.

## Provider adapters

`ProviderAdapter` is the single interface the gateway uses for every AI provider:

- `status()` returns the provider id, model, connection state, last success, last error kind and
  usage totals.
- `send(request)` sends one conversation (messages, optional system prompt, output token limit, optional
  abort signal) and returns text, the model the provider reports, finish reason and token usage when
  the provider supplies it.
- `verify()` makes a free, authenticated request (the provider's model-listing endpoint) so a key can
  be checked without spending tokens.

`HttpProviderAdapter` implements everything the providers share: the API key stays inside it, the
timeout and cancellation signal are combined with `AbortSignal.any`, HTTP failures are classified
(`auth_failed`, `rate_limited`, `timeout`, `unavailable`, `rejected`, `bad_response`), and the state is
derived from what actually happened. `OpenAIAdapter`, `ClaudeAdapter` and `GeminiAdapter` only build
their provider's HTTP request and read its response, validated with Zod.

**Provider state** is derived, never stored as a claim:

| State | Meaning |
| --- | --- |
| `unconfigured` | The key or the model is missing |
| `configured` | Both are set; no call has completed yet |
| `connecting` | A call is in flight and none has succeeded yet |
| `connected` | The most recent authenticated call (`verify` or `send`) succeeded |
| `error` | The most recent call failed. The next success returns it to `connected` |

A call cancelled by the caller does not change the state. Each adapter owns its own state, so one
provider failing cannot change another.

**Routing.** The `send_message` tool names a target agent. The gateway looks the agent up in the
registry, which resolves it to that agent's provider adapter. All provider traffic therefore goes
through the one gateway, the caller needs `providers:invoke`, and the caller is rate limited per agent.

**Adding a provider.** Add the id to `ProviderIdSchema`, write an adapter class that extends
`HttpProviderAdapter`, add it to `createProviderAdapters`, and add its key and model to the gateway
configuration. The compiler flags every `Record<ProviderId, ...>` that needs an entry.

**Prepared for later phases.** `ProviderRequest` carries a message list and a system prompt, so Phase 3
identity and memory can build the conversation before calling `send` without touching the adapters.

## Request flows

### MCP session

1. A client sends `initialize` to `POST /mcp` with `Authorization: Bearer <agent token>`.
2. The gateway authenticates the token against every agent's digest. A failure is audited as
   `auth.failed` and answered with 401.
3. The gateway checks session capacity, creates an `McpServer` bound to that agent, and a
   `StreamableHTTPServerTransport` with a generated session id. When the transport reports the
   session initialised, the session is recorded and `session.created` is audited.
4. Later requests carry `Mcp-Session-Id`. The gateway authenticates again, requires the session to
   exist and to belong to the same agent (otherwise 404 or 403), updates its activity time, and passes
   the request to that session's transport.
5. `DELETE /mcp` ends the session. Idle sessions are closed by a sweeper after
   `SESSION_IDLE_TTL_SECONDS`, and every session is closed on shutdown. Each closure is audited with its
   reason.

### Rate limiting and lockout

Three limits apply, all in memory and per process:

1. Every request except `/health` counts against `RATE_LIMIT_PER_MINUTE` for the client address.
2. Failed authentications (`/mcp` and `/api/*`) count against `AUTH_FAILURE_LIMIT` per 15 minutes. The
   lockout is checked before the credential is compared, so once it triggers, a correct token from
   that address is also refused until the window passes.
3. `send_message` counts against `PROVIDER_CALLS_PER_MINUTE` for the calling agent.

Refusals use `rate_limited` (HTTP 429 with `Retry-After`, or a tool error carrying `retryAfterSeconds`).
The client key is the socket address unless `TRUST_PROXY=true`, in which case `X-Forwarded-For` is read
only when the connection comes from loopback, and the rightmost untrusted entry is used. IPv6 clients are
keyed by their /64 prefix, because one client normally controls the whole prefix. An IPv4-mapped address
(`::ffff:a.b.c.d`, written in dotted, hexadecimal or expanded form) is keyed as that IPv4 address. The limiter
clock is monotonic so a system clock change cannot extend a lockout.

### Tool call

`executeTool` runs these steps in order and throws a `GatewayError` on any failure:

1. Check that the agent holds the tool's required permission.
2. Validate the input with the tool's Zod schema.
3. Run the handler.
4. Validate the result against the output schema.
5. Record a `tool.call` audit event with outcome `success`, `denied` or `error`.

The MCP layer returns a failure as a tool result with `isError: true` and a structured error body. Only
`invalid_request` errors carry details, because those describe the caller's own input; internal errors
expose a fixed message and keep their cause in the server log.

## Identity and permissions

An agent identity is an id, a display name, a provider and a set of permissions. There are four
read-only permissions (`system:read`, `agents:read`, `gateway:read`, `session:read`) and
`providers:invoke`, which allows billable provider calls. The roster grants `providers:invoke` by name
rather than as part of the read set. Tools declare the permission they need and the pipeline enforces
it on every call. Later phases add write-capable permissions and differentiate agents.

## Errors

All failures become a `GatewayError` with a code from a closed set. HTTP responses use
`{ "error": { "code", "message", "requestId?", "details?" } }`. Fastify's own 4xx errors (malformed
JSON, oversized bodies) are mapped to `invalid_request`. Anything unexpected becomes `internal_error`
and is logged with its cause.

## Decisions

**Workspace packages export TypeScript source.** Each package's `exports` points at `src/index.ts`.
There is no per-package build step, so type checking, tests (Vitest), the dashboard (Vite) and the
gateway bundle (esbuild) all read the same source. The cost is that packages cannot be published as is.

**The gateway ships as one esbuild bundle.** Workspace packages are inlined; `fastify`,
`@modelcontextprotocol/sdk` and `zod` stay external and are installed from the lockfile at deploy time.

**Plain JSON responses on the MCP transport.** `enableJsonResponse` is on. The tools are simple
request and response, and `send_message` is a single non-streaming call, so no server-initiated streaming is needed. Revisit when a tool needs progress
events or server notifications.

**One `McpServer` per session.** It lets each server hold its agent's identity directly. The price is
memory per session, bounded by `MAX_SESSIONS` and `MAX_SESSIONS_PER_AGENT`.

**In-memory sessions and audit.** Simplest thing that works for one instance. Persistence and
multi-instance support are explicit later work.

**Provider calls use `fetch` against the official REST APIs, not the vendor SDKs.** Each adapter makes
one non-streaming request. Three SDKs would add three dependency trees for that, and the lockfile can
only be regenerated on GitHub Actions. Native `fetch` with `AbortSignal` gives the timeout and
cancellation directly. If a later phase needs streaming, tool calling or batch APIs, switching one
adapter to its SDK touches only that adapter.

**No default model ids.** Provider model names change often and differ by account, so the gateway
requires `*_MODEL` and treats a provider without one as unconfigured instead of baking in a name that
may be retired.

**No automatic retries.** A retry of a billable call can bill twice. The caller decides whether to
call again, and the rate limit bounds the cost of doing so.

**Provider error text is built from the HTTP status only.** Response bodies are never copied into
errors, because providers can echo request content.

**Secrets are digested at startup and not kept as plain comparison targets.** Provider keys are held
in a `Secret`, revealed only inside the adapter while building a request.

**Two kinds of bearer token.** Agent tokens authorise `/mcp`; the admin token authorises `/api/*`. They
must differ, and each endpoint rejects the other's token.

## Extending in later phases

- **Persistence.** Mirror the audit log into the `audit_events` table in `supabase/`, and move
  sessions to a shared store before running more than one gateway instance.
- **Roblox.** Add it as its own package behind a permission, and only for experiences where
  integration is officially permitted. The dashboard already reports it as "Not integrated".
- **More tools.** Add a `defineTool` entry to `TOOLS` in `packages/mcp`. The registry, permission
  check, validation, audit and dashboard listing follow from that.
- **Differentiated agents.** Give agents different permission sets in `backend/agents/src/roster.ts`.
