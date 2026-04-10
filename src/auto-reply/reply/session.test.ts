import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as bootstrapCache from "../../agents/bootstrap-cache.js";
import {
  getOrCreateSessionMcpRuntime,
  __testing as sessionMcpTesting,
} from "../../agents/pi-bundle-mcp-tools.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { formatZonedTimestamp } from "../../infra/format-time/format-datetime.ts";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  __testing as sessionBindingTesting,
} from "../../infra/outbound/session-binding-service.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { drainFormattedSystemEvents } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
import { initSessionState } from "./session.js";

// Perf: session-store locks are exercised elsewhere; most session tests don't need FS lock files.
vi.mock("../../agents/session-write-lock.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/session-write-lock.js")>(
    "../../agents/session-write-lock.js",
  );
  return {
    ...actual,
    acquireSessionWriteLock: vi.fn(async () => ({ release: async () => {} })),
    resolveSessionLockMaxHoldFromTimeout: vi.fn(
      ({
        timeoutMs,
        graceMs = 2 * 60 * 1000,
        minMs = 5 * 60 * 1000,
      }: {
        timeoutMs: number;
        graceMs?: number;
        minMs?: number;
      }) => Math.max(minMs, timeoutMs + graceMs),
    ),
  };
});

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { id: "m2.7", name: "M2.7", provider: "minimax" },
    { id: "gpt-4o-mini", name: "GPT-4o mini", provider: "openai" },
  ]),
}));

let suiteRoot = "";
let suiteCase = 0;

beforeAll(async () => {
  suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-suite-"));
});

afterAll(async () => {
  await fs.rm(suiteRoot, { force: true, recursive: true });
  suiteRoot = "";
  suiteCase = 0;
});

async function makeCaseDir(prefix: string): Promise<string> {
  const dir = path.join(suiteRoot, `${prefix}${++suiteCase}`);
  await fs.mkdir(dir);
  return dir;
}

async function makeStorePath(prefix: string): Promise<string> {
  const root = await makeCaseDir(prefix);
  return path.join(root, "sessions.json");
}

const createStorePath = makeStorePath;
const TEST_NATIVE_MODEL_PROFILE_ID = "openai-codex:secondary@example.test";

async function writeSessionStoreFast(
  storePath: string,
  store: Record<string, SessionEntry | Record<string, unknown>>,
): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
}

function setMinimalCurrentConversationBindingRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "slack", label: "Slack" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim())
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "slack",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^signal:/i, ""))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "signal",
        source: "test",
      },
      {
        plugin: {
          ...createChannelTestPluginBase({ id: "googlechat", label: "Google Chat" }),
          bindings: {
            resolveCommandConversation: ({
              originatingTo,
              commandTo,
              fallbackTo,
            }: {
              originatingTo?: string;
              commandTo?: string;
              fallbackTo?: string;
            }) => {
              const conversationId = [originatingTo, commandTo, fallbackTo]
                .map((candidate) => candidate?.trim().replace(/^googlechat:/i, ""))
                .map((candidate) => candidate?.replace(/^spaces:/i, "spaces/"))
                .find((candidate) => candidate && candidate.length > 0);
              return conversationId ? { conversationId } : null;
            },
          },
        },
        pluginId: "googlechat",
        source: "test",
      },
    ]),
  );
}

function registerCurrentConversationBindingAdapterForTest(params: {
  channel: "slack" | "signal" | "googlechat";
  accountId: string;
}): void {
  const bindings: {
    bindingId: string;
    targetSessionKey: string;
    targetKind: "session" | "subagent";
    conversation: {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };
    status: "active";
    boundAt: number;
    metadata?: Record<string, unknown>;
  }[] = [];
  registerSessionBindingAdapter({
    accountId: params.accountId,
    bind: async (input) => {
      const record = {
        bindingId: `${input.conversation.channel}:${input.conversation.accountId}:${input.conversation.conversationId}`,
        boundAt: Date.now(),
        conversation: input.conversation,
        status: "active" as const,
        targetKind: input.targetKind,
        targetSessionKey: input.targetSessionKey,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      bindings.push(record);
      return record;
    },
    capabilities: { placements: ["current"] },
    channel: params.channel,
    listBySession: (targetSessionKey) =>
      bindings.filter((binding) => binding.targetSessionKey === targetSessionKey),
    resolveByConversation: (ref) =>
      bindings.find(
        (binding) =>
          binding.conversation.channel === ref.channel &&
          binding.conversation.accountId === ref.accountId &&
          binding.conversation.conversationId === ref.conversationId,
      ) ?? null,
  });
}

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
});
afterEach(async () => {
  await sessionMcpTesting.resetSessionMcpRuntimeManager();
});
describe("initSessionState thread forking", () => {
  it("forks a new session from the parent session file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      cwd: process.cwd(),
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    };
    const message = {
      id: "m1",
      message: { content: "Parent prompt", role: "user" },
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
    };
    const assistantMessage = {
      id: "m2",
      message: { content: "Parent reply", role: "assistant" },
      parentId: "m1",
      timestamp: new Date().toISOString(),
      type: "message",
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionFile: parentSessionFile,
        sessionId: parentSessionId,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Thread reply",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
        ThreadLabel: threadLabel,
      },
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).toBeTruthy();
    expect(result.sessionEntry.displayName).toBe(threadLabel);

    const newSessionFile = result.sessionEntry.sessionFile;
    if (!newSessionFile) {
      throw new Error("Missing session file for forked thread");
    }
    const [headerLine] = (await fs.readFile(newSessionFile, "utf8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const parsedHeader = JSON.parse(headerLine) as {
      parentSession?: string;
    };
    const expectedParentSession = await fs.realpath(parentSessionFile);
    const actualParentSession = parsedHeader.parentSession
      ? await fs.realpath(parsedHeader.parentSession)
      : undefined;
    expect(actualParentSession).toBe(expectedParentSession);
    warn.mockRestore();
  });

  it("forks from parent when thread session key already exists but was not forked yet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await makeCaseDir("openclaw-thread-session-existing-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      cwd: process.cwd(),
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    };
    const message = {
      id: "m1",
      message: { content: "Parent prompt", role: "user" },
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
    };
    const assistantMessage = {
      id: "m2",
      message: { content: "Parent reply", role: "assistant" },
      parentId: "m1",
      timestamp: new Date().toISOString(),
      type: "message",
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:123";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionFile: parentSessionFile,
        sessionId: parentSessionId,
        updatedAt: Date.now(),
      },
      [threadSessionKey]: {
        sessionId: "preseed-thread-session",
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const first = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Thread reply",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      },
    });

    expect(first.sessionEntry.sessionId).not.toBe("preseed-thread-session");
    expect(first.sessionEntry.forkedFromParent).toBe(true);

    const second = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Thread reply 2",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      },
    });

    expect(second.sessionEntry.sessionId).toBe(first.sessionEntry.sessionId);
    expect(second.sessionEntry.forkedFromParent).toBe(true);
    warn.mockRestore();
  });

  it("skips fork and creates fresh session when parent tokens exceed threshold", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-overflow";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      cwd: process.cwd(),
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    };
    const message = {
      id: "m1",
      message: { content: "Parent prompt", role: "user" },
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
    };
    const assistantMessage = {
      id: "m2",
      message: { content: "Parent reply", role: "assistant" },
      parentId: "m1",
      timestamp: new Date().toISOString(),
      type: "message",
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    // Set totalTokens well above PARENT_FORK_MAX_TOKENS (100_000)
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionFile: parentSessionFile,
        sessionId: parentSessionId,
        totalTokens: 170_000,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:456";
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Thread reply",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      },
    });

    // Should be marked as forked (to prevent re-attempts) but NOT actually forked from parent
    expect(result.sessionEntry.forkedFromParent).toBe(true);
    // Session ID should NOT match the parent — it should be a fresh UUID
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    // Session file should NOT be the parent's file (it was not forked)
    expect(result.sessionEntry.sessionFile).not.toBe(parentSessionFile);
  });

  it("respects session.parentForkMaxTokens override", async () => {
    const root = await makeCaseDir("openclaw-thread-session-overflow-override-");
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir);

    const parentSessionId = "parent-override";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      cwd: process.cwd(),
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      type: "session",
      version: 3,
    };
    const message = {
      id: "m1",
      message: { content: "Parent prompt", role: "user" },
      parentId: null,
      timestamp: new Date().toISOString(),
      type: "message",
    };
    const assistantMessage = {
      id: "m2",
      message: { content: "Parent reply", role: "assistant" },
      parentId: "m1",
      timestamp: new Date().toISOString(),
      type: "message",
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n${JSON.stringify(assistantMessage)}\n`,
      "utf8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:c1";
    await writeSessionStoreFast(storePath, {
      [parentSessionKey]: {
        sessionFile: parentSessionFile,
        sessionId: parentSessionId,
        totalTokens: 170_000,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: {
        parentForkMaxTokens: 200_000,
        store: storePath,
      },
    } as OpenClawConfig;

    const threadSessionKey = "agent:main:slack:channel:c1:thread:789";
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Thread reply",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      },
    });

    expect(result.sessionEntry.forkedFromParent).toBe(true);
    expect(result.sessionEntry.sessionFile).toBeTruthy();
    const forkedContent = await fs.readFile(result.sessionEntry.sessionFile ?? "", "utf8");
    const [headerLine] = forkedContent.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const parsedHeader = JSON.parse(headerLine) as { parentSession?: string };
    const expectedParentSession = await fs.realpath(parentSessionFile);
    const actualParentSession = parsedHeader.parentSession
      ? await fs.realpath(parsedHeader.parentSession)
      : undefined;
    expect(actualParentSession).toBe(expectedParentSession);
  });

  it("records topic-specific session files when MessageThreadId is present", async () => {
    const root = await makeCaseDir("openclaw-topic-session-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Hello topic",
        MessageThreadId: 456,
        SessionKey: "agent:main:telegram:group:123:topic:456",
      },
    });

    const {sessionFile} = result.sessionEntry;
    expect(sessionFile).toBeTruthy();
    expect(path.basename(sessionFile ?? "")).toBe(
      `${result.sessionEntry.sessionId}-topic-456.jsonl`,
    );
  });
});

describe("initSessionState RawBody", () => {
  it("uses RawBody for command extraction and reset triggers when Body contains wrapped context", async () => {
    const root = await makeCaseDir("openclaw-rawbody-");
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const statusResult = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
        ChatType: "group",
        RawBody: "/status",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
    });
    expect(statusResult.triggerBodyNormalized).toBe("/status");

    const resetResult = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: `[Context]\nJake: /new\n[from: Jake]`,
        ChatType: "group",
        RawBody: "/new",
        SessionKey: "agent:main:whatsapp:group:g1",
      },
    });
    expect(resetResult.isNewSession).toBe(true);
    expect(resetResult.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await makeCaseDir("openclaw-rawbody-reset-case-");
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: {
        resetTriggers: ["/new"],
        store: storePath,
      },
    } as OpenClawConfig;

    const ctx = {
      ChatType: "direct",
      RawBody: "/NEW KeepThisCase",
      SessionKey: "agent:main:whatsapp:dm:s1",
    };

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("rotates local session state for /new on bound ACP sessions", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-reset-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      bindings: [
        {
          acp: { mode: "persistent" },
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "discord",
            peer: { id: "1478836151241412759", kind: "channel" },
          },
          type: "acp",
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        CommandBody: "/new",
        From: "discord:12345",
        Provider: "discord",
        RawBody: "/new",
        SenderId: "12345",
        SessionKey: sessionKey,
        Surface: "discord",
        To: "1478836151241412759",
      },
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.isNewSession).toBe(true);
  });

  it("rotates local session state for ACP /new when no matching conversation binding exists", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-reset-no-conversation-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        CommandBody: "/new",
        From: "discord:12345",
        OriginatingTo: "user:12345",
        Provider: "discord",
        RawBody: "/new",
        SenderId: "12345",
        SessionKey: sessionKey,
        Surface: "discord",
        To: "user:12345",
      },
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.isNewSession).toBe(true);
  });

  it("keeps custom reset triggers working on bound ACP sessions", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-custom-reset-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      bindings: [
        {
          acp: { mode: "persistent" },
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "discord",
            peer: { id: "1478836151241412759", kind: "channel" },
          },
          type: "acp",
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: {
        resetTriggers: ["/fresh"],
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        CommandBody: "/fresh",
        From: "discord:12345",
        Provider: "discord",
        RawBody: "/fresh",
        SenderId: "12345",
        SessionKey: sessionKey,
        Surface: "discord",
        To: "1478836151241412759",
      },
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("keeps normal /new behavior for unbound ACP-shaped session keys", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-unbound-reset-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        CommandBody: "/new",
        From: "discord:12345",
        Provider: "discord",
        RawBody: "/new",
        SenderId: "12345",
        SessionKey: sessionKey,
        Surface: "discord",
        To: "1478836151241412759",
      },
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("does not suppress /new when active conversation binding points to a non-ACP session", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-nonacp-binding-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
    const existingSessionId = "session-existing";
    const now = Date.now();
    const channelId = "1478836151241412759";
    const nonAcpFocusSessionKey = "agent:main:discord:channel:focus-target";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      bindings: [
        {
          acp: { mode: "persistent" },
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "discord",
            peer: { id: channelId, kind: "channel" },
          },
          type: "acp",
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    registerSessionBindingAdapter({
      accountId: "default",
      capabilities: { bindSupported: false, placements: ["current"], unbindSupported: false },
      channel: "discord",
      listBySession: () => [],
      resolveByConversation: (ref) => {
        if (ref.conversationId !== channelId) {
          return null;
        }
        return {
          bindingId: "focus-binding",
          boundAt: now,
          conversation: {
            accountId: "default",
            channel: "discord",
            conversationId: channelId,
          },
          status: "active",
          targetKind: "session",
          targetSessionKey: nonAcpFocusSessionKey,
        };
      },
    });
    try {
      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          CommandBody: "/new",
          From: "discord:12345",
          Provider: "discord",
          RawBody: "/new",
          SenderId: "12345",
          SessionKey: sessionKey,
          Surface: "discord",
          To: channelId,
        },
      });

      expect(result.resetTriggered).toBe(true);
      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
    }
  });

  it("does not suppress /new when active target session key is non-ACP even with configured ACP binding", async () => {
    const root = await makeCaseDir("openclaw-rawbody-acp-configured-fallback-target-");
    const storePath = path.join(root, "sessions.json");
    const channelId = "1478836151241412759";
    const fallbackSessionKey = "agent:main:discord:channel:focus-target";
    const existingSessionId = "session-existing";
    const now = Date.now();

    await writeSessionStoreFast(storePath, {
      [fallbackSessionKey]: {
        sessionId: existingSessionId,
        systemSent: true,
        updatedAt: now,
      },
    });

    const cfg = {
      bindings: [
        {
          acp: { mode: "persistent" },
          agentId: "codex",
          match: {
            accountId: "default",
            channel: "discord",
            peer: { id: channelId, kind: "channel" },
          },
          type: "acp",
        },
      ],
      channels: {
        discord: {
          allowFrom: ["*"],
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        CommandBody: "/new",
        From: "discord:12345",
        Provider: "discord",
        RawBody: "/new",
        SenderId: "12345",
        SessionKey: fallbackSessionKey,
        Surface: "discord",
        To: channelId,
      },
    });

    expect(result.resetTriggered).toBe(true);
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("prefers native command target sessions over bound slash sessions", async () => {
    const storePath = await createStorePath("native-command-target-session-");
    const boundSlashSessionKey = "slack:slash:123";
    const targetSessionKey = "agent:main:main";
    const cfg = {
      session: { store: storePath },
    } as OpenClawConfig;

    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      accountId: "default",
      channel: "slack",
    });
    await getSessionBindingService().bind({
      conversation: {
        accountId: "default",
        channel: "slack",
        conversationId: "channel:ops",
      },
      placement: "current",
      targetKind: "session",
      targetSessionKey: boundSlashSessionKey,
    });

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        AccountId: "default",
        Body: `/model openai-codex/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        CommandBody: `/model openai-codex/gpt-5.4@${TEST_NATIVE_MODEL_PROFILE_ID}`,
        CommandSource: "native",
        CommandTargetSessionKey: targetSessionKey,
        From: "slack:U123",
        OriginatingTo: "channel:ops",
        Provider: "slack",
        SenderId: "U123",
        SessionKey: boundSlashSessionKey,
        Surface: "slack",
        To: "channel:ops",
      },
    });

    expect(result.sessionKey).toBe(targetSessionKey);
    expect(result.sessionCtx.SessionKey).toBe(targetSessionKey);
  });

  it("uses the default per-agent sessions store when config store is unset", async () => {
    const root = await makeCaseDir("openclaw-session-store-default-");
    const stateDir = path.join(root, ".openclaw");
    const agentId = "worker1";
    const sessionKey = `agent:${agentId}:telegram:12345`;
    const sessionId = "sess-worker-1";
    const sessionFile = path.join(stateDir, "agents", agentId, "sessions", `${sessionId}.jsonl`);
    const storePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");

    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionFile,
          sessionId,
          updatedAt: Date.now(),
        },
      });

      const cfg = {} as OpenClawConfig;
      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: "hello",
          ChatType: "direct",
          Provider: "telegram",
          SessionKey: sessionKey,
          Surface: "telegram",
        },
      });

      expect(result.sessionEntry.sessionId).toBe(sessionId);
      expect(result.sessionEntry.sessionFile).toBe(sessionFile);
      expect(result.storePath).toBe(storePath);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      conversation: {
        accountId: "default",
        channel: "slack",
        conversationId: "user:U123",
      },
      ctx: {
        ChatType: "direct",
        From: "slack:user:U123",
        OriginatingTo: "user:U123",
        Provider: "slack",
        SenderId: "U123",
        Surface: "slack",
        To: "user:U123",
      },
      name: "Slack DM",
    },
    {
      conversation: {
        accountId: "default",
        channel: "signal",
        conversationId: "+15550001111",
      },
      ctx: {
        ChatType: "direct",
        From: "signal:+15550001111",
        OriginatingTo: "signal:+15550001111",
        Provider: "signal",
        SenderId: "+15550001111",
        Surface: "signal",
        To: "+15550001111",
      },
      name: "Signal DM",
    },
    {
      conversation: {
        accountId: "default",
        channel: "googlechat",
        conversationId: "spaces/AAAAAAA",
      },
      ctx: {
        ChatType: "group",
        From: "googlechat:users/123",
        OriginatingTo: "googlechat:spaces/AAAAAAA",
        Provider: "googlechat",
        SenderId: "users/123",
        Surface: "googlechat",
        To: "spaces/AAAAAAA",
      },
      name: "Google Chat room",
    },
  ])("routes generic current-conversation bindings for $name", async ({ conversation, ctx }) => {
    setMinimalCurrentConversationBindingRegistryForTests();
    registerCurrentConversationBindingAdapterForTest({
      accountId: "default",
      channel: conversation.channel as "slack" | "signal" | "googlechat",
    });
    const storePath = await createStorePath("openclaw-generic-current-binding-");
    const boundSessionKey = `agent:codex:acp:binding:${conversation.channel}:default:test`;

    await getSessionBindingService().bind({
      conversation,
      targetKind: "session",
      targetSessionKey: boundSessionKey,
    });

    const result = await initSessionState({
      cfg: {
        session: { store: storePath },
      } as OpenClawConfig,
      commandAuthorized: true,
      ctx: {
        RawBody: "hello",
        SessionKey: `agent:main:${conversation.channel}:seed`,
        ...ctx,
      },
    });

    expect(result.sessionKey).toBe(boundSessionKey);
  });
});

describe("initSessionState reset policy", () => {
  let clearBootstrapSnapshotOnSessionRolloverSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    clearBootstrapSnapshotOnSessionRolloverSpy = vi.spyOn(
      bootstrapCache,
      "clearBootstrapSnapshotOnSessionRollover",
    );
  });

  afterEach(() => {
    clearBootstrapSnapshotOnSessionRolloverSpy.mockRestore();
    vi.useRealTimers();
  });

  it("defaults to daily reset at 4am local time", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s1";
    const existingSessionId = "daily-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      previousSessionId: existingSessionId,
      sessionKey,
    });
  });

  it("treats sessions as stale before the daily reset when updated before yesterday's boundary", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    const root = await makeCaseDir("openclaw-reset-daily-edge-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s-edge";
    const existingSessionId = "daily-edge-session";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
      },
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("expires sessions when idle timeout wins over daily reset", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    const root = await makeCaseDir("openclaw-reset-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s2";
    const existingSessionId = "idle-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { atHour: 4, idleMinutes: 30, mode: "daily" },
        store: storePath,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("uses per-type overrides for thread sessions", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:slack:channel:c1:thread:123";
    const existingSessionId = "thread-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        reset: { atHour: 4, mode: "daily" },
        resetByType: { thread: { idleMinutes: 180, mode: "idle" } },
        store: storePath,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Slack thread" },
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("detects thread sessions without thread key suffix", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-thread-nosuffix-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:channel:c1";
    const existingSessionId = "thread-nosuffix";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        resetByType: { thread: { idleMinutes: 180, mode: "idle" } },
        store: storePath,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Discord thread" },
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("defaults to daily resets when only resetByType is configured", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-type-default-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s4";
    const existingSessionId = "type-default-session";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        resetByType: { thread: { idleMinutes: 60, mode: "idle" } },
        store: storePath,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
  });

  it("keeps legacy idleMinutes behavior without reset config", async () => {
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    const root = await makeCaseDir("openclaw-reset-legacy-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:whatsapp:dm:s3";
    const existingSessionId = "legacy-session-id";

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
      },
    });

    const cfg = {
      session: {
        idleMinutes: 240,
        store: storePath,
      },
    } as OpenClawConfig;
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: { Body: "hello", SessionKey: sessionKey },
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(clearBootstrapSnapshotOnSessionRolloverSpy).toHaveBeenCalledWith({
      previousSessionId: undefined,
      sessionKey,
    });
  });
});

describe("initSessionState channel reset overrides", () => {
  it("uses channel-specific reset policy when configured", async () => {
    const root = await makeCaseDir("openclaw-channel-idle-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:discord:dm:123";
    const sessionId = "session-override";
    const updatedAt = Date.now() - (10_080 - 1) * 60_000;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId,
        updatedAt,
      },
    });

    const cfg = {
      session: {
        idleMinutes: 60,
        resetByChannel: { discord: { idleMinutes: 10_080, mode: "idle" } },
        resetByType: { direct: { idleMinutes: 10, mode: "idle" } },
        store: storePath,
      },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "Hello",
        Provider: "discord",
        SessionKey: sessionKey,
      },
    });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionEntry.sessionId).toBe(sessionId);
  });
});

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): OpenClawConfig {
    return {
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
      session: { idleMinutes: 999, store: params.storePath },
    } as OpenClawConfig;
  }

  it("applies WhatsApp group reset authorization across sender variants", async () => {
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    const storePath = await createStorePath("openclaw-group-reset");
    const cases = [
      {
        allowFrom: ["+41796666864"],
        body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
        expectedIsNewSession: true,
        name: "authorized sender",
        senderE164: "+41796666864",
        senderId: "41796666864:0@s.whatsapp.net",
        senderName: "Peschiño",
      },
      {
        allowFrom: ["+41796666864"],
        body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
        expectedIsNewSession: true,
        name: "LID sender with unauthorized E164",
        senderE164: "+1555123456",
        senderId: "123@lid",
        senderName: "Other",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStore({
        sessionId: existingSessionId,
        sessionKey,
        storePath,
      });
      const cfg = makeCfg({
        allowFrom: [...testCase.allowFrom],
        storePath,
      });

      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: testCase.body,
          ChatType: "group",
          CommandBody: "/new",
          From: "120363406150318674@g.us",
          Provider: "whatsapp",
          RawBody: "/new",
          SenderE164: testCase.senderE164,
          SenderId: testCase.senderId,
          SenderName: testCase.senderName,
          SessionKey: sessionKey,
          Surface: "whatsapp",
          To: "+41779241027",
        },
      });

      expect(result.triggerBodyNormalized, testCase.name).toBe("/new");
      expect(result.isNewSession, testCase.name).toBe(testCase.expectedIsNewSession);
      if (testCase.expectedIsNewSession) {
        expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
        expect(result.bodyStripped, testCase.name).toBe("");
      } else {
        expect(result.sessionId, testCase.name).toBe(existingSessionId);
      }
    }
  });
});

describe("initSessionState reset triggers in Slack channels", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  it("supports mention-prefixed Slack reset commands and preserves args", async () => {
    setMinimalCurrentConversationBindingRegistryForTests();
    const existingSessionId = "existing-session-123";
    const sessionKey = "agent:main:slack:channel:c2";
    const body = "<@U123> /new take notes";
    const storePath = await createStorePath("openclaw-slack-channel-new-");
    await seedSessionStore({
      sessionId: existingSessionId,
      sessionKey,
      storePath,
    });
    const cfg = {
      session: { idleMinutes: 999, store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: body,
        BodyForCommands: "/new take notes",
        ChatType: "channel",
        CommandBody: body,
        From: "slack:channel:C1",
        Provider: "slack",
        RawBody: body,
        SenderId: "U123",
        SenderName: "Owner",
        SessionKey: sessionKey,
        Surface: "slack",
        To: "channel:C1",
        WasMentioned: true,
      },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("take notes");
  });
});

describe("initSessionState preserves behavior overrides across /new and /reset", () => {
  async function seedSessionStoreWithOverrides(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    overrides: Record<string, unknown>;
  }): Promise<void> {
    await writeSessionStoreFast(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        ...params.overrides,
      },
    });
  }

  it("preserves behavior overrides across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-overrides-");
    const sessionKey = "agent:main:telegram:dm:user-overrides";
    const existingSessionId = "existing-session-overrides";
    const overrides = {
      label: "telegram-priority",
      reasoningLevel: "low",
      thinkingLevel: "high",
      verboseLevel: "on",
    } as const;
    const cases = [
      {
        body: "/new",
        name: "new preserves behavior overrides",
      },
      {
        body: "/reset",
        name: "reset preserves behavior overrides",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        overrides: { ...overrides },
        sessionId: existingSessionId,
        sessionKey,
        storePath,
      });

      const cfg = {
        session: { idleMinutes: 999, store: storePath },
      } as OpenClawConfig;

      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: testCase.body,
          ChatType: "direct",
          CommandBody: testCase.body,
          From: "user-overrides",
          Provider: "telegram",
          RawBody: testCase.body,
          SessionKey: sessionKey,
          Surface: "telegram",
          To: "bot",
        },
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry, testCase.name).toMatchObject(overrides);
    }
  });

  it("preserves selected auth profile overrides across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-model-auth-");
    const sessionKey = "agent:main:telegram:dm:user-model-auth";
    const existingSessionId = "existing-session-model-auth";
    const overrides = {
      authProfileOverride: "20251001",
      authProfileOverrideCompactionCount: 2,
      authProfileOverrideSource: "user",
      claudeCliSessionId: "cli-session-123",
      cliSessionBindings: {
        "claude-cli": {
          authProfileId: "anthropic:default",
          sessionId: "cli-session-123",
        },
      },
      cliSessionIds: { "claude-cli": "cli-session-123" },
      modelOverride: "gpt-4o",
      providerOverride: "openai",
    } as const;
    const cases = [
      {
        body: "/new",
        name: "new preserves selected auth profile overrides",
      },
      {
        body: "/reset",
        name: "reset preserves selected auth profile overrides",
      },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        overrides: { ...overrides },
        sessionId: existingSessionId,
        sessionKey,
        storePath,
      });

      const cfg = {
        session: { idleMinutes: 999, store: storePath },
      } as OpenClawConfig;

      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: testCase.body,
          ChatType: "direct",
          CommandBody: testCase.body,
          From: "user-model-auth",
          Provider: "telegram",
          RawBody: testCase.body,
          SessionKey: sessionKey,
          Surface: "telegram",
          To: "bot",
        },
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry, testCase.name).toMatchObject({
        authProfileOverride: overrides.authProfileOverride,
        authProfileOverrideCompactionCount: overrides.authProfileOverrideCompactionCount,
        authProfileOverrideSource: overrides.authProfileOverrideSource,
        modelOverride: overrides.modelOverride,
        providerOverride: overrides.providerOverride,
      });
      expect(result.sessionEntry.cliSessionIds).toBeUndefined();
      expect(result.sessionEntry.cliSessionBindings).toBeUndefined();
      expect(result.sessionEntry.claudeCliSessionId).toBeUndefined();

      const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
      expect(stored[sessionKey].cliSessionIds).toBeUndefined();
      expect(stored[sessionKey].cliSessionBindings).toBeUndefined();
      expect(stored[sessionKey].claudeCliSessionId).toBeUndefined();
    }
  });

  it("preserves spawned session ownership metadata across /new and /reset", async () => {
    const storePath = await createStorePath("openclaw-reset-spawned-metadata-");
    const sessionKey = "subagent:owned-child";
    const existingSessionId = "existing-session-owned-child";
    const overrides = {
      displayName: "Ops Child",
      forkedFromParent: true,
      parentSessionKey: "agent:main:main",
      spawnDepth: 2,
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/child-workspace",
      subagentControlScope: "children",
      subagentRole: "orchestrator",
    } as const;
    const cases = [
      { body: "/new", name: "new preserves spawned session ownership metadata" },
      { body: "/reset", name: "reset preserves spawned session ownership metadata" },
    ] as const;

    for (const testCase of cases) {
      await seedSessionStoreWithOverrides({
        overrides: { ...overrides },
        sessionId: existingSessionId,
        sessionKey,
        storePath,
      });

      const cfg = {
        session: { idleMinutes: 999, store: storePath },
      } as OpenClawConfig;

      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: testCase.body,
          ChatType: "direct",
          CommandBody: testCase.body,
          From: "user-owned-child",
          Provider: "telegram",
          RawBody: testCase.body,
          SessionKey: sessionKey,
          Surface: "telegram",
          To: "bot",
        },
      });

      expect(result.isNewSession, testCase.name).toBe(true);
      expect(result.resetTriggered, testCase.name).toBe(true);
      expect(result.sessionId, testCase.name).not.toBe(existingSessionId);
      expect(result.sessionEntry).toMatchObject(overrides);
    }
  });

  it("requires operator.admin when Provider is internal even if Surface carries external metadata", async () => {
    const storePath = await createStorePath("openclaw-internal-reset-provider-authoritative-");
    const sessionKey = "agent:main:telegram:dm:provider-authoritative";
    const existingSessionId = "existing-session-provider-authoritative";

    await seedSessionStoreWithOverrides({
      overrides: {},
      sessionId: existingSessionId,
      sessionKey,
      storePath,
    });

    const cfg = {
      session: { idleMinutes: 999, store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "/reset",
        ChatType: "direct",
        CommandBody: "/reset",
        GatewayClientScopes: ["operator.write"],
        OriginatingChannel: "telegram",
        Provider: "webchat",
        RawBody: "/reset",
        SessionKey: sessionKey,
        Surface: "telegram",
      },
    });

    expect(result.resetTriggered).toBe(false);
    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
  });

  it("archives the old session store entry on /new", async () => {
    const storePath = await createStorePath("openclaw-archive-old-");
    const sessionKey = "agent:main:telegram:dm:user-archive";
    const existingSessionId = "existing-session-archive";
    const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);
    await seedSessionStoreWithOverrides({
      overrides: { verboseLevel: "on" },
      sessionId: existingSessionId,
      sessionKey,
      storePath,
    });
    await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

    const cfg = {
      session: { idleMinutes: 999, store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "/new",
        ChatType: "direct",
        CommandBody: "/new",
        From: "user-archive",
        Provider: "telegram",
        RawBody: "/new",
        SessionKey: sessionKey,
        Surface: "telegram",
        To: "bot",
      },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(true);
    expect(await fs.stat(transcriptPath).catch(() => null)).toBeNull();
    const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
      entry.startsWith(`${existingSessionId}.jsonl.reset.`),
    );
    expect(archived).toHaveLength(1);
  });

  it("archives the old session transcript on daily/scheduled reset (stale session)", async () => {
    // Daily resets occur when the session becomes stale (not via /new or /reset command).
    // Previously, previousSessionEntry was only set when resetTriggered=true, leaving
    // Old transcript files orphaned on disk. Refs #35481.
    vi.useFakeTimers();
    try {
      // Simulate: it is 5am, session was last active at 3am (before 4am daily boundary)
      vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
      const storePath = await createStorePath("openclaw-stale-archive-");
      const sessionKey = "agent:main:telegram:dm:archive-stale-user";
      const existingSessionId = "stale-session-to-be-archived";
      const transcriptPath = path.join(path.dirname(storePath), `${existingSessionId}.jsonl`);

      await writeSessionStoreFast(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });
      await fs.writeFile(transcriptPath, '{"type":"message"}\n', "utf8");

      const cfg = { session: { store: storePath } } as OpenClawConfig;
      const result = await initSessionState({
        cfg,
        commandAuthorized: true,
        ctx: {
          Body: "hello",
          ChatType: "direct",
          CommandBody: "hello",
          From: "user-stale",
          Provider: "telegram",
          RawBody: "hello",
          SessionKey: sessionKey,
          Surface: "telegram",
          To: "bot",
        },
      });

      expect(result.isNewSession).toBe(true);
      expect(result.resetTriggered).toBe(false);
      expect(result.sessionId).not.toBe(existingSessionId);
      expect(await fs.stat(transcriptPath).catch(() => null)).toBeNull();
      const archived = (await fs.readdir(path.dirname(storePath))).filter((entry) =>
        entry.startsWith(`${existingSessionId}.jsonl.reset.`),
      );
      expect(archived).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the previous bundle MCP runtime on session rollover", async () => {
    const storePath = await createStorePath("openclaw-stale-runtime-dispose-");
    const sessionKey = "agent:main:telegram:dm:runtime-stale-user";
    const existingSessionId = "stale-runtime-session";
    const cfg = {
      session: {
        reset: { idleMinutes: 1, mode: "idle" },
        store: storePath,
      },
    } as OpenClawConfig;

    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: existingSessionId,
        updatedAt: Date.now() - 5 * 60_000,
      },
    });

    await getOrCreateSessionMcpRuntime({
      cfg,
      sessionId: existingSessionId,
      sessionKey,
      workspaceDir: path.dirname(storePath),
    });

    expect(sessionMcpTesting.getCachedSessionIds()).toContain(existingSessionId);

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello",
        ChatType: "direct",
        CommandBody: "hello",
        From: "user-stale-runtime",
        Provider: "telegram",
        RawBody: "hello",
        SessionKey: sessionKey,
        Surface: "telegram",
        To: "bot",
      },
    });

    expect(sessionMcpTesting.getCachedSessionIds()).not.toContain(existingSessionId);
  });

  it("idle-based new session does NOT preserve overrides (no entry to read)", async () => {
    const storePath = await createStorePath("openclaw-idle-no-preserve-");
    const sessionKey = "agent:main:telegram:dm:new-user";

    const cfg = {
      session: { idleMinutes: 0, store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello",
        ChatType: "direct",
        CommandBody: "hello",
        From: "new-user",
        Provider: "telegram",
        RawBody: "hello",
        SessionKey: sessionKey,
        Surface: "telegram",
        To: "bot",
      },
    });

    expect(result.isNewSession).toBe(true);
    expect(result.resetTriggered).toBe(false);
    expect(result.sessionEntry.verboseLevel).toBeUndefined();
    expect(result.sessionEntry.thinkingLevel).toBeUndefined();
  });
});

describe("drainFormattedSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    try {
      const timestamp = new Date("2026-01-12T20:19:17Z");
      const expectedTimestamp = formatZonedTimestamp(timestamp, { displaySeconds: true });
      vi.setSystemTime(timestamp);

      enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

      const result = await drainFormattedSystemEvents({
        cfg: {} as OpenClawConfig,
        isMainSession: true,
        isNewSession: false,
        sessionKey: "agent:main:main",
      });

      expect(expectedTimestamp).toBeDefined();
      expect(result).toContain(`System: [${expectedTimestamp}] Model switched.`);
    } finally {
      resetSystemEventsForTest();
      vi.useRealTimers();
    }
  });

  it("keeps channel summary lines prefixed as trusted system output on new main sessions", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          plugin: {
            ...createChannelTestPluginBase({ id: "whatsapp", label: "WhatsApp" }),
            config: {
              defaultAccountId: () => "default",
              inspectAccount: () => ({
                accountId: "default",
                configured: true,
                enabled: true,
                name: "line one\nline two",
              }),
              listAccountIds: () => ["default"],
              resolveAccount: () => ({
                accountId: "default",
                configured: true,
                enabled: true,
                name: "line one\nline two",
              }),
            },
            status: {
              buildChannelSummary: async () => ({ linked: true }),
            },
          },
          pluginId: "whatsapp",
          source: "test",
        },
      ]),
    );

    const result = await drainFormattedSystemEvents({
      cfg: { channels: {} } as OpenClawConfig,
      isMainSession: true,
      isNewSession: true,
      sessionKey: "agent:main:main",
    });

    expect(result).toContain("System: WhatsApp: linked");
    for (const line of result!.split("\n")) {
      expect(line).toMatch(/^System:/);
    }
  });
});

describe("persistSessionUsageUpdate", () => {
  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    entry: Record<string, unknown>;
  }) {
    await fs.mkdir(path.dirname(params.storePath), { recursive: true });
    await fs.writeFile(
      params.storePath,
      JSON.stringify({ [params.sessionKey]: params.entry }, null, 2),
      "utf8",
    );
  }

  it("uses lastCallUsage for totalTokens when provided", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", totalTokens: 100_000, updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    const accumulatedUsage = { input: 180_000, output: 10_000, total: 190_000 };
    const lastCallUsage = { input: 12_000, output: 2000, total: 14_000 };

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      lastCallUsage,
      sessionKey,
      storePath,
      usage: accumulatedUsage,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBe(12_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(180_000);
    expect(stored[sessionKey].outputTokens).toBe(10_000);
  });

  it("uses lastCallUsage cache counters when available", async () => {
    const storePath = await createStorePath("openclaw-usage-cache-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      lastCallUsage: {
        cacheRead: 18_000,
        cacheWrite: 4000,
        input: 12_000,
        output: 1000,
      },
      sessionKey,
      storePath,
      usage: {
        cacheRead: 260_000,
        cacheWrite: 90_000,
        input: 100_000,
        output: 8000,
      },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].inputTokens).toBe(100_000);
    expect(stored[sessionKey].outputTokens).toBe(8000);
    expect(stored[sessionKey].cacheRead).toBe(18_000);
    expect(stored[sessionKey].cacheWrite).toBe(4000);
  });

  it("marks totalTokens as unknown when no fresh context snapshot is available", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      sessionKey,
      storePath,
      usage: { input: 50_000, output: 5000, total: 55_000 },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBeUndefined();
    expect(stored[sessionKey].totalTokensFresh).toBe(false);
  });

  it("uses promptTokens when available without lastCallUsage", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      promptTokens: 42_000,
      sessionKey,
      storePath,
      usage: { input: 50_000, output: 5000, total: 55_000 },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBe(42_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("treats CLI usage as a fresh context snapshot when requested", async () => {
    const storePath = await createStorePath("openclaw-usage-cli-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      cliSessionBinding: {
        authProfileId: "anthropic:default",
        extraSystemPromptHash: "prompt-hash",
        mcpConfigHash: "mcp-hash",
        sessionId: "cli-session-1",
      },
      contextTokensUsed: 200_000,
      providerUsed: "claude-cli",
      sessionKey,
      storePath,
      usage: { cacheRead: 8000, input: 24_000, output: 2000 },
      usageIsContextSnapshot: true,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBe(32_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].cliSessionIds?.["claude-cli"]).toBe("cli-session-1");
    expect(stored[sessionKey].cliSessionBindings?.["claude-cli"]).toEqual({
      authProfileId: "anthropic:default",
      extraSystemPromptHash: "prompt-hash",
      mcpConfigHash: "mcp-hash",
      sessionId: "cli-session-1",
    });
  });

  it("persists totalTokens from promptTokens when usage is unavailable", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: {
        inputTokens: 1234,
        outputTokens: 456,
        sessionId: "s1",
        updatedAt: Date.now(),
      },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      promptTokens: 39_000,
      sessionKey,
      storePath,
      usage: undefined,
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBe(39_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
    expect(stored[sessionKey].inputTokens).toBe(1234);
    expect(stored[sessionKey].outputTokens).toBe(456);
  });

  it("keeps non-clamped lastCallUsage totalTokens when exceeding context window", async () => {
    const storePath = await createStorePath("openclaw-usage-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: { sessionId: "s1", updatedAt: Date.now() },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      contextTokensUsed: 200_000,
      lastCallUsage: { input: 250_000, output: 5000, total: 255_000 },
      sessionKey,
      storePath,
      usage: { input: 300_000, output: 10_000, total: 310_000 },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].totalTokens).toBe(250_000);
    expect(stored[sessionKey].totalTokensFresh).toBe(true);
  });

  it("accumulates estimatedCostUsd across persisted usage updates", async () => {
    const storePath = await createStorePath("openclaw-usage-cost-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: {
        estimatedCostUsd: 0.0015,
        sessionId: "s1",
        updatedAt: Date.now(),
      },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      cfg: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  contextWindow: 200_000,
                  cost: { cacheRead: 0.125, cacheWrite: 0.5, input: 1.25, output: 10 },
                  id: "gpt-5.4",
                  input: ["text"],
                  maxTokens: 8_192,
                  name: "GPT 5.4",
                  reasoning: true,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
      contextTokensUsed: 200_000,
      lastCallUsage: { cacheRead: 300, cacheWrite: 50, input: 800, output: 200 },
      modelUsed: "gpt-5.4",
      providerUsed: "openai",
      sessionKey,
      storePath,
      usage: { cacheRead: 1000, cacheWrite: 200, input: 2000, output: 500 },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].estimatedCostUsd).toBeCloseTo(0.009_225, 8);
  });

  it("persists zero estimatedCostUsd for free priced models", async () => {
    const storePath = await createStorePath("openclaw-usage-free-cost-");
    const sessionKey = "main";
    await seedSessionStore({
      entry: {
        sessionId: "s1",
        updatedAt: Date.now(),
      },
      sessionKey,
      storePath,
    });

    await persistSessionUsageUpdate({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  contextWindow: 200_000,
                  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
                  id: "gpt-5.3-codex-spark",
                  input: ["text"],
                  maxTokens: 8_192,
                  name: "GPT 5.3 Codex Spark",
                  reasoning: true,
                },
              ],
            },
          },
        },
      } satisfies OpenClawConfig,
      contextTokensUsed: 200_000,
      lastCallUsage: { cacheRead: 1536, cacheWrite: 0, input: 5107, output: 1827 },
      modelUsed: "gpt-5.3-codex-spark",
      providerUsed: "openai-codex",
      sessionKey,
      storePath,
      usage: { cacheRead: 1536, cacheWrite: 0, input: 5107, output: 1827 },
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    expect(stored[sessionKey].estimatedCostUsd).toBe(0);
  });
});

describe("initSessionState stale threadId fallback", () => {
  it("does not inherit lastThreadId from a previous thread interaction in non-thread sessions", async () => {
    const storePath = await createStorePath("stale-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First interaction: inside a DM topic (thread session)
    const threadResult = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello from topic",
        MessageThreadId: 42,
        SessionKey: "agent:main:main:thread:42",
      },
    });
    expect(threadResult.sessionEntry.lastThreadId).toBe(42);

    // Second interaction: plain DM (non-thread session), same store
    // The main session should NOT inherit threadId=42
    const mainResult = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello from DM",
        SessionKey: "agent:main:main",
      },
    });
    expect(mainResult.sessionEntry.lastThreadId).toBeUndefined();
    expect(mainResult.sessionEntry.deliveryContext?.threadId).toBeUndefined();
  });

  it("preserves lastThreadId within the same thread session", async () => {
    const storePath = await createStorePath("preserve-thread-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    // First message in thread
    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "first",
        MessageThreadId: 99,
        SessionKey: "agent:main:main:thread:99",
      },
    });

    // Second message in same thread (MessageThreadId still present)
    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "second",
        MessageThreadId: 99,
        SessionKey: "agent:main:main:thread:99",
      },
    });
    expect(result.sessionEntry.lastThreadId).toBe(99);
  });
});

describe("initSessionState dmScope delivery migration", () => {
  it("retires stale main-session delivery route when dmScope uses per-channel DM keys", async () => {
    const storePath = await createStorePath("dm-scope-retire-main-route-");
    await writeSessionStoreFast(storePath, {
      "agent:main:main": {
        deliveryContext: {
          accountId: "default",
          channel: "telegram",
          to: "6101296751",
        },
        lastAccountId: "default",
        lastChannel: "telegram",
        lastTo: "6101296751",
        sessionId: "legacy-main",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer", store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        AccountId: "default",
        Body: "hello",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        SessionKey: "agent:main:telegram:direct:6101296751",
      },
    });

    expect(result.sessionKey).toBe("agent:main:telegram:direct:6101296751");
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted["agent:main:main"]?.sessionId).toBe("legacy-main");
    expect(persisted["agent:main:main"]?.deliveryContext).toBeUndefined();
    expect(persisted["agent:main:main"]?.lastChannel).toBeUndefined();
    expect(persisted["agent:main:main"]?.lastTo).toBeUndefined();
    expect(persisted["agent:main:telegram:direct:6101296751"]?.deliveryContext?.to).toBe(
      "6101296751",
    );
  });

  it("keeps legacy main-session delivery route when current DM target does not match", async () => {
    const storePath = await createStorePath("dm-scope-keep-main-route-");
    await writeSessionStoreFast(storePath, {
      "agent:main:main": {
        deliveryContext: {
          accountId: "default",
          channel: "telegram",
          to: "1111",
        },
        lastAccountId: "default",
        lastChannel: "telegram",
        lastTo: "1111",
        sessionId: "legacy-main",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer", store: storePath },
    } as OpenClawConfig;

    await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        AccountId: "default",
        Body: "hello",
        OriginatingChannel: "telegram",
        OriginatingTo: "6101296751",
        SessionKey: "agent:main:telegram:direct:6101296751",
      },
    });

    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted["agent:main:main"]?.deliveryContext).toEqual({
      accountId: "default",
      channel: "telegram",
      to: "1111",
    });
    expect(persisted["agent:main:main"]?.lastTo).toBe("1111");
  });
});

describe("initSessionState internal channel routing preservation", () => {
  it("keeps persisted external lastChannel when OriginatingChannel is internal webchat", async () => {
    const storePath = await createStorePath("preserve-external-channel-");
    const sessionKey = "agent:main:telegram:group:12345";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        deliveryContext: {
          channel: "telegram",
          to: "group:12345",
        },
        lastChannel: "telegram",
        lastTo: "group:12345",
        sessionId: "sess-1",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "internal follow-up",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        SessionKey: sessionKey,
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.lastTo).toBe("group:12345");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.to).toBe("group:12345");
  });

  it("preserves persisted external route when webchat views a channel-peer session (fixes #47745)", async () => {
    // Regression: dashboard/webchat access must not overwrite an established
    // External delivery route (e.g. Telegram/iMessage) on a channel-scoped session.
    // Subagent completions should still be delivered to the original channel.
    const storePath = await createStorePath("webchat-direct-route-preserve-");
    const sessionKey = "agent:main:imessage:direct:+1555";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        deliveryContext: {
          channel: "imessage",
          to: "+1555",
        },
        lastChannel: "imessage",
        lastTo: "+1555",
        sessionId: "sess-webchat-direct",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer", store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "reply from control ui",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        SessionKey: sessionKey,
        Surface: "webchat",
      },
    });

    // External route must be preserved — webchat is admin/monitoring only
    expect(result.sessionEntry.lastChannel).toBe("imessage");
    expect(result.sessionEntry.lastTo).toBe("+1555");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("imessage");
    expect(result.sessionEntry.deliveryContext?.to).toBe("+1555");
  });

  it("lets direct webchat turns own routing for sessions with no prior external route", async () => {
    // Webchat should still own routing for sessions that were created via webchat
    // (no external channel ever established).
    const storePath = await createStorePath("webchat-direct-route-noext-");
    const sessionKey = "agent:main:main";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        sessionId: "sess-webchat-noext",
        updatedAt: Date.now(),
      },
    });
    const cfg = {
      session: { dmScope: "per-channel-peer", store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "reply from control ui",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:dashboard",
        SessionKey: sessionKey,
        Surface: "webchat",
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
    expect(result.sessionEntry.lastTo).toBe("session:dashboard");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("webchat");
    expect(result.sessionEntry.deliveryContext?.to).toBe("session:dashboard");
  });

  it("keeps persisted external route when OriginatingChannel is non-deliverable", async () => {
    const storePath = await createStorePath("preserve-nondeliverable-route-");
    const sessionKey = "agent:main:discord:channel:24680";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        deliveryContext: {
          channel: "discord",
          to: "channel:24680",
        },
        lastChannel: "discord",
        lastTo: "channel:24680",
        sessionId: "sess-2",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "internal handoff",
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
        SessionKey: sessionKey,
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("discord");
    expect(result.sessionEntry.lastTo).toBe("channel:24680");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("discord");
    expect(result.sessionEntry.deliveryContext?.to).toBe("channel:24680");
  });

  it("uses session key channel hint when first turn is internal webchat", async () => {
    const storePath = await createStorePath("session-key-channel-hint-");
    const sessionKey = "agent:main:telegram:group:98765";
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello",
        OriginatingChannel: "webchat",
        SessionKey: sessionKey,
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("telegram");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("telegram");
  });

  it("keeps internal route when there is no persisted external fallback", async () => {
    const storePath = await createStorePath("no-external-fallback-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "handoff only",
        OriginatingChannel: "sessions_send",
        OriginatingTo: "session:handoff",
        SessionKey: "agent:main:main",
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("sessions_send");
    expect(result.sessionEntry.lastTo).toBe("session:handoff");
  });

  it("keeps webchat channel for webchat/main sessions", async () => {
    const storePath = await createStorePath("preserve-webchat-main-");
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello",
        OriginatingChannel: "webchat",
        SessionKey: "agent:main:main",
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("webchat");
  });

  it("preserves external route for main session when webchat accesses without destination (fixes #47745)", async () => {
    // Regression: webchat monitoring a main session that has an established WhatsApp
    // Route must not clear that route. Subagents should still deliver to WhatsApp.
    const storePath = await createStorePath("webchat-main-preserve-external-");
    const sessionKey = "agent:main:main";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        deliveryContext: {
          channel: "whatsapp",
          to: "+15555550123",
        },
        lastChannel: "whatsapp",
        lastTo: "+15555550123",
        sessionId: "sess-webchat-main-1",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "webchat follow-up",
        OriginatingChannel: "webchat",
        SessionKey: sessionKey,
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
    expect(result.sessionEntry.lastTo).toBe("+15555550123");
  });

  it("preserves external route for main session when webchat sends with destination (fixes #47745)", async () => {
    // Regression: webchat sending to a main session with an established WhatsApp route
    // Must not steal that route for webchat delivery.
    const storePath = await createStorePath("preserve-main-external-webchat-send-");
    const sessionKey = "agent:main:main";
    await writeSessionStoreFast(storePath, {
      [sessionKey]: {
        deliveryContext: {
          channel: "whatsapp",
          to: "+15555550123",
        },
        lastChannel: "whatsapp",
        lastTo: "+15555550123",
        sessionId: "sess-webchat-main-2",
        updatedAt: Date.now(),
      },
    });
    const cfg = { session: { store: storePath } } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "reply only here",
        OriginatingChannel: "webchat",
        OriginatingTo: "session:webchat-main",
        SessionKey: sessionKey,
      },
    });

    expect(result.sessionEntry.lastChannel).toBe("whatsapp");
    expect(result.sessionEntry.lastTo).toBe("+15555550123");
    expect(result.sessionEntry.deliveryContext?.channel).toBe("whatsapp");
    expect(result.sessionEntry.deliveryContext?.to).toBe("+15555550123");
  });

  it("uses the configured default account for persisted routing when AccountId is omitted", async () => {
    const storePath = await createStorePath("default-account-routing-context-");
    const cfg = {
      channels: {
        discord: {
          defaultAccount: "work",
        },
      },
      session: { store: storePath },
    } as OpenClawConfig;

    const result = await initSessionState({
      cfg,
      commandAuthorized: true,
      ctx: {
        Body: "hello",
        OriginatingChannel: "discord",
        OriginatingTo: "channel:24680",
        SessionKey: "agent:main:discord:channel:24680",
      },
    });

    expect(result.sessionEntry.lastAccountId).toBe("work");
    expect(result.sessionEntry.deliveryContext?.accountId).toBe("work");
  });
});
