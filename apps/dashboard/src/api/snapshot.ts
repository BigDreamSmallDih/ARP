import type { AgentSummary, AuditEvent, GatewayInfo, Health, SystemStatus } from '@arp/shared';
import { ApiError, NetworkError, type GatewayClient } from './client';

export type ConnectionState =
  | { kind: 'loading' }
  | { kind: 'unreachable'; message: string }
  | { kind: 'needs_token' }
  | { kind: 'unauthorized' }
  | { kind: 'admin_disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'ready' };

export interface Snapshot {
  readonly connection: ConnectionState;
  readonly health?: Health;
  readonly status?: SystemStatus;
  readonly agents?: AgentSummary[];
  readonly gateway?: GatewayInfo;
  readonly audit?: AuditEvent[];
  readonly refreshedAt?: Date;
}

export const INITIAL_SNAPSHOT: Snapshot = { connection: { kind: 'loading' } };

function describeFailure(error: unknown): ConnectionState {
  if (error instanceof NetworkError) return { kind: 'unreachable', message: error.message };
  if (error instanceof ApiError) {
    if (error.code === 'unauthorized') return { kind: 'unauthorized' };
    if (error.code === 'admin_not_configured') return { kind: 'admin_disabled' };
    return { kind: 'error', message: error.message };
  }
  return { kind: 'error', message: error instanceof Error ? error.message : 'Unknown error' };
}

/**
 * Runs the public health check first, so a reachable gateway is distinguishable from
 * missing or rejected admin credentials. Nothing carries over from earlier snapshots.
 */
export async function loadSnapshot(client: GatewayClient, now: () => Date = () => new Date()): Promise<Snapshot> {
  let health: Health;
  try {
    health = await client.health();
  } catch (error) {
    return { connection: describeFailure(error), refreshedAt: now() };
  }

  if (!client.hasToken) {
    return { connection: { kind: 'needs_token' }, health, refreshedAt: now() };
  }

  try {
    const [status, agents, gateway, audit] = await Promise.all([
      client.status(),
      client.agents(),
      client.gateway(),
      client.audit(50),
    ]);
    return { connection: { kind: 'ready' }, health, status, agents, gateway, audit, refreshedAt: now() };
  } catch (error) {
    return { connection: describeFailure(error), health, refreshedAt: now() };
  }
}
