import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockFollowupRun, createMockTypingController } from "./test-helpers.js";

const runEmbeddedPiAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const compactEmbeddedPiSessionMock = vi.fn();
const isEmbeddedPiRunActiveMock = vi.fn(() => false);
const isEmbeddedPiRunStreamingMock = vi.fn(() => false);
const queueEmbeddedPiMessageMock = vi.fn(() => false);
const resolveEmbeddedSessionLaneMock = vi.fn();
const waitForEmbeddedPiRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const scheduleFollowupDrainMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: abortEmbeddedPiRunMock,
  compactEmbeddedPiSession: compactEmbeddedPiSessionMock,
  isEmbeddedPiRunActive: isEmbeddedPiRunActiveMock,
  isEmbeddedPiRunStreaming: isEmbeddedPiRunStreamingMock,
  queueEmbeddedPiMessage: queueEmbeddedPiMessageMock,
  resolveEmbeddedSessionLane: resolveEmbeddedSessionLaneMock,
  runEmbeddedPiAgent: runEmbeddedPiAgentMock,
  waitForEmbeddedPiRunEnd: waitForEmbeddedPiRunEndMock,
}));

vi.mock("./queue.js", () => ({
  enqueueFollowupRun: enqueueFollowupRunMock,
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
  scheduleFollowupDrain: scheduleFollowupDrainMock,
}));

let runReplyAgent: typeof import("./agent-runner.js").runReplyAgent;

describe("runReplyAgent media path normalization", () => {
  beforeEach(async () => {
    vi.resetModules();
    runEmbeddedPiAgentMock.mockReset();
    runWithModelFallbackMock.mockReset();
    abortEmbeddedPiRunMock.mockReset();
    compactEmbeddedPiSessionMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReset();
    isEmbeddedPiRunActiveMock.mockReturnValue(false);
    isEmbeddedPiRunStreamingMock.mockReset();
    isEmbeddedPiRunStreamingMock.mockReturnValue(false);
    queueEmbeddedPiMessageMock.mockReset();
    queueEmbeddedPiMessageMock.mockReturnValue(false);
    resolveEmbeddedSessionLaneMock.mockReset();
    waitForEmbeddedPiRunEndMock.mockReset();
    enqueueFollowupRunMock.mockReset();
    scheduleFollowupDrainMock.mockReset();
    refreshQueuedFollowupSessionMock.mockReset();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    runWithModelFallbackMock.mockImplementation(
      async ({
        provider,
        model,
        run,
      }: {
        provider: string;
        model: string;
        run: (...args: unknown[]) => Promise<unknown>;
      }) => ({
        model,
        provider,
        result: await run(provider, model),
      }),
    );
    ({ runReplyAgent } = await import("./agent-runner.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("normalizes final MEDIA replies against the run workspace", async () => {
    runEmbeddedPiAgentMock.mockResolvedValue({
      meta: {
        agentMeta: {
          model: "claude",
          provider: "anthropic",
          sessionId: "session",
        },
      },
      payloads: [{ text: "MEDIA:./out/generated.png" }],
    });

    const result = await runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "generate",
      defaultModel: "anthropic/claude",
      followupRun: createMockFollowupRun({
        prompt: "generate",
        run: {
          agentDir: "/tmp/agent",
          agentId: "main",
          messageProvider: "telegram",
          workspaceDir: "/tmp/workspace",
        },
      }) as unknown as FollowupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue: { mode: "interrupt" } as QueueSettings,
      resolvedVerboseLevel: "off",
      sessionCtx: {
        AccountId: "default",
        MessageSid: "msg-1",
        OriginatingTo: "chat-1",
        Provider: "telegram",
        Surface: "telegram",
        To: "chat-1",
      } as unknown as TemplateContext,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing: createMockTypingController(),
      typingMode: "instant",
    });

    expect(result).toMatchObject({
      mediaUrl: path.join("/tmp/workspace", "out", "generated.png"),
      mediaUrls: [path.join("/tmp/workspace", "out", "generated.png")],
    });
  });
});
