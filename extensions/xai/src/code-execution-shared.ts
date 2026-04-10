import { postTrustedWebToolsJson } from "@openclaw/plugin-sdk/provider-web-search";
import {
  XAI_RESPONSES_ENDPOINT,
  buildXaiResponsesToolBody,
  resolveXaiResponseTextAndCitations,
} from "./responses-tool-shared.js";
import {
  coerceXaiToolConfig,
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";
import type { XaiWebSearchResponse } from "./web-search-shared.js";

export const XAI_CODE_EXECUTION_ENDPOINT = XAI_RESPONSES_ENDPOINT;
export const XAI_DEFAULT_CODE_EXECUTION_MODEL = "grok-4-1-fast";

export interface XaiCodeExecutionConfig {
  apiKey?: unknown;
  model?: unknown;
  maxTurns?: unknown;
}

export type XaiCodeExecutionResponse = XaiWebSearchResponse & {
  output?: {
    type?: string;
  }[];
};

export interface XaiCodeExecutionResult {
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
}

export function resolveXaiCodeExecutionConfig(
  config?: Record<string, unknown>,
): XaiCodeExecutionConfig {
  return coerceXaiToolConfig<XaiCodeExecutionConfig>(config);
}

export function resolveXaiCodeExecutionModel(config?: Record<string, unknown>): string {
  return resolveNormalizedXaiToolModel({
    config,
    defaultModel: XAI_DEFAULT_CODE_EXECUTION_MODEL,
  });
}

export function resolveXaiCodeExecutionMaxTurns(
  config?: Record<string, unknown>,
): number | undefined {
  return resolvePositiveIntegerToolConfig(config, "maxTurns");
}

export function buildXaiCodeExecutionPayload(params: {
  task: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
}): Record<string, unknown> {
  return {
    citations: params.citations,
    content: params.content,
    model: params.model,
    outputTypes: params.outputTypes,
    provider: "xai",
    task: params.task,
    tookMs: params.tookMs,
    usedCodeExecution: params.usedCodeExecution,
  };
}

export async function requestXaiCodeExecution(params: {
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxTurns?: number;
  task: string;
}): Promise<XaiCodeExecutionResult> {
  return await postTrustedWebToolsJson(
    {
      apiKey: params.apiKey,
      body: buildXaiResponsesToolBody({
        inputText: params.task,
        maxTurns: params.maxTurns,
        model: params.model,
        tools: [{ type: "code_interpreter" }],
      }),
      errorLabel: "xAI",
      timeoutSeconds: params.timeoutSeconds,
      url: XAI_CODE_EXECUTION_ENDPOINT,
    },
    async (response) => {
      const data = (await response.json()) as XaiCodeExecutionResponse;
      const { content, citations } = resolveXaiResponseTextAndCitations(data);
      const outputTypes = Array.isArray(data.output)
        ? [
            ...new Set(
              data.output
                .map((entry) => entry?.type)
                .filter((value): value is string => Boolean(value)),
            ),
          ]
        : [];
      return {
        citations,
        content,
        outputTypes,
        usedCodeExecution: outputTypes.includes("code_interpreter_call"),
      };
    },
  );
}

export const __testing = {
  XAI_DEFAULT_CODE_EXECUTION_MODEL,
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionConfig,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
} as const;
