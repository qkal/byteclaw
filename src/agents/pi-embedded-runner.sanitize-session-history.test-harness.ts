import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { expect, vi } from "vitest";
import type { TranscriptPolicy } from "./transcript-policy.js";

export interface SessionEntry { type: string; customType: string; data: unknown }
export type SanitizeSessionHistoryFn = (params: {
  messages: AgentMessage[];
  modelApi: string;
  provider: string;
  allowedToolNames?: Iterable<string>;
  sessionManager: SessionManager;
  sessionId: string;
  modelId?: string;
  policy?: TranscriptPolicy;
}) => Promise<AgentMessage[]>;
export type SanitizeSessionHistoryMockedHelpers = typeof import("./pi-embedded-helpers.js");
export interface SanitizeSessionHistoryHarness {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  mockedHelpers: SanitizeSessionHistoryMockedHelpers;
}
export const TEST_SESSION_ID = "test-session";

export function makeModelSnapshotEntry(data: {
  timestamp?: number;
  provider: string;
  modelApi: string;
  modelId: string;
}): SessionEntry {
  return {
    customType: "model-snapshot",
    data: {
      modelApi: data.modelApi,
      modelId: data.modelId,
      provider: data.provider,
      timestamp: data.timestamp ?? Date.now(),
    },
    type: "custom",
  };
}

export function makeInMemorySessionManager(entries: SessionEntry[]): SessionManager {
  return {
    appendCustomEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ customType, data, type: "custom" });
    }),
    getEntries: vi.fn(() => entries),
  } as unknown as SessionManager;
}

export function makeMockSessionManager(): SessionManager {
  return {
    appendCustomEntry: vi.fn(),
    getEntries: vi.fn().mockReturnValue([]),
  } as unknown as SessionManager;
}

export function makeSimpleUserMessages(): AgentMessage[] {
  const messages = [{ content: "hello", role: "user" }];
  return messages as unknown as AgentMessage[];
}

export async function loadSanitizeSessionHistoryWithCleanMocks(): Promise<SanitizeSessionHistoryHarness> {
  vi.resetModules();
  vi.resetAllMocks();
  const mockedHelpers = await import("./pi-embedded-helpers.js");
  vi.mocked(mockedHelpers.sanitizeSessionMessagesImages).mockImplementation(async (msgs) => msgs);
  const mod = await import("./pi-embedded-runner/replay-history.js");
  return {
    mockedHelpers,
    sanitizeSessionHistory: mod.sanitizeSessionHistory,
  };
}

export function makeReasoningAssistantMessages(opts?: {
  thinkingSignature?: "object" | "json";
}): AgentMessage[] {
  const thinkingSignature: unknown =
    opts?.thinkingSignature === "json"
      ? JSON.stringify({ id: "rs_test", type: "reasoning" })
      : { id: "rs_test", type: "reasoning" };

  // Intentional: we want to build message payloads that can carry non-string
  // Signatures, but core typing currently expects a string.
  const messages = [
    {
      content: [
        {
          thinking: "reasoning",
          thinkingSignature,
          type: "thinking",
        },
      ],
      role: "assistant",
    },
  ];

  return messages as unknown as AgentMessage[];
}

export async function sanitizeWithOpenAIResponses(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
  messages: AgentMessage[];
  sessionManager: SessionManager;
  modelId?: string;
}) {
  return await params.sanitizeSessionHistory({
    messages: params.messages,
    modelApi: "openai-responses",
    modelId: params.modelId,
    provider: "openai",
    sessionId: TEST_SESSION_ID,
    sessionManager: params.sessionManager,
  });
}

export function expectOpenAIResponsesStrictSanitizeCall(
  sanitizeSessionMessagesImagesMock: unknown,
  messages: AgentMessage[],
) {
  expect(sanitizeSessionMessagesImagesMock).toHaveBeenCalledWith(
    messages,
    "session:history",
    expect.objectContaining({
      sanitizeMode: "images-only",
      sanitizeToolCallIds: true,
      toolCallIdMode: "strict",
    }),
  );
}

export function makeSnapshotChangedOpenAIReasoningScenario() {
  const sessionEntries = [
    makeModelSnapshotEntry({
      modelApi: "anthropic-messages",
      modelId: "claude-3-7",
      provider: "anthropic",
    }),
  ];
  return {
    messages: makeReasoningAssistantMessages({ thinkingSignature: "object" }),
    modelId: "gpt-5.4",
    sessionManager: makeInMemorySessionManager(sessionEntries),
  };
}

export async function sanitizeSnapshotChangedOpenAIReasoning(params: {
  sanitizeSessionHistory: SanitizeSessionHistoryFn;
}) {
  const { sessionManager, messages, modelId } = makeSnapshotChangedOpenAIReasoningScenario();
  return await sanitizeWithOpenAIResponses({
    messages,
    modelId,
    sanitizeSessionHistory: params.sanitizeSessionHistory,
    sessionManager,
  });
}
