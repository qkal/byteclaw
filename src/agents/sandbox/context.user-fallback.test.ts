import { describe, expect, it } from "vitest";
import { resolveSandboxDockerUser } from "./context.js";
import type { SandboxDockerConfig } from "./types.js";

const baseDocker: SandboxDockerConfig = {
  capDrop: ["ALL"],
  containerPrefix: "openclaw-sandbox-",
  image: "ghcr.io/example/sandbox:latest",
  network: "none",
  readOnlyRoot: true,
  tmpfs: ["/tmp"],
  workdir: "/workspace",
};

describe("resolveSandboxDockerUser", () => {
  it("keeps configured docker.user", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: { ...baseDocker, user: "2000:2000" },
      stat: async () => ({ gid: 1000, uid: 1000 }),
      workspaceDir: "/tmp/unused",
    });
    expect(resolved.user).toBe("2000:2000");
  });

  it("falls back to workspace ownership when docker.user is unset", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: baseDocker,
      stat: async () => ({ gid: 1002, uid: 1001 }),
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBe("1001:1002");
  });

  it("leaves docker.user unset when workspace stat fails", async () => {
    const resolved = await resolveSandboxDockerUser({
      docker: baseDocker,
      stat: async () => {
        throw new Error("ENOENT");
      },
      workspaceDir: "/tmp/workspace",
    });
    expect(resolved.user).toBeUndefined();
  });
});
