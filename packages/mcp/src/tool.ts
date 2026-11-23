import type { z } from 'zod';
import { assertPermission, type AuditEventInput } from '@arp/security';
import {
  GatewayError,
  toGatewayError,
  type AgentSummary,
  type GatewayInfo,
  type Permission,
  type ProviderId,
  type ProviderReply,
  type SessionStatus,
  type SystemStatus,
} from '@arp/shared';

export interface ToolAgent {
  readonly id: string;
  readonly permissions: readonly Permission[];
}

export interface SendMessageRequest {
  readonly callerId: string;
  readonly agent: string;
  readonly message: string;
  readonly system?: string | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** What the gateway exposes to tools. Tools never reach into gateway internals directly. */
export interface GatewayServices {
  getSystemStatus(): SystemStatus;
  listAgents(provider?: ProviderId): AgentSummary[];
  getGatewayInfo(): GatewayInfo;
  getSessionStatus(sessionId: string): SessionStatus | undefined;
  /** Routes the message to the provider behind the target agent. Billable. */
  sendMessage(request: SendMessageRequest): Promise<ProviderReply>;
}

export interface ToolContext {
  readonly agent: ToolAgent;
  readonly sessionId: string | undefined;
  readonly services: GatewayServices;
  /** Aborted when the MCP client cancels the call. */
  readonly signal?: AbortSignal | undefined;
}

export type AuditFn = (event: AuditEventInput) => void;

export interface ToolDefinition<
  I extends z.AnyZodObject = z.AnyZodObject,
  O extends z.AnyZodObject = z.AnyZodObject,
> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requiredPermission: Permission;
  readonly input: I;
  readonly output: O;
  handler(input: z.infer<I>, ctx: ToolContext): Promise<z.infer<O>> | z.infer<O>;
}

export function defineTool<I extends z.AnyZodObject, O extends z.AnyZodObject>(
  definition: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return definition;
}

/** Throws a GatewayError on every failure so callers map a single error shape. */
export async function executeTool(
  tool: ToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
  audit: AuditFn,
): Promise<Record<string, unknown>> {
  const base = {
    type: 'tool.call' as const,
    agentId: ctx.agent.id,
    sessionId: ctx.sessionId,
    tool: tool.name,
  };

  try {
    assertPermission(ctx.agent.id, ctx.agent.permissions, tool.requiredPermission);

    const input = tool.input.safeParse(rawInput);
    if (!input.success) {
      throw new GatewayError('invalid_request', `Invalid input for tool "${tool.name}"`, {
        details: input.error.issues,
      });
    }

    const result = await tool.handler(input.data, ctx);

    const output = tool.output.safeParse(result);
    if (!output.success) {
      throw new GatewayError(
        'internal_error',
        `Tool "${tool.name}" produced a response that does not match its output schema`,
        { details: output.error.issues },
      );
    }

    audit({ ...base, outcome: 'success' });
    return output.data;
  } catch (error) {
    const failure = toGatewayError(error);
    audit({
      ...base,
      outcome: failure.code === 'permission_denied' ? 'denied' : 'error',
      errorCode: failure.code,
    });
    throw failure;
  }
}
