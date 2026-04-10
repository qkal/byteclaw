import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRecordedUpdateLastRoute,
  loadTelegramMessageContextRouteHarness,
  recordInboundSessionMock,
} from "./bot-message-context.route-test-support.js";

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: "hello",
    canDetectMention: false,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    historyKey: undefined,
    locationData: undefined,
    rawBody: "hello",
    shouldBypassMention: false,
    stickerCacheHit: false,
  }),
}));

let buildTelegramMessageContextForTest: typeof import("./bot-message-context.test-harness.js").buildTelegramMessageContextForTest;
let clearRuntimeConfigSnapshot: typeof import("openclaw/plugin-sdk/config-runtime").clearRuntimeConfigSnapshot;

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
    });
  }

  function expectRecordedRoute(params: { to: string; threadId?: string }) {
    const updateLastRoute = getRecordedUpdateLastRoute(0) as
      | { threadId?: string; to?: string }
      | undefined;
    expect(updateLastRoute).toBeDefined();
    expect(updateLastRoute?.to).toBe(params.to);
    expect(updateLastRoute?.threadId).toBe(params.threadId);
  }

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  beforeAll(async () => {
    ({ clearRuntimeConfigSnapshot, buildTelegramMessageContextForTest } =
      await loadTelegramMessageContextRouteHarness());
  });

  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ threadId: "42", to: "telegram:1234" });
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ to: "telegram:1234" });
  });

  it("passes threadId to updateLastRoute for forum topic group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "Test Group", type: "supergroup" },
        message_thread_id: 99,
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ threadId: "99", to: "telegram:-1001234567890:topic:99" });
  });

  it("passes threadId to updateLastRoute for the forum General topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1_001_234_567_890, is_forum: true, title: "Test Group", type: "supergroup" },
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    expect(ctx).not.toBeNull();
    expect(recordInboundSessionMock).toHaveBeenCalled();

    expectRecordedRoute({ threadId: "1", to: "telegram:-1001234567890:topic:1" });
  });
});
