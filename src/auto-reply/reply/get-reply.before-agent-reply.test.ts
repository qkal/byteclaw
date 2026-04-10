import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookRunner } from "../../plugins/hooks.js";
import type { MsgContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  handleInlineActions: vi.fn(),
  hasHooks: vi.fn<HookRunner["hasHooks"]>(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
  runBeforeAgentReply: vi.fn<HookRunner["runBeforeAgentReply"]>(),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () =>
    ({
      hasHooks: mocks.hasHooks,
      runBeforeAgentReply: mocks.runBeforeAgentReply,
    }) as unknown as HookRunner,
}));
vi.mock("./get-reply-directives.js", () => ({
  resolveReplyDirectives: (...args: unknown[]) => mocks.resolveReplyDirectives(...args),
}));
vi.mock("./get-reply-inline-actions.js", () => ({
  handleInlineActions: (...args: unknown[]) => mocks.handleInlineActions(...args),
}));
vi.mock("./session.js", () => ({
  initSessionState: (...args: unknown[]) => mocks.initSessionState(...args),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;

async function loadGetReplyRuntimeForTest() {
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
}

function buildCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Body: "hello world",
    BodyForAgent: "hello world",
    BodyForCommands: "hello world",
    ChatType: "group",
    CommandBody: "hello world",
    From: "telegram:user:42",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:-100123",
    Provider: "telegram",
    RawBody: "hello world",
    SessionKey: "agent:main:telegram:-100123",
    Surface: "telegram",
    Timestamp: 1_710_000_000_000,
    To: "telegram:-100123",
    ...overrides,
  };
}

function createContinueDirectivesResult() {
  return {
    kind: "continue" as const,
    result: {
      allowTextCommands: true,
      blockReplyChunking: undefined,
      blockStreamingEnabled: false,
      cleanedBody: "hello world",
      command: {
        abortKey: "agent:main:telegram:-100123",
        channel: "telegram",
        channelId: "telegram",
        commandBodyNormalized: "hello world",
        from: "telegram:user:42",
        isAuthorizedSender: true,
        ownerList: [],
        rawBodyNormalized: "hello world",
        resetHookTriggered: false,
        senderId: "42",
        senderIsOwner: false,
        surface: "telegram",
        to: "telegram:-100123",
      },
      commandSource: "text",
      contextTokens: 0,
      defaultActivation: "always",
      directiveAck: undefined,
      directives: {},
      elevatedAllowed: false,
      elevatedEnabled: false,
      elevatedFailures: [],
      execOverrides: undefined,
      inlineStatusRequested: false,
      model: "gpt-4o-mini",
      modelState: {
        resolveDefaultThinkingLevel: async () => undefined,
      },
      perMessageQueueMode: undefined,
      perMessageQueueOptions: undefined,
      provider: "openai",
      resolvedBlockStreamingBreak: undefined,
      resolvedElevatedLevel: "off",
      resolvedReasoningLevel: "off",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: "off",
      skillCommands: [],
    },
  };
}

describe("getReplyFromConfig before_agent_reply wiring", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.initSessionState.mockReset();
    mocks.hasHooks.mockReset();
    mocks.runBeforeAgentReply.mockReset();

    mocks.initSessionState.mockResolvedValue({
      abortedLastRun: false,
      bodyStripped: "hello world",
      groupResolution: undefined,
      isGroup: true,
      isNewSession: false,
      previousSessionEntry: {},
      resetTriggered: false,
      sessionCtx: buildCtx({
        OriginatingChannel: "Telegram",
        Provider: "telegram",
      }),
      sessionEntry: {},
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:-100123",
      sessionScope: "per-chat",
      sessionStore: {},
      storePath: "/tmp/sessions.json",
      systemSent: false,
      triggerBodyNormalized: "hello world",
    });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult());
    mocks.handleInlineActions.mockResolvedValue({
      abortedLastRun: false,
      directives: {},
      kind: "continue",
    });
    mocks.hasHooks.mockImplementation((hookName) => hookName === "before_agent_reply");
  });

  it("returns a plugin reply and invokes the hook after inline actions", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "plugin reply" },
    });

    const result = await getReplyFromConfig(buildCtx(), undefined, {});

    expect(result).toEqual({ text: "plugin reply" });
    expect(mocks.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: "hello world" },
      expect.objectContaining({
        agentId: "main",
        channelId: "telegram",
        messageProvider: "telegram",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:-100123",
        trigger: "user",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(mocks.handleInlineActions.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runBeforeAgentReply.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("falls back to NO_REPLY when the hook claims without a reply payload", async () => {
    mocks.runBeforeAgentReply.mockResolvedValue({ handled: true });

    const result = await getReplyFromConfig(buildCtx(), undefined, {});

    expect(result).toEqual({ text: SILENT_REPLY_TOKEN });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
});
