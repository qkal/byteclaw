/**
 * Tests for Matrix group chat history accumulation.
 *
 * Covers two key scenarios:
 *
 * Scenario 1 — basic accumulation across agents:
 *   user: msg A              (no mention, accumulates)
 *   user: @agent_a msg B     (triggers agent_a; agent_a sees [A] in history, not B itself)
 *   user: @agent_b msg C     (triggers agent_b; agent_b sees [A, B] — independent watermark)
 *   user: @agent_b msg D     (triggers agent_b; agent_b sees [] — A/B/C were consumed)
 *
 * Scenario 2 — race condition safety:
 *   user: @agent_a msg A     (triggers agent_a; agent starts processing, not yet replied)
 *   user: msg B              (no mention, arrives during processing — must not be lost)
 *   agent_a: reply           (watermark advances to just after A, not after B)
 *   user: @agent_a msg C     (triggers agent_a; agent_a sees [B] in history)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixMonitorTestRuntime } from "../../test-runtime.js";
import {
  createMatrixHandlerTestHarness,
  createMatrixRoomMessageEvent,
  createMatrixTextMessageEvent,
} from "./handler.test-helpers.js";
import type { MatrixRawEvent } from "./types.js";

const DEFAULT_ROOM = "!room:example.org";

function makeRoomTriggerEvent(params: { eventId: string; body: string; ts?: number }) {
  // Use @room mention to trigger the bot without requiring agent-specific mention regexes
  return createMatrixTextMessageEvent({
    body: `@room ${params.body}`,
    eventId: params.eventId,
    mentions: { room: true },
    originServerTs: params.ts ?? Date.now(),
  });
}

function makeRoomPlainEvent(params: { eventId: string; body: string; ts?: number }) {
  return createMatrixTextMessageEvent({
    body: params.body,
    eventId: params.eventId,
    originServerTs: params.ts ?? Date.now(),
  });
}

function makeDevRoute(agentId: string) {
  return {
    accountId: "ops",
    agentId,
    channel: "matrix" as const,
    mainSessionKey: `agent:${agentId}:main`,
    matchedBy: "binding.account" as const,
    sessionKey: `agent:${agentId}:main`,
  };
}

beforeEach(() => {
  installMatrixMonitorTestRuntime();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createFinalDeliveryFailureHandler(finalizeInboundContext: (ctx: unknown) => unknown) {
  let capturedOnError:
    | ((err: unknown, info: { kind: "tool" | "block" | "final" }) => void)
    | undefined;

  return createMatrixHandlerTestHarness({
    createReplyDispatcherWithTyping: (params?: {
      onError?: (err: unknown, info: { kind: "tool" | "block" | "final" }) => void;
    }) => {
      capturedOnError = params?.onError;
      return {
        dispatcher: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
        replyOptions: {},
      };
    },
    dispatchReplyFromConfig: async () => ({
      counts: { block: 0, final: 1, tool: 0 },
      queuedFinal: true,
    }),
    finalizeInboundContext,
    groupPolicy: "open",
    historyLimit: 20,
    isDirectMessage: false,
    withReplyDispatcher: async <T>(params: {
      dispatcher: { markComplete?: () => void; waitForIdle?: () => Promise<void> };
      run: () => Promise<T>;
      onSettled?: () => void | Promise<void>;
    }) => {
      const result = await params.run();
      capturedOnError?.(new Error("simulated delivery failure"), { kind: "final" });
      params.dispatcher.markComplete?.();
      await params.dispatcher.waitForIdle?.();
      await params.onSettled?.();
      return result;
    },
  });
}

describe("matrix group chat history — scenario 1: basic accumulation", () => {
  it("pending messages appear in InboundHistory; trigger itself does not", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    // Non-trigger message A — should not dispatch
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "msg A", eventId: "$a", ts: 1000 }));
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    // Trigger B — history must contain [msg A] only, not the trigger itself
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "msg B", eventId: "$b", ts: 2000 }));
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string; sender: string }[];
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toContain("msg A");
  });

  it("multi-agent: each agent has an independent watermark", async () => {
    let currentAgentId = "agent_a";
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
      resolveAgentRoute: vi.fn(() => makeDevRoute(currentAgentId)),
    });

    // Msg A accumulates for all agents
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "msg A", eventId: "$a", ts: 1000 }));

    // @agent_a trigger B — agent_a sees [msg A]
    currentAgentId = "agent_a";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "msg B", eventId: "$b", ts: 2000 }));
    {
      const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as { body: string }[];
      expect(history).toHaveLength(1);
      expect(history[0]?.body).toContain("msg A");
    }

    // @agent_b trigger C — agent_b watermark is 0, so it sees [msg A, msg B]
    currentAgentId = "agent_b";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "msg C", eventId: "$c", ts: 3000 }));
    {
      const ctx = finalizeInboundContext.mock.calls[1]?.[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as { body: string }[];
      expect(history).toHaveLength(2);
      expect(history.map((h) => h.body).some((b) => b.includes("msg A"))).toBe(true);
      expect(history.map((h) => h.body).some((b) => b.includes("msg B"))).toBe(true);
    }

    // @agent_b trigger D — A/B/C consumed; history is empty
    currentAgentId = "agent_b";
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "msg D", eventId: "$d", ts: 4000 }));
    {
      const ctx = finalizeInboundContext.mock.calls[2]?.[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as unknown[] | undefined;
      expect(history ?? []).toHaveLength(0);
    }
  });

  it("respects historyLimit: caps to the most recent N entries", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 2,
      isDirectMessage: false,
    });

    for (let i = 1; i <= 4; i++) {
      await handler(
        DEFAULT_ROOM,
        makeRoomPlainEvent({ body: `pending ${i}`, eventId: `$p${i}`, ts: i * 1000 }),
      );
    }

    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "trigger", eventId: "$t", ts: 5000 }));
    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string }[];
    expect(history).toHaveLength(2);
    expect(history[0]?.body).toContain("pending 3");
    expect(history[1]?.body).toContain("pending 4");
  });

  it("historyLimit=0 disables history accumulation entirely", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 0,
      isDirectMessage: false,
    });

    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "pending", eventId: "$p" }));
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "trigger", eventId: "$t" }));

    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as unknown[] | undefined;
    expect(history ?? []).toHaveLength(0);
  });

  it("historyLimit=0 does not serialize same-room ingress", async () => {
    const firstUserId = deferred<string>();
    let getUserIdCalls = 0;
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        getUserId: async () => {
          getUserIdCalls += 1;
          if (getUserIdCalls === 1) {
            return await firstUserId.promise;
          }
          return "@bot:example.org";
        },
      },
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      groupPolicy: "open",
      historyLimit: 0,
      isDirectMessage: false,
    });

    const first = handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "first", eventId: "$a" }));
    await Promise.resolve();
    const second = handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "second", eventId: "$b" }));
    await Promise.resolve();

    expect(getUserIdCalls).toBe(2);

    firstUserId.resolve("@bot:example.org");
    await Promise.all([first, second]);
  });

  it("DMs do not accumulate history (group chat only)", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      historyLimit: 20,
      isDirectMessage: true,
    });

    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "dm message 1", eventId: "$dm1" }));
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "dm message 2", eventId: "$dm2" }));

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    for (const call of finalizeInboundContext.mock.calls) {
      const ctx = call[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as unknown[] | undefined;
      expect(history ?? []).toHaveLength(0);
    }
  });

  it("history-enabled rooms do not serialize DM ingress heavy work", async () => {
    let resolveFirstName: (() => void) | undefined;
    let nameLookupCalls = 0;
    const getMemberDisplayName = vi.fn(async () => {
      nameLookupCalls += 1;
      if (nameLookupCalls === 1) {
        await new Promise<void>((resolve) => {
          resolveFirstName = resolve;
        });
      }
      return "sender";
    });

    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      getMemberDisplayName,
      historyLimit: 20,
      isDirectMessage: true,
    });

    const first = handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "first dm", eventId: "$dm-a" }));
    await vi.waitFor(() => {
      expect(resolveFirstName).toBeTypeOf("function");
    });

    const second = handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ body: "second dm", eventId: "$dm-b" }),
    );
    await vi.waitFor(() => {
      expect(nameLookupCalls).toBe(2);
    });

    resolveFirstName?.();
    await Promise.all([first, second]);
  });

  it("includes skipped media-only room messages in next trigger history", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    // Unmentioned media-only message should be buffered as pending history context.
    await handler(
      DEFAULT_ROOM,
      createMatrixRoomMessageEvent({
        content: {
          body: "",
          msgtype: "m.image",
          url: "mxc://example.org/media-a",
        },
        eventId: "$media-a",
        originServerTs: 1000,
      }),
    );
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger", eventId: "$trigger-media", ts: 2000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string }[] | undefined;
    expect(history?.some((entry) => entry.body.includes("[matrix image attachment]"))).toBe(true);
  });

  it("includes skipped poll updates in next trigger history", async () => {
    const getEvent = vi.fn(async () => ({
      content: {
        "m.poll.start": {
          answers: [{ id: "a1", "m.text": "Pizza" }],
          kind: "m.poll.disclosed",
          max_selections: 1,
          question: { "m.text": "Lunch?" },
        },
      },
      event_id: "$poll",
      origin_server_ts: Date.now(),
      sender: "@user:example.org",
      type: "m.poll.start",
    }));
    const getRelations = vi.fn(async () => ({
      events: [],
      nextBatch: null,
      prevBatch: null,
    }));
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        getEvent,
        getRelations,
      },
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    await handler(DEFAULT_ROOM, {
      content: {
        "m.poll.response": {
          answers: ["a1"],
        },
        "m.relates_to": {
          event_id: "$poll",
          rel_type: "m.reference",
        },
      },
      event_id: "$poll-response-1",
      origin_server_ts: 1000,
      sender: "@user:example.org",
      type: "m.poll.response",
    } as MatrixRawEvent);
    expect(finalizeInboundContext).not.toHaveBeenCalled();

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger", eventId: "$trigger-poll", ts: 2000 }),
    );

    expect(getEvent).toHaveBeenCalledOnce();
    expect(getRelations).toHaveBeenCalledOnce();
    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string }[] | undefined;
    expect(history?.some((entry) => entry.body.includes("Lunch?"))).toBe(true);
  });
});

describe("matrix group chat history — scenario 2: race condition safety", () => {
  it("messages arriving during agent processing are visible on the next trigger", async () => {
    let resolveFirstDispatch: (() => void) | undefined;
    let firstDispatchStarted = false;

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const dispatchReplyFromConfig = vi.fn(async () => {
      if (!firstDispatchStarted) {
        firstDispatchStarted = true;
        await new Promise<void>((resolve) => {
          resolveFirstDispatch = resolve;
        });
      }
      return { counts: { block: 0, final: 1, tool: 0 }, queuedFinal: true };
    });

    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig,
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    // Step 1: trigger msg A — don't await, let it block in dispatch
    const firstHandlerDone = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "msg A", eventId: "$a", ts: 1000 }),
    );

    // Step 2: wait until dispatch is in-flight
    await vi.waitFor(() => {
      expect(firstDispatchStarted).toBe(true);
    });

    // Step 3: msg B arrives while agent is processing — must not be lost
    await handler(DEFAULT_ROOM, makeRoomPlainEvent({ body: "msg B", eventId: "$b", ts: 2000 }));

    // Step 4: unblock dispatch and complete
    resolveFirstDispatch!();
    await firstHandlerDone;
    // Watermark advances to snapshot taken at dispatch time (just after msg A), not to queue end

    // Step 5: trigger msg C — should see [msg B] in history (msg A was consumed)
    await handler(DEFAULT_ROOM, makeRoomTriggerEvent({ body: "msg C", eventId: "$c", ts: 3000 }));

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    const ctxForC = finalizeInboundContext.mock.calls[1]?.[0] as Record<string, unknown>;
    const history = ctxForC["InboundHistory"] as { body: string }[];
    expect(history.some((h) => h.body.includes("msg B"))).toBe(true);
    expect(history.every((h) => !h.body.includes("msg A"))).toBe(true);
  });

  it("watermark does not advance when final reply delivery fails (retry sees same history)", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createFinalDeliveryFailureHandler(finalizeInboundContext);

    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ body: "pending msg", eventId: "$p", ts: 1000 }),
    );

    // First trigger — delivery fails; watermark must NOT advance
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger 1", eventId: "$t1", ts: 2000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledOnce();
    {
      const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as { body: string }[];
      expect(history).toHaveLength(1);
      expect(history[0]?.body).toContain("pending msg");
    }

    // Second trigger — pending msg must still be visible (watermark not advanced)
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger 2", eventId: "$t2", ts: 3000 }),
    );
    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    {
      const ctx = finalizeInboundContext.mock.calls[1]?.[0] as Record<string, unknown>;
      const history = ctx["InboundHistory"] as { body: string }[] | undefined;
      expect(history?.some((h) => h.body.includes("pending msg"))).toBe(true);
    }
  });

  it("retrying the same failed trigger reuses the original history window", async () => {
    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createFinalDeliveryFailureHandler(finalizeInboundContext);

    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ body: "pending msg", eventId: "$p", ts: 1000 }),
    );

    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger", eventId: "$same", ts: 2000 }),
    );
    await handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger", eventId: "$same", ts: 2000 }),
    );

    expect(finalizeInboundContext).toHaveBeenCalledTimes(2);
    const firstHistory = (finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>)[
      "InboundHistory"
    ] as { body: string }[];
    const retryHistory = (finalizeInboundContext.mock.calls[1]?.[0] as Record<string, unknown>)[
      "InboundHistory"
    ] as { body: string }[];

    expect(firstHistory.map((entry) => entry.body)).toEqual(["pending msg"]);
    expect(retryHistory.map((entry) => entry.body)).toEqual(["pending msg"]);
  });

  it("records pending history before sender-name lookup resolves", async () => {
    let resolveFirstName: (() => void) | undefined;
    let firstNameLookupStarted = false;
    const getMemberDisplayName = vi.fn(async () => {
      firstNameLookupStarted = true;
      await new Promise<void>((resolve) => {
        resolveFirstName = resolve;
      });
      return "sender";
    });

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      getMemberDisplayName,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    // Unmentioned message should be buffered without waiting for async sender-name lookup.
    await handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ body: "plain before trigger", eventId: "$slow-name", ts: 1000 }),
    );
    expect(firstNameLookupStarted).toBe(false);

    // Trigger reads pending history first, then can await sender-name lookup later.
    const triggerDone = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "trigger", eventId: "$trigger-after-slow-name", ts: 2000 }),
    );
    await vi.waitFor(() => {
      expect(firstNameLookupStarted).toBe(true);
    });
    resolveFirstName?.();
    await triggerDone;

    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string }[] | undefined;
    expect(history?.some((entry) => entry.body.includes("plain before trigger"))).toBe(true);
  });

  it("preserves arrival order when a plain message starts before a later trigger", async () => {
    let releaseFirstGetUserId: (() => void) | undefined;
    let getUserIdCalls = 0;

    const finalizeInboundContext = vi.fn((ctx: unknown) => ctx);
    const { handler } = createMatrixHandlerTestHarness({
      client: {
        getEvent: async () => ({ sender: "@bot:example.org" }),
        async getUserId() {
          getUserIdCalls += 1;
          if (getUserIdCalls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirstGetUserId = resolve;
            });
          }
          return "@bot:example.org";
        },
      },
      dispatchReplyFromConfig: async () => ({
        counts: { block: 0, final: 1, tool: 0 },
        queuedFinal: true,
      }),
      finalizeInboundContext,
      groupPolicy: "open",
      historyLimit: 20,
      isDirectMessage: false,
    });

    const plainPromise = handler(
      DEFAULT_ROOM,
      makeRoomPlainEvent({ body: "msg A", eventId: "$a", ts: 1000 }),
    );
    await vi.waitFor(() => {
      expect(releaseFirstGetUserId).toBeTypeOf("function");
    });
    const triggerPromise = handler(
      DEFAULT_ROOM,
      makeRoomTriggerEvent({ body: "msg B", eventId: "$b", ts: 2000 }),
    );

    releaseFirstGetUserId?.();
    await Promise.all([plainPromise, triggerPromise]);

    const ctx = finalizeInboundContext.mock.calls[0]?.[0] as Record<string, unknown>;
    const history = ctx["InboundHistory"] as { body: string }[];
    expect(history.map((entry) => entry.body)).toEqual(["msg A"]);
  });
});
