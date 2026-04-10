import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { getDiagnosticSessionState } from "../logging/diagnostic-session-state.js";
import { killProcessTree } from "../process/kill-tree.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import {
  type ProcessSession,
  deleteSession,
  drainSession,
  getFinishedSession,
  getSession,
  listFinishedSessions,
  listRunningSessions,
  markExited,
  setJobTtlMs,
} from "./bash-process-registry.js";
import { deriveSessionName, pad, sliceLogLines, truncateMiddle } from "./bash-tools.shared.js";
import { recordCommandPoll, resetCommandPollCount } from "./command-poll-backoff.js";
import { encodeKeySequence, encodePaste, hasCursorModeSensitiveKeys } from "./pty-keys.js";
import { PROCESS_TOOL_DISPLAY_SUMMARY } from "./tool-description-presets.js";
import type { AgentToolWithMeta } from "./tools/common.js";

export interface ProcessToolDefaults {
  cleanupMs?: number;
  hasCronTool?: boolean;
  scopeKey?: string;
}

interface WritableStdin {
  write: (data: string, cb?: (err?: Error | null) => void) => void;
  end: () => void;
  destroyed?: boolean;
}
const DEFAULT_LOG_TAIL_LINES = 200;

function resolveLogSliceWindow(offset?: number, limit?: number) {
  const usingDefaultTail = offset === undefined && limit === undefined;
  const effectiveLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? limit
      : (usingDefaultTail
        ? DEFAULT_LOG_TAIL_LINES
        : undefined);
  return { effectiveLimit, effectiveOffset: offset, usingDefaultTail };
}

function defaultTailNote(totalLines: number, usingDefaultTail: boolean) {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) {
    return "";
  }
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

const processSchema = Type.Object({
  action: Type.String({ description: "Process action" }),
  bracketed: Type.Optional(Type.Boolean({ description: "Wrap paste in bracketed mode" })),
  data: Type.Optional(Type.String({ description: "Data to write for write" })),
  eof: Type.Optional(Type.Boolean({ description: "Close stdin after write" })),
  hex: Type.Optional(Type.Array(Type.String(), { description: "Hex bytes to send for send-keys" })),
  keys: Type.Optional(
    Type.Array(Type.String(), { description: "Key tokens to send for send-keys" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Log length" })),
  literal: Type.Optional(Type.String({ description: "Literal string for send-keys" })),
  offset: Type.Optional(Type.Number({ description: "Log offset" })),
  sessionId: Type.Optional(Type.String({ description: "Session id for actions other than list" })),
  text: Type.Optional(Type.String({ description: "Text to paste for paste" })),
  timeout: Type.Optional(
    Type.Number({
      description: "For poll: wait up to this many milliseconds before returning",
      minimum: 0,
    }),
  ),
});

const MAX_POLL_WAIT_MS = 120_000;

function resolvePollWaitMs(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.floor(value)));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(MAX_POLL_WAIT_MS, parsed));
    }
  }
  return 0;
}

function failText(text: string): AgentToolResult<unknown> {
  return {
    content: [
      {
        text,
        type: "text",
      },
    ],
    details: { status: "failed" },
  };
}

function recordPollRetrySuggestion(sessionId: string, hasNewOutput: boolean): number | undefined {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    return recordCommandPoll(sessionState, sessionId, hasNewOutput);
  } catch {
    return undefined;
  }
}

function resetPollRetrySuggestion(sessionId: string): void {
  try {
    const sessionState = getDiagnosticSessionState({ sessionId });
    resetCommandPollCount(sessionState, sessionId);
  } catch {
    // Ignore diagnostics state failures for process tool behavior.
  }
}

export function describeProcessTool(params?: { hasCronTool?: boolean }): string {
  return [
    "Manage running exec sessions for commands already started: list, poll, log, write, send-keys, submit, paste, kill.",
    "Use poll/log when you need status, logs, quiet-success confirmation, or completion confirmation when automatic completion wake is unavailable. Use write/send-keys/submit/paste/kill for input or intervention.",
    params?.hasCronTool
      ? "Do not use process polling to emulate timers or reminders; use cron for scheduled follow-ups."
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function createProcessTool(
  defaults?: ProcessToolDefaults,
): AgentToolWithMeta<typeof processSchema, unknown> {
  if (defaults?.cleanupMs !== undefined) {
    setJobTtlMs(defaults.cleanupMs);
  }
  const scopeKey = defaults?.scopeKey;
  const supervisor = getProcessSupervisor();
  const isInScope = (session?: { scopeKey?: string } | null) =>
    !scopeKey || session?.scopeKey === scopeKey;

  const cancelManagedSession = (sessionId: string) => {
    const record = supervisor.getRecord(sessionId);
    if (!record || record.state === "exited") {
      return false;
    }
    supervisor.cancel(sessionId, "manual-cancel");
    return true;
  };

  const terminateSessionFallback = (session: ProcessSession) => {
    const pid = session.pid ?? session.child?.pid;
    if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) {
      return false;
    }
    killProcessTree(pid);
    return true;
  };

  return {
    description: describeProcessTool({ hasCronTool: defaults?.hasCronTool === true }),
    displaySummary: PROCESS_TOOL_DISPLAY_SUMMARY,
    execute: async (_toolCallId, args, _signal, _onUpdate): Promise<AgentToolResult<unknown>> => {
      const params = args as {
        action:
          | "list"
          | "poll"
          | "log"
          | "write"
          | "send-keys"
          | "submit"
          | "paste"
          | "kill"
          | "clear"
          | "remove";
        sessionId?: string;
        data?: string;
        keys?: string[];
        hex?: string[];
        literal?: string;
        text?: string;
        bracketed?: boolean;
        eof?: boolean;
        offset?: number;
        limit?: number;
        timeout?: unknown;
      };

      if (params.action === "list") {
        const running = listRunningSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            command: s.command,
            cwd: s.cwd,
            name: deriveSessionName(s.command),
            pid: s.pid ?? undefined,
            runtimeMs: Date.now() - s.startedAt,
            sessionId: s.id,
            startedAt: s.startedAt,
            status: "running",
            tail: s.tail,
            truncated: s.truncated,
          }));
        const finished = listFinishedSessions()
          .filter((s) => isInScope(s))
          .map((s) => ({
            command: s.command,
            cwd: s.cwd,
            endedAt: s.endedAt,
            exitCode: s.exitCode ?? undefined,
            exitSignal: s.exitSignal ?? undefined,
            name: deriveSessionName(s.command),
            runtimeMs: s.endedAt - s.startedAt,
            sessionId: s.id,
            startedAt: s.startedAt,
            status: s.status,
            tail: s.tail,
            truncated: s.truncated,
          }));
        const lines = [...running, ...finished]
          .toSorted((a, b) => b.startedAt - a.startedAt)
          .map((s) => {
            const label = s.name ? truncateMiddle(s.name, 80) : truncateMiddle(s.command, 120);
            return `${s.sessionId} ${pad(s.status, 9)} ${formatDurationCompact(s.runtimeMs) ?? "n/a"} :: ${label}`;
          });
        return {
          content: [
            {
              text: lines.join("\n") || "No running or recent sessions.",
              type: "text",
            },
          ],
          details: { sessions: [...running, ...finished], status: "completed" },
        };
      }

      if (!params.sessionId) {
        return {
          content: [{ text: "sessionId is required for this action.", type: "text" }],
          details: { status: "failed" },
        };
      }

      const session = getSession(params.sessionId);
      const finished = getFinishedSession(params.sessionId);
      const scopedSession = isInScope(session) ? session : undefined;
      const scopedFinished = isInScope(finished) ? finished : undefined;

      const failedResult = (text: string): AgentToolResult<unknown> => ({
        content: [{ text, type: "text" }],
        details: { status: "failed" },
      });

      const resolveBackgroundedWritableStdin = () => {
        if (!scopedSession) {
          return {
            ok: false as const,
            result: failedResult(`No active session found for ${params.sessionId}`),
          };
        }
        if (!scopedSession.backgrounded) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} is not backgrounded.`),
          };
        }
        const stdin = scopedSession.stdin ?? scopedSession.child?.stdin;
        if (!stdin || stdin.destroyed) {
          return {
            ok: false as const,
            result: failedResult(`Session ${params.sessionId} stdin is not writable.`),
          };
        }
        return { ok: true as const, session: scopedSession, stdin: stdin as WritableStdin };
      };

      const writeToStdin = async (stdin: WritableStdin, data: string) => {
        await new Promise<void>((resolve, reject) => {
          stdin.write(data, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      };

      const runningSessionResult = (
        session: ProcessSession,
        text: string,
      ): AgentToolResult<unknown> => ({
        content: [{ text, type: "text" }],
        details: {
          name: deriveSessionName(session.command),
          sessionId: params.sessionId,
          status: "running",
        },
      });

      switch (params.action) {
        case "poll": {
          if (!scopedSession) {
            if (scopedFinished) {
              resetPollRetrySuggestion(params.sessionId);
              return {
                content: [
                  {
                    text:
                      (scopedFinished.tail ||
                        `(no output recorded${
                          scopedFinished.truncated ? " — truncated to cap" : ""
                        })`) +
                      `\n\nProcess exited with ${
                        scopedFinished.exitSignal
                          ? `signal ${scopedFinished.exitSignal}`
                          : `code ${scopedFinished.exitCode ?? 0}`
                      }.`,
                    type: "text",
                  },
                ],
                details: {
                  aggregated: scopedFinished.aggregated,
                  exitCode: scopedFinished.exitCode ?? undefined,
                  name: deriveSessionName(scopedFinished.command),
                  sessionId: params.sessionId,
                  status: scopedFinished.status === "completed" ? "completed" : "failed",
                },
              };
            }
            resetPollRetrySuggestion(params.sessionId);
            return failText(`No session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          const pollWaitMs = resolvePollWaitMs(params.timeout);
          if (pollWaitMs > 0 && !scopedSession.exited) {
            const deadline = Date.now() + pollWaitMs;
            while (!scopedSession.exited && Date.now() < deadline) {
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(0, Math.min(250, deadline - Date.now()))),
              );
            }
          }
          const { stdout, stderr } = drainSession(scopedSession);
          const {exited} = scopedSession;
          const exitCode = scopedSession.exitCode ?? 0;
          const exitSignal = scopedSession.exitSignal ?? undefined;
          if (exited) {
            const status = exitCode === 0 && exitSignal == null ? "completed" : "failed";
            markExited(
              scopedSession,
              scopedSession.exitCode ?? null,
              scopedSession.exitSignal ?? null,
              status,
            );
          }
          const status = exited
            ? (exitCode === 0 && exitSignal == null
              ? "completed"
              : "failed")
            : "running";
          const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n").trim();
          const hasNewOutput = output.length > 0;
          const retryInMs = exited
            ? undefined
            : recordPollRetrySuggestion(params.sessionId, hasNewOutput);
          if (exited) {
            resetPollRetrySuggestion(params.sessionId);
          }
          return {
            content: [
              {
                text:
                  (output || "(no new output)") +
                  (exited
                    ? `\n\nProcess exited with ${
                        exitSignal ? `signal ${exitSignal}` : `code ${exitCode}`
                      }.`
                    : "\n\nProcess still running."),
                type: "text",
              },
            ],
            details: {
              aggregated: scopedSession.aggregated,
              exitCode: exited ? exitCode : undefined,
              name: deriveSessionName(scopedSession.command),
              sessionId: params.sessionId,
              status,
              ...(typeof retryInMs === "number" ? { retryInMs } : {}),
            },
          };
        }

        case "log": {
          if (scopedSession) {
            if (!scopedSession.backgrounded) {
              return {
                content: [
                  {
                    text: `Session ${params.sessionId} is not backgrounded.`,
                    type: "text",
                  },
                ],
                details: { status: "failed" },
              };
            }
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedSession.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [{ text: (slice || "(no output yet)") + logDefaultTailNote, type: "text" }],
              details: {
                name: deriveSessionName(scopedSession.command),
                sessionId: params.sessionId,
                status: scopedSession.exited ? "completed" : "running",
                total: totalLines,
                totalChars,
                totalLines,
                truncated: scopedSession.truncated,
              },
            };
          }
          if (scopedFinished) {
            const window = resolveLogSliceWindow(params.offset, params.limit);
            const { slice, totalLines, totalChars } = sliceLogLines(
              scopedFinished.aggregated,
              window.effectiveOffset,
              window.effectiveLimit,
            );
            const status = scopedFinished.status === "completed" ? "completed" : "failed";
            const logDefaultTailNote = defaultTailNote(totalLines, window.usingDefaultTail);
            return {
              content: [
                { text: (slice || "(no output recorded)") + logDefaultTailNote, type: "text" },
              ],
              details: {
                exitCode: scopedFinished.exitCode ?? undefined,
                exitSignal: scopedFinished.exitSignal ?? undefined,
                name: deriveSessionName(scopedFinished.command),
                sessionId: params.sessionId,
                status,
                total: totalLines,
                totalChars,
                totalLines,
                truncated: scopedFinished.truncated,
              },
            };
          }
          return {
            content: [
              {
                text: `No session found for ${params.sessionId}`,
                type: "text",
              },
            ],
            details: { status: "failed" },
          };
        }

        case "write": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          await writeToStdin(resolved.stdin, params.data ?? "");
          if (params.eof) {
            resolved.stdin.end();
          }
          return runningSessionResult(
            resolved.session,
            `Wrote ${(params.data ?? "").length} bytes to session ${params.sessionId}${
              params.eof ? " (stdin closed)" : ""
            }.`,
          );
        }

        case "send-keys": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          const request = {
            hex: params.hex,
            keys: params.keys,
            literal: params.literal,
          };
          if (resolved.session.cursorKeyMode === "unknown" && hasCursorModeSensitiveKeys(request)) {
            return failText(
              `Session ${params.sessionId} cursor key mode is not known yet. Poll or log until startup output appears, then retry send-keys.`,
            );
          }
          const cursorKeyMode =
            resolved.session.cursorKeyMode === "unknown"
              ? undefined
              : resolved.session.cursorKeyMode;
          const { data, warnings } = encodeKeySequence(request, cursorKeyMode);
          if (!data) {
            return {
              content: [
                {
                  text: "No key data provided.",
                  type: "text",
                },
              ],
              details: { status: "failed" },
            };
          }
          await writeToStdin(resolved.stdin, data);
          return runningSessionResult(
            resolved.session,
            `Sent ${data.length} bytes to session ${params.sessionId}.` +
              (warnings.length ? `\nWarnings:\n- ${warnings.join("\n- ")}` : ""),
          );
        }

        case "submit": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          await writeToStdin(resolved.stdin, "\r");
          return runningSessionResult(
            resolved.session,
            `Submitted session ${params.sessionId} (sent CR).`,
          );
        }

        case "paste": {
          const resolved = resolveBackgroundedWritableStdin();
          if (!resolved.ok) {
            return resolved.result;
          }
          const payload = encodePaste(params.text ?? "", params.bracketed !== false);
          if (!payload) {
            return {
              content: [
                {
                  text: "No paste text provided.",
                  type: "text",
                },
              ],
              details: { status: "failed" },
            };
          }
          await writeToStdin(resolved.stdin, payload);
          return runningSessionResult(
            resolved.session,
            `Pasted ${params.text?.length ?? 0} chars to session ${params.sessionId}.`,
          );
        }

        case "kill": {
          if (!scopedSession) {
            return failText(`No active session found for ${params.sessionId}`);
          }
          if (!scopedSession.backgrounded) {
            return failText(`Session ${params.sessionId} is not backgrounded.`);
          }
          const canceled = cancelManagedSession(scopedSession.id);
          if (!canceled) {
            const terminated = terminateSessionFallback(scopedSession);
            if (!terminated) {
              return failText(
                `Unable to terminate session ${params.sessionId}: no active supervisor run or process id.`,
              );
            }
            markExited(scopedSession, null, "SIGKILL", "failed");
          }
          resetPollRetrySuggestion(params.sessionId);
          return {
            content: [
              {
                text: canceled
                  ? `Termination requested for session ${params.sessionId}.`
                  : `Killed session ${params.sessionId}.`,
                type: "text",
              },
            ],
            details: {
              name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
              status: "failed",
            },
          };
        }

        case "clear": {
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ text: `Cleared session ${params.sessionId}.`, type: "text" }],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                text: `No finished session found for ${params.sessionId}`,
                type: "text",
              },
            ],
            details: { status: "failed" },
          };
        }

        case "remove": {
          if (scopedSession) {
            const canceled = cancelManagedSession(scopedSession.id);
            if (canceled) {
              // Keep remove semantics deterministic: drop from process registry now.
              scopedSession.backgrounded = false;
              deleteSession(params.sessionId);
            } else {
              const terminated = terminateSessionFallback(scopedSession);
              if (!terminated) {
                return failText(
                  `Unable to remove session ${params.sessionId}: no active supervisor run or process id.`,
                );
              }
              markExited(scopedSession, null, "SIGKILL", "failed");
              deleteSession(params.sessionId);
            }
            resetPollRetrySuggestion(params.sessionId);
            return {
              content: [
                {
                  text: canceled
                    ? `Removed session ${params.sessionId} (termination requested).`
                    : `Removed session ${params.sessionId}.`,
                  type: "text",
                },
              ],
              details: {
                name: scopedSession ? deriveSessionName(scopedSession.command) : undefined,
                status: "failed",
              },
            };
          }
          if (scopedFinished) {
            resetPollRetrySuggestion(params.sessionId);
            deleteSession(params.sessionId);
            return {
              content: [{ text: `Removed session ${params.sessionId}.`, type: "text" }],
              details: { status: "completed" },
            };
          }
          return {
            content: [
              {
                text: `No session found for ${params.sessionId}`,
                type: "text",
              },
            ],
            details: { status: "failed" },
          };
        }
      }

      return {
        content: [{ text: `Unknown action ${params.action as string}`, type: "text" }],
        details: { status: "failed" },
      };
    },
    label: "process",
    name: "process",
    parameters: processSchema,
  };
}

export const processTool = createProcessTool();
