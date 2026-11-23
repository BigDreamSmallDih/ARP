import { describe, expect, it } from 'vitest';
import { Secret } from '@arp/security';
import { GatewayError, type ProviderId } from '@arp/shared';
import {
  ClaudeAdapter,
  GeminiAdapter,
  OpenAIAdapter,
  createProviderAdapters,
  type FetchLike,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderSettings,
} from './index';

const KEY = 'test-api-key-0123456789-not-real';
const MODEL = 'test-model-1';

const REQUEST: ProviderRequest = {
  messages: [{ role: 'user', content: 'Say hello' }],
  maxOutputTokens: 64,
};

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Plays back one scripted response per call and records what was sent. */
function scripted(...responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected extra provider call');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

/** A fetch that stays pending until the request signal aborts, like a hung provider. */
const hanging: FetchLike = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason ?? new Error('aborted'));
    });
  });

function settings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return { apiKey: new Secret(KEY), model: MODEL, timeoutMs: 5_000, ...overrides };
}

interface Case {
  id: ProviderId;
  make: (settings: ProviderSettings, fetchImpl: FetchLike) => ProviderAdapter;
  success: unknown;
  urlPart: string;
  keyHeader: string;
  verifyUrlPart: string;
}

const CASES: Case[] = [
  {
    id: 'openai',
    make: (s, f) => new OpenAIAdapter(s, f),
    success: {
      model: 'served-model',
      choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    urlPart: '/chat/completions',
    keyHeader: 'authorization',
    verifyUrlPart: '/v1/models',
  },
  {
    id: 'anthropic',
    make: (s, f) => new ClaudeAdapter(s, f),
    success: {
      model: 'served-model',
      content: [{ type: 'text', text: 'hello there' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 7, output_tokens: 3 },
    },
    urlPart: '/v1/messages',
    keyHeader: 'x-api-key',
    verifyUrlPart: '/v1/models',
  },
  {
    id: 'gemini',
    make: (s, f) => new GeminiAdapter(s, f),
    success: {
      modelVersion: 'served-model',
      candidates: [{ content: { parts: [{ text: 'hello there' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    },
    urlPart: ':generateContent',
    keyHeader: 'x-goog-api-key',
    verifyUrlPart: '/v1beta/models',
  },
];

async function failureOf(promise: Promise<unknown>): Promise<GatewayError> {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(GatewayError);
  return result as GatewayError;
}

describe.each(CASES)('$id adapter', (testCase) => {
  it('is unconfigured without a key, and without a model', async () => {
    const noKey = scripted();
    const withoutKey = testCase.make(settings({ apiKey: undefined }), noKey.fetchImpl);
    const withoutModel = testCase.make(settings({ model: undefined }), noKey.fetchImpl);

    expect(withoutKey.status().state).toBe('unconfigured');
    expect(withoutModel.status().state).toBe('unconfigured');
    expect((await failureOf(withoutKey.send(REQUEST))).code).toBe('provider_not_configured');
    expect((await failureOf(withoutModel.verify())).code).toBe('provider_not_configured');
    expect(noKey.calls).toHaveLength(0);
  });

  it('is configured, not connected, until a call has succeeded', () => {
    const adapter = testCase.make(settings(), scripted().fetchImpl);
    expect(adapter.status()).toMatchObject({ id: testCase.id, state: 'configured', model: MODEL });
    expect(adapter.status().lastSuccessAt).toBeUndefined();
  });

  it('sends the key in a header and the model and token limit in the body', async () => {
    const { fetchImpl, calls } = scripted(json(testCase.success));
    await testCase.make(settings(), fetchImpl).send({ ...REQUEST, system: 'Be brief' });

    const call = calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url).toContain(testCase.urlPart);
    expect(call?.url).not.toContain(KEY);
    expect(call?.headers[testCase.keyHeader]).toContain(KEY);
    const serialized = JSON.stringify(call?.body);
    expect(serialized).toContain('Say hello');
    expect(serialized).toContain('Be brief');
    expect(serialized).toContain('64');
    expect(serialized).not.toContain(KEY);
  });

  it('maps the response, reports the provider-served model and token usage, and becomes connected', async () => {
    const { fetchImpl } = scripted(json(testCase.success));
    const adapter = testCase.make(settings(), fetchImpl);

    const response = await adapter.send(REQUEST);
    expect(response).toMatchObject({
      text: 'hello there',
      model: 'served-model',
      usage: { inputTokens: 7, outputTokens: 3 },
    });
    expect(adapter.status()).toMatchObject({
      state: 'connected',
      usage: { requests: 1, failures: 0, inputTokens: 7, outputTokens: 3 },
    });
    expect(Date.parse(adapter.status().lastSuccessAt ?? '')).not.toBeNaN();
  });

  it.each([
    [401, 'auth_failed'],
    [403, 'auth_failed'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'rejected'],
    [404, 'rejected'],
  ] as const)('classifies HTTP %i as %s and reports an error state', async (status, kind) => {
    const { fetchImpl } = scripted(json({ error: { message: `echo of ${KEY}` } }, status));
    const adapter = testCase.make(settings(), fetchImpl);

    const error = await failureOf(adapter.send(REQUEST));
    expect(error.code).toBe('provider_error');
    expect(error.message).toContain(`HTTP ${status}`);
    expect(adapter.status()).toMatchObject({
      state: 'error',
      lastError: { kind },
      usage: { requests: 1, failures: 1 },
    });
  });

  it('never puts the API key or the provider response body in an error or status', async () => {
    const { fetchImpl } = scripted(json({ error: { message: `echo of ${KEY}` } }, 401));
    const adapter = testCase.make(settings(), fetchImpl);

    const error = await failureOf(adapter.send(REQUEST));
    expect(`${error.message} ${JSON.stringify(error.details)} ${JSON.stringify(adapter.status())}`).not.toContain(
      KEY,
    );
  });

  it('treats an unreachable provider as unavailable', async () => {
    const { fetchImpl } = scripted(new TypeError('fetch failed'));
    const adapter = testCase.make(settings(), fetchImpl);

    expect((await failureOf(adapter.send(REQUEST))).code).toBe('provider_error');
    expect(adapter.status().lastError?.kind).toBe('unavailable');
  });

  it.each([
    ['a body that is not JSON', new Response('<html>oops</html>', { status: 200 })],
    ['a JSON body of the wrong shape', json({ unexpected: true })],
    ['a reply with no text', json({ choices: [{ message: { content: null } }], content: [], candidates: [] })],
  ])('reports %s as a bad response', async (_name, response) => {
    const { fetchImpl } = scripted(response);
    const adapter = testCase.make(settings(), fetchImpl);

    expect((await failureOf(adapter.send(REQUEST))).code).toBe('provider_error');
    expect(adapter.status()).toMatchObject({ state: 'error', lastError: { kind: 'bad_response' } });
  });

  it('times out a hung provider and records the failure', async () => {
    const adapter = testCase.make(settings({ timeoutMs: 25 }), hanging);

    expect((await failureOf(adapter.send(REQUEST))).code).toBe('provider_timeout');
    expect(adapter.status()).toMatchObject({ state: 'error', lastError: { kind: 'timeout' } });
  });

  it('cancels when the caller aborts, without marking the provider as failed', async () => {
    const adapter = testCase.make(settings(), hanging);
    const controller = new AbortController();

    const pending = failureOf(adapter.send({ ...REQUEST, signal: controller.signal }));
    controller.abort();

    expect((await pending).code).toBe('cancelled');
    expect(adapter.status()).toMatchObject({ state: 'configured', usage: { failures: 0 } });
  });

  it('shows connecting while the first call is in flight', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchImpl: FetchLike = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const adapter = testCase.make(settings(), fetchImpl);

    const pending = adapter.send(REQUEST);
    expect(adapter.status().state).toBe('connecting');
    release(json(testCase.success));
    await pending;
    expect(adapter.status().state).toBe('connected');
  });

  it('moves from connected to error after a failure and recovers on the next success', async () => {
    const { fetchImpl } = scripted(json(testCase.success), json({}, 500), json(testCase.success));
    const adapter = testCase.make(settings(), fetchImpl);

    await adapter.send(REQUEST);
    await failureOf(adapter.send(REQUEST));
    expect(adapter.status().state).toBe('error');
    await adapter.send(REQUEST);
    expect(adapter.status().state).toBe('connected');
  });

  it('verifies the key with a free request and only then reports connected', async () => {
    const { fetchImpl, calls } = scripted(json({ data: [], models: [] }));
    const adapter = testCase.make(settings(), fetchImpl);

    await adapter.verify();
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain(testCase.verifyUrlPart);
    expect(calls[0]?.headers[testCase.keyHeader]).toContain(KEY);
    expect(adapter.status().state).toBe('connected');
  });

  it('reports an error when verification is rejected', async () => {
    const { fetchImpl } = scripted(json({}, 401));
    const adapter = testCase.make(settings(), fetchImpl);

    expect((await failureOf(adapter.verify())).code).toBe('provider_error');
    expect(adapter.status()).toMatchObject({ state: 'error', lastError: { kind: 'auth_failed' } });
  });
});

describe('provider-specific request shapes', () => {
  it('OpenAI puts the system prompt first as a system message', async () => {
    const { fetchImpl, calls } = scripted(json(CASES[0]?.success));
    await new OpenAIAdapter(settings(), fetchImpl).send({ ...REQUEST, system: 'Be brief' });

    expect(calls[0]?.body).toMatchObject({
      model: MODEL,
      max_completion_tokens: 64,
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Say hello' },
      ],
    });
  });

  it('Claude sends max_tokens, the system field and the API version header', async () => {
    const { fetchImpl, calls } = scripted(json(CASES[1]?.success));
    await new ClaudeAdapter(settings(), fetchImpl).send({ ...REQUEST, system: 'Be brief' });

    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.body).toMatchObject({
      model: MODEL,
      max_tokens: 64,
      system: 'Be brief',
      messages: [{ role: 'user', content: 'Say hello' }],
    });
  });

  it('Claude joins several text blocks and ignores other block types', async () => {
    const body = {
      content: [
        { type: 'thinking' },
        { type: 'text', text: 'one ' },
        { type: 'text', text: 'two' },
      ],
    };
    const { fetchImpl } = scripted(json(body));
    const response = await new ClaudeAdapter(settings(), fetchImpl).send(REQUEST);
    expect(response.text).toBe('one two');
    expect(response.model).toBe(MODEL);
  });

  it('Gemini maps roles, system instruction and token limit, and keeps the key out of the URL', async () => {
    const { fetchImpl, calls } = scripted(json(CASES[2]?.success));
    await new GeminiAdapter(settings({ model: 'name:with/odd' }), fetchImpl).send({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ],
      system: 'Be brief',
      maxOutputTokens: 64,
    });

    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/name%3Awith%2Fodd:generateContent',
    );
    expect(calls[0]?.body).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief' }] },
      contents: [
        { role: 'user', parts: [{ text: 'q' }] },
        { role: 'model', parts: [{ text: 'a' }] },
      ],
      generationConfig: { maxOutputTokens: 64 },
    });
  });

  it('Gemini counts reasoning tokens as output and explains a blocked reply', async () => {
    const counted = {
      candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 10 },
    };
    const blocked = { candidates: [{ finishReason: 'SAFETY' }] };
    const { fetchImpl } = scripted(json(counted), json(blocked));
    const adapter = new GeminiAdapter(settings(), fetchImpl);

    expect((await adapter.send(REQUEST)).usage).toEqual({ inputTokens: 2, outputTokens: 13 });
    expect((await failureOf(adapter.send(REQUEST))).message).toContain('SAFETY');
  });

  it('reports no usage when the provider omits it', async () => {
    const { fetchImpl } = scripted(json({ choices: [{ message: { content: 'hi' } }] }));
    const response = await new OpenAIAdapter(settings(), fetchImpl).send(REQUEST);
    expect(response.usage).toBeUndefined();
  });
});

describe('failure isolation', () => {
  it('keeps one provider failing from changing another provider', async () => {
    const fetchImpl: FetchLike = async (url) =>
      url.includes('openai.com') ? json({}, 500) : json(CASES[1]?.success);
    const adapters = createProviderAdapters(
      { openai: settings(), anthropic: settings(), gemini: settings({ apiKey: undefined }) },
      fetchImpl,
    );

    await failureOf(adapters.openai.send(REQUEST));
    await adapters.anthropic.send(REQUEST);

    expect(adapters.openai.status().state).toBe('error');
    expect(adapters.anthropic.status().state).toBe('connected');
    expect(adapters.gemini.status().state).toBe('unconfigured');
    expect(adapters.anthropic.status().usage.failures).toBe(0);
  });

  it('creates one adapter per provider id', () => {
    const adapters = createProviderAdapters(
      { openai: settings(), anthropic: settings(), gemini: settings() },
      scripted().fetchImpl,
    );
    expect(Object.keys(adapters).sort()).toEqual(['anthropic', 'gemini', 'openai']);
    for (const [id, adapter] of Object.entries(adapters)) expect(adapter.id).toBe(id);
  });
});
