import { splitBatchRequests } from "./batch-utils.js";
import { runWithConcurrency } from "./internal.js";

export interface EmbeddingBatchExecutionParams {
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  concurrency: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
}

export async function runEmbeddingBatchGroups<TRequest>(params: {
  requests: TRequest[];
  maxRequests: number;
  wait: EmbeddingBatchExecutionParams["wait"];
  pollIntervalMs: EmbeddingBatchExecutionParams["pollIntervalMs"];
  timeoutMs: EmbeddingBatchExecutionParams["timeoutMs"];
  concurrency: EmbeddingBatchExecutionParams["concurrency"];
  debugLabel: string;
  debug?: EmbeddingBatchExecutionParams["debug"];
  runGroup: (args: {
    group: TRequest[];
    groupIndex: number;
    groups: number;
    byCustomId: Map<string, number[]>;
  }) => Promise<void>;
}): Promise<Map<string, number[]>> {
  if (params.requests.length === 0) {
    return new Map();
  }
  const groups = splitBatchRequests(params.requests, params.maxRequests);
  const byCustomId = new Map<string, number[]>();
  const tasks = groups.map((group, groupIndex) => async () => {
    await params.runGroup({ byCustomId, group, groupIndex, groups: groups.length });
  });

  params.debug?.(params.debugLabel, {
    concurrency: params.concurrency,
    groups: groups.length,
    pollIntervalMs: params.pollIntervalMs,
    requests: params.requests.length,
    timeoutMs: params.timeoutMs,
    wait: params.wait,
  });

  await runWithConcurrency(tasks, params.concurrency);
  return byCustomId;
}

export function buildEmbeddingBatchGroupOptions<TRequest>(
  params: { requests: TRequest[] } & EmbeddingBatchExecutionParams,
  options: { maxRequests: number; debugLabel: string },
) {
  return {
    concurrency: params.concurrency,
    debug: params.debug,
    debugLabel: options.debugLabel,
    maxRequests: options.maxRequests,
    pollIntervalMs: params.pollIntervalMs,
    requests: params.requests,
    timeoutMs: params.timeoutMs,
    wait: params.wait,
  };
}
