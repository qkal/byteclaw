import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import { runMemoryFlushIfNeeded, setAgentRunnerMemoryTestDeps } from "./agent-runner-memory.js";
import type { FollowupRun } from "./queue.js";

const runWithModelFallbackMock = vi.fn();
const runEmbeddedPiAgentMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const incrementCompactionCountMock = vi.fn();

function createReplyOperation() {
  return {
    abortSignal: new AbortController().signal,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
  } as never;
}

function createFollowupRun(overrides: Partial<FollowupRun["run"]> = {}): FollowupRun {
  return {
    enqueuedAt: Date.now(),
    prompt: "hello",
    run: {
      agentDir: "/tmp/agent",
      agentId: "main",
      bashElevated: { allowed: false, defaultLevel: "off", enabled: false },
      blockReplyBreak: "message_end",
      config: {},
      elevatedLevel: "off",
      messageProvider: "whatsapp",
      model: "claude",
      provider: "anthropic",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session",
      sessionKey: "main",
      skillsSnapshot: {},
      skipProviderRuntimeHints: true,
      thinkLevel: "low",
      timeoutMs: 1000,
      verboseLevel: "off",
      workspaceDir: "/tmp",
      ...overrides,
    },
    summaryLine: "hello",
  } as unknown as FollowupRun;
}

async function writeSessionStore(
  storePath: string,
  sessionKey: string,
  entry: SessionEntry,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf8");
}

describe("runMemoryFlushIfNeeded", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-unit-"));
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 1_000_000_000,
      prompt: "Pre-compaction memory flush.\nNO_REPLY",
      relativePath: "memory/2023-11-14.md",
      reserveTokensFloor: 20_000,
      softThresholdTokens: 4000,
      systemPrompt: "Write memory to memory/YYYY-MM-DD.md.",
    }));
    runWithModelFallbackMock.mockReset().mockImplementation(async ({ provider, model, run }) => ({
      attempts: [],
      model,
      provider,
      result: await run(provider, model),
    }));
    runEmbeddedPiAgentMock.mockReset().mockResolvedValue({ meta: {}, payloads: [] });
    refreshQueuedFollowupSessionMock.mockReset();
    incrementCompactionCountMock.mockReset().mockImplementation(async (params) => {
      const sessionKey = String(params.sessionKey ?? "");
      if (!sessionKey || !params.sessionStore?.[sessionKey]) {
        return undefined;
      }
      const previous = params.sessionStore[sessionKey] as SessionEntry;
      const nextEntry: SessionEntry = {
        ...previous,
        compactionCount: (previous.compactionCount ?? 0) + 1,
      };
      if (typeof params.newSessionId === "string" && params.newSessionId) {
        nextEntry.sessionId = params.newSessionId;
        const storePath = typeof params.storePath === "string" ? params.storePath : rootDir;
        nextEntry.sessionFile = path.join(path.dirname(storePath), `${params.newSessionId}.jsonl`);
      }
      params.sessionStore[sessionKey] = nextEntry;
      if (typeof params.storePath === "string") {
        await writeSessionStore(params.storePath, sessionKey, nextEntry);
      }
      return nextEntry.compactionCount;
    });
    setAgentRunnerMemoryTestDeps({
      incrementCompactionCount: incrementCompactionCountMock as never,
      now: () => 1_700_000_000_000,
      randomUUID: () => "00000000-0000-0000-0000-000000000001",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
      registerAgentRunContext: vi.fn() as never,
      runEmbeddedPiAgent: runEmbeddedPiAgentMock as never,
      runWithModelFallback: runWithModelFallbackMock as never,
    });
  });

  afterEach(async () => {
    setAgentRunnerMemoryTestDeps();
    clearMemoryPluginState();
    await fs.rm(rootDir, { force: true, recursive: true });
  });

  it("runs a memory flush turn, rotates after compaction, and persists metadata", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      compactionCount: 1,
      sessionId: "session",
      totalTokens: 80_000,
      updatedAt: Date.now(),
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    await writeSessionStore(storePath, sessionKey, sessionEntry);

    runEmbeddedPiAgentMock.mockImplementationOnce(
      async (params: {
        onAgentEvent?: (evt: { stream: string; data: { phase: string } }) => void;
      }) => {
        params.onAgentEvent?.({ data: { phase: "end" }, stream: "compaction" });
        return {
          meta: { agentMeta: { sessionId: "session-rotated" } },
          payloads: [],
        };
      },
    );

    const followupRun = createFollowupRun();
    const entry = await runMemoryFlushIfNeeded({
      agentCfgContextTokens: 100_000,
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {},
            },
          },
        },
      },
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      resolvedVerboseLevel: "off",
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      sessionEntry,
      sessionKey,
      sessionStore,
      storePath,
    });

    expect(entry?.sessionId).toBe("session-rotated");
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Pre-compaction memory flush.");
    expect(flushCall.memoryFlushWritePath).toMatch(/^memory\/\d{4}-\d{2}-\d{2}\.md$/);
    expect(flushCall.silentExpected).toBe(true);
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: sessionKey,
      nextSessionFile: expect.stringContaining("session-rotated.jsonl"),
      nextSessionId: "session-rotated",
      previousSessionId: "session",
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe("session-rotated");
    expect(persisted.main.compactionCount).toBe(2);
    expect(persisted.main.memoryFlushCompactionCount).toBe(2);
    expect(persisted.main.memoryFlushAt).toBe(1_700_000_000_000);
  });

  it("skips memory flush for CLI providers", async () => {
    const sessionEntry: SessionEntry = {
      compactionCount: 1,
      sessionId: "session",
      totalTokens: 80_000,
      updatedAt: Date.now(),
    };

    const entry = await runMemoryFlushIfNeeded({
      agentCfgContextTokens: 100_000,
      cfg: { agents: { defaults: { cliBackends: { "codex-cli": { command: "codex" } } } } },
      defaultModel: "codex-cli/gpt-5.4",
      followupRun: createFollowupRun({ provider: "codex-cli" }),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      resolvedVerboseLevel: "off",
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      sessionEntry,
      sessionKey: "main",
      sessionStore: { main: sessionEntry },
    });

    expect(entry).toBe(sessionEntry);
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("uses configured prompts and stored bootstrap warning signatures", async () => {
    const sessionEntry: SessionEntry = {
      compactionCount: 1,
      sessionId: "session",
      systemPromptReport: {
        bootstrapTruncation: {
          nearLimitFiles: 0,
          promptWarningSignature: "sig-b",
          totalNearLimit: false,
          truncatedFiles: 1,
          warningMode: "once",
          warningShown: true,
          warningSignaturesSeen: ["sig-a", "sig-b"],
        },
        generatedAt: Date.now(),
        injectedWorkspaceFiles: [],
        skills: { entries: [], promptChars: 0 },
        source: "run",
        systemPrompt: { chars: 1, nonProjectContextChars: 1, projectContextChars: 0 },
        tools: { entries: [], listChars: 0, schemaChars: 0 },
      },
      totalTokens: 80_000,
      updatedAt: Date.now(),
    };
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 1_000_000_000,
      prompt: "Write notes.\nNO_REPLY to memory/2023-11-14.md and MEMORY.md",
      relativePath: "memory/2023-11-14.md",
      reserveTokensFloor: 20_000,
      softThresholdTokens: 4000,
      systemPrompt: "Flush memory now. NO_REPLY memory/YYYY-MM-DD.md MEMORY.md",
    }));

    await runMemoryFlushIfNeeded({
      agentCfgContextTokens: 100_000,
      cfg: { agents: { defaults: { compaction: { memoryFlush: {} } } } },
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun: createFollowupRun({ extraSystemPrompt: "extra system" }),
      isHeartbeat: false,
      replyOperation: createReplyOperation(),
      resolvedVerboseLevel: "off",
      sessionCtx: { Provider: "whatsapp" } as unknown as TemplateContext,
      sessionEntry,
      sessionKey: "main",
      sessionStore: { main: sessionEntry },
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as {
      prompt?: string;
      extraSystemPrompt?: string;
      bootstrapPromptWarningSignaturesSeen?: string[];
      bootstrapPromptWarningSignature?: string;
      memoryFlushWritePath?: string;
      silentExpected?: boolean;
    };
    expect(flushCall.prompt).toContain("Write notes.");
    expect(flushCall.prompt).toContain("NO_REPLY");
    expect(flushCall.prompt).toContain("MEMORY.md");
    expect(flushCall.extraSystemPrompt).toContain("extra system");
    expect(flushCall.extraSystemPrompt).toContain("Flush memory now.");
    expect(flushCall.memoryFlushWritePath).toBe("memory/2023-11-14.md");
    expect(flushCall.silentExpected).toBe(true);
    expect(flushCall.bootstrapPromptWarningSignaturesSeen).toEqual(["sig-a", "sig-b"]);
    expect(flushCall.bootstrapPromptWarningSignature).toBe("sig-b");
  });
});
