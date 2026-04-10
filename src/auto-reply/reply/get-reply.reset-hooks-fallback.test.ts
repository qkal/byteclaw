import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import "./get-reply.test-runtime-mocks.js";

const mocks = vi.hoisted(() => ({
  emitResetCommandHooks: vi.fn(),
  handleInlineActions: vi.fn(),
  initSessionState: vi.fn(),
  resolveReplyDirectives: vi.fn(),
}));
vi.mock("./commands-core.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
}));
vi.mock("./commands-core.runtime.js", () => ({
  emitResetCommandHooks: (...args: unknown[]) => mocks.emitResetCommandHooks(...args),
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

function buildNativeResetContext(): MsgContext {
  return {
    Body: "/new",
    ChatType: "direct",
    CommandAuthorized: true,
    CommandBody: "/new",
    CommandSource: "native",
    CommandTargetSessionKey: "agent:main:telegram:direct:123",
    From: "telegram:123",
    Provider: "telegram",
    RawBody: "/new",
    SessionKey: "telegram:slash:123",
    Surface: "telegram",
    To: "slash:123",
  };
}

function createContinueDirectivesResult(resetHookTriggered: boolean) {
  return {
    kind: "continue" as const,
    result: {
      allowTextCommands: true,
      blockReplyChunking: undefined,
      blockStreamingEnabled: false,
      cleanedBody: "/new",
      command: {
        abortKey: "telegram:slash:123",
        channel: "telegram",
        channelId: "telegram",
        commandBodyNormalized: "/new",
        from: "telegram:123",
        isAuthorizedSender: true,
        ownerList: [],
        rawBodyNormalized: "/new",
        resetHookTriggered,
        senderId: "123",
        senderIsOwner: true,
        surface: "telegram",
        to: "slash:123",
      },
      commandSource: "/new",
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

describe("getReplyFromConfig reset-hook fallback", () => {
  beforeEach(async () => {
    await loadGetReplyRuntimeForTest();
    vi.stubEnv("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
    mocks.resolveReplyDirectives.mockReset();
    mocks.handleInlineActions.mockReset();
    mocks.emitResetCommandHooks.mockReset();
    mocks.initSessionState.mockReset();

    mocks.initSessionState.mockResolvedValue({
      abortedLastRun: false,
      bodyStripped: "",
      groupResolution: undefined,
      isGroup: false,
      isNewSession: true,
      previousSessionEntry: {},
      resetTriggered: true,
      sessionCtx: buildNativeResetContext(),
      sessionEntry: {},
      sessionId: "session-1",
      sessionKey: "agent:main:telegram:direct:123",
      sessionScope: "per-sender",
      sessionStore: {},
      storePath: "/tmp/sessions.json",
      systemSent: false,
      triggerBodyNormalized: "/new",
    });

    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(false));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits reset hooks when inline actions return early without marking resetHookTriggered", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).toHaveBeenCalledTimes(1);
    expect(mocks.emitResetCommandHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "new",
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });

  it("does not emit fallback hooks when resetHookTriggered is already set", async () => {
    mocks.handleInlineActions.mockResolvedValue({ kind: "reply", reply: undefined });
    mocks.resolveReplyDirectives.mockResolvedValue(createContinueDirectivesResult(true));

    await getReplyFromConfig(buildNativeResetContext(), undefined, {});

    expect(mocks.emitResetCommandHooks).not.toHaveBeenCalled();
  });
});
