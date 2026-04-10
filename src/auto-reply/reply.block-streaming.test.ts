import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { withFastReplyConfig } from "./reply/get-reply-fast-path.js";
import { loadGetReplyModuleForTest } from "./reply/get-reply.test-loader.js";
import { createMockTypingController } from "./reply/reply.test-helpers.js";
import type { MsgContext } from "./templating.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
  runPreparedReply: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentSkillsFilter: vi.fn(() => undefined),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveSessionAgentId: vi.fn(() => "main"),
  };
});
vi.mock("../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-selection.js")>(
    "../agents/model-selection.js",
  );
  return {
    ...actual,
    resolveModelRefFromString: vi.fn(() => null),
  };
});
vi.mock("../agents/timeout.js", () => ({
  resolveAgentTimeoutMs: vi.fn(() => 60_000),
}));
vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/workspace",
  ensureAgentWorkspace: vi.fn(async () => ({ dir: "/tmp/workspace" })),
}));
vi.mock("../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: vi.fn(() => undefined),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { error: vi.fn(), info: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));
vi.mock("./command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(() => ({ isAuthorizedSender: true })),
}));
vi.mock("./reply/directive-handling.defaults.js", () => ({
  resolveDefaultModel: vi.fn(() => ({
    aliasIndex: new Map(),
    defaultModel: "claude-opus-4-6",
    defaultProvider: "anthropic",
  })),
}));
vi.mock("./reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("./reply/session-reset-model.runtime.js", () => ({
  applyResetModelOverride: vi.fn(async () => undefined),
}));
vi.mock("./reply/stage-sandbox-media.runtime.js", () => ({
  stageSandboxMedia: vi.fn(async () => undefined),
}));
vi.mock("./reply/typing.js", () => ({
  createTypingController: vi.fn(() => createMockTypingController()),
}));

vi.mock("./reply/get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./reply/get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./reply/session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));
vi.mock("./reply/get-reply-run.js", () => ({
  runPreparedReply: (...args: unknown[]) => mocks.runPreparedReply(...args),
}));

let getReplyFromConfig: typeof import("./reply/get-reply.js").getReplyFromConfig;

async function loadFreshGetReplyModuleForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function createTelegramMessage(messageSid: string): MsgContext {
  return {
    Body: "ping",
    ChatType: "direct",
    From: "+1004",
    MessageSid: messageSid,
    Provider: "telegram",
    Surface: "telegram",
    To: "+2000",
  };
}

function createReplyConfig(streamMode?: "block"): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: "/tmp/workspace",
      },
    },
    channels: {
      telegram: {
        allowFrom: ["*"],
        ...(streamMode ? { streaming: { mode: streamMode } } : {}),
      },
    },
    session: { store: "/tmp/sessions.json" },
  } as OpenClawConfig);
}

function createContinueDirectivesResult() {
  return {
    kind: "continue" as const,
    result: {
      allowTextCommands: true,
      blockReplyChunking: undefined,
      blockStreamingEnabled: true,
      cleanedBody: "ping",
      command: {
        abortKey: "telegram:+2000",
        channel: "telegram",
        channelId: "+2000",
        commandBodyNormalized: "ping",
        from: "+1004",
        isAuthorizedSender: true,
        ownerList: [],
        rawBodyNormalized: "ping",
        resetHookTriggered: false,
        senderId: "+1004",
        senderIsOwner: true,
        surface: "telegram",
        to: "+2000",
      },
      commandSource: undefined,
      contextTokens: 0,
      defaultActivation: "always",
      directiveAck: undefined,
      directives: {},
      elevatedAllowed: false,
      elevatedEnabled: false,
      elevatedFailures: [],
      execOverrides: undefined,
      inlineStatusRequested: false,
      model: "claude-opus-4-6",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
      provider: "anthropic",
      resolvedBlockStreamingBreak: "message_end",
      resolvedElevatedLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      skillCommands: [],
    },
  };
}

describe("block streaming", () => {
  beforeEach(async () => {
    await loadFreshGetReplyModuleForTest();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.runPreparedReply.mockReset();

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockImplementation(async (params) => ({
      abortedLastRun: false,
      directives: params.directives,
      kind: "continue",
    }));
    mocks.initSessionState.mockImplementation(async ({ ctx }: { ctx: MsgContext }) => ({
      abortedLastRun: false,
      bodyStripped: "ping",
      groupResolution: undefined,
      isGroup: false,
      isNewSession: true,
      previousSessionEntry: {},
      resetTriggered: false,
      sessionCtx: {
        ...ctx,
        CommandAuthorized: true,
      },
      sessionEntry: {},
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:+1004",
      sessionScope: "per-sender",
      sessionStore: {},
      storePath: "/tmp/sessions.json",
      systemSent: false,
      triggerBodyNormalized: "ping",
    }));
  });

  it("handles ordering, timeout fallback, and telegram streamMode block", async () => {
    const onReplyStart = vi.fn().mockResolvedValue(undefined);
    const onBlockReply = vi.fn().mockResolvedValue(undefined);

    mocks.runPreparedReply.mockImplementationOnce(async (params) => {
      await params.opts?.onReplyStart?.();
      await params.opts?.onBlockReply?.({ text: "first\n\nsecond" });
      return undefined;
    });

    const res = await getReplyFromConfig(
      createTelegramMessage("msg-123"),
      {
        disableBlockStreaming: false,
        onBlockReply,
        onReplyStart,
      },
      createReplyConfig(),
    );

    expect(res).toBeUndefined();
    expect(mocks.runPreparedReply).toHaveBeenCalledTimes(1);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
    expect(onBlockReply).toHaveBeenCalledWith({ text: "first\n\nsecond" });

    const onBlockReplyStreamMode = vi.fn().mockResolvedValue(undefined);
    mocks.runPreparedReply.mockImplementationOnce(async () => [{ text: "final" }]);

    const resStreamMode = await getReplyFromConfig(
      createTelegramMessage("msg-127"),
      {
        onBlockReply: onBlockReplyStreamMode,
      },
      createReplyConfig("block"),
    );

    const streamPayload = Array.isArray(resStreamMode) ? resStreamMode[0] : resStreamMode;
    expect(streamPayload?.text).toBe("final");
    expect(onBlockReplyStreamMode).not.toHaveBeenCalled();
  });
});
