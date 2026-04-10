import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import {
  type ProviderUsageAuth,
  loadUsageWithAuth,
  usageNow,
} from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot } from "./provider-usage.types.js";

type ProviderAuth = ProviderUsageAuth<typeof loadProviderUsageSummary>;
const googleGeminiCliProvider = "google-gemini-cli" as unknown as ProviderAuth["provider"];
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

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resolveProviderUsageSnapshotWithPluginMock.mockReset();
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValue(null);
  });

  it("loads snapshots for copilot gemini codex and xiaomi", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockImplementation(
      async ({ provider }): Promise<ProviderUsageSnapshot | null> => {
        switch (provider) {
          case "github-copilot": {
            return {
              displayName: "GitHub Copilot",
              provider,
              windows: [{ label: "Chat", usedPercent: 20 }],
            };
          }
          case googleGeminiCliProvider: {
            return {
              displayName: "Gemini CLI",
              provider,
              windows: [{ label: "Pro", usedPercent: 40 }],
            };
          }
          case "openai-codex": {
            return {
              displayName: "Codex",
              provider,
              windows: [{ label: "3h", usedPercent: 12 }],
            };
          }
          case "xiaomi": {
            return {
              displayName: "Xiaomi",
              provider,
              windows: [],
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
        { provider: "github-copilot", token: "copilot-token" },
        { provider: googleGeminiCliProvider, token: "gemini-token" },
        { accountId: "acc-1", provider: "openai-codex", token: "codex-token" },
        { provider: "xiaomi", token: "xiaomi-token" },
      ],
      mockFetch,
    );

    expect(summary.providers.map((provider) => provider.provider)).toEqual([
      "github-copilot",
      googleGeminiCliProvider,
      "openai-codex",
      "xiaomi",
    ]);
    expect(
      summary.providers.find((provider) => provider.provider === "github-copilot")?.windows,
    ).toEqual([{ label: "Chat", usedPercent: 20 }]);
    expect(
      summary.providers.find((provider) => provider.provider === googleGeminiCliProvider)
        ?.windows[0]?.label,
    ).toBe("Pro");
    expect(
      summary.providers.find((provider) => provider.provider === "openai-codex")?.windows[0]?.label,
    ).toBe("3h");
    expect(summary.providers.find((provider) => provider.provider === "xiaomi")?.windows).toEqual(
      [],
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty provider list when auth resolves to none", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(loadProviderUsageSummary, [], mockFetch);
    expect(summary).toEqual({ providers: [], updatedAt: usageNow });
  });

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadUsageWithAuth(
      loadProviderUsageSummary,
      [{ provider: "unsupported-provider", token: "token-u" }] as unknown as ProviderAuth[],
      mockFetch,
    );
    expect(summary.providers).toHaveLength(1);
    expect(summary.providers[0]?.error).toBe("Unsupported provider");
  });

  it("filters errors that are marked as ignored", async () => {
    resolveProviderUsageSnapshotWithPluginMock.mockResolvedValueOnce({
      displayName: "Claude",
      error: "HTTP 500",
      provider: "anthropic",
      windows: [],
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("throws when fetch is unavailable", async () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(
        loadProviderUsageSummary({
          auth: [{ provider: "xiaomi", token: "token-x" }],
          fetch: undefined,
          now: usageNow,
        }),
      ).rejects.toThrow("fetch is not available");
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});
