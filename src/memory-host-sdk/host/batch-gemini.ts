import {
  type EmbeddingBatchExecutionParams,
  buildEmbeddingBatchGroupOptions,
  runEmbeddingBatchGroups,
} from "./batch-runner.js";
import { buildBatchHeaders, normalizeBatchBaseUrl } from "./batch-utils.js";
import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import { debugEmbeddingsLog } from "./embeddings-debug.js";
import type { GeminiEmbeddingClient, GeminiTextEmbeddingRequest } from "./embeddings-gemini.js";
import { hashText } from "./internal.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export interface GeminiBatchRequest {
  custom_id: string;
  request: GeminiTextEmbeddingRequest;
}

export interface GeminiBatchStatus {
  name?: string;
  state?: string;
  outputConfig?: { file?: string; fileId?: string };
  metadata?: {
    output?: {
      responsesFile?: string;
    };
  };
  error?: { message?: string };
}

export interface GeminiBatchOutputLine {
  key?: string;
  custom_id?: string;
  request_id?: string;
  embedding?: { values?: number[] };
  response?: {
    embedding?: { values?: number[] };
    error?: { message?: string };
  };
  error?: { message?: string };
}

const GEMINI_BATCH_MAX_REQUESTS = 50_000;
function getGeminiUploadUrl(baseUrl: string): string {
  if (baseUrl.includes("/v1beta")) {
    return baseUrl.replace(/\/v1beta\/?$/, "/upload/v1beta");
  }
  return `${baseUrl.replace(/\/$/, "")}/upload`;
}

function buildGeminiUploadBody(params: { jsonl: string; displayName: string }): {
  body: Blob;
  contentType: string;
} {
  const boundary = `openclaw-${hashText(params.displayName)}`;
  const jsonPart = JSON.stringify({
    file: {
      displayName: params.displayName,
      mimeType: "application/jsonl",
    },
  });
  const delimiter = `--${boundary}\r\n`;
  const closeDelimiter = `--${boundary}--\r\n`;
  const parts = [
    `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
    `${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${params.jsonl}\r\n`,
    closeDelimiter,
  ];
  const body = new Blob([parts.join("")], { type: "multipart/related" });
  return {
    body,
    contentType: `multipart/related; boundary=${boundary}`,
  };
}

async function submitGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  requests: GeminiBatchRequest[];
  agentId: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const jsonl = params.requests
    .map((request) =>
      JSON.stringify({
        key: request.custom_id,
        request: request.request,
      }),
    )
    .join("\n");
  const displayName = `memory-embeddings-${hashText(String(Date.now()))}`;
  const uploadPayload = buildGeminiUploadBody({ displayName, jsonl });

  const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
  debugEmbeddingsLog("memory embeddings: gemini batch upload", {
    baseUrl,
    requests: params.requests.length,
    uploadUrl,
  });
  const filePayload = await withRemoteHttpResponse({
    init: {
      body: uploadPayload.body,
      headers: {
        ...buildBatchHeaders(params.gemini, { json: false }),
        "Content-Type": uploadPayload.contentType,
      },
      method: "POST",
    },
    onResponse: async (fileRes) => {
      if (!fileRes.ok) {
        const text = await fileRes.text();
        throw new Error(`gemini batch file upload failed: ${fileRes.status} ${text}`);
      }
      return (await fileRes.json()) as { name?: string; file?: { name?: string } };
    },
    ssrfPolicy: params.gemini.ssrfPolicy,
    url: uploadUrl,
  });
  const fileId = filePayload.name ?? filePayload.file?.name;
  if (!fileId) {
    throw new Error("gemini batch file upload failed: missing file id");
  }

  const batchBody = {
    batch: {
      displayName: `memory-embeddings-${params.agentId}`,
      inputConfig: {
        file_name: fileId,
      },
    },
  };

  const batchEndpoint = `${baseUrl}/${params.gemini.modelPath}:asyncBatchEmbedContent`;
  debugEmbeddingsLog("memory embeddings: gemini batch create", {
    batchEndpoint,
    fileId,
  });
  return await withRemoteHttpResponse({
    init: {
      body: JSON.stringify(batchBody),
      headers: buildBatchHeaders(params.gemini, { json: true }),
      method: "POST",
    },
    onResponse: async (batchRes) => {
      if (batchRes.ok) {
        return (await batchRes.json()) as GeminiBatchStatus;
      }
      const text = await batchRes.text();
      if (batchRes.status === 404) {
        throw new Error(
          "gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.",
        );
      }
      throw new Error(`gemini batch create failed: ${batchRes.status} ${text}`);
    },
    ssrfPolicy: params.gemini.ssrfPolicy,
    url: batchEndpoint,
  });
}

async function fetchGeminiBatchStatus(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
}): Promise<GeminiBatchStatus> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const name = params.batchName.startsWith("batches/")
    ? params.batchName
    : `batches/${params.batchName}`;
  const statusUrl = `${baseUrl}/${name}`;
  debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
  return await withRemoteHttpResponse({
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gemini batch status failed: ${res.status} ${text}`);
      }
      return (await res.json()) as GeminiBatchStatus;
    },
    ssrfPolicy: params.gemini.ssrfPolicy,
    url: statusUrl,
  });
}

async function fetchGeminiFileContent(params: {
  gemini: GeminiEmbeddingClient;
  fileId: string;
}): Promise<string> {
  const baseUrl = normalizeBatchBaseUrl(params.gemini);
  const file = params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`;
  const downloadUrl = `${baseUrl}/${file}:download`;
  debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
  return await withRemoteHttpResponse({
    init: {
      headers: buildBatchHeaders(params.gemini, { json: true }),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gemini batch file content failed: ${res.status} ${text}`);
      }
      return await res.text();
    },
    ssrfPolicy: params.gemini.ssrfPolicy,
    url: downloadUrl,
  });
}

function parseGeminiBatchOutput(text: string): GeminiBatchOutputLine[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GeminiBatchOutputLine);
}

async function waitForGeminiBatch(params: {
  gemini: GeminiEmbeddingClient;
  batchName: string;
  wait: boolean;
  pollIntervalMs: number;
  timeoutMs: number;
  debug?: (message: string, data?: Record<string, unknown>) => void;
  initial?: GeminiBatchStatus;
}): Promise<{ outputFileId: string }> {
  const start = Date.now();
  let current: GeminiBatchStatus | undefined = params.initial;
  while (true) {
    const status =
      current ??
      (await fetchGeminiBatchStatus({
        batchName: params.batchName,
        gemini: params.gemini,
      }));
    const state = status.state ?? "UNKNOWN";
    if (["SUCCEEDED", "COMPLETED", "DONE"].includes(state)) {
      const outputFileId =
        status.outputConfig?.file ??
        status.outputConfig?.fileId ??
        status.metadata?.output?.responsesFile;
      if (!outputFileId) {
        throw new Error(`gemini batch ${params.batchName} completed without output file`);
      }
      return { outputFileId };
    }
    if (["FAILED", "CANCELLED", "CANCELED", "EXPIRED"].includes(state)) {
      const message = status.error?.message ?? "unknown error";
      throw new Error(`gemini batch ${params.batchName} ${state}: ${message}`);
    }
    if (!params.wait) {
      throw new Error(`gemini batch ${params.batchName} still ${state}; wait disabled`);
    }
    if (Date.now() - start > params.timeoutMs) {
      throw new Error(`gemini batch ${params.batchName} timed out after ${params.timeoutMs}ms`);
    }
    params.debug?.(`gemini batch ${params.batchName} ${state}; waiting ${params.pollIntervalMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    current = undefined;
  }
}

export async function runGeminiEmbeddingBatches(
  params: {
    gemini: GeminiEmbeddingClient;
    agentId: string;
    requests: GeminiBatchRequest[];
  } & EmbeddingBatchExecutionParams,
): Promise<Map<string, number[]>> {
  return await runEmbeddingBatchGroups({
    ...buildEmbeddingBatchGroupOptions(params, {
      debugLabel: "memory embeddings: gemini batch submit",
      maxRequests: GEMINI_BATCH_MAX_REQUESTS,
    }),
    runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
      const batchInfo = await submitGeminiBatch({
        agentId: params.agentId,
        gemini: params.gemini,
        requests: group,
      });
      const batchName = batchInfo.name ?? "";
      if (!batchName) {
        throw new Error("gemini batch create failed: missing batch name");
      }

      params.debug?.("memory embeddings: gemini batch created", {
        batchName,
        group: groupIndex + 1,
        groups,
        requests: group.length,
        state: batchInfo.state,
      });

      if (
        !params.wait &&
        batchInfo.state &&
        !["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
      ) {
        throw new Error(
          `gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`,
        );
      }

      const completed =
        batchInfo.state && ["SUCCEEDED", "COMPLETED", "DONE"].includes(batchInfo.state)
          ? {
              outputFileId:
                batchInfo.outputConfig?.file ??
                batchInfo.outputConfig?.fileId ??
                batchInfo.metadata?.output?.responsesFile ??
                "",
            }
          : await waitForGeminiBatch({
              batchName,
              debug: params.debug,
              gemini: params.gemini,
              initial: batchInfo,
              pollIntervalMs: params.pollIntervalMs,
              timeoutMs: params.timeoutMs,
              wait: params.wait,
            });
      if (!completed.outputFileId) {
        throw new Error(`gemini batch ${batchName} completed without output file`);
      }

      const content = await fetchGeminiFileContent({
        fileId: completed.outputFileId,
        gemini: params.gemini,
      });
      const outputLines = parseGeminiBatchOutput(content);
      const errors: string[] = [];
      const remaining = new Set(group.map((request) => request.custom_id));

      for (const line of outputLines) {
        const customId = line.key ?? line.custom_id ?? line.request_id;
        if (!customId) {
          continue;
        }
        remaining.delete(customId);
        if (line.error?.message) {
          errors.push(`${customId}: ${line.error.message}`);
          continue;
        }
        if (line.response?.error?.message) {
          errors.push(`${customId}: ${line.response.error.message}`);
          continue;
        }
        const embedding = sanitizeAndNormalizeEmbedding(
          line.embedding?.values ?? line.response?.embedding?.values ?? [],
        );
        if (embedding.length === 0) {
          errors.push(`${customId}: empty embedding`);
          continue;
        }
        byCustomId.set(customId, embedding);
      }

      if (errors.length > 0) {
        throw new Error(`gemini batch ${batchName} failed: ${errors.join("; ")}`);
      }
      if (remaining.size > 0) {
        throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
      }
    },
  });
}
