import { describe, expect, it } from 'vitest';
import { GatewayError } from '@arp/shared';
import { AGENT_ROSTER, AgentRegistry, createProviderAdapters } from './index';

const NONE = { openai: false, anthropic: false, gemini: false };

function token(label: string): string {
  return `${label}-`.padEnd(40, 'x');
}

describe('placeholder provider adapters', () => {
  it('report unconfigured when no key is present', () => {
    const adapters = createProviderAdapters(NONE);
    for (const adapter of Object.values(adapters)) {
      expect(adapter.status()).toMatchObject({ state: 'unconfigured', adapter: 'placeholder' });
    }
  });

  it('report configured, never connected, when a key is present', () => {
    const adapters = createProviderAdapters({ openai: true, anthropic: false, gemini: false });
    expect(adapters.openai.status().state).toBe('configured');
    expect(adapters.anthropic.status().state).toBe('unconfigured');
  });

  it('refuse to call the provider', async () => {
    const adapters = createProviderAdapters({ openai: true, anthropic: true, gemini: true });
    for (const adapter of Object.values(adapters)) {
      const failure = await adapter.invoke({ prompt: 'hello' }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GatewayError);
      expect((failure as GatewayError).code).toBe('not_implemented');
    }
  });
});

describe('AgentRegistry', () => {
  const adapters = createProviderAdapters({ openai: true, anthropic: false, gemini: false });

  it('authenticates an agent by its gateway token', () => {
    const registry = new AgentRegistry(
      AGENT_ROSTER,
      { chatgpt: token('chatgpt'), claude: token('claude') },
      adapters,
    );
    expect(registry.authenticate(token('claude'))).toMatchObject({ id: 'claude' });
    expect(registry.authenticate(token('chatgpt'))).toMatchObject({ id: 'chatgpt' });
  });

  it('rejects unknown tokens and agents without a configured token', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, { claude: token('claude') }, adapters);
    expect(registry.authenticate('not-a-token')).toBeUndefined();
    expect(registry.authenticate('')).toBeUndefined();
    expect(registry.authenticate(token('gemini'))).toBeUndefined();
  });

  it('does not treat an empty token as a credential', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, { claude: '' }, adapters);
    expect(registry.authenticate('')).toBeUndefined();
    expect(registry.get('claude')?.gatewayCredential).toBe('missing');
  });

  it('refuses two agents that share one token', () => {
    const shared = token('shared');
    expect(
      () => new AgentRegistry(AGENT_ROSTER, { chatgpt: shared, claude: shared }, adapters),
    ).toThrow(/shares a gateway token/);
  });

  it('refuses duplicate agent ids', () => {
    const duplicated = [AGENT_ROSTER[0], AGENT_ROSTER[0]].filter(
      (agent): agent is NonNullable<typeof agent> => agent !== undefined,
    );
    expect(() => new AgentRegistry(duplicated, {}, adapters)).toThrow(/Duplicate agent id/);
  });

  it('summarises credential and provider state without exposing tokens', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, { claude: token('claude') }, adapters);
    const summaries = registry.list();

    expect(summaries.map((agent) => agent.id)).toEqual(['chatgpt', 'claude', 'gemini']);
    expect(registry.get('claude')).toMatchObject({
      gatewayCredential: 'configured',
      providerState: 'unconfigured',
    });
    expect(registry.get('chatgpt')).toMatchObject({
      gatewayCredential: 'missing',
      providerState: 'configured',
    });
    expect(JSON.stringify(summaries)).not.toContain(token('claude'));
  });

  it('filters by provider and returns undefined for unknown ids', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, {}, adapters);
    expect(registry.list('gemini').map((agent) => agent.id)).toEqual(['gemini']);
    expect(registry.get('nobody')).toBeUndefined();
  });

  it('gives every Phase 1 agent read-only permissions', () => {
    for (const agent of AGENT_ROSTER) {
      expect(agent.permissions.every((permission) => permission.endsWith(':read'))).toBe(true);
    }
  });
});
