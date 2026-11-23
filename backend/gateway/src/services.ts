import type { AgentRegistry, ProviderAdapter } from '@arp/agents';
import { listToolSummaries, type GatewayServices, type ToolDefinition } from '@arp/mcp';
import type { RateLimiter } from '@arp/security';
import {
  GatewayError,
  GATEWAY_NAME,
  GATEWAY_VERSION,
  PROVIDER_IDS,
  type AgentSummary,
  type ProviderId,
  type ProviderStatus,
} from '@arp/shared';
import type { GatewayConfig } from './config';
import type { SessionStore } from './session-store';

export interface ServicesDeps {
  readonly config: GatewayConfig;
  readonly agents: AgentRegistry;
  readonly adapters: Readonly<Record<ProviderId, ProviderAdapter>>;
  readonly sessions: SessionStore;
  readonly startedAt: Date;
  readonly tools: readonly ToolDefinition[];
  readonly providerLimiter: RateLimiter;
}

export function uptimeSeconds(startedAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000));
}

export interface WarningInput {
  readonly adminConfigured: boolean;
  readonly agents: readonly AgentSummary[];
  readonly providers: readonly ProviderStatus[];
  readonly supabaseConfigured: boolean;
}

/** Operator-facing findings. Each one is derived from real configuration state. */
export function collectWarnings(input: WarningInput): string[] {
  const warnings: string[] = [];

  if (!input.adminConfigured) {
    warnings.push('GATEWAY_ADMIN_TOKEN is not set, so the dashboard API is disabled.');
  }
  if (!input.agents.some((agent) => agent.gatewayCredential === 'configured')) {
    warnings.push('No agent has a gateway token, so no MCP client can authenticate.');
  }
  const unconfigured = input.providers
    .filter((provider) => provider.state === 'unconfigured')
    .map((provider) => provider.id);
  if (unconfigured.length > 0) {
    warnings.push(`Needs both an API key and a model: ${unconfigured.join(', ')}.`);
  }
  const failing = input.providers
    .filter((provider) => provider.state === 'error')
    .map((provider) => provider.id);
  if (failing.length > 0) {
    warnings.push(`The last call failed for: ${failing.join(', ')}.`);
  }
  if (input.supabaseConfigured) {
    warnings.push('Supabase credentials are set but the gateway does not use them yet.');
  }
  return warnings;
}

export function createGatewayServices(deps: ServicesDeps): GatewayServices {
  const providerStatuses = (): ProviderStatus[] =>
    PROVIDER_IDS.map((id) => deps.adapters[id].status());

  return {
    getSystemStatus() {
      const providers = providerStatuses();
      const adminConfigured = deps.config.adminToken !== undefined;
      return {
        version: GATEWAY_VERSION,
        environment: deps.config.environment,
        startedAt: deps.startedAt.toISOString(),
        uptimeSeconds: uptimeSeconds(deps.startedAt),
        nodeVersion: process.version,
        components: {
          adminApi: adminConfigured ? 'configured' : 'unconfigured',
          supabase: deps.config.supabaseConfigured ? 'configured' : 'unconfigured',
          roblox: 'not_integrated',
        },
        providers,
        sessions: { active: deps.sessions.activeCount(), max: deps.config.sessions.max },
        toolCount: deps.tools.length,
        warnings: collectWarnings({
          adminConfigured,
          agents: deps.agents.list(),
          providers,
          supabaseConfigured: deps.config.supabaseConfigured,
        }),
      };
    },

    listAgents: (provider) => deps.agents.list(provider),

    getGatewayInfo: () => ({
      name: GATEWAY_NAME,
      version: GATEWAY_VERSION,
      transport: 'streamable-http',
      mcpPath: '/mcp',
      auth: 'bearer',
      tools: listToolSummaries(deps.tools),
      sessions: {
        active: deps.sessions.activeCount(),
        max: deps.config.sessions.max,
        idleTtlSeconds: deps.config.sessions.idleTtlSeconds,
      },
    }),

    getSessionStatus: (sessionId) => deps.sessions.status(sessionId),

    async sendMessage(request) {
      const target = deps.agents.resolve(request.agent);
      if (target === undefined) {
        throw new GatewayError('not_found', 'No agent with that id is registered');
      }

      const decision = deps.providerLimiter.hit(request.callerId);
      if (!decision.allowed) {
        throw new GatewayError('rate_limited', 'Too many provider calls from this agent', {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }

      const cap = deps.config.providerMaxOutputTokens;
      const response = await target.adapter.send({
        messages: [{ role: 'user', content: request.message }],
        system: request.system,
        maxOutputTokens: Math.min(request.maxOutputTokens ?? cap, cap),
        signal: request.signal,
      });
      return {
        agent: target.agent.id,
        provider: target.agent.provider,
        model: response.model,
        text: response.text,
        ...(response.finishReason === undefined ? {} : { finishReason: response.finishReason }),
        ...(response.usage === undefined ? {} : { usage: response.usage }),
      };
    },
  };
}
