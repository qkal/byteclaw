import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";

const streamSimpleMock = vi.fn();
const buildSessionContextMock = vi.fn();
const getLeafEntryMock = vi.fn();
const branchMock = vi.fn();
const resetLeafMock = vi.fn();
const ensureOpenClawModelsJsonMock = vi.fn();
const discoverAuthStorageMock = vi.fn();
const discoverModelsMock = vi.fn();
const resolveModelWithRegistryMock = vi.fn();
const getApiKeyForModelMock = vi.fn();
const requireApiKeyMock = vi.fn();
const resolveSessionAuthProfileOverrideMock = vi.fn();
const getActiveEmbeddedRunSnapshotMock = vi.fn();
const resolveSessionAgentIdMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const prepareProviderRuntimeAuthMock = vi.fn();
const diagDebugMock = vi.fn();

vi.mock("@mariozechner/pi-ai", async () => {
  const original =
    await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...original,
    streamSimple: (...args: unknown[]) => streamSimpleMock(...args),
  };
});

vi.mock("@mariozechner/pi-coding-agent", () => ({
  SessionManager: {
    open: () => ({
      branch: branchMock,
      buildSessionContext: buildSessionContextMock,
      getLeafEntry: getLeafEntryMock,
      resetLeaf: resetLeafMock,
    }),
  },
}));

vi.mock("./models-config.js", () => ({
  ensureOpenClawModelsJson: (...args: unknown[]) => ensureOpenClawModelsJsonMock(...args),
}));

vi.mock("./pi-model-discovery.js", () => ({
  discoverAuthStorage: (...args: unknown[]) => discoverAuthStorageMock(...args),
  discoverModels: (...args: unknown[]) => discoverModelsMock(...args),
}));

vi.mock("./pi-embedded-runner/model.js", () => ({
  resolveModelWithRegistry: (...args: unknown[]) => resolveModelWithRegistryMock(...args),
}));

vi.mock("./model-auth.js", () => ({
  getApiKeyForModel: (...args: unknown[]) => getApiKeyForModelMock(...args),
  requireApiKey: (...args: unknown[]) => requireApiKeyMock(...args),
}));

vi.mock("./pi-embedded-runner/runs.js", () => ({
  getActiveEmbeddedRunSnapshot: (...args: unknown[]) => getActiveEmbeddedRunSnapshotMock(...args),
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentWorkspaceDir: (...args: unknown[]) => resolveAgentWorkspaceDirMock(...args),
  resolveSessionAgentId: (...args: unknown[]) => resolveSessionAgentIdMock(...args),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  prepareProviderRuntimeAuth: (...args: unknown[]) => prepareProviderRuntimeAuthMock(...args),
}));

vi.mock("./auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: (...args: unknown[]) =>
    resolveSessionAuthProfileOverrideMock(...args),
}));

vi.mock("../logging/diagnostic.js", () => ({
  diagnosticLogger: {
    debug: (...args: unknown[]) => diagDebugMock(...args),
  },
}));

const { runBtwSideQuestion } = await import("./btw.js");
type RunBtwSideQuestionParams = Parameters<typeof runBtwSideQuestion>[0];

const DEFAULT_AGENT_DIR = "/tmp/agent";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_REASONING_LEVEL = "off";
const DEFAULT_SESSION_KEY = "agent:main:main";
const DEFAULT_STORE_PATH = "/tmp/sessions.json";
const DEFAULT_QUESTION = "What changed?";
const MATH_QUESTION = "What is 17 * 19?";
const MATH_ANSWER = "323";

function makeAsyncEvents(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function createSessionEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionFile: "session-1.jsonl",
    sessionId: "session-1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createDoneEvent(text: string) {
  return {
    message: {
      api: "anthropic-messages",
      content: [{ text, type: "text" }],
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 1,
        output: 2,
        totalTokens: 3,
      },
    },
    reason: "stop",
    type: "done",
  };
}

function createThinkingOnlyDoneEvent(thinking: string) {
  return {
    message: {
      api: "anthropic-messages",
      content: [{ thinking, type: "thinking" }],
      model: DEFAULT_MODEL,
      provider: DEFAULT_PROVIDER,
      role: "assistant",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: {
        cacheRead: 0,
        cacheWrite: 0,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
        input: 1,
        output: 2,
        totalTokens: 3,
      },
    },
    reason: "stop",
    type: "done",
  };
}

function mockDoneAnswer(text: string) {
  streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent(text)]));
}

function runSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runBtwSideQuestion({
    agentDir: DEFAULT_AGENT_DIR,
    cfg: {} as never,
    isNewSession: false,
    model: DEFAULT_MODEL,
    opts: {},
    provider: DEFAULT_PROVIDER,
    question: DEFAULT_QUESTION,
    resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
    sessionEntry: createSessionEntry(),
    ...overrides,
  });
}

function runMathSideQuestion(overrides: Partial<RunBtwSideQuestionParams> = {}) {
  return runSideQuestion({
    question: MATH_QUESTION,
    ...overrides,
  });
}

function clearBuiltSessionMessages() {
  buildSessionContextMock.mockReturnValue({ messages: [] });
}

describe("runBtwSideQuestion", () => {
  beforeEach(() => {
    streamSimpleMock.mockReset();
    buildSessionContextMock.mockReset();
    getLeafEntryMock.mockReset();
    branchMock.mockReset();
    resetLeafMock.mockReset();
    ensureOpenClawModelsJsonMock.mockReset();
    discoverAuthStorageMock.mockReset();
    discoverModelsMock.mockReset();
    resolveModelWithRegistryMock.mockReset();
    getApiKeyForModelMock.mockReset();
    requireApiKeyMock.mockReset();
    resolveSessionAuthProfileOverrideMock.mockReset();
    getActiveEmbeddedRunSnapshotMock.mockReset();
    resolveSessionAgentIdMock.mockReset();
    resolveAgentWorkspaceDirMock.mockReset();
    prepareProviderRuntimeAuthMock.mockReset();
    diagDebugMock.mockReset();

    buildSessionContextMock.mockReturnValue({
      messages: [{ content: [{ text: "hi", type: "text" }], role: "user", timestamp: 1 }],
    });
    getLeafEntryMock.mockReturnValue(null);
    resolveModelWithRegistryMock.mockReturnValue({
      api: "anthropic-messages",
      id: "claude-sonnet-4-6",
      provider: "anthropic",
    });
    getApiKeyForModelMock.mockResolvedValue({ apiKey: "secret", mode: "api-key", source: "test" });
    requireApiKeyMock.mockReturnValue("secret");
    resolveSessionAuthProfileOverrideMock.mockResolvedValue("profile-1");
    getActiveEmbeddedRunSnapshotMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    prepareProviderRuntimeAuthMock.mockResolvedValue(undefined);
  });

  it("streams blocks without persisting BTW data to disk", async () => {
    const onBlockReply = vi.fn().mockResolvedValue(undefined);
    streamSimpleMock.mockReturnValue(
      makeAsyncEvents([
        {
          delta: "Side answer.",
          partial: {
            content: [],
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
          },
          type: "text_delta",
        },
        {
          content: "Side answer.",
          contentIndex: 0,
          partial: {
            content: [],
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
          },
          type: "text_end",
        },
        {
          message: {
            api: "anthropic-messages",
            content: [{ text: "Side answer.", type: "text" }],
            model: "claude-sonnet-4-6",
            provider: "anthropic",
            role: "assistant",
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              cacheRead: 0,
              cacheWrite: 0,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
              input: 1,
              output: 2,
              totalTokens: 3,
            },
          },
          reason: "stop",
          type: "done",
        },
      ]),
    );

    const result = await runBtwSideQuestion({
      agentDir: DEFAULT_AGENT_DIR,
      blockReplyChunking: {
        breakPreference: "paragraph",
        maxChars: 200,
        minChars: 1,
      },
      cfg: {} as never,
      isNewSession: false,
      model: DEFAULT_MODEL,
      opts: { onBlockReply },
      provider: DEFAULT_PROVIDER,
      question: DEFAULT_QUESTION,
      resolvedBlockStreamingBreak: "text_end",
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      resolvedThinkLevel: "low",
      sessionEntry: createSessionEntry(),
      sessionKey: DEFAULT_SESSION_KEY,
      sessionStore: {},
      storePath: DEFAULT_STORE_PATH,
    });

    expect(result).toBeUndefined();
    expect(onBlockReply).toHaveBeenCalledWith({
      btw: { question: DEFAULT_QUESTION },
      text: "Side answer.",
    });
  });

  it("returns a final payload when block streaming is unavailable", async () => {
    mockDoneAnswer("Final answer.");

    const result = await runSideQuestion();

    expect(result).toEqual({ text: "Final answer." });
  });

  it("applies provider runtime auth before streaming github-copilot BTW questions", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      api: "openai-responses",
      baseUrl: "https://api.individual.githubcopilot.com",
      id: "gpt-5.4",
      provider: "github-copilot",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: "github-token",
      mode: "token",
      profileId: "github-copilot:github",
      source: "profile",
    });
    requireApiKeyMock.mockReturnValue("github-token");
    prepareProviderRuntimeAuthMock.mockResolvedValue({
      apiKey: "copilot-runtime-token",
      baseUrl: "https://api.enterprise.githubcopilot.com",
    });
    mockDoneAnswer("Copilot answer.");

    const result = await runSideQuestion({
      model: "gpt-5.4",
      provider: "github-copilot",
    });

    expect(result).toEqual({ text: "Copilot answer." });
    expect(prepareProviderRuntimeAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          apiKey: "github-token",
          authMode: "token",
          modelId: "gpt-5.4",
          profileId: "profile-1",
          provider: "github-copilot",
          workspaceDir: "/tmp/workspace",
        }),
        provider: "github-copilot",
        workspaceDir: "/tmp/workspace",
      }),
    );
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://api.enterprise.githubcopilot.com",
        id: "gpt-5.4",
        provider: "github-copilot",
      }),
      expect.anything(),
      expect.objectContaining({ apiKey: "copilot-runtime-token" }),
    );
  });

  it("strips injected empty tools arrays from BTW payloads before sending", async () => {
    mockDoneAnswer("Final answer.");

    await runSideQuestion();

    const [, , options] = streamSimpleMock.mock.calls[0] ?? [];
    const onPayload = (options as { onPayload?: (payload: unknown) => void })?.onPayload;
    const payloadWithEmptyTools = { messages: [], tools: [] as unknown[] };

    const result = onPayload?.(payloadWithEmptyTools);

    expect(payloadWithEmptyTools).not.toHaveProperty("tools");
    expect(result).toBeUndefined();
  });

  it("allows Bedrock /btw runs to proceed without a static api key in aws-sdk mode", async () => {
    resolveModelWithRegistryMock.mockReturnValue({
      api: "anthropic-messages",
      id: "us.anthropic.claude-sonnet-4-5-v1:0",
      provider: "amazon-bedrock",
    });
    getApiKeyForModelMock.mockResolvedValue({
      apiKey: undefined,
      mode: "aws-sdk",
      source: "aws-sdk default chain",
    });
    streamSimpleMock.mockReturnValue(makeAsyncEvents([createDoneEvent("Bedrock answer.")]));

    const result = await runBtwSideQuestion({
      agentDir: DEFAULT_AGENT_DIR,
      cfg: {} as never,
      isNewSession: false,
      model: "us.anthropic.claude-sonnet-4-5-v1:0",
      opts: {},
      provider: "amazon-bedrock",
      question: DEFAULT_QUESTION,
      resolvedReasoningLevel: DEFAULT_REASONING_LEVEL,
      sessionEntry: createSessionEntry(),
    });

    expect(result).toEqual({ text: "Bedrock answer." });
    expect(requireApiKeyMock).not.toHaveBeenCalled();
    const [, , options] = streamSimpleMock.mock.calls.at(-1) ?? [];
    expect((options as { apiKey?: string } | undefined)?.apiKey).toBeUndefined();
  });

  it("forces provider reasoning off even when the session think level is adaptive", async () => {
    streamSimpleMock.mockImplementation((_model, _input, options?: { reasoning?: unknown }) => options?.reasoning === undefined
        ? makeAsyncEvents([createDoneEvent("Final answer.")])
        : makeAsyncEvents([createThinkingOnlyDoneEvent("thinking only")]));

    const result = await runSideQuestion({ resolvedThinkLevel: "adaptive" });

    expect(result).toEqual({ text: "Final answer." });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ reasoning: undefined }),
    );
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.not.objectContaining({ reasoning: expect.anything() }),
    );
  });

  it("fails when the current branch has no messages", async () => {
    clearBuiltSessionMessages();
    streamSimpleMock.mockReturnValue(makeAsyncEvents([]));

    await expect(runSideQuestion()).rejects.toThrow("No active session context.");
  });

  it("uses active-run snapshot messages for BTW context while the main run is in flight", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [
            { type: "text", text: "write some things then wait 30 seconds and write more" },
          ],
          role: "user",
          timestamp: 1,
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({
            content: [
              {
                type: "text",
                text: expect.stringContaining(
                  `<btw_side_question>\n${MATH_QUESTION}\n</btw_side_question>`,
                ),
              },
            ],
            role: "user",
          }),
        ]),
        systemPrompt: expect.stringContaining("ephemeral /btw side question"),
      }),
      expect.anything(),
    );
  });

  it("uses the in-flight prompt as background only when there is no prior transcript context", async () => {
    clearBuiltSessionMessages();
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      inFlightPrompt: "build me a tic-tac-toe game in brainfuck",
      messages: [],
      transcriptLeafId: null,
    });
    mockDoneAnswer("You're building a tic-tac-toe game in Brainfuck.");

    const result = await runSideQuestion({ question: "what are we doing?" });

    expect(result).toEqual({ text: "You're building a tic-tac-toe game in Brainfuck." });
    expect(streamSimpleMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: [
              {
                text: expect.stringContaining(
                  "<in_flight_main_task>\nbuild me a tic-tac-toe game in brainfuck\n</in_flight_main_task>",
                ),
                type: "text",
              },
            ],
            role: "user",
          }),
        ],
      }),
      expect.anything(),
    );
  });

  it("wraps the side question so the model does not treat it as a main-task continuation", async () => {
    mockDoneAnswer("About 93 million miles.");

    await runSideQuestion({ question: "what is the distance to the sun?" });

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      systemPrompt: expect.stringContaining(
        "Do not continue, resume, or complete any unfinished task",
      ),
    });
    expect(context).toMatchObject({
      messages: expect.arrayContaining([
        expect.objectContaining({
          content: [
            {
              text: expect.stringContaining(
                "Ignore any unfinished task in the conversation while answering it.",
              ),
              type: "text",
            },
          ],
          role: "user",
        }),
      ]),
    });
  });

  it("branches away from an unresolved trailing user turn before building BTW context", async () => {
    getLeafEntryMock.mockReturnValue({
      message: { role: "user" },
      parentId: "assistant-1",
      type: "message",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-1");
    expect(resetLeafMock).not.toHaveBeenCalled();
    expect(buildSessionContextMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("branches to the active run snapshot leaf when the session is busy", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-seed",
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-seed");
    expect(getLeafEntryMock).not.toHaveBeenCalled();
    expect(result).toEqual({ text: MATH_ANSWER });
  });

  it("falls back when the active run snapshot leaf no longer exists", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      transcriptLeafId: "assistant-gone",
    });
    branchMock.mockImplementationOnce(() => {
      throw new Error("Entry 3235c7c4 not found");
    });
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(branchMock).toHaveBeenCalledWith("assistant-gone");
    expect(resetLeafMock).toHaveBeenCalled();
    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).toHaveBeenCalledWith(
      expect.stringContaining("btw snapshot leaf unavailable: sessionId=session-1"),
    );
  });

  it("returns the BTW answer without appending transcript custom entries", async () => {
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(buildSessionContextMock).toHaveBeenCalled();
  });

  it("does not log transcript persistence warnings because BTW no longer writes to disk", async () => {
    mockDoneAnswer(MATH_ANSWER);

    const result = await runMathSideQuestion();

    expect(result).toEqual({ text: MATH_ANSWER });
    expect(diagDebugMock).not.toHaveBeenCalledWith(
      expect.stringContaining("btw transcript persistence skipped"),
    );
  });

  it("excludes tool results from BTW context to avoid replaying raw tool output", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          content: [{ type: "text", text: "sensitive tool output" }],
          details: { raw: "secret" },
          role: "toolResult",
          timestamp: 2,
        },
        {
          content: [{ type: "text", text: "done" }],
          role: "assistant",
          timestamp: 3,
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
        expect.objectContaining({ role: "user" }),
      ],
    });
    expect((context as { messages?: { role?: string }[] }).messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "toolResult" })]),
    );
  });

  it("strips assistant tool calls from BTW context so no-tool side questions stay tool-free", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          api: "anthropic-messages",
          content: [
            { type: "text", text: "Let me check." },
            { type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
            { type: "toolUse", id: "call_legacy", name: "read", input: { path: "README.md" } },
            { type: "tool_call", id: "call_snake", name: "read", arguments: { path: "README.md" } },
          ],
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 1,
            output: 2,
            totalTokens: 3,
          },
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          content: [{ text: "Let me check.", type: "text" }],
          role: "assistant",
        }),
        expect.objectContaining({ role: "user" }),
      ],
    });
    expect(
      (context as { messages?: { role?: string; content?: { type?: string }[] }[] })
        .messages,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "toolCall" }),
            expect.objectContaining({ type: "toolUse" }),
            expect.objectContaining({ type: "tool_call" }),
          ]),
          role: "assistant",
        }),
      ]),
    );
  });

  it("drops assistant messages that contain only tool calls", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          api: "anthropic-messages",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 1,
            output: 0,
            totalTokens: 1,
          },
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(
      (context as { messages?: { role?: string }[] }).messages?.filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(0);
  });

  it("strips embedded user tool results from BTW context", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [
            { type: "text", text: "seed" },
            {
              type: "toolResult",
              toolUseId: "call_1",
              content: [{ type: "text", text: "secret" }],
            },
            {
              type: "tool_result",
              toolUseId: "call_2",
              content: [{ type: "text", text: "secret-2" }],
            },
          ],
          role: "user",
          timestamp: 1,
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({
          content: [{ text: "seed", type: "text" }],
          role: "user",
        }),
        expect.objectContaining({ role: "user" }),
      ],
    });
  });

  it("drops assistant thinking blocks from BTW context", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          api: "anthropic-messages",
          content: [
            { type: "text", text: "Visible answer" },
            { type: "thinking", thinking: "Hidden chain of thought" },
          ],
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          role: "assistant",
          stopReason: "stop",
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 1,
            output: 1,
            totalTokens: 2,
          },
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({
          content: [{ text: "Visible answer", type: "text" }],
          role: "assistant",
        }),
        expect.objectContaining({ role: "user" }),
      ],
    });
    expect(
      (context as { messages?: { role?: string; content?: { type?: string }[] }[] })
        .messages,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([expect.objectContaining({ type: "thinking" })]),
          role: "assistant",
        }),
      ]),
    );
  });

  it("drops thinking-only assistant messages from BTW context", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          api: "anthropic-messages",
          content: [{ type: "thinking", thinking: "Hidden chain of thought" }],
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          role: "assistant",
          stopReason: "stop",
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 1,
            output: 1,
            totalTokens: 2,
          },
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(
      (context as { messages?: { role?: string }[] }).messages?.filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(0);
  });

  it("drops malformed user image blocks from BTW context", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [
            { type: "text", text: "seed" },
            { type: "image", mimeType: "image/png" },
          ],
          role: "user",
          timestamp: 1,
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(context).toMatchObject({
      messages: [
        expect.objectContaining({
          content: [{ text: "seed", type: "text" }],
          role: "user",
        }),
        expect.objectContaining({ role: "user" }),
      ],
    });
  });

  it("normalizes malformed assistant content before stripping tool blocks", async () => {
    getActiveEmbeddedRunSnapshotMock.mockReturnValue({
      messages: [
        {
          content: [{ type: "text", text: "seed" }],
          role: "user",
          timestamp: 1,
        },
        {
          api: "anthropic-messages",
          content: { arguments: {}, id: "call_1", name: "read", type: "toolCall" },
          model: DEFAULT_MODEL,
          provider: DEFAULT_PROVIDER,
          role: "assistant",
          stopReason: "toolUse",
          timestamp: 2,
          usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 1,
            output: 0,
            totalTokens: 1,
          },
        },
      ],
      transcriptLeafId: "assistant-1",
    });
    mockDoneAnswer(MATH_ANSWER);

    await runMathSideQuestion();

    const [, context] = streamSimpleMock.mock.calls[0] ?? [];
    expect(
      (context as { messages?: { role?: string }[] }).messages?.filter(
        (message) => message.role === "assistant",
      ),
    ).toHaveLength(0);
  });
});
