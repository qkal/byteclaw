import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./tools/common.js";

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn(async (params: { filePath: string; cwd: string; root: string }) => {
    const root = `/${params.root.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`;
    const candidate = params.filePath.replace(/\\/g, "/");
    const input = candidate.startsWith("/") ? candidate : `${root}/${candidate}`;
    const segments = input.split("/");
    const stack: string[] = [];
    for (const segment of segments) {
      if (!segment || segment === ".") {
        continue;
      }
      if (segment === "..") {
        stack.pop();
        continue;
      }
      stack.push(segment);
    }
    const resolved = `/${stack.join("/")}`;
    const inside = resolved === root || resolved.startsWith(`${root}/`);
    if (!inside) {
      throw new Error(`Path escapes sandbox root (${root}): ${params.filePath}`);
    }
    const relative = resolved === root ? "" : resolved.slice(root.length + 1);
    return { relative, resolved };
  }),
  nodesExecute: vi.fn(async () => ({
    content: [{ text: "ok", type: "text" }],
    details: {},
  })),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

vi.mock("./tools/nodes-tool.js", () => ({
  createNodesTool: () =>
    ({
      description: "nodes test tool",
      execute: mocks.nodesExecute,
      label: "Nodes",
      name: "nodes",
      parameters: {
        properties: {},
        type: "object",
      },
    }) as unknown as AnyAgentTool,
}));

let createOpenClawTools: typeof import("./openclaw-tools.js").createOpenClawTools;

const WORKSPACE_ROOT = "/tmp/openclaw-workspace-nodes-guard";

describe("createOpenClawTools nodes workspace guard", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ createOpenClawTools } = await import("./openclaw-tools.js"));
  });

  beforeEach(() => {
    mocks.assertSandboxPath.mockClear();
    mocks.nodesExecute.mockClear();
  });

  function getNodesTool(
    workspaceOnly: boolean,
    options?: { sandboxRoot?: string; sandboxContainerWorkdir?: string },
  ): AnyAgentTool {
    const tools = createOpenClawTools({
      disableMessageTool: true,
      disablePluginTools: true,
      fsPolicy: { workspaceOnly },
      sandboxContainerWorkdir: options?.sandboxContainerWorkdir,
      sandboxRoot: options?.sandboxRoot,
      workspaceDir: WORKSPACE_ROOT,
    });
    const nodesTool = tools.find((tool) => tool.name === "nodes");
    expect(nodesTool).toBeDefined();
    if (!nodesTool) {
      throw new Error("missing nodes tool");
    }
    return nodesTool;
  }

  it("guards outPath when workspaceOnly is enabled", async () => {
    const nodesTool = getNodesTool(true);
    await nodesTool.execute("call-1", {
      action: "screen_record",
      outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: WORKSPACE_ROOT,
      filePath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      root: WORKSPACE_ROOT,
    });
    expect(mocks.nodesExecute).toHaveBeenCalledTimes(1);
  });

  it("normalizes relative outPath to an absolute workspace path before execute", async () => {
    const nodesTool = getNodesTool(true);
    await nodesTool.execute("call-rel", {
      action: "screen_record",
      outPath: "videos/capture.mp4",
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: WORKSPACE_ROOT,
      filePath: "videos/capture.mp4",
      root: WORKSPACE_ROOT,
    });
    expect(mocks.nodesExecute).toHaveBeenCalledWith(
      "call-rel",
      {
        action: "screen_record",
        outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      },
      undefined,
      undefined,
    );
  });

  it("maps sandbox container outPath to host root when containerWorkdir is provided", async () => {
    const nodesTool = getNodesTool(true, {
      sandboxContainerWorkdir: "/workspace",
      sandboxRoot: WORKSPACE_ROOT,
    });
    await nodesTool.execute("call-sandbox", {
      action: "screen_record",
      outPath: "/workspace/videos/capture.mp4",
    });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: WORKSPACE_ROOT,
      filePath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      root: WORKSPACE_ROOT,
    });
    expect(mocks.nodesExecute).toHaveBeenCalledWith(
      "call-sandbox",
      {
        action: "screen_record",
        outPath: `${WORKSPACE_ROOT}/videos/capture.mp4`,
      },
      undefined,
      undefined,
    );
  });

  it("rejects outPath outside workspace when workspaceOnly is enabled", async () => {
    const nodesTool = getNodesTool(true);
    await expect(
      nodesTool.execute("call-2", {
        action: "screen_record",
        outPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/Path escapes sandbox root/);

    expect(mocks.assertSandboxPath).toHaveBeenCalledTimes(1);
    expect(mocks.nodesExecute).not.toHaveBeenCalled();
  });

  it("does not guard outPath when workspaceOnly is disabled", async () => {
    const nodesTool = getNodesTool(false);
    await nodesTool.execute("call-3", {
      action: "screen_record",
      outPath: "/etc/passwd",
    });

    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
    expect(mocks.nodesExecute).toHaveBeenCalledTimes(1);
  });
});
