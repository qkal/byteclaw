import type { z } from "zod";
import { hasEnvHttpProxyConfigured } from "../infra/net/proxy-env.js";
import { runPassiveAccountLifecycle } from "./channel-lifecycle.core.js";
import { createLoggerBackedRuntime } from "./runtime-logger.js";
export { safeParseJsonWithSchema, safeParseWithSchema } from "../utils/zod-parse.js";

interface PassiveChannelStatusSnapshot {
  configured?: boolean;
  running?: boolean;
  lastStartAt?: number | null;
  lastStopAt?: number | null;
  lastError?: string | null;
  probe?: unknown;
  lastProbeAt?: number | null;
}

interface TrafficStatusSnapshot {
  lastInboundAt?: number | null;
  lastOutboundAt?: number | null;
}

interface StoppableMonitor {
  stop: () => void;
}

type RequireOpenAllowFromFn = (params: {
  policy?: string;
  allowFrom?: (string | number)[];
  ctx: z.RefinementCtx;
  path: (string | number)[];
  message: string;
}) => void;

export function buildPassiveChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    configured: snapshot.configured ?? false,
    ...(extra ?? ({} as TExtra)),
    running: snapshot.running ?? false,
    lastStartAt: snapshot.lastStartAt ?? null,
    lastStopAt: snapshot.lastStopAt ?? null,
    lastError: snapshot.lastError ?? null,
  };
}

export function buildPassiveProbedChannelStatusSummary<TExtra extends object>(
  snapshot: PassiveChannelStatusSnapshot,
  extra?: TExtra,
) {
  return {
    ...buildPassiveChannelStatusSummary(snapshot, extra),
    lastProbeAt: snapshot.lastProbeAt ?? null,
    probe: snapshot.probe,
  };
}

export function buildTrafficStatusSummary<TSnapshot extends TrafficStatusSnapshot>(
  snapshot?: TSnapshot | null,
) {
  return {
    lastInboundAt: snapshot?.lastInboundAt ?? null,
    lastOutboundAt: snapshot?.lastOutboundAt ?? null,
  };
}

export async function runStoppablePassiveMonitor<TMonitor extends StoppableMonitor>(params: {
  abortSignal: AbortSignal;
  start: () => Promise<TMonitor>;
}): Promise<void> {
  await runPassiveAccountLifecycle({
    abortSignal: params.abortSignal,
    start: params.start,
    stop: async (monitor) => {
      monitor.stop();
    },
  });
}

export function resolveLoggerBackedRuntime<TRuntime>(
  runtime: TRuntime | undefined,
  logger: Parameters<typeof createLoggerBackedRuntime>[0]["logger"],
): TRuntime {
  return (
    runtime ??
    (createLoggerBackedRuntime({
      exitError: () => new Error("Runtime exit not available"),
      logger,
    }) as TRuntime)
  );
}

export function requireChannelOpenAllowFrom(params: {
  channel: string;
  policy?: string;
  allowFrom?: (string | number)[];
  ctx: z.RefinementCtx;
  requireOpenAllowFrom: RequireOpenAllowFromFn;
}) {
  params.requireOpenAllowFrom({
    allowFrom: params.allowFrom,
    ctx: params.ctx,
    message: `channels.${params.channel}.dmPolicy="open" requires channels.${params.channel}.allowFrom to include "*"`,
    path: ["allowFrom"],
    policy: params.policy,
  });
}

export function readStatusIssueFields<TField extends string>(
  value: unknown,
  fields: readonly TField[],
): Record<TField, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result = {} as Record<TField, unknown>;
  for (const field of fields) {
    result[field] = record[field];
  }
  return result;
}

export function coerceStatusIssueAccountId(value: unknown): string | undefined {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : undefined;
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export async function resolveAmbientNodeProxyAgent<TAgent>(params?: {
  onError?: (error: unknown) => void;
  onUsingProxy?: () => void;
  protocol?: "http" | "https";
}): Promise<TAgent | undefined> {
  if (!hasEnvHttpProxyConfigured(params?.protocol ?? "https")) {
    return undefined;
  }
  try {
    const { ProxyAgent } = await import("proxy-agent");
    params?.onUsingProxy?.();
    return new ProxyAgent() as TAgent;
  } catch (error) {
    params?.onError?.(error);
    return undefined;
  }
}
