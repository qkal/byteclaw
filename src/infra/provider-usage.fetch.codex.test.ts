import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchCodexUsage } from "./provider-usage.fetch.codex.js";

describe("fetchCodexUsage", () => {
  it("returns token expired for auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(401, { error: "unauthorized" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("Token expired");
    expect(result.windows).toHaveLength(0);
  });

  it("returns HTTP status errors for non-auth failures", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(429, { error: "throttled" }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.error).toBe("HTTP 429");
    expect(result.windows).toHaveLength(0);
  });

  it("parses windows, reset times, and plan balance", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers["ChatGPT-Account-Id"]).toBe("acct-1");
      return makeResponse(200, {
        credits: { balance: "12.5" },
        plan_type: "Plus",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            reset_at: 1_700_000_000,
            used_percent: 35.5,
          },
          secondary_window: {
            limit_window_seconds: 86_400,
            reset_at: 1_700_050_000,
            used_percent: 75,
          },
        },
      });
    });

    const result = await fetchCodexUsage("token", "acct-1", 5000, mockFetch);

    expect(result.provider).toBe("openai-codex");
    expect(result.plan).toBe("Plus ($12.50)");
    expect(result.windows).toEqual([
      { label: "3h", resetAt: 1_700_000_000_000, usedPercent: 35.5 },
      { label: "Day", resetAt: 1_700_050_000_000, usedPercent: 75 },
    ]);
  });

  it("labels weekly secondary window as Week", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            reset_at: 1_700_000_000,
            used_percent: 7,
          },
          secondary_window: {
            limit_window_seconds: 604_800,
            reset_at: 1_700_500_000,
            used_percent: 10,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "3h", resetAt: 1_700_000_000_000, usedPercent: 7 },
      { label: "Week", resetAt: 1_700_500_000_000, usedPercent: 10 },
    ]);
  });

  it("labels secondary window as Week when reset cadence clearly exceeds one day", async () => {
    const primaryReset = 1_700_000_000;
    const weeklyLikeSecondaryReset = primaryReset + 5 * 24 * 60 * 60;
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          primary_window: {
            limit_window_seconds: 10_800,
            reset_at: primaryReset,
            used_percent: 14,
          },
          secondary_window: {
            // Observed in production: API reports 24h, but dashboard shows a weekly window.
            limit_window_seconds: 86_400,
            reset_at: weeklyLikeSecondaryReset,
            used_percent: 20,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([
      { label: "3h", resetAt: 1_700_000_000_000, usedPercent: 14 },
      { label: "Week", resetAt: weeklyLikeSecondaryReset * 1000, usedPercent: 20 },
    ]);
  });

  it("labels short secondary windows in hours", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        rate_limit: {
          secondary_window: {
            limit_window_seconds: 21_600,
            used_percent: 11,
          },
        },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.windows).toEqual([{ label: "6h", resetAt: undefined, usedPercent: 11 }]);
  });

  it("builds a balance-only plan when credits exist without a plan type", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        credits: { balance: "7.5" },
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.plan).toBe("$7.50");
    expect(result.windows).toEqual([]);
  });

  it("falls back invalid credit strings to a zero balance", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        credits: { balance: "not-a-number" },
        plan_type: "Plus",
      }),
    );

    const result = await fetchCodexUsage("token", undefined, 5000, mockFetch);
    expect(result.plan).toBe("Plus ($0.00)");
  });
});
