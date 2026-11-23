# Testing

Everything runs on GitHub Actions. Nothing needs to be installed on your own device.

## Automated checks

`ci.yml` runs on pushes to `main`, `phase-1/**` and `phase-2/**`, and on pull requests:

| Job | What it does |
| --- | --- |
| Lint and typecheck | `npm run lint`, `npm run typecheck` |
| Unit tests (Node 20, Node 22) | `npm run test:ci` on both versions, with a JUnit report artifact |
| Build gateway | esbuild bundle, then starts the bundle and requests `/health` |
| Build dashboard | Vite production build |

Every job first verifies `package-lock.json` (`scripts/verify-lockfile.mjs`) and installs with `npm ci`.

## What the unit tests cover

All provider traffic in unit tests goes to a scripted fake `fetch`. No test calls a provider and no test
needs a key.

| Area | Where |
| --- | --- |
| Each provider adapter: request shape, response mapping, usage, HTTP error classes, bad bodies, timeout, caller cancellation, `connecting`, recovery, `verify` | `backend/agents/src/adapters.test.ts` |
| Failure isolation between providers | `adapters.test.ts`, `backend/gateway/src/mcp-http.test.ts` |
| Configuration validation, secret handling | `backend/gateway/src/config.test.ts`, `backend/security/src/security.test.ts` |
| Input and output validation of `send_message` | `packages/mcp/src/tools.test.ts` |
| Routing to the right provider over real MCP-over-HTTP sessions | `mcp-http.test.ts` |
| Rate limiter, per-minute limit, authentication lockout, request size limit | `security.test.ts`, `auth-guard.test.ts`, `app.test.ts`, `services.test.ts` |
| Authentication and permissions | `app.test.ts`, `mcp-http.test.ts`, `tools.test.ts` |
| Secret redaction: keys absent from status, tool output, audit events, errors and logs | `adapters.test.ts`, `mcp-http.test.ts`, `app.test.ts`, `services.test.ts` |
| Dashboard rendering of provider states | `apps/dashboard/src/present.test.ts` |

Run one area locally with `npx vitest run <path>` if you have Node 20.19 or newer.

## Integration tests against real providers

`integration.yml` is run by hand from the Actions tab (Run workflow). It never runs on pushes or pull
requests, so repository secrets are not exposed to forks.

1. Add repository secrets, in pairs per provider: `OPENAI_API_KEY` and `OPENAI_MODEL`,
   `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL`, `GEMINI_API_KEY` and `GEMINI_MODEL`.
2. Run the workflow. A provider without both secrets is skipped, and if none has both, the run says so
   and passes without calling anything.
3. By default each configured provider is only verified, which uses the free model-listing endpoint.
4. Tick **paid_calls** to also send one small message (at most 64 output tokens) to each configured
   provider.

The workflow file must exist on the default branch before the Run workflow button appears.

A passing integration run is the only evidence that the adapters work against the real APIs. Unit tests
prove the adapters handle the documented response shapes, not that the providers still return them.
