import fs from "node:fs/promises";
import type { Mock } from "vitest";
import { beforeEach, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import type { enqueueSystemEvent } from "../infra/system-events.js";
import type { CliBackendPlugin } from "../plugin-sdk/cli-backend.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "../plugin-sdk/cli-backend.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import type { getProcessSupervisor } from "../process/supervisor/index.js";
import { setCliAuthEpochTestDeps } from "./cli-auth-epoch.js";
import { setCliRunnerExecuteTestDeps } from "./cli-runner/execute.js";
import { setCliRunnerPrepareTestDeps } from "./cli-runner/prepare.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type EnqueueSystemEventFn = typeof enqueueSystemEvent;
type RequestHeartbeatNowFn = typeof requestHeartbeatNow;
type UnknownMock = Mock<(...args: unknown[]) => unknown>;
interface BootstrapContext {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}
type ResolveBootstrapContextForRunMock = Mock<() => Promise<BootstrapContext>>;

export const supervisorSpawnMock: UnknownMock = vi.fn();
export const enqueueSystemEventMock: UnknownMock = vi.fn();
export const requestHeartbeatNowMock: UnknownMock = vi.fn();
export const SMALL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
let cliRunnerModulePromise: Promise<typeof import("./cli-runner.js")> | undefined;

const hoisted = vi.hoisted(
  (): {
    resolveBootstrapContextForRunMock: ResolveBootstrapContextForRunMock;
  } => ({
    resolveBootstrapContextForRunMock: vi.fn<() => Promise<BootstrapContext>>(async () => ({
      bootstrapFiles: [],
      contextFiles: [],
    })),
  }),
);

setCliRunnerExecuteTestDeps({
  enqueueSystemEvent: (
    text: Parameters<EnqueueSystemEventFn>[0],
    options: Parameters<EnqueueSystemEventFn>[1],
  ) => enqueueSystemEventMock(text, options) as ReturnType<EnqueueSystemEventFn>,
  getProcessSupervisor: () => ({
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    getRecord: vi.fn(),
    reconcileOrphans: vi.fn(),
    spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
      supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
  }),
  requestHeartbeatNow: (options?: Parameters<RequestHeartbeatNowFn>[0]) =>
    requestHeartbeatNowMock(options) as ReturnType<RequestHeartbeatNowFn>,
});

setCliRunnerPrepareTestDeps({
  makeBootstrapWarn: () => () => {},
  resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
  resolveOpenClawDocsPath: async () => null,
});

interface MockRunExit {
  reason:
    | "manual-cancel"
    | "overall-timeout"
    | "no-output-timeout"
    | "spawn-error"
    | "signal"
    | "exit";
  exitCode: number | null;
  exitSignal: NodeJS.Signals | number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  noOutputTimedOut: boolean;
}

interface TestCliBackendConfig {
  command: string;
  env?: Record<string, string>;
  clearEnv?: string[];
}

interface ManagedRunMock {
  runId: string;
  pid: number;
  startedAtMs: number;
  stdin: undefined;
  wait: Mock<() => Promise<MockRunExit>>;
  cancel: Mock<() => void>;
}

function buildOpenAICodexCliBackendFixture(): CliBackendPlugin {
  return {
    bundleMcp: true,
    bundleMcpMode: "codex-config-overrides",
    config: {
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      command: "codex",
      imageArg: "--image",
      imageMode: "repeat",
      input: "arg",
      modelArg: "--model",
      output: "jsonl",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: [
        "exec",
        "resume",
        "{sessionId}",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
      ],
      resumeOutput: "text",
      serialize: true,
      sessionIdFields: ["thread_id"],
      sessionMode: "existing",
      systemPromptFileConfigArg: "-c",
      systemPromptFileConfigKey: "model_instructions_file",
      systemPromptWhen: "first",
    },
    id: "codex-cli",
  };
}

function buildAnthropicCliBackendFixture(): CliBackendPlugin {
  const clearEnv = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY_OLD",
    "ANTHROPIC_API_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "ANTHROPIC_OAUTH_TOKEN",
    "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
    "CLAUDE_CODE_OAUTH_SCOPES",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
    "CLAUDE_CODE_PLUGIN_CACHE_DIR",
    "CLAUDE_CODE_PLUGIN_SEED_DIR",
    "CLAUDE_CODE_REMOTE",
    "CLAUDE_CODE_USE_COWORK_PLUGINS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_VERTEX",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
    "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
    "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
    "OTEL_EXPORTER_OTLP_PROTOCOL",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
    "OTEL_LOGS_EXPORTER",
    "OTEL_METRICS_EXPORTER",
    "OTEL_SDK_DISABLED",
    "OTEL_TRACES_EXPORTER",
  ] as const;
  return {
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    config: {
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
      ],
      clearEnv: [...clearEnv],
      command: "claude",
      input: "stdin",
      modelAliases: {
        "claude-opus-4-6": "opus",
        "claude-sonnet-4-5": "sonnet",
        "claude-sonnet-4-6": "sonnet",
        haiku: "haiku",
        opus: "opus",
        sonnet: "sonnet",
      },
      modelArg: "--model",
      output: "jsonl",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--permission-mode",
        "bypassPermissions",
        "--resume",
        "{sessionId}",
      ],
      serialize: true,
      sessionArg: "--session-id",
      sessionIdFields: ["session_id", "sessionId", "conversation_id", "conversationId"],
      sessionMode: "always",
      systemPromptArg: "--append-system-prompt",
      systemPromptMode: "append",
      systemPromptWhen: "first",
    },
    id: "claude-cli",
  };
}

function buildGoogleGeminiCliBackendFixture(): CliBackendPlugin {
  return {
    bundleMcp: true,
    bundleMcpMode: "gemini-system-settings",
    config: {
      args: ["--output-format", "json", "--prompt", "{prompt}"],
      command: "gemini",
      imageArg: "@",
      imagePathScope: "workspace",
      input: "arg",
      modelAliases: {
        flash: "gemini-3.1-flash-preview",
        "flash-lite": "gemini-3.1-flash-lite-preview",
        pro: "gemini-3.1-pro-preview",
      },
      modelArg: "--model",
      output: "json",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      resumeArgs: ["--resume", "{sessionId}", "--output-format", "json", "--prompt", "{prompt}"],
      serialize: true,
      sessionIdFields: ["session_id", "sessionId"],
      sessionMode: "existing",
    },
    id: "google-gemini-cli",
  };
}

export function createManagedRun(
  exit: MockRunExit,
  pid = 1234,
): ManagedRunMock & Awaited<ReturnType<SupervisorSpawnFn>> {
  return {
    cancel: vi.fn(),
    pid,
    runId: "run-supervisor",
    startedAtMs: Date.now(),
    stdin: undefined,
    wait: vi.fn().mockResolvedValue(exit),
  };
}

export function mockSuccessfulCliRun() {
  supervisorSpawnMock.mockResolvedValueOnce(
    createManagedRun({
      durationMs: 50,
      exitCode: 0,
      exitSignal: null,
      noOutputTimedOut: false,
      reason: "exit",
      stderr: "",
      stdout: "ok",
      timedOut: false,
    }),
  );
}

export const EXISTING_CODEX_CONFIG = {
  agents: {
    defaults: {
      cliBackends: {
        "codex-cli": {
          args: ["exec", "--json"],
          command: "codex",
          modelArg: "--model",
          output: "text",
          resumeArgs: ["exec", "resume", "{sessionId}", "--json"],
          sessionMode: "existing",
        },
      },
    },
  },
} satisfies OpenClawConfig;

export async function setupCliRunnerTestModule() {
  setupCliRunnerTestRegistry();
  cliRunnerModulePromise ??= import("./cli-runner.js");
  return (await cliRunnerModulePromise).runCliAgent;
}

export function setupCliRunnerTestRegistry() {
  setCliAuthEpochTestDeps({
    loadAuthProfileStoreForRuntime: () => ({ profiles: {}, version: 1 }),
    readClaudeCliCredentialsCached: () => null,
    readCodexCliCredentialsCached: () => null,
  });
  const registry = createEmptyPluginRegistry();
  registry.cliBackends = [
    {
      backend: buildAnthropicCliBackendFixture(),
      pluginId: "anthropic",
      source: "test",
    },
    {
      backend: buildOpenAICodexCliBackendFixture(),
      pluginId: "openai",
      source: "test",
    },
    {
      backend: buildGoogleGeminiCliBackendFixture(),
      pluginId: "google",
      source: "test",
    },
  ];
  setActivePluginRegistry(registry);
  supervisorSpawnMock.mockClear();
  enqueueSystemEventMock.mockClear();
  requestHeartbeatNowMock.mockClear();
  hoisted.resolveBootstrapContextForRunMock.mockReset().mockResolvedValue({
    bootstrapFiles: [],
    contextFiles: [],
  });
}

export function stubBootstrapContext(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}) {
  hoisted.resolveBootstrapContextForRunMock.mockResolvedValueOnce(params);
}

export function restoreCliRunnerPrepareTestDeps() {
  setCliRunnerPrepareTestDeps({
    makeBootstrapWarn: () => () => {},
    resolveBootstrapContextForRun: hoisted.resolveBootstrapContextForRunMock,
    resolveOpenClawDocsPath: async () => null,
  });
}

export async function runCliAgentWithBackendConfig(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  backend: TestCliBackendConfig;
  runId: string;
}) {
  await params.runCliAgent({
    cliSessionId: "thread-123",
    config: {
      agents: {
        defaults: {
          cliBackends: {
            "codex-cli": params.backend,
          },
        },
      },
    } satisfies OpenClawConfig,
    model: "gpt-5.4",
    prompt: "hi",
    provider: "codex-cli",
    runId: params.runId,
    sessionFile: "/tmp/session.jsonl",
    sessionId: "s1",
    timeoutMs: 1000,
    workspaceDir: "/tmp",
  });
}

export async function runExistingCodexCliAgent(params: {
  runCliAgent: typeof import("./cli-runner.js").runCliAgent;
  runId: string;
  cliSessionBindingAuthProfileId: string;
  authProfileId: string;
}) {
  await params.runCliAgent({
    authProfileId: params.authProfileId,
    cliSessionBinding: {
      authProfileId: params.cliSessionBindingAuthProfileId,
      sessionId: "thread-123",
    },
    config: EXISTING_CODEX_CONFIG,
    model: "gpt-5.4",
    prompt: "hi",
    provider: "codex-cli",
    runId: params.runId,
    sessionFile: "/tmp/session.jsonl",
    sessionId: "s1",
    timeoutMs: 1000,
    workspaceDir: "/tmp",
  });
}

export async function withTempImageFile(
  prefix: string,
): Promise<{ tempDir: string; sourceImage: string }> {
  const os = await import("node:os");
  const path = await import("node:path");
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sourceImage = path.join(tempDir, "image.png");
  await fs.writeFile(sourceImage, Buffer.from(SMALL_PNG_BASE64, "base64"));
  return { sourceImage, tempDir };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});
