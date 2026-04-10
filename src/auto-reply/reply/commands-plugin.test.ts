import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handlePluginCommand } from "./commands-plugin.js";
import type { HandleCommandsParams } from "./commands-types.js";

const matchPluginCommandMock = vi.hoisted(() => vi.fn());
const executePluginCommandMock = vi.hoisted(() => vi.fn());

vi.mock("../../plugins/commands.js", () => ({
  executePluginCommand: executePluginCommandMock,
  matchPluginCommand: matchPluginCommandMock,
}));

function buildPluginParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
): HandleCommandsParams {
  return {
    cfg,
    command: {
      channel: "whatsapp",
      channelId: "whatsapp",
      commandBodyNormalized,
      from: "test-user",
      isAuthorizedSender: true,
      senderId: "owner",
      to: "test-bot",
    },
    ctx: {
      AccountId: undefined,
      CommandSource: "text",
      GatewayClientScopes: ["operator.write", "operator.pairing"],
      Provider: "whatsapp",
      Surface: "whatsapp",
    },
    sessionEntry: {
      sessionId: "session-plugin-command",
      updatedAt: Date.now(),
    },
    sessionKey: "agent:main:whatsapp:direct:test-user",
  } as unknown as HandleCommandsParams;
}

describe("handlePluginCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("dispatches registered plugin commands with gateway scopes and session metadata", async () => {
    matchPluginCommandMock.mockReturnValue({
      args: "",
      command: { name: "card" },
    });
    executePluginCommandMock.mockResolvedValue({ text: "from plugin" });

    const result = await handlePluginCommand(
      buildPluginParams("/card", {
        channels: { whatsapp: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig),
      true,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("from plugin");
    expect(executePluginCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        commandBody: "/card",
        gatewayClientScopes: ["operator.write", "operator.pairing"],
        sessionId: "session-plugin-command",
        sessionKey: "agent:main:whatsapp:direct:test-user",
      }),
    );
  });
});
