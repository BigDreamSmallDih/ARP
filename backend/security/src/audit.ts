import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@arp/shared';

export type AuditEventInput = Omit<AuditEvent, 'id' | 'timestamp'>;
export type AuditListener = (event: AuditEvent) => void;

interface Entry {
  readonly sequence: number;
  readonly event: AuditEvent;
}

/**
 * In-memory and bounded; the listener lets the gateway also write each event to its log.
 * Failed authentications use a separate, smaller buffer so unauthenticated traffic cannot
 * push other events out.
 */
export class AuditLog {
  private readonly capacity: number;
  private readonly failureCapacity: number;
  private readonly listener: AuditListener | undefined;
  private readonly events: Entry[] = [];
  private readonly failures: Entry[] = [];
  private sequence = 0;

  constructor(capacity: number, listener?: AuditListener) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('AuditLog capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.failureCapacity = Math.max(1, Math.floor(capacity / 4));
    this.listener = listener;
  }

  record(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    const entry: Entry = { sequence: this.sequence, event };
    this.sequence += 1;

    if (event.type === 'auth.failed') {
      this.failures.push(entry);
      if (this.failures.length > this.failureCapacity) this.failures.shift();
    } else {
      this.events.push(entry);
      if (this.events.length > this.capacity) this.events.shift();
    }

    this.listener?.(event);
    return event;
  }

  /** Newest first. */
  recent(limit = 100): AuditEvent[] {
    if (limit <= 0) return [];
    return [...this.events, ...this.failures]
      .sort((a, b) => b.sequence - a.sequence)
      .slice(0, limit)
      .map((entry) => entry.event);
  }
}
