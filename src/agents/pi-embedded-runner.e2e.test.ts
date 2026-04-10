import fs from "node:fs/promises";
import path from "node:path";
import "./test-helpers/fast-coding-tools.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type EmbeddedPiRunnerTestWorkspace,
  buildEmbeddedRunnerAssistant,
  cleanupEmbeddedPiRunnerTestWorkspace,
  createEmbeddedPiRunnerOpenAiConfig,
  createEmbeddedPiRunnerTestWorkspace,
  createMockUsage,
  createResolvedEmbeddedRunnerModel,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/pi-embedded-runner-e2e-fixtures.js";

const runEmbeddedAttemptMock = vi.fn();
const disposeSessionMcpRuntimeMock = vi.fn<(sessionId: string) => Promise<void>>(
  async () => undefined,
);
const resolveSessionKeyForRequestMock = vi.fn();
const resolveStoredSessionKeyForSessionIdMock = vi.fn();
const loggerWarnMock = vi.fn();
let refreshRuntimeAuthOnFirstPromptError = false;

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    api: model.api,
    content: [{ text: "ok", type: "text" as const }],
    model: model.id,
    provider: model.provider,
    role: "assistant" as const,
    stopReason: "stop" as const,
    timestamp: Date.now(),
    usage: createMockUsage(1, 1),
  });

  const buildAssistantErrorMessage = (model: { api: string; provider: string; id: string }) => ({
    api: model.api,
    content: [],
    errorMessage: "boom",
    model: model.id,
    provider: model.provider,
    role: "assistant" as const,
    stopReason: "error" as const,
    timestamp: Date.now(),
    usage: createMockUsage(0, 0),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    completeSimple: async (model: { api: string; provider: string; id: string }) => {
      if (model.id === "mock-error") {
        return buildAssistantErrorMessage(model);
      }
      return buildAssistantMessage(model);
    },
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = actual.createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          message:
            model.id === "mock-error"
              ? buildAssistantErrorMessage(model)
              : buildAssistantMessage(model),
          reason: "stop",
          type: "done",
        });
        stream.end();
      });
      return stream;
    },
  };
});

const installRunEmbeddedMocks = () => {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => undefined),
    getGlobalPluginRegistry: vi.fn(() => null),
    hasGlobalHooks: vi.fn(() => false),
    initializeGlobalHookRunner: vi.fn(),
    resetGlobalHookRunner: vi.fn(),
  }));
  vi.doMock("../context-engine/index.js", () => ({
    ensureContextEnginesInitialized: vi.fn(),
    resolveContextEngine: vi.fn(async () => ({
      dispose: async () => undefined,
    })),
  }));
  vi.doMock("./runtime-plugins.js", () => ({
    ensureRuntimePluginsLoaded: vi.fn(),
  }));
  vi.doMock("./command/session.js", async () => {
    const actual =
      await vi.importActual<typeof import("./command/session.js")>("./command/session.js");
    return {
      ...actual,
      resolveSessionKeyForRequest: (opts: unknown) => resolveSessionKeyForRequestMock(opts),
      resolveStoredSessionKeyForSessionId: (opts: unknown) =>
        resolveStoredSessionKeyForSessionIdMock(opts),
    };
  });
  vi.doMock("./pi-embedded-runner/logger.js", async () => {
    const actual = await vi.importActual<typeof import("./pi-embedded-runner/logger.js")>(
      "./pi-embedded-runner/logger.js",
    );
    return {
      ...actual,
      log: {
        ...actual.log,
        warn: (...args: unknown[]) => loggerWarnMock(...args),
      },
    };
  });
  vi.doMock("./pi-embedded-runner/run/attempt.js", () => ({
    runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
  }));
  vi.doMock("./pi-bundle-mcp-tools.js", () => ({
    disposeSessionMcpRuntime: (sessionId: string) => disposeSessionMcpRuntimeMock(sessionId),
  }));
  vi.doMock("./pi-embedded-runner/model.js", async () => {
    const actual = await vi.importActual<typeof import("./pi-embedded-runner/model.js")>(
      "./pi-embedded-runner/model.js",
    );
    return {
      ...actual,
      resolveModelAsync: async (provider: string, modelId: string) =>
        createResolvedEmbeddedRunnerModel(provider, modelId),
    };
  });
  vi.doMock("./pi-embedded-runner/run/auth-controller.js", () => ({
    createEmbeddedRunAuthController: () => ({
      advanceAuthProfile: vi.fn(async () => false),
      initializeAuthProfile: vi.fn(async () => undefined),
      maybeRefreshRuntimeAuthForAuthError: vi.fn(
        async (_errorText: string, runtimeAuthRetry) =>
          refreshRuntimeAuthOnFirstPromptError && runtimeAuthRetry !== true,
      ),
      stopRuntimeAuthRefreshTimer: vi.fn(),
    }),
  }));
  vi.doMock("../plugins/provider-runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
      "../plugins/provider-runtime.js",
    );
    return {
      ...actual,
      prepareProviderRuntimeAuth: vi.fn(async () => undefined),
    };
  });
  vi.doMock("./models-config.js", async () => {
    const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...mod,
      ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
    };
  });
};

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
let e2eWorkspace: EmbeddedPiRunnerTestWorkspace | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;
let runCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({ SessionManager } = await import("@mariozechner/pi-coding-agent"));
  e2eWorkspace = await createEmbeddedPiRunnerTestWorkspace("openclaw-embedded-agent-");
  ({ agentDir, workspaceDir } = e2eWorkspace);
}, 180_000);

afterAll(async () => {
  await cleanupEmbeddedPiRunnerTestWorkspace(e2eWorkspace);
  e2eWorkspace = undefined;
});

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  disposeSessionMcpRuntimeMock.mockReset();
  resolveSessionKeyForRequestMock.mockReset();
  resolveStoredSessionKeyForSessionIdMock.mockReset();
  loggerWarnMock.mockReset();
  refreshRuntimeAuthOnFirstPromptError = false;
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
});

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};
const nextRunId = (prefix = "run-embedded-test") => `${prefix}-${++runCounter}`;
const nextSessionKey = () => `agent:test:embedded:${nextRunId("session-key")}`;

const runWithOrphanedSingleUserMessage = async (text: string, sessionKey: string) => {
  const sessionFile = nextSessionFile();
  const sessionManager = SessionManager.open(sessionFile);
  sessionManager.appendMessage({
    content: [{ text, type: "text" }],
    role: "user",
    timestamp: Date.now(),
  });

  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ text: "ok", type: "text" }],
      }),
    }),
  );

  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
  return await runEmbeddedPiAgent({
    agentDir,
    config: cfg,
    enqueue: immediateEnqueue,
    model: "mock-1",
    prompt: "hello",
    provider: "openai",
    runId: nextRunId("orphaned-user"),
    sessionFile,
    sessionId: "session:test",
    sessionKey,
    timeoutMs: 5000,
    workspaceDir,
  });
};

const textFromContent = (content: unknown) => {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content) && content[0]?.type === "text") {
    return (content[0] as { text?: string }).text;
  }
  return undefined;
};

const readSessionEntries = async (sessionFile: string) => {
  const raw = await fs.readFile(sessionFile, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; customType?: string; data?: unknown });
};

const readSessionMessages = async (sessionFile: string) => {
  const entries = await readSessionEntries(sessionFile);
  return entries
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message?: { role?: string; content?: unknown } }).message) as {
    role?: string;
    content?: unknown;
  }[];
};

const runDefaultEmbeddedTurn = async (sessionFile: string, prompt: string, sessionKey: string) => {
  const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeEmbeddedRunnerAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildEmbeddedRunnerAssistant({
        content: [{ text: "ok", type: "text" }],
      }),
    }),
  );
  await runEmbeddedPiAgent({
    agentDir,
    config: cfg,
    enqueue: immediateEnqueue,
    model: "mock-error",
    prompt,
    provider: "openai",
    runId: nextRunId("default-turn"),
    sessionFile,
    sessionId: "session:test",
    sessionKey,
    timeoutMs: 5000,
    workspaceDir,
  });
};

describe("runEmbeddedPiAgent", () => {
  it("backfills a trimmed session key from sessionId when the embedded run omits it", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: "agent:test:resolved",
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ text: "ok", type: "text" }],
        }),
      }),
    );

    await runEmbeddedPiAgent({
      agentDir,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("backfill"),
      sessionFile,
      sessionId: "resume-123",
      sessionKey: "   ",
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      agentId: undefined,
      cfg,
      sessionId: "resume-123",
    });
    const firstCall = runEmbeddedAttemptMock.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(firstCall.sessionKey).toBe("agent:test:resolved");
  });

  it("drops whitespace-only session keys when backfill cannot resolve a session key", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockReturnValue({
      sessionKey: undefined,
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ text: "ok", type: "text" }],
        }),
      }),
    );

    await runEmbeddedPiAgent({
      agentDir,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("backfill-empty"),
      sessionFile,
      sessionId: "resume-124",
      sessionKey: "   ",
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(resolveSessionKeyForRequestMock).toHaveBeenCalledWith({
      agentId: undefined,
      cfg,
      sessionId: "resume-124",
    });
    const firstCall = runEmbeddedAttemptMock.mock.calls[0]?.[0] as { sessionKey?: string };
    expect(firstCall.sessionKey).toBeUndefined();
  });

  it("logs when embedded session-key backfill resolution fails", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    resolveSessionKeyForRequestMock.mockImplementation(() => {
      throw new Error("resolver exploded");
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ text: "ok", type: "text" }],
        }),
      }),
    );

    await runEmbeddedPiAgent({
      agentDir,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("backfill-warn"),
      sessionFile,
      sessionId: "resume-456",
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(
      loggerWarnMock.mock.calls.some(([message]) =>
        String(message ?? "").includes("[backfillSessionKey] Failed to resolve sessionKey"),
      ),
    ).toBe(true);
  });

  it("passes the current agentId when backfilling a session key", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    resolveStoredSessionKeyForSessionIdMock.mockReturnValue({
      sessionKey: "agent:test:resolved",
      sessionStore: {},
      storePath: "/tmp/session-store.json",
    });
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ text: "ok", type: "text" }],
        }),
      }),
    );

    await runEmbeddedPiAgent({
      agentDir,
      agentId: "embedded-agent",
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("backfill-agent-scope"),
      sessionFile,
      sessionId: "resume-agent-1",
      sessionKey: undefined,
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(resolveStoredSessionKeyForSessionIdMock).toHaveBeenCalledWith({
      agentId: "embedded-agent",
      cfg,
      sessionId: "resume-agent-1",
    });
    expect(resolveSessionKeyForRequestMock).not.toHaveBeenCalled();
  });

  it("disposes bundle MCP once when a one-shot local run completes", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildEmbeddedRunnerAssistant({
          content: [{ text: "ok", type: "text" }],
        }),
      }),
    );

    await runEmbeddedPiAgent({
      agentDir,
      cleanupBundleMcpOnRunEnd: true,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("bundle-mcp-run-cleanup"),
      sessionFile,
      sessionId: "session:test",
      sessionKey,
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("preserves bundle MCP state across retries within one local run", async () => {
    refreshRuntimeAuthOnFirstPromptError = true;
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-1"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          promptError: new Error("401 unauthorized"),
        });
      })
      .mockImplementationOnce(async () => {
        expect(disposeSessionMcpRuntimeMock).not.toHaveBeenCalled();
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [{ text: "ok", type: "text" }],
          }),
        });
      });

    const result = await runEmbeddedPiAgent({
      agentDir,
      cleanupBundleMcpOnRunEnd: true,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: nextRunId("bundle-mcp-retry"),
      sessionFile,
      sessionId: "session:test",
      sessionKey,
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ text: "ok" });
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledTimes(1);
    expect(disposeSessionMcpRuntimeMock).toHaveBeenCalledWith("session:test");
  });

  it("retries a planning-only GPT turn once with an act-now steer", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["gpt-5.4"]);
    const sessionKey = nextSessionKey();

    runEmbeddedAttemptMock
      .mockImplementationOnce(async (params: unknown) => {
        expect((params as { prompt?: string }).prompt).toMatch(/^ship it(?:\n\n|$)/);
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["I'll inspect the files, make the change, and run the checks."],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [
              {
                text: "I'll inspect the files, make the change, and run the checks.",
                type: "text",
              },
            ],
            model: "gpt-5.4",
          }),
        });
      })
      .mockImplementationOnce(async (params: unknown) => {
        expect((params as { prompt?: string }).prompt).toContain(
          "Do not restate the plan. Act now",
        );
        return makeEmbeddedRunnerAttempt({
          assistantTexts: ["done"],
          lastAssistant: buildEmbeddedRunnerAssistant({
            content: [{ text: "done", type: "text" }],
            model: "gpt-5.4",
          }),
        });
      });

    const result = await runEmbeddedPiAgent({
      agentDir,
      config: cfg,
      enqueue: immediateEnqueue,
      model: "gpt-5.4",
      prompt: "ship it",
      provider: "openai",
      runId: nextRunId("planning-only-retry"),
      sessionFile,
      sessionId: "session:test",
      sessionKey,
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]).toMatchObject({ text: "done" });
  });

  it("handles prompt error paths without dropping user state", async () => {
    const sessionFile = nextSessionFile();
    const cfg = createEmbeddedPiRunnerOpenAiConfig(["mock-error"]);
    const sessionKey = nextSessionKey();
    runEmbeddedAttemptMock.mockResolvedValueOnce(
      makeEmbeddedRunnerAttempt({
        promptError: new Error("boom"),
      }),
    );
    await expect(
      runEmbeddedPiAgent({
        agentDir,
        config: cfg,
        enqueue: immediateEnqueue,
        model: "mock-error",
        prompt: "boom",
        provider: "openai",
        runId: nextRunId("prompt-error"),
        sessionFile,
        sessionId: "session:test",
        sessionKey,
        timeoutMs: 5000,
        workspaceDir,
      }),
    ).rejects.toThrow("boom");

    try {
      const messages = await readSessionMessages(sessionFile);
      const userIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "boom",
      );
      expect(userIndex).toBeGreaterThanOrEqual(0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        throw error;
      }
    }
  });

  it(
    "preserves existing transcript entries across an additional turn",
    { timeout: 7000 },
    async () => {
      const sessionFile = nextSessionFile();
      const sessionKey = nextSessionKey();

      const sessionManager = SessionManager.open(sessionFile);
      sessionManager.appendMessage({
        content: [{ text: "seed user", type: "text" }],
        role: "user",
        timestamp: Date.now(),
      });
      sessionManager.appendMessage({
        api: "openai-responses",
        content: [{ text: "seed assistant", type: "text" }],
        model: "mock-1",
        provider: "openai",
        role: "assistant",
        stopReason: "stop",
        timestamp: Date.now(),
        usage: createMockUsage(1, 1),
      });

      await runDefaultEmbeddedTurn(sessionFile, "hello", sessionKey);

      const messages = await readSessionMessages(sessionFile);
      const seedUserIndex = messages.findIndex(
        (message) => message?.role === "user" && textFromContent(message.content) === "seed user",
      );
      const seedAssistantIndex = messages.findIndex(
        (message) =>
          message?.role === "assistant" && textFromContent(message.content) === "seed assistant",
      );
      expect(seedUserIndex).toBeGreaterThanOrEqual(0);
      expect(seedAssistantIndex).toBeGreaterThan(seedUserIndex);
      expect(messages.length).toBeGreaterThanOrEqual(2);
    },
  );

  it("repairs orphaned user messages and continues", async () => {
    const result = await runWithOrphanedSingleUserMessage("orphaned user", nextSessionKey());

    expect(result.meta.error).toBeUndefined();
    expect(result.payloads?.length ?? 0).toBeGreaterThan(0);
  });
});
