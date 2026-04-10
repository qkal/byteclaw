import { buildAttemptReplayMetadata } from "./run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

export const DEFAULT_OVERFLOW_ERROR_MESSAGE =
  "request_too_large: Request size exceeds model context window";

export function makeOverflowError(message: string = DEFAULT_OVERFLOW_ERROR_MESSAGE): Error {
  return new Error(message);
}

export function makeCompactionSuccess(params: {
  summary: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
}) {
  return {
    compacted: true as const,
    ok: true as const,
    result: {
      summary: params.summary,
      ...(params.firstKeptEntryId ? { firstKeptEntryId: params.firstKeptEntryId } : {}),
      ...(params.tokensBefore !== undefined ? { tokensBefore: params.tokensBefore } : {}),
      ...(params.tokensAfter !== undefined ? { tokensAfter: params.tokensAfter } : {}),
    },
  };
}

export function makeAttemptResult(
  overrides: Partial<EmbeddedRunAttemptResult> = {},
): EmbeddedRunAttemptResult {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const { successfulCronAdds } = overrides;
  return {
    aborted: false,
    assistantTexts: ["Hello!"],
    cloudCodeAssistFormatError: false,
    didSendViaMessagingTool,
    idleTimedOut: false,
    itemLifecycle: {
      activeCount: 0,
      completedCount: 0,
      startedCount: 0,
    },
    lastAssistant: undefined,
    messagesSnapshot: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    messagingToolSentTexts: [],
    promptError: null,
    promptErrorSource: null,
    replayMetadata:
      overrides.replayMetadata ??
      buildAttemptReplayMetadata({
        didSendViaMessagingTool,
        successfulCronAdds,
        toolMetas,
      }),
    sessionIdUsed: "test-session",
    timedOut: false,
    timedOutDuringCompaction: false,
    toolMetas,
    ...overrides,
  };
}

interface MockRunEmbeddedAttempt {
  mockResolvedValueOnce: (value: EmbeddedRunAttemptResult) => unknown;
}

interface MockCompactDirect {
  mockResolvedValueOnce: (value: {
    ok: true;
    compacted: true;
    result: {
      summary: string;
      firstKeptEntryId?: string;
      tokensBefore?: number;
      tokensAfter?: number;
    };
  }) => unknown;
}

export function mockOverflowRetrySuccess(params: {
  runEmbeddedAttempt: MockRunEmbeddedAttempt;
  compactDirect: MockCompactDirect;
  overflowMessage?: string;
}) {
  const overflowError = makeOverflowError(params.overflowMessage);

  params.runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({ promptError: overflowError }),
  );
  params.runEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

  params.compactDirect.mockResolvedValueOnce(
    makeCompactionSuccess({
      firstKeptEntryId: "entry-5",
      summary: "Compacted session",
      tokensBefore: 150_000,
    }),
  );

  return overflowError;
}

export function queueOverflowAttemptWithOversizedToolOutput(
  runEmbeddedAttempt: MockRunEmbeddedAttempt,
  overflowError: Error = makeOverflowError(),
): Error {
  runEmbeddedAttempt.mockResolvedValueOnce(
    makeAttemptResult({
      messagesSnapshot: [
        {
          content: [{ type: "text", text: "x".repeat(80_000) }],
          role: "toolResult",
        } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
      ],
      promptError: overflowError,
    }),
  );
  return overflowError;
}
