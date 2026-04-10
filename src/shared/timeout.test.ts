import { describe, expect, it, vi } from "vitest";
import {
  TimeoutController,
  TimeoutError,
  debounce,
  throttle,
  withTimeout,
  withTimeouts,
} from "./timeout.js";

describe("timeout", () => {
  describe("withTimeout", () => {
    it("executes function within timeout", async () => {
      const result = await withTimeout(
        async () => {
          return "success";
        },
        { timeoutMs: 1000 },
      );
      expect(result).toBe("success");
    });

    it("throws TimeoutError on timeout", async () => {
      await expect(
        withTimeout(
          async () => {
            await new Promise(() => {}); // Never resolves
          },
          { timeoutMs: 100 },
        ),
      ).rejects.toThrow(TimeoutError);
    });

    it("calls onTimeout callback", async () => {
      const onTimeout = vi.fn();
      await expect(
        withTimeout(
          async () => {
            await new Promise(() => {});
          },
          { timeoutMs: 100, onTimeout },
        ),
      ).rejects.toThrow();
      expect(onTimeout).toHaveBeenCalled();
    });

    it("aborts signal on timeout", async () => {
      let signalReceived = false;
      await expect(
        withTimeout(
          async (signal) => {
            signal.addEventListener("abort", () => {
              signalReceived = true;
            });
            await new Promise(() => {});
          },
          { timeoutMs: 100 },
        ),
      ).rejects.toThrow();
      expect(signalReceived).toBe(true);
    });
  });

  describe("TimeoutController", () => {
    it("starts and clears timeout", () => {
      const controller = new TimeoutController({ timeoutMs: 1000 });
      controller.start();
      expect(controller.isActive()).toBe(true);
      controller.clear();
      expect(controller.isActive()).toBe(false);
    });
  });

  describe("withTimeouts", () => {
    it("executes multiple operations with timeouts", async () => {
      const results = await withTimeouts([
        { fn: async () => "a", timeoutMs: 1000 },
        { fn: async () => "b", timeoutMs: 1000 },
      ]);
      expect(results).toHaveLength(2);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
    });

    it("handles partial failures", async () => {
      const results = await withTimeouts([
        { fn: async () => "a", timeoutMs: 1000 },
        { fn: async () => new Promise(() => {}), timeoutMs: 100 },
      ]);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(false);
    });
  });

  describe("debounce", () => {
    it("delays function execution", async () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);
      debounced();
      expect(fn).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("cancels previous calls", async () => {
      const fn = vi.fn();
      const debounced = debounce(fn, 100);
      debounced();
      debounced();
      debounced();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("throttle", () => {
    it("limits function execution rate", async () => {
      const fn = vi.fn();
      const throttled = throttle(fn, 100);
      throttled();
      throttled();
      throttled();
      expect(fn).toHaveBeenCalledTimes(1);
      await new Promise((resolve) => setTimeout(resolve, 150));
      throttled();
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
