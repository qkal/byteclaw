import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  waitForFileText,
  writeBundleProbeMcpServer,
  writeClaudeBundle,
} from "./pi-bundle-mcp-test-harness.js";
import {
  __testing,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

describe("session MCP runtime", () => {
  it("keeps colliding sanitized tool definitions stable across catalog order changes", async () => {
    function makeRuntime(
      tools: { toolName: string; description: string }[],
    ): SessionMcpRuntime {
      return {
        callTool: async (_serverName, toolName) => ({
          content: [{ text: String(toolName), type: "text" }],
          isError: false,
        }),
        configFingerprint: "fingerprint",
        createdAt: 0,
        dispose: async () => {},
        getCatalog: async () => ({
          generatedAt: 0,
          servers: {
            collision: {
              launchSummary: "collision",
              serverName: "collision",
              toolCount: tools.length,
            },
          },
          tools: tools.map((tool) => ({
            serverName: "collision",
            safeServerName: "collision",
            toolName: tool.toolName,
            description: tool.description,
            inputSchema: {
              type: "object",
              properties: {
                toolName: { type: "string", const: tool.toolName },
              },
            },
            fallbackDescription: tool.description,
          })),
          version: 1,
        }),
        lastUsedAt: 0,
        markUsed: () => {},
        sessionId: "session-colliding-tools",
        workspaceDir: "/tmp",
      };
    }

    const catalogA = [
      { description: "question", toolName: "alpha?" },
      { description: "bang", toolName: "alpha!" },
    ];
    const catalogB = catalogA.toReversed();

    const materializedA = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogA),
    });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogB),
    });

    const summarizeTools = (runtime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>) =>
      runtime.tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parameters: tool.parameters,
      }));

    expect(summarizeTools(materializedA)).toEqual(summarizeTools(materializedB));
    expect(summarizeTools(materializedA)).toEqual([
      {
        description: "bang",
        name: "collision__alpha-",
        parameters: {
          properties: {
            toolName: { const: "alpha!", type: "string" },
          },
          type: "object",
        },
      },
      {
        description: "question",
        name: "collision__alpha--2",
        parameters: {
          properties: {
            toolName: { const: "alpha?", type: "string" },
          },
          type: "object",
        },
      },
    ]);
  });

  it("reuses the same session runtime across repeated materialization", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
    });
    const runtimeB = await getOrCreateSessionMcpRuntime({
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir,
    });

    const materializedA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const materializedB = await materializeBundleMcpToolsForRun({
      reservedToolNames: ["builtin_tool"],
      runtime: runtimeB,
    });

    expect(runtimeA).toBe(runtimeB);
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).toEqual(["session-a"]);
  });

  it("recreates the session runtime after explicit disposal", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const cfg = {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    };

    const runtimeA = await getOrCreateSessionMcpRuntime({
      cfg,
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    await disposeSessionMcpRuntime("session-b");

    const runtimeB = await getOrCreateSessionMcpRuntime({
      cfg,
      sessionId: "session-b",
      sessionKey: "agent:test:session-b",
      workspaceDir,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeB });

    expect(runtimeA).not.toBe(runtimeB);
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("recreates the session runtime when MCP config changes", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, { startupCounterPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              args: [serverScriptPath],
              command: "node",
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-A",
              },
            },
          },
        },
      },
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
    });
    const toolsA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const resultA = await toolsA.tools[0].execute(
      "call-configured-probe-a",
      {},
      undefined,
      undefined,
    );

    const runtimeB = await getOrCreateSessionMcpRuntime({
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              args: [serverScriptPath],
              command: "node",
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-B",
              },
            },
          },
        },
      },
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir,
    });
    const toolsB = await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    const resultB = await toolsB.tools[0].execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
    expect(resultA.content[0]).toMatchObject({ text: "FROM-CONFIG-A", type: "text" });
    expect(resultB.content[0]).toMatchObject({ text: "FROM-CONFIG-B", type: "text" });
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });

  it("disposes startup-in-flight runtimes without leaking MCP processes", async () => {
    vi.useRealTimers();
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pidPath = path.join(workspaceDir, "bundle.pid");
    const exitMarkerPath = path.join(workspaceDir, "bundle.exit");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, {
      exitMarkerPath,
      pidPath,
      startupCounterPath,
      startupDelayMs: 1000,
    });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      sessionId: "session-d",
      sessionKey: "agent:test:session-d",
      workspaceDir,
    });

    const materializeResult = materializeBundleMcpToolsForRun({ runtime }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    );
    await waitForFileText(pidPath);
    await disposeSessionMcpRuntime("session-d");

    const result = await materializeResult;
    if (result.status !== "rejected") {
      throw new Error("Expected bundle MCP materialization to reject after disposal");
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/disposed/);
    expect(await waitForFileText(exitMarkerPath)).toBe("exited");
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("1");
    expect(__testing.getCachedSessionIds()).not.toContain("session-d");
  });

  it("materialized disposal can retire a manager-owned runtime", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const startupCounterPath = path.join(workspaceDir, "bundle-starts.txt");
    const pidPath = path.join(workspaceDir, "bundle.pid");
    const exitMarkerPath = path.join(workspaceDir, "bundle.exit");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
    const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath, {
      exitMarkerPath,
      pidPath,
      startupCounterPath,
    });
    await writeClaudeBundle({ pluginRoot, serverScriptPath });

    const runtimeA = await getOrCreateSessionMcpRuntime({
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      sessionId: "session-e",
      sessionKey: "agent:test:session-e",
      workspaceDir,
    });
    const materialized = await materializeBundleMcpToolsForRun({
      disposeRuntime: async () => {
        await disposeSessionMcpRuntime("session-e");
      },
      runtime: runtimeA,
    });

    expect(materialized.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(await waitForFileText(pidPath)).toMatch(/^\d+$/);

    await materialized.dispose();

    expect(await waitForFileText(exitMarkerPath)).toBe("exited");
    expect(__testing.getCachedSessionIds()).not.toContain("session-e");

    const runtimeB = await getOrCreateSessionMcpRuntime({
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
      },
      sessionId: "session-e",
      sessionKey: "agent:test:session-e",
      workspaceDir,
    });

    expect(runtimeB).not.toBe(runtimeA);
    await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    expect(await fs.readFile(startupCounterPath, "utf8")).toBe("2");
  });
});
