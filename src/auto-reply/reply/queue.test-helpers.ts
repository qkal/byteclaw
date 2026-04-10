import { afterAll, beforeAll } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import type { FollowupRun } from "./queue.js";

export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export function createQueueTestRun(params: {
  prompt: string;
  messageId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
}): FollowupRun {
  return {
    enqueuedAt: Date.now(),
    messageId: params.messageId,
    originatingAccountId: params.originatingAccountId,
    originatingChannel: params.originatingChannel,
    originatingThreadId: params.originatingThreadId,
    originatingTo: params.originatingTo,
    prompt: params.prompt,
    run: {
      agentDir: "/tmp",
      agentId: "agent",
      blockReplyBreak: "text_end",
      config: {} as OpenClawConfig,
      model: "gpt-test",
      provider: "openai",
      sessionFile: "/tmp/session.json",
      sessionId: "sess",
      timeoutMs: 10_000,
      workspaceDir: "/tmp",
    },
  };
}

export function installQueueRuntimeErrorSilencer(): void {
  let previousRuntimeError: typeof defaultRuntime.error;

  beforeAll(() => {
    previousRuntimeError = defaultRuntime.error;
    defaultRuntime.error = (() => {}) as typeof defaultRuntime.error;
  });

  afterAll(() => {
    defaultRuntime.error = previousRuntimeError;
  });
}
