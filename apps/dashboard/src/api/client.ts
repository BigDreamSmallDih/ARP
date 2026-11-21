import { z } from 'zod';
import {
  AgentSummarySchema,
  AuditEventSchema,
  ErrorBodySchema,
  GatewayInfoSchema,
  HealthSchema,
  SystemStatusSchema,
  type AgentSummary,
  type AuditEvent,
  type GatewayInfo,
  type Health,
  type SystemStatus,
} from '@arp/shared';

export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NetworkError';
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface GatewayClient {
  readonly hasToken: boolean;
  health(): Promise<Health>;
  status(): Promise<SystemStatus>;
  agents(): Promise<AgentSummary[]>;
  gateway(): Promise<GatewayInfo>;
  audit(limit?: number): Promise<AuditEvent[]>;
}

export interface ClientOptions {
  /** Empty means same origin. */
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly fetchImpl?: typeof fetch;
}

export function createClient(options: ClientOptions): GatewayClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const token = options.token === undefined || options.token === '' ? undefined : options.token;

  async function request<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    authenticated: boolean,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (authenticated && token !== undefined) headers.authorization = `Bearer ${token}`;

    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, { headers });
    } catch (error) {
      throw new NetworkError('The gateway could not be reached', { cause: error });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        'invalid_response',
        `The gateway answered with HTTP ${response.status} and a body that is not JSON`,
      );
    }

    if (!response.ok) {
      const failure = ErrorBodySchema.safeParse(payload);
      if (failure.success) {
        throw new ApiError(response.status, failure.data.error.code, failure.data.error.message);
      }
      throw new ApiError(response.status, 'http_error', `The gateway answered with HTTP ${response.status}`);
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        'invalid_response',
        'The gateway response does not match the expected shape',
      );
    }
    return parsed.data;
  }

  return {
    hasToken: token !== undefined,
    health: () => request('/health', HealthSchema, false),
    status: () => request('/api/status', SystemStatusSchema, true),
    agents: async () =>
      (await request('/api/agents', z.object({ agents: z.array(AgentSummarySchema) }), true)).agents,
    gateway: () => request('/api/gateway', GatewayInfoSchema, true),
    audit: async (limit = 50) =>
      (await request(`/api/audit?limit=${limit}`, z.object({ events: z.array(AuditEventSchema) }), true))
        .events,
  };
}
