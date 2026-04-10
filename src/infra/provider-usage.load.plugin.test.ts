import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

const resolveProviderUsageSnapshotWithPluginMock = vi.fn();

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderUsageSnapshotWithPlugin: (...args: unknown[]) =>
      resolveProviderUsageSnapshotWithPluginMock(...args),
  };
});

let loadProviderUsageSummary: typeof import("./provider-usage.load.js").loadProviderUsageSummary;

const usageNow = Date.UTC(2026, 0, 7, 0, 0, 0);

describe("provider-usage.load plugin boundary", () => {
  beforeAll(async () => {
    ({ loadProviderUsageSummary } = await import("./provider-usage.load.js"));
  });

  beforeEach(() => {
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
  });

  it("prefers plugin-owned usage snapshots", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      displayName: "Copilot",
      provider: "github-copilot",
      windows: [{ label: "Plugin", usedPercent: 11 }],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    await expect(
      loadProviderUsageSummary({
        auth: [{ provider: "github-copilot", token: "copilot-token" }],
        fetch: mockFetch as unknown as typeof fetch,
        now: usageNow,
      }),
    ).resolves.toEqual({
      providers: [
        {
          displayName: "Copilot",
          provider: "github-copilot",
          windows: [{ label: "Plugin", usedPercent: 11 }],
        },
      ],
      updatedAt: usageNow,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(resolveProviderUsageSnapshotWithPluginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          provider: "github-copilot",
          timeoutMs: 5_000,
          token: "copilot-token",
        }),
        provider: "github-copilot",
      }),
    );
  });
});
