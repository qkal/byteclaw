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
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";

export interface OpenAiBatchRequest {
  custom_id: string;
  method: "POST";
  url: "/v1/embeddings";
  body: {
    model: string;
    input: string;
  };
}

export type OpenAiBatchStatus = EmbeddingBatchStatus;
export type OpenAiBatchOutputLine = ProviderBatchOutputLine;

export const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 50_000;

async function submitOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  requests: OpenAiBatchRequest[];
  agentId: string;
}): Promise<OpenAiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  const inputFileId = await uploadBatchJsonlFile({
    client: params.openAi,
    errorPrefix: "openai batch file upload failed",
    requests: params.requests,
  });

  return await postJsonWithRetry<OpenAiBatchStatus>({
    body: {
      completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
      endpoint: OPENAI_BATCH_ENDPOINT,
      input_file_id: inputFileId,
      metadata: {
        agent: params.agentId,
        source: "openclaw-memory",
      },
    },
    errorPrefix: "openai batch create failed",
    headers: buildBatchHeaders(params.openAi, { json: true }),
    ssrfPolicy: params.openAi.ssrfPolicy,
    url: `${baseUrl}/batches`,
  });
}

async function fetchOpenAiBatchStatus(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
}): Promise<OpenAiBatchStatus> {
  return await fetchOpenAiBatchResource({
    errorPrefix: "openai batch status",
    openAi: params.openAi,
    parse: async (res) => (await res.json()) as OpenAiBatchStatus,
    path: `/batches/${params.batchId}`,
  });
}

async function fetchOpenAiFileContent(params: {
  openAi: OpenAiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  return await fetchOpenAiBatchResource({
    errorPrefix: "openai batch file content",
    openAi: params.openAi,
    parse: async (res) => await res.text(),
    path: `/files/${params.fileId}/content`,
  });
}

async function fetchOpenAiBatchResource<T>(params: {
  openAi: OpenAiEmbeddingClient;
  path: string;
  errorPrefix: string;
  parse: (res: Response) => Promise<T>;
}): Promise<T> {
  const baseUrl = normalizeBatchBaseUrl(params.openAi);
  return await withRemoteHttpResponse({
    init: {
      headers: buildBatchHeaders(params.openAi, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`${params.errorPrefix} failed: ${res.status} ${text}`);
      }
      return await params.parse(res);
    },
    ssrfPolicy: params.openAi.ssrfPolicy,
    url: `${baseUrl}${params.path}`,
  });
}

function parseOpenAiBatchOutput(text: string): OpenAiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OpenAiBatchOutputLine);
}

async function readOpenAiBatchError(params: {
  openAi: OpenAiEmbeddingClient;
  errorFileId: string;
}): Promise<string | undefined> {
  try {
    const content = await fetchOpenAiFileContent({
      fileId: params.errorFileId,
      openAi: params.openAi,
    });
    const lines = parseOpenAiBatchOutput(content);
    return extractBatchErrorMessage(lines);
  } catch (error) {
    return formatUnavailableBatchError(error);
  }
}

async function waitForOpenAiBatch(params: {
  openAi: OpenAiEmbeddingClient;
  batchId: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: OpenAiBatchStatus;
}): Promise<BatchCompletionResult> {
  const start = Date.now();
  let current: OpenAiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchOpenAiBatchStatus({
        batchId: params.batchId,
        openAi: params.openAi,
      }));
    const state = status.status ?? "unknown";
    if (state === "completed") {
      return resolveBatchCompletionFromStatus({
        batchId: params.batchId,
        provider: "openai",
        status,
      });
    }
    await throwIfBatchTerminalFailure({
      provider: "openai",
      readError: async (errorFileId) =>
        await readOpenAiBatchError({
          errorFileId,
          openAi: params.openAi,
        }),
      status: { ...status, id: params.batchId },
    });
    if (!params.wait) {
      throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runOpenAiEmbeddingBatches(
  params: {
    openAi: OpenAiEmbeddingClient;
    agentId: string;
    requests: OpenAiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      debugLabel: "memory embeddings: openai batch submit",
      maxRequests: OPENAI_BATCH_MAX_REQUESTS,
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitOpenAiBatch({
        agentId: params.agentId,
        openAi: params.openAi,
        requests: group,
      });
      if (!batchInfo.id) {
        throw new Error("openai batch create failed: missing batch id");
      }
      const batchId = batchInfo.id;

      params.debug?.("memory embeddings: openai batch created", {
        batchId: batchInfo.id,
        group: groupIndex + 1,
        groups,
        requests: group.length,
        status: batchInfo.status,
      });

      const completed = await resolveCompletedBatchResult({
        provider: "openai",
        status: batchInfo,
        wait: params.wait,
        waitForBatch: async () =>
          await waitForOpenAiBatch({
            batchId,
            debug: params.debug,
            initial: batchInfo,
            openAi: params.openAi,
            pollIntervalMs: params.pollIntervalMs,
            timeoutMs: params.timeoutMs,
            wait: params.wait,
          }),
      });

      const content = await fetchOpenAiFileContent({
        fileId: completed.outputFileId,
        openAi: params.openAi,
      });
      const outputLines = parseOpenAiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        applyEmbeddingBatchOutputLine({ byCustomId, errors, line, remaining });
      }

      if (errors.length > 0) {
        throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(
          `openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`,
        );
      }
    },
  });
}
