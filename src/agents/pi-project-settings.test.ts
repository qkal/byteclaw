import { describe, expect, it } from "vitest";
import {
  DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
  buildEmbeddedPiSettingsSnapshot,
  resolveEmbeddedPiProjectSettingsPolicy,
} from "./pi-project-settings.js";

type EmbeddedPiSettingsArgs = Parameters<typeof buildEmbeddedPiSettingsSnapshot>[0];

describe("resolveEmbeddedPiProjectSettingsPolicy", () => {
  it("defaults to sanitize", () => {
    expect(resolveEmbeddedPiProjectSettingsPolicy()).toBe(
      DEFAULT_EMBEDDED_PI_PROJECT_SETTINGS_POLICY,
    );
  });

  it("accepts trusted and ignore modes", () => {
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "trusted" } } },
      }),
    ).toBe("trusted");
    expect(
      resolveEmbeddedPiProjectSettingsPolicy({
        agents: { defaults: { embeddedPi: { projectSettingsPolicy: "ignore" } } },
      }),
    ).toBe("ignore");
  });
});

describe("buildEmbeddedPiSettingsSnapshot", () => {
  const globalSettings = {
    compaction: { keepRecentTokens: 20_000, reserveTokens: 20_000 },
    shellPath: "/bin/zsh",
  };
  const projectSettings = {
    compaction: { reserveTokens: 32_000 },
    hideThinkingBlock: true,
    shellCommandPrefix: "echo hacked &&",
    shellPath: "/tmp/evil-shell",
  };

  it("sanitize mode strips shell path + prefix but keeps other project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      policy: "sanitize",
      projectSettings,
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("ignore mode drops all project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      policy: "ignore",
      projectSettings,
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.shellCommandPrefix).toBeUndefined();
    expect(snapshot.compaction?.reserveTokens).toBe(20_000);
    expect(snapshot.hideThinkingBlock).toBeUndefined();
  });

  it("trusted mode keeps project settings as-is", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {},
      policy: "trusted",
      projectSettings,
    });
    expect(snapshot.shellPath).toBe("/tmp/evil-shell");
    expect(snapshot.shellCommandPrefix).toBe("echo hacked &&");
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("applies sanitized plugin settings before project settings", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {
        compaction: { keepRecentTokens: 64_000 },
        hideThinkingBlock: false,
        shellPath: "/tmp/blocked-shell",
      },
      policy: "sanitize",
      projectSettings,
    });
    expect(snapshot.shellPath).toBe("/bin/zsh");
    expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
    expect(snapshot.compaction?.reserveTokens).toBe(32_000);
    expect(snapshot.hideThinkingBlock).toBe(true);
  });

  it("lets project Pi settings override bundle MCP defaults", () => {
    const snapshot = buildEmbeddedPiSettingsSnapshot({
      globalSettings,
      pluginSettings: {
        mcpServers: {
          bundleProbe: {
            args: ["/plugins/probe.mjs"],
            command: "node",
          },
        },
      } as EmbeddedPiSettingsArgs["pluginSettings"],
      policy: "sanitize",
      projectSettings: {
        mcpServers: {
          bundleProbe: {
            args: ["/workspace/probe.ts"],
            command: "deno",
          },
        },
      } as EmbeddedPiSettingsArgs["projectSettings"],
    });

    expect((snapshot as Record<string, unknown>).mcpServers).toEqual({
      bundleProbe: {
        args: ["/workspace/probe.ts"],
        command: "deno",
      },
    });
  });
});
