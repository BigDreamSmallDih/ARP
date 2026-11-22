import { describe, expect, it } from 'vitest';
import { ProviderStateSchema } from '@arp/shared';
import type { ConnectionState } from './api/snapshot';
import { componentPresentation, connectionNotice, credentialPresentation, providerPresentation } from './present';
import { formatUptime } from './format';

describe('provider presentation', () => {
  it('shows an unconfigured provider as unconfigured', () => {
    expect(providerPresentation('unconfigured')).toEqual({ tone: 'muted', label: 'Unconfigured' });
  });

  it('never presents any provider state as connected or healthy', () => {
    for (const state of ProviderStateSchema.options) {
      const { tone, label } = providerPresentation(state);
      expect(label).not.toMatch(/connected|online|ready|active/i);
      expect(tone).not.toBe('ok');
    }
  });

  it('describes a present key as not verified', () => {
    expect(providerPresentation('configured').label).toMatch(/not verified/i);
  });
});

describe('credential and component presentation', () => {
  it('distinguishes set from missing credentials', () => {
    expect(credentialPresentation('configured').label).toBe('Token set');
    expect(credentialPresentation('missing').label).toBe('No token');
  });

  it('shows configuration, not operation, for components', () => {
    expect(componentPresentation('configured').label).toBe('Configured');
    expect(componentPresentation('unconfigured').label).toBe('Unconfigured');
  });
});

describe('connectionNotice', () => {
  const states: ConnectionState[] = [
    { kind: 'unreachable', message: 'The gateway could not be reached' },
    { kind: 'needs_token' },
    { kind: 'unauthorized' },
    { kind: 'admin_disabled' },
    { kind: 'error', message: 'Internal error' },
  ];

  it.each(states)('explains $kind', (state) => {
    const notice = connectionNotice(state);
    expect(notice?.title).toBeTruthy();
    expect(notice?.body).toBeTruthy();
  });

  it('shows nothing while loading or when ready', () => {
    expect(connectionNotice({ kind: 'loading' })).toBeUndefined();
    expect(connectionNotice({ kind: 'ready' })).toBeUndefined();
  });

  it('includes the failure message for an unreachable gateway', () => {
    expect(connectionNotice(states[0] as ConnectionState)?.body).toContain('could not be reached');
  });
});

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [59, '59s'],
    [61, '1m 1s'],
    [3600, '1h 0m'],
    [3 * 3600 + 25 * 60, '3h 25m'],
    [2 * 86400 + 5 * 3600, '2d 5h'],
    [-5, '0s'],
    [12.9, '12s'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatUptime(seconds)).toBe(expected);
  });
});
