import crypto from "node:crypto";
import { getShellConfig } from "../../agents/shell-utils.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { createChildAdapter } from "./adapters/child.js";
import { createPtyAdapter } from "./adapters/pty.js";
import { createRunRegistry } from "./registry.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  RunRecord,
  SpawnInput,
  TerminationReason,
} from "./types.js";

interface ActiveRun {
  run: ManagedRun;
  scopeKey?: string;
}

function clampTimeout(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

function isTimeoutReason(reason: TerminationReason) {
  return reason === "overall-timeout" || reason === "no-output-timeout";
}

export function createProcessSupervisor(): ProcessSupervisor {
  const registry = createRunRegistry();
  const active = new Map<string, ActiveRun>();

  const cancel = (runId: string, reason: TerminationReason = "manual-cancel") => {
    const current = active.get(runId);
    if (!current) {
      return;
    }
    registry.updateState(runId, "exiting", {
      terminationReason: reason,
    });
    current.run.cancel(reason);
  };

  const cancelScope = (scopeKey: string, reason: TerminationReason = "manual-cancel") => {
    if (!scopeKey.trim()) {
      return;
    }
    for (const [runId, run] of active.entries()) {
      if (run.scopeKey !== scopeKey) {
        continue;
      }
      cancel(runId, reason);
    }
  };

  const spawn = async (input: SpawnInput): Promise<ManagedRun> => {
    const runId = normalizeOptionalString(input.runId) ?? crypto.randomUUID();
    const scopeKey = normalizeOptionalString(input.scopeKey);
    if (input.replaceExistingScope && scopeKey) {
      cancelScope(scopeKey, "manual-cancel");
    }
    const startedAtMs = Date.now();
    const record: RunRecord = {
      backendId: input.backendId,
      createdAtMs: startedAtMs,
      lastOutputAtMs: startedAtMs,
      runId,
      scopeKey,
      sessionId: input.sessionId,
      startedAtMs,
      state: "starting",
      updatedAtMs: startedAtMs,
    };
    registry.add(record);

    let forcedReason: TerminationReason | null = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let timeoutTimer: NodeJS.Timeout | null = null;
    let noOutputTimer: NodeJS.Timeout | null = null;
    const captureOutput = input.captureOutput !== false;

    const overallTimeoutMs = clampTimeout(input.timeoutMs);
    const noOutputTimeoutMs = clampTimeout(input.noOutputTimeoutMs);

    const setForcedReason = (reason: TerminationReason) => {
      if (forcedReason) {
        return;
      }
      forcedReason = reason;
      registry.updateState(runId, "exiting", { terminationReason: reason });
    };

    let cancelAdapter: ((reason: TerminationReason) => void) | null = null;

    const requestCancel = (reason: TerminationReason) => {
      setForcedReason(reason);
      cancelAdapter?.(reason);
    };

    const touchOutput = () => {
      registry.touchOutput(runId);
      if (!noOutputTimeoutMs || settled) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        requestCancel("no-output-timeout");
      }, noOutputTimeoutMs);
    };

    try {
      if (input.mode === "child" && input.argv.length === 0) {
        throw new Error("spawn argv cannot be empty");
      }
      const adapter =
        input.mode === "pty"
          ? await (async () => {
              const { shell, args: shellArgs } = getShellConfig();
              const ptyCommand = input.ptyCommand.trim();
              if (!ptyCommand) {
                throw new Error("PTY command cannot be empty");
              }
              return await createPtyAdapter({
                args: [...shellArgs, ptyCommand],
                cwd: input.cwd,
                env: input.env,
                shell,
              });
            })()
          : await createChildAdapter({
              argv: input.argv,
              cwd: input.cwd,
              env: input.env,
              input: input.input,
              stdinMode: input.stdinMode,
              windowsVerbatimArguments: input.windowsVerbatimArguments,
            });

      registry.updateState(runId, "running", { pid: adapter.pid });

      const clearTimers = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (noOutputTimer) {
          clearTimeout(noOutputTimer);
          noOutputTimer = null;
        }
      };

      cancelAdapter = (_reason: TerminationReason) => {
        if (settled) {
          return;
        }
        adapter.kill("SIGKILL");
      };

      if (overallTimeoutMs) {
        timeoutTimer = setTimeout(() => {
          requestCancel("overall-timeout");
        }, overallTimeoutMs);
      }
      if (noOutputTimeoutMs) {
        noOutputTimer = setTimeout(() => {
          requestCancel("no-output-timeout");
        }, noOutputTimeoutMs);
      }

      adapter.onStdout((chunk) => {
        if (captureOutput) {
          stdout += chunk;
        }
        input.onStdout?.(chunk);
        touchOutput();
      });
      adapter.onStderr((chunk) => {
        if (captureOutput) {
          stderr += chunk;
        }
        input.onStderr?.(chunk);
        touchOutput();
      });

      const waitPromise = (async (): Promise<RunExit> => {
        const result = await adapter.wait();
        if (settled) {
          return {
            durationMs: Date.now() - startedAtMs,
            exitCode: result.code,
            exitSignal: result.signal,
            noOutputTimedOut: forcedReason === "no-output-timeout",
            reason: forcedReason ?? "exit",
            stderr,
            stdout,
            timedOut: isTimeoutReason(forcedReason ?? "exit"),
          };
        }
        settled = true;
        clearTimers();
        adapter.dispose();
        active.delete(runId);

        const reason: TerminationReason =
          forcedReason ?? (result.signal != null ? ("signal" as const) : ("exit" as const));
        const exit: RunExit = {
          durationMs: Date.now() - startedAtMs,
          exitCode: result.code,
          exitSignal: result.signal,
          noOutputTimedOut: forcedReason === "no-output-timeout",
          reason,
          stderr,
          stdout,
          timedOut: isTimeoutReason(forcedReason ?? reason),
        };
        registry.finalize(runId, {
          exitCode: exit.exitCode,
          exitSignal: exit.exitSignal,
          reason: exit.reason,
        });
        return exit;
      })().catch((error) => {
        if (!settled) {
          settled = true;
          clearTimers();
          active.delete(runId);
          adapter.dispose();
          registry.finalize(runId, {
            exitCode: null,
            exitSignal: null,
            reason: "spawn-error",
          });
        }
        throw error;
      });

      const managedRun: ManagedRun = {
        cancel: (reason = "manual-cancel") => {
          requestCancel(reason);
        },
        pid: adapter.pid,
        runId,
        startedAtMs,
        stdin: adapter.stdin,
        wait: async () => await waitPromise,
      };

      active.set(runId, {
        run: managedRun,
        scopeKey,
      });
      return managedRun;
    } catch (error) {
      registry.finalize(runId, {
        exitCode: null,
        exitSignal: null,
        reason: "spawn-error",
      });
      const { warnProcessSupervisorSpawnFailure } = await import("./supervisor-log.runtime.js");
      warnProcessSupervisorSpawnFailure(`spawn failed: runId=${runId} reason=${String(error)}`);
      throw error;
    }
  };

  return {
    cancel,
    cancelScope,
    getRecord: (runId: string) => registry.get(runId),
    reconcileOrphans: async () => {
      // Deliberate no-op: this supervisor uses in-memory ownership only.
      // Active runs are not recovered after process restart in the current model.
    },
    spawn,
  };
}
