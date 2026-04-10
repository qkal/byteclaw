import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";
import {
  type UsageSummary,
  formatUsageReportLines,
  formatUsageSummaryLine,
  loadProviderUsageSummary,
} from "./provider-usage.js";
import { loadUsageWithAuth } from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageSnapshotWithPlugin>(
    async () => null,
  ),
);

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: resolveProviderUsageSnapshotWithPluginMock,
  };
});

describe("provider usage formatting", () => {
  beforeEach(() => {
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
  });

  it("returns null when no usage is available", () => {
    const summary: UsageSummary = { providers: [], updatedAt: 0 };
    expect(formatUsageSummaryLine(summary)).toBeNull();
  });

  it("picks the most-used window for summary line", () => {
    const summary: UsageSummary = {
      providers: [
        {
          displayName: "Claude",
          provider: "anthropic",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 60 },
          ],
        },
      ],
      updatedAt: 0,
    };
    const line = formatUsageSummaryLine(summary, { now: 0 });
    expect(line).toContain("Claude");
    expect(line).toContain("40% left");
    expect(line).toContain("(Week");
  });

  it("prints provider errors in report output", () => {
    const summary: UsageSummary = {
      providers: [
        {
          displayName: "Codex",
          error: "Token expired",
          provider: "openai-codex",
          windows: [],
        },
      ],
      updatedAt: 0,
    };
    const lines = formatUsageReportLines(summary);
    expect(lines.join("\n")).toContain("Codex: Token expired");
  });

  it("includes reset countdowns in report lines", () => {
    const now = Date.UTC(2026, 0, 7, 0, 0, 0);
    const summary: UsageSummary = {
      providers: [
        {
          displayName: "Claude",
          provider: "anthropic",
          windows: [{ label: "5h", usedPercent: 20, resetAt: now + 60_000 }],
        },
      ],
      updatedAt: now,
    };
    const lines = formatUsageReportLines(summary, { now });
    expect(lines.join("\n")).toContain("resets 1m");
  });
});

describe("provider usage loading", () => {
  it("loads usage snapshots with injected auth", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "anthropic": {
            return {
              displayName: "Claude",
              provider,
              windows: [{ label: "5h", usedPercent: 20 }],
            };
          }
          case "minimax": {
            return {
              displayName: "MiniMax",
              plan: "Coding Plan",
              provider,
              windows: [{ label: "5h", usedPercent: 75 }],
            };
          }
          case "zai": {
            return {
              displayName: "Z.ai",
              plan: "Pro",
              provider,
              windows: [{ label: "3h", usedPercent: 25 }],
            };
          }
          default: {
            return null;
          }
        }
      },
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [
        { provider: "anthropic", token: "token-1" },
        { provider: "minimax", token: "token-1b" },
        { provider: "zai", token: "token-2" },
      ],
      mockFetch,
    );

    expect(summary.providers).toHaveLength(3);
    const claude = summary.providers.find((p) => p.provider === "anthropic");
    const minimax = summary.providers.find((p) => p.provider === "minimax");
    const zai = summary.providers.find((p) => p.provider === "zai");
    expect(claude?.windows[0]?.label).toBe("5h");
    expect(minimax?.windows[0]?.usedPercent).toBe(75);
    expect(zai?.plan).toBe("Pro");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
