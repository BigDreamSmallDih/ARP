import { GatewayError, type AgentSummary, type ProviderId } from '@arp/shared';
import { listToolSummaries } from './tools';
import type { GatewayServices } from './tool';

const AGENTS: AgentSummary[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    provider: 'anthropic',
    providerState: 'unconfigured',
    gatewayCredential: 'configured',
    permissions: ['system:read', 'agents:read', 'gateway:read', 'session:read'],
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    provider: 'gemini',
    providerState: 'configured',
    gatewayCredential: 'missing',
    permissions: ['system:read', 'agents:read', 'gateway:read', 'session:read'],
  },
];

/** Deterministic services for tool and server tests only; the reply text is a fixture, not model output. */
export function createFixtureServices(sessionId = 'session-1'): GatewayServices {
  return {
    getSystemStatus: () => ({
      version: '0.1.0',
      environment: 'test',
      startedAt: '2026-01-01T00:00:00.000Z',
      uptimeSeconds: 42,
      nodeVersion: 'v20.19.0',
      components: { adminApi: 'configured', supabase: 'unconfigured', roblox: 'not_integrated' },
      providers: [
        {
          id: 'openai',
          displayName: 'OpenAI',
          state: 'unconfigured',
          usage: { requests: 0, failures: 0, inputTokens: 0, outputTokens: 0 },
        },
      ],
      sessions: { active: 1, max: 10 },
      toolCount: 5,
      warnings: [],
    }),
    listAgents: (provider?: ProviderId) =>
      AGENTS.filter((agent) => provider === undefined || agent.provider === provider),
    getGatewayInfo: () => ({
      name: 'arp-gateway',
      version: '0.1.0',
      transport: 'streamable-http',
      mcpPath: '/mcp',
      auth: 'bearer',
      tools: listToolSummaries(),
      sessions: { active: 1, max: 10, idleTtlSeconds: 1800 },
    }),
    getSessionStatus: (id) =>
      id === sessionId
        ? {
            sessionId: id,
            agentId: 'claude',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastSeenAt: '2026-01-01T00:00:01.000Z',
            expiresAt: '2026-01-01T00:30:01.000Z',
            requestCount: 2,
          }
        : undefined,
    sendMessage: async (request) => {
      if (!AGENTS.some((agent) => agent.id === request.agent)) {
        throw new GatewayError('not_found', `Unknown agent "${request.agent}"`);
      }
      return {
        agent: request.agent,
        provider: 'anthropic',
        model: 'fixture-model',
        text: `fixture reply to: ${request.message}`,
        usage: { inputTokens: 3, outputTokens: 5 },
      };
    },
  };
}
