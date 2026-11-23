import { describe, expect, it } from 'vitest';
import { AuditLog } from '@arp/security';
import { GatewayError } from '@arp/shared';
import { AUTH_FAILURE_WINDOW_MS, AuthFailureGuard } from './auth-guard';

function setup(limit = 2) {
  let now = 0;
  const audit = new AuditLog(50);
  const guard = new AuthFailureGuard(limit, audit, () => now);
  return {
    guard,
    audit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('AuthFailureGuard', () => {
  it('allows a client until it reaches the failure limit', () => {
    const { guard } = setup();
    guard.assertAllowed('1.1.1.1', 'r1');
    guard.recordFailure('1.1.1.1', 'r1');
    guard.assertAllowed('1.1.1.1', 'r2');
    guard.recordFailure('1.1.1.1', 'r2');

    expect(() => guard.assertAllowed('1.1.1.1', 'r3')).toThrow(GatewayError);
    expect(() => guard.assertAllowed('2.2.2.2', 'r4')).not.toThrow();
  });

  it('reports how long the lockout lasts', () => {
    const { guard, advance } = setup(1);
    guard.recordFailure('1.1.1.1', 'r1');
    advance(60_000);

    const failure = (() => {
      try {
        guard.assertAllowed('1.1.1.1', 'r2');
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: (AUTH_FAILURE_WINDOW_MS - 60_000) / 1000,
    });
  });

  it('lifts the lockout when the window has passed', () => {
    const { guard, advance } = setup(1);
    guard.recordFailure('1.1.1.1', 'r1');
    advance(AUTH_FAILURE_WINDOW_MS);
    expect(() => guard.assertAllowed('1.1.1.1', 'r2')).not.toThrow();
  });

  it('treats every address in one IPv6 /64 as the same client', () => {
    const { guard } = setup(2);
    guard.recordFailure('2001:db8:1:2::1', 'r1');
    guard.recordFailure('2001:db8:1:2:ffff:eeee:dddd:cccc', 'r2');

    expect(() => guard.assertAllowed('2001:db8:1:2:1::9', 'r3')).toThrow(GatewayError);
    expect(() => guard.assertAllowed('2001:db8:1:3::1', 'r4')).not.toThrow();
  });

  it('audits failures and lockouts without recording the client address', () => {
    const { guard, audit } = setup(1);
    guard.recordFailure('203.0.113.9', 'r1');
    expect(() => guard.assertAllowed('203.0.113.9', 'r2')).toThrow();

    const events = audit.recent();
    expect(events.map((event) => event.errorCode)).toEqual(['rate_limited', 'unauthorized']);
    expect(JSON.stringify(events)).not.toContain('203.0.113.9');
  });
});
