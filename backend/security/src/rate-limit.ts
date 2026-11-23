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
    this.now = options.now ?? Date.now;
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
