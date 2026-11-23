import { isIPv6 } from 'node:net';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  /** Bounds memory; the oldest key is evicted once expired entries are gone. */
  readonly maxKeys?: number;
  /** Milliseconds on a clock that never moves backwards. Defaults to performance.now. */
  readonly now?: () => number;
}

interface Window {
  start: number;
  count: number;
}

/** Fixed-window counter per key. */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private readonly windows = new Map<string, Window>();

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError('RateLimiter limit must be a positive integer');
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new RangeError('RateLimiter windowMs must be a positive integer');
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? (() => performance.now());
  }

  /** Counts one request against the key. */
  hit(key: string): RateLimitDecision {
    const now = this.now();
    let window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      window = { start: now, count: 0 };
      this.store(key, window, now);
    }
    if (window.count >= this.limit) return this.decision(window, now);
    window.count += 1;
    return { allowed: true, remaining: this.limit - window.count, retryAfterSeconds: 0 };
  }

  /** Reports the state of the key without counting a request. */
  peek(key: string): RateLimitDecision {
    const now = this.now();
    const window = this.windows.get(key);
    if (window === undefined || now - window.start >= this.windowMs) {
      return { allowed: true, remaining: this.limit, retryAfterSeconds: 0 };
    }
    return this.decision(window, now);
  }

  private decision(window: Window, now: number): RateLimitDecision {
    const allowed = window.count < this.limit;
    return {
      allowed,
      remaining: Math.max(0, this.limit - window.count),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000)),
    };
  }

  private store(key: string, window: Window, now: number): void {
    this.windows.delete(key);
    if (this.windows.size >= this.maxKeys) {
      for (const [other, entry] of this.windows) {
        if (now - entry.start >= this.windowMs) this.windows.delete(other);
      }
      const oldest = this.windows.keys().next();
      if (this.windows.size >= this.maxKeys && !oldest.done) this.windows.delete(oldest.value);
    }
    this.windows.set(key, window);
  }
}

/** The eight 16-bit groups of an IPv6 address in any notation, or undefined if it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  const bare = address.split('%')[0] ?? address;
  if (!isIPv6(bare)) return undefined;

  // A dotted IPv4 tail is two groups, not one.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  let text = bare;
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = dotted.slice(1).map(Number);
    text = `${bare.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const fill = tail === undefined ? 0 : Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((group) =>
    Number.parseInt(group, 16),
  );
  return groups.length === 8 ? groups : undefined;
}

/**
 * Maps a client address to its rate-limit key. An IPv6 client usually controls a whole /64, so
 * keying by full address would let it rotate addresses to dodge limits and lockouts. An
 * IPv4-mapped address (::ffff:a.b.c.d, in any notation) is keyed as that IPv4 address.
 */
export function clientKey(address: string): string {
  const groups = ipv6Groups(address);
  if (groups === undefined) return address;

  const [g0, g1, g2, g3, g4, g5, high = 0, low = 0] = groups;
  if ([g0, g1, g2, g3, g4].every((group) => group === 0) && g5 === 0xffff) {
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return `${[g0, g1, g2, g3].map((group) => (group ?? 0).toString(16)).join(':')}::/64`;
}
