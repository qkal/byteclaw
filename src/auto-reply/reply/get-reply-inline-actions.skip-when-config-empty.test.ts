import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { stripInlineStatus } from "./reply-inline.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();
const getChannelPluginMock = vi.fn();
const createOpenClawToolsMock = vi.fn();
const buildStatusReplyMock = vi.fn();

let handleInlineActions: typeof import("./get-reply-inline-actions.js").handleInlineActions;
type HandleInlineActionsInput = Parameters<
  typeof import("./get-reply-inline-actions.js").handleInlineActions
>[0];

async function loadFreshInlineActionsModuleForTest() {
  vi.resetModules();
  vi.doMock("./commands.runtime.js", () => ({
    buildStatusReply: (...args: unknown[]) => buildStatusReplyMock(...args),
    handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  }));
  vi.doMock("../../agents/openclaw-tools.runtime.js", () => ({
    createOpenClawTools: (...args: unknown[]) => createOpenClawToolsMock(...args),
  }));
  vi.doMock("../../channels/plugins/index.js", async () => {
    const actual = await vi.importActual<typeof import("../../channels/plugins/index.js")>(
      "../../channels/plugins/index.js",
    );
    return {
      ...actual,
      getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
    };
  });
  ({ handleInlineActions } = await import("./get-reply-inline-actions.js"));
}

const createTypingController = (): TypingController => ({
  cleanup: vi.fn(),
  isActive: () => false,
  markDispatchIdle: () => {},
  markRunComplete: () => {},
  onReplyStart: async () => {},
  refreshTypingTtl: () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
});

const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}): HandleInlineActionsInput => {
  const baseCommand: HandleInlineActionsInput["command"] = {
    abortKey: "whatsapp:+999",
    channel: "whatsapp",
    channelId: "whatsapp",
    commandBodyNormalized: params.cleanedBody,
    from: "whatsapp:+999",
    isAuthorizedSender: false,
    ownerList: [],
    rawBodyNormalized: params.cleanedBody,
    senderId: undefined,
    senderIsOwner: false,
    surface: "whatsapp",
    to: "whatsapp:+999",
  };
  return {
    abortedLastRun: false,
    agentId: "main",
    allowTextCommands: false,
    cfg: {},
    cleanedBody: params.cleanedBody,
    command: {
      ...baseCommand,
      ...params.command,
    },
    contextTokens: 0,
    ctx: params.ctx,
    defaultActivation: () => "always",
    directives: clearInlineDirectives(params.cleanedBody),
    elevatedAllowed: false,
    elevatedEnabled: false,
    elevatedFailures: [],
    inlineStatusRequested: false,
    isGroup: false,
    model: "gpt-4o-mini",
    provider: "openai",
    resolveDefaultThinkingLevel: async () => "off",
    resolvedElevatedLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: undefined,
    sessionCtx: params.ctx as unknown as TemplateContext,
    sessionKey: "s:main",
    sessionScope: "per-sender",
    typing: params.typing,
    workspaceDir: "/tmp",
    ...params.overrides,
  };
};

async function expectInlineActionSkipped(params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Partial<Omit<HandleInlineActionsInput, "ctx" | "sessionCtx" | "typing" | "command">>;
}) {
  const result = await handleInlineActions(createHandleInlineActionsInput(params));
  expect(result).toEqual({ kind: "reply", reply: undefined });
  expect(params.typing.cleanup).toHaveBeenCalled();
  expect(handleCommandsMock).not.toHaveBeenCalled();
}

describe("handleInlineActions", () => {
  beforeEach(async () => {
    handleCommandsMock.mockReset();
    handleCommandsMock.mockResolvedValue({ reply: undefined, shouldContinue: true });
    getChannelPluginMock.mockReset();
    createOpenClawToolsMock.mockReset();
    buildStatusReplyMock.mockReset();
    buildStatusReplyMock.mockResolvedValue({ text: "status" });
    createOpenClawToolsMock.mockReturnValue([]);
    getChannelPluginMock.mockImplementation((channelId?: string) =>
      channelId === "whatsapp"
        ? { commands: { skipWhenConfigEmpty: true } }
        : channelId === "discord"
          ? { mentions: { stripPatterns: () => [String.raw`<@!?\d+>`] } }
          : undefined,
    );
    await loadFreshInlineActionsModuleForTest();
  });

  it("skips whatsapp replies when config is empty and From !== To", async () => {
    const typing = createTypingController();

    const ctx = buildTestCtx({
      Body: "hi",
      From: "whatsapp:+999",
      To: "whatsapp:+123",
    });
    await expectInlineActionSkipped({
      cleanedBody: "hi",
      command: { to: "whatsapp:+123" },
      ctx,
      typing,
    });
  });

  it("forwards agentDir into handleCommands", async () => {
    const typing = createTypingController();

    handleCommandsMock.mockResolvedValue({ reply: { text: "done" }, shouldContinue: false });

    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
    });
    const agentDir = "/tmp/inline-agent";

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: "/status",
        command: {
          abortKey: "sender-1",
          isAuthorizedSender: true,
          senderId: "sender-1",
        },
        ctx,
        overrides: {
          agentDir,
          cfg: { commands: { text: true } },
        },
        typing,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(handleCommandsMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir,
      }),
    );
  });

  it("does not run command handlers after replying to an inline status-only turn", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "/status",
      CommandBody: "/status",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: stripInlineStatus("/status").cleaned,
        command: {
          commandBodyNormalized: "/status",
          isAuthorizedSender: true,
          rawBodyNormalized: "/status",
        },
        ctx,
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
        },
        typing,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("does not continue into the agent after a mention-wrapped inline status-only turn", async () => {
    const typing = createTypingController();
    const ctx = buildTestCtx({
      Body: "<@123> /status",
      ChatType: "channel",
      CommandBody: "<@123> /status",
      Provider: "discord",
      Surface: "discord",
      WasMentioned: true,
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: "<@123>",
        command: {
          channel: "discord",
          channelId: "discord",
          commandBodyNormalized: "<@123> /status",
          isAuthorizedSender: true,
          rawBodyNormalized: "<@123> /status",
          surface: "discord",
        },
        ctx,
        overrides: {
          allowTextCommands: true,
          inlineStatusRequested: true,
          isGroup: true,
        },
        typing,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(buildStatusReplyMock).toHaveBeenCalledTimes(1);
    expect(handleCommandsMock).not.toHaveBeenCalled();
    expect(typing.cleanup).toHaveBeenCalled();
  });

  it("skips stale queued messages that are at or before the /stop cutoff", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
      sessionId: "session-1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "s:main": sessionEntry };
    const ctx = buildTestCtx({
      Body: "old queued message",
      CommandBody: "old queued message",
      MessageSid: "41",
    });

    await expectInlineActionSkipped({
      cleanedBody: "old queued message",
      command: {
        commandBodyNormalized: "old queued message",
        rawBodyNormalized: "old queued message",
      },
      ctx,
      overrides: {
        sessionEntry,
        sessionStore,
      },
      typing,
    });
  });

  it("clears /stop cutoff when a newer message arrives", async () => {
    const typing = createTypingController();
    const sessionEntry: SessionEntry = {
      abortCutoffMessageSid: "42",
      abortedLastRun: true,
      sessionId: "session-2",
      updatedAt: Date.now(),
    };
    const sessionStore = { "s:main": sessionEntry };
    handleCommandsMock.mockResolvedValue({ reply: { text: "ok" }, shouldContinue: false });
    const ctx = buildTestCtx({
      Body: "new message",
      CommandBody: "new message",
      MessageSid: "43",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: "new message",
        command: {
          commandBodyNormalized: "new message",
          rawBodyNormalized: "new message",
        },
        ctx,
        overrides: {
          sessionEntry,
          sessionStore,
        },
        typing,
      }),
    );

    expect(result).toEqual({
      abortedLastRun: false,
      directives: clearInlineDirectives("new message"),
      kind: "continue",
    });
    expect(sessionStore["s:main"]?.abortCutoffMessageSid).toBeUndefined();
    expect(sessionStore["s:main"]?.abortCutoffTimestamp).toBeUndefined();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });

  it("rewrites Claude bundle markdown commands into a native agent prompt", async () => {
    const typing = createTypingController();
    handleCommandsMock.mockResolvedValue({ reply: { text: "done" }, shouldContinue: false });
    const ctx = buildTestCtx({
      Body: "/office_hours build me a deployment plan",
      CommandBody: "/office_hours build me a deployment plan",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        description: "Office hours",
        name: "office_hours",
        promptTemplate: "Act as an engineering advisor.\n\nFocus on:\n$ARGUMENTS",
        skillName: "office-hours",
        sourceFilePath: "/tmp/plugin/commands/office-hours.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: "/office_hours build me a deployment plan",
        command: {
          commandBodyNormalized: "/office_hours build me a deployment plan",
          isAuthorizedSender: true,
          rawBodyNormalized: "/office_hours build me a deployment plan",
        },
        ctx,
        overrides: {
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands,
        },
        typing,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "done" } });
    expect(ctx.Body).toBe(
      "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
    );
    expect(handleCommandsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          Body: "Act as an engineering advisor.\n\nFocus on:\nbuild me a deployment plan",
        }),
      }),
    );
  });

  it("passes requesterAgentIdOverride into inline tool runtimes", async () => {
    const typing = createTypingController();
    const toolExecute = vi.fn(async () => ({ text: "spawned" }));
    createOpenClawToolsMock.mockReturnValue([
      {
        execute: toolExecute,
        name: "sessions_spawn",
      },
    ]);

    const ctx = buildTestCtx({
      Body: "/spawn_subagent investigate",
      CommandBody: "/spawn_subagent investigate",
    });
    const skillCommands: SkillCommandSpec[] = [
      {
        description: "Spawn a subagent",
        dispatch: {
          argMode: "raw",
          kind: "tool",
          toolName: "sessions_spawn",
        },
        name: "spawn_subagent",
        skillName: "spawn-subagent",
        sourceFilePath: "/tmp/plugin/commands/spawn-subagent.md",
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        cleanedBody: "/spawn_subagent investigate",
        command: {
          abortKey: "sender-1",
          commandBodyNormalized: "/spawn_subagent investigate",
          isAuthorizedSender: true,
          rawBodyNormalized: "/spawn_subagent investigate",
          senderId: "sender-1",
          senderIsOwner: true,
        },
        ctx,
        overrides: {
          agentId: "named-worker",
          allowTextCommands: true,
          cfg: { commands: { text: true } },
          skillCommands,
        },
        typing,
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "✅ Done." } });
    expect(createOpenClawToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requesterAgentIdOverride: "named-worker",
      }),
    );
    expect(toolExecute).toHaveBeenCalled();
  });
});
