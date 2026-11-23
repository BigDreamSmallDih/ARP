import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorBodySchema } from '@arp/shared';
import { createGateway, type Gateway } from './app';
import type { FetchLike } from '@arp/agents';
import { PROVIDER_ENV, fakeProviders, testConfig, testToken } from './test-support';

const open: Gateway[] = [];

async function start(overrides: Record<string, string> = {}, fetchImpl?: FetchLike) {
  const gateway = await createGateway(testConfig(overrides), fetchImpl === undefined ? {} : { fetchImpl });
  open.push(gateway);
  await gateway.app.listen({ host: '127.0.0.1', port: 0 });
  const address = gateway.app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The gateway did not bind to a TCP port');
  }
  return { gateway, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((gateway) => gateway.app.close()));
});

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw-test-client', version: '0.0.0' },
  },
};

function post(url: URL, token: string | undefined, body: unknown, sessionId?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function initialize(url: URL, token: string): Promise<string> {
  const response = await post(url, token, INITIALIZE);
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  if (sessionId === null) throw new Error('The gateway did not return a session id');
  return sessionId;
}

async function errorCode(response: Response): Promise<string> {
  return ErrorBodySchema.parse(await response.json()).error.code;
}

async function connectClient(url: URL, agent: string) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: `Bearer ${testToken(agent)}` } },
  });
  const client = new Client({ name: 'sdk-test-client', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

function messageArgs(agent: string, message = 'hello') {
  return { name: 'send_message', arguments: { agent, message } };
}

describe('send_message routing', () => {
  const env = { ...PROVIDER_ENV, GATEWAY_TOKEN_GEMINI: testToken('gemini') };

  it('routes each agent to its own provider and reports which one answered', async () => {
    const providers = fakeProviders();
    const { url } = await start(env, providers.fetchImpl);
    const client = await connectClient(url, 'claude');

    const claude = await client.callTool(messageArgs('claude'));
    expect(claude.structuredContent).toMatchObject({
      agent: 'claude',
      provider: 'anthropic',
      model: 'anthropic-served',
      text: 'reply from anthropic',
      usage: { inputTokens: 5, outputTokens: 3 },
    });
    const gemini = await client.callTool(messageArgs('gemini'));
    expect(gemini.structuredContent).toMatchObject({ provider: 'gemini', text: 'reply from gemini' });
    const chatgpt = await client.callTool(messageArgs('chatgpt'));
    expect(chatgpt.structuredContent).toMatchObject({ provider: 'openai', text: 'reply from openai' });

    expect(providers.hosts).toEqual([
      'api.anthropic.com',
      'generativelanguage.googleapis.com',
      'api.openai.com',
    ]);
    await client.close();
  });

  it('reports a provider as connected only after a call went through', async () => {
    const providers = fakeProviders();
    const { gateway, url } = await start(env, providers.fetchImpl);
    const client = await connectClient(url, 'claude');
    const state = async (agent: string) =>
      (
        (await client.callTool({ name: 'get_registered_agents', arguments: {} })).structuredContent as {
          agents: Array<{ id: string; providerState: string }>;
        }
      ).agents.find((entry) => entry.id === agent)?.providerState;

    expect(await state('claude')).toBe('configured');
    await client.callTool(messageArgs('claude'));
    expect(await state('claude')).toBe('connected');
    expect(await state('gemini')).toBe('configured');
    expect(gateway.audit.recent().some((event) => event.tool === 'send_message')).toBe(true);
    await client.close();
  });

  it('keeps one failing provider from affecting the others', async () => {
    const providers = fakeProviders();
    providers.failing.add('api.openai.com');
    const { url } = await start(env, providers.fetchImpl);
    const client = await connectClient(url, 'claude');

    const failed = await client.callTool(messageArgs('chatgpt'));
    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed.content)).toContain('provider_error');

    const fine = await client.callTool(messageArgs('claude'));
    expect(fine.isError).toBeFalsy();

    const status = (await client.callTool({ name: 'get_system_status', arguments: {} }))
      .structuredContent as { providers: Array<{ id: string; state: string }>; warnings: string[] };
    expect(Object.fromEntries(status.providers.map((provider) => [provider.id, provider.state]))).toEqual({
      openai: 'error',
      anthropic: 'connected',
      gemini: 'configured',
    });
    expect(status.warnings.join(' ')).toContain('openai');
    await client.close();
  });

  it('answers provider_not_configured without calling any provider', async () => {
    const providers = fakeProviders();
    const { url } = await start({ ...env, GEMINI_API_KEY: '' }, providers.fetchImpl);
    const client = await connectClient(url, 'claude');

    const result = await client.callTool(messageArgs('gemini'));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('provider_not_configured');
    expect(providers.hosts).toEqual([]);
    await client.close();
  });

  it('rejects an unknown agent as not_found', async () => {
    const providers = fakeProviders();
    const { url } = await start(env, providers.fetchImpl);
    const client = await connectClient(url, 'claude');

    const result = await client.callTool(messageArgs('nobody'));
    expect(JSON.stringify(result.content)).toContain('not_found');
    expect(providers.hosts).toEqual([]);
    await client.close();
  });

  it('rate limits provider calls per calling agent', async () => {
    const providers = fakeProviders();
    const { url } = await start({ ...env, PROVIDER_CALLS_PER_MINUTE: '2' }, providers.fetchImpl);
    const claude = await connectClient(url, 'claude');
    const chatgpt = await connectClient(url, 'chatgpt');

    expect((await claude.callTool(messageArgs('claude'))).isError).toBeFalsy();
    expect((await claude.callTool(messageArgs('claude'))).isError).toBeFalsy();
    const limited = await claude.callTool(messageArgs('claude'));
    expect(limited.isError).toBe(true);
    const body = JSON.parse((limited.content as Array<{ text: string }>)[0]?.text ?? '{}') as {
      error: { code: string; retryAfterSeconds: number };
    };
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(providers.hosts).toHaveLength(2);

    expect((await chatgpt.callTool(messageArgs('chatgpt'))).isError).toBeFalsy();
    await claude.close();
    await chatgpt.close();
  });

  it('caps the output tokens sent to the provider at the configured maximum', async () => {
    const bodies: unknown[] = [];
    const providers = fakeProviders();
    const fetchImpl: FetchLike = async (requestUrl, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return providers.fetchImpl(requestUrl, init);
    };
    const { url } = await start({ ...env, PROVIDER_MAX_OUTPUT_TOKENS: '100' }, fetchImpl);
    const client = await connectClient(url, 'claude');

    await client.callTool({
      name: 'send_message',
      arguments: { agent: 'claude', message: 'hi', maxOutputTokens: 5_000 },
    });
    await client.callTool(messageArgs('claude'));
    expect(bodies).toMatchObject([{ max_tokens: 100 }, { max_tokens: 100 }]);
    await client.close();
  });

  it('does not expose provider keys in any tool output or audit event', async () => {
    const providers = fakeProviders();
    const { gateway, url } = await start(env, providers.fetchImpl);
    const client = await connectClient(url, 'claude');

    const outputs = [
      await client.callTool(messageArgs('claude')),
      await client.callTool({ name: 'get_system_status', arguments: {} }),
      await client.callTool({ name: 'get_registered_agents', arguments: {} }),
    ];
    const everything = JSON.stringify([outputs, gateway.audit.recent(500)]);
    for (const key of [
      PROVIDER_ENV.OPENAI_API_KEY,
      PROVIDER_ENV.ANTHROPIC_API_KEY,
      PROVIDER_ENV.GEMINI_API_KEY,
    ]) {
      expect(everything).not.toContain(key);
    }
    await client.close();
  });
});

describe('MCP over Streamable HTTP', () => {
  it('runs a full agent session with the official SDK client', async () => {
    const { gateway, url } = await start();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${testToken('claude')}` } },
    });
    const client = new Client({ name: 'sdk-test-client', version: '0.0.0' });

    await client.connect(transport);
    expect(gateway.sessions.activeCount()).toBe(1);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_gateway_info',
      'get_registered_agents',
      'get_session_status',
      'get_system_status',
      'send_message',
    ]);

    const session = await client.callTool({ name: 'get_session_status', arguments: {} });
    expect(session.structuredContent).toMatchObject({
      sessionId: transport.sessionId,
      agentId: 'claude',
    });

    const agents = await client.callTool({ name: 'get_registered_agents', arguments: {} });
    expect((agents.structuredContent as { agents: unknown[] }).agents).toHaveLength(3);

    await transport.terminateSession();
    await client.close();

    expect(gateway.sessions.activeCount()).toBe(0);
    const events = gateway.audit.recent().map((event) => [event.type, event.reason ?? event.tool]);
    expect(events).toContainEqual(['session.created', undefined]);
    expect(events).toContainEqual(['tool.call', 'get_session_status']);
    expect(events).toContainEqual(['session.closed', 'client_closed']);
  });

  it('refuses to connect with a wrong agent token', async () => {
    const { url } = await start();
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer wrong-token' } },
    });
    const client = new Client({ name: 'sdk-test-client', version: '0.0.0' });

    await expect(client.connect(transport)).rejects.toThrow();
  });

  it('requires credentials to initialise', async () => {
    const { url, gateway } = await start();

    const response = await post(url, undefined, INITIALIZE);
    expect(response.status).toBe(401);
    expect(await errorCode(response)).toBe('unauthorized');
    expect(gateway.sessions.activeCount()).toBe(0);
  });

  it('does not accept the admin token as an agent credential', async () => {
    const { url } = await start();
    const response = await post(url, testToken('admin'), INITIALIZE);
    expect(response.status).toBe(401);
  });

  it('keeps a session bound to the agent that created it', async () => {
    const { url, gateway } = await start();
    const sessionId = await initialize(url, testToken('chatgpt'));

    const hijack = await post(
      url,
      testToken('claude'),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
    );
    expect(hijack.status).toBe(403);
    expect(await errorCode(hijack)).toBe('forbidden');
    expect(gateway.audit.recent()[0]).toMatchObject({
      type: 'auth.failed',
      agentId: 'claude',
      errorCode: 'forbidden',
    });
  });

  it('answers 404 for an unknown session so clients re-initialise', async () => {
    const { url } = await start();
    const response = await post(
      url,
      testToken('claude'),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      'no-such-session',
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('session_not_found');
  });

  it('rejects non-initialize requests that carry no session id', async () => {
    const { url } = await start();
    const response = await post(url, testToken('claude'), {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('invalid_request');
  });

  it('enforces the session limit', async () => {
    const { url } = await start({ MAX_SESSIONS: '1' });
    await initialize(url, testToken('claude'));

    const second = await post(url, testToken('chatgpt'), INITIALIZE);
    expect(second.status).toBe(503);
    expect(await errorCode(second)).toBe('session_limit_reached');
  });

  it('limits sessions per agent without blocking other agents', async () => {
    const { url } = await start({ MAX_SESSIONS_PER_AGENT: '1' });
    await initialize(url, testToken('claude'));

    const second = await post(url, testToken('claude'), INITIALIZE);
    expect(second.status).toBe(503);
    expect(await errorCode(second)).toBe('session_limit_reached');

    await initialize(url, testToken('chatgpt'));
  });

  it('closes sessions that stay idle past the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { url, gateway } = await start({ SESSION_IDLE_TTL_SECONDS: '60' });
    const sessionId = await initialize(url, testToken('claude'));
    expect(gateway.sessions.activeCount()).toBe(1);

    vi.setSystemTime(Date.now() + 61_000);
    gateway.sweepExpiredSessions();

    expect(gateway.sessions.activeCount()).toBe(0);
    expect(gateway.audit.recent()[0]).toMatchObject({
      type: 'session.closed',
      reason: 'expired',
      sessionId,
    });

    const reuse = await post(
      url,
      testToken('claude'),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
    );
    expect(reuse.status).toBe(404);
  });
});
