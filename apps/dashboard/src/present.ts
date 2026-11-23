import type { ComponentState, ProviderState } from '@arp/shared';
import type { ConnectionState } from './api/snapshot';

export type Tone = 'ok' | 'info' | 'warn' | 'danger' | 'muted';

export interface Presentation {
  readonly tone: Tone;
  readonly label: string;
}

/** "Connected" is shown only when the gateway reports a successful authenticated provider call. */
export function providerPresentation(state: ProviderState): Presentation {
  switch (state) {
    case 'unconfigured':
      return { tone: 'muted', label: 'Unconfigured' };
    case 'configured':
      return { tone: 'info', label: 'Key set, not verified' };
    case 'connecting':
      return { tone: 'info', label: 'Connecting' };
    case 'connected':
      return { tone: 'ok', label: 'Connected' };
    case 'error':
      return { tone: 'danger', label: 'Last call failed' };
  }
}

export function credentialPresentation(state: 'configured' | 'missing'): Presentation {
  return state === 'configured'
    ? { tone: 'info', label: 'Token set' }
    : { tone: 'muted', label: 'No token' };
}

export function componentPresentation(state: ComponentState): Presentation {
  return state === 'configured'
    ? { tone: 'info', label: 'Configured' }
    : { tone: 'muted', label: 'Unconfigured' };
}

export interface ConnectionNotice {
  readonly tone: Tone;
  readonly title: string;
  readonly body: string;
}

export function connectionNotice(connection: ConnectionState): ConnectionNotice | undefined {
  switch (connection.kind) {
    case 'loading':
    case 'ready':
      return undefined;
    case 'unreachable':
      return {
        tone: 'danger',
        title: 'Gateway unreachable',
        body: `${connection.message}. Check the gateway URL in Settings and that the gateway is running.`,
      };
    case 'needs_token':
      return {
        tone: 'info',
        title: 'Admin token required',
        body: 'Enter the gateway admin token in Settings to load agents, sessions and audit events. The public health check works without it.',
      };
    case 'unauthorized':
      return {
        tone: 'danger',
        title: 'Admin token rejected',
        body: 'The gateway refused the admin token. Check it in Settings.',
      };
    case 'admin_disabled':
      return {
        tone: 'warn',
        title: 'Admin API disabled',
        body: 'The gateway has no GATEWAY_ADMIN_TOKEN set, so it serves no dashboard data. Set it and restart the gateway.',
      };
    case 'error':
      return { tone: 'danger', title: 'Unexpected gateway response', body: connection.message };
  }
}
