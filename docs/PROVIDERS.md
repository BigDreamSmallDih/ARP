# Providers

The gateway can call OpenAI, Anthropic Claude and Google Gemini. Each provider is configured with
environment variables on the gateway. Keys live only in the gateway process. They are never sent to the
dashboard, returned by any API or tool, or written to logs.

A provider is usable only when **both** its API key and its model id are set. There are no default
models, because model names differ by account and change over time.

| Provider | Key variable | Model variable | Agent |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_MODEL` | `chatgpt` |
| Anthropic Claude | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | `claude` |
| Google Gemini | `GEMINI_API_KEY` | `GEMINI_MODEL` | `gemini` |

## Configuring a provider

1. Create an API key in the provider's console. Use a key with a spending limit if the provider offers
   one.
2. Look up the model id your account can use in the provider's model list.
3. Set both variables in the gateway's environment (a local `.env`, or your host's secret manager). Do
   not put them in a file that is committed.
4. Restart the gateway. The provider now shows as `configured`.
5. Check the key without spending tokens (replace the placeholder with your admin token):

   ```sh
   curl -X POST -H "Authorization: Bearer $GATEWAY_ADMIN_TOKEN" \
     https://your-gateway.example.com/api/providers/openai/verify
   ```

   The gateway calls the provider's model-listing endpoint. On success the provider becomes
   `connected`. On failure the response is `502 provider_error` and the state becomes `error`.

Verification proves that the key is accepted. It does not prove the configured model id exists or that
your account may use it; that shows up on the first `send_message`.

Model ids may contain letters, digits, `.`, `_`, `:` and `-`, and must start with a letter or digit.

## What "connected" means

| State | Meaning |
| --- | --- |
| `unconfigured` | Key or model missing |
| `configured` | Both set, no call has completed |
| `connecting` | A call is in flight and none has succeeded yet |
| `connected` | The most recent authenticated call succeeded |
| `error` | The most recent call failed |

A key being present never produces `connected`. The state lives in memory and resets on restart.

## Sending a message

MCP clients call the `send_message` tool. It needs the `providers:invoke` permission.

| Input | Type | Notes |
| --- | --- | --- |
| `agent` | string | Target agent id (`chatgpt`, `claude`, `gemini`) |
| `message` | string | 1 to 16,000 characters |
| `system` | string, optional | Up to 4,000 characters |
| `maxOutputTokens` | integer, optional | 1 to 8,192, and never above `PROVIDER_MAX_OUTPUT_TOKENS` |

The reply contains `agent`, `provider`, `model` (as reported by the provider), `text`, `finishReason`
and, when the provider reports it, `usage.inputTokens` and `usage.outputTokens`. For Gemini, reasoning
tokens are counted as output tokens, as the provider bills them.

An agent may name itself or another agent as the target. Both are billable.

## Failures

| Error code | HTTP | Cause |
| --- | --- | --- |
| `provider_not_configured` | 503 | The target's provider has no key or no model |
| `provider_timeout` | 504 | No answer within `PROVIDER_TIMEOUT_MS` |
| `provider_error` | 502 | The provider refused (HTTP status in the message), was unreachable, or sent an unusable body |
| `rate_limited` | 429 | The calling agent exceeded `PROVIDER_CALLS_PER_MINUTE` |
| `cancelled` | 499 | The MCP client cancelled the call |
| `not_found` | 404 | No agent with that id |

Messages never include the provider's response body or any credential. The gateway does not retry.

## Settings

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROVIDER_TIMEOUT_MS` | 30000 | Timeout per provider request (1,000 to 120,000) |
| `PROVIDER_MAX_OUTPUT_TOKENS` | 1024 | Upper bound on output tokens per call (1 to 8,192) |
| `PROVIDER_CALLS_PER_MINUTE` | 20 | Calls per calling agent per minute |

## Limits of this phase

- One non-streaming call per message. No streaming, tool calling by the model, images or files.
- No conversation memory. Each call is independent.
- Usage totals are per process and reset on restart.
- Cost control is the output token cap, the rate limit and your provider-side spending limit.
