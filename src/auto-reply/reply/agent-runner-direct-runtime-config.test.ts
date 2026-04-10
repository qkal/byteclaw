import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const freshCfg = { runtimeFresh: true };
const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: {
        apiKey: { id: "OPENAI_API_KEY", provider: "default", source: "env" },
      },
    },
  },
};
const sentinelError = new Error("stop-after-preflight");

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
    resolveQueuedReplyExecutionConfigMock(...args),
}));

vi.mock("./reply-threading.js", () => ({
  createReplyToModeFilterForChannel: (...args: unknown[]) =>
    createReplyToModeFilterForChannelMock(...args),
  resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
}));

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaPathNormalizer: (...args: unknown[]) =>
    createReplyMediaPathNormalizerMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
  runPreflightCompactionIfNeeded: (...args: unknown[]) =>
    runPreflightCompactionIfNeededMock(...args),
}));

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  };
});

const { runReplyAgent } = await import("./agent-runner.js");

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    resolveReplyToModeMock.mockReset();
    createReplyToModeFilterForChannelMock.mockReset();
    createReplyMediaPathNormalizerMock.mockReset();
    runPreflightCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("default");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
    runPreflightCompactionIfNeededMock.mockRejectedValue(sentinelError);
    runMemoryFlushIfNeededMock.mockResolvedValue(undefined);
  });

  it("resolves direct reply runs before early helpers read config", async () => {
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: staleCfg,
        elevatedLevel: "off",
        messageProvider: "telegram",
        model: "gpt-5.4",
        provider: "openai",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:default:direct:test",
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    const resolvedQueue = { mode: "interrupt" } as QueueSettings;
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      Provider: "telegram",
    } as unknown as TemplateContext;

    await expect(
      runReplyAgent({
        blockStreamingEnabled: false,
        commandBody: "hello",
        defaultModel: "openai/gpt-5.4",
        followupRun,
        isActive: false,
        isNewSession: false,
        isStreaming: false,
        queueKey: "main",
        resolvedBlockStreamingBreak: "message_end",
        resolvedQueue,
        resolvedVerboseLevel: "off",
        sessionCtx,
        shouldFollowup: false,
        shouldInjectGroupIntro: false,
        shouldSteer: false,
        typing,
        typingMode: "instant",
      }),
    ).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledWith(staleCfg);
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith({
      cfg: freshCfg,
      sessionKey: undefined,
      workspaceDir: "/tmp",
    });
    expect(runPreflightCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: freshCfg,
        followupRun,
      }),
    );
  });

  it("does not resolve secrets before the enqueue-followup queue path", async () => {
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: staleCfg,
        elevatedLevel: "off",
        messageProvider: "telegram",
        model: "gpt-5.4",
        provider: "openai",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:default:direct:test",
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    const resolvedQueue = { mode: "interrupt" } as QueueSettings;
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      Provider: "telegram",
    } as unknown as TemplateContext;

    await expect(
      runReplyAgent({
        blockStreamingEnabled: false,
        commandBody: "hello",
        defaultModel: "openai/gpt-5.4",
        followupRun,
        isActive: true,
        isNewSession: false,
        isStreaming: false,
        queueKey: "main",
        resolvedBlockStreamingBreak: "message_end",
        resolvedQueue,
        resolvedVerboseLevel: "off",
        sessionCtx,
        shouldFollowup: true,
        shouldInjectGroupIntro: false,
        shouldSteer: false,
        typing,
        typingMode: "instant",
      }),
    ).resolves.toBeUndefined();

    expect(resolveQueuedReplyExecutionConfigMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledWith(
      "main",
      followupRun,
      resolvedQueue,
      "message-id",
      expect.any(Function),
      false,
    );
  });
});
