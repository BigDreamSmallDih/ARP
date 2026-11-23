import type { FetchLike } from '@arp/agents';
import { loadConfig, type GatewayConfig } from './config';

/** Obviously fake 40-character credentials for tests. */
export function testToken(label: string): string {
  return `${label}-`.padEnd(40, 'x');
}

export function testConfig(overrides: Record<string, string> = {}): GatewayConfig {
  return loadConfig({
    NODE_ENV: 'test',
    GATEWAY_ADMIN_TOKEN: testToken('admin'),
    GATEWAY_TOKEN_CHATGPT: testToken('chatgpt'),
    GATEWAY_TOKEN_CLAUDE: testToken('claude'),
    ...overrides,
  });
}

/** Obviously fake provider keys and model ids, one per provider. */
export const PROVIDER_ENV = {
  OPENAI_API_KEY: 'test-openai-key-not-real-0001',
  OPENAI_MODEL: 'openai-test-model',
  ANTHROPIC_API_KEY: 'test-anthropic-key-not-real-0002',
  ANTHROPIC_MODEL: 'anthropic-test-model',
  GEMINI_API_KEY: 'test-gemini-key-not-real-0003',
  GEMINI_MODEL: 'gemini-test-model',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface FakeProviders {
  readonly fetchImpl: FetchLike;
  /** Hosts called so far, in order. */
  readonly hosts: string[];
  /** Hosts whose requests should fail with HTTP 500. */
  readonly failing: Set<string>;
}

/** Stands in for the three provider APIs. Replies are canned test data, not model output. */
export function fakeProviders(): FakeProviders {
  const hosts: string[] = [];
  const failing = new Set<string>();
  const fetchImpl: FetchLike = async (url) => {
    const host = new URL(url).host;
    hosts.push(host);
    if (failing.has(host)) return jsonResponse({}, 500);
    if (host === 'api.openai.com') {
      return jsonResponse({
        model: 'openai-served',
        choices: [{ message: { content: 'reply from openai' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    }
    if (host === 'api.anthropic.com') {
      return jsonResponse({
        model: 'anthropic-served',
        content: [{ type: 'text', text: 'reply from anthropic' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 3 },
      });
    }
    return jsonResponse({
      modelVersion: 'gemini-served',
      candidates: [{ content: { parts: [{ text: 'reply from gemini' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4 },
    });
  };
  return { fetchImpl, hosts, failing };
}
