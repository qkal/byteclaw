import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadBundleFixture,
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";

function expectNoUnwiredBundleDiagnostic(
  registry: ReturnType<typeof loadOpenClawPlugins>,
  pluginId: string,
) {
  expect(
    registry.diagnostics.some(
      (diag) =>
        diag.pluginId === pluginId &&
        diag.message.includes("bundle capability detected but not wired"),
    ),
  ).toBe(false);
}

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("bundle plugins", () => {
  it("reports Codex bundles as loaded bundle plugins without importing runtime code", () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const stateDir = makeTempDir();
    const bundleRoot = path.join(workspaceDir, ".openclaw", "extensions", "sample-bundle");
    mkdirSafe(path.join(bundleRoot, ".codex-plugin"));
    mkdirSafe(path.join(bundleRoot, "skills"));
    fs.writeFileSync(
      path.join(bundleRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        description: "Codex bundle fixture",
        name: "Sample Bundle",
        skills: "skills",
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(bundleRoot, "skills", "SKILL.md"),
      "---\ndescription: fixture\n---\n",
    );

    const registry = withEnv({ OPENCLAW_STATE_DIR: stateDir }, () =>
      loadOpenClawPlugins({
        cache: false,
        config: {
          plugins: {
            entries: {
              "sample-bundle": {
                enabled: true,
              },
            },
          },
        },
        onlyPluginIds: ["sample-bundle"],
        workspaceDir,
      }),
    );

    const plugin = registry.plugins.find((entry) => entry.id === "sample-bundle");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.format).toBe("bundle");
    expect(plugin?.bundleFormat).toBe("codex");
    expect(plugin?.bundleCapabilities).toContain("skills");
  });

  it.each([
    {
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
        fs.writeFileSync(
          path.join(bundleRoot, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf8",
        );
      },
      expectedCapabilities: ["skills", "commands", "settings"],
      expectedFormat: "claude",
      name: "treats Claude command roots and settings as supported bundle surfaces",
      pluginId: "claude-skills",
    },
    {
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP",
          }),
          "utf8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              probe: {
                args: ["./probe.mjs"],
                command: "node",
              },
            },
          }),
          "utf8",
        );
      },
      expectedCapabilities: ["mcpServers"],
      expectedFormat: "claude",
      name: "treats bundle MCP as a supported bundle surface",
      pluginId: "claude-mcp",
    },
    {
      build: (bundleRoot: string) => {
        mkdirSafe(path.join(bundleRoot, ".cursor-plugin"));
        mkdirSafe(path.join(bundleRoot, ".cursor", "commands"));
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor-plugin", "plugin.json"),
          JSON.stringify({
            name: "Cursor Skills",
          }),
          "utf8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".cursor", "commands", "review.md"),
          "---\ndescription: fixture\n---\n",
        );
      },
      expectedCapabilities: ["skills", "commands"],
      expectedFormat: "cursor",
      name: "treats Cursor command roots as supported bundle skill surfaces",
      pluginId: "cursor-skills",
    },
  ])("$name", ({ pluginId, expectedFormat, expectedCapabilities, build }) => {
    const registry = loadBundleFixture({ build, pluginId });
    const plugin = registry.plugins.find((entry) => entry.id === pluginId);

    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleFormat).toBe(expectedFormat);
    expect(plugin?.bundleCapabilities).toEqual(expect.arrayContaining(expectedCapabilities));
    expectNoUnwiredBundleDiagnostic(registry, pluginId);
  });

  it("warns when bundle MCP only declares unsupported non-stdio transports", () => {
    const stateDir = makeTempDir();
    const registry = loadBundleFixture({
      build: (bundleRoot) => {
        mkdirSafe(path.join(bundleRoot, ".claude-plugin"));
        fs.writeFileSync(
          path.join(bundleRoot, ".claude-plugin", "plugin.json"),
          JSON.stringify({
            name: "Claude MCP URL",
          }),
          "utf8",
        );
        fs.writeFileSync(
          path.join(bundleRoot, ".mcp.json"),
          JSON.stringify({
            mcpServers: {
              remoteProbe: {
                url: "http://127.0.0.1:8787/mcp",
              },
            },
          }),
          "utf8",
        );
      },
      env: {
        OPENCLAW_HOME: stateDir,
      },
      pluginId: "claude-mcp-url",
    });

    const plugin = registry.plugins.find((entry) => entry.id === "claude-mcp-url");
    expect(plugin?.status).toBe("loaded");
    expect(plugin?.bundleCapabilities).toEqual(expect.arrayContaining(["mcpServers"]));
    expect(
      registry.diagnostics.some(
        (diag) =>
          diag.pluginId === "claude-mcp-url" &&
          diag.message.includes("stdio only today") &&
          diag.message.includes("remoteProbe"),
      ),
    ).toBe(true);
  });
});
