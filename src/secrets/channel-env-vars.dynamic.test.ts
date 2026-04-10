import { beforeEach, describe, expect, it, vi } from "vitest";

interface MockManifestRegistry {
  plugins: {
    id: string;
    origin: string;
    channelEnvVars?: Record<string, string[]>;
  }[];
  diagnostics: unknown[];
}

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({ diagnostics: [], plugins: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("channel env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ diagnostics: [], plugins: [] });
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          channelEnvVars: {
            mattermost: ["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"],
          },
          id: "external-mattermost",
          origin: "global",
        },
      ],
    });

    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]);
    expect(mod.listKnownChannelEnvVarNames()).toEqual(
      expect.arrayContaining(["MATTERMOST_BOT_TOKEN", "MATTERMOST_URL"]),
    );
  });
});
