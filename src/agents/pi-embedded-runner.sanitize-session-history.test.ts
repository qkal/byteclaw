import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Usage, UserMessage } from "@mariozechner/pi-ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SanitizeSessionHistoryFn,
  type SanitizeSessionHistoryHarness,
  TEST_SESSION_ID,
  expectOpenAIResponsesStrictSanitizeCall,
  loadSanitizeSessionHistoryWithCleanMocks,
  makeInMemorySessionManager,
  makeMockSessionManager,
  makeModelSnapshotEntry,
  makeReasoningAssistantMessages,
  makeSimpleUserMessages,
  sanitizeSnapshotChangedOpenAIReasoning,
  sanitizeWithOpenAIResponses,
} from "./pi-embedded-runner.sanitize-session-history.test-harness.js";
import { castAgentMessage, castAgentMessages } from "./test-helpers/agent-message-fixtures.js";
import type { TranscriptPolicy } from "./transcript-policy.js";
import { makeZeroUsageSnapshot } from "./usage.js";

vi.mock("./pi-embedded-helpers.js", async () => ({
  ...(await vi.importActual("./pi-embedded-helpers.js")),
  isGoogleModelApi: vi.fn(),
  sanitizeSessionMessagesImages: vi.fn(async (msgs) => msgs),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderRuntimePlugin: ({ provider }: { provider?: string }) =>
      provider === "openrouter" || provider === "github-copilot"
        ? {
            buildReplayPolicy: (context?: { modelId?: string | null }) => {
              const modelId = String(context?.modelId ?? "").toLowerCase();
              if (provider === "openrouter") {
                return {
                  applyAssistantFirstOrderingFix: false,
                  validateAnthropicTurns: false,
                  validateGeminiTurns: false,
                  ...(modelId.includes("gemini")
                    ? {
                        sanitizeThoughtSignatures: {
                          allowBase64Only: true,
                          includeCamelCase: true,
                        },
                      }
                    : {}),
                };
              }
              if (provider === "github-copilot" && modelId.includes("claude")) {
                return {
                  dropThinkingBlocks: true,
                };
              }
              return undefined;
            },
          }
        : undefined,
    sanitizeProviderReplayHistoryWithPlugin: vi.fn(
      async ({
        provider,
        context,
      }: {
        provider?: string;
        context: {
          messages: AgentMessage[];
          sessionState?: {
            appendCustomEntry(customType: string, data: unknown): void;
          };
        };
      }) => {
        if (
          provider &&
          provider.startsWith("google") &&
          context.messages[0]?.role === "assistant" &&
          context.sessionState
        ) {
          context.sessionState.appendCustomEntry("google-turn-ordering-bootstrap", {
            timestamp: Date.now(),
          });
          return [
            { content: "(session bootstrap)", role: "user" } as AgentMessage,
            ...context.messages,
          ];
        }
        return context.messages;
      },
    ),
    validateProviderReplayTurnsWithPlugin: vi.fn(() => undefined),
  };
});

let sanitizeSessionHistory: SanitizeSessionHistoryFn;
let mockedHelpers: SanitizeSessionHistoryHarness["mockedHelpers"];
let testTimestamp = 1;
const nextTimestamp = () => testTimestamp++;

// We don't mock session-transcript-repair.js as it is a pure function and complicates mocking.
// We rely on the real implementation which should pass through our simple messages.

describe("sanitizeSessionHistory", () => {
  let mockSessionManager: ReturnType<typeof makeMockSessionManager>;
  const mockMessages = makeSimpleUserMessages();
  const setNonGoogleModelApi = () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);
  };

  const sanitizeGithubCopilotHistory = async (params: {
    messages: AgentMessage[];
    modelApi?: string;
    modelId?: string;
  }) =>
    sanitizeSessionHistory({
      messages: params.messages,
      modelApi: params.modelApi ?? "openai-completions",
      modelId: params.modelId ?? "claude-opus-4.6",
      provider: "github-copilot",
      sessionId: TEST_SESSION_ID,
      sessionManager: makeMockSessionManager(),
    });

  const sanitizeAnthropicHistory = async (params: {
    messages: AgentMessage[];
    provider?: string;
    modelApi?: string;
    modelId?: string;
    policy?: TranscriptPolicy;
  }) =>
    sanitizeSessionHistory({
      messages: params.messages,
      modelApi: params.modelApi ?? "anthropic-messages",
      modelId: params.modelId ?? "claude-opus-4-6",
      policy: params.policy,
      provider: params.provider ?? "anthropic",
      sessionId: TEST_SESSION_ID,
      sessionManager: makeMockSessionManager(),
    });

  const getAssistantMessage = (messages: AgentMessage[]) => {
    expect(messages[1]?.role).toBe("assistant");
    return messages[1] as Extract<AgentMessage, { role: "assistant" }>;
  };

  const getAssistantContentTypes = (messages: AgentMessage[]) =>
    getAssistantMessage(messages).content.map((block: { type: string }) => block.type);

  const makeThinkingAndTextAssistantMessages = (
    thinkingSignature: string = "some_sig",
  ): AgentMessage[] => {
    const user: UserMessage = {
      content: "hello",
      role: "user",
      timestamp: nextTimestamp(),
    };
    const assistant: AssistantMessage = {
      api: "openai-responses",
      content: [
        {
          thinking: "internal",
          thinkingSignature,
          type: "thinking",
        },
        { text: "hi", type: "text" },
      ],
      model: "gpt-5.4",
      provider: "openai",
      role: "assistant",
      stopReason: "stop",
      timestamp: nextTimestamp(),
      usage: makeUsage(0, 0, 0),
    };
    return [user, assistant];
  };

  const makeUsage = (input: number, output: number, totalTokens: number): Usage => ({
    cacheRead: 0,
    cacheWrite: 0,
    cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
    input,
    output,
    totalTokens,
  });

  const makeAssistantUsageMessage = (params: {
    text: string;
    usage: ReturnType<typeof makeUsage>;
    timestamp?: number;
  }): AssistantMessage => ({
    api: "openai-responses",
    content: [{ text: params.text, type: "text" }],
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant",
    stopReason: "stop",
    timestamp: params.timestamp ?? nextTimestamp(),
    usage: params.usage,
  });

  const makeUserMessage = (content: string, timestamp = nextTimestamp()): UserMessage => ({
    content,
    role: "user",
    timestamp,
  });

  const makeAssistantMessage = (
    content: AssistantMessage["content"],
    params: {
      stopReason?: AssistantMessage["stopReason"];
      usage?: Usage;
      timestamp?: number;
    } = {},
  ): AssistantMessage => ({
    api: "openai-responses",
    content,
    model: "gpt-5.4",
    provider: "openai",
    role: "assistant",
    stopReason: params.stopReason ?? "stop",
    timestamp: params.timestamp ?? nextTimestamp(),
    usage: params.usage ?? makeUsage(0, 0, 0),
  });

  const makeCompactionSummaryMessage = (tokensBefore: number, timestamp: string) =>
    castAgentMessage({
      role: "compactionSummary",
      summary: "compressed",
      timestamp,
      tokensBefore,
    });

  const sanitizeOpenAIHistory = async (
    messages: AgentMessage[],
    overrides: Partial<Parameters<SanitizeSessionHistoryFn>[0]> = {},
  ) =>
    sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
      ...overrides,
    });

  const getAssistantMessages = (messages: AgentMessage[]) =>
    messages.filter((message) => message.role === "assistant") as (AgentMessage & { usage?: unknown; content?: unknown })[];

  const getSingleAssistantUsage = async (messages: AgentMessage[]) => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);
    const result = await sanitizeOpenAIHistory(messages);
    return result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
  };

  beforeAll(async () => {
    const harness = await loadSanitizeSessionHistoryWithCleanMocks();
    ({ sanitizeSessionHistory } = harness);
    ({ mockedHelpers } = harness);
  });

  beforeEach(() => {
    testTimestamp = 1;
    vi.clearAllMocks();
    vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
    mockSessionManager = makeMockSessionManager();
  });

  it("passes simple user-only history through for Google model APIs", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("lets Google provider hooks prepend a bootstrap turn and persist a marker", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(true);
    const sessionEntries: { type: string; customType: string; data: unknown }[] = [];
    const sessionManager = makeInMemorySessionManager(sessionEntries);

    const result = await sanitizeSessionHistory({
      messages: castAgentMessages([
        {
          content: [{ type: "text", text: "hello from previous turn" }],
          role: "assistant",
        },
      ]),
      modelApi: "google-generative-ai",
      provider: "google-vertex",
      sessionId: TEST_SESSION_ID,
      sessionManager,
    });

    expect(result[0]).toMatchObject({
      content: "(session bootstrap)",
      role: "user",
    });
    expect(
      sessionEntries.some((entry) => entry.customType === "google-turn-ordering-bootstrap"),
    ).toBe(true);
  });

  it("passes simple user-only history through for Mistral models", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      modelId: "mistralai/devstral-2512:free",
      provider: "openrouter",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for Anthropic APIs", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "anthropic-messages",
      provider: "anthropic",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("passes simple user-only history through for openai-responses", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeWithOpenAIResponses({
      messages: mockMessages,
      sanitizeSessionHistory,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("sanitizes tool call ids for OpenAI-compatible responses providers", async () => {
    setNonGoogleModelApi();

    await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-responses",
      provider: "custom",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expectOpenAIResponsesStrictSanitizeCall(
      mockedHelpers.sanitizeSessionMessagesImages,
      mockMessages,
    );
  });

  it("sanitizes tool call ids for openai-completions", async () => {
    setNonGoogleModelApi();

    const result = await sanitizeSessionHistory({
      messages: mockMessages,
      modelApi: "openai-completions",
      modelId: "gpt-5.4",
      provider: "openai",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expect(result).toEqual(mockMessages);
  });

  it("prepends a bootstrap user turn for strict OpenAI-compatible assistant-first history", async () => {
    setNonGoogleModelApi();
    const sessionEntries: { type: string; customType: string; data: unknown }[] = [];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = castAgentMessages([
      {
        content: [{ text: "hello from previous turn", type: "text" }],
        role: "assistant",
      },
    ]);

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-completions",
      modelId: "gemma-3-27b",
      provider: "vllm",
      sessionId: TEST_SESSION_ID,
      sessionManager,
    });

    expect(result[0]?.role).toBe("user");
    expect((result[0] as { content?: unknown } | undefined)?.content).toBe("(session bootstrap)");
    expect(result[1]?.role).toBe("assistant");
    expect(
      sessionEntries.some((entry) => entry.customType === "google-turn-ordering-bootstrap"),
    ).toBe(false);
  });

  it("annotates inter-session user messages before context sanitization", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      castAgentMessage({
        content: "forwarded instruction",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:req",
          sourceTool: "sessions_send",
        },
        role: "user",
      }),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    const first = result[0] as Extract<AgentMessage, { role: "user" }>;
    expect(first.role).toBe("user");
    expect(typeof first.content).toBe("string");
    expect(first.content as string).toContain("[Inter-session message]");
    expect(first.content as string).toContain("sourceSession=agent:main:req");
  });

  it("drops stale assistant usage snapshots kept before latest compaction summary", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const messages = castAgentMessages([
      { content: "old context", role: "user" },
      makeAssistantUsageMessage({
        text: "old answer",
        usage: makeUsage(191_919, 2000, 193_919),
      }),
      makeCompactionSummaryMessage(191_919, new Date().toISOString()),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const staleAssistant = result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
    expect(staleAssistant).toBeDefined();
    expect(staleAssistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("preserves fresh assistant usage snapshots created after latest compaction summary", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const messages = castAgentMessages([
      makeAssistantUsageMessage({
        text: "pre-compaction answer",
        usage: makeUsage(120_000, 3000, 123_000),
      }),
      makeCompactionSummaryMessage(123_000, new Date().toISOString()),
      { content: "new question", role: "user" },
      makeAssistantUsageMessage({
        text: "fresh answer",
        usage: makeUsage(1000, 250, 1250),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistants = getAssistantMessages(result);
    expect(assistants).toHaveLength(2);
    expect(assistants[0]?.usage).toEqual(makeZeroUsageSnapshot());
    expect(assistants[1]?.usage).toBeDefined();
  });

  it("adds a zeroed assistant usage snapshot when usage is missing", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { content: "question", role: "user" },
        {
          content: [{ text: "answer without usage", type: "text" }],
          role: "assistant",
        },
      ]),
    );

    expect(assistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("normalizes mixed partial assistant usage fields to numeric totals", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { content: "question", role: "user" },
        {
          content: [{ text: "answer with partial usage", type: "text" }],
          role: "assistant",
          usage: {
            cache_read_input_tokens: 9,
            output: 3,
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      cacheRead: 9,
      cacheWrite: 0,
      input: 0,
      output: 3,
      totalTokens: 12,
    });
  });

  it("preserves existing usage cost while normalizing token fields", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { content: "question", role: "user" },
        {
          content: [{ text: "answer with partial usage and cost", type: "text" }],
          role: "assistant",
          usage: {
            cache_read_input_tokens: 9,
            cost: {
              cacheRead: 0.25,
              cacheWrite: 0,
              input: 1.25,
              output: 2.5,
              total: 4,
            },
            output: 3,
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      ...makeZeroUsageSnapshot(),
      cacheRead: 9,
      cacheWrite: 0,
      cost: {
        cacheRead: 0.25,
        cacheWrite: 0,
        input: 1.25,
        output: 2.5,
        total: 4,
      },
      input: 0,
      output: 3,
      totalTokens: 12,
    });
  });

  it("preserves unknown cost when token fields already match", async () => {
    const assistant = await getSingleAssistantUsage(
      castAgentMessages([
        { content: "question", role: "user" },
        {
          content: [{ text: "answer with complete numeric usage but no cost", type: "text" }],
          role: "assistant",
          usage: {
            cacheRead: 3,
            cacheWrite: 4,
            input: 1,
            output: 2,
            totalTokens: 10,
          },
        },
      ]),
    );

    expect(assistant?.usage).toEqual({
      cacheRead: 3,
      cacheWrite: 4,
      input: 1,
      output: 2,
      totalTokens: 10,
    });
    expect((assistant?.usage as { cost?: unknown } | undefined)?.cost).toBeUndefined();
  });

  it("drops stale usage when compaction summary appears before kept assistant messages", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const compactionTs = Date.parse("2026-02-26T12:00:00.000Z");
    const messages = castAgentMessages([
      makeCompactionSummaryMessage(191_919, new Date(compactionTs).toISOString()),
      makeAssistantUsageMessage({
        text: "kept pre-compaction answer",
        timestamp: compactionTs - 1000,
        usage: makeUsage(191_919, 2000, 193_919),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistant = result.find((message) => message.role === "assistant") as
      | (AgentMessage & { usage?: unknown })
      | undefined;
    expect(assistant?.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("keeps fresh usage after compaction timestamp in summary-first ordering", async () => {
    vi.mocked(mockedHelpers.isGoogleModelApi).mockReturnValue(false);

    const compactionTs = Date.parse("2026-02-26T12:00:00.000Z");
    const messages = castAgentMessages([
      makeCompactionSummaryMessage(123_000, new Date(compactionTs).toISOString()),
      makeAssistantUsageMessage({
        text: "kept pre-compaction answer",
        timestamp: compactionTs - 2000,
        usage: makeUsage(120_000, 3000, 123_000),
      }),
      { content: "new question", role: "user", timestamp: compactionTs + 1000 },
      makeAssistantUsageMessage({
        text: "fresh answer",
        timestamp: compactionTs + 2000,
        usage: makeUsage(1000, 250, 1250),
      }),
    ]);

    const result = await sanitizeOpenAIHistory(messages);

    const assistants = getAssistantMessages(result);
    const keptAssistant = assistants.find((message) =>
      JSON.stringify(message.content).includes("kept pre-compaction answer"),
    );
    const freshAssistant = assistants.find((message) =>
      JSON.stringify(message.content).includes("fresh answer"),
    );
    expect(keptAssistant?.usage).toEqual(makeZeroUsageSnapshot());
    expect(freshAssistant?.usage).toBeDefined();
  });

  it("keeps reasoning-only assistant messages for openai-responses", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage(
        [
          {
            thinking: "reasoning",
            thinkingSignature: "sig",
            type: "thinking",
          },
        ],
        { stopReason: "aborted" },
      ),
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "openai-responses",
      provider: "openai",
      sessionId: TEST_SESSION_ID,
      sessionManager: mockSessionManager,
    });

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
  });

  it("synthesizes missing tool results for openai-responses after repair", async () => {
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ arguments: {}, id: "call_1", name: "read", type: "toolCall" }], {
        stopReason: "toolUse",
      }),
    ];

    const result = await sanitizeOpenAIHistory(messages);

    // RepairToolUseResultPairing now runs for all providers (including OpenAI)
    // To fix orphaned function_call_output items that OpenAI would reject.
    expect(result).toHaveLength(2);
    expect(result[0]?.role).toBe("assistant");
    expect(result[1]?.role).toBe("toolResult");
  });

  it.each([
    {
      makeMessages: () =>
        castAgentMessages([
          castAgentMessage({
            content: [{ type: "toolCall", id: "call_1", name: "read" }],
            role: "assistant",
          }),
          makeUserMessage("hello"),
        ]),
      name: "missing input or arguments",
      overrides: { sessionId: "test-session" } as Partial<
        Parameters<typeof sanitizeOpenAIHistory>[1]
      >,
    },
    {
      makeMessages: () =>
        castAgentMessages([
          makeAssistantMessage(
            [
              {
                arguments: {},
                id: "call_bad",
                name: 'toolu_01mvznfebfuu <|tool_call_argument_begin|> {"command"',
                type: "toolCall",
              },
              {
                arguments: {},
                id: "call_long",
                name: `read_${"x".repeat(80)}`,
                type: "toolCall",
              },
            ],
            { stopReason: "toolUse" },
          ),
          makeUserMessage("hello"),
        ]),
      name: "invalid or overlong names",
      overrides: {} as Partial<Parameters<typeof sanitizeOpenAIHistory>[1]>,
    },
  ])("drops malformed tool calls: $name", async ({ makeMessages, overrides }) => {
    const result = await sanitizeOpenAIHistory(makeMessages(), overrides);
    expect(result.map((msg) => msg.role)).toEqual(["user"]);
  });

  it("drops tool calls that are not in the allowed tool set", async () => {
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ arguments: {}, id: "call_1", name: "write", type: "toolCall" }], {
        stopReason: "toolUse",
      }),
    ];

    const result = await sanitizeOpenAIHistory(messages, {
      allowedToolNames: ["read"],
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning even when the model has not changed", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages = makeReasoningAssistantMessages({ thinkingSignature: "json" });

    const result = await sanitizeWithOpenAIResponses({
      messages,
      modelId: "gpt-5.4",
      sanitizeSessionHistory,
      sessionManager,
    });

    expect(result).toEqual([]);
  });

  it("downgrades orphaned openai reasoning when the model changes too", async () => {
    const result = await sanitizeSnapshotChangedOpenAIReasoning({
      sanitizeSessionHistory,
    });

    expect(result).toEqual([]);
  });

  it("drops orphaned toolResult entries when switching from openai history to anthropic", async () => {
    const sessionEntries = [
      makeModelSnapshotEntry({
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
        provider: "openai",
      }),
    ];
    const sessionManager = makeInMemorySessionManager(sessionEntries);
    const messages: AgentMessage[] = [
      makeAssistantMessage([{ arguments: {}, id: "tool_abc123", name: "read", type: "toolCall" }], {
        stopReason: "toolUse",
      }),
      {
        content: [{ text: "ok", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: nextTimestamp(),
        toolCallId: "tool_abc123",
        toolName: "read",
      },
      makeUserMessage("continue"),
      {
        content: [{ text: "stale result", type: "text" }],
        isError: false,
        role: "toolResult",
        timestamp: nextTimestamp(),
        toolCallId: "tool_01VihkDRptyLpX1ApUPe7ooU",
        toolName: "read",
      },
    ];

    const result = await sanitizeSessionHistory({
      messages,
      modelApi: "anthropic-messages",
      modelId: "claude-opus-4-6",
      provider: "anthropic",
      sessionId: TEST_SESSION_ID,
      sessionManager,
    });

    expect(result.map((msg) => msg.role)).toEqual(["assistant", "toolResult", "user"]);
    expect(
      result.some(
        (msg) =>
          msg.role === "toolResult" &&
          (msg as { toolCallId?: string }).toolCallId === "tool_01VihkDRptyLpX1ApUPe7ooU",
      ),
    ).toBe(false);
  });

  it("preserves latest assistant thinking blocks for github-copilot models", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages("reasoning_text");

    const result = await sanitizeGithubCopilotHistory({ messages });
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        thinking: "internal",
        thinkingSignature: "reasoning_text",
        type: "thinking",
      },
      { text: "hi", type: "text" },
    ]);
  });

  it("preserves latest assistant turn when all content is thinking blocks (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("hello"),
      makeAssistantMessage([
        {
          thinking: "some reasoning",
          thinkingSignature: "reasoning_text",
          type: "thinking",
        },
      ]),
      makeUserMessage("follow up"),
    ];

    const result = await sanitizeGithubCopilotHistory({ messages });

    expect(result).toHaveLength(3);
    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        thinking: "some reasoning",
        thinkingSignature: "reasoning_text",
        type: "thinking",
      },
    ]);
  });

  it("preserves thinking blocks alongside tool_use blocks in latest assistant message (github-copilot)", async () => {
    setNonGoogleModelApi();

    const messages: AgentMessage[] = [
      makeUserMessage("read a file"),
      makeAssistantMessage([
        {
          thinking: "I should use the read tool",
          thinkingSignature: "reasoning_text",
          type: "thinking",
        },
        { arguments: { path: "/tmp/test" }, id: "tool_123", name: "read", type: "toolCall" },
        { text: "Let me read that file.", type: "text" },
      ]),
    ];

    const result = await sanitizeGithubCopilotHistory({ messages });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
    expect(types).toContain("toolCall");
    expect(types).toContain("text");
  });

  it("preserves latest assistant thinking blocks for anthropic replay", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeAnthropicHistory({ messages });

    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        thinking: "internal",
        thinkingSignature: "some_sig",
        type: "thinking",
      },
      { text: "hi", type: "text" },
    ]);
  });

  it("keeps the earlier anthropic replay prefix stable after a later subagent turn", async () => {
    setNonGoogleModelApi();

    const priorToolId = "toolu_01ABCDEF1234567890";
    const laterToolId = "toolu_01ZZZZZZ9999999999";
    const nativeAnthropicPolicy: TranscriptPolicy = {
      allowSyntheticToolResults: true,
      applyGoogleTurnOrdering: false,
      dropThinkingBlocks: true,
      preserveNativeAnthropicToolUseIds: true,
      preserveSignatures: true,
      repairToolUseResultPairing: true,
      sanitizeMode: "full",
      sanitizeThinkingSignatures: false,
      sanitizeThoughtSignatures: undefined,
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
      validateAnthropicTurns: true,
      validateGeminiTurns: false,
    };
    const baseMessages = castAgentMessages([
      makeUserMessage("Read IDENTITY.md"),
      makeAssistantMessage(
        [
          { id: priorToolId, input: { path: "IDENTITY.md" }, name: "read", type: "toolUse" },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      {
        content: [{ text: "ok", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: priorToolId,
        toolName: "read",
        toolUseId: priorToolId,
      },
      makeAssistantMessage([{ text: "done", type: "text" }]),
    ]);
    const withSubagentMessages = castAgentMessages([
      ...baseMessages,
      makeUserMessage("Ask a subagent for an emoji"),
      makeAssistantMessage(
        [
          { id: laterToolId, input: { prompt: "emoji" }, name: "subagent", type: "toolUse" },
        ] as unknown as AssistantMessage["content"],
        { stopReason: "toolUse" },
      ),
      {
        content: [{ text: "😀", type: "text" }],
        isError: false,
        role: "toolResult",
        toolCallId: laterToolId,
        toolName: "subagent",
        toolUseId: laterToolId,
      },
      makeAssistantMessage([{ text: "it was 😀", type: "text" }]),
    ]);

    const sanitizedBase = await sanitizeAnthropicHistory({
      messages: baseMessages,
      policy: nativeAnthropicPolicy,
    });
    const sanitizedWithSubagent = await sanitizeAnthropicHistory({
      messages: withSubagentMessages,
      policy: nativeAnthropicPolicy,
    });

    expect(sanitizedWithSubagent.slice(0, sanitizedBase.length)).toEqual(sanitizedBase);
    expect((sanitizedBase[1] as Extract<AgentMessage, { role: "assistant" }>).content).toEqual([
      { id: priorToolId, input: { path: "IDENTITY.md" }, name: "read", type: "toolUse" },
    ]);
    expect(
      (sanitizedBase[2] as Extract<AgentMessage, { role: "toolResult" }> & { toolUseId?: string })
        .toolCallId,
    ).toBe(priorToolId);
  });

  it("preserves latest assistant thinking blocks for amazon-bedrock replay", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeAnthropicHistory({
      messages,
      modelApi: "bedrock-converse-stream",
      provider: "amazon-bedrock",
    });

    const assistant = getAssistantMessage(result);
    expect(assistant.content).toEqual([
      {
        thinking: "internal",
        thinkingSignature: "some_sig",
        type: "thinking",
      },
      { text: "hi", type: "text" },
    ]);
  });

  it("does not drop thinking blocks for non-claude copilot models", async () => {
    setNonGoogleModelApi();

    const messages = makeThinkingAndTextAssistantMessages();

    const result = await sanitizeGithubCopilotHistory({ messages, modelId: "gpt-5.4" });
    const types = getAssistantContentTypes(result);
    expect(types).toContain("thinking");
  });
});
