import { describe, expect, it } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { fetchZaiUsage } from "./provider-usage.fetch.zai.js";

describe("fetchZaiUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(503, "unavailable"));
    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.error).toBe("HTTP 503");
    expect(result.windows).toHaveLength(0);
  });

  it("returns API message errors for unsuccessful payloads", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        code: 500,
        msg: "quota endpoint disabled",
        success: false,
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);
    expect(result.error).toBe("quota endpoint disabled");
    expect(result.windows).toHaveLength(0);
  });

  it("falls back to a generic API error for blank unsuccessful messages", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        code: 500,
        msg: "   ",
        success: false,
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);
    expect(result.error).toBe("API error");
    expect(result.windows).toHaveLength(0);
  });

  it("parses token and monthly windows with reset times", async () => {
    const tokenReset = "2026-01-08T00:00:00Z";
    const minuteReset = "2026-01-08T00:30:00Z";
    const monthlyReset = "2026-01-31T12:00:00Z";
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              nextResetTime: tokenReset,
              number: 6,
              percentage: 32,
              type: "TOKENS_LIMIT",
              unit: 3,
            },
            {
              nextResetTime: minuteReset,
              number: 15,
              percentage: 8,
              type: "TOKENS_LIMIT",
              unit: 5,
            },
            {
              nextResetTime: monthlyReset,
              number: 30,
              percentage: 12.5,
              type: "TIME_LIMIT",
              unit: 1,
            },
          ],
          planName: "Team",
        },
        success: true,
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.plan).toBe("Team");
    expect(result.windows).toEqual([
      {
        label: "Tokens (6h)",
        resetAt: new Date(tokenReset).getTime(),
        usedPercent: 32,
      },
      {
        label: "Tokens (15m)",
        resetAt: new Date(minuteReset).getTime(),
        usedPercent: 8,
      },
      {
        label: "Monthly",
        resetAt: new Date(monthlyReset).getTime(),
        usedPercent: 12.5,
      },
    ]);
  });

  it("clamps invalid percentages and falls back to alternate plan fields", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        code: 200,
        data: {
          limits: [
            {
              percentage: -5,
              type: "TOKENS_LIMIT",
              unit: 99,
            },
            {
              percentage: 140,
              type: "TIME_LIMIT",
            },
            {
              percentage: 50,
              type: "OTHER_LIMIT",
            },
          ],
          plan: "Pro",
        },
        success: true,
      }),
    );

    const result = await fetchZaiUsage("key", 5000, mockFetch);

    expect(result.plan).toBe("Pro");
    expect(result.windows).toEqual([
      {
        label: "Tokens (Limit)",
        resetAt: undefined,
        usedPercent: 0,
      },
      {
        label: "Monthly",
        resetAt: undefined,
        usedPercent: 100,
      },
    ]);
  });
});
