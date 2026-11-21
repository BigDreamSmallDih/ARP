import { GatewayError, type SessionStatus } from '@arp/shared';

export interface SessionRecord {
  readonly id: string;
  readonly agentId: string;
  readonly createdAt: number;
  lastSeenAt: number;
  requestCount: number;
}

export interface SessionStoreOptions {
  readonly maxSessions: number;
  readonly idleTtlMs: number;
  readonly now?: () => number;
}

/** A session expires after idleTtlMs without a request; the caller closes the transports of swept sessions. */
export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxSessions: number;
  private readonly idleTtlMs: number;
  private readonly now: () => number;

  constructor(options: SessionStoreOptions) {
    this.maxSessions = options.maxSessions;
    this.idleTtlMs = options.idleTtlMs;
    this.now = options.now ?? Date.now;
  }

  activeCount(): number {
    let active = 0;
    for (const record of this.sessions.values()) {
      if (!this.isExpired(record)) active += 1;
    }
    return active;
  }

  assertCapacity(): void {
    if (this.activeCount() >= this.maxSessions) {
      throw new GatewayError(
        'session_limit_reached',
        `The gateway already has the maximum of ${this.maxSessions} active sessions`,
      );
    }
  }

  create(id: string, agentId: string): SessionRecord {
    const now = this.now();
    const record: SessionRecord = { id, agentId, createdAt: now, lastSeenAt: now, requestCount: 0 };
    this.sessions.set(id, record);
    return record;
  }

  /** Returns undefined for unknown and for expired sessions. */
  get(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    return record === undefined || this.isExpired(record) ? undefined : record;
  }

  touch(id: string): void {
    const record = this.get(id);
    if (record === undefined) return;
    record.lastSeenAt = this.now();
    record.requestCount += 1;
  }

  close(id: string): SessionRecord | undefined {
    const record = this.sessions.get(id);
    this.sessions.delete(id);
    return record;
  }

  sweepExpired(): SessionRecord[] {
    const expired: SessionRecord[] = [];
    for (const record of this.sessions.values()) {
      if (this.isExpired(record)) expired.push(record);
    }
    for (const record of expired) this.sessions.delete(record.id);
    return expired;
  }

  status(id: string): SessionStatus | undefined {
    const record = this.get(id);
    if (record === undefined) return undefined;
    return {
      sessionId: record.id,
      agentId: record.agentId,
      createdAt: new Date(record.createdAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(),
      expiresAt: new Date(record.lastSeenAt + this.idleTtlMs).toISOString(),
      requestCount: record.requestCount,
    };
  }

  private isExpired(record: SessionRecord): boolean {
    return this.now() - record.lastSeenAt > this.idleTtlMs;
  }
}
