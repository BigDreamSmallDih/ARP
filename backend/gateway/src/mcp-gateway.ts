import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { AgentIdentity, AgentRegistry } from '@arp/agents';
import { createMcpServer, type GatewayServices } from '@arp/mcp';
import { extractBearerToken, type AuditLog } from '@arp/security';
import { GatewayError, toErrorBody } from '@arp/shared';
import type { AuthFailureGuard } from './auth-guard';
import type { SessionStore } from './session-store';

export interface McpGatewayDeps {
  readonly sessions: SessionStore;
  readonly agents: AgentRegistry;
  readonly services: GatewayServices;
  readonly audit: AuditLog;
  readonly authGuard: AuthFailureGuard;
  readonly logger: FastifyBaseLogger;
}

interface LiveSession {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

type CloseReason = 'client_closed' | 'expired' | 'shutdown';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * One transport and McpServer per session, bound to the agent that initialised it.
 * Responses are plain JSON because Phase 1 has no server-initiated streams.
 */
export class McpGateway {
  private readonly deps: McpGatewayDeps;
  private readonly live = new Map<string, LiveSession>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
  private shuttingDown = false;

  constructor(deps: McpGatewayDeps) {
    this.deps = deps;
  }

  register(app: FastifyInstance): void {
    const handler = (request: FastifyRequest, reply: FastifyReply) => this.handle(request, reply);
    app.post('/mcp', handler);
    app.get('/mcp', handler);
    app.delete('/mcp', handler);
  }

  startSweeper(intervalMs: number): void {
    if (this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => {
      this.sweepExpired();
    }, intervalMs);
    this.sweeper.unref();
  }

  sweepExpired(): void {
    for (const record of this.deps.sessions.sweepExpired()) {
      const live = this.live.get(record.id);
      this.live.delete(record.id);
      this.deps.audit.record({
        type: 'session.closed',
        outcome: 'success',
        agentId: record.agentId,
        sessionId: record.id,
        reason: 'expired',
      });
      live?.transport.close().catch((error: unknown) => {
        this.deps.logger.error({ err: error }, 'Failed to close an expired MCP session');
      });
    }
  }

  async shutdown(): Promise<void> {
    if (this.sweeper !== undefined) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    this.shuttingDown = true;

    const sessions = [...this.live.values()];
    const results = await Promise.allSettled(sessions.map(({ transport }) => transport.close()));
    for (const result of results) {
      if (result.status === 'rejected') {
        this.deps.logger.error({ err: result.reason }, 'Failed to close an MCP session on shutdown');
      }
    }
  }

  private async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const agent = this.authenticate(request);
    const sessionId = firstHeader(request.headers['mcp-session-id']);

    if (sessionId !== undefined) {
      const live = this.requireLive(sessionId, agent.id);
      this.deps.sessions.touch(sessionId);
      await this.dispatch(live.transport, request, reply);
      return;
    }

    if (request.method === 'POST' && isInitializeRequest(request.body)) {
      await this.initialize(agent, request, reply);
      return;
    }

    throw new GatewayError(
      'invalid_request',
      'Send an initialize request first, then include the Mcp-Session-Id header on later requests',
    );
  }

  private authenticate(request: FastifyRequest): AgentIdentity {
    this.deps.authGuard.assertAllowed(request.ip, request.id);
    const token = extractBearerToken(request.headers.authorization);
    const agent = token === undefined ? undefined : this.deps.agents.authenticate(token);
    if (agent === undefined) {
      this.deps.authGuard.recordFailure(request.ip, request.id);
      throw new GatewayError('unauthorized', 'Missing or invalid agent credential');
    }
    return agent;
  }

  private requireLive(sessionId: string, agentId: string): LiveSession {
    const record = this.deps.sessions.get(sessionId);
    const live = this.live.get(sessionId);
    if (record === undefined || live === undefined) {
      throw new GatewayError('session_not_found', 'Unknown or expired session');
    }
    if (record.agentId !== agentId) {
      this.deps.audit.record({
        type: 'auth.failed',
        outcome: 'denied',
        agentId,
        sessionId,
        errorCode: 'forbidden',
      });
      throw new GatewayError('forbidden', 'This session belongs to a different agent');
    }
    return live;
  }

  private async initialize(
    agent: AgentIdentity,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    this.deps.sessions.assertCapacity(agent.id);

    const server = createMcpServer({
      agent,
      services: this.deps.services,
      audit: (event) => {
        this.deps.audit.record(event);
      },
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        this.deps.sessions.create(sessionId, agent.id);
        this.live.set(sessionId, { transport, server });
        this.deps.audit.record({
          type: 'session.created',
          outcome: 'success',
          agentId: agent.id,
          sessionId,
          requestId: request.id,
        });
      },
    });

    // Must be set before connect(), which chains onto an existing handler.
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) {
        this.release(sessionId, this.shuttingDown ? 'shutdown' : 'client_closed');
      }
    };

    await server.connect(transport);
    await this.dispatch(transport, request, reply);
  }

  private release(sessionId: string, reason: CloseReason): void {
    const record = this.deps.sessions.close(sessionId);
    this.live.delete(sessionId);
    if (record === undefined) return;
    this.deps.audit.record({
      type: 'session.closed',
      outcome: 'success',
      agentId: record.agentId,
      sessionId,
      reason,
    });
  }

  private async dispatch(
    transport: StreamableHTTPServerTransport,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      this.deps.logger.error({ err: error }, 'MCP transport failure');
      if (reply.raw.headersSent) {
        reply.raw.end();
        return;
      }
      const body = toErrorBody(new GatewayError('internal_error', 'MCP transport failure'), request.id);
      reply.raw.writeHead(500, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify(body));
    }
  }
}
