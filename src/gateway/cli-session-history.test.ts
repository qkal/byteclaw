import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentChatHistoryWithCliSessionImports,
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessages,
  resolveClaudeCliSessionFilePath,
} from "./cli-session-history.js";

const ORIGINAL_HOME = process.env.HOME;

function createClaudeHistoryLines(sessionId: string) {
  return [
    JSON.stringify({
      content: "[Thu 2026-03-26 16:29 GMT] Reply with exactly: AGENT CLI OK.",
      operation: "enqueue",
      sessionId,
      timestamp: "2026-03-26T16:29:54.722Z",
      type: "queue-operation",
    }),
    JSON.stringify({
      message: {
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
        role: "user",
      },
      timestamp: "2026-03-26T16:29:54.800Z",
      type: "user",
      uuid: "user-1",
    }),
    JSON.stringify({
      message: {
        content: [{ text: "hello from Claude", type: "text" }],
        model: "claude-sonnet-4-6",
        role: "assistant",
        stop_reason: "end_turn",
        usage: {
          cache_read_input_tokens: 22,
          input_tokens: 11,
          output_tokens: 7,
        },
      },
      timestamp: "2026-03-26T16:29:55.500Z",
      type: "assistant",
      uuid: "assistant-1",
    }),
    JSON.stringify({
      message: {
        content: [
          {
            id: "toolu_123",
            input: {
              command: "pwd",
            },
            name: "Bash",
            type: "tool_use",
          },
        ],
        model: "claude-sonnet-4-6",
        role: "assistant",
        stop_reason: "tool_use",
      },
      timestamp: "2026-03-26T16:29:56.000Z",
      type: "assistant",
      uuid: "assistant-2",
    }),
    JSON.stringify({
      message: {
        content: [
          {
            content: "/tmp/demo",
            tool_use_id: "toolu_123",
            type: "tool_result",
          },
        ],
        role: "user",
      },
      timestamp: "2026-03-26T16:29:56.400Z",
      type: "user",
      uuid: "user-2",
    }),
    JSON.stringify({
      lastPrompt: "ignored",
      sessionId,
      type: "last-prompt",
    }),
  ].join("\n");
}

async function withClaudeProjectsDir<T>(
  run: (params: { homeDir: string; sessionId: string; filePath: string }) => Promise<T>,
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-history-"));
  const homeDir = path.join(root, "home");
  const sessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
  const projectsDir = path.join(homeDir, ".claude", "projects", "demo-workspace");
  const filePath = path.join(projectsDir, `${sessionId}.jsonl`);
  await fs.mkdir(projectsDir, { recursive: true });
  await fs.writeFile(filePath, createClaudeHistoryLines(sessionId), "utf8");
  process.env.HOME = homeDir;
  try {
    return await run({ filePath, homeDir, sessionId });
  } finally {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
    await fs.rm(root, { force: true, recursive: true });
  }
}

describe("cli session history", () => {
  afterEach(() => {
    if (ORIGINAL_HOME === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = ORIGINAL_HOME;
    }
  });

  it("reads claude-cli session messages from the Claude projects store", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
      expect(resolveClaudeCliSessionFilePath({ cliSessionId: sessionId, homeDir })).toBe(filePath);
      const messages = readClaudeCliSessionMessages({ cliSessionId: sessionId, homeDir });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        __openclaw: {
          cliSessionId: sessionId,
          externalId: "user-1",
          importedFrom: "claude-cli",
        },
        content: expect.stringContaining("[Thu 2026-03-26 16:29 GMT] hi"),
        role: "user",
      });
      expect(messages[1]).toMatchObject({
        __openclaw: {
          cliSessionId: sessionId,
          externalId: "assistant-1",
          importedFrom: "claude-cli",
        },
        model: "claude-sonnet-4-6",
        provider: "claude-cli",
        role: "assistant",
        stopReason: "end_turn",
        usage: {
          cacheRead: 22,
          input: 11,
          output: 7,
        },
      });
      expect(messages[2]).toMatchObject({
        content: [
          {
            arguments: {
              command: "pwd",
            },
            id: "toolu_123",
            name: "Bash",
            type: "toolcall",
          },
          {
            content: "/tmp/demo",
            name: "Bash",
            tool_use_id: "toolu_123",
            type: "tool_result",
          },
        ],
        role: "assistant",
      });
    });
  });

  it("deduplicates imported messages against similar local transcript entries", () => {
    const localMessages = [
      {
        content: "hi",
        role: "user",
        timestamp: Date.parse("2026-03-26T16:29:54.900Z"),
      },
      {
        content: [{ text: "hello from Claude", type: "text" }],
        role: "assistant",
        timestamp: Date.parse("2026-03-26T16:29:55.700Z"),
      },
    ];
    const importedMessages = [
      {
        __openclaw: {
          cliSessionId: "session-1",
          externalId: "user-1",
          importedFrom: "claude-cli",
        },
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
        role: "user",
        timestamp: Date.parse("2026-03-26T16:29:54.800Z"),
      },
      {
        __openclaw: {
          cliSessionId: "session-1",
          externalId: "assistant-1",
          importedFrom: "claude-cli",
        },
        content: [{ text: "hello from Claude", type: "text" }],
        role: "assistant",
        timestamp: Date.parse("2026-03-26T16:29:55.500Z"),
      },
      {
        __openclaw: {
          cliSessionId: "session-1",
          externalId: "user-2",
          importedFrom: "claude-cli",
        },
        content: "[Thu 2026-03-26 16:31 GMT] follow-up",
        role: "user",
        timestamp: Date.parse("2026-03-26T16:31:00.000Z"),
      },
    ];

    const merged = mergeImportedChatHistoryMessages({ importedMessages, localMessages });
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({
      __openclaw: {
        externalId: "user-2",
        importedFrom: "claude-cli",
      },
      role: "user",
    });
  });

  it("augments chat history when a session has a claude-cli binding", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          cliSessionBindings: {
            "claude-cli": {
              sessionId,
            },
          },
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
        },
        homeDir,
        localMessages: [],
        provider: "claude-cli",
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        __openclaw: { cliSessionId: sessionId },
        role: "user",
      });
    });
  });

  it("falls back to legacy cliSessionIds when bindings are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          cliSessionIds: {
            "claude-cli": sessionId,
          },
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
        },
        homeDir,
        localMessages: [],
        provider: "claude-cli",
      });
      expect(messages).toHaveLength(3);
      expect(messages[1]).toMatchObject({
        __openclaw: { cliSessionId: sessionId },
        role: "assistant",
      });
    });
  });

  it("falls back to legacy claudeCliSessionId when newer fields are absent", async () => {
    await withClaudeProjectsDir(async ({ homeDir, sessionId }) => {
      const messages = augmentChatHistoryWithCliSessionImports({
        entry: {
          claudeCliSessionId: sessionId,
          sessionId: "openclaw-session",
          updatedAt: Date.now(),
        },
        homeDir,
        localMessages: [],
        provider: "claude-cli",
      });
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        __openclaw: { cliSessionId: sessionId },
        role: "user",
      });
    });
  });
});
