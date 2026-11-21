import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ErrorCodeSchema,
  GATEWAY_VERSION,
  GatewayError,
  ProviderStateSchema,
  SystemStatusSchema,
  toErrorBody,
  toGatewayError,
} from './index';

describe('GatewayError', () => {
  it.each([
    ['invalid_request', 400],
    ['unauthorized', 401],
    ['forbidden', 403],
    ['permission_denied', 403],
    ['not_found', 404],
    ['session_not_found', 404],
    ['session_limit_reached', 503],
    ['not_implemented', 501],
    ['admin_not_configured', 503],
    ['internal_error', 500],
  ] as const)('maps %s to HTTP %i', (code, status) => {
    expect(new GatewayError(code, 'message').httpStatus).toBe(status);
  });

  it('has an HTTP status for every declared error code', () => {
    for (const code of ErrorCodeSchema.options) {
      expect(new GatewayError(code, 'message').httpStatus).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('toErrorBody', () => {
  it('includes details only for invalid_request', () => {
    const details = [{ path: ['provider'] }];
    const invalid = toErrorBody(new GatewayError('invalid_request', 'bad', { details }), 'req-1');
    expect(invalid.error).toEqual({
      code: 'invalid_request',
      message: 'bad',
      requestId: 'req-1',
      details,
    });

    const internal = toErrorBody(new GatewayError('internal_error', 'boom', { details }));
    expect(internal.error).toEqual({ code: 'internal_error', message: 'boom' });
  });
});

describe('toGatewayError', () => {
  it('returns gateway errors unchanged', () => {
    const error = new GatewayError('not_found', 'missing');
    expect(toGatewayError(error)).toBe(error);
  });

  it('wraps unknown errors without leaking their message', () => {
    const cause = new Error('database password is hunter2');
    const wrapped = toGatewayError(cause);
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).not.toContain('hunter2');
    expect(wrapped.cause).toBe(cause);
  });
});

describe('provider state', () => {
  it('has no connected state because Phase 1 never calls providers', () => {
    expect(ProviderStateSchema.options).toEqual(['unconfigured', 'configured']);
    expect(ProviderStateSchema.safeParse('connected').success).toBe(false);
  });
});

describe('SystemStatusSchema', () => {
  it('rejects a Roblox state other than not_integrated', () => {
    const base = {
      version: '0.1.0',
      environment: 'test',
      startedAt: new Date().toISOString(),
      uptimeSeconds: 1,
      nodeVersion: 'v20.0.0',
      components: { adminApi: 'configured', supabase: 'unconfigured', roblox: 'connected' },
      providers: [],
      sessions: { active: 0, max: 10 },
      toolCount: 4,
      warnings: [],
    };
    expect(SystemStatusSchema.safeParse(base).success).toBe(false);
  });
});

describe('GATEWAY_VERSION', () => {
  it('matches the shared package version', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(GATEWAY_VERSION).toBe(manifest.version);
  });
});
