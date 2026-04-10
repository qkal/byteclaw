import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";

const { bypassMock, dispatchMock } = vi.hoisted(() => ({
  bypassMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => ({
  shouldBypassAcpDispatchForCommand: bypassMock,
  tryDispatchAcpReply: dispatchMock,
}));

import { tryDispatchAcpReplyHook } from "./acp-runtime.js";

const event = {
  ctx: buildTestCtx({
    BodyForAgent: "/acp cancel",
    BodyForCommands: "/acp cancel",
    CommandBody: "/acp cancel",
    SessionKey: "agent:test:session",
  }),
  inboundAudio: false,
  originatingChannel: undefined,
  originatingTo: undefined,
  runId: "run-1",
  sendPolicy: "allow" as const,
  sessionKey: "agent:test:session",
  sessionTtsAuto: "off" as const,
  shouldRouteToOriginating: false,
  shouldSendToolSummaries: true,
  suppressUserDelivery: false,
  ttsChannel: undefined,
};

const ctx = {
  abortSignal: undefined,
  cfg: {},
  dispatcher: {
    getFailedCounts: () => ({ block: 0, final: 0, tool: 0 }),
    getQueuedCounts: () => ({ block: 0, final: 0, tool: 0 }),
    markComplete: () => {},
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    sendToolResult: () => false,
    waitForIdle: async () => {},
  },
  markIdle: vi.fn(),
  onReplyStart: undefined,
  recordProcessed: vi.fn(),
};

describe("tryDispatchAcpReplyHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips ACP runtime lookup for plain-text deny turns", async () => {
    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        ctx: buildTestCtx({
          BodyForAgent: "write a test",
          BodyForCommands: "write a test",
          SessionKey: "agent:test:session",
        }),
        sendPolicy: "deny",
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(bypassMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("skips ACP dispatch when send policy denies delivery and no bypass applies", async () => {
    bypassMock.mockResolvedValue(false);

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches through ACP when command bypass applies", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue({
      counts: { block: 2, final: 3, tool: 1 },
      queuedFinal: true,
    });

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toEqual({
      counts: { block: 2, final: 3, tool: 1 },
      handled: true,
      queuedFinal: true,
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassForCommand: true,
        cfg: ctx.cfg,
        ctx: event.ctx,
        dispatcher: ctx.dispatcher,
      }),
    );
  });

  it("returns unhandled when ACP dispatcher declines the turn", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(event, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });

  it("does not let ACP claim reset commands before local command handling", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(
      {
        ...event,
        ctx: buildTestCtx({
          BodyForAgent: "/new",
          BodyForCommands: "/new",
          CommandBody: "/new",
          SessionKey: "agent:test:session",
        }),
      },
      ctx,
    );

    expect(result).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bypassForCommand: true,
      }),
    );
  });
});
