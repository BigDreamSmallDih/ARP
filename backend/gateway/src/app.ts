import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENT_ROSTER, AgentRegistry, createProviderAdapters, type FetchLike } from '@arp/agents';
import { TOOLS } from '@arp/mcp';
import {
  AuditLog,
  RateLimiter,
  clientKey,
  digestToken,
  extractBearerToken,
  matchesDigest,
} from '@arp/security';
import {
  GATEWAY_VERSION,
  GatewayError,
  ProviderIdSchema,
  toErrorBody,
  type Health,
} from '@arp/shared';
import { AuthFailureGuard } from './auth-guard';
import type { GatewayConfig } from './config';
import { McpGateway } from './mcp-gateway';
import { toRequestError } from './request-error';
import { createGatewayServices, uptimeSeconds } from './services';
import { SessionStore } from './session-store';

export interface Gateway {
  readonly app: FastifyInstance;
  readonly sessions: SessionStore;
  readonly audit: AuditLog;
  /** Closes sessions idle past their TTL. Also runs on a timer once the app is ready. */
  sweepExpiredSessions(): void;
}

const ProviderParamsSchema = z.object({ id: ProviderIdSchema });

const AuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});

export interface GatewayOptions {
  /** Replaces the global fetch used for provider calls; tests inject a fake. */
  readonly fetchImpl?: FetchLike;
  /** Receives the structured log lines instead of stdout; used by tests that inspect the log. */
  readonly logStream?: { write(line: string): void };
}

export async function createGateway(
  config: GatewayConfig,
  options: GatewayOptions = {},
): Promise<Gateway> {
  const loggerOptions = {
    level: config.environment === 'test' ? 'silent' : config.logLevel,
    redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-goog-api-key"]'],
    ...(options.logStream === undefined ? {} : { stream: options.logStream }),
  };
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: config.bodyLimitBytes,
    // Only a proxy on this host is believed about X-Forwarded-For; the rightmost untrusted hop wins.
    trustProxy: config.trustProxy ? 'loopback' : false,
    forceCloseConnections: true,
  });

  const startedAt = new Date();
  const audit = new AuditLog(config.auditBufferSize, (event) => {
    app.log.info({ audit: event }, 'audit');
  });
  const sessions = new SessionStore({
    maxSessions: config.sessions.max,
    maxSessionsPerAgent: config.sessions.maxPerAgent,
    idleTtlMs: config.sessions.idleTtlSeconds * 1000,
  });
  const adapters = createProviderAdapters(config.providers, options.fetchImpl);
  const agents = new AgentRegistry(AGENT_ROSTER, config.agentTokens, adapters);
  const providerLimiter = new RateLimiter({ limit: config.limits.providerCallsPerMinute, windowMs: 60_000 });
  const services = createGatewayServices({
    config,
    agents,
    adapters,
    sessions,
    startedAt,
    tools: TOOLS,
    providerLimiter,
  });
  const authGuard = new AuthFailureGuard(config.limits.authFailures, audit);
  const mcp = new McpGateway({ sessions, agents, services, audit, authGuard, logger: app.log });
  const requestLimiter = new RateLimiter({ limit: config.limits.requestsPerMinute, windowMs: 60_000 });

  const dashboardOrigin = config.dashboardOrigin;
  if (dashboardOrigin !== undefined) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.headers.origin !== dashboardOrigin) return;
      reply.header('access-control-allow-origin', dashboardOrigin).header('vary', 'Origin');
      if (request.method === 'OPTIONS') {
        return reply
          .header('access-control-allow-methods', 'GET, OPTIONS')
          .header('access-control-allow-headers', 'authorization, content-type')
          .header('access-control-max-age', '600')
          .code(204)
          .send();
      }
    });
  }

  app.addHook('onRequest', async (request) => {
    if (request.url === '/health') return;
    const decision = requestLimiter.hit(clientKey(request.ip));
    if (!decision.allowed) {
      throw new GatewayError('rate_limited', 'Too many requests', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    }
  });

  app.addHook('onReady', async () => {
    mcp.startSweeper(Math.min(60_000, (config.sessions.idleTtlSeconds * 1000) / 2));
  });
  app.addHook('onClose', async () => {
    await mcp.shutdown();
  });

  app.setErrorHandler((error: Error, request, reply) => {
    const failure = toRequestError(error);
    if (failure.code === 'internal_error') {
      request.log.error({ err: error }, 'Unhandled request error');
    }
    if (failure.code === 'unauthorized') reply.header('www-authenticate', 'Bearer');
    if (failure.retryAfterSeconds !== undefined) {
      reply.header('retry-after', String(failure.retryAfterSeconds));
    }
    return reply.code(failure.httpStatus).send(toErrorBody(failure, request.id));
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .code(404)
      .send(toErrorBody(new GatewayError('not_found', 'Route not found'), request.id)),
  );

  app.get('/health', async (): Promise<Health> => ({
    status: 'ok',
    version: GATEWAY_VERSION,
    uptimeSeconds: uptimeSeconds(startedAt),
    timestamp: new Date().toISOString(),
  }));

  mcp.register(app);

  const adminDigest = config.adminToken === undefined ? undefined : digestToken(config.adminToken);

  await app.register(
    async (api) => {
      api.addHook('onRequest', async (request) => {
        if (adminDigest === undefined) {
          throw new GatewayError(
            'admin_not_configured',
            'GATEWAY_ADMIN_TOKEN is not set, so the admin API is disabled',
          );
        }
        authGuard.assertAllowed(request.ip, request.id);
        const token = extractBearerToken(request.headers.authorization);
        if (token === undefined || !matchesDigest(token, adminDigest)) {
          authGuard.recordFailure(request.ip, request.id);
          throw new GatewayError('unauthorized', 'Missing or invalid admin credential');
        }
      });

      api.get('/status', async () => services.getSystemStatus());
      api.get('/agents', async () => ({ agents: services.listAgents() }));
      api.get('/gateway', async () => services.getGatewayInfo());
      api.post('/providers/:id/verify', async (request) => {
        const { id } = ProviderParamsSchema.parse(request.params);
        const adapter = adapters[id];
        await adapter.verify();
        return { provider: adapter.status() };
      });
      api.get('/audit', async (request) => {
        const { limit } = AuditQuerySchema.parse(request.query);
        return { events: audit.recent(limit) };
      });
    },
    { prefix: '/api' },
  );

  return { app, sessions, audit, sweepExpiredSessions: () => mcp.sweepExpired() };
}
