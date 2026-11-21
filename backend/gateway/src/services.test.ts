import { describe, expect, it } from 'vitest';
import { AGENT_ROSTER, AgentRegistry, createProviderAdapters } from '@arp/agents';
import { TOOLS } from '@arp/mcp';
import { GatewayInfoSchema, SystemStatusSchema } from '@arp/shared';
import { collectWarnings, createGatewayServices, uptimeSeconds } from './services';
import { SessionStore } from './session-store';
import { testConfig, testToken } from './test-support';

function build(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const adapters = createProviderAdapters(config.providerKeysPresent);
  const agents = new AgentRegistry(AGENT_ROSTER, config.agentTokens, adapters);
  const sessions = new SessionStore({ maxSessions: 10, idleTtlMs: 60_000 });
  const startedAt = new Date(Date.now() - 5_000);
  const services = createGatewayServices({ config, agents, adapters, sessions, startedAt, tools: TOOLS });
  return { services, sessions, config };
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
    expect(status.toolCount).toBe(4);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(5);
  });

  it('marks a provider configured when its key is present, and never connected', () => {
    const { services } = build({ ANTHROPIC_API_KEY: 'any-non-empty-value' });
    const states = services.getSystemStatus().providers.map((provider) => provider.state);
    expect(states).toEqual(['unconfigured', 'configured', 'unconfigured']);
    expect(states).not.toContain('connected' as never);
  });

  it('counts active sessions', () => {
    const { services, sessions } = build();
    sessions.create('s1', 'claude');
    expect(services.getSystemStatus().sessions).toEqual({ active: 1, max: 100 });
  });

  it('does not include any credential in its output', () => {
    const { services } = build({ OPENAI_API_KEY: 'provider-key-value-1234567890' });
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
        providers: [{ id: 'openai', displayName: 'OpenAI', state: 'configured', adapter: 'placeholder' }],
        supabaseConfigured: false,
      }),
    ).toEqual([]);
  });

  it('lists each missing piece of configuration', () => {
    const warnings = collectWarnings({
      adminConfigured: false,
      agents: [agent('missing')],
      providers: [
        { id: 'openai', displayName: 'OpenAI', state: 'unconfigured', adapter: 'placeholder' },
        { id: 'gemini', displayName: 'Gemini', state: 'unconfigured', adapter: 'placeholder' },
      ],
      supabaseConfigured: true,
    });
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toContain('openai, gemini');
  });
});

describe('uptimeSeconds', () => {
  it('floors to whole seconds and never goes negative', () => {
    const start = new Date('2026-01-01T00:00:00.000Z');
    expect(uptimeSeconds(start, new Date('2026-01-01T00:00:05.900Z'))).toBe(5);
    expect(uptimeSeconds(start, new Date('2025-12-31T23:59:59.000Z'))).toBe(0);
  });
});
