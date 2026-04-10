import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";

type AssertSandboxPath = typeof import("./sandbox-paths.js").assertSandboxPath;

const mocks = vi.hoisted(() => ({
  assertSandboxPath: vi.fn<AssertSandboxPath>(async () => ({
    relative: "",
    resolved: "/tmp/root",
  })),
}));

vi.mock("./sandbox-paths.js", () => ({
  assertSandboxPath: mocks.assertSandboxPath,
}));

function createToolHarness() {
  const execute = vi.fn(async () => ({
    content: [{ text: "ok", type: "text" }],
  }));
  const tool = {
    description: "test tool",
    execute,
    inputSchema: { properties: {}, type: "object" },
    name: "read",
  } as unknown as AnyAgentTool;
  return { execute, tool };
}

async function loadModule() {
  ({ wrapToolWorkspaceRootGuardWithOptions } = await import("./pi-tools.read.js"));
}

let wrapToolWorkspaceRootGuardWithOptions: typeof import("./pi-tools.read.js").wrapToolWorkspaceRootGuardWithOptions;

describe("wrapToolWorkspaceRootGuardWithOptions", () => {
  const root = "/tmp/root";
  const assertSandboxPathImpl: AssertSandboxPath = async ({ filePath }) => ({
    relative: "",
    resolved:
      filePath.startsWith("file://") || path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath),
  });

  beforeAll(loadModule);

  beforeEach(() => {
    mocks.assertSandboxPath.mockReset();
    mocks.assertSandboxPath.mockImplementation(assertSandboxPathImpl);
  });

  it("maps container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc1", { path: "/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: path.resolve(root, "docs", "readme.md"),
      root,
    });
  });

  it("maps file:// container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc2", { path: "file:///workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: path.resolve(root, "docs", "readme.md"),
      root,
    });
  });

  it("does not remap remote-host file:// paths", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-remote-file-url", { path: "file://attacker/share/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: "file://attacker/share/readme.md",
      root,
    });
  });

  it("maps @-prefixed container workspace paths to host workspace root", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-container", { path: "@/workspace/docs/readme.md" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: path.resolve(root, "docs", "readme.md"),
      root,
    });
  });

  it("normalizes @-prefixed absolute paths before guard checks", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-at-absolute", { path: "@/etc/passwd" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: "/etc/passwd",
      root,
    });
  });

  it("does not remap absolute paths outside the configured container workdir", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc3", { path: "/workspace-two/secret.txt" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: "/workspace-two/secret.txt",
      root,
    });
  });

  it("does not guard outPath by default", async () => {
    const { tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
    });

    await wrapped.execute("tc-outpath-default", { outPath: "/workspace/videos/capture.mp4" });

    expect(mocks.assertSandboxPath).not.toHaveBeenCalled();
  });

  it("guards custom outPath params when configured", async () => {
    const { execute, tool } = createToolHarness();
    const wrapped = wrapToolWorkspaceRootGuardWithOptions(tool, root, {
      containerWorkdir: "/workspace",
      normalizeGuardedPathParams: true,
      pathParamKeys: ["outPath"],
    });

    await wrapped.execute("tc-outpath-custom", { outPath: "videos/capture.mp4" });

    expect(mocks.assertSandboxPath).toHaveBeenCalledWith({
      cwd: root,
      filePath: "videos/capture.mp4",
      root,
    });
    expect(execute).toHaveBeenCalledWith(
      "tc-outpath-custom",
      { outPath: path.resolve(root, "videos", "capture.mp4") },
      undefined,
      undefined,
    );
  });
});
