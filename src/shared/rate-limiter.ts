/**
 * Production-grade rate limiting implementation.
 * Supports multiple strategies: token bucket, sliding window, and fixed window.
 */

export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  strategy?: 'tokenBucket' | 'slidingWindow' | 'fixedWindow';
  keyGenerator?: (identifier: string) => string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export class RateLimiter {
  private store: Map<string, RateLimitState> = new Map();
  private options: Required<RateLimitOptions>;

  constructor(options: RateLimitOptions) {
    this.options = {
      maxRequests: options.maxRequests,
      windowMs: options.windowMs,
      strategy: options.strategy ?? 'slidingWindow',
      keyGenerator: options.keyGenerator ?? ((id) => id),
    };
  }

  /**
   * Check if a request is allowed for the given identifier.
   */
  check(identifier: string): RateLimitResult {
    const key = this.options.keyGenerator(identifier);
    const now = Date.now();
    
    switch (this.options.strategy) {
      case 'tokenBucket':
        return this.tokenBucketCheck(key, now);
      case 'slidingWindow':
        return this.slidingWindowCheck(key, now);
      case 'fixedWindow':
        return this.fixedWindowCheck(key, now);
      default:
        return this.slidingWindowCheck(key, now);
    }
  }

  /**
   * Reset rate limit for a specific identifier.
   */
  reset(identifier: string): void {
    const key = this.options.keyGenerator(identifier);
    this.store.delete(key);
  }

  /**
   * Clear all rate limit state.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Get statistics for all rate limited identifiers.
   */
  getStats(): { totalKeys: number; strategy: string } {
    return {
      totalKeys: this.store.size,
      strategy: this.options.strategy,
    };
  }

  private tokenBucketCheck(key: string, now: number): RateLimitResult {
    let state = this.store.get(key);
    
    if (!state) {
      state = {
        tokens: this.options.maxRequests,
        lastRefill: now,
        requests: [],
      };
      this.store.set(key, state);
    }

    // Refill tokens based on time elapsed
    const elapsed = now - state.lastRefill;
    const refillAmount = Math.floor((elapsed / this.options.windowMs) * this.options.maxRequests);
    state.tokens = Math.min(this.options.maxRequests, state.tokens + refillAmount);
    state.lastRefill = now;

    if (state.tokens >= 1) {
      state.tokens--;
      return {
        allowed: true,
        remaining: state.tokens,
        resetTime: now + this.options.windowMs,
      };
    }

    const retryAfter = Math.ceil((this.options.windowMs - elapsed) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetTime: now + this.options.windowMs,
      retryAfter,
    };
  }

  private slidingWindowCheck(key: string, now: number): RateLimitResult {
    let state = this.store.get(key);
    
    if (!state) {
      state = {
        tokens: this.options.maxRequests,
        lastRefill: now,
        requests: [],
      };
      this.store.set(key, state);
    }

    // Remove requests outside the window
    state.requests = state.requests.filter((timestamp) => timestamp > now - this.options.windowMs);

    if (state.requests.length < this.options.maxRequests) {
      state.requests.push(now);
      return {
        allowed: true,
        remaining: this.options.maxRequests - state.requests.length,
        resetTime: now + this.options.windowMs,
      };
    }

    const oldestRequest = state.requests[0];
    const retryAfter = Math.ceil((oldestRequest + this.options.windowMs - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetTime: oldestRequest + this.options.windowMs,
      retryAfter,
    };
  }

  private fixedWindowCheck(key: string, now: number): RateLimitResult {
    let state = this.store.get(key);
    
    const windowStart = Math.floor(now / this.options.windowMs) * this.options.windowMs;
    
    if (!state || state.lastRefill < windowStart) {
      state = {
        tokens: this.options.maxRequests,
        lastRefill: windowStart,
        requests: [],
      };
      this.store.set(key, state);
    }

    if (state.tokens > 0) {
      state.tokens--;
      return {
        allowed: true,
        remaining: state.tokens,
        resetTime: windowStart + this.options.windowMs,
      };
    }

    const retryAfter = Math.ceil((windowStart + this.options.windowMs - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      resetTime: windowStart + this.options.windowMs,
      retryAfter,
    };
  }
}

interface RateLimitState {
  tokens: number;
  lastRefill: number;
  requests: number[];
}

/**
 * Create a rate limiter middleware for Express-like frameworks.
 */
export function createRateLimitMiddleware(options: RateLimitOptions) {
  const limiter = new RateLimiter(options);

  return (identifier: string) => {
    return limiter.check(identifier);
  };
}

/**
 * In-memory rate limiter instance for common use cases.
 */
export const defaultRateLimiter = new RateLimiter({
  maxRequests: 100,
  windowMs: 60000, // 1 minute
  strategy: 'slidingWindow',
});
