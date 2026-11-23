import type { Secret } from '@arp/security';
import {
  GatewayError,
  toGatewayError,
  type ProviderFailureKind,
  type ProviderId,
  type ProviderState,
  type ProviderStatus,
  type TokenUsage,
} from '@arp/shared';
import type { ZodType } from 'zod';

export interface ProviderSettings {
  readonly apiKey: Secret | undefined;
  readonly model: string | undefined;
  readonly timeoutMs: number;
}

export interface ProviderMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ProviderRequest {
  readonly messages: readonly ProviderMessage[];
  readonly system?: string | undefined;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal | undefined;
}

export interface ProviderResponse {
  readonly text: string;
  readonly model: string;
  readonly finishReason?: string | undefined;
  readonly usage?: TokenUsage | undefined;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  status(): ProviderStatus;
  /** Sends one conversation to the provider. Never retries, because a retry would bill twice. */
  send(request: ProviderRequest): Promise<ProviderResponse>;
  /** Makes a free, authenticated request to the provider and updates the connection state. */
  verify(signal?: AbortSignal): Promise<void>;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface HttpCall {
  readonly url: string;
  readonly init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string };
}

/** Raised by adapters for any failure of the provider exchange itself. */
export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind, message: string) {
    super(message);
    this.name = 'ProviderFailure';
    this.kind = kind;
  }
}

/** Validates a provider response body; a mismatch means the provider changed or is misbehaving. */
export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ProviderFailure('bad_response', 'The provider response did not have the expected shape');
  }
  return parsed.data;
}

export function tokenUsage(
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): TokenUsage | undefined {
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  const usage: { inputTokens?: number; outputTokens?: number } = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  return usage;
}

function failureKindForStatus(status: number): ProviderFailureKind {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status >= 500) return 'unavailable';
  return 'rejected';
}

/**
 * Shared transport and state handling. Subclasses only build the provider's HTTP calls and
 * read its responses, so the API key never leaves this class and a failure on one provider
 * never touches another provider's state.
 */
export abstract class HttpProviderAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  protected abstract readonly displayName: string;

  private readonly settings: ProviderSettings;
  private readonly fetchImpl: FetchLike;
  private inFlight = 0;
  private outcome: 'none' | 'success' | 'failure' = 'none';
  private lastSuccessAt: string | undefined;
  private lastError: { kind: ProviderFailureKind; at: string } | undefined;
  private readonly usage = { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 };

  constructor(settings: ProviderSettings, fetchImpl: FetchLike) {
    this.settings = settings;
    this.fetchImpl = fetchImpl;
  }

  protected abstract chatCall(apiKey: string, model: string, request: ProviderRequest): HttpCall;
  protected abstract readChat(body: unknown, model: string): ProviderResponse;
  protected abstract verifyCall(apiKey: string): HttpCall;

  status(): ProviderStatus {
    const status: ProviderStatus = {
      id: this.id,
      displayName: this.displayName,
      state: this.state(),
      usage: { ...this.usage },
    };
    if (this.settings.model !== undefined) status.model = this.settings.model;
    if (this.lastSuccessAt !== undefined) status.lastSuccessAt = this.lastSuccessAt;
    if (this.lastError !== undefined) status.lastError = { ...this.lastError };
    return status;
  }

  async send(request: ProviderRequest): Promise<ProviderResponse> {
    const { apiKey, model } = this.requireConfigured();
    const call = this.chatCall(apiKey, model, request);
    const response = await this.run(call, request.signal, (body) => this.readChat(body, model));
    this.usage.inputTokens += response.usage?.inputTokens ?? 0;
    this.usage.outputTokens += response.usage?.outputTokens ?? 0;
    return response;
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { apiKey } = this.requireConfigured();
    await this.run(this.verifyCall(apiKey), signal, () => undefined);
  }

  private state(): ProviderState {
    if (this.settings.apiKey === undefined || this.settings.model === undefined) return 'unconfigured';
    if (this.inFlight > 0 && this.outcome !== 'success') return 'connecting';
    if (this.outcome === 'success') return 'connected';
    return this.outcome === 'failure' ? 'error' : 'configured';
  }

  private requireConfigured(): { apiKey: string; model: string } {
    const { apiKey, model } = this.settings;
    if (apiKey === undefined || model === undefined) {
      throw new GatewayError(
        'provider_not_configured',
        `${this.displayName} needs both an API key and a model before it can be used`,
      );
    }
    return { apiKey: apiKey.reveal(), model };
  }

  private async run<T>(
    call: HttpCall,
    callerSignal: AbortSignal | undefined,
    read: (body: unknown) => T,
  ): Promise<T> {
    this.inFlight += 1;
    this.usage.requests += 1;
    try {
      const result = read(await this.exchange(call, callerSignal));
      this.outcome = 'success';
      this.lastSuccessAt = new Date().toISOString();
      return result;
    } catch (error) {
      throw this.recordFailure(error);
    } finally {
      this.inFlight -= 1;
    }
  }

  private recordFailure(error: unknown): GatewayError {
    if (!(error instanceof ProviderFailure)) return toGatewayError(error);

    this.outcome = 'failure';
    this.usage.failures += 1;
    this.lastError = { kind: error.kind, at: new Date().toISOString() };
    const message = `${this.displayName} request failed: ${error.message}`;
    return new GatewayError(error.kind === 'timeout' ? 'provider_timeout' : 'provider_error', message, {
      cause: error,
    });
  }

  /** Error messages carry only the HTTP status, never the response body, which could echo input. */
  private async exchange(call: HttpCall, callerSignal: AbortSignal | undefined): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([timeout, callerSignal]);

    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(call.url, { ...call.init, signal });
      status = response.status;
      text = await response.text();
    } catch {
      if (timeout.aborted) {
        throw new ProviderFailure('timeout', `no response within ${this.settings.timeoutMs} ms`);
      }
      if (callerSignal?.aborted === true) {
        throw new GatewayError('cancelled', 'The request was cancelled by the caller');
      }
      throw new ProviderFailure('unavailable', 'the provider could not be reached');
    }

    if (status < 200 || status >= 300) {
      throw new ProviderFailure(failureKindForStatus(status), `HTTP ${status}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ProviderFailure('bad_response', 'the response was not valid JSON');
    }
  }
}
