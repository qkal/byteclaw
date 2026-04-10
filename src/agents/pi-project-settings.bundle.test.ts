import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const { loadEnabledBundlePiSettingsSnapshot } = await import("./pi-project-settings.js");

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function createWorkspaceBundle(params: {
  workspaceDir: string;
  pluginId?: string;
}): Promise<string> {
  const pluginId = params.pluginId ?? "claude-bundle";
  const pluginRoot = path.join(params.workspaceDir, ".openclaw", "extensions", pluginId);
  await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: pluginId,
    }),
    "utf8",
  );
  return pluginRoot;
}

describe("loadEnabledBundlePiSettingsSnapshot", () => {
  it("loads sanitized settings from enabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({
        compaction: { keepRecentTokens: 64_000 },
        hideThinkingBlock: true,
        shellPath: "/tmp/blocked-shell",
      }),
      "utf8",
    );

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
      cwd: workspaceDir,
    });

    expect(snapshot.hideThinkingBlock).toBe(true);
    expect(snapshot.shellPath).toBeUndefined();
    expect(snapshot.compaction?.keepRecentTokens).toBe(64_000);
  });

  it("loads enabled bundle MCP servers into the Pi settings snapshot", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    const resolvedPluginRoot = await fs.realpath(pluginRoot);
    await fs.mkdir(path.join(pluginRoot, "servers"), { recursive: true });
    const resolvedServerPath = await fs.realpath(path.join(pluginRoot, "servers"));
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          bundleProbe: {
            args: ["./servers/probe.mjs"],
            command: "node",
          },
        },
      }),
      "utf8",
    );

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
      cwd: workspaceDir,
    });

    expect((snapshot as Record<string, unknown>).mcpServers).toEqual({
      bundleProbe: {
        args: [path.join(resolvedServerPath, "probe.mjs")],
        command: "node",
        cwd: resolvedPluginRoot,
      },
    });
  });

  it("lets top-level MCP config override bundle MCP defaults", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    await fs.writeFile(
      path.join(pluginRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          sharedServer: {
            args: ["./servers/bundle.mjs"],
            command: "node",
          },
        },
      }),
      "utf8",
    );

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
      cfg: {
        mcp: {
          servers: {
            sharedServer: {
              url: "https://example.com/mcp",
            },
          },
        },
        plugins: {
          entries: {
            "claude-bundle": { enabled: true },
          },
        },
      },
      cwd: workspaceDir,
    });

    expect((snapshot as Record<string, unknown>).mcpServers).toEqual({
      sharedServer: {
        url: "https://example.com/mcp",
      },
    });
  });

  it("ignores disabled bundle plugins", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await createWorkspaceBundle({ workspaceDir });
    await fs.writeFile(
      path.join(pluginRoot, "settings.json"),
      JSON.stringify({ hideThinkingBlock: true }),
      "utf8",
    );

    const snapshot = loadEnabledBundlePiSettingsSnapshot({
      cfg: {
        plugins: {
          entries: {
            "claude-bundle": { enabled: false },
          },
        },
      },
      cwd: workspaceDir,
    });

    expect(snapshot).toEqual({});
  });
});
