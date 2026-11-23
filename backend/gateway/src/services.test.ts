import { describe, expect, it } from 'vitest';
import { AGENT_ROSTER, AgentRegistry, createProviderAdapters } from '@arp/agents';
import { TOOLS } from '@arp/mcp';
import {
  GatewayError,
  GatewayInfoSchema,
  SystemStatusSchema,
  type ProviderStatus,
} from '@arp/shared';
import { RateLimiter } from '@arp/security';
import { collectWarnings, createGatewayServices, uptimeSeconds } from './services';
import { SessionStore } from './session-store';
import { PROVIDER_ENV, fakeProviders, testConfig, testToken } from './test-support';

const NO_USAGE = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };

function build(overrides: Record<string, string> = {}, providerCallsPerMinute = 20) {
  const config = testConfig(overrides);
  const providers = fakeProviders();
  const adapters = createProviderAdapters(config.providers, providers.fetchImpl);
  const agents = new AgentRegistry(AGENT_ROSTER, config.agentTokens, adapters);
  const sessions = new SessionStore({ maxSessions: 10, maxSessionsPerAgent: 5, idleTtlMs: 60_000 });
  const startedAt = new Date(Date.now() - 5_000);
  const providerLimiter = new RateLimiter({ limit: providerCallsPerMinute, windowMs: 60_000 });
  const services = createGatewayServices({
    config,
    agents,
    adapters,
    sessions,
    startedAt,
    tools: TOOLS,
    providerLimiter,
  });
  return { services, sessions, config, providers };
}

describe('getSystemStatus', () => {
  it('matches the shared schema and reports unconfigured providers as unconfigured', () => {
    const { services } = build();
    const status = SystemStatusSchema.parse(services.getSystemStatus());

    expect(status.providers.map((provider) => [provider.id, provider.state])).toEqual([
      ['openai', 'unconfigured'],
      ['anthropic', 'unconfigured'],
      ['gemini', 'unconfigured'],
    ]);
    expect(status.components).toEqual({
      adminApi: 'configured',
      supabase: 'unconfigured',
      roblox: 'not_integrated',
    });
    expect(status.toolCount).toBe(TOOLS.length);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  it('marks a provider configured only when both its key and model are set, and never connected', () => {
    const { services } = build({ ANTHROPIC_API_KEY: 'any-non-empty-value-1', ANTHROPIC_MODEL: 'some-model' });
    const states = services.getSystemStatus().providers.map((provider) => provider.state);
    expect(states).toEqual(['unconfigured', 'configured', 'unconfigured']);

    const keyOnly = build({ OPENAI_API_KEY: 'any-non-empty-value-2' });
    expect(keyOnly.services.getSystemStatus().providers[0]?.state).toBe('unconfigured');
  });

  it('reports connected only after a provider call succeeded', async () => {
    const { services } = build(PROVIDER_ENV);
    const states = () => services.getSystemStatus().providers.map((provider) => provider.state);
    expect(states()).toEqual(['configured', 'configured', 'configured']);

    await services.sendMessage({ callerId: 'claude', agent: 'claude', message: 'hi' });
    expect(states()).toEqual(['configured', 'connected', 'configured']);
  });

  it('counts active sessions', () => {
    const { services, sessions } = build();
    sessions.create('s1', 'claude');
    expect(services.getSystemStatus().sessions).toEqual({ active: 1, max: 100 });
  });

  it('does not include any credential in its output', () => {
    const { services } = build({ ...PROVIDER_ENV, OPENAI_API_KEY: 'provider-key-value-1234567890' });
    const serialized = JSON.stringify([services.getSystemStatus(), services.getGatewayInfo(), services.listAgents()]);
    for (const secret of [testToken('admin'), testToken('claude'), 'provider-key-value-1234567890']) {
      expect(serialized).not.toContain(secret);
    }
  });
});

describe('getGatewayInfo', () => {
  it('describes the transport, auth scheme and tools', () => {
    const { services } = build();
    const info = GatewayInfoSchema.parse(services.getGatewayInfo());
    expect(info).toMatchObject({
      transport: 'streamable-http',
      mcpPath: '/mcp',
      auth: 'bearer',
      sessions: { active: 0, max: 100, idleTtlSeconds: 1800 },
    });
    expect(info.tools.map((tool) => tool.name)).toContain('get_session_status');
  });
});

describe('listAgents and getSessionStatus', () => {
  it('reports credential state per agent and filters by provider', () => {
    const { services } = build();
    const byId = Object.fromEntries(services.listAgents().map((agent) => [agent.id, agent.gatewayCredential]));
    expect(byId).toEqual({ chatgpt: 'configured', claude: 'configured', gemini: 'missing' });
    expect(services.listAgents('gemini')).toHaveLength(1);
  });

  it('returns undefined for an unknown session', () => {
    expect(build().services.getSessionStatus('missing')).toBeUndefined();
  });
});

function provider(id: 'openai' | 'gemini', state: ProviderStatus['state']): ProviderStatus {
  return { id, displayName: id, state, usage: NO_USAGE };
}

describe('collectWarnings', () => {
  const agent = (gatewayCredential: 'configured' | 'missing') => ({
    id: 'claude',
    displayName: 'Claude',
    provider: 'anthropic' as const,
    providerState: 'unconfigured' as const,
    gatewayCredential,
    permissions: [],
  });

  it('is empty when everything is configured', () => {
    expect(
      collectWarnings({
        adminConfigured: true,
        agents: [agent('configured')],
        providers: [provider('openai', 'connected')],
        supabaseConfigured: false,
      }),
    ).toEqual([]);
  });

  it('warns about a provider whose last call failed', () => {
    const warnings = collectWarnings({
      adminConfigured: true,
      agents: [agent('configured')],
      providers: [provider('openai', 'error'), provider('gemini', 'connected')],
      supabaseConfigured: false,
    });
    expect(warnings).toEqual(['The last call failed for: openai.']);
  });

  it('lists each missing piece of configuration', () => {
    const warnings = collectWarnings({
      adminConfigured: false,
      agents: [agent('missing')],
      providers: [
        provider('openai', 'unconfigured'),
        provider('gemini', 'unconfigured'),
      ],
      supabaseConfigured: true,
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toContain('openai, gemini');
  });
});

describe('sendMessage', () => {
  const callerId = 'claude';

  it('rejects an unknown agent without spending any rate-limit quota or calling a provider', async () => {
    const { services, providers } = build(PROVIDER_ENV, 1);
    const failure = await services
      .sendMessage({ callerId, agent: 'nobody', message: 'hi' })
      .catch((error: unknown) => error);
    expect((failure as GatewayError).code).toBe('not_found');

    await expect(services.sendMessage({ callerId, agent: 'claude', message: 'hi' })).resolves.toBeDefined();
    expect(providers.hosts).toEqual(['api.anthropic.com']);
  });

  it('raises rate_limited with a retry hint once the caller exceeds its quota', async () => {
    const { services } = build(PROVIDER_ENV, 1);
    await services.sendMessage({ callerId, agent: 'claude', message: 'one' });

    const failure = (await services
      .sendMessage({ callerId, agent: 'claude', message: 'two' })
      .catch((error: unknown) => error)) as GatewayError;
    expect(failure.code).toBe('rate_limited');
    expect(failure.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts the quota per caller, not per target agent', async () => {
    const { services } = build(PROVIDER_ENV, 1);
    await services.sendMessage({ callerId: 'claude', agent: 'gemini', message: 'one' });
    await expect(
      services.sendMessage({ callerId: 'chatgpt', agent: 'gemini', message: 'two' }),
    ).resolves.toBeDefined();
  });

  it('fails with provider_not_configured for an agent whose provider has no key', async () => {
    const { services, providers } = build();
    const failure = (await services
      .sendMessage({ callerId, agent: 'claude', message: 'hi' })
      .catch((error: unknown) => error)) as GatewayError;
    expect(failure.code).toBe('provider_not_configured');
    expect(providers.hosts).toEqual([]);
  });
});

describe('uptimeSeconds', () => {
  it('floors to whole seconds and never goes negative', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(uptimeSeconds(start, new Date('2026-01-01T00:00:05.900Z'))).toBe(5);
    expect(uptimeSeconds(start, new Date('2025-12-31T23:59:59.000Z'))).toBe(0);
  });
});
