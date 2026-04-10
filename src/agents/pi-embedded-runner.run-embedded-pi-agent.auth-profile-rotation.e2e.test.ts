import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import type { AuthProfileFailureReason } from "./auth-profiles.js";
import { buildAttemptReplayMetadata } from "./pi-embedded-runner/run/incomplete-turn.js";
import type { EmbeddedRunAttemptResult } from "./pi-embedded-runner/run/types.js";

const runEmbeddedAttemptMock = vi.fn<(params: unknown) => Promise<EmbeddedRunAttemptResult>>();
const resolveCopilotApiTokenMock = vi.fn();
const { computeBackoffMock, sleepWithAbortMock } = vi.hoisted(() => ({
  computeBackoffMock: vi.fn(
    (
      _policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      _attempt: number,
    ) => 321,
  ),
  sleepWithAbortMock: vi.fn(async (_ms: number, _abortSignal?: AbortSignal) => undefined),
}));

const installRunEmbeddedMocks = () => {
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: vi.fn(() => undefined),
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
  vi.doMock("./pi-embedded-runner/model.js", () => ({
    resolveModelAsync: async (provider: string, modelId: string) => ({
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      error: undefined,
      model: {
        api: "openai-responses",
        baseUrl:
          provider === "github-copilot" ? "https://api.copilot.example" : "https://example.com",
        contextWindow: 16_000,
        cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
        id: modelId,
        input: ["text"],
        maxTokens: 2048,
        name: modelId,
        provider,
        reasoning: false,
      },
      modelRegistry: {},
    }),
  }));
  vi.doMock("./pi-embedded-runner/run/attempt.js", () => ({
    runEmbeddedAttempt: (params: unknown) => runEmbeddedAttemptMock(params),
  }));
  vi.doMock("../plugins/provider-runtime.js", async () => {
    const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
      "../plugins/provider-runtime.js",
    );
    return {
      ...actual,
      prepareProviderRuntimeAuth: async (params: {
        provider: string;
        context: { apiKey: string };
      }) => {
        if (params.provider !== "github-copilot") {
          return undefined;
        }
        const token = await resolveCopilotApiTokenMock(params.context.apiKey);
        return {
          apiKey: token.token,
          baseUrl: token.baseUrl,
          expiresAt: token.expiresAt,
        };
      },
      resolveProviderCapabilitiesWithPlugin: vi.fn(() => undefined),
    };
  });
  vi.doMock("../infra/backoff.js", () => ({
    computeBackoff: (
      policy: { initialMs: number; maxMs: number; factor: number; jitter: number },
      attempt: number,
    ) => computeBackoffMock(policy, attempt),
    sleepWithAbort: (ms: number, abortSignal?: AbortSignal) => sleepWithAbortMock(ms, abortSignal),
  }));
  vi.doMock("./pi-embedded-runner/compact.js", () => ({
    compactEmbeddedPiSessionDirect: vi.fn(async () => {
      throw new Error("compact should not run in auth profile rotation tests");
    }),
  }));
  vi.doMock("./models-config.js", async () => {
    const mod = await vi.importActual<typeof import("./models-config.js")>("./models-config.js");
    return {
      ...mod,
      ensureOpenClawModelsJson: vi.fn(async () => ({ wrote: false })),
    };
  });
};

let runEmbeddedPiAgent: typeof import("./pi-embedded-runner/run.js").runEmbeddedPiAgent;
let unregisterLogTransport: (() => void) | undefined;
let registerLogTransportFn: typeof import("../logging/logger.js").registerLogTransport;
let resetLoggerFn: typeof import("../logging/logger.js").resetLogger;
let setLoggerOverrideFn: typeof import("../logging/logger.js").setLoggerOverride;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  vi.resetModules();
  installRunEmbeddedMocks();
  ({ runEmbeddedPiAgent } = await import("./pi-embedded-runner/run.js"));
  ({
    registerLogTransport: registerLogTransportFn,
    resetLogger: resetLoggerFn,
    setLoggerOverride: setLoggerOverrideFn,
  } = await import("../logging/logger.js"));
});

async function runEmbeddedPiAgentInline(
  params: Parameters<typeof runEmbeddedPiAgent>[0],
): Promise<Awaited<ReturnType<typeof runEmbeddedPiAgent>>> {
  return await runEmbeddedPiAgent({
    ...params,
    enqueue: async (task) => await task(),
  });
}

beforeEach(() => {
  vi.useRealTimers();
  runEmbeddedAttemptMock.mockReset();
  runEmbeddedAttemptMock.mockImplementation(async () => {
    throw new Error("unexpected extra runEmbeddedAttempt call");
  });
  resolveCopilotApiTokenMock.mockReset();
  resolveCopilotApiTokenMock.mockImplementation(async () => {
    throw new Error("unexpected extra Copilot token refresh");
  });
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as unknown as typeof fetch;
  computeBackoffMock.mockClear();
  sleepWithAbortMock.mockClear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  unregisterLogTransport?.();
  unregisterLogTransport = undefined;
  setLoggerOverrideFn(null);
  resetLoggerFn();
});

const baseUsage = {
  cacheRead: 0,
  cacheWrite: 0,
  cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
  input: 0,
  output: 0,
  totalTokens: 0,
};

const buildAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
  api: "openai-responses",
  content: [],
  model: "mock-1",
  provider: "openai",
  role: "assistant",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: baseUsage,
  ...overrides,
});

const makeAttempt = (overrides: Partial<EmbeddedRunAttemptResult>): EmbeddedRunAttemptResult => {
  const toolMetas = overrides.toolMetas ?? [];
  const didSendViaMessagingTool = overrides.didSendViaMessagingTool ?? false;
  const {successfulCronAdds} = overrides;
  return {
    aborted: false,
    assistantTexts: [],
    cloudCodeAssistFormatError: false,
    didSendViaMessagingTool,
    idleTimedOut: false,
    itemLifecycle: { activeCount: 0, completedCount: 0, startedCount: 0 },
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
    sessionIdUsed: "session:test",
    systemPromptReport: undefined,
    timedOut: false,
    timedOutDuringCompaction: false,
    toolMetas,
    ...overrides,
  };
};

const makeConfig = (opts?: {
  fallbacks?: string[];
  apiKey?: string;
  overloadedBackoffMs?: number;
  overloadedProfileRotations?: number;
}): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        model: {
          fallbacks: opts?.fallbacks ?? [],
        },
      },
    },
    auth:
      opts?.overloadedBackoffMs != null || opts?.overloadedProfileRotations != null
        ? {
            cooldowns: {
              ...(opts?.overloadedBackoffMs != null
                ? { overloadedBackoffMs: opts.overloadedBackoffMs }
                : {}),
              ...(opts?.overloadedProfileRotations != null
                ? { overloadedProfileRotations: opts.overloadedProfileRotations }
                : {}),
            },
          }
        : undefined,
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: opts?.apiKey ?? "sk-test",
          baseUrl: "https://example.com",
          models: [
            {
              contextWindow: 16_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "mock-1",
              input: ["text"],
              maxTokens: 2048,
              name: "Mock 1",
              reasoning: false,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const makeAgentOverrideOnlyFallbackConfig = (agentId: string): OpenClawConfig =>
  ({
    agents: {
      defaults: {
        model: {
          fallbacks: [],
        },
      },
      list: [
        {
          id: agentId,
          model: {
            fallbacks: ["openai/mock-2"],
          },
        },
      ],
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test", // Pragma: allowlist secret
          baseUrl: "https://example.com",
          models: [
            {
              contextWindow: 16_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: "mock-1",
              input: ["text"],
              maxTokens: 2048,
              name: "Mock 1",
              reasoning: false,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const copilotModelId = "gpt-4o";

const makeCopilotConfig = (): OpenClawConfig =>
  ({
    models: {
      providers: {
        "github-copilot": {
          api: "openai-responses",
          baseUrl: "https://api.copilot.example",
          models: [
            {
              contextWindow: 16_000,
              cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
              id: copilotModelId,
              input: ["text"],
              maxTokens: 2048,
              name: "Copilot GPT-4o",
              reasoning: false,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;

const writeAuthStore = async (
  agentDir: string,
  opts?: {
    includeAnthropic?: boolean;
    order?: Record<string, string[]>;
    usageStats?: Record<
      string,
      {
        lastUsed?: number;
        cooldownUntil?: number;
        disabledUntil?: number;
        disabledReason?: AuthProfileFailureReason;
        failureCounts?: Partial<Record<AuthProfileFailureReason, number>>;
      }
    >;
  },
) => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const statePath = path.join(agentDir, "auth-state.json");
  const authPayload = {
    profiles: {
      "openai:p1": { key: "sk-one", provider: "openai", type: "api_key" },
      "openai:p2": { key: "sk-two", provider: "openai", type: "api_key" },
      ...(opts?.includeAnthropic
        ? { "anthropic:default": { key: "sk-anth", provider: "anthropic", type: "api_key" } }
        : {}),
    },
    version: 1,
  };
  const statePayload = {
    version: 1,
    ...(opts?.order ? { order: opts.order } : {}),
    usageStats:
      opts?.usageStats ??
      ({
        "openai:p1": { lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      } as Record<string, { lastUsed?: number }>),
  };
  await fs.writeFile(authPath, JSON.stringify(authPayload));
  await fs.writeFile(statePath, JSON.stringify(statePayload));
};

const writeCopilotAuthStore = async (agentDir: string, token = "gh-token") => {
  const authPath = path.join(agentDir, "auth-profiles.json");
  const payload = {
    profiles: {
      "github-copilot:github": { provider: "github-copilot", token, type: "token" },
    },
    version: 1,
  };
  await fs.writeFile(authPath, JSON.stringify(payload));
};

const buildCopilotAssistant = (overrides: Partial<AssistantMessage> = {}) =>
  buildAssistant({ model: copilotModelId, provider: "github-copilot", ...overrides });

const mockFailedThenSuccessfulAttempt = (errorMessage = "rate limit") => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: [],
        lastAssistant: buildAssistant({
          errorMessage,
          stopReason: "error",
        }),
      }),
    )
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildAssistant({
          content: [{ text: "ok", type: "text" }],
          stopReason: "stop",
        }),
      }),
    );
};

const mockPromptErrorThenSuccessfulAttempt = (errorMessage: string) => {
  runEmbeddedAttemptMock
    .mockResolvedValueOnce(
      makeAttempt({
        promptError: new Error(errorMessage),
      }),
    )
    .mockResolvedValueOnce(
      makeAttempt({
        assistantTexts: ["ok"],
        lastAssistant: buildAssistant({
          content: [{ text: "ok", type: "text" }],
          stopReason: "stop",
        }),
      }),
    );
};

async function runAutoPinnedOpenAiTurn(params: {
  agentDir: string;
  workspaceDir: string;
  sessionKey: string;
  runId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
}) {
  await runEmbeddedPiAgentInline({
    agentDir: params.agentDir,
    authProfileId: params.authProfileId ?? "openai:p1",
    authProfileIdSource: "auto",
    config: params.config ?? makeConfig(),
    model: "mock-1",
    prompt: "hello",
    provider: "openai",
    runId: params.runId,
    sessionFile: path.join(params.workspaceDir, "session.jsonl"),
    sessionId: "session:test",
    sessionKey: params.sessionKey,
    timeoutMs: 5000,
    workspaceDir: params.workspaceDir,
  });
}

async function readUsageStats(agentDir: string) {
  const stored = JSON.parse(await fs.readFile(path.join(agentDir, "auth-state.json"), "utf8")) as {
    usageStats?: Record<
      string,
      {
        lastUsed?: number;
        cooldownUntil?: number;
        disabledUntil?: number;
        disabledReason?: AuthProfileFailureReason;
      }
    >;
  };
  return stored.usageStats ?? {};
}

async function expectProfileP2UsageUnchanged(agentDir: string) {
  const usageStats = await readUsageStats(agentDir);
  expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
}

async function runAutoPinnedRotationCase(params: {
  errorMessage: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
}) {
  runEmbeddedAttemptMock.mockReset();
  return withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
    await writeAuthStore(agentDir);
    mockFailedThenSuccessfulAttempt(params.errorMessage);
    await runAutoPinnedOpenAiTurn({
      agentDir,
      config: params.config,
      runId: params.runId,
      sessionKey: params.sessionKey,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    const usageStats = await readUsageStats(agentDir);
    return { usageStats };
  });
}

async function runAutoPinnedPromptErrorRotationCase(params: {
  errorMessage: string;
  sessionKey: string;
  runId: string;
  config?: OpenClawConfig;
}) {
  runEmbeddedAttemptMock.mockReset();
  return withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
    await writeAuthStore(agentDir);
    mockPromptErrorThenSuccessfulAttempt(params.errorMessage);
    await runAutoPinnedOpenAiTurn({
      agentDir,
      config: params.config,
      runId: params.runId,
      sessionKey: params.sessionKey,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
    const usageStats = await readUsageStats(agentDir);
    return { usageStats };
  });
}

function mockSingleSuccessfulAttempt() {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: ["ok"],
      lastAssistant: buildAssistant({
        content: [{ text: "ok", type: "text" }],
        stopReason: "stop",
      }),
    }),
  );
}

function mockSingleErrorAttempt(params: {
  errorMessage: string;
  provider?: string;
  model?: string;
}) {
  runEmbeddedAttemptMock.mockResolvedValueOnce(
    makeAttempt({
      assistantTexts: [],
      lastAssistant: buildAssistant({
        errorMessage: params.errorMessage,
        stopReason: "error",
        ...(params.provider ? { provider: params.provider } : {}),
        ...(params.model ? { model: params.model } : {}),
      }),
    }),
  );
}

async function withTimedAgentWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string; now: number }) => Promise<T>,
) {
  vi.useFakeTimers();
  try {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    const now = Date.now();
    vi.setSystemTime(now);

    try {
      return await run({ agentDir, now, workspaceDir });
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  } finally {
    vi.useRealTimers();
  }
}

async function withAgentWorkspace<T>(
  run: (ctx: { agentDir: string; workspaceDir: string }) => Promise<T>,
) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
  try {
    return await run({ agentDir, workspaceDir });
  } finally {
    await fs.rm(agentDir, { force: true, recursive: true });
    await fs.rm(workspaceDir, { force: true, recursive: true });
  }
}

async function runTurnWithCooldownSeed(params: {
  sessionKey: string;
  runId: string;
  authProfileId: string | undefined;
  authProfileIdSource: "auto" | "user";
}) {
  return await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
    await writeAuthStore(agentDir, {
      usageStats: {
        "openai:p1": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 1 },
        "openai:p2": { lastUsed: 2 },
      },
    });
    mockSingleSuccessfulAttempt();

    await runEmbeddedPiAgentInline({
      agentDir,
      authProfileId: params.authProfileId,
      authProfileIdSource: params.authProfileIdSource,
      config: makeConfig(),
      model: "mock-1",
      prompt: "hello",
      provider: "openai",
      runId: params.runId,
      sessionFile: path.join(workspaceDir, "session.jsonl"),
      sessionId: "session:test",
      sessionKey: params.sessionKey,
      timeoutMs: 5000,
      workspaceDir,
    });

    expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    return { now, usageStats: await readUsageStats(agentDir) };
  });
}

describe("runEmbeddedPiAgent auth profile rotation", () => {
  it("refreshes copilot token after auth error and retries once", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();

      resolveCopilotApiTokenMock
        .mockResolvedValueOnce({
          token: "copilot-initial",
          // Keep expiry beyond the runtime refresh margin so the test only
          // Exercises auth-error refresh, not the background scheduler.
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          baseUrl: "https://api.copilot.example",
          expiresAt: now + 60 * 60 * 1000,
          source: "mock",
          token: "copilot-refresh",
        });

      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              errorMessage: "unauthorized",
              stopReason: "error",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["ok"],
            lastAssistant: buildCopilotAssistant({
              content: [{ text: "ok", type: "text" }],
              stopReason: "stop",
            }),
          }),
        );

      await runEmbeddedPiAgentInline({
        agentDir,
        authProfileIdSource: "auto",
        config: makeCopilotConfig(),
        model: copilotModelId,
        prompt: "hello",
        provider: "github-copilot",
        runId: "run:copilot-auth-error",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-auth-error",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("allows another auth refresh after a successful retry", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();

      resolveCopilotApiTokenMock
        .mockResolvedValueOnce({
          token: "copilot-initial",
          // Avoid an immediate scheduled refresh racing the explicit auth retry.
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        })
        .mockResolvedValueOnce({
          baseUrl: "https://api.copilot.example",
          expiresAt: now + 10 * 60 * 1000,
          source: "mock",
          token: "copilot-refresh-1",
        })
        .mockResolvedValueOnce({
          baseUrl: "https://api.copilot.example",
          expiresAt: now + 40 * 60 * 1000,
          source: "mock",
          token: "copilot-refresh-2",
        });

      runEmbeddedAttemptMock
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              errorMessage: "401 unauthorized",
              stopReason: "error",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            promptError: new Error("supported values are: low, medium"),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: [],
            lastAssistant: buildCopilotAssistant({
              errorMessage: "token has expired",
              stopReason: "error",
            }),
          }),
        )
        .mockResolvedValueOnce(
          makeAttempt({
            assistantTexts: ["ok"],
            lastAssistant: buildCopilotAssistant({
              content: [{ text: "ok", type: "text" }],
              stopReason: "stop",
            }),
          }),
        );

      await runEmbeddedPiAgentInline({
        agentDir,
        authProfileIdSource: "auto",
        config: makeCopilotConfig(),
        model: copilotModelId,
        prompt: "hello",
        provider: "github-copilot",
        runId: "run:copilot-auth-repeat",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-auth-repeat",
        timeoutMs: 5000,
        workspaceDir,
      });
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(4);
      expect(resolveCopilotApiTokenMock).toHaveBeenCalledTimes(3);
    } finally {
      await fs.rm(agentDir, { force: true, recursive: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("does not reschedule copilot refresh after shutdown", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-"));
    vi.useFakeTimers();
    try {
      await writeCopilotAuthStore(agentDir);
      const now = Date.now();
      vi.setSystemTime(now);

      resolveCopilotApiTokenMock.mockResolvedValue({
        baseUrl: "https://api.copilot.example",
        expiresAt: now + 60 * 60 * 1000,
        source: "mock",
        token: "copilot-initial",
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildCopilotAssistant({
            content: [{ text: "ok", type: "text" }],
            stopReason: "stop",
          }),
        }),
      );

      const runPromise = runEmbeddedPiAgentInline({
        agentDir,
        authProfileIdSource: "auto",
        config: makeCopilotConfig(),
        model: copilotModelId,
        prompt: "hello",
        provider: "github-copilot",
        runId: "run:copilot-shutdown",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:copilot-shutdown",
        timeoutMs: 5000,
        workspaceDir,
      });

      await vi.advanceTimersByTimeAsync(1);
      await runPromise;
      const refreshCalls = resolveCopilotApiTokenMock.mock.calls.length;

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

      expect(resolveCopilotApiTokenMock.mock.calls.length).toBe(refreshCalls);
    } finally {
      vi.useRealTimers();
      await fs.rm(agentDir, { force: true, recursive: true });
      await fs.rm(workspaceDir, { force: true, recursive: true });
    }
  });

  it("rotates for auto-pinned profiles across retryable stream failures", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "rate limit",
      runId: "run:auto",
      sessionKey: "agent:test:auto",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
  });

  it("rotates for overloaded assistant failures across auto-pinned profiles", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      runId: "run:overloaded-rotation",
      sessionKey: "agent:test:overloaded-rotation",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("logs structured failover decision metadata for overloaded assistant rotation", async () => {
    const records: Record<string, unknown>[] = [];
    setLoggerOverrideFn({
      consoleLevel: "silent",
      file: path.join(os.tmpdir(), `openclaw-auth-rotation-${Date.now()}.log`),
      level: "trace",
    });
    unregisterLogTransport = registerLogTransportFn((record) => {
      records.push(record);
    });

    await runAutoPinnedRotationCase({
      errorMessage:
        '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_overload"}',
      runId: "run:overloaded-logging",
      sessionKey: "agent:test:overloaded-logging",
    });

    const decisionRecord = records.find(
      (record) =>
        record["2"] === "embedded run failover decision" &&
        record["1"] &&
        typeof record["1"] === "object" &&
        (record["1"] as Record<string, unknown>).decision === "rotate_profile",
    );

    expect(decisionRecord).toBeDefined();
    const safeProfileId = redactIdentifier("openai:p1", { len: 12 });
    expect((decisionRecord as Record<string, unknown>)["1"]).toMatchObject({
      decision: "rotate_profile",
      event: "embedded_run_failover_decision",
      failoverReason: "overloaded",
      profileId: safeProfileId,
      providerErrorType: "overloaded_error",
      rawErrorPreview: expect.stringContaining('"request_id":"sha256:'),
      runId: "run:overloaded-logging",
    });

    const stateRecord = records.find(
      (record) =>
        record["2"] === "auth profile failure state updated" &&
        record["1"] &&
        typeof record["1"] === "object" &&
        (record["1"] as Record<string, unknown>).profileId === safeProfileId,
    );

    expect(stateRecord).toBeDefined();
    expect((stateRecord as Record<string, unknown>)["1"]).toMatchObject({
      event: "auth_profile_failure_state_updated",
      profileId: safeProfileId,
      reason: "overloaded",
      runId: "run:overloaded-logging",
    });
  });

  it("rotates for overloaded prompt failures across auto-pinned profiles", async () => {
    const { usageStats } = await runAutoPinnedPromptErrorRotationCase({
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      runId: "run:overloaded-prompt-rotation",
      sessionKey: "agent:test:overloaded-prompt-rotation",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(typeof usageStats["openai:p1"]?.cooldownUntil).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("uses configured overload backoff before rotating profiles", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      config: makeConfig({ overloadedBackoffMs: 321 }),
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      runId: "run:overloaded-configured-backoff",
      sessionKey: "agent:test:overloaded-configured-backoff",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(321, undefined);
  });

  it("rotates on timeout without cooling down the timed-out profile", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "request ended without sending any chunks",
      runId: "run:timeout-no-cooldown",
      sessionKey: "agent:test:timeout-no-cooldown",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(computeBackoffMock).not.toHaveBeenCalled();
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("rotates on bare service unavailable without cooling down the profile", async () => {
    const { usageStats } = await runAutoPinnedRotationCase({
      errorMessage: "LLM error: service unavailable",
      runId: "run:service-unavailable-no-cooldown",
      sessionKey: "agent:test:service-unavailable-no-cooldown",
    });
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
  });

  it("does not rotate for compaction timeouts", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          aborted: true,
          assistantTexts: ["partial"],
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "partial" }],
            stopReason: "stop",
          }),
          timedOut: true,
          timedOutDuringCompaction: true,
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        agentDir,
        authProfileId: "openai:p1",
        authProfileIdSource: "auto",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:compaction-timeout",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:compaction-timeout",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.meta.aborted).toBe(true);

      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("does not rotate when failover-looking prompt errors came from compaction wait", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["partial"],
          lastAssistant: buildAssistant({
            content: [{ type: "text", text: "partial" }],
            stopReason: "stop",
          }),
          promptError: new Error("rate limit exceeded"),
          promptErrorSource: "compaction",
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        agentDir,
        authProfileId: "openai:p1",
        authProfileIdSource: "auto",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:compaction-wait-abort",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:compaction-wait-abort",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text).toContain("partial");
      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("does not rotate for user-pinned profiles", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);

      mockSingleErrorAttempt({ errorMessage: "rate limit" });

      await runEmbeddedPiAgentInline({
        agentDir,
        authProfileId: "openai:p1",
        authProfileIdSource: "user",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:user",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:user",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      await expectProfileP2UsageUnchanged(agentDir);
    });
  });

  it("honors user-pinned profiles even when in cooldown", async () => {
    const { usageStats } = await runTurnWithCooldownSeed({
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
      runId: "run:user-cooldown",
      sessionKey: "agent:test:user-cooldown",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBeUndefined();
    expect(usageStats["openai:p1"]?.lastUsed).not.toBe(1);
    expect(usageStats["openai:p2"]?.lastUsed).toBe(2);
  });

  it("honors user-pinned profiles even when stored order excludes them", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir, {
        order: {
          openai: ["openai:p1"],
        },
      });
      mockSingleSuccessfulAttempt();

      await runEmbeddedPiAgentInline({
        agentDir,
        authProfileId: "openai:p2",
        authProfileIdSource: "user",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:user-order-excluded",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:user-order-excluded",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      const usageStats = await readUsageStats(agentDir);
      expect(usageStats["openai:p1"]?.lastUsed).toBe(1);
      expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p2"]?.lastUsed).not.toBe(2);
    });
  });

  it("ignores user-locked profile when provider mismatches", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir, { includeAnthropic: true });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            content: [{ text: "ok", type: "text" }],
            stopReason: "stop",
          }),
        }),
      );

      await runEmbeddedPiAgentInline({
        agentDir,
        authProfileId: "anthropic:default",
        authProfileIdSource: "user",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:mismatch",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:mismatch",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips profiles in cooldown during initial selection", async () => {
    const { usageStats, now } = await runTurnWithCooldownSeed({
      authProfileId: undefined,
      authProfileIdSource: "auto",
      runId: "run:skip-cooldown",
      sessionKey: "agent:test:skip-cooldown",
    });

    expect(usageStats["openai:p1"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    expect(typeof usageStats["openai:p2"]?.lastUsed).toBe("number");
  });

  it("fails over when all profiles are in cooldown and fallbacks are configured", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 1 },
          "openai:p2": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 2 },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          agentDir,
          authProfileIdSource: "auto",
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          model: "mock-1",
          prompt: "hello",
          provider: "openai",
          runId: "run:cooldown-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          sessionId: "session:test",
          sessionKey: "agent:test:cooldown-failover",
          timeoutMs: 5000,
          workspaceDir,
        }),
      ).rejects.toMatchObject({
        model: "mock-1",
        name: "FailoverError",
        provider: "openai",
        reason: "unknown",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("can probe one cooldowned profile when transient cooldown probe is explicitly allowed", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 1 },
          "openai:p2": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 2 },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            content: [{ text: "ok", type: "text" }],
            stopReason: "stop",
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        agentDir,
        allowTransientCooldownProbe: true,
        authProfileIdSource: "auto",
        config: makeConfig({ fallbacks: ["openai/mock-2"] }),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:cooldown-probe",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:cooldown-probe",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("can probe one cooldowned profile when overloaded cooldown is explicitly probeable", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            cooldownUntil: now + 60 * 60 * 1000,
            failureCounts: { overloaded: 4 },
            lastUsed: 1,
          },
          "openai:p2": {
            cooldownUntil: now + 60 * 60 * 1000,
            failureCounts: { overloaded: 4 },
            lastUsed: 2,
          },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            content: [{ text: "ok", type: "text" }],
            stopReason: "stop",
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        agentDir,
        allowTransientCooldownProbe: true,
        authProfileIdSource: "auto",
        config: makeConfig({ fallbacks: ["openai/mock-2"] }),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:overloaded-cooldown-probe",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:overloaded-cooldown-probe",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("can probe one billing-disabled profile when transient cooldown probe is allowed without fallback models", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            disabledReason: "billing",
            disabledUntil: now + 60 * 60 * 1000,
            lastUsed: 1,
          },
          "openai:p2": {
            disabledReason: "billing",
            disabledUntil: now + 60 * 60 * 1000,
            lastUsed: 2,
          },
        },
      });

      runEmbeddedAttemptMock.mockResolvedValueOnce(
        makeAttempt({
          assistantTexts: ["ok"],
          lastAssistant: buildAssistant({
            content: [{ text: "ok", type: "text" }],
            stopReason: "stop",
          }),
        }),
      );

      const result = await runEmbeddedPiAgentInline({
        agentDir,
        allowTransientCooldownProbe: true,
        authProfileIdSource: "auto",
        config: makeConfig(),
        model: "mock-1",
        prompt: "hello",
        provider: "openai",
        runId: "run:billing-cooldown-probe-no-fallbacks",
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        sessionId: "session:test",
        sessionKey: "agent:test:billing-cooldown-probe-no-fallbacks",
        timeoutMs: 5000,
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
      expect(result.payloads?.[0]?.text ?? "").toContain("ok");
    });
  });

  it("treats agent-level fallbacks as configured when defaults have none", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 1 },
          "openai:p2": { cooldownUntil: now + 60 * 60 * 1000, lastUsed: 2 },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          agentDir,
          agentId: "support",
          authProfileIdSource: "auto",
          config: makeAgentOverrideOnlyFallbackConfig("support"),
          model: "mock-1",
          prompt: "hello",
          provider: "openai",
          runId: "run:agent-override-fallback",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          sessionId: "session:test",
          sessionKey: "agent:support:cooldown-failover",
          timeoutMs: 5000,
          workspaceDir,
        }),
      ).rejects.toMatchObject({
        model: "mock-1",
        name: "FailoverError",
        provider: "openai",
        reason: "unknown",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over with disabled reason when all profiles are unavailable", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      await writeAuthStore(agentDir, {
        usageStats: {
          "openai:p1": {
            disabledReason: "billing",
            disabledUntil: now + 60 * 60 * 1000,
            failureCounts: { rate_limit: 4 },
            lastUsed: 1,
          },
          "openai:p2": {
            disabledReason: "billing",
            disabledUntil: now + 60 * 60 * 1000,
            lastUsed: 2,
          },
        },
      });

      await expect(
        runEmbeddedPiAgentInline({
          agentDir,
          authProfileIdSource: "auto",
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          model: "mock-1",
          prompt: "hello",
          provider: "openai",
          runId: "run:disabled-failover",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          sessionId: "session:test",
          sessionKey: "agent:test:disabled-failover",
          timeoutMs: 5000,
          workspaceDir,
        }),
      ).rejects.toMatchObject({
        model: "mock-1",
        name: "FailoverError",
        provider: "openai",
        reason: "billing",
      });

      expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
    });
  });

  it("fails over when auth is unavailable and fallbacks are configured", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
        const authPath = path.join(agentDir, "auth-profiles.json");
        const authStatePath = path.join(agentDir, "auth-state.json");
        await fs.writeFile(authPath, JSON.stringify({ profiles: {}, version: 1 }));
        await fs.writeFile(authStatePath, JSON.stringify({ usageStats: {}, version: 1 }));

        await expect(
          runEmbeddedPiAgentInline({
            agentDir,
            authProfileIdSource: "auto",
            config: makeConfig({ apiKey: "", fallbacks: ["openai/mock-2"] }),
            model: "mock-1",
            prompt: "hello",
            provider: "openai",
            runId: "run:auth-unavailable",
            sessionFile: path.join(workspaceDir, "session.jsonl"),
            sessionId: "session:test",
            sessionKey: "agent:test:auth-unavailable",
            timeoutMs: 5000,
            workspaceDir,
          }),
        ).rejects.toMatchObject({ name: "FailoverError", reason: "auth" });

        expect(runEmbeddedAttemptMock).not.toHaveBeenCalled();
      });
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("uses the active erroring model in billing failover errors", async () => {
    await withAgentWorkspace(async ({ agentDir, workspaceDir }) => {
      await writeAuthStore(agentDir);
      mockSingleErrorAttempt({
        errorMessage: "insufficient credits",
        model: "mock-rotated",
        provider: "openai",
      });

      let thrown: unknown;
      try {
        await runEmbeddedPiAgentInline({
          agentDir,
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
          config: makeConfig({ fallbacks: ["openai/mock-2"] }),
          model: "mock-1",
          prompt: "hello",
          provider: "openai",
          runId: "run:billing-failover-active-model",
          sessionFile: path.join(workspaceDir, "session.jsonl"),
          sessionId: "session:test",
          sessionKey: "agent:test:billing-failover-active-model",
          timeoutMs: 5000,
          workspaceDir,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        model: "mock-rotated",
        name: "FailoverError",
        provider: "openai",
        reason: "billing",
      });
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("openai (mock-rotated) returned a billing error");
      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(1);
    });
  });

  it("skips profiles in cooldown when rotating after failure", async () => {
    await withTimedAgentWorkspace(async ({ agentDir, workspaceDir, now }) => {
      const authPath = path.join(agentDir, "auth-profiles.json");
      const payload = {
        profiles: {
          "openai:p1": { key: "sk-one", provider: "openai", type: "api_key" },
          "openai:p2": { key: "sk-two", provider: "openai", type: "api_key" },
          "openai:p3": { key: "sk-three", provider: "openai", type: "api_key" },
        },
        usageStats: {
          "openai:p1": { lastUsed: 1 },
          "openai:p2": { cooldownUntil: now + 60 * 60 * 1000 }, // P2 in cooldown
          "openai:p3": { lastUsed: 3 },
        },
        version: 1,
      };
      await fs.writeFile(authPath, JSON.stringify(payload));

      mockFailedThenSuccessfulAttempt("rate limit");
      await runAutoPinnedOpenAiTurn({
        agentDir,
        runId: "run:rotate-skip-cooldown",
        sessionKey: "agent:test:rotate-skip-cooldown",
        workspaceDir,
      });

      expect(runEmbeddedAttemptMock).toHaveBeenCalledTimes(2);
      const usageStats = await readUsageStats(agentDir);
      expect(typeof usageStats["openai:p1"]?.lastUsed).toBe("number");
      expect(typeof usageStats["openai:p3"]?.lastUsed).toBe("number");
      expect(usageStats["openai:p2"]?.cooldownUntil).toBe(now + 60 * 60 * 1000);
    });
  });
});
