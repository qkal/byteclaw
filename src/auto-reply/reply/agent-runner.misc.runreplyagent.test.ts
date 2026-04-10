import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  abortEmbeddedPiRun,
  __testing as embeddedRunTesting,
  isEmbeddedPiRunActive,
} from "../../agents/pi-embedded-runner/runs.js";
import * as sessionTypesModule from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore, saveSessionStore } from "../../config/sessions.js";
import {
  clearMemoryPluginState,
  registerMemoryFlushPlanResolver,
} from "../../plugins/memory-state.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { __testing as replyRunRegistryTesting } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

function createCliBackendTestConfig() {
  return {
    agents: {
      defaults: {
        cliBackends: {
          "claude-cli": {},
          "google-gemini-cli": {},
        },
      },
    },
  };
}

const runEmbeddedPiAgentMock = vi.fn();
const runCliAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const runtimeErrorMock = vi.fn();
const abortEmbeddedPiRunMock = vi.fn();
const clearSessionQueuesMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const compactState = vi.hoisted(() => ({
  compactEmbeddedPiSessionMock: vi.fn(),
}));

vi.mock("../../agents/model-fallback.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
  runWithModelFallback: (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-auth.js", () => ({
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: (sessionId: string) => {
    abortEmbeddedPiRunMock(sessionId);
    return abortEmbeddedPiRun(sessionId);
  },
  compactEmbeddedPiSession: (params: unknown) => compactState.compactEmbeddedPiSessionMock(params),
  isEmbeddedPiRunActive: (sessionId: string) => isEmbeddedPiRunActive(sessionId),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
}));

vi.mock("../../agents/cli-runner.js", () => ({
  runCliAgent: (...args: unknown[]) => runCliAgentMock(...args),
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    error: (...args: unknown[]) => runtimeErrorMock(...args),
    exit: vi.fn(),
    log: vi.fn(),
  },
}));

vi.mock("./queue.js", () => ({
  clearSessionQueues: (...args: unknown[]) => clearSessionQueuesMock(...args),
  enqueueFollowupRun: vi.fn(),
  refreshQueuedFollowupSession: (...args: unknown[]) => refreshQueuedFollowupSessionMock(...args),
  scheduleFollowupDrain: vi.fn(),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: unknown }) => ({
    diagnostics: [],
    resolvedConfig: config,
  }),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: (provider: string | undefined | null) =>
    provider === "google" || provider === "google-gemini-cli",
}));

const loadCronStoreMock = vi.fn();
vi.mock("../../cron/store.js", () => ({
  loadCronStore: (...args: unknown[]) => loadCronStoreMock(...args),
  resolveCronStorePath: (storePath?: string) => storePath ?? "/tmp/openclaw-cron-store.json",
}));

vi.mock("../../acp/control-plane/manager.js", () => ({
  getAcpSessionManager: () => ({
    cancelSession: async () => {},
    resolveSession: () => ({ kind: "none" }),
  }),
}));

vi.mock("../../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey: () => null,
  listSubagentRunsForController: () => [],
  markSubagentRunTerminated: () => 0,
}));

import { runReplyAgent } from "./agent-runner.js";

interface RunWithModelFallbackParams {
  provider: string;
  model: string;
  run: (provider: string, model: string) => Promise<unknown>;
}

beforeEach(() => {
  embeddedRunTesting.resetActiveEmbeddedRuns();
  replyRunRegistryTesting.resetReplyRunRegistry();
  runEmbeddedPiAgentMock.mockClear();
  runCliAgentMock.mockClear();
  runWithModelFallbackMock.mockClear();
  runtimeErrorMock.mockClear();
  abortEmbeddedPiRunMock.mockClear();
  compactState.compactEmbeddedPiSessionMock.mockReset();
  compactState.compactEmbeddedPiSessionMock.mockResolvedValue({
    compacted: false,
    reason: "test-preflight-disabled",
  });
  clearSessionQueuesMock.mockReset();
  clearSessionQueuesMock.mockReturnValue({ followupCleared: 0, keys: [], laneCleared: 0 });
  refreshQueuedFollowupSessionMock.mockReset();
  refreshQueuedFollowupSessionMock.mockResolvedValue(undefined);
  loadCronStoreMock.mockClear();
  // Default: no cron jobs in store.
  loadCronStoreMock.mockResolvedValue({ jobs: [], version: 1 });

  // Default: no provider switch; execute the chosen provider+model.
  runWithModelFallbackMock.mockImplementation(
    async ({ provider, model, run }: RunWithModelFallbackParams) => ({
      model,
      provider,
      result: await run(provider, model),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  clearMemoryPluginState();
  replyRunRegistryTesting.resetReplyRunRegistry();
  embeddedRunTesting.resetActiveEmbeddedRuns();
});

describe("runReplyAgent auto-compaction token update", () => {
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

  function createBaseRun(params: {
    storePath: string;
    sessionEntry: Record<string, unknown>;
    config?: Record<string, unknown>;
    sessionFile?: string;
    workspaceDir?: string;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "+15550001111",
      Provider: "whatsapp",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        agentDir: "/tmp/agent",
        agentId: "main",
        bashElevated: { allowed: false, defaultLevel: "off", enabled: false },
        blockReplyBreak: "message_end",
        config: params.config ?? {},
        elevatedLevel: "off",
        messageProvider: "whatsapp",
        model: "claude",
        provider: "anthropic",
        sessionFile: params.sessionFile ?? "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey: "main",
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: params.workspaceDir ?? "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;
    return { followupRun, resolvedQueue, sessionCtx, typing };
  }

  it("updates totalTokens from lastCallUsage even without compaction", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-usage-last-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry = {
      sessionId: "session",
      totalTokens: 50_000,
      updatedAt: Date.now(),
    };

    await seedSessionStore({ entry: sessionEntry, sessionKey, storePath });

    runEmbeddedPiAgentMock.mockResolvedValue({
      meta: {
        agentMeta: {
          // Tool-use loop: accumulated input is higher than last call's input
          lastCallUsage: { input: 55_000, output: 2000, total: 57_000 },
          usage: { input: 75_000, output: 5000, total: 80_000 },
        },
      },
      payloads: [{ text: "ok" }],
    });

    const { typing, sessionCtx, resolvedQueue, followupRun } = createBaseRun({
      sessionEntry,
      storePath,
    });

    await runReplyAgent({
      agentCfgContextTokens: 200_000,
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      sessionEntry,
      sessionKey,
      sessionStore: { [sessionKey]: sessionEntry },
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      storePath,
      typing,
      typingMode: "instant",
    });

    const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
    // TotalTokens should use lastCallUsage (55k), not accumulated (75k)
    expect(stored[sessionKey].totalTokens).toBe(55_000);
  });
});

describe("runReplyAgent block streaming", () => {
  it("coalesces duplicate text_end block replies", async () => {
    const onBlockReply = vi.fn();
    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Hello" });
      block?.({ text: "Hello" });
      return {
        meta: {},
        payloads: [{ text: "Final message" }],
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "channel:C1",
      Provider: "discord",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "text_end",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                idleMs: 0,
                maxChars: 200,
                minChars: 1,
              },
            },
          },
        },
        elevatedLevel: "off",
        messageProvider: "discord",
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

    const result = await runReplyAgent({
      blockReplyChunking: {
        breakPreference: "paragraph",
        maxChars: 200,
        minChars: 1,
      },
      blockStreamingEnabled: true,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      opts: { onBlockReply },
      queueKey: "main",
      resolvedBlockStreamingBreak: "text_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });

    expect(onBlockReply).toHaveBeenCalledTimes(1);
    expect(onBlockReply.mock.calls[0][0].text).toBe("Hello");
    expect(result).toBeUndefined();
  });

  it("returns the final payload when onBlockReply times out", async () => {
    vi.useFakeTimers();
    let sawAbort = false;

    const onBlockReply = vi.fn(
      (_payload, context) =>
        new Promise<void>((resolve) => {
          context?.abortSignal?.addEventListener(
            "abort",
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true },
          );
        }),
    );

    runEmbeddedPiAgentMock.mockImplementationOnce(async (params) => {
      const block = params.onBlockReply as ((payload: { text?: string }) => void) | undefined;
      block?.({ text: "Chunk" });
      return {
        meta: {},
        payloads: [{ text: "Final message" }],
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "channel:C1",
      Provider: "discord",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "text_end",
        config: {
          agents: {
            defaults: {
              blockStreamingCoalesce: {
                idleMs: 0,
                maxChars: 200,
                minChars: 1,
              },
            },
          },
        },
        elevatedLevel: "off",
        messageProvider: "discord",
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

    const resultPromise = runReplyAgent({
      blockReplyChunking: {
        breakPreference: "paragraph",
        maxChars: 200,
        minChars: 1,
      },
      blockStreamingEnabled: true,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      opts: { blockReplyTimeoutMs: 1, onBlockReply },
      queueKey: "main",
      resolvedBlockStreamingBreak: "text_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(5);
    const result = await resultPromise;

    expect(sawAbort).toBe(true);
    expect(result).toMatchObject({ text: "Final message" });
  });
});

describe("runReplyAgent Active Memory inline debug", () => {
  it("appends inline Active Memory debug payload when verbose is enabled", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-inline-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: sessionEntry,
        },
        null,
        2,
      ),
      "utf8",
    );

    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      const latest = loadSessionStore(storePath, { skipCache: true });
      latest[sessionKey] = {
        ...latest[sessionKey],
        pluginDebugEntries: [
          {
            lines: [
              "🧩 Active Memory: ok 842ms recent 34 chars",
              "🔎 Active Memory Debug: Lemon pepper wings with blue cheese.",
            ],
            pluginId: "active-memory",
          },
        ],
      };
      await saveSessionStore(storePath, latest);
      return {
        meta: {},
        payloads: [{ text: "Normal reply" }],
      };
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "chat:1",
      Provider: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        agentId: "main",
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: {},
        elevatedLevel: "off",
        messageProvider: "telegram",
        model: "claude",
        provider: "anthropic",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey,
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "on",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    const result = await runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: sessionKey,
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "on",
      sessionCtx,
      sessionEntry,
      sessionKey,
      sessionStore: { [sessionKey]: sessionEntry },
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      storePath,
      typing,
      typingMode: "instant",
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as { text?: string }[]).map((payload) => payload.text)).toEqual([
      "🧩 Active Memory: ok 842ms recent 34 chars\n🔎 Active Memory Debug: Lemon pepper wings with blue cheese.",
      "Normal reply",
    ]);
  });

  it("does not reload the session store when verbose is disabled", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-active-memory-inline-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const sessionEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: Date.now(),
    };

    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: sessionEntry,
        },
        null,
        2,
      ),
      "utf8",
    );

    const loadSessionStoreSpy = vi.spyOn(sessionTypesModule, "loadSessionStore");
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "Normal reply" }],
    });

    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "chat:1",
      Provider: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        agentId: "main",
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: {},
        elevatedLevel: "off",
        messageProvider: "telegram",
        model: "claude",
        provider: "anthropic",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey,
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    const result = await runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: sessionKey,
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      sessionEntry,
      sessionKey,
      sessionStore: { [sessionKey]: sessionEntry },
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      storePath,
      typing,
      typingMode: "instant",
    });

    expect(loadSessionStoreSpy).not.toHaveBeenCalledWith(storePath, { skipCache: true });
    expect(result).toMatchObject({ text: "Normal reply" });
  });
});

describe("runReplyAgent claude-cli routing", () => {
  function createRun() {
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "session:1",
      Provider: "webchat",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: { agents: { defaults: { cliBackends: { "claude-cli": {} } } } },
        elevatedLevel: "off",
        messageProvider: "webchat",
        model: "opus-4.5",
        provider: "claude-cli",
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

    return runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "claude-cli/opus-4.5",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });
  }

  it("uses the CLI runner for claude-cli provider", async () => {
    runCliAgentMock.mockResolvedValueOnce({
      meta: {
        agentMeta: {
          model: "opus-4.5",
          provider: "claude-cli",
        },
      },
      payloads: [{ text: "ok" }],
    });

    const result = await createRun();

    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ text: "ok" });
  });
});

describe("runReplyAgent messaging tool suppression", () => {
  function createRun(
    messageProvider = "slack",
    opts: { storePath?: string; sessionKey?: string } = {},
  ) {
    const typing = createMockTypingController();
    const sessionKey = opts.sessionKey ?? "main";
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "channel:C1",
      Provider: messageProvider,
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider,
        model: "claude",
        provider: "anthropic",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey,
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    return runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      sessionKey,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      storePath: opts.storePath,
      typing,
      typingMode: "instant",
    });
  }

  it("drops replies when a messaging tool sent via the same provider + target", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      messagingToolSentTargets: [{ provider: "slack", to: "channel:C1", tool: "slack" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
      payloads: [{ text: "hello world!" }],
    });

    const result = await createRun("slack");

    expect(result).toBeUndefined();
  });

  it("delivers replies when tool provider does not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      messagingToolSentTargets: [{ provider: "discord", to: "channel:C1", tool: "discord" }],
      messagingToolSentTexts: ["different message"],
      meta: {},
      payloads: [{ text: "hello world!" }],
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("keeps final reply when text matches a cross-target messaging send", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      messagingToolSentTargets: [{ provider: "discord", to: "channel:C1", tool: "discord" }],
      messagingToolSentTexts: ["hello world!"],
      meta: {},
      payloads: [{ text: "hello world!" }],
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });

  it("delivers replies when account ids do not match", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      messagingToolSentTargets: [
        {
          accountId: "alt",
          provider: "slack",
          to: "channel:C1",
          tool: "slack",
        },
      ],
      messagingToolSentTexts: ["different message"],
      meta: {},
      payloads: [{ text: "hello world!" }],
    });

    const result = await createRun("slack");

    expect(result).toMatchObject({ text: "hello world!" });
  });
});

describe("runReplyAgent reminder commitment guard", () => {
  function createRun(params?: { sessionKey?: string; omitSessionKey?: boolean }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "chat",
      Provider: "telegram",
      Surface: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "telegram",
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

    return runReplyAgent({
      commandBody: "hello",
      followupRun,
      queueKey: "main",
      resolvedQueue,
      shouldSteer: false,
      shouldFollowup: false,
      isActive: false,
      isStreaming: false,
      typing,
      sessionCtx,
      ...(params?.omitSessionKey ? {} : { sessionKey: params?.sessionKey ?? "main" }),
      defaultModel: "anthropic/claude-opus-4-6",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });
  }

  it("appends guard note when reminder commitment is not backed by cron.add", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("keeps reminder commitment unchanged when cron.add succeeded", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      successfulCronAdds: 1,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.",
    });
  });

  it("suppresses guard note when session already has an active cron job", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      jobs: [
        {
          createdAtMs: Date.now() - 60_000,
          enabled: true,
          id: "existing-job",
          name: "monitor-task",
          sessionKey: "main",
          updatedAtMs: Date.now() - 60_000,
        },
      ],
      version: 1,
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll ping you when it's done." }],
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll ping you when it's done.",
    });
  });

  it("still appends guard note when cron jobs exist but not for the current session", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      jobs: [
        {
          createdAtMs: Date.now() - 60_000,
          enabled: true,
          id: "unrelated-job",
          name: "daily-news",
          sessionKey: "other-session",
          updatedAtMs: Date.now() - 60_000,
        },
      ],
      version: 1,
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll remind you tomorrow morning." }],
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll remind you tomorrow morning.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when cron jobs for session exist but are disabled", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      jobs: [
        {
          createdAtMs: Date.now() - 60_000,
          enabled: false,
          id: "disabled-job",
          name: "old-monitor",
          sessionKey: "main",
          updatedAtMs: Date.now() - 60_000,
        },
      ],
      version: 1,
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll check back in an hour." }],
      successfulCronAdds: 0,
    });

    const result = await createRun();
    expect(result).toMatchObject({
      text: "I'll check back in an hour.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when sessionKey is missing", async () => {
    loadCronStoreMock.mockResolvedValueOnce({
      jobs: [
        {
          createdAtMs: Date.now() - 60_000,
          enabled: true,
          id: "existing-job",
          name: "monitor-task",
          sessionKey: "main",
          updatedAtMs: Date.now() - 60_000,
        },
      ],
      version: 1,
    });

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll ping you later." }],
      successfulCronAdds: 0,
    });

    const result = await createRun({ omitSessionKey: true });
    expect(result).toMatchObject({
      text: "I'll ping you later.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });

  it("still appends guard note when cron store read fails", async () => {
    loadCronStoreMock.mockRejectedValueOnce(new Error("store read failed"));

    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "I'll remind you after lunch." }],
      successfulCronAdds: 0,
    });

    const result = await createRun({ sessionKey: "main" });
    expect(result).toMatchObject({
      text: "I'll remind you after lunch.\n\nNote: I did not schedule a reminder in this turn, so this will not trigger automatically.",
    });
  });
});

describe("runReplyAgent fallback reasoning tags", () => {
  interface EmbeddedPiAgentParams {
    enforceFinalTag?: boolean;
    prompt?: string;
  }

  function createRun(params?: {
    sessionEntry?: SessionEntry;
    sessionKey?: string;
    agentCfgContextTokens?: number;
  }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "+15550001111",
      Provider: "whatsapp",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const sessionKey = params?.sessionKey ?? "main";
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        agentDir: "/tmp/agent",
        agentId: "main",
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "whatsapp",
        model: "claude",
        provider: "anthropic",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey,
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    return runReplyAgent({
      agentCfgContextTokens: params?.agentCfgContextTokens,
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      sessionEntry: params?.sessionEntry,
      sessionKey,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });
  }

  it("enforces <final> when the fallback provider requires reasoning tags", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {},
      payloads: [{ text: "ok" }],
    });
    runWithModelFallbackMock.mockImplementationOnce(
      async ({ run }: RunWithModelFallbackParams) => ({
        model: "gemini-2.5-pro",
        provider: "google",
        result: await run("google", "gemini-2.5-pro"),
      }),
    );

    await createRun();

    const call = runEmbeddedPiAgentMock.mock.calls[0]?.[0] as EmbeddedPiAgentParams | undefined;
    expect(call?.enforceFinalTag).toBe(true);
  });

  it("enforces <final> during memory flush on fallback providers", async () => {
    registerMemoryFlushPlanResolver(() => ({
      forceFlushTranscriptBytes: 1_000_000_000,
      prompt: "Pre-compaction memory flush.",
      relativePath: "memory/active.md",
      reserveTokensFloor: 20_000,
      softThresholdTokens: 1000,
      systemPrompt: "Flush memory into the configured memory file.",
    }));
    runEmbeddedPiAgentMock.mockImplementation(async (params: EmbeddedPiAgentParams) => {
      if (params.prompt?.includes("Pre-compaction memory flush.")) {
        return { meta: {}, payloads: [] };
      }
      return { meta: {}, payloads: [{ text: "ok" }] };
    });
    runWithModelFallbackMock.mockImplementation(async ({ run }: RunWithModelFallbackParams) => ({
      model: "gemini-3",
      provider: "google-gemini-cli",
      result: await run("google-gemini-cli", "gemini-3"),
    }));

    await createRun({
      sessionEntry: {
        compactionCount: 0,
        sessionId: "session",
        totalTokens: 1_000_000,
        updatedAt: Date.now(),
      },
    });

    const flushCall = runEmbeddedPiAgentMock.mock.calls.find(([params]) =>
      (params as EmbeddedPiAgentParams | undefined)?.prompt?.includes(
        "Pre-compaction memory flush.",
      ),
    )?.[0] as EmbeddedPiAgentParams | undefined;

    expect(flushCall?.enforceFinalTag).toBe(true);
  });
});

describe("runReplyAgent response usage footer", () => {
  function createRun(params: { responseUsage: "tokens" | "full"; sessionKey: string }) {
    const typing = createMockTypingController();
    const sessionCtx = {
      AccountId: "primary",
      MessageSid: "msg",
      OriginatingTo: "+15550001111",
      Provider: "whatsapp",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;

    const sessionEntry: SessionEntry = {
      responseUsage: params.responseUsage,
      sessionId: "session",
      updatedAt: Date.now(),
    };

    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        agentDir: "/tmp/agent",
        agentId: "main",
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "whatsapp",
        model: "claude",
        provider: "anthropic",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session",
        sessionKey: params.sessionKey,
        skillsSnapshot: {},
        thinkLevel: "low",
        timeoutMs: 1000,
        verboseLevel: "off",
        workspaceDir: "/tmp",
      },
      summaryLine: "hello",
    } as unknown as FollowupRun;

    return runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      sessionEntry,
      sessionKey: params.sessionKey,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });
  }

  it("appends session key when responseUsage=full", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {
        agentMeta: {
          model: "claude",
          provider: "anthropic",
          usage: { input: 12, output: 3 },
        },
      },
      payloads: [{ text: "ok" }],
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "full", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).toContain(`· session \`${sessionKey}\``);
  });

  it("does not append session key when responseUsage=tokens", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {
        agentMeta: {
          model: "claude",
          provider: "anthropic",
          usage: { input: 12, output: 3 },
        },
      },
      payloads: [{ text: "ok" }],
    });

    const sessionKey = "agent:main:whatsapp:dm:+1000";
    const res = await createRun({ responseUsage: "tokens", sessionKey });
    const payload = Array.isArray(res) ? res[0] : res;
    expect(String(payload?.text ?? "")).toContain("Usage:");
    expect(String(payload?.text ?? "")).not.toContain("· session ");
  });
});

describe("runReplyAgent transient HTTP retry", () => {
  it("retries once after transient 521 HTML failure and then succeeds", async () => {
    vi.useFakeTimers();
    runEmbeddedPiAgentMock
      .mockRejectedValueOnce(
        new Error(
          `521 <!DOCTYPE html><html lang="en-US"><head><title>Web server is down</title></head><body>Cloudflare</body></html>`,
        ),
      )
      .mockResolvedValueOnce({
        meta: {},
        payloads: [{ text: "Recovered response" }],
      });

    const typing = createMockTypingController();
    const sessionCtx = {
      MessageSid: "msg",
      Provider: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "telegram",
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

    const runPromise = runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude-opus-4-6",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });

    await vi.advanceTimersByTimeAsync(2500);
    const result = await runPromise;

    expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(2);
    expect(runtimeErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("Transient HTTP provider error before reply"),
    );

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("Recovered response");
  });
});

describe("runReplyAgent billing error classification", () => {
  // Regression guard for the runner-level catch block in runAgentTurnWithFallback.
  // Billing errors from providers like OpenRouter can contain token/size wording that
  // Matches context overflow heuristics. This test verifies the final user-visible
  // Message is the billing-specific one, not the "Context overflow" fallback.
  it("returns billing message for mixed-signal error (billing text + overflow patterns)", async () => {
    runEmbeddedPiAgentMock.mockRejectedValueOnce(
      new Error("402 Payment Required: request token limit exceeded for this billing plan"),
    );

    const typing = createMockTypingController();
    const sessionCtx = {
      MessageSid: "msg",
      Provider: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "telegram",
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

    const result = await runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });

    const payload = Array.isArray(result) ? result[0] : result;
    expect(payload?.text).toContain("billing error");
    expect(payload?.text).not.toContain("Context overflow");
  });
});

describe("runReplyAgent mid-turn rate-limit fallback", () => {
  function createRun() {
    const typing = createMockTypingController();
    const sessionCtx = {
      MessageSid: "msg",
      Provider: "telegram",
    } as unknown as TemplateContext;
    const resolvedQueue = { mode: "interrupt" } as unknown as QueueSettings;
    const followupRun = {
      enqueuedAt: Date.now(),
      prompt: "hello",
      run: {
        bashElevated: {
          allowed: false,
          defaultLevel: "off",
          enabled: false,
        },
        blockReplyBreak: "message_end",
        config: createCliBackendTestConfig(),
        elevatedLevel: "off",
        messageProvider: "telegram",
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

    return runReplyAgent({
      blockStreamingEnabled: false,
      commandBody: "hello",
      defaultModel: "anthropic/claude",
      followupRun,
      isActive: false,
      isNewSession: false,
      isStreaming: false,
      queueKey: "main",
      resolvedBlockStreamingBreak: "message_end",
      resolvedQueue,
      resolvedVerboseLevel: "off",
      sessionCtx,
      shouldFollowup: false,
      shouldInjectGroupIntro: false,
      shouldSteer: false,
      typing,
      typingMode: "instant",
    });
  }

  it("surfaces a final error when only reasoning preceded a mid-turn rate limit", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
      payloads: [{ isReasoning: true, text: "reasoning" }],
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload?.text).toContain("API rate limit reached");
  });

  it("preserves successful media-only replies that use legacy mediaUrl", async () => {
    runEmbeddedPiAgentMock.mockResolvedValueOnce({
      meta: {
        error: {
          kind: "retry_limit",
          message: "429 Too Many Requests: rate limit exceeded",
        },
      },
      payloads: [{ mediaUrl: "https://example.test/image.png" }],
    });

    const result = await createRun();
    const payload = Array.isArray(result) ? result[0] : result;

    expect(payload).toMatchObject({
      mediaUrl: "https://example.test/image.png",
    });
    expect(payload?.text).toBeUndefined();
  });
});
