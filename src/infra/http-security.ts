/**
 * HTTP Security Middleware
 * Provides rate limiting, request size limits, and other security features
 */

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface RequestSizeLimitConfig {
  maxJsonSize: number;
  maxUrlEncodedSize: number;
  maxTextSize: number;
  maxRawSize: number;
}

/**
 * In-memory rate limiter for HTTP requests
 */
class RateLimiter {
  private requests = new Map<string, number[]>();
  private config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /**
   * Check if request should be rate limited
   */
  isRateLimited(identifier: string): boolean {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    let timestamps = this.requests.get(identifier) || [];

    // Clean up old timestamps outside the window
    timestamps = timestamps.filter((ts) => ts > windowStart);

    // Check if limit exceeded
    if (timestamps.length >= this.config.maxRequests) {
      return true;
    }

    // Add current request timestamp
    timestamps.push(now);
    this.requests.set(identifier, timestamps);

    return false;
  }

  /**
   * Get remaining requests for identifier
   */
  getRemainingRequests(identifier: string): number {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;

    const timestamps = this.requests.get(identifier) || [];
    const recentTimestamps = timestamps.filter((ts) => ts > windowStart);

    return Math.max(0, this.config.maxRequests - recentTimestamps.length);
  }

  /**
   * Reset rate limit for identifier
   */
  reset(identifier: string): void {
    this.requests.delete(identifier);
  }
}

/**
 * Request size limiter
 */
class RequestSizeLimiter {
  private config: RequestSizeLimitConfig;

  constructor(config: RequestSizeLimitConfig) {
    this.config = config;
  }

  /**
   * Check if request size exceeds limit
   */
  isSizeExceeded(contentType: string | null, contentLength: number): boolean {
    if (!contentLength) {
      return false;
    }

    if (contentType?.includes("application/json")) {
      return contentLength > this.config.maxJsonSize;
    }

    if (contentType?.includes("application/x-www-form-urlencoded")) {
      return contentLength > this.config.maxUrlEncodedSize;
    }

    if (contentType?.includes("text/")) {
      return contentLength > this.config.maxTextSize;
    }

    return contentLength > this.config.maxRawSize;
  }
}

/**
 * Default rate limit configuration
 */
export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100, // 100 requests per minute
  skipSuccessfulRequests: false,
  skipFailedRequests: false,
};

/**
 * Default request size limit configuration
 */
export const DEFAULT_REQUEST_SIZE_LIMIT_CONFIG: RequestSizeLimitConfig = {
  maxJsonSize: 10 * 1024 * 1024, // 10MB
  maxUrlEncodedSize: 10 * 1024 * 1024, // 10MB
  maxTextSize: 10 * 1024 * 1024, // 10MB
  maxRawSize: 50 * 1024 * 1024, // 50MB
};

/**
 * Create rate limiter instance
 */
export function createRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter({ ...DEFAULT_RATE_LIMIT_CONFIG, ...config });
}

/**
 * Create request size limiter instance
 */
export function createRequestSizeLimiter(
  config?: Partial<RequestSizeLimitConfig>,
): RequestSizeLimiter {
  return new RequestSizeLimiter({ ...DEFAULT_REQUEST_SIZE_LIMIT_CONFIG, ...config });
}

/**
 * HTTP security headers
 */
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
};

/**
 * Apply security headers to response
 */
export function applySecurityHeaders(headers: Record<string, string>): void {
  Object.assign(headers, SECURITY_HEADERS);
}

/**
 * Rate limit error response
 */
export class RateLimitError extends Error {
  constructor(
    public retryAfter: number,
    message = "Too many requests",
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/**
 * Request size limit error response
 */
export class RequestSizeLimitError extends Error {
  constructor(
    public maxSize: number,
    public actualSize: number,
    message = "Request size limit exceeded",
  ) {
    super(message);
    this.name = "RequestSizeLimitError";
  }
}
