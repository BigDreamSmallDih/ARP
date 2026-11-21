import { z } from 'zod';
import { ErrorCodeSchema } from './errors';
import { PermissionSchema } from './permissions';

export const ProviderIdSchema = z.enum(['openai', 'anthropic', 'gemini']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const PROVIDER_IDS = ProviderIdSchema.options;

/** Phase 1 never contacts a provider, so there is deliberately no "connected" state. */
export const ProviderStateSchema = z.enum(['unconfigured', 'configured']);
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const ProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  displayName: z.string(),
  state: ProviderStateSchema,
  adapter: z.literal('placeholder'),
});
export type ProviderStatus = z.infer<typeof ProviderStatusSchema>;

export const AgentSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: ProviderIdSchema,
  providerState: ProviderStateSchema,
  gatewayCredential: z.enum(['configured', 'missing']),
  permissions: z.array(PermissionSchema),
});
export type AgentSummary = z.infer<typeof AgentSummarySchema>;

export const ComponentStateSchema = z.enum(['configured', 'unconfigured']);
export type ComponentState = z.infer<typeof ComponentStateSchema>;

export const SystemStatusSchema = z.object({
  version: z.string(),
  environment: z.enum(['development', 'test', 'production']),
  startedAt: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  nodeVersion: z.string(),
  components: z.object({
    adminApi: ComponentStateSchema,
    supabase: ComponentStateSchema,
    roblox: z.literal('not_integrated'),
  }),
  providers: z.array(ProviderStatusSchema),
  sessions: z.object({
    active: z.number().int().nonnegative(),
    max: z.number().int().positive(),
  }),
  toolCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const ToolSummarySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  requiredPermission: PermissionSchema,
});
export type ToolSummary = z.infer<typeof ToolSummarySchema>;

export const GatewayInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  transport: z.literal('streamable-http'),
  mcpPath: z.string(),
  auth: z.literal('bearer'),
  tools: z.array(ToolSummarySchema),
  sessions: z.object({
    active: z.number().int().nonnegative(),
    max: z.number().int().positive(),
    idleTtlSeconds: z.number().int().positive(),
  }),
});
export type GatewayInfo = z.infer<typeof GatewayInfoSchema>;

export const SessionStatusSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  requestCount: z.number().int().nonnegative(),
});
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const AuditEventTypeSchema = z.enum([
  'auth.failed',
  'session.created',
  'session.closed',
  'tool.call',
]);

export const AuditEventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: AuditEventTypeSchema,
  outcome: z.enum(['success', 'denied', 'error']),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  tool: z.string().optional(),
  errorCode: ErrorCodeSchema.optional(),
  reason: z.enum(['client_closed', 'expired', 'shutdown']).optional(),
  requestId: z.string().optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  uptimeSeconds: z.number().int().nonnegative(),
  timestamp: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;
