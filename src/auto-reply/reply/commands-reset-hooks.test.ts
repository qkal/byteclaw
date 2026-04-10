import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineDirectives } from "./directive-handling.parse.js";

const triggerInternalHookMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const resetMocks = vi.hoisted(() => ({
  resetConfiguredBindingTargetInPlace: vi.fn().mockResolvedValue({ ok: true as const }),
  resolveBoundAcpThreadSessionKey: vi.fn(() => undefined as string | undefined),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: (
    type: string,
    action: string,
    sessionKey: string,
    context: Record<string, unknown>,
  ) => ({
    action,
    context,
    messages: [],
    sessionKey,
    timestamp: new Date(0),
    type,
  }),
  triggerInternalHook: triggerInternalHookMock,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../commands-registry.js", () => ({
  normalizeCommandBody: (raw: string) => raw.trim(),
  shouldHandleTextCommands: () => true,
}));

vi.mock("../../channels/plugins/binding-targets.js", () => ({
  resetConfiguredBindingTargetInPlace: resetMocks.resetConfiguredBindingTargetInPlace,
}));

vi.mock("./commands-acp/targets.js", () => ({
  resolveBoundAcpThreadSessionKey: resetMocks.resolveBoundAcpThreadSessionKey,
}));

vi.mock("./commands-handlers.runtime.js", () => ({
  loadCommandHandlers: () => [],
}));

function buildResetParams(
  commandBody: string,
  cfg: OpenClawConfig,
  ctxOverrides?: Partial<MsgContext>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandAuthorized: true,
    CommandBody: commandBody,
    CommandSource: "text",
    Provider: "whatsapp",
    SessionKey: "agent:main:main",
    Surface: "whatsapp",
    ...ctxOverrides,
  } as MsgContext;

  return {
    cfg,
    command: {
      channel: String(ctx.Surface ?? "whatsapp"),
      channelId: String(ctx.Surface ?? "whatsapp"),
      commandBodyNormalized: commandBody.trim(),
      from: ctx.From ?? "sender",
      isAuthorizedSender: true,
      ownerList: [],
      rawBodyNormalized: commandBody.trim(),
      resetHookTriggered: false,
      senderId: ctx.SenderId ?? "123",
      senderIsOwner: true,
      surface: String(ctx.Surface ?? "whatsapp"),
      to: ctx.To ?? "bot",
    },
    contextTokens: 0,
    ctx,
    defaultGroupActivation: () => "mention",
    directives: parseInlineDirectives(""),
    elevated: { allowed: true, enabled: true, failures: [] },
    isGroup: false,
    model: "test-model",
    provider: "whatsapp",
    resolveDefaultThinkingLevel: async () => undefined,
    resolvedReasoningLevel: "off",
    resolvedVerboseLevel: "off",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/openclaw-commands",
  };
}

describe("handleCommands reset hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMocks.resetConfiguredBindingTargetInPlace.mockResolvedValue({ ok: true });
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(undefined);
  });

  it("triggers hooks for /new commands", async () => {
    const cases = [
      {
        expectedCall: expect.objectContaining({ action: "new", type: "command" }),
        name: "text command with arguments",
        params: buildResetParams("/new take notes", {
          channels: { whatsapp: { allowFrom: ["*"] } },
          commands: { text: true },
        } as OpenClawConfig),
      },
      {
        expectedCall: expect.objectContaining({
          action: "new",
          context: expect.objectContaining({
            workspaceDir: "/tmp/openclaw-commands",
          }),
          sessionKey: "agent:main:telegram:direct:123",
          type: "command",
        }),
        name: "native command routed to target session",
        params: (() => {
          const params = buildResetParams(
            "/new",
            {
              channels: { telegram: { allowFrom: ["*"] } },
              commands: { text: true },
            } as OpenClawConfig,
            {
              CommandAuthorized: true,
              CommandSource: "native",
              CommandTargetSessionKey: "agent:main:telegram:direct:123",
              From: "telegram:123",
              Provider: "telegram",
              SenderId: "123",
              SessionKey: "telegram:slash:123",
              Surface: "telegram",
              To: "slash:123",
            },
          );
          params.sessionKey = "agent:main:telegram:direct:123";
          return params;
        })(),
      },
    ] as const;

    for (const testCase of cases) {
      await maybeHandleResetCommand(testCase.params);
      expect(triggerInternalHookMock, testCase.name).toHaveBeenCalledWith(testCase.expectedCall);
      triggerInternalHookMock.mockClear();
    }
  });

  it("uses gateway session reset for bound ACP sessions", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildResetParams(
      "/reset",
      {
        channels: { discord: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(resetMocks.resetConfiguredBindingTargetInPlace).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      commandSource: "discord:native",
      reason: "reset",
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    });
    expect(result).toEqual({
      reply: { text: "✅ ACP session reset in place." },
      shouldContinue: false,
    });
    expect(triggerInternalHookMock).not.toHaveBeenCalled();
    expect(params.command.resetHookTriggered).toBe(true);
  });

  it("keeps tail dispatch after a bound ACP reset", async () => {
    resetMocks.resolveBoundAcpThreadSessionKey.mockReturnValue(
      "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    );
    const params = buildResetParams(
      "/new who are you",
      {
        channels: { discord: { allowFrom: ["*"] } },
        commands: { text: true },
      } as OpenClawConfig,
      {
        CommandSource: "native",
        Provider: "discord",
        Surface: "discord",
      },
    );

    const result = await maybeHandleResetCommand(params);

    expect(result).toEqual({ shouldContinue: false });
    expect(params.ctx.Body).toBe("who are you");
    expect(params.ctx.CommandBody).toBe("who are you");
    expect(params.ctx.AcpDispatchTailAfterReset).toBe(true);
  });
});
