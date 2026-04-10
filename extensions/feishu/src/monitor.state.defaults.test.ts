import { describe, expect, it } from "vitest";
import {
  resolveFeishuWebhookAnomalyDefaultsForTest,
  resolveFeishuWebhookRateLimitDefaultsForTest,
} from "./monitor.state.js";

describe("feishu monitor state defaults", () => {
  it("falls back to hard defaults when sdk defaults are missing", () => {
    expect(resolveFeishuWebhookRateLimitDefaultsForTest(undefined)).toEqual({
      maxRequests: 120,
      maxTrackedKeys: 4096,
      windowMs: 60_000,
    });
    expect(resolveFeishuWebhookAnomalyDefaultsForTest(undefined)).toEqual({
      logEvery: 25,
      maxTrackedKeys: 4096,
      ttlMs: 21_600_000,
    });
  });

  it("keeps valid sdk values and repairs invalid fields", () => {
    expect(
      resolveFeishuWebhookRateLimitDefaultsForTest({
        maxRequests: 0,
        maxTrackedKeys: -1,
        windowMs: 45_000,
      }),
    ).toEqual({
      maxRequests: 120,
      maxTrackedKeys: 4096,
      windowMs: 45_000,
    });

    expect(
      resolveFeishuWebhookAnomalyDefaultsForTest({
        logEvery: 10,
        maxTrackedKeys: 2048,
        ttlMs: Number.NaN,
      }),
    ).toEqual({
      logEvery: 10,
      maxTrackedKeys: 2048,
      ttlMs: 21_600_000,
    });
  });
});
