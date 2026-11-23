import { describe, expect, it } from 'vitest';
import { Secret } from '@arp/security';
import type { ProviderId } from '@arp/shared';
import { createProviderAdapters, type ProviderAdapter, type ProviderSettings } from './index';

/**
 * Talks to the real provider APIs. Run with `npm run test:integration`.
 * A provider is skipped unless both its key and model are in the environment.
 * verify() is free. The one billable call per provider runs only when
 * ARP_INTEGRATION_PAID_CALLS=true, and asks for at most 64 output tokens.
 */
const PROVIDERS: ReadonlyArray<{ id: ProviderId; keyVar: string; modelVar: string }> = [
  { id: 'openai', keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL' },
  { id: 'anthropic', keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL' },
  { id: 'gemini', keyVar: 'GEMINI_API_KEY', modelVar: 'GEMINI_MODEL' },
];

const PAID = process.env.ARP_INTEGRATION_PAID_CALLS === 'true';

function settingsFor(keyVar: string, modelVar: string): ProviderSettings {
  const key = process.env[keyVar];
  const model = process.env[modelVar];
  return {
    apiKey: key === undefined || key === '' ? undefined : new Secret(key),
    model: model === undefined || model === '' ? undefined : model,
    timeoutMs: 30_000,
  };
}

function adapterFor(id: ProviderId): ProviderAdapter {
  const settings = Object.fromEntries(
    PROVIDERS.map((provider) => [provider.id, settingsFor(provider.keyVar, provider.modelVar)]),
  ) as Record<ProviderId, ProviderSettings>;
  return createProviderAdapters(settings)[id];
}

describe.each(PROVIDERS)('live $id adapter', ({ id, keyVar, modelVar }) => {
  const settings = settingsFor(keyVar, modelVar);
  const configured = settings.apiKey !== undefined && settings.model !== undefined;

  it.skipIf(!configured)('verify: the key is accepted and the provider becomes connected', async () => {
    const adapter = adapterFor(id);
    expect(adapter.status().state).toBe('configured');

    await adapter.verify();
    expect(adapter.status().state).toBe('connected');
  });

  it.skipIf(!configured || !PAID)('send: one small message is answered and usage is reported', async () => {
    const adapter = adapterFor(id);
    const response = await adapter.send({
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
      maxOutputTokens: 64,
    });

    expect(typeof response.text).toBe('string');
    expect(response.model).toBeTruthy();
    expect(adapter.status()).toMatchObject({ state: 'connected', usage: { requests: 1, failures: 0 } });
  });
});
