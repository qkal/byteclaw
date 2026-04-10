import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { extractAssistantText, stripToolMessages } from "./tools/chat-history-text.js";

type GatewayCaller = typeof callGateway;

const defaultRunWaitDeps = {
  callGateway,
};

let runWaitDeps: {
  callGateway: GatewayCaller;
} = defaultRunWaitDeps;

export interface AssistantReplySnapshot {
  text?: string;
  fingerprint?: string;
}

export interface AgentWaitResult {
  status: "ok" | "timeout" | "error";
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

export interface AgentRunsDrainResult {
  timedOut: boolean;
  pendingRunIds: string[];
  deadlineAtMs: number;
}

interface RawAgentWaitResponse {
  status?: string;
  error?: string;
  startedAt?: unknown;
  endedAt?: unknown;
}

function normalizeAgentWaitResult(
  status: AgentWaitResult["status"],
  wait?: RawAgentWaitResponse,
): AgentWaitResult {
  return {
    endedAt: typeof wait?.endedAt === "number" ? wait.endedAt : undefined,
    error: typeof wait?.error === "string" ? wait.error : undefined,
    startedAt: typeof wait?.startedAt === "number" ? wait.startedAt : undefined,
    status,
  };
}

function normalizePendingRunIds(runIds: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const runId of runIds) {
    const normalized = runId.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
  }
  return [...seen];
}

function resolveLatestAssistantReplySnapshot(messages: unknown[]): AssistantReplySnapshot {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const candidate = messages[i];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractAssistantText(candidate);
    if (!text?.trim()) {
      continue;
    }
    let fingerprint: string | undefined;
    try {
      fingerprint = JSON.stringify(candidate);
    } catch {
      fingerprint = text;
    }
    return { fingerprint, text };
  }
  return {};
}

export async function readLatestAssistantReplySnapshot(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<AssistantReplySnapshot> {
  const history = await (params.callGateway ?? runWaitDeps.callGateway)<{
    messages: unknown[];
  }>({
    method: "chat.history",
    params: { limit: params.limit ?? 50, sessionKey: params.sessionKey },
  });
  return resolveLatestAssistantReplySnapshot(
    stripToolMessages(Array.isArray(history?.messages) ? history.messages : []),
  );
}

export async function readLatestAssistantReply(params: {
  sessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<string | undefined> {
  return (
    await readLatestAssistantReplySnapshot({
      callGateway: params.callGateway,
      limit: params.limit,
      sessionKey: params.sessionKey,
    })
  ).text;
}

export async function waitForAgentRun(params: {
  runId: string;
  timeoutMs: number;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult> {
  const timeoutMs = Math.max(1, Math.floor(params.timeoutMs));
  try {
    const wait = await (params.callGateway ?? runWaitDeps.callGateway)<RawAgentWaitResponse>({
      method: "agent.wait",
      params: {
        runId: params.runId,
        timeoutMs,
      },
      timeoutMs: timeoutMs + 2000,
    });
    if (wait?.status === "timeout") {
      return normalizeAgentWaitResult("timeout", wait);
    }
    if (wait?.status === "error") {
      return normalizeAgentWaitResult("error", wait);
    }
    return normalizeAgentWaitResult("ok", wait);
  } catch (error) {
    const error = formatErrorMessage(error);
    return {
      error,
      status: error.includes("gateway timeout") ? "timeout" : "error",
    };
  }
}

export async function waitForAgentRunAndReadUpdatedAssistantReply(params: {
  runId: string;
  sessionKey: string;
  timeoutMs: number;
  limit?: number;
  baseline?: AssistantReplySnapshot;
  callGateway?: GatewayCaller;
}): Promise<AgentWaitResult & { replyText?: string }> {
  const wait = await waitForAgentRun({
    callGateway: params.callGateway,
    runId: params.runId,
    timeoutMs: params.timeoutMs,
  });
  if (wait.status !== "ok") {
    return wait;
  }

  const latestReply = await readLatestAssistantReplySnapshot({
    callGateway: params.callGateway,
    limit: params.limit,
    sessionKey: params.sessionKey,
  });
  const baselineFingerprint = params.baseline?.fingerprint;
  const replyText =
    latestReply.text && (!baselineFingerprint || latestReply.fingerprint !== baselineFingerprint)
      ? latestReply.text
      : undefined;
  return {
    replyText,
    status: "ok",
  };
}

export async function waitForAgentRunsToDrain(params: {
  getPendingRunIds: () => Iterable<string>;
  initialPendingRunIds?: Iterable<string>;
  timeoutMs?: number;
  deadlineAtMs?: number;
  callGateway?: GatewayCaller;
}): Promise<AgentRunsDrainResult> {
  const deadlineAtMs =
    params.deadlineAtMs ?? Date.now() + Math.max(1, Math.floor(params.timeoutMs ?? 0));

  // Runs may finish and spawn more runs, so refresh until no pending IDs remain.
  let pendingRunIds = new Set<string>(
    normalizePendingRunIds(params.initialPendingRunIds ?? params.getPendingRunIds()),
  );

  while (pendingRunIds.size > 0 && Date.now() < deadlineAtMs) {
    const remainingMs = Math.max(1, deadlineAtMs - Date.now());
    await Promise.allSettled(
      [...pendingRunIds].map((runId) =>
        waitForAgentRun({
          callGateway: params.callGateway,
          runId,
          timeoutMs: remainingMs,
        }),
      ),
    );
    pendingRunIds = new Set<string>(normalizePendingRunIds(params.getPendingRunIds()));
  }

  return {
    deadlineAtMs,
    pendingRunIds: [...pendingRunIds],
    timedOut: pendingRunIds.size > 0,
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<{ callGateway: GatewayCaller }>) {
    runWaitDeps = overrides
      ? {
          ...defaultRunWaitDeps,
          ...overrides,
        }
      : defaultRunWaitDeps;
  },
};
