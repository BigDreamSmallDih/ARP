import { z } from 'zod';
import {
  AgentSummarySchema,
  GatewayError,
  GatewayInfoSchema,
  ProviderIdSchema,
  SessionStatusSchema,
  SystemStatusSchema,
  type ToolSummary,
} from '@arp/shared';
import { defineTool, type ToolDefinition } from './tool';

export const getSystemStatus = defineTool({
  name: 'get_system_status',
  title: 'System status',
  description:
    'Reports gateway uptime, component and provider configuration state, session usage and warnings.',
  requiredPermission: 'system:read',
  input: z.object({}),
  output: SystemStatusSchema,
  handler: (_input, ctx) => ctx.services.getSystemStatus(),
});

export const getRegisteredAgents = defineTool({
  name: 'get_registered_agents',
  title: 'Registered agents',
  description:
    'Lists the agents known to the gateway with their permissions and credential state. Optionally filter by provider.',
  requiredPermission: 'agents:read',
  input: z.object({ provider: ProviderIdSchema.optional() }),
  output: z.object({ agents: z.array(AgentSummarySchema) }),
  handler: (input, ctx) => ({ agents: ctx.services.listAgents(input.provider) }),
});

export const getGatewayInfo = defineTool({
  name: 'get_gateway_info',
  title: 'Gateway info',
  description: 'Describes the gateway: version, transport, authentication scheme, tools and session limits.',
  requiredPermission: 'gateway:read',
  input: z.object({}),
  output: GatewayInfoSchema,
  handler: (_input, ctx) => ctx.services.getGatewayInfo(),
});

export const getSessionStatus = defineTool({
  name: 'get_session_status',
  title: 'Session status',
  description: 'Reports the state of the calling agent\'s current gateway session.',
  requiredPermission: 'session:read',
  input: z.object({}),
  output: SessionStatusSchema,
  handler: (_input, ctx) => {
    const status =
      ctx.sessionId === undefined ? undefined : ctx.services.getSessionStatus(ctx.sessionId);
    if (status === undefined) {
      throw new GatewayError(
        'session_not_found',
        'No active gateway session is associated with this request',
      );
    }
    return status;
  },
});

export const TOOLS: readonly ToolDefinition[] = [
  getSystemStatus,
  getRegisteredAgents,
  getGatewayInfo,
  getSessionStatus,
];

export function listToolSummaries(tools: readonly ToolDefinition[] = TOOLS): ToolSummary[] {
  return tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    requiredPermission: tool.requiredPermission,
  }));
}
