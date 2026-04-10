import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SanitizeSessionHistoryHarness,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeInMemorySessionManager,
  makeModelSnapshotEntry,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage } from "./test-helpers/agent-message-fixtures.js";

vi.mock("./pi-embedded-helpers.js", async () => ({
  ...(await vi.importActual("./pi-embedded-helpers.js")),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderRuntimePlugin: vi.fn(() => undefined),
    sanitizeProviderReplayHistoryWithPlugin: vi.fn(() => undefined),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
  };
});

describe("sanitizeSessionHistory openai tool id preservation", () => {
  let sanitizeSessionHistory: SanitizeSessionHistoryHarness["sanitizeSessionHistory"];

  beforeEach(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    ({ sanitizeSessionHistory } = harness);
  });

  const makeSessionManager = () =>
    makeInMemorySessionManager([
      makeModelSnapshotEntry({
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    ]);

  const makeMessages = (withReasoning: boolean): AgentMessage[] => [
    castAgentMessage({
      content: [
        ...(withReasoning
          ? [
              {
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "rs_123", type: "reasoning" }),
                type: "thinking",
              },
            ]
          : []),
        { arguments: {}, id: "call_123|fc_123", name: "noop", type: "toolCall" },
      ],
      role: "assistant",
    }),
    castAgentMessage({
      content: [{ text: "ok", type: "text" }],
      isError: false,
      role: "toolResult",
      toolCallId: "call_123|fc_123",
      toolName: "noop",
    }),
  ];

  it.each([
    {
      expectedToolId: "call_123",
      name: "strips fc ids when replayable reasoning metadata is missing",
      withReasoning: false,
    },
    {
      expectedToolId: "call_123|fc_123",
      name: "keeps canonical call_id|fc_id pairings when replayable reasoning is present",
      withReasoning: true,
    },
  ])("$name", async ({ withReasoning, expectedToolId }) => {
    const result = await sanitizeSessionHistory({
      messages: makeMessages(withReasoning),
      modelApi: "openai-responses",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: "test-session",
      sessionManager: makeSessionManager(),
    });

    const assistant = result[0] as { content?: { type?: string; id?: string }[] };
    const toolCall = assistant.content?.find((block) => block.type === "toolCall");
    expect(toolCall?.id).toBe(expectedToolId);

    const toolResult = result[1] as { toolCallId?: string };
    expect(toolResult.toolCallId).toBe(expectedToolId);
  });
});
