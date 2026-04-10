import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  return {
    spawnAcpDirectMock,
    spawnSubagentDirectMock,
  };
});

vi.mock("../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
  isSpawnAcpAcceptedResult: (result: { status?: string }) => result?.status === "accepted",
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

describe("sessions_spawn tool", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
      status: "accepted",
    });
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
      status: "accepted",
    });
  });

  it("uses subagent runtime by default", async () => {
    const tool = createSessionsSpawnTool({
      agentAccountId: "default",
      agentChannel: "discord",
      agentSessionKey: "agent:main:main",
      agentThreadId: "456",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call-1", {
      agentId: "main",
      cleanup: "keep",
      mode: "session",
      model: "anthropic/claude-sonnet-4-6",
      runTimeoutSeconds: 5,
      task: "build feature",
      thinking: "medium",
      thread: true,
    });

    expect(result.details).toMatchObject({
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
      status: "accepted",
    });
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        cleanup: "keep",
        mode: "session",
        model: "anthropic/claude-sonnet-4-6",
        runTimeoutSeconds: 5,
        task: "build feature",
        thinking: "medium",
        thread: true,
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("supports legacy timeoutSeconds alias", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-timeout-alias", {
      task: "do thing",
      timeoutSeconds: 2,
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runTimeoutSeconds: 2,
        task: "do thing",
      }),
      expect.any(Object),
    );
  });

  it("passes inherited workspaceDir from tool context, not from tool args", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/parent/workspace",
    });

    await tool.execute("call-ws", {
      task: "inspect AGENTS",
      workspaceDir: "/tmp/attempted-override",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceDir: "/parent/workspace",
      }),
    );
  });

  it("passes lightContext through to subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-light", {
      lightContext: true,
      task: "summarize this",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lightContext: true,
        task: "summarize this",
      }),
      expect.any(Object),
    );
  });

  it('rejects lightContext when runtime is not "subagent"', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await expect(
      tool.execute("call-light-acp", {
        lightContext: true,
        runtime: "acp",
        task: "summarize this",
      }),
    ).rejects.toThrow("lightContext is only supported for runtime='subagent'.");

    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("routes to ACP runtime when runtime=acp", async () => {
    const tool = createSessionsSpawnTool({
      agentAccountId: "default",
      agentChannel: "discord",
      agentSessionKey: "agent:main:main",
      agentThreadId: "456",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call-2", {
      agentId: "codex",
      cwd: "/workspace",
      mode: "session",
      runtime: "acp",
      streamTo: "parent",
      task: "investigate the failing CI run",
      thread: true,
    });

    expect(result.details).toMatchObject({
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
      status: "accepted",
    });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        cwd: "/workspace",
        mode: "session",
        streamTo: "parent",
        task: "investigate the failing CI run",
        thread: true,
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("forwards ACP sandbox options and requester sandbox context", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      sandboxed: true,
    });

    await tool.execute("call-2b", {
      agentId: "codex",
      runtime: "acp",
      sandbox: "require",
      task: "investigate",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandbox: "require",
        task: "investigate",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:subagent:parent",
        sandboxed: true,
      }),
    );
  });

  it("passes resumeSessionId through to ACP spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-2c", {
      agentId: "codex",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      runtime: "acp",
      task: "resume prior work",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
        task: "resume prior work",
      }),
      expect.any(Object),
    );
  });

  it("rejects resumeSessionId without runtime=acp", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-guard", {
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      task: "resume prior work",
    });

    expect(JSON.stringify(result)).toContain("resumeSessionId is only supported for runtime=acp");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects attachments for ACP runtime", async () => {
    const tool = createSessionsSpawnTool({
      agentAccountId: "default",
      agentChannel: "discord",
      agentSessionKey: "agent:main:main",
      agentThreadId: "456",
      agentTo: "channel:123",
    });

    const result = await tool.execute("call-3", {
      attachments: [{ content: "hello", encoding: "utf8", name: "a.txt" }],
      runtime: "acp",
      task: "analyze file",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("attachments are currently unsupported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it('rejects streamTo when runtime is not "acp"', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-3b", {
      runtime: "subagent",
      streamTo: "parent",
      task: "analyze file",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("streamTo is only supported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("keeps attachment content schema unconstrained for llama.cpp grammar safety", () => {
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        attachments?: {
          items?: {
            properties?: {
              content?: {
                type?: string;
                maxLength?: number;
              };
            };
          };
        };
      };
    };

    const contentSchema = schema.properties?.attachments?.items?.properties?.content;
    expect(contentSchema?.type).toBe("string");
    expect(contentSchema?.maxLength).toBeUndefined();
  });
});
