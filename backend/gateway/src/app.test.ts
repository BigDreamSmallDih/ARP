import { afterEach, describe, expect, it } from 'vitest';
import {
  AgentSummarySchema,
  AuditEventSchema,
  ErrorBodySchema,
  GatewayInfoSchema,
  HealthSchema,
  SystemStatusSchema,
} from '@arp/shared';
import { z } from 'zod';
import { createGateway, type Gateway, type GatewayOptions } from './app';
import { PROVIDER_ENV, fakeProviders, testConfig, testToken } from './test-support';

const open: Gateway[] = [];

async function start(
  overrides: Record<string, string> = {},
  options: GatewayOptions = {},
): Promise<Gateway> {
  const gateway = await createGateway(testConfig(overrides), options);
  open.push(gateway);
  return gateway;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((gateway) => gateway.app.close()));
});

const admin = { authorization: `Bearer ${testToken('admin')}` };

describe('GET /health', () => {
  it('is public and returns a validated body', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(HealthSchema.parse(response.json())).toMatchObject({ status: 'ok', version: '0.1.0' });
  });
});

describe('admin API', () => {
  it('rejects requests without a bearer token and sets WWW-Authenticate', async () => {
    const { app, audit } = await start();
    const response = await app.inject({ method: 'GET', url: '/api/status' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('unauthorized');
    expect(audit.recent()[0]).toMatchObject({ type: 'auth.failed', outcome: 'denied' });
  });

  it('rejects a wrong token', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('does not accept an agent token', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { authorization: `Bearer ${testToken('claude')}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('answers 503 admin_not_configured when no admin token is set', async () => {
    const { app } = await start({ GATEWAY_ADMIN_TOKEN: '' });
    const response = await app.inject({ method: 'GET', url: '/api/status', headers: admin });

    expect(response.statusCode).toBe(503);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('admin_not_configured');
  });

  it('serves validated status, agents, gateway info and audit data', async () => {
    const { app } = await start({ OPENAI_API_KEY: 'any-non-empty-value-1', OPENAI_MODEL: 'some-model' });

    const status = await app.inject({ method: 'GET', url: '/api/status', headers: admin });
    expect(status.statusCode).toBe(200);
    const parsed = SystemStatusSchema.parse(status.json());
    expect(parsed.providers.find((provider) => provider.id === 'openai')?.state).toBe('configured');
    expect(parsed.providers.find((provider) => provider.id === 'gemini')?.state).toBe('unconfigured');

    const agents = await app.inject({ method: 'GET', url: '/api/agents', headers: admin });
    const agentList = z.object({ agents: z.array(AgentSummarySchema) }).parse(agents.json()).agents;
    expect(agentList.map((agent) => agent.id)).toEqual(['chatgpt', 'claude', 'gemini']);

    const gateway = await app.inject({ method: 'GET', url: '/api/gateway', headers: admin });
    expect(GatewayInfoSchema.parse(gateway.json()).tools.map((tool) => tool.name)).toContain('send_message');

    const audit = await app.inject({ method: 'GET', url: '/api/audit?limit=5', headers: admin });
    expect(z.object({ events: z.array(AuditEventSchema) }).parse(audit.json()).events).toEqual([]);
  });

  it('validates the audit limit', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/api/audit?limit=0', headers: admin });

    expect(response.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('invalid_request');
  });
});

describe('error handling', () => {
  it('returns a structured 404 for unknown routes', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(ErrorBodySchema.parse(response.json()).error).toMatchObject({
      code: 'not_found',
      message: 'Route not found',
    });
  });

  it('returns a structured 400 for malformed JSON on /mcp', async () => {
    const { app } = await start();
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { ...{ authorization: `Bearer ${testToken('claude')}` }, 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('invalid_request');
  });

  it('includes the request id in error bodies', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(ErrorBodySchema.parse(response.json()).error.requestId).toBeTruthy();
  });
});

describe('CORS for the dashboard origin', () => {
  const origin = 'https://dashboard.example.com';

  it('allows only the configured origin', async () => {
    const { app } = await start({ DASHBOARD_ORIGIN: origin });

    const allowed = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    expect(allowed.headers['access-control-allow-origin']).toBe(origin);

    const other = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for the configured origin', async () => {
    const { app } = await start({ DASHBOARD_ORIGIN: origin });
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/status',
      headers: { origin, 'access-control-request-method': 'GET' },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('sends no CORS headers when no origin is configured', async () => {
    const { app } = await start();
    const response = await app.inject({ method: 'GET', url: '/health', headers: { origin } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('provider verification', () => {
  const verify = (app: Gateway['app'], id: string) =>
    app.inject({ method: 'POST', url: `/api/providers/${id}/verify`, headers: admin });

  it('requires the admin token', async () => {
    const { app } = await start(PROVIDER_ENV, { fetchImpl: fakeProviders().fetchImpl });
    const response = await app.inject({ method: 'POST', url: '/api/providers/openai/verify' });
    expect(response.statusCode).toBe(401);
  });

  it('turns a provider connected only after an authenticated request succeeded', async () => {
    const providers = fakeProviders();
    const { app } = await start(PROVIDER_ENV, { fetchImpl: providers.fetchImpl });

    const response = await verify(app, 'gemini');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ provider: { id: 'gemini', state: 'connected' } });
    expect(providers.hosts).toEqual(['generativelanguage.googleapis.com']);

    const status = SystemStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/status', headers: admin })).json(),
    );
    expect(status.providers.map((provider) => provider.state)).toEqual([
      'configured',
      'configured',
      'connected',
    ]);
  });

  it('answers 502 and records an error state when the provider rejects the request', async () => {
    const providers = fakeProviders();
    providers.failing.add('api.openai.com');
    const { app } = await start(PROVIDER_ENV, { fetchImpl: providers.fetchImpl });

    const response = await verify(app, 'openai');
    expect(response.statusCode).toBe(502);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('provider_error');

    const status = SystemStatusSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/status', headers: admin })).json(),
    );
    expect(status.providers[0]).toMatchObject({ id: 'openai', state: 'error' });
  });

  it('answers 503 for a provider without a key and never calls out', async () => {
    const providers = fakeProviders();
    const { app } = await start({}, { fetchImpl: providers.fetchImpl });

    const response = await verify(app, 'anthropic');
    expect(response.statusCode).toBe(503);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('provider_not_configured');
    expect(providers.hosts).toEqual([]);
  });

  it('rejects an unknown provider id as invalid_request', async () => {
    const { app } = await start();
    const response = await verify(app, 'azure');
    expect(response.statusCode).toBe(400);
  });
});

describe('request rate limiting', () => {
  it('answers 429 with Retry-After once a client exceeds its per-minute limit', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '3' });
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      statuses.push((await app.inject({ method: 'GET', url: '/api/status', headers: admin })).statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);

    const limited = await app.inject({ method: 'GET', url: '/api/status', headers: admin });
    expect(ErrorBodySchema.parse(limited.json()).error).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never limits the health endpoint', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
  });

  it('counts clients separately by address', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1' });
    const first = await app.inject({ method: 'GET', url: '/api/status', headers: admin, remoteAddress: '10.0.0.1' });
    const other = await app.inject({ method: 'GET', url: '/api/status', headers: admin, remoteAddress: '10.0.0.2' });
    const repeat = await app.inject({ method: 'GET', url: '/api/status', headers: admin, remoteAddress: '10.0.0.1' });
    expect([first.statusCode, other.statusCode, repeat.statusCode]).toEqual([200, 200, 429]);
  });

  it('uses the forwarded address only when TRUST_PROXY is on', async () => {
    const forwarded = (address: string) => ({ ...admin, 'x-forwarded-for': address });

    const untrusted = await start({ RATE_LIMIT_PER_MINUTE: '1' });
    await untrusted.app.inject({ method: 'GET', url: '/api/status', headers: forwarded('1.1.1.1') });
    const spoofed = await untrusted.app.inject({ method: 'GET', url: '/api/status', headers: forwarded('2.2.2.2') });
    expect(spoofed.statusCode).toBe(429);

    const trusted = await start({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: 'true' });
    await trusted.app.inject({ method: 'GET', url: '/api/status', headers: forwarded('1.1.1.1') });
    const other = await trusted.app.inject({ method: 'GET', url: '/api/status', headers: forwarded('2.2.2.2') });
    expect(other.statusCode).toBe(200);
  });

  it('ignores X-Forwarded-For from a peer that is not the local proxy, even with TRUST_PROXY on', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: 'true' });
    const send = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { ...admin, 'x-forwarded-for': forwardedFor },
        remoteAddress: '203.0.113.5',
      });

    expect((await send('1.1.1.1')).statusCode).toBe(200);
    expect((await send('2.2.2.2')).statusCode).toBe(429);
  });

  it('takes the rightmost untrusted address, so a forged leading entry changes nothing', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1', TRUST_PROXY: 'true' });
    const send = (forwardedFor: string) =>
      app.inject({
        method: 'GET',
        url: '/api/status',
        headers: { ...admin, 'x-forwarded-for': forwardedFor },
      });

    expect((await send('9.9.9.9, 198.51.100.4')).statusCode).toBe(200);
    expect((await send('8.8.8.8, 198.51.100.4')).statusCode).toBe(429);
  });

  it('limits IPv6 clients by /64 so they cannot rotate addresses', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1' });
    const send = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: '/api/status', headers: admin, remoteAddress });

    expect((await send('2001:db8:1:2::1')).statusCode).toBe(200);
    expect((await send('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).statusCode).toBe(429);
    expect((await send('2001:db8:1:3::1')).statusCode).toBe(200);
  });

  it('limits an IPv4 client once however its IPv4-mapped address is written', async () => {
    const { app } = await start({ RATE_LIMIT_PER_MINUTE: '1' });
    const send = (remoteAddress: string) =>
      app.inject({ method: 'GET', url: '/api/status', headers: admin, remoteAddress });

    expect((await send('::ffff:203.0.113.5')).statusCode).toBe(200);
    expect((await send('::ffff:cb00:7105')).statusCode).toBe(429);
    expect((await send('0:0:0:0:0:ffff:cb00:7105')).statusCode).toBe(429);
    expect((await send('::ffff:cb00:7106')).statusCode).toBe(200);
  });
});

describe('authentication lockout', () => {
  const bad = { authorization: 'Bearer wrong' };

  it('locks a client out after repeated failures, even for a correct token', async () => {
    const { app, audit } = await start({ AUTH_FAILURE_LIMIT: '3' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await app.inject({ method: 'GET', url: '/api/status', headers: bad });
      expect(response.statusCode).toBe(401);
    }

    const locked = await app.inject({ method: 'GET', url: '/api/status', headers: admin });
    expect(locked.statusCode).toBe(429);
    expect(ErrorBodySchema.parse(locked.json()).error.code).toBe('rate_limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    expect(audit.recent()[0]).toMatchObject({ type: 'auth.failed', errorCode: 'rate_limited' });
  });

  it('does not lock out another client address', async () => {
    const { app } = await start({ AUTH_FAILURE_LIMIT: '1' });
    await app.inject({ method: 'GET', url: '/api/status', headers: bad, remoteAddress: '10.0.0.1' });
    const other = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: admin,
      remoteAddress: '10.0.0.2',
    });
    expect(other.statusCode).toBe(200);
  });

  it('applies the same lockout to agent authentication on /mcp', async () => {
    const { app } = await start({ AUTH_FAILURE_LIMIT: '2' });
    const post = (token: string) =>
      app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: '{}',
      });

    expect((await post('wrong-1')).statusCode).toBe(401);
    expect((await post('wrong-2')).statusCode).toBe(401);
    expect((await post(testToken('claude'))).statusCode).toBe(429);
  });

  it('does not count unrelated requests as authentication failures', async () => {
    const { app } = await start({ AUTH_FAILURE_LIMIT: '1' });
    await app.inject({ method: 'GET', url: '/nope' });
    const response = await app.inject({ method: 'GET', url: '/api/status', headers: admin });
    expect(response.statusCode).toBe(200);
  });
});

describe('request size limit', () => {
  it('rejects a body over REQUEST_BODY_LIMIT_BYTES', async () => {
    const { app } = await start({ REQUEST_BODY_LIMIT_BYTES: '1024' });
    const response = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${testToken('claude')}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(2_000) }),
    });
    expect(response.statusCode).toBe(400);
    expect(ErrorBodySchema.parse(response.json()).error.code).toBe('invalid_request');
  });
});

describe('secret redaction in logs', () => {
  it('does not write bearer tokens or provider keys to the request log', async () => {
    const lines: string[] = [];
    const gateway = await createGateway(
      { ...testConfig({ ...PROVIDER_ENV, LOG_LEVEL: 'trace' }), environment: 'development' },
      { fetchImpl: fakeProviders().fetchImpl, logStream: { write: (line) => lines.push(line) } },
    );
    open.push(gateway);

    await gateway.app.inject({ method: 'GET', url: '/api/status', headers: admin });
    await gateway.app.inject({ method: 'GET', url: '/api/status', headers: { authorization: 'Bearer wrong-token-value' } });
    await gateway.app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-api-key': PROVIDER_ENV.OPENAI_API_KEY, 'x-goog-api-key': PROVIDER_ENV.GEMINI_API_KEY },
    });
    await gateway.app.inject({ method: 'POST', url: '/api/providers/openai/verify', headers: admin });

    const log = lines.join('');
    expect(log.length).toBeGreaterThan(0);
    for (const secret of [
      testToken('admin'),
      'wrong-token-value',
      ...Object.values(PROVIDER_ENV).filter((value) => value.includes('key')),
    ]) {
      expect(log).not.toContain(secret);
    }
  });
});
