import { describe, expect, it } from "vitest";
import { appendWorkspaceMountArgs } from "./workspace-mounts.js";

describe("appendWorkspaceMountArgs", () => {
  it.each([
    { access: "rw" as const, expected: "/tmp/workspace:/workspace:z" },
    { access: "ro" as const, expected: "/tmp/workspace:/workspace:ro,z" },
    { access: "none" as const, expected: "/tmp/workspace:/workspace:ro,z" },
  ])("sets main mount permissions for workspaceAccess=$access", ({ access, expected }) => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      agentWorkspaceDir: "/tmp/agent-workspace",
      args,
      workdir: "/workspace",
      workspaceAccess: access,
      workspaceDir: "/tmp/workspace",
    });

    expect(args).toContain(expected);
  });

  it("omits agent workspace mount when workspaceAccess is none", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      agentWorkspaceDir: "/tmp/agent-workspace",
      args,
      workdir: "/workspace",
      workspaceAccess: "none",
      workspaceDir: "/tmp/workspace",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z"]);
  });

  it("omits agent workspace mount when paths are identical", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      agentWorkspaceDir: "/tmp/workspace",
      args,
      workdir: "/workspace",
      workspaceAccess: "rw",
      workspaceDir: "/tmp/workspace",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:z"]);
  });

  it("marks split agent workspace mounts shared for SELinux", () => {
    const args: string[] = [];
    appendWorkspaceMountArgs({
      agentWorkspaceDir: "/tmp/agent-workspace",
      args,
      workdir: "/workspace",
      workspaceAccess: "ro",
      workspaceDir: "/tmp/workspace",
    });

    const mounts = args.filter((arg) => arg.startsWith("/tmp/"));
    expect(mounts).toEqual(["/tmp/workspace:/workspace:ro,z", "/tmp/agent-workspace:/agent:ro,z"]);
  });
});
