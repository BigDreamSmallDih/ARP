import { describe, expect, it } from 'vitest';
import { GatewayError } from '@arp/shared';
import { SessionStore } from './session-store';

function setup(options: { maxSessions?: number; idleTtlMs?: number } = {}) {
  let now = 1_000_000;
  const store = new SessionStore({
    maxSessions: options.maxSessions ?? 2,
    idleTtlMs: options.idleTtlMs ?? 10_000,
    now: () => now,
  });
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('SessionStore', () => {
  it('creates sessions and reports their status', () => {
    const { store } = setup();
    store.create('s1', 'claude');

    expect(store.get('s1')).toMatchObject({ id: 's1', agentId: 'claude', requestCount: 0 });
    expect(store.status('s1')).toMatchObject({
      sessionId: 's1',
      agentId: 'claude',
      requestCount: 0,
    });
    expect(store.activeCount()).toBe(1);
  });

  it('counts requests and slides the expiry window on touch', () => {
    const { store, advance } = setup();
    store.create('s1', 'claude');
    advance(6_000);
    store.touch('s1');
    advance(6_000);

    expect(store.get('s1')).toBeDefined();
    expect(store.status('s1')?.requestCount).toBe(1);
    expect(Date.parse(store.status('s1')?.expiresAt ?? '') - Date.parse(store.status('s1')?.lastSeenAt ?? '')).toBe(
      10_000,
    );
  });

  it('treats a session idle past the TTL as gone', () => {
    const { store, advance } = setup();
    store.create('s1', 'claude');
    advance(10_001);

    expect(store.get('s1')).toBeUndefined();
    expect(store.status('s1')).toBeUndefined();
    expect(store.activeCount()).toBe(0);
  });

  it('does not extend an expired session when touched', () => {
    const { store, advance } = setup();
    store.create('s1', 'claude');
    advance(10_001);
    store.touch('s1');
    expect(store.get('s1')).toBeUndefined();
  });

  it('sweeps expired sessions and returns them to the caller', () => {
    const { store, advance } = setup();
    store.create('old', 'claude');
    advance(8_000);
    store.create('fresh', 'chatgpt');
    advance(3_000);

    const swept = store.sweepExpired();
    expect(swept.map((record) => record.id)).toEqual(['old']);
    expect(store.get('fresh')).toBeDefined();
    expect(store.sweepExpired()).toEqual([]);
  });

  it('enforces the session limit but frees capacity from expired sessions', () => {
    const { store, advance } = setup({ maxSessions: 1 });
    store.create('s1', 'claude');

    expect(() => store.assertCapacity()).toThrow(GatewayError);
    try {
      store.assertCapacity();
    } catch (error) {
      expect((error as GatewayError).code).toBe('session_limit_reached');
    }

    advance(10_001);
    expect(() => store.assertCapacity()).not.toThrow();
  });

  it('closes a session and returns its record once', () => {
    const { store } = setup();
    store.create('s1', 'claude');

    expect(store.close('s1')).toMatchObject({ id: 's1', agentId: 'claude' });
    expect(store.close('s1')).toBeUndefined();
    expect(store.get('s1')).toBeUndefined();
  });
});
