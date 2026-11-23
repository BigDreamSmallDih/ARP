import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '@arp/shared';
import {
  AuditLog,
  RateLimiter,
  Secret,
  clientKey,
  assertPermission,
  digestToken,
  extractBearerToken,
  hasPermission,
  matchesDigest,
} from './index';

describe('tokens', () => {
  it('matches only the exact token', () => {
    const digest = digestToken('correct-token');
    expect(matchesDigest('correct-token', digest)).toBe(true);
    expect(matchesDigest('correct-token ', digest)).toBe(false);
    expect(matchesDigest('', digest)).toBe(false);
  });

  it('does not keep the token inside the digest', () => {
    const digest = digestToken('plain-secret-value');
    expect(digest.toString('utf8')).not.toContain('plain-secret-value');
    expect(digest).toHaveLength(32);
  });

  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['Bearer', undefined],
    ['Bearer a b', undefined],
    ['Basic abc123', undefined],
    [undefined, undefined],
  ])('extracts a bearer token from %j', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });
});

describe('permissions', () => {
  it('grants only listed permissions', () => {
    expect(hasPermission(['system:read'], 'system:read')).toBe(true);
    expect(hasPermission(['system:read'], 'agents:read')).toBe(false);
  });

  it('throws a permission_denied error naming the agent and permission', () => {
    expect(() => assertPermission('claude', [], 'agents:read')).toThrow(GatewayError);
    try {
      assertPermission('claude', [], 'agents:read');
    } catch (error) {
      expect((error as GatewayError).code).toBe('permission_denied');
      expect((error as GatewayError).message).toContain('claude');
      expect((error as GatewayError).message).toContain('agents:read');
    }
  });
});

describe('AuditLog', () => {
  it('assigns an id and timestamp and returns events newest first', () => {
    const log = new AuditLog(10);
    const first = log.record({ type: 'session.created', outcome: 'success', agentId: 'claude' });
    log.record({ type: 'tool.call', outcome: 'success', agentId: 'claude', tool: 'get_gateway_info' });

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(first.timestamp))).toBe(false);
    expect(log.recent().map((event) => event.type)).toEqual(['tool.call', 'session.created']);
  });

  it('drops the oldest events beyond its capacity', () => {
    const log = new AuditLog(2);
    for (const tool of ['a', 'b', 'c']) {
      log.record({ type: 'tool.call', outcome: 'success', tool });
    }
    expect(log.recent().map((event) => event.tool)).toEqual(['c', 'b']);
  });

  it('honours the limit argument', () => {
    const log = new AuditLog(5);
    for (const tool of ['a', 'b', 'c']) {
      log.record({ type: 'tool.call', outcome: 'success', tool });
    }
    expect(log.recent(1).map((event) => event.tool)).toEqual(['c']);
    expect(log.recent(0)).toEqual([]);
  });

  it('keeps failed authentications in their own smaller buffer', () => {
    const log = new AuditLog(8);
    log.record({ type: 'session.created', outcome: 'success', agentId: 'claude' });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      log.record({ type: 'auth.failed', outcome: 'denied', errorCode: 'unauthorized' });
    }

    const events = log.recent(100);
    expect(events.filter((event) => event.type === 'auth.failed')).toHaveLength(2);
    expect(events.some((event) => event.type === 'session.created')).toBe(true);
  });

  it('orders events from both buffers by when they were recorded', () => {
    const log = new AuditLog(8);
    log.record({ type: 'tool.call', outcome: 'success', tool: 'first' });
    log.record({ type: 'auth.failed', outcome: 'denied', errorCode: 'unauthorized' });
    log.record({ type: 'tool.call', outcome: 'success', tool: 'third' });

    expect(log.recent().map((event) => event.tool ?? event.type)).toEqual([
      'third',
      'auth.failed',
      'first',
    ]);
    expect(log.recent(2)).toHaveLength(2);
  });

  it('notifies the listener for every recorded event', () => {
    const listener = vi.fn();
    const log = new AuditLog(5, listener);
    const event = log.record({ type: 'auth.failed', outcome: 'denied', errorCode: 'unauthorized' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(event);
  });

  it('rejects an invalid capacity', () => {
    expect(() => new AuditLog(0)).toThrow(RangeError);
    expect(() => new AuditLog(1.5)).toThrow(RangeError);
  });
});

describe('Secret', () => {
  const value = 'sk-test-secret-value-1234567890';

  it('returns the value only through reveal()', () => {
    expect(new Secret(value).reveal()).toBe(value);
  });

  it.each([
    ['JSON.stringify', (secret: Secret) => JSON.stringify({ secret })],
    ['string interpolation', (secret: Secret) => `${secret.toString()}`],
    ['template literal', (secret: Secret) => `key=${String(secret)}`],
    ['util.inspect', (secret: Secret) => inspect({ secret }, { depth: 5 })],
  ])('does not reveal the value through %s', (_name, render) => {
    expect(render(new Secret(value))).not.toContain(value);
  });

  it('does not expose the value as an enumerable property', () => {
    expect(Object.keys(new Secret(value))).toEqual([]);
    expect(JSON.stringify(Object.entries(new Secret(value)))).not.toContain(value);
  });
});

describe('RateLimiter', () => {
  function setup(limit = 3, windowMs = 60_000, maxKeys?: number) {
    let now = 0;
    const limiter = new RateLimiter({
      limit,
      windowMs,
      now: () => now,
      ...(maxKeys === undefined ? {} : { maxKeys }),
    });
    return {
      limiter,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('allows up to the limit and then reports when to retry', () => {
    const { limiter, advance } = setup();
    advance(10_000);
    expect([1, 2, 3].map(() => limiter.hit('a').allowed)).toEqual([true, true, true]);

    const denied = limiter.hit('a');
    expect(denied).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 60 });
  });

  it('starts a new window once the old one has passed', () => {
    const { limiter, advance } = setup(1, 1_000);
    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    advance(1_000);
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('tracks each key separately', () => {
    const { limiter } = setup(1);
    limiter.hit('a');
    expect(limiter.hit('a').allowed).toBe(false);
    expect(limiter.hit('b').allowed).toBe(true);
  });

  it('peek reports state without counting a request', () => {
    const { limiter } = setup(1);
    expect(limiter.peek('a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.peek('a').allowed).toBe(true);
    limiter.hit('a');
    expect(limiter.peek('a').allowed).toBe(false);
  });

  it('keeps memory bounded by evicting the oldest key', () => {
    const { limiter } = setup(1, 60_000, 2);
    limiter.hit('a');
    limiter.hit('b');
    limiter.hit('c');
    expect(limiter.peek('a').allowed).toBe(true);
    expect(limiter.peek('c').allowed).toBe(false);
  });

  it('rejects invalid options', () => {
    expect(() => new RateLimiter({ limit: 0, windowMs: 1000 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe('clientKey', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7'.toUpperCase(), '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
  ])('maps %s to %s', (address, expected) => {
    expect(clientKey(address)).toBe(expected);
  });

  it('gives every address in one /64 the same key and other prefixes different keys', () => {
    expect(clientKey('2001:db8:1:2:1111:2222:3333:4444')).toBe(clientKey('2001:db8:1:2:ffff::9'));
    expect(clientKey('2001:db8:1:3::1')).not.toBe(clientKey('2001:db8:1:2::1'));
  });

  it('leaves a value that is not an address unchanged', () => {
    expect(clientKey('unknown')).toBe('unknown');
  });
});
