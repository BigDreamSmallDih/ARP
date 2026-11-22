import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorBodySchema } from '@arp/shared';
import { createGateway, type Gateway } from './app';
import { testConfig, testToken } from './test-support';

const open: Gateway[] = [];

async function start(overrides: Record<string, string> = {}) {
  const gateway = await createGateway(testConfig(overrides));
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
