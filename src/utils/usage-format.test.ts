import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  __resetGatewayModelPricingCacheForTest,
  __setGatewayModelPricingForTest,
} from "../gateway/model-pricing-cache-state.js";
import {
  __resetUsageFormatCachesForTest,
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "./usage-format.js";

describe("usage-format", () => {
  const originalAgentDir = process.env.OPENCLAW_AGENT_DIR;
  let agentDir: string;

  beforeEach(async () => {
    agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-format-"));
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
  });

  afterEach(async () => {
    if (originalAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = originalAgentDir;
    }
    __resetUsageFormatCachesForTest();
    __resetGatewayModelPricingCacheForTest();
    await fs.rm(agentDir, { force: true, recursive: true });
  });

  it("formats token counts", () => {
    expect(formatTokenCount(999)).toBe("999");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12_000)).toBe("12k");
    expect(formatTokenCount(999_499)).toBe("999k");
    expect(formatTokenCount(999_500)).toBe("1.0m");
    expect(formatTokenCount(2_500_000)).toBe("2.5m");
  });

  it("formats USD values", () => {
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.5)).toBe("$0.50");
    expect(formatUsd(0.0042)).toBe("$0.0042");
  });

  it("resolves model cost config and estimates usage cost", () => {
    const config = {
      models: {
        providers: {
          test: {
            models: [
              {
                cost: { cacheRead: 0.5, cacheWrite: 0, input: 1, output: 2 },
                id: "m1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const cost = resolveModelCostConfig({
      config,
      model: "m1",
      provider: "test",
    });

    expect(cost).toEqual({
      cacheRead: 0.5,
      cacheWrite: 0,
      input: 1,
      output: 2,
    });

    const total = estimateUsageCost({
      cost,
      usage: { cacheRead: 2000, input: 1000, output: 500 },
    });

    expect(total).toBeCloseTo(0.003);
  });

  it("returns undefined when model pricing is not configured", () => {
    expect(
      resolveModelCostConfig({
        model: "demo-model-a",
        provider: "demo-unconfigured-a",
      }),
    ).toBeUndefined();

    expect(
      resolveModelCostConfig({
        model: "demo-model-b",
        provider: "demo-unconfigured-b",
      }),
    ).toBeUndefined();
  });

  it("prefers models.json pricing over openclaw config and cached pricing", async () => {
    const config = {
      models: {
        providers: {
          "demo-preferred": {
            models: [
              {
                cost: { cacheRead: 22, cacheWrite: 23, input: 20, output: 21 },
                id: "demo-model",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify(
        {
          providers: {
            "demo-preferred": {
              models: [
                {
                  cost: { cacheRead: 12, cacheWrite: 13, input: 10, output: 11 },
                  id: "demo-model",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    __setGatewayModelPricingForTest([
      {
        model: "demo-model",
        pricing: { cacheRead: 32, cacheWrite: 33, input: 30, output: 31 },
        provider: "demo-preferred",
      },
    ]);

    expect(
      resolveModelCostConfig({
        config,
        model: "demo-model",
        provider: "demo-preferred",
      }),
    ).toEqual({
      cacheRead: 12,
      cacheWrite: 13,
      input: 10,
      output: 11,
    });
  });

  it("falls back to openclaw config pricing when models.json is absent", () => {
    const config = {
      models: {
        providers: {
          "demo-config-provider": {
            models: [
              {
                cost: { cacheRead: 0.9, cacheWrite: 1.9, input: 9, output: 19 },
                id: "demo-model",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    __setGatewayModelPricingForTest([
      {
        model: "demo-model",
        pricing: { cacheRead: 0.3, cacheWrite: 0.4, input: 3, output: 4 },
        provider: "demo-config-provider",
      },
    ]);

    expect(
      resolveModelCostConfig({
        config,
        model: "demo-model",
        provider: "demo-config-provider",
      }),
    ).toEqual({
      cacheRead: 0.9,
      cacheWrite: 1.9,
      input: 9,
      output: 19,
    });
  });

  it("falls back to cached gateway pricing when no configured cost exists", () => {
    __setGatewayModelPricingForTest([
      {
        model: "demo-model",
        pricing: { cacheRead: 0.25, cacheWrite: 0, input: 2.5, output: 15 },
        provider: "demo-cached-provider",
      },
    ]);

    expect(
      resolveModelCostConfig({
        model: "demo-model",
        provider: "demo-cached-provider",
      }),
    ).toEqual({
      cacheRead: 0.25,
      cacheWrite: 0,
      input: 2.5,
      output: 15,
    });
  });

  it("can skip plugin-backed model normalization for display-only cost lookup", () => {
    const config = {
      models: {
        providers: {
          "google-vertex": {
            models: [
              {
                cost: { cacheRead: 0.7, cacheWrite: 0.8, input: 7, output: 8 },
                id: "gemini-3.1-flash-lite",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveModelCostConfig({
        allowPluginNormalization: false,
        config,
        model: "gemini-3.1-flash-lite",
        provider: "google-vertex",
      }),
    ).toEqual({
      cacheRead: 0.7,
      cacheWrite: 0.8,
      input: 7,
      output: 8,
    });
  });
});
