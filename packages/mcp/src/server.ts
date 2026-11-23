import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodRawShape } from 'zod';
import { GATEWAY_NAME, GATEWAY_VERSION, toErrorBody, toGatewayError } from '@arp/shared';
import {
  executeTool,
  type AuditFn,
  type GatewayServices,
  type ToolAgent,
  type ToolDefinition,
} from './tool';
import { TOOLS } from './tools';

export interface McpServerOptions {
  readonly agent: ToolAgent;
  readonly services: GatewayServices;
  readonly audit: AuditFn;
  readonly tools?: readonly ToolDefinition[];
}

/** Creates one MCP server bound to the authenticated agent that owns the session. */
export function createMcpServer(options: McpServerOptions): McpServer {
  const server = new McpServer({ name: GATEWAY_NAME, version: GATEWAY_VERSION });

  for (const tool of options.tools ?? TOOLS) {
    const inputShape: ZodRawShape = tool.input.shape;
    const outputShape: ZodRawShape = tool.output.shape;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: inputShape,
        outputSchema: outputShape,
      },
      async (args, extra): Promise<CallToolResult> => {
        try {
          const output = await executeTool(
            tool,
            args,
            {
              agent: options.agent,
              sessionId: extra.sessionId,
              services: options.services,
              signal: extra.signal,
            },
            options.audit,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          const body = toErrorBody(toGatewayError(error));
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
        }
      },
    );
  }

  return server;
}
