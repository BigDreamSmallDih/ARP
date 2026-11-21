import { randomUUID } from 'node:crypto';
import type { AuditEvent } from '@arp/shared';

export type AuditEventInput = Omit<AuditEvent, 'id' | 'timestamp'>;
export type AuditListener = (event: AuditEvent) => void;

/** In-memory and bounded; the listener lets the gateway also write each event to its log. */
export class AuditLog {
  private readonly capacity: number;
  private readonly listener: AuditListener | undefined;
  private readonly events: AuditEvent[] = [];

  constructor(capacity: number, listener?: AuditListener) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('AuditLog capacity must be a positive integer');
    }
    this.capacity = capacity;
    this.listener = listener;
  }

  record(input: AuditEventInput): AuditEvent {
    const event: AuditEvent = {
      ...input,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    if (this.events.length > this.capacity) this.events.shift();
    this.listener?.(event);
    return event;
  }

  /** Newest first. */
  recent(limit = 100): AuditEvent[] {
    if (limit <= 0) return [];
    return this.events.slice(-limit).reverse();
  }
}
