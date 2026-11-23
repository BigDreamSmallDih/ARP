import { describe, expect, it } from 'vitest';
import { Secret } from '@arp/security';
import type { ProviderId } from '@arp/shared';
import {
  AGENT_ROSTER,
  AgentRegistry,
  createProviderAdapters,
  type FetchLike,
  type ProviderSettings,
} from './index';

function token(label: string): string {
  return `${label}-`.padEnd(40, 'x');
}

function settings(configured: boolean): ProviderSettings {
  return {
    apiKey: configured ? new Secret('test-api-key-not-real') : undefined,
    model: configured ? 'test-model' : undefined,
    timeoutMs: 1_000,
  };
}

const NO_NETWORK: FetchLike = () => Promise.reject(new Error('the registry tests must not call a provider'));

function adaptersWith(configured: Record<ProviderId, boolean>) {
  return createProviderAdapters(
    { openai: settings(configured.openai), anthropic: settings(configured.anthropic), gemini: settings(configured.gemini) },
    NO_NETWORK,
  );
}

describe('AgentRegistry', () => {
  const adapters = adaptersWith({ openai: true, anthropic: false, gemini: false });

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

  it('shows each agent its provider model without exposing any key', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, {}, adapters);
    expect(registry.get('chatgpt')?.model).toBe('test-model');
    expect(registry.get('claude')?.model).toBeUndefined();
    expect(JSON.stringify(registry.list())).not.toContain('test-api-key-not-real');
  });

  it('resolves an agent to its own provider adapter', () => {
    const registry = new AgentRegistry(AGENT_ROSTER, {}, adapters);
    expect(registry.resolve('claude')?.adapter.id).toBe('anthropic');
    expect(registry.resolve('gemini')?.adapter.id).toBe('gemini');
    expect(registry.resolve('chatgpt')?.agent.provider).toBe('openai');
    expect(registry.resolve('nobody')).toBeUndefined();
  });

  it('gives every agent the read permissions and the explicit provider permission', () => {
    for (const agent of AGENT_ROSTER) {
      expect([...agent.permissions].sort()).toEqual([
        'agents:read',
        'gateway:read',
        'providers:invoke',
        'session:read',
        'system:read',
      ]);
    }
  });
});
