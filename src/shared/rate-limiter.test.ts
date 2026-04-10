import { describe, expect, it } from "vitest";
import {
  RateLimiter,
  createRateLimitMiddleware,
  defaultRateLimiter,
} from "./rate-limiter.js";

describe("rate-limiter", () => {
  describe("RateLimiter", () => {
    it("allows requests within limit", () => {
      const limiter = new RateLimiter({ maxRequests: 5, windowMs: 1000 });
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it("blocks requests exceeding limit", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.check("user1");
      limiter.check("user1");
      const result = limiter.check("user1");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it("resets after window expires", async () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 100 });
      limiter.check("user1");
      limiter.check("user1");
      await new Promise((resolve) => setTimeout(resolve, 150));
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
    });

    it("separates limits by identifier", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.check("user1");
      limiter.check("user1");
      const result = limiter.check("user2");
      expect(result.allowed).toBe(true);
    });

    it("supports token bucket strategy", () => {
      const limiter = new RateLimiter({
        maxRequests: 5,
        windowMs: 1000,
        strategy: "tokenBucket",
      });
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
    });

    it("provides retry after time", () => {
      const limiter = new RateLimiter({ maxRequests: 1, windowMs: 1000 });
      limiter.check("user1");
      const result = limiter.check("user1");
      expect(result.retryAfter).toBeDefined();
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("resets specific identifier", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.check("user1");
      limiter.check("user1");
      limiter.reset("user1");
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
    });

    it("clears all state", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.check("user1");
      limiter.clear();
      const result = limiter.check("user1");
      expect(result.allowed).toBe(true);
    });

    it("provides statistics", () => {
      const limiter = new RateLimiter({ maxRequests: 2, windowMs: 1000 });
      limiter.check("user1");
      const stats = limiter.getStats();
      expect(stats.totalKeys).toBe(1);
    });
  });

  describe("createRateLimitMiddleware", () => {
    it("creates middleware function", () => {
      const middleware = createRateLimitMiddleware({ maxRequests: 10, windowMs: 1000 });
      const result = middleware("user1");
      expect(result.allowed).toBe(true);
    });
  });

  describe("defaultRateLimiter", () => {
    it("provides default rate limiter", () => {
      const result = defaultRateLimiter.check("user1");
      expect(result.allowed).toBe(true);
    });
  });
});
