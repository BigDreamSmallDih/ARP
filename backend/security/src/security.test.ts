import { describe, expect, it, vi } from 'vitest';
import { GatewayError } from '@arp/shared';
import {
  AuditLog,
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
