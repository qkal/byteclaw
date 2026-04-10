import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handleCompactCommand } from "./commands-compact.js";
import type { HandleCommandsParams } from "./commands-types.js";

vi.mock("./commands-compact.runtime.js", () => ({
  abortEmbeddedPiRun: vi.fn(),
  compactEmbeddedPiSession: vi.fn(),
  enqueueSystemEvent: vi.fn(),
  formatContextUsageShort: vi.fn(() => "Context 12.1k"),
  formatTokenCount: vi.fn((value: number) => `${value}`),
  incrementCompactionCount: vi.fn(),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  resolveFreshSessionTotalTokens: vi.fn(() => 12_345),
  resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
  resolveSessionFilePathOptions: vi.fn(() => ({})),
  waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(undefined),
}));

const { compactEmbeddedPiSession } = await import("./commands-compact.runtime.js");

function buildCompactParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    command: {
      channel: "whatsapp",
      commandBodyNormalized,
      isAuthorizedSender: true,
      ownerList: [],
      senderId: "owner",
      senderIsOwner: false,
    },
    ctx: {
      CommandBody: commandBodyNormalized,
      CommandSource: "text",
      Provider: "whatsapp",
      Surface: "whatsapp",
    },
    resolveDefaultThinkingLevel: async () => "medium",
    sessionKey: "agent:main:main",
    sessionStore: {},
  } as unknown as HandleCommandsParams;
}

describe("handleCompactCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when command is not /compact", async () => {
    const result = await handleCompactCommand(
      buildCompactParams("/status", {
        channels: { whatsapp: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig),
      true,
    );

    expect(result).toBeNull();
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("rejects unauthorized /compact commands", async () => {
    const params = buildCompactParams("/compact", {
      channels: { whatsapp: { allowFrom: ["*"] } },
      commands: { text: true },
    } as OpenClawConfig);

    const result = await handleCompactCommand(
      {
        ...params,
        command: {
          ...params.command,
          isAuthorizedSender: false,
          senderId: "unauthorized",
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result).toEqual({ shouldContinue: false });
    expect(vi.mocked(compactEmbeddedPiSession)).not.toHaveBeenCalled();
  });

  it("routes manual compaction with explicit trigger and context metadata", async () => {
    vi.mocked(compactEmbeddedPiSession).mockResolvedValueOnce({
      compacted: false,
      ok: true,
    });

    const result = await handleCompactCommand(
      {
        ...buildCompactParams("/compact", {
          channels: { whatsapp: { allowFrom: ["*"] } },
          commands: { text: true },
          session: { store: "/tmp/openclaw-session-store.json" },
        } as OpenClawConfig),
        agentDir: "/tmp/openclaw-agent-compact",
        ctx: {
          CommandBody: "/compact: focus on decisions",
          CommandSource: "text",
          From: "+15550001",
          Provider: "whatsapp",
          Surface: "whatsapp",
          To: "+15550002",
        },
        sessionEntry: {
          groupChannel: "#general",
          groupId: "group-1",
          sessionId: "session-1",
          space: "workspace-1",
          spawnedBy: "agent:main:parent",
          totalTokens: 12_345,
          updatedAt: Date.now(),
        },
      } as HandleCommandsParams,
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledOnce();
    expect(vi.mocked(compactEmbeddedPiSession)).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw-agent-compact",
        allowGatewaySubagentBinding: true,
        customInstructions: "focus on decisions",
        groupChannel: "#general",
        groupId: "group-1",
        groupSpace: "workspace-1",
        messageChannel: "whatsapp",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:parent",
        trigger: "manual",
      }),
    );
  });
});
