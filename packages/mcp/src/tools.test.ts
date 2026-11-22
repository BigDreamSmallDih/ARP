import { describe, expect, it } from 'vitest';
import { GatewayError, type Permission } from '@arp/shared';
import type { AuditEventInput } from '@arp/security';
import { createFixtureServices } from './fixtures';
import {
  TOOLS,
  executeTool,
  getGatewayInfo,
  getRegisteredAgents,
  getSessionStatus,
  getSystemStatus,
  listToolSummaries,
  type ToolContext,
  type ToolDefinition,
} from './index';

const ALL: Permission[] = ['system:read', 'agents:read', 'gateway:read', 'session:read'];

/** Pass null for a request that carries no session; undefined would select the default. */
function setup(permissions: Permission[] = ALL, sessionId: string | null = 'session-1') {
  const events: AuditEventInput[] = [];
  const ctx: ToolContext = {
    agent: { id: 'claude', permissions },
    sessionId: sessionId ?? undefined,
    services: createFixtureServices(),
  };
  const run = (tool: ToolDefinition, input: unknown) =>
    executeTool(tool, input, ctx, (event) => events.push(event));
  return { events, run };
}

async function failureOf(promise: Promise<unknown>): Promise<GatewayError> {
  const result = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(GatewayError);
  return result as GatewayError;
}

describe('tool registry', () => {
  it('exposes exactly the four Phase 1 tools with unique names', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toEqual([
      'get_system_status',
      'get_registered_agents',
      'get_gateway_info',
      'get_session_status',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('summarises tools with their required permission', () => {
    expect(listToolSummaries()).toContainEqual(
      expect.objectContaining({ name: 'get_session_status', requiredPermission: 'session:read' }),
    );
  });
});

describe('executeTool', () => {
  it('returns validated structured output and audits success', async () => {
    const { run, events } = setup();
    const status = await run(getSystemStatus, {});
    expect(status).toMatchObject({ version: '0.1.0', components: { roblox: 'not_integrated' } });
    expect(events).toEqual([
      { type: 'tool.call', agentId: 'claude', sessionId: 'session-1', tool: 'get_system_status', outcome: 'success' },
    ]);
  });

  it('filters agents by provider', async () => {
    const { run } = setup();
    const all = await run(getRegisteredAgents, {});
    const filtered = await run(getRegisteredAgents, { provider: 'gemini' });
    expect((all as { agents: unknown[] }).agents).toHaveLength(2);
    expect(filtered).toEqual({
      agents: [expect.objectContaining({ id: 'gemini', providerState: 'configured' })],
    });
  });

  it('rejects an unknown provider as invalid_request and audits the error', async () => {
    const { run, events } = setup();
    const error = await failureOf(run(getRegisteredAgents, { provider: 'azure' }));
    expect(error.code).toBe('invalid_request');
    expect(events.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'invalid_request' });
  });

  it('rejects input of the wrong type', async () => {
    const { run } = setup();
    const error = await failureOf(run(getRegisteredAgents, { provider: 7 }));
    expect(error.code).toBe('invalid_request');
  });

  it('denies a call without the required permission before running the handler', async () => {
    const { run, events } = setup(['system:read']);
    const error = await failureOf(run(getGatewayInfo, {}));
    expect(error.code).toBe('permission_denied');
    expect(events).toEqual([
      expect.objectContaining({
        tool: 'get_gateway_info',
        outcome: 'denied',
        errorCode: 'permission_denied',
      }),
    ]);
  });

  it('reports the caller session', async () => {
    const { run } = setup();
    expect(await run(getSessionStatus, {})).toMatchObject({
      sessionId: 'session-1',
      agentId: 'claude',
      requestCount: 2,
    });
  });

  it('fails with session_not_found when there is no session', async () => {
    const { run } = setup(ALL, null);
    expect((await failureOf(run(getSessionStatus, {}))).code).toBe('session_not_found');

    const unknown = setup(ALL, 'other-session');
    expect((await failureOf(unknown.run(getSessionStatus, {}))).code).toBe('session_not_found');
  });

  it('turns a handler that breaks its output schema into an internal_error', async () => {
    const broken: ToolDefinition = {
      ...getSystemStatus,
      name: 'broken',
      handler: () => ({ version: 1 }),
    };
    const { run, events } = setup();
    const error = await failureOf(run(broken, {}));
    expect(error.code).toBe('internal_error');
    expect(events.at(-1)).toMatchObject({ outcome: 'error', errorCode: 'internal_error' });
  });

  it('wraps unexpected handler exceptions without leaking their message', async () => {
    const throwing: ToolDefinition = {
      ...getSystemStatus,
      name: 'throwing',
      handler: () => {
        throw new Error('connection string postgres://user:secret@host');
      },
    };
    const { run } = setup();
    const error = await failureOf(run(throwing, {}));
    expect(error.code).toBe('internal_error');
    expect(error.message).not.toContain('secret');
  });
});
