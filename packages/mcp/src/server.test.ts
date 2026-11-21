import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Permission } from '@arp/shared';
import type { AuditEventInput } from '@arp/security';
import { createFixtureServices } from './fixtures';
import { createMcpServer } from './server';

const ALL: Permission[] = ['system:read', 'agents:read', 'gateway:read', 'session:read'];

async function connect(permissions: Permission[] = ALL) {
  const events: AuditEventInput[] = [];
  const server = createMcpServer({
    agent: { id: 'claude', permissions },
    services: createFixtureServices(),
    audit: (event) => events.push(event),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, events };
}

function errorCodeOf(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const body = JSON.parse(text) as { error?: { code?: string } };
  return body.error?.code;
}

/** SDK versions differ on whether argument errors reject or return isError. */
async function settle(call: Promise<unknown>): Promise<{ failed: boolean; value: unknown }> {
  try {
    const value = await call;
    const failed = (value as { isError?: boolean }).isError === true;
    return { failed, value };
  } catch (error) {
    return { failed: true, value: error };
  }
}

describe('MCP server over an in-memory transport', () => {
  it('lists the four tools with input and output schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'get_gateway_info',
      'get_registered_agents',
      'get_session_status',
      'get_system_status',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }
  });

  it('returns structured content that matches the output schema', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_gateway_info', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      name: 'arp-gateway',
      transport: 'streamable-http',
      auth: 'bearer',
    });
  });

  it('applies the provider filter', async () => {
    const { client } = await connect();
    const result = await client.callTool({
      name: 'get_registered_agents',
      arguments: { provider: 'anthropic' },
    });
    expect(result.structuredContent).toEqual({
      agents: [expect.objectContaining({ id: 'claude' })],
    });
  });

  it('rejects arguments that fail validation', async () => {
    const { client } = await connect();
    const outcome = await settle(
      client.callTool({ name: 'get_registered_agents', arguments: { provider: 'azure' } }),
    );
    expect(outcome.failed).toBe(true);
  });

  it('returns a structured permission_denied error and audits it', async () => {
    const { client, events } = await connect(['system:read']);
    const result = await client.callTool({ name: 'get_registered_agents', arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(errorCodeOf(content[0]?.text)).toBe('permission_denied');
    expect(events).toContainEqual(
      expect.objectContaining({ tool: 'get_registered_agents', outcome: 'denied' }),
    );
  });

  it('reports a missing session through the transport without a session id', async () => {
    const { client } = await connect();
    const result = await client.callTool({ name: 'get_session_status', arguments: {} });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    expect(errorCodeOf(content[0]?.text)).toBe('session_not_found');
  });
});
