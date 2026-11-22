import type { AgentRegistry, ProviderAdapter } from '@arp/agents';
import { listToolSummaries, type GatewayServices, type ToolDefinition } from '@arp/mcp';
import {
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
    warnings.push(`No API key is set for: ${unconfigured.join(', ')}.`);
  }
  if (input.supabaseConfigured) {
    warnings.push('Supabase credentials are set but Phase 1 does not use them.');
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
  };
}
