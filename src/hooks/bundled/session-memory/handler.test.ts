import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { writeWorkspaceFile } from "../../../test-helpers/workspace.js";
import { createHookEvent } from "../../hooks.js";
import {
  findPreviousSessionFile,
  getRecentSessionContent,
  getRecentSessionContentWithResetFallback,
} from "./transcript.js";

// Avoid calling the embedded Pi agent (global command lane); keep this unit test deterministic.
vi.mock("../../llm-slug-generator.js", () => ({
  generateSlugViaLLM: vi.fn().mockResolvedValue("simple-math"),
}));

let handler: typeof import("./handler.js").default;
let suiteWorkspaceRoot = "";
let workspaceCaseCounter = 0;

async function createCaseWorkspace(prefix = "case"): Promise<string> {
  const dir = path.join(suiteWorkspaceRoot, `${prefix}-${workspaceCaseCounter}`);
  workspaceCaseCounter += 1;
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
  suiteWorkspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-memory-"));
});

afterAll(async () => {
  if (!suiteWorkspaceRoot) {
    return;
  }
  await fs.rm(suiteWorkspaceRoot, { force: true, recursive: true });
  suiteWorkspaceRoot = "";
  workspaceCaseCounter = 0;
});

/**
 * Create a mock session JSONL file with various entry types
 */
function createMockSessionContent(
  entries: ({ role: string; content: string } | ({ type: string } & Record<string, unknown>))[],
): string {
  return entries
    .map((entry) => {
      if ("role" in entry) {
        return JSON.stringify({
          message: {
            content: entry.content,
            role: entry.role,
          },
          type: "message",
        });
      }
      // Non-message entry (tool call, system, etc.)
      return JSON.stringify(entry);
    })
    .join("\n");
}

async function runNewWithPreviousSessionEntry(params: {
  tempDir: string;
  previousSessionEntry: { sessionId: string; sessionFile?: string };
  cfg?: OpenClawConfig;
  action?: "new" | "reset";
  sessionKey?: string;
  workspaceDirOverride?: string;
}): Promise<{ files: string[]; memoryContent: string }> {
  const event = createHookEvent(
    "command",
    params.action ?? "new",
    params.sessionKey ?? "agent:main:main",
    {
      cfg:
        params.cfg ??
        ({
          agents: { defaults: { workspace: params.tempDir } },
        } satisfies OpenClawConfig),
      previousSessionEntry: params.previousSessionEntry,
      ...(params.workspaceDirOverride ? { workspaceDir: params.workspaceDirOverride } : {}),
    },
  );

  await handler(event);

  const memoryDir = path.join(params.tempDir, "memory");
  const files = await fs.readdir(memoryDir);
  const memoryContent =
    files.length > 0 ? await fs.readFile(path.join(memoryDir, files[0]), "utf8") : "";
  return { files, memoryContent };
}

async function runNewWithPreviousSession(params: {
  sessionContent: string;
  cfg?: (tempDir: string) => OpenClawConfig;
  action?: "new" | "reset";
}): Promise<{ tempDir: string; files: string[]; memoryContent: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  const sessionFile = await writeWorkspaceFile({
    content: params.sessionContent,
    dir: sessionsDir,
    name: "test-session.jsonl",
  });

  const cfg =
    params.cfg?.(tempDir) ??
    ({
      agents: { defaults: { workspace: tempDir } },
    } satisfies OpenClawConfig);

  const { files, memoryContent } = await runNewWithPreviousSessionEntry({
    action: params.action,
    cfg,
    previousSessionEntry: {
      sessionFile,
      sessionId: "test-123",
    },
    tempDir,
  });
  return { files, memoryContent, tempDir };
}

async function createSessionMemoryWorkspace(params?: {
  activeSession?: { name: string; content: string };
}): Promise<{ tempDir: string; sessionsDir: string; activeSessionFile?: string }> {
  const tempDir = await createCaseWorkspace("workspace");
  const sessionsDir = path.join(tempDir, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });

  if (!params?.activeSession) {
    return { sessionsDir, tempDir };
  }

  const activeSessionFile = await writeWorkspaceFile({
    content: params.activeSession.content,
    dir: sessionsDir,
    name: params.activeSession.name,
  });
  return { activeSessionFile, sessionsDir, tempDir };
}

async function writeSessionTranscript(params: {
  name: string;
  content: string;
}): Promise<{ tempDir: string; sessionsDir: string; sessionFile: string }> {
  const { tempDir, sessionsDir } = await createSessionMemoryWorkspace();
  const sessionFile = await writeWorkspaceFile({
    content: params.content,
    dir: sessionsDir,
    name: params.name,
  });
  return { sessionFile, sessionsDir, tempDir };
}

async function readSessionTranscript(params: {
  sessionContent: string;
  messageCount?: number;
}): Promise<string | null> {
  const { sessionFile } = await writeSessionTranscript({
    content: params.sessionContent,
    name: "test-session.jsonl",
  });
  return getRecentSessionContent(sessionFile, params.messageCount);
}

function expectMemoryConversation(params: {
  memoryContent: string;
  user: string;
  assistant: string;
  absent?: string;
}) {
  expect(params.memoryContent).toContain(`user: ${params.user}`);
  expect(params.memoryContent).toContain(`assistant: ${params.assistant}`);
  if (params.absent) {
    expect(params.memoryContent).not.toContain(params.absent);
  }
}

describe("session-memory hook", () => {
  it("skips non-command events", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("agent", "bootstrap", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for non-command events
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("skips commands other than new", async () => {
    const tempDir = await createCaseWorkspace("workspace");

    const event = createHookEvent("command", "help", "agent:main:main", {
      workspaceDir: tempDir,
    });

    await handler(event);

    // Memory directory should not be created for other commands
    const memoryDir = path.join(tempDir, "memory");
    await expect(fs.access(memoryDir)).rejects.toThrow();
  });

  it("creates memory file with session content on /new command", async () => {
    // Create a mock session file with user/assistant messages
    const sessionContent = createMockSessionContent([
      { content: "Hello there", role: "user" },
      { content: "Hi! How can I help?", role: "assistant" },
      { content: "What is 2+2?", role: "user" },
      { content: "2+2 equals 4", role: "assistant" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({ sessionContent });
    expect(files.length).toBe(1);

    // Read the memory file and verify content
    expect(memoryContent).toContain("user: Hello there");
    expect(memoryContent).toContain("assistant: Hi! How can I help?");
    expect(memoryContent).toContain("user: What is 2+2?");
    expect(memoryContent).toContain("assistant: 2+2 equals 4");
  });

  it("creates memory file with session content on /reset command", async () => {
    const sessionContent = createMockSessionContent([
      { content: "Please reset and keep notes", role: "user" },
      { content: "Captured before reset", role: "assistant" },
    ]);
    const { files, memoryContent } = await runNewWithPreviousSession({
      action: "reset",
      sessionContent,
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain("user: Please reset and keep notes");
    expect(memoryContent).toContain("assistant: Captured before reset");
  });

  it("prefers workspaceDir from hook context when sessionKey points at main", async () => {
    const mainWorkspace = await createCaseWorkspace("workspace-main");
    const naviWorkspace = await createCaseWorkspace("workspace-navi");
    const naviSessionsDir = path.join(naviWorkspace, "sessions");
    await fs.mkdir(naviSessionsDir, { recursive: true });

    const sessionFile = await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Remember this under Navi", role: "user" },
        { content: "Stored in the bound workspace", role: "assistant" },
      ]),
      dir: naviSessionsDir,
      name: "navi-session.jsonl",
    });

    const { files, memoryContent } = await runNewWithPreviousSessionEntry({
      cfg: {
        agents: {
          defaults: { workspace: mainWorkspace },
          list: [{ id: "navi", workspace: naviWorkspace }],
        },
      } satisfies OpenClawConfig,
      previousSessionEntry: {
        sessionFile,
        sessionId: "navi-session",
      },
      sessionKey: "agent:main:main",
      tempDir: naviWorkspace,
      workspaceDirOverride: naviWorkspace,
    });

    expect(files.length).toBe(1);
    expect(memoryContent).toContain("user: Remember this under Navi");
    expect(memoryContent).toContain("assistant: Stored in the bound workspace");
    expect(memoryContent).toContain("- **Session Key**: agent:navi:main");
    await expect(fs.access(path.join(mainWorkspace, "memory"))).rejects.toThrow();
  });

  it("filters out non-message entries (tool calls, system)", async () => {
    const sessionContent = createMockSessionContent([
      { content: "Hello", role: "user" },
      { input: "test", tool: "search", type: "tool_use" },
      { content: "World", role: "assistant" },
      { result: "found it", type: "tool_result" },
      { content: "Thanks", role: "user" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).toContain("user: Hello");
    expect(memoryContent).toContain("assistant: World");
    expect(memoryContent).toContain("user: Thanks");
    expect(memoryContent).not.toContain("tool_use");
    expect(memoryContent).not.toContain("tool_result");
    expect(memoryContent).not.toContain("search");
  });

  it("filters out inter-session user messages", async () => {
    const sessionContent = [
      JSON.stringify({
        message: {
          content: "Forwarded internal instruction",
          provenance: { kind: "inter_session", sourceTool: "sessions_send" },
          role: "user",
        },
        type: "message",
      }),
      JSON.stringify({
        message: { content: "Acknowledged", role: "assistant" },
        type: "message",
      }),
      JSON.stringify({
        message: { content: "External follow-up", role: "user" },
        type: "message",
      }),
    ].join("\n");
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).not.toContain("Forwarded internal instruction");
    expect(memoryContent).toContain("assistant: Acknowledged");
    expect(memoryContent).toContain("user: External follow-up");
  });

  it("filters out command messages starting with /", async () => {
    const sessionContent = createMockSessionContent([
      { content: "/help", role: "user" },
      { content: "Here is help info", role: "assistant" },
      { content: "Normal message", role: "user" },
      { content: "/new", role: "user" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).not.toContain("/help");
    expect(memoryContent).not.toContain("/new");
    expect(memoryContent).toContain("assistant: Here is help info");
    expect(memoryContent).toContain("user: Normal message");
  });

  it("respects custom messages config (limits to N messages)", async () => {
    const entries = [];
    for (let i = 1; i <= 10; i++) {
      entries.push({ content: `Message ${i}`, role: "user" });
    }
    const sessionContent = createMockSessionContent(entries);
    const memoryContent = await readSessionTranscript({
      messageCount: 3,
      sessionContent,
    });

    expect(memoryContent).not.toContain("user: Message 1\n");
    expect(memoryContent).not.toContain("user: Message 7\n");
    expect(memoryContent).toContain("user: Message 8");
    expect(memoryContent).toContain("user: Message 9");
    expect(memoryContent).toContain("user: Message 10");
  });

  it("filters messages before slicing (fix for #2681)", async () => {
    const entries = [
      { content: "First message", role: "user" },
      { tool: "test1", type: "tool_use" },
      { result: "result1", type: "tool_result" },
      { content: "Second message", role: "assistant" },
      { tool: "test2", type: "tool_use" },
      { result: "result2", type: "tool_result" },
      { content: "Third message", role: "user" },
      { tool: "test3", type: "tool_use" },
      { result: "result3", type: "tool_result" },
      { content: "Fourth message", role: "assistant" },
    ];
    const sessionContent = createMockSessionContent(entries);
    const memoryContent = await readSessionTranscript({
      messageCount: 3,
      sessionContent,
    });

    expect(memoryContent).not.toContain("First message");
    expect(memoryContent).toContain("user: Third message");
    expect(memoryContent).toContain("assistant: Second message");
    expect(memoryContent).toContain("assistant: Fourth message");
  });

  it("falls back to latest .jsonl.reset.* transcript when active file is empty", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { content: "", name: "test-session.jsonl" },
    });

    // Simulate /new rotation where useful content is now in .reset.* file
    const resetContent = createMockSessionContent([
      { content: "Message from rotated transcript", role: "user" },
      { content: "Recovered from reset fallback", role: "assistant" },
    ]);
    await writeWorkspaceFile({
      content: resetContent,
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
    });

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);

    expect(memoryContent).toContain("user: Message from rotated transcript");
    expect(memoryContent).toContain("assistant: Recovered from reset fallback");
  });

  it("handles reset-path session pointers from previousSessionEntry", async () => {
    const { sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "reset-pointer-session";
    const resetSessionFile = await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Message from reset pointer", role: "user" },
        { content: "Recovered directly from reset file", role: "assistant" },
      ]),
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
    });

    const previousSessionFile = await findPreviousSessionFile({
      currentSessionFile: resetSessionFile,
      sessionId,
      sessionsDir,
    });
    expect(previousSessionFile).toBeUndefined();

    const memoryContent = await getRecentSessionContentWithResetFallback(resetSessionFile);
    expect(memoryContent).toContain("user: Message from reset pointer");
    expect(memoryContent).toContain("assistant: Recovered directly from reset file");
  });

  it("recovers transcript when previousSessionEntry.sessionFile is missing", async () => {
    const { sessionsDir } = await createSessionMemoryWorkspace();

    const sessionId = "missing-session-file";
    await writeWorkspaceFile({
      content: "",
      dir: sessionsDir,
      name: `${sessionId}.jsonl`,
    });
    await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Recovered with missing sessionFile pointer", role: "user" },
        { content: "Recovered by sessionId fallback", role: "assistant" },
      ]),
      dir: sessionsDir,
      name: `${sessionId}.jsonl.reset.2026-02-16T22-26-33.000Z`,
    });

    const previousSessionFile = await findPreviousSessionFile({
      sessionId,
      sessionsDir,
    });
    expect(previousSessionFile).toBe(path.join(sessionsDir, `${sessionId}.jsonl`));

    const memoryContent = await getRecentSessionContentWithResetFallback(previousSessionFile!);
    expect(memoryContent).toContain("user: Recovered with missing sessionFile pointer");
    expect(memoryContent).toContain("assistant: Recovered by sessionId fallback");
  });

  it("prefers the newest reset transcript when multiple reset candidates exist", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: { content: "", name: "test-session.jsonl" },
    });

    await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Older rotated transcript", role: "user" },
        { content: "Old summary", role: "assistant" },
      ]),
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-33.000Z",
    });
    await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Newest rotated transcript", role: "user" },
        { content: "Newest summary", role: "assistant" },
      ]),
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
    });

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);
    expect(memoryContent).toBeTruthy();

    expectMemoryConversation({
      absent: "Older rotated transcript",
      assistant: "Newest summary",
      memoryContent: memoryContent!,
      user: "Newest rotated transcript",
    });
  });

  it("prefers active transcript when it is non-empty even with reset candidates", async () => {
    const { sessionsDir, activeSessionFile } = await createSessionMemoryWorkspace({
      activeSession: {
        content: createMockSessionContent([
          { content: "Active transcript message", role: "user" },
          { content: "Active transcript summary", role: "assistant" },
        ]),
        name: "test-session.jsonl",
      },
    });

    await writeWorkspaceFile({
      content: createMockSessionContent([
        { content: "Reset fallback message", role: "user" },
        { content: "Reset fallback summary", role: "assistant" },
      ]),
      dir: sessionsDir,
      name: "test-session.jsonl.reset.2026-02-16T22-26-34.000Z",
    });

    const memoryContent = await getRecentSessionContentWithResetFallback(activeSessionFile!);
    expect(memoryContent).toBeTruthy();

    expectMemoryConversation({
      absent: "Reset fallback message",
      assistant: "Active transcript summary",
      memoryContent: memoryContent!,
      user: "Active transcript message",
    });
  });

  it("handles empty session files gracefully", async () => {
    // Should not throw
    const { files } = await runNewWithPreviousSession({ sessionContent: "" });
    expect(files.length).toBe(1);
  });

  it("handles session files with fewer messages than requested", async () => {
    const sessionContent = createMockSessionContent([
      { content: "Only message 1", role: "user" },
      { content: "Only message 2", role: "assistant" },
    ]);
    const memoryContent = await readSessionTranscript({ sessionContent });

    expect(memoryContent).toContain("user: Only message 1");
    expect(memoryContent).toContain("assistant: Only message 2");
  });
});
