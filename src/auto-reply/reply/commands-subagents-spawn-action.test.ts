import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnSubagentResult } from "../../agents/subagent-spawn.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { handleSubagentsSpawnAction } from "./commands-subagents/action-spawn.js";
import type { HandleCommandsParams } from "./commands-types.js";
import type { InlineDirectives } from "./directive-handling.js";

const spawnSubagentDirectMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => spawnSubagentDirectMock(...args),
}));

function acceptedResult(overrides?: Partial<SpawnSubagentResult>): SpawnSubagentResult {
  return {
    childSessionKey: "agent:beta:subagent:test-uuid",
    runId: "run-spawn-1",
    status: "accepted",
    ...overrides,
  };
}

function forbiddenResult(error: string): SpawnSubagentResult {
  return {
    error,
    status: "forbidden",
  };
}

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildContext(params?: {
  cfg?: OpenClawConfig;
  requesterKey?: string;
  restTokens?: string[];
  commandTo?: string | undefined;
  context?: Partial<HandleCommandsParams["ctx"]>;
  sessionEntry?: SessionEntry | undefined;
}) {
  const directives: InlineDirectives = {
    cleaned: "",
    hasElevatedDirective: false,
    hasExecDirective: false,
    hasExecOptions: false,
    hasFastDirective: false,
    hasModelDirective: false,
    hasQueueDirective: false,
    hasQueueOptions: false,
    hasReasoningDirective: false,
    hasStatusDirective: false,
    hasThinkDirective: false,
    hasVerboseDirective: false,
    invalidExecAsk: false,
    invalidExecHost: false,
    invalidExecNode: false,
    invalidExecSecurity: false,
    queueReset: false,
  };
  const ctx = {
    AccountId: "default",
    MessageThreadId: "thread-1",
    OriginatingChannel: "whatsapp",
    OriginatingTo: "channel:origin",
    ...params?.context,
  };
  return {
    handledPrefix: "/subagents",
    params: {
      cfg: params?.cfg ?? baseCfg,
      command: {
        channel: "whatsapp",
        commandBodyNormalized: "",
        isAuthorizedSender: true,
        ownerList: [],
        rawBodyNormalized: "",
        senderIsOwner: true,
        surface: "whatsapp",
        to: params?.commandTo ?? "channel:command",
      },
      contextTokens: 0,
      ctx,
      defaultGroupActivation: () => "mention",
      directives,
      elevated: { allowed: false, enabled: false, failures: [] },
      isGroup: true,
      model: "test-model",
      provider: "whatsapp",
      resolveDefaultThinkingLevel: async () => undefined,
      resolvedReasoningLevel: "off",
      resolvedVerboseLevel: "off",
      sessionKey: "agent:main:main",
      workspaceDir: "/tmp/openclaw-subagents-spawn",
      ...(params?.sessionEntry ? { sessionEntry: params.sessionEntry } : {}),
    },
    requesterKey: params?.requesterKey ?? "agent:main:main",
    restTokens: params?.restTokens ?? ["beta", "do", "the", "thing"],
    runs: [],
  } satisfies Parameters<typeof handleSubagentsSpawnAction>[0];
}

describe("subagents spawn action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows usage when agentId is missing", async () => {
    const result = await handleSubagentsSpawnAction(buildContext({ restTokens: [] }));
    expect(result).toEqual({
      reply: {
        text: "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
      },
      shouldContinue: false,
    });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("shows usage when task is missing", async () => {
    const result = await handleSubagentsSpawnAction(buildContext({ restTokens: ["beta"] }));
    expect(result).toEqual({
      reply: {
        text: "Usage: /subagents spawn <agentId> <task> [--model <model>] [--thinking <level>]",
      },
      shouldContinue: false,
    });
    expect(spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("spawns a subagent and formats the success reply", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    const result = await handleSubagentsSpawnAction(buildContext());
    expect(result).toEqual({
      reply: {
        text: "Spawned subagent beta (session agent:beta:subagent:test-uuid, run run-spaw).",
      },
      shouldContinue: false,
    });
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "beta",
        cleanup: "keep",
        expectsCompletionMessage: true,
        mode: "run",
        task: "do the thing",
      }),
      expect.objectContaining({
        agentAccountId: "default",
        agentChannel: "whatsapp",
        agentSessionKey: "agent:main:main",
        agentThreadId: "thread-1",
        agentTo: "channel:origin",
      }),
    );
  });

  it("passes --model through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult({ modelApplied: true }));
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--model", "openai/gpt-4o"],
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/gpt-4o",
        task: "do the thing",
      }),
      expect.anything(),
    );
  });

  it("passes --thinking through to spawnSubagentDirect", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        restTokens: ["beta", "do", "the", "thing", "--thinking", "high"],
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "do the thing",
        thinking: "high",
      }),
      expect.anything(),
    );
  });

  it("passes group context from the session entry", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        sessionEntry: {
          groupChannel: "#group-channel",
          groupId: "group-1",
          sessionId: "session-1",
          space: "workspace-1",
          updatedAt: Date.now(),
        },
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentGroupChannel: "#group-channel",
        agentGroupId: "group-1",
        agentGroupSpace: "workspace-1",
      }),
    );
  });

  it("uses the requester key chosen by earlier routing", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        context: {
          CommandSource: "native",
          CommandTargetSessionKey: "agent:main:target",
          OriginatingChannel: "discord",
          OriginatingTo: "channel:12345",
        },
        requesterKey: "agent:main:target",
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentChannel: "discord",
        agentSessionKey: "agent:main:target",
        agentTo: "channel:12345",
      }),
    );
  });

  it("falls back to OriginatingTo when command.to is missing", async () => {
    spawnSubagentDirectMock.mockResolvedValue(acceptedResult());
    await handleSubagentsSpawnAction(
      buildContext({
        commandTo: undefined,
        context: {
          OriginatingChannel: "whatsapp",
          OriginatingTo: "channel:manual",
          To: "channel:fallback-from-to",
        },
      }),
    );
    expect(spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentTo: "channel:manual",
      }),
    );
  });

  it("formats forbidden spawn failures", async () => {
    spawnSubagentDirectMock.mockResolvedValue(
      forbiddenResult("agentId is not allowed for sessions_spawn (allowed: alpha)"),
    );
    const result = await handleSubagentsSpawnAction(buildContext());
    expect(result).toEqual({
      reply: {
        text: "Spawn failed: agentId is not allowed for sessions_spawn (allowed: alpha)",
      },
      shouldContinue: false,
    });
  });
});
