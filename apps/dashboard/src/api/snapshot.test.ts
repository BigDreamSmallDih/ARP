import { describe, expect, it } from 'vitest';
import type { SystemStatus } from '@arp/shared';
import { ApiError, NetworkError, type GatewayClient } from './client';
import { loadSnapshot } from './snapshot';

const HEALTH = { status: 'ok' as const, version: '0.1.0', uptimeSeconds: 3, timestamp: '2026-01-01T00:00:00.000Z' };

const STATUS: SystemStatus = {
  version: '0.1.0',
  environment: 'development',
  startedAt: '2026-01-01T00:00:00.000Z',
  uptimeSeconds: 3,
  nodeVersion: 'v20.19.0',
  components: { adminApi: 'configured', supabase: 'unconfigured', roblox: 'not_integrated' },
  providers: [
    {
      id: 'openai',
      displayName: 'OpenAI',
      state: 'unconfigured',
      usage: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
    },
  ],
  sessions: { active: 0, max: 10 },
  toolCount: 4,
  warnings: [],
};

function fakeClient(overrides: Partial<GatewayClient> & { hasToken?: boolean } = {}): GatewayClient {
  return {
    hasToken: true,
    health: async () => HEALTH,
    status: async () => STATUS,
    agents: async () => [],
    gateway: async () => ({
      name: 'arp-gateway',
      version: '0.1.0',
      transport: 'streamable-http',
      mcpPath: '/mcp',
      auth: 'bearer',
      tools: [],
      sessions: { active: 0, max: 10, idleTtlSeconds: 1800 },
    }),
    audit: async () => [],
    ...overrides,
  };
}

const NOW = new Date('2026-01-01T12:00:00.000Z');
const now = () => NOW;

describe('loadSnapshot', () => {
  it('is ready with every section when the gateway answers', async () => {
    const snapshot = await loadSnapshot(fakeClient(), now);
    expect(snapshot.connection).toEqual({ kind: 'ready' });
    expect(snapshot.status).toEqual(STATUS);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.refreshedAt).toBe(NOW);
  });

  it('is unreachable, with no data, when the health check cannot connect', async () => {
    const client = fakeClient({
      health: async () => {
        throw new NetworkError('The gateway could not be reached');
      },
    });
    const snapshot = await loadSnapshot(client, now);

    expect(snapshot.connection).toEqual({ kind: 'unreachable', message: 'The gateway could not be reached' });
    expect(snapshot.health).toBeUndefined();
    expect(snapshot.status).toBeUndefined();
  });

  it('asks for a token without calling admin endpoints when none is set', async () => {
    let adminCalls = 0;
    const client = fakeClient({
      hasToken: false,
      status: async () => {
        adminCalls += 1;
        return STATUS;
      },
    });
    const snapshot = await loadSnapshot(client, now);

    expect(snapshot.connection).toEqual({ kind: 'needs_token' });
    expect(snapshot.health).toEqual(HEALTH);
    expect(adminCalls).toBe(0);
  });

  it('reports a rejected token and keeps the public health data', async () => {
    const client = fakeClient({
      status: async () => {
        throw new ApiError(401, 'unauthorized', 'Missing or invalid admin credential');
      },
    });
    const snapshot = await loadSnapshot(client, now);

    expect(snapshot.connection).toEqual({ kind: 'unauthorized' });
    expect(snapshot.health).toEqual(HEALTH);
    expect(snapshot.status).toBeUndefined();
  });

  it('reports a gateway without an admin token', async () => {
    const client = fakeClient({
      status: async () => {
        throw new ApiError(503, 'admin_not_configured', 'disabled');
      },
    });
    expect((await loadSnapshot(client, now)).connection).toEqual({ kind: 'admin_disabled' });
  });

  it('reports other failures with their message', async () => {
    const client = fakeClient({
      agents: async () => {
        throw new ApiError(500, 'internal_error', 'Internal error');
      },
    });
    expect((await loadSnapshot(client, now)).connection).toEqual({ kind: 'error', message: 'Internal error' });
  });
});
