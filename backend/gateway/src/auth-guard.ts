import { RateLimiter, clientKey, type AuditLog } from '@arp/security';
import { GatewayError } from '@arp/shared';

export const AUTH_FAILURE_WINDOW_MS = 15 * 60_000;

/**
 * Locks a client out after repeated failed authentications. Clients are keyed with clientKey,
 * so an IPv6 client cannot escape the lockout by switching addresses inside its /64. The lockout is checked
 * before the credential is compared, so guessing a token stops working once the limit is hit.
 */
export class AuthFailureGuard {
  private readonly limiter: RateLimiter;
  private readonly audit: AuditLog;

  constructor(limit: number, audit: AuditLog, now?: () => number) {
    this.limiter = new RateLimiter({
      limit,
      windowMs: AUTH_FAILURE_WINDOW_MS,
      ...(now === undefined ? {} : { now }),
    });
    this.audit = audit;
  }

  assertAllowed(address: string, requestId: string): void {
    const decision = this.limiter.peek(clientKey(address));
    if (decision.allowed) return;
    this.audit.record({
      type: 'auth.failed',
      outcome: 'denied',
      errorCode: 'rate_limited',
      requestId,
    });
    throw new GatewayError('rate_limited', 'Too many failed authentication attempts', {
      retryAfterSeconds: decision.retryAfterSeconds,
    });
  }

  recordFailure(address: string, requestId: string): void {
    this.limiter.hit(clientKey(address));
    this.audit.record({
      type: 'auth.failed',
      outcome: 'denied',
      errorCode: 'unauthorized',
      requestId,
    });
  }
}
