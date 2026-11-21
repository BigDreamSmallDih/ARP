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
import { createGateway, type Gateway } from './app';
import { testConfig, testToken } from './test-support';

const open: Gateway[] = [];

async function start(overrides: Record<string, string> = {}): Promise<Gateway> {
  const gateway = await createGateway(testConfig(overrides));
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
    const { app } = await start({ OPENAI_API_KEY: 'any-non-empty-value' });

    const status = await app.inject({ method: 'GET', url: '/api/status', headers: admin });
    expect(status.statusCode).toBe(200);
    const parsed = SystemStatusSchema.parse(status.json());
    expect(parsed.providers.find((provider) => provider.id === 'openai')?.state).toBe('configured');
    expect(parsed.providers.find((provider) => provider.id === 'gemini')?.state).toBe('unconfigured');

    const agents = await app.inject({ method: 'GET', url: '/api/agents', headers: admin });
    const agentList = z.object({ agents: z.array(AgentSummarySchema) }).parse(agents.json()).agents;
    expect(agentList.map((agent) => agent.id)).toEqual(['chatgpt', 'claude', 'gemini']);

    const gateway = await app.inject({ method: 'GET', url: '/api/gateway', headers: admin });
    expect(GatewayInfoSchema.parse(gateway.json()).tools).toHaveLength(4);

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
