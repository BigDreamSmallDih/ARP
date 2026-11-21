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
                    registry,        pipeline,      audit log)
                    adapters)        McpServer)
                            └─────────┬───────────────┘
                                packages/shared
                          (Zod schemas, GatewayError)
```

Dependencies point one way: `shared` ← `security` ← `agents` and `mcp` ← `gateway`. The dashboard
depends only on `shared`, so `shared` stays free of Node-only imports.

## Packages

**`packages/shared`** holds the Zod schemas for everything that crosses a boundary (system status,
agents, gateway info, session status, audit events, error bodies) and the `GatewayError` class with its
error codes and HTTP status mapping. The backend validates against these schemas before responding, and
the dashboard validates against the same schemas when it reads responses.

**`backend/security`** has three small pieces: SHA-256 token digests compared with
`timingSafeEqual`, permission checks, and the `AuditLog`, a bounded in-memory trail that also calls a
listener so the gateway can write each event to its structured log.

**`backend/agents`** has the static agent roster, the `AgentRegistry` that authenticates a bearer token
to an agent identity, and the placeholder provider adapters. An adapter receives only whether a key is
present, so it never holds a secret.

**`packages/mcp`** defines tools and runs them. A tool is a name, a required permission, Zod input and
output schemas, and a handler that talks to the gateway through the `GatewayServices` interface rather
than reaching into gateway internals. `executeTool` is the single pipeline every call goes through.
`createMcpServer` registers the tools on an official SDK `McpServer`.

**`backend/gateway`** wires everything: environment validation, session tracking, the Fastify routes,
the MCP-over-HTTP handler, CORS for the dashboard origin, and error mapping.

**`apps/dashboard`** is a React single-page app with hash routing. It polls the gateway, validates each
response, and models connection state explicitly (loading, unreachable, token needed, token rejected,
admin API disabled, ready) instead of showing stale or invented data.

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

An agent identity is an id, a display name and a set of permissions. Phase 1 defines four read-only
permissions (`system:read`, `agents:read`, `gateway:read`, `session:read`) and grants all of them to
each agent. The mechanism is what matters now: tools declare the permission they need, and the
pipeline enforces it on every call. Later phases add write-capable permissions and differentiate agents.

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

**Plain JSON responses on the MCP transport.** `enableJsonResponse` is on. Phase 1 tools are simple
request and response, so no server-initiated streaming is needed. Revisit when a tool needs progress
events or server notifications.

**One `McpServer` per session.** It lets each server hold its agent's identity directly. The price is
memory per session, bounded by `MAX_SESSIONS`.

**In-memory sessions and audit.** Simplest thing that works for one instance. Persistence and
multi-instance support are explicit later work.

**Placeholder adapters throw instead of pretending.** `invoke` rejects with `not_implemented`. A test
asserts that provider state can never be "connected".

**Secrets are digested at startup and not kept as plain comparison targets.** Provider keys are
reduced to a presence flag in configuration and are never stored.

**Two kinds of bearer token.** Agent tokens authorise `/mcp`; the admin token authorises `/api/*`. They
must differ, and each endpoint rejects the other's token.

## Extending in later phases

- **Real provider calls (Phase 2).** Implement `ProviderAdapter.invoke` per provider in
  `backend/agents`, load the provider keys there, and add a state beyond `configured` to
  `ProviderStateSchema` only once a call has actually succeeded.
- **Persistence.** Mirror the audit log into the `audit_events` table in `supabase/`, and move
  sessions to a shared store before running more than one gateway instance.
- **Roblox.** Add it as its own package behind a permission, and only for experiences where
  integration is officially permitted. The dashboard already reports it as "Not integrated".
- **More tools.** Add a `defineTool` entry to `TOOLS` in `packages/mcp`. The registry, permission
  check, validation, audit and dashboard listing follow from that.
- **Differentiated agents.** Give agents different permission sets in `backend/agents/src/roster.ts`.
