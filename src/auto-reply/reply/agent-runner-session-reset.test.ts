import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resetReplyRunSession,
  setAgentRunnerSessionResetTestDeps,
} from "./agent-runner-session-reset.js";
import type { FollowupRun } from "./queue.js";

const refreshQueuedFollowupSessionMock = vi.fn();
const errorMock = vi.fn();

function createFollowupRun(): FollowupRun {
  return {
    enqueuedAt: Date.now(),
    prompt: "hello",
    run: {
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
      thinkLevel: "low",
      timeoutMs: 1000,
      verboseLevel: "off",
      workspaceDir: "/tmp",
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

describe("resetReplyRunSession", () => {
  let rootDir = "";

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-reset-run-"));
    refreshQueuedFollowupSessionMock.mockReset();
    errorMock.mockReset();
    setAgentRunnerSessionResetTestDeps({
      error: errorMock,
      generateSecureUuid: () => "00000000-0000-0000-0000-000000000123",
      refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock as never,
    });
  });

  afterEach(async () => {
    setAgentRunnerSessionResetTestDeps();
    await fs.rm(rootDir, { force: true, recursive: true });
  });

  it("rotates the session and clears stale runtime and fallback fields", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const sessionEntry: SessionEntry = {
      contextTokens: 123,
      fallbackNoticeActiveModel: "openai/gpt",
      fallbackNoticeReason: "rate limit",
      fallbackNoticeSelectedModel: "anthropic/claude",
      model: "qwen",
      modelProvider: "qwencode",
      sessionFile: path.join(rootDir, "session.jsonl"),
      sessionId: "session",
      systemPromptReport: {
        generatedAt: 1,
        injectedWorkspaceFiles: [],
        skills: { entries: [], promptChars: 0 },
        source: "run",
        systemPrompt: { chars: 1, nonProjectContextChars: 1, projectContextChars: 0 },
        tools: { entries: [], listChars: 0, schemaChars: 0 },
      },
      updatedAt: 1,
    };
    const sessionStore = { main: sessionEntry };
    const followupRun = createFollowupRun();
    await writeSessionStore(storePath, "main", sessionEntry);

    let activeSessionEntry: SessionEntry | undefined = sessionEntry;
    let isNewSession = false;
    const reset = await resetReplyRunSession({
      activeSessionEntry,
      activeSessionStore: sessionStore,
      followupRun,
      onActiveSessionEntry: (entry) => {
        activeSessionEntry = entry;
      },
      onNewSession: () => {
        isNewSession = true;
      },
      options: {
        buildLogMessage: (next) => `reset ${next}`,
        failureLabel: "compaction failure",
      },
      queueKey: "main",
      sessionKey: "main",
      storePath,
    });

    expect(reset).toBe(true);
    expect(isNewSession).toBe(true);
    expect(activeSessionEntry?.sessionId).toBe("00000000-0000-0000-0000-000000000123");
    expect(followupRun.run.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(activeSessionEntry?.modelProvider).toBeUndefined();
    expect(activeSessionEntry?.model).toBeUndefined();
    expect(activeSessionEntry?.contextTokens).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeSelectedModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeActiveModel).toBeUndefined();
    expect(activeSessionEntry?.fallbackNoticeReason).toBeUndefined();
    expect(activeSessionEntry?.systemPromptReport).toBeUndefined();
    expect(refreshQueuedFollowupSessionMock).toHaveBeenCalledWith({
      key: "main",
      nextSessionFile: activeSessionEntry?.sessionFile,
      nextSessionId: activeSessionEntry?.sessionId,
      previousSessionId: "session",
    });
    expect(errorMock).toHaveBeenCalledWith("reset 00000000-0000-0000-0000-000000000123");

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as {
      main: SessionEntry;
    };
    expect(persisted.main.sessionId).toBe(activeSessionEntry?.sessionId);
    expect(persisted.main.fallbackNoticeReason).toBeUndefined();
  });

  it("cleans up the old transcript when requested", async () => {
    const storePath = path.join(rootDir, "sessions.json");
    const oldTranscriptPath = path.join(rootDir, "old-session.jsonl");
    await fs.writeFile(oldTranscriptPath, "old", "utf8");
    const sessionEntry: SessionEntry = {
      sessionFile: oldTranscriptPath,
      sessionId: "old-session",
      updatedAt: 1,
    };
    const sessionStore = { main: sessionEntry };
    await writeSessionStore(storePath, "main", sessionEntry);

    await resetReplyRunSession({
      activeSessionEntry: sessionEntry,
      activeSessionStore: sessionStore,
      followupRun: createFollowupRun(),
      onActiveSessionEntry: () => {},
      onNewSession: () => {},
      options: {
        buildLogMessage: (next) => `reset ${next}`,
        cleanupTranscripts: true,
        failureLabel: "role ordering conflict",
      },
      queueKey: "main",
      sessionKey: "main",
      storePath,
    });

    await expect(fs.access(oldTranscriptPath)).rejects.toThrow();
  });
});
