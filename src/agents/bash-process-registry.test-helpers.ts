import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { ProcessSession } from "./bash-process-registry.js";

export function createProcessSessionFixture(params: {
  id: string;
  command?: string;
  startedAt?: number;
  cwd?: string;
  maxOutputChars?: number;
  pendingMaxOutputChars?: number;
  backgrounded?: boolean;
  pid?: number;
  child?: ChildProcessWithoutNullStreams;
  cursorKeyMode?: ProcessSession["cursorKeyMode"];
}): ProcessSession {
  const session: ProcessSession = {
    aggregated: "",
    backgrounded: params.backgrounded ?? false,
    command: params.command ?? "test",
    cursorKeyMode: params.cursorKeyMode ?? "normal",
    cwd: params.cwd ?? "/tmp",
    exitCode: undefined,
    exitSignal: undefined,
    exited: false,
    id: params.id,
    maxOutputChars: params.maxOutputChars ?? 10_000,
    pendingMaxOutputChars: params.pendingMaxOutputChars ?? 30_000,
    pendingStderr: [],
    pendingStderrChars: 0,
    pendingStdout: [],
    pendingStdoutChars: 0,
    startedAt: params.startedAt ?? Date.now(),
    tail: "",
    totalOutputChars: 0,
    truncated: false,
  };
  if (params.pid !== undefined) {
    session.pid = params.pid;
  }
  if (params.child) {
    session.child = params.child;
  }
  return session;
}
