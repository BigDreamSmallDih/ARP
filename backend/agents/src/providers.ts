import {
  GatewayError,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderStatus,
} from '@arp/shared';

export interface ProviderRequest {
  readonly prompt: string;
}

export interface ProviderResponse {
  readonly text: string;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  status(): ProviderStatus;
  invoke(request: ProviderRequest): Promise<ProviderResponse>;
}

const DISPLAY_NAMES: Record<ProviderId, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  gemini: 'Google Gemini',
};

function createPlaceholderAdapter(id: ProviderId, configured: boolean): ProviderAdapter {
  const displayName = DISPLAY_NAMES[id];
  return {
    id,
    status: () => ({
      id,
      displayName,
      state: configured ? 'configured' : 'unconfigured',
      adapter: 'placeholder',
    }),
    invoke: () =>
      Promise.reject(
        new GatewayError(
          'not_implemented',
          `The ${displayName} adapter is a placeholder; live provider calls are not implemented`,
        ),
      ),
  };
}

/** Callers pass only whether a key is present, so adapters never see the key. */
export function createProviderAdapters(
  configured: Readonly<Record<ProviderId, boolean>>,
): Record<ProviderId, ProviderAdapter> {
  const adapters = {} as Record<ProviderId, ProviderAdapter>;
  for (const id of PROVIDER_IDS) {
    adapters[id] = createPlaceholderAdapter(id, configured[id]);
  }
  return adapters;
}
