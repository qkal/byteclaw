import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSandboxFsMounts,
  parseSandboxBindMount,
  resolveSandboxFsPathWithMounts,
} from "./fs-paths.js";
import { createSandboxTestContext } from "./test-fixtures.js";
import type { SandboxContext } from "./types.js";

function createSandbox(overrides?: Partial<SandboxContext>): SandboxContext {
  return createSandboxTestContext({ overrides });
}

describe("parseSandboxBindMount", () => {
  it("parses bind mode and writeability", () => {
    expect(parseSandboxBindMount("/tmp/a:/workspace-a:ro")).toEqual({
      containerRoot: "/workspace-a",
      hostRoot: path.resolve("/tmp/a"),
      writable: false,
    });
    expect(parseSandboxBindMount("/tmp/b:/workspace-b:rw")).toEqual({
      containerRoot: "/workspace-b",
      hostRoot: path.resolve("/tmp/b"),
      writable: true,
    });
  });

  it("parses Windows drive-letter host paths", () => {
    expect(parseSandboxBindMount(String.raw`C:\Users\kai\workspace:/workspace:ro`)).toEqual({
      containerRoot: "/workspace",
      hostRoot: path.resolve(String.raw`C:\Users\kai\workspace`),
      writable: false,
    });
    expect(parseSandboxBindMount("D:/data:/workspace-data:rw")).toEqual({
      containerRoot: "/workspace-data",
      hostRoot: path.resolve("D:/data"),
      writable: true,
    });
  });

  it("parses UNC-style host paths", () => {
    expect(parseSandboxBindMount("//server/share:/workspace:ro")).toEqual({
      containerRoot: "/workspace",
      hostRoot: path.resolve("//server/share"),
      writable: false,
    });
  });
});

describe("resolveSandboxFsPathWithMounts", () => {
  it("maps mounted container absolute paths to host paths", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/workspace-two:/workspace-two:ro"],
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      cwd: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      filePath: "/workspace-two/docs/AGENTS.md",
      mounts,
    });

    expect(resolved.hostPath).toBe(
      path.join(path.resolve("/tmp/workspace-two"), "docs", "AGENTS.md"),
    );
    expect(resolved.containerPath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.relativePath).toBe("/workspace-two/docs/AGENTS.md");
    expect(resolved.writable).toBe(false);
  });

  it("keeps workspace-relative display paths for default workspace files", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      cwd: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      filePath: "src/index.ts",
      mounts,
    });
    expect(resolved.hostPath).toBe(path.join(path.resolve("/tmp/workspace"), "src", "index.ts"));
    expect(resolved.containerPath).toBe("/workspace/src/index.ts");
    expect(resolved.relativePath).toBe("src/index.ts");
    expect(resolved.writable).toBe(true);
  });

  it("preserves legacy sandbox-root error for outside paths", () => {
    const sandbox = createSandbox();
    const mounts = buildSandboxFsMounts(sandbox);
    expect(() =>
      resolveSandboxFsPathWithMounts({
        cwd: sandbox.workspaceDir,
        defaultContainerRoot: sandbox.containerWorkdir,
        defaultWorkspaceRoot: sandbox.workspaceDir,
        filePath: "/etc/passwd",
        mounts,
      }),
    ).toThrow(/Path escapes sandbox root/);
  });

  it("prefers custom bind mounts over default workspace mount at /workspace", () => {
    const sandbox = createSandbox({
      docker: {
        ...createSandbox().docker,
        binds: ["/tmp/override:/workspace:ro"],
      },
    });
    const mounts = buildSandboxFsMounts(sandbox);
    const resolved = resolveSandboxFsPathWithMounts({
      cwd: sandbox.workspaceDir,
      defaultContainerRoot: sandbox.containerWorkdir,
      defaultWorkspaceRoot: sandbox.workspaceDir,
      filePath: "/workspace/docs/AGENTS.md",
      mounts,
    });

    expect(resolved.hostPath).toBe(path.join(path.resolve("/tmp/override"), "docs", "AGENTS.md"));
    expect(resolved.writable).toBe(false);
  });
});
