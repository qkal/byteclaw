import { describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

interface Delivery { kind: string; text?: string }

function createProjectorHarness(cfgOverrides?: Parameters<typeof createCfg>[0]) {
  const deliveries: Delivery[] = [];
  const projector = createAcpReplyProjector({
    cfg: createCfg(cfgOverrides),
    deliver: async (kind, payload) => {
      deliveries.push({ kind, text: payload.text });
      return true;
    },
    shouldSendToolSummaries: true,
  });
  return { deliveries, projector };
}

function createLiveCfgOverrides(
  streamOverrides: Record<string, unknown>,
): Parameters<typeof createCfg>[0] {
  return {
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...streamOverrides,
      },
    },
  } as Parameters<typeof createCfg>[0];
}

function createHiddenBoundaryCfg(
  streamOverrides: Record<string, unknown> = {},
): Parameters<typeof createCfg>[0] {
  return createLiveCfgOverrides({
    coalesceIdleMs: 0,
    maxChunkChars: 256,
    ...streamOverrides,
  });
}

function blockDeliveries(deliveries: Delivery[]) {
  return deliveries.filter((entry) => entry.kind === "block");
}

function combinedBlockText(deliveries: Delivery[]) {
  return blockDeliveries(deliveries)
    .map((entry) => entry.text ?? "")
    .join("");
}

function expectToolCallSummary(delivery: Delivery | undefined) {
  expect(delivery?.kind).toBe("tool");
  expect(delivery?.text).toContain("Tool Call");
}

function createFinalOnlyStatusToolHarness() {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        deliveryMode: "final_only",
        maxChunkChars: 512,
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
        },
      },
    },
  });
}

function createLiveToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  maxSessionUpdateChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

function createLiveStatusAndToolLifecycleHarness(params?: {
  coalesceIdleMs?: number;
  maxChunkChars?: number;
  repeatSuppression?: boolean;
}) {
  return createProjectorHarness({
    acp: {
      enabled: true,
      stream: {
        deliveryMode: "live",
        ...params,
        tagVisibility: {
          available_commands_update: true,
          tool_call: true,
          tool_call_update: true,
        },
      },
    },
  });
}

async function emitToolLifecycleEvent(
  projector: ReturnType<typeof createProjectorHarness>["projector"],
  event: {
    tag: "tool_call" | "tool_call_update";
    toolCallId: string;
    status: "in_progress" | "completed";
    title?: string;
    text: string;
  },
) {
  await projector.onEvent({
    type: "tool_call",
    ...event,
  });
}

async function runHiddenBoundaryCase(params: {
  cfgOverrides?: Parameters<typeof createCfg>[0];
  toolCallId: string;
  includeNonTerminalUpdate?: boolean;
  firstText?: string;
  secondText?: string;
  expectedText: string;
}) {
  const { deliveries, projector } = createProjectorHarness(params.cfgOverrides);
  await projector.onEvent({
    tag: "agent_message_chunk",
    text: params.firstText ?? "fallback.",
    type: "text_delta",
  });
  await projector.onEvent({
    status: "in_progress",
    tag: "tool_call",
    text: "Run test (in_progress)",
    title: "Run test",
    toolCallId: params.toolCallId,
    type: "tool_call",
  });
  if (params.includeNonTerminalUpdate) {
    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call_update",
      text: "Run test (in_progress)",
      title: "Run test",
      toolCallId: params.toolCallId,
      type: "tool_call",
    });
  }
  await projector.onEvent({
    tag: "agent_message_chunk",
    text: params.secondText ?? "I don't",
    type: "text_delta",
  });
  await projector.flush(true);

  expect(combinedBlockText(deliveries)).toBe(params.expectedText);
}

describe("createAcpReplyProjector", () => {
  it("coalesces text deltas into bounded block chunks", async () => {
    const { deliveries, projector } = createProjectorHarness();

    await projector.onEvent({
      tag: "agent_message_chunk",
      text: "a".repeat(70),
      type: "text_delta",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([
      { kind: "block", text: "a".repeat(64) },
      { kind: "block", text: "a".repeat(6) },
    ]);
  });

  it("does not suppress identical short text across terminal turn boundaries", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
      }),
    );

    await projector.onEvent({ tag: "agent_message_chunk", text: "A", type: "text_delta" });
    await projector.onEvent({ stopReason: "end_turn", type: "done" });
    await projector.onEvent({ tag: "agent_message_chunk", text: "A", type: "text_delta" });
    await projector.onEvent({ stopReason: "end_turn", type: "done" });

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "A" },
      { kind: "block", text: "A" },
    ]);
  });

  it("flushes staggered live text deltas after idle gaps", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 50,
          maxChunkChars: 64,
        }),
      );

      await projector.onEvent({ tag: "agent_message_chunk", text: "A", type: "text_delta" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ tag: "agent_message_chunk", text: "B", type: "text_delta" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ tag: "agent_message_chunk", text: "C", type: "text_delta" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      expect(blockDeliveries(deliveries)).toEqual([
        { kind: "block", text: "A" },
        { kind: "block", text: "B" },
        { kind: "block", text: "C" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits oversized live text by maxChunkChars", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          deliveryMode: "live",
          maxChunkChars: 50,
        },
      },
    });

    const text = `${"a".repeat(50)}${"b".repeat(50)}${"c".repeat(20)}`;
    await projector.onEvent({ tag: "agent_message_chunk", text, type: "text_delta" });
    await projector.flush(true);

    expect(blockDeliveries(deliveries)).toEqual([
      { kind: "block", text: "a".repeat(50) },
      { kind: "block", text: "b".repeat(50) },
      { kind: "block", text: "c".repeat(20) },
    ]);
  });

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    try {
      const { deliveries, projector } = createProjectorHarness(
        createLiveCfgOverrides({
          coalesceIdleMs: 100,
          maxChunkChars: 256,
        }),
      );

      await projector.onEvent({
        tag: "agent_message_chunk",
        text: "Yes. Send me the term(s), and I’ll run ",
        type: "text_delta",
      });

      await vi.advanceTimersByTimeAsync(1200);
      expect(deliveries).toEqual([]);

      await projector.onEvent({
        tag: "agent_message_chunk",
        text: "`wd-cli` searches right away. ",
        type: "text_delta",
      });
      await projector.flush(false);

      expect(deliveries).toEqual([
        {
          kind: "block",
          text: "Yes. Send me the term(s), and I’ll run `wd-cli` searches right away. ",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports deliveryMode=final_only by buffering all projected output until done", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      tag: "agent_message_chunk",
      text: "What",
      type: "text_delta",
    });
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (7)",
      type: "status",
    });
    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call",
      text: "List files (in_progress)",
      title: "List files",
      toolCallId: "call_1",
      type: "tool_call",
    });
    await projector.onEvent({
      tag: "agent_message_chunk",
      text: " now?",
      type: "text_delta",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ type: "done" });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
    expect(deliveries[2]).toEqual({ kind: "block", text: "What now?" });
  });

  it("flushes buffered status/tool output on error in deliveryMode=final_only", async () => {
    const { deliveries, projector } = createFinalOnlyStatusToolHarness();

    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (7)",
      type: "status",
    });
    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call",
      text: "Run tests (in_progress)",
      title: "Run tests",
      toolCallId: "call_2",
      type: "tool_call",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ message: "turn failed", type: "error" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expectToolCallSummary(deliveries[1]);
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const { deliveries: hidden, projector: hiddenProjector } = createProjectorHarness();
    await hiddenProjector.onEvent({
      size: 100,
      tag: "usage_update",
      text: "usage updated: 10/100",
      type: "status",
      used: 10,
    });
    expect(hidden).toEqual([]);

    const { deliveries: shown, projector: shownProjector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 64,
        tagVisibility: {
          usage_update: true,
        },
      }),
    );

    await shownProjector.onEvent({
      size: 100,
      tag: "usage_update",
      text: "usage updated: 10/100",
      type: "status",
      used: 10,
    });
    await shownProjector.onEvent({
      size: 100,
      tag: "usage_update",
      text: "usage updated: 10/100",
      type: "status",
      used: 10,
    });
    await shownProjector.onEvent({
      size: 100,
      tag: "usage_update",
      text: "usage updated: 11/100",
      type: "status",
      used: 11,
    });

    expect(shown).toEqual([
      { kind: "tool", text: prefixSystemMessage("usage updated: 10/100") },
      { kind: "tool", text: prefixSystemMessage("usage updated: 11/100") },
    ]);
  });

  it("hides available_commands_update by default", async () => {
    const { deliveries, projector } = createProjectorHarness();
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (7)",
      type: "status",
    });

    expect(deliveries).toEqual([]);
  });

  it("dedupes repeated tool lifecycle updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await emitToolLifecycleEvent(projector, {
      status: "in_progress",
      tag: "tool_call",
      text: "List files (in_progress)",
      title: "List files",
      toolCallId: "call_1",
    });
    await emitToolLifecycleEvent(projector, {
      status: "in_progress",
      tag: "tool_call_update",
      text: "List files (in_progress)",
      title: "List files",
      toolCallId: "call_1",
    });
    await emitToolLifecycleEvent(projector, {
      status: "completed",
      tag: "tool_call_update",
      text: "List files (completed)",
      title: "List files",
      toolCallId: "call_1",
    });
    await emitToolLifecycleEvent(projector, {
      status: "completed",
      tag: "tool_call_update",
      text: "List files (completed)",
      title: "List files",
      toolCallId: "call_1",
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expectToolCallSummary(deliveries[1]);
  });

  it("keeps terminal tool updates even when rendered summaries are truncated", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness({
      maxSessionUpdateChars: 48,
    });

    const longTitle =
      "Run an intentionally long command title that truncates before lifecycle status is visible";
    await emitToolLifecycleEvent(projector, {
      status: "in_progress",
      tag: "tool_call",
      text: `${longTitle} (in_progress)`,
      title: longTitle,
      toolCallId: "call_truncated_status",
    });
    await emitToolLifecycleEvent(projector, {
      status: "completed",
      tag: "tool_call_update",
      text: `${longTitle} (completed)`,
      title: longTitle,
      toolCallId: "call_truncated_status",
    });

    expect(deliveries.length).toBe(2);
    expectToolCallSummary(deliveries[0]);
    expectToolCallSummary(deliveries[1]);
  });

  it("renders fallback tool labels without leaking call ids as primary label", async () => {
    const { deliveries, projector } = createLiveToolLifecycleHarness();

    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call",
      text: "call_ABC123 (in_progress)",
      toolCallId: "call_ABC123",
      type: "tool_call",
    });

    expectToolCallSummary(deliveries[0]);
    expect(deliveries[0]?.text).not.toContain("call_ABC123 (");
  });

  it("allows repeated status/tool summaries when repeatSuppression is disabled", async () => {
    const { deliveries, projector } = createLiveStatusAndToolLifecycleHarness({
      coalesceIdleMs: 0,
      maxChunkChars: 256,
      repeatSuppression: false,
    });

    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated",
      type: "status",
    });
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated",
      type: "status",
    });
    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call",
      text: "tool call",
      toolCallId: "x",
      type: "tool_call",
    });
    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call_update",
      text: "tool call",
      toolCallId: "x",
      type: "tool_call",
    });
    await projector.onEvent({
      tag: "agent_message_chunk",
      text: "hello",
      type: "text_delta",
    });
    await projector.flush(true);

    expect(deliveries.filter((entry) => entry.kind === "tool").length).toBe(4);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expect(deliveries[1]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expectToolCallSummary(deliveries[2]);
    expectToolCallSummary(deliveries[3]);
    expect(deliveries[4]).toEqual({ kind: "block", text: "hello" });
  });

  it("suppresses exact duplicate status updates when repeatSuppression is enabled", async () => {
    const { deliveries, projector } = createProjectorHarness(
      createLiveCfgOverrides({
        coalesceIdleMs: 0,
        maxChunkChars: 256,
        tagVisibility: {
          available_commands_update: true,
        },
      }),
    );

    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (7)",
      type: "status",
    });
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (7)",
      type: "status",
    });
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated (8)",
      type: "status",
    });

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

  it("truncates oversized turns once and emits one truncation notice", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          deliveryMode: "live",
          maxChunkChars: 256,
          maxOutputChars: 5,
        },
      },
    });

    await projector.onEvent({
      tag: "agent_message_chunk",
      text: "hello world",
      type: "text_delta",
    });
    await projector.onEvent({
      tag: "agent_message_chunk",
      text: "ignored tail",
      type: "text_delta",
    });
    await projector.flush(true);

    expect(deliveries).toHaveLength(2);
    expect(deliveries).toContainEqual({ kind: "block", text: "hello" });
    expect(deliveries).toContainEqual({
      kind: "tool",
      text: prefixSystemMessage("output truncated"),
    });
  });

  it("supports tagVisibility overrides for tool updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          deliveryMode: "live",
          maxChunkChars: 256,
          tagVisibility: {
            tool_call: true,
            tool_call_update: false,
          },
        },
      },
    });

    await projector.onEvent({
      status: "in_progress",
      tag: "tool_call",
      text: "Run tests (in_progress)",
      title: "Run tests",
      toolCallId: "c1",
      type: "tool_call",
    });
    await projector.onEvent({
      status: "completed",
      tag: "tool_call_update",
      text: "Run tests (completed)",
      title: "Run tests",
      toolCallId: "c1",
      type: "tool_call",
    });

    expect(deliveries.length).toBe(1);
    expectToolCallSummary(deliveries[0]);
  });

  it("inserts a space boundary before visible text after hidden tool updates by default", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg(),
      expectedText: "fallback. I don't",
      toolCallId: "call_hidden_1",
    });
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        tagVisibility: {
          tool_call: false,
          tool_call_update: false,
        },
      }),
      expectedText: "fallback. I don't",
      includeNonTerminalUpdate: true,
      toolCallId: "hidden_boundary_1",
    });
  });

  it("supports hiddenBoundarySeparator=space", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "space",
      }),
      expectedText: "fallback. I don't",
      toolCallId: "call_hidden_2",
    });
  });

  it("supports hiddenBoundarySeparator=none", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg({
        hiddenBoundarySeparator: "none",
      }),
      expectedText: "fallback.I don't",
      toolCallId: "call_hidden_3",
    });
  });

  it("does not duplicate newlines when previous visible text already ends with newline", async () => {
    await runHiddenBoundaryCase({
      cfgOverrides: createHiddenBoundaryCfg(),
      expectedText: "fallback.\nI don't",
      firstText: "fallback.\n",
      toolCallId: "call_hidden_4",
    });
  });

  it("does not insert boundary separator for hidden non-tool status updates", async () => {
    const { deliveries, projector } = createProjectorHarness({
      acp: {
        enabled: true,
        stream: {
          coalesceIdleMs: 0,
          deliveryMode: "live",
          maxChunkChars: 256,
        },
      },
    });

    await projector.onEvent({ tag: "agent_message_chunk", text: "A", type: "text_delta" });
    await projector.onEvent({
      tag: "available_commands_update",
      text: "available commands updated",
      type: "status",
    });
    await projector.onEvent({ tag: "agent_message_chunk", text: "B", type: "text_delta" });
    await projector.flush(true);

    expect(combinedBlockText(deliveries)).toBe("AB");
  });
});
