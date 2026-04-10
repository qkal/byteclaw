import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HandleCommandsParams } from "./commands-types.js";

const { createOpenClawCodingToolsMock } = vi.hoisted(() => ({
  createOpenClawCodingToolsMock: vi.fn(() => []),
}));

vi.mock("../../agents/bootstrap-files.js", () => ({
  resolveBootstrapContextForRun: vi.fn(async () => ({
    bootstrapFiles: [],
    contextFiles: [],
  })),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ mode: "off", sandboxed: false })),
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => ({ prompt: "", resolvedSkills: [], skills: [] })),
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => "test-snapshot"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: vi.fn(() => undefined),
  resolveSessionAgentIds: vi.fn(() => ({ sessionAgentId: "main" })),
}));

vi.mock("../../agents/model-selection.js", () => ({
  resolveDefaultModelForAgent: vi.fn(() => ({ model: "gpt-5", provider: "openai" })),
}));

vi.mock("../../agents/system-prompt-params.js", () => ({
  buildSystemPromptParams: vi.fn(() => ({
    runtimeInfo: { arch: "unknown", host: "unknown", node: process.version, os: "unknown" },
    userTime: "12:00 PM",
    userTimeFormat: "12h",
    userTimezone: "UTC",
  })),
}));

vi.mock("../../agents/system-prompt.js", () => ({
  buildAgentSystemPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => false),
}));

function makeParams(): HandleCommandsParams {
  return {
    agentId: "main",
    cfg: {},
    command: {
      channel: "telegram",
      commandBodyNormalized: "/context",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: "/context",
      senderIsOwner: true,
      surface: "telegram",
    },
    contextTokens: 0,
    ctx: {
      SessionKey: "agent:main:default",
    },
    defaultGroupActivation: () => "mention",
    directives: {},
    elevated: {
      allowed: true,
      enabled: true,
      failures: [],
    },
    isGroup: false,
    model: "gpt-5.4",
    provider: "openai",
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedElevatedLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionEntry: {
      groupChannel: "#general",
      groupId: "group-1",
      sessionId: "session-1",
      space: "guild-1",
      spawnedBy: "agent:parent",
    },
    sessionKey: "agent:main:default",
    workspaceDir: "/tmp/workspace",
  } as unknown as HandleCommandsParams;
}

describe("resolveCommandsSystemPromptBundle", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    createOpenClawCodingToolsMock.mockClear();
    createOpenClawCodingToolsMock.mockReturnValue([]);
    const piTools = await import("../../agents/pi-tools.js");
    vi.spyOn(piTools, "createOpenClawCodingTools").mockImplementation(
      createOpenClawCodingToolsMock,
    );
    const ttsRuntime = await import("../../tts/tts.js");
    vi.spyOn(ttsRuntime, "buildTtsSystemPromptHint").mockReturnValue(undefined);
  });

  it("opts command tool builds into gateway subagent binding", async () => {
    const { resolveCommandsSystemPromptBundle } = await import("./commands-system-prompt.js");
    await resolveCommandsSystemPromptBundle(makeParams());

    expect(createOpenClawCodingToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowGatewaySubagentBinding: true,
        messageProvider: "telegram",
        sessionKey: "agent:main:default",
        workspaceDir: "/tmp/workspace",
      }),
    );
  });
});
