import type { ProviderId } from '@arp/shared';
import type { FetchLike, ProviderAdapter, ProviderSettings } from './adapter';
import { ClaudeAdapter } from './claude';
import { GeminiAdapter } from './gemini';
import { OpenAIAdapter } from './openai';

/** Adding a provider means a new adapter class, a ProviderId, and one entry here; the compiler flags the rest. */
export function createProviderAdapters(
  settings: Readonly<Record<ProviderId, ProviderSettings>>,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Record<ProviderId, ProviderAdapter> {
  return {
    openai: new OpenAIAdapter(settings.openai, fetchImpl),
    anthropic: new ClaudeAdapter(settings.anthropic, fetchImpl),
    gemini: new GeminiAdapter(settings.gemini, fetchImpl),
  };
}
