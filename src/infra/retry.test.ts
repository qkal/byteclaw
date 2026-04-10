import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRetryConfig, retryAsync } from "./retry.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureFraction: vi.fn(),
}));

vi.mock("./secure-random.js", () => ({
  generateSecureFraction: randomMocks.generateSecureFraction,
}));

interface NumberRetryCase {
  name: string;
  fn: ReturnType<typeof vi.fn>;
  attempts: number;
  initialDelayMs: number;
  expectedValue?: string;
  expectedError?: string;
  expectedCalls: number;
}

async function runRetryAfterCase(params: {
  minDelayMs: number;
  maxDelayMs: number;
  retryAfterMs: number;
}): Promise<number[]> {
  vi.clearAllTimers();
  vi.useFakeTimers();
  try {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];
    const promise = retryAsync(fn, {
      attempts: 2,
      jitter: 0,
      maxDelayMs: params.maxDelayMs,
      minDelayMs: params.minDelayMs,
      onRetry: (info) => delays.push(info.delayMs),
      retryAfterMs: () => params.retryAfterMs,
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    return delays;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

async function runRetryNumberCase(
  fn: ReturnType<typeof vi.fn>,
  attempts: number,
  initialDelayMs: number,
): Promise<unknown> {
  vi.clearAllTimers();
  vi.useFakeTimers();
  try {
    const promise = retryAsync(fn as () => Promise<unknown>, attempts, initialDelayMs);
    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ error, ok: false as const }),
    );
    await vi.runAllTimersAsync();
    const result = await settled;
    if (result.ok) {
      return result.value;
    }
    throw result.error;
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  randomMocks.generateSecureFraction.mockReset();
});

describe("retryAsync", () => {
  it.each<NumberRetryCase>([
    {
      attempts: 3,
      expectedCalls: 1,
      expectedValue: "ok",
      fn: vi.fn().mockResolvedValue("ok"),
      initialDelayMs: 10,
      name: "returns on first success",
    },
    {
      attempts: 3,
      expectedCalls: 2,
      expectedValue: "ok",
      fn: vi.fn().mockRejectedValueOnce(new Error("fail1")).mockResolvedValueOnce("ok"),
      initialDelayMs: 1,
      name: "retries then succeeds",
    },
    {
      attempts: 2,
      expectedCalls: 2,
      expectedError: "boom",
      fn: vi.fn().mockRejectedValue(new Error("boom")),
      initialDelayMs: 1,
      name: "propagates after exhausting retries",
    },
  ])(
    "$name",
    async ({ fn, attempts, initialDelayMs, expectedValue, expectedError, expectedCalls }) => {
      const result = runRetryNumberCase(fn, attempts, initialDelayMs);
      if (expectedError) {
        await expect(result).rejects.toThrow(expectedError);
      } else {
        await expect(result).resolves.toBe(expectedValue);
      }
      expect(fn).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("stops when shouldRetry returns false", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn(() => false);
    await expect(retryAsync(fn, { attempts: 3, shouldRetry })).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err, 1);
  });

  it("calls onRetry with retry metadata before retrying", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce("ok");
    const onRetry = vi.fn();
    vi.clearAllTimers();
    vi.useFakeTimers();
    let res: string;
    try {
      const promise: Promise<string> = retryAsync(fn, {
        attempts: 2,
        label: "telegram",
        maxDelayMs: 0,
        minDelayMs: 0,
        onRetry,
      });
      await vi.runAllTimersAsync();
      res = await promise;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    expect(res).toBe("ok");
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        err,
        label: "telegram",
        maxAttempts: 2,
      }),
    );
  });

  it("retries immediately when the resolved delay is zero", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    await expect(
      retryAsync(fn, {
        attempts: 2,
        jitter: 0,
        maxDelayMs: 0,
        minDelayMs: 0,
      }),
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("clamps attempts to at least 1", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(retryAsync(fn, { attempts: 0, maxDelayMs: 0, minDelayMs: 0 })).rejects.toThrow(
      "boom",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      expectedDelay: 500,
      name: "uses retryAfterMs when provided",
      params: { maxDelayMs: 1000, minDelayMs: 0, retryAfterMs: 500 },
    },
    {
      expectedDelay: 100,
      name: "clamps retryAfterMs to maxDelayMs",
      params: { maxDelayMs: 100, minDelayMs: 0, retryAfterMs: 500 },
    },
    {
      expectedDelay: 250,
      name: "clamps retryAfterMs to minDelayMs",
      params: { maxDelayMs: 1000, minDelayMs: 250, retryAfterMs: 50 },
    },
  ])("$name", async ({ params, expectedDelay }) => {
    const delays = await runRetryAfterCase(params);
    expect(delays[0]).toBe(expectedDelay);
  });

  it("uses secure jitter when configured", async () => {
    vi.useFakeTimers();
    randomMocks.generateSecureFraction.mockReturnValue(1);
    const fn = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const delays: number[] = [];

    try {
      const promise = retryAsync(fn, {
        attempts: 2,
        jitter: 0.5,
        maxDelayMs: 200,
        minDelayMs: 100,
        onRetry: (info) => delays.push(info.delayMs),
      });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe("ok");
      expect(delays).toEqual([150]);
      expect(randomMocks.generateSecureFraction).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe("resolveRetryConfig", () => {
  it.each([
    {
      expected: { attempts: 3, jitter: 0.4, maxDelayMs: 100, minDelayMs: 10 },
      name: "rounds attempts and delays",
      overrides: { attempts: 2.6, jitter: 0.4, maxDelayMs: 99.8, minDelayMs: 10.4 },
    },
    {
      expected: { attempts: 1, jitter: 0, maxDelayMs: 250, minDelayMs: 250 },
      name: "clamps attempts to at least one and maxDelayMs to minDelayMs",
      overrides: { attempts: 0, jitter: -1, maxDelayMs: 100, minDelayMs: 250 },
    },
    {
      expected: { attempts: 3, jitter: 1, maxDelayMs: 30_000, minDelayMs: 300 },
      name: "falls back for non-finite overrides and caps jitter at one",
      overrides: {
        attempts: Number.NaN,
        jitter: 2,
        maxDelayMs: Number.NaN,
        minDelayMs: Number.POSITIVE_INFINITY,
      },
    },
  ])("$name", ({ overrides, expected }) => {
    expect(resolveRetryConfig(undefined, overrides)).toEqual(expected);
  });
});
