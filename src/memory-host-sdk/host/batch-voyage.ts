import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import {
  type BatchCompletionResult,
  EMBEDDING_BATCH_ENDPOINT,
  type EmbeddingBatchExecutionParams,
  type EmbeddingBatchStatus,
  type ProviderBatchOutputLine,
  applyEmbeddingBatchOutputLine,
  buildBatchHeaders,
  buildEmbeddingBatchGroupOptions,
  extractBatchErrorMessage,
  formatUnavailableBatchError,
  normalizeBatchBaseUrl,
  postJsonWithRetry,
  resolveBatchCompletionFromStatus,
  resolveCompletedBatchResult,
  runEmbeddingBatchGroups,
  throwIfBatchTerminalFailure,
  uploadBatchJsonlFile,
  withRemoteHttpResponse,
} from "./batch-embedding-common.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";

/**
 * Voyage Batch API Input Line format.
 * See: https://docs.voyageai.com/docs/batch-inference
 */
export interface VoyageBatchRequest {
  custom_id: string;
  body: {
    input: string | string[];
  };
}

export type VoyageBatchStatus = EmbeddingBatchStatus;
export type VoyageBatchOutputLine = ProviderBatchOutputLine;

export const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 50_000;

interface VoyageBatchDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  postJsonWithRetry: typeof postJsonWithRetry;
  uploadBatchJsonlFile: typeof uploadBatchJsonlFile;
  withRemoteHttpResponse: typeof withRemoteHttpResponse;
}

function resolveVoyageBatchDeps(overrides: Partial<VoyageBatchDeps> | undefined): VoyageBatchDeps {
  return {
    now: overrides?.now ?? Date.now,
    postJsonWithRetry: overrides?.postJsonWithRetry ?? postJsonWithRetry,
    sleep:
      overrides?.sleep ??
      (async (ms: number) => await new Promise((resolve) => setTimeout(resolve, ms))),
    uploadBatchJsonlFile: overrides?.uploadBatchJsonlFile ?? uploadBatchJsonlFile,
    withRemoteHttpResponse: overrides?.withRemoteHttpResponse ?? withRemoteHttpResponse,
  };
}

async function assertVoyageResponseOk(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${context}: ${res.status} ${text}`);
  }
}

function buildVoyageBatchRequest<T>(params: {
  client: VoyageEmbeddingClient;
  path: string;
  onResponse: (res: Response) => Promise<T>;
}) {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  return {
    init: {
      headers: buildBatchHeaders(params.client, { json: true }),
    },
    onResponse: params.onResponse,
    ssrfPolicy: params.client.ssrfPolicy,
    url: `${baseUrl}/${params.path}`,
  };
}

async function submitVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  requests: VoyageBatchRequest[];
  agentId: string;
  deps: VoyageBatchDeps;
}): Promise<VoyageBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.client);
  const inputFileId = await params.deps.uploadBatchJsonlFile({
    client: params.client,
    errorPrefix: "voyage batch file upload failed",
    requests: params.requests,
  });

  // 2. Create batch job using Voyage Batches API
  return await params.deps.postJsonWithRetry<VoyageBatchStatus>({
    body: {
      completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
      endpoint: VOYAGE_BATCH_ENDPOINT,
      input_file_id: inputFileId,
      metadata: {
        agent: params.agentId,
        source: "clawdbot-memory",
      },
      request_params: {
        input_type: "document",
        model: params.client.model,
      },
    },
    errorPrefix: "voyage batch create failed",
    headers: buildBatchHeaders(params.client, { json: true }),
    ssrfPolicy: params.client.ssrfPolicy,
    url: `${baseUrl}/batches`,
  });
}

async function fetchVoyageBatchStatus(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  deps: VoyageBatchDeps;
}): Promise<VoyageBatchStatus> {
  return await params.deps.withRemoteHttpResponse(
    buildVoyageBatchRequest({
      client: params.client,
      onResponse: async (res) => {
        await assertVoyageResponseOk(res, "voyage batch status failed");
        return (await res.json()) as VoyageBatchStatus;
      },
      path: `batches/${params.batchId}`,
    }),
  );
}

async function readVoyageBatchError(params: {
  client: VoyageEmbeddingClient;
  errorFileId: string;
  deps: VoyageBatchDeps;
}): Promise<string | undefined> {
  try {
    return await params.deps.withRemoteHttpResponse(
      buildVoyageBatchRequest({
        client: params.client,
        onResponse: async (res) => {
          await assertVoyageResponseOk(res, "voyage batch error file content failed");
          const text = await res.text();
          if (!text.trim()) {
            return undefined;
          }
          const lines = text
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as VoyageBatchOutputLine);
          return extractBatchErrorMessage(lines);
        },
        path: `files/${params.errorFileId}/content`,
      }),
    );
  } catch (error) {
    return formatUnavailableBatchError(error);
  }
}

async function waitForVoyageBatch(params: {
  client: VoyageEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: VoyageBatchStatus;
  deps: VoyageBatchDeps;
}): Promise<BatchCompletionResult> {
  const start = params.deps.now();
  let current: VoyageBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchVoyageBatchStatus({
        batchId: params.batchId,
        client: params.client,
        deps: params.deps,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        batchId: params.batchId,
        provider: "voyage",
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "voyage",
      readError: async (errorFileId) =>
        await readVoyageBatchError({
          client: params.client,
          deps: params.deps,
          errorFileId,
        }),
      status: { ...status, id: params.batchId },
    });
    if (!params.wait) {
      throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (params.deps.now() - start > params.timeoutMs) {
      throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await params.deps.sleep(params.pollIntervalMs);
    current = undefined;
  }
}

export async function runVoyageEmbeddingBatches(
  params: {
    client: VoyageEmbeddingClient;
    agentId: string;
    requests: VoyageBatchRequest[];
    deps?: Partial<VoyageBatchDeps>;
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  const deps = resolveVoyageBatchDeps(params.deps);
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      debugLabel: "memory embeddings: voyage batch submit",
      maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitVoyageBatch({
        agentId: params.agentId,
        client: params.client,
        deps,
        requests: group,
      });
      if (!batchInfo.id) {
        throw new Error("voyage batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: voyage batch created", {
        batchId: batchInfo.id,
        group: groupIndex + 1,
        groups,
        requests: group.length,
        status: batchInfo.status,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "voyage",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForVoyageBatch({
            batchId,
            client: params.client,
            debug: params.debug,
            deps,
            initial: batchInfo,
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            wait: params.wait,
          }),
      });

      const baseUrl = normalizeBatchBaseUrl(params.client);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      await deps.withRemoteHttpResponse({
        init: {
          headers: buildBatchHeaders(params.client, { json: true }),
        },
        onResponse: async (contentRes) => {
          if (!contentRes.ok) {
            const text = await contentRes.text();
            throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
          }

          if (!contentRes.body) {
            return;
          }
          const reader = createInterface({
            input: Readable.fromWeb(
              contentRes.body as unknown as import("stream/web").ReadableStream,
            ),
            terminal: false,
          });

          for await (const rawLine of reader) {
            if (!rawLine.trim()) {
              continue;
            }
            const line = JSON.parse(rawLine) as VoyageBatchOutputLine;
            applyEmbeddingBatchOutputLine({ byCustomId, errors, line, remaining });
          }
        },
        ssrfPolicy: params.client.ssrfPolicy,
        url: `${baseUrl}/files/${completed.outputFileId}/content`,
      });

      if (errors.length > 0) {
        throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
