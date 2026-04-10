import { describe, expect, it } from "vitest";
import { createPiToolsSandboxContext } from "../../test-helpers/pi-tools-sandbox-context.js";
import { resolveAttemptSpawnWorkspaceDir } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt sessions_spawn workspace inheritance", () => {
  it("passes the real workspace to sessions_spawn when workspaceAccess is ro", async () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandboxWorkspace = "/tmp/openclaw-sandbox-workspace";
    const sandbox = createPiToolsSandboxContext({
      agentWorkspaceDir: realWorkspace,
      sessionKey: "agent:main:main",
      tools: { allow: ["sessions_spawn"], deny: [] },
      workspaceAccess: "ro",
      workspaceDir: sandboxWorkspace,
    });

    expect(
      resolveAttemptSpawnWorkspaceDir({
        resolvedWorkspace: realWorkspace,
        sandbox,
      }),
    ).toBe(realWorkspace);
  });

  it("does not override spawned workspace when sandbox workspace is rw", async () => {
    const realWorkspace = "/tmp/openclaw-real-workspace";
    const sandbox = createPiToolsSandboxContext({
      agentWorkspaceDir: realWorkspace,
      sessionKey: "agent:main:main",
      tools: { allow: ["sessions_spawn"], deny: [] },
      workspaceAccess: "rw",
      workspaceDir: realWorkspace,
    });

    expect(
      resolveAttemptSpawnWorkspaceDir({
        resolvedWorkspace: realWorkspace,
        sandbox,
      }),
    ).toBeUndefined();
  });
});
