import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import {
  inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin,
} from "../../plugins/provider-runtime.js";
import type { ProviderRuntimeModel } from "../../plugins/types.js";
import type { AnyAgentTool } from "../tools/common.js";
import { log } from "./logger.js";

interface ProviderToolSchemaParams<TSchemaType extends TSchema = TSchema, TResult = unknown> {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
}

function buildProviderToolSchemaContext<TSchemaType extends TSchema = TSchema, TResult = unknown>(
  params: ProviderToolSchemaParams<TSchemaType, TResult>,
  provider: string,
) {
  return {
    config: params.config,
    env: params.env,
    model: params.model,
    modelApi: params.modelApi,
    modelId: params.modelId,
    provider,
    tools: params.tools as unknown as AnyAgentTool[],
    workspaceDir: params.workspaceDir,
  };
}

/**
 * Runs provider-owned tool-schema normalization without encoding provider
 * families in the embedded runner.
 */
export function normalizeProviderToolSchemas<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: ProviderToolSchemaParams<TSchemaType, TResult>): AgentTool<TSchemaType, TResult>[] {
  const provider = params.provider.trim();
  const pluginNormalized = normalizeProviderToolSchemasWithPlugin({
    config: params.config,
    context: buildProviderToolSchemaContext(params, provider),
    env: params.env,
    provider,
    workspaceDir: params.workspaceDir,
  });
  return Array.isArray(pluginNormalized)
    ? (pluginNormalized as AgentTool<TSchemaType, TResult>[])
    : params.tools;
}

/**
 * Logs provider-owned tool-schema diagnostics after normalization.
 */
export function logProviderToolSchemaDiagnostics(params: ProviderToolSchemaParams): void {
  const provider = params.provider.trim();
  const diagnostics = inspectProviderToolSchemasWithPlugin({
    config: params.config,
    context: buildProviderToolSchemaContext(params, provider),
    env: params.env,
    provider,
    workspaceDir: params.workspaceDir,
  });
  if (!Array.isArray(diagnostics)) {
    return;
  }

  log.info("provider tool schema snapshot", {
    provider: params.provider,
    toolCount: params.tools.length,
    tools: params.tools.map((tool, index) => `${index}:${tool.name}`),
  });
  for (const diagnostic of diagnostics) {
    log.warn("provider tool schema diagnostic", {
      index: diagnostic.toolIndex,
      provider: params.provider,
      tool: diagnostic.toolName,
      violationCount: diagnostic.violations.length,
      violations: diagnostic.violations.slice(0, 12),
    });
  }
}
