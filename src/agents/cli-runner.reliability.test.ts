import { describe, expect, it } from "vitest";
import { runPreparedCliAgent } from "./cli-runner.js";
import {
  createManagedRun,
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  supervisorSpawnMock,
} from "./cli-runner.test-support.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";
import { resolveCliNoOutputTimeoutMs } from "./cli-runner/helpers.js";
import type { PreparedCliRunContext } from "./cli-runner/types.js";

function buildPreparedContext(params?: {
  sessionKey?: string;
  cliSessionId?: string;
  runId?: string;
}): PreparedCliRunContext {
  const backend = {
    args: ["exec", "--json"],
    command: "codex",
    input: "arg" as const,
    modelArg: "--model",
    output: "text" as const,
    serialize: true,
    sessionMode: "existing" as const,
  };
  return {
    backendResolved: {
      bundleMcp: false,
      config: backend,
      id: "codex-cli",
      pluginId: "openai",
    },
    bootstrapPromptWarningLines: [],
    modelId: "gpt-5.4",
    normalizedModel: "gpt-5.4",
    params: {
      model: "gpt-5.4",
      prompt: "hi",
      provider: "codex-cli",
      runId: params?.runId ?? "run-2",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "s1",
      sessionKey: params?.sessionKey,
      timeoutMs: 1000,
      workspaceDir: "/tmp",
    },
    preparedBackend: {
      backend,
      env: {},
    },
    reusableCliSession: params?.cliSessionId ? { sessionId: params.cliSessionId } : {},
    started: Date.now(),
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    workspaceDir: "/tmp",
  };
}

describe("runCliAgent reliability", () => {
  it("fails with timeout when no-output watchdog trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        durationMs: 200,
        exitCode: null,
        exitSignal: "SIGKILL",
        noOutputTimedOut: true,
        reason: "no-output-timeout",
        stderr: "",
        stdout: "",
        timedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-2" }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");
  });

  it("enqueues a system event and heartbeat wake on no-output watchdog timeout for session runs", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        durationMs: 200,
        exitCode: null,
        exitSignal: "SIGKILL",
        noOutputTimedOut: true,
        reason: "no-output-timeout",
        stderr: "",
        stdout: "",
        timedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({
          cliSessionId: "thread-123",
          runId: "run-2b",
          sessionKey: "agent:main:main",
        }),
        "thread-123",
      ),
    ).rejects.toThrow("produced no output");

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [notice, opts] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(String(notice)).toContain("produced no output");
    expect(String(notice)).toContain("interactive input or an approval prompt");
    expect(opts).toMatchObject({ sessionKey: "agent:main:main" });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "cli:watchdog:stall",
      sessionKey: "agent:main:main",
    });
  });

  it("fails with timeout when overall timeout trips", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        durationMs: 200,
        exitCode: null,
        exitSignal: "SIGKILL",
        noOutputTimedOut: false,
        reason: "overall-timeout",
        stderr: "",
        stdout: "",
        timedOut: true,
      }),
    );

    await expect(
      executePreparedCliRun(
        buildPreparedContext({ cliSessionId: "thread-123", runId: "run-3" }),
        "thread-123",
      ),
    ).rejects.toThrow("exceeded timeout");
  });

  it("rethrows the retry failure when session-expired recovery retry also fails", async () => {
    supervisorSpawnMock.mockClear();
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        durationMs: 150,
        exitCode: 1,
        exitSignal: null,
        noOutputTimedOut: false,
        reason: "exit",
        stderr: "session expired",
        stdout: "",
        timedOut: false,
      }),
    );
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun({
        durationMs: 150,
        exitCode: 1,
        exitSignal: null,
        noOutputTimedOut: false,
        reason: "exit",
        stderr: "rate limit exceeded",
        stdout: "",
        timedOut: false,
      }),
    );

    await expect(
      runPreparedCliAgent(
        buildPreparedContext({
          cliSessionId: "thread-123",
          runId: "run-retry-failure",
          sessionKey: "agent:main:subagent:retry",
        }),
      ),
    ).rejects.toThrow("rate limit exceeded");

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("resolveCliNoOutputTimeoutMs", () => {
  it("uses backend-configured resume watchdog override", () => {
    const timeoutMs = resolveCliNoOutputTimeoutMs({
      backend: {
        command: "codex",
        reliability: {
          watchdog: {
            resume: {
              noOutputTimeoutMs: 42_000,
            },
          },
        },
      },
      timeoutMs: 120_000,
      useResume: true,
    });
    expect(timeoutMs).toBe(42_000);
  });
});
