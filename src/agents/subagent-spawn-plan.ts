import { formatThinkingLevels, normalizeThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSubagentSpawnModelSelection } from "./model-selection.js";
import { readStringParam } from "./tools/common.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function splitModelRef(ref?: string) {
  if (!ref) {
    return { model: undefined, provider: undefined };
  }
  const trimmed = ref.trim();
  if (!trimmed) {
    return { model: undefined, provider: undefined };
  }
  const [provider, model] = trimmed.split("/", 2);
  if (model) {
    return { model, provider };
  }
  return { model: trimmed, provider: undefined };
}

export function resolveConfiguredSubagentRunTimeoutSeconds(params: {
  cfg: OpenClawConfig;
  runTimeoutSeconds?: number;
}) {
  const cfgSubagentTimeout =
    typeof params.cfg?.agents?.defaults?.subagents?.runTimeoutSeconds === "number" &&
    Number.isFinite(params.cfg.agents.defaults.subagents.runTimeoutSeconds)
      ? Math.max(0, Math.floor(params.cfg.agents.defaults.subagents.runTimeoutSeconds))
      : 0;
  return typeof params.runTimeoutSeconds === "number" && Number.isFinite(params.runTimeoutSeconds)
    ? Math.max(0, Math.floor(params.runTimeoutSeconds))
    : cfgSubagentTimeout;
}

export function resolveSubagentModelAndThinkingPlan(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentConfig?: unknown;
  modelOverride?: string;
  thinkingOverrideRaw?: string;
}) {
  const resolvedModel = resolveSubagentSpawnModelSelection({
    agentId: params.targetAgentId,
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });

  const targetSubagents = asRecord(asRecord(params.targetAgentConfig)?.subagents);
  const defaultSubagents = asRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    readStringParam(targetSubagents ?? {}, "thinking") ??
    readStringParam(defaultSubagents ?? {}, "thinking");

  const thinkingCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  if (!thinkingCandidateRaw) {
    return {
      initialSessionPatch: resolvedModel ? { model: resolvedModel } : {},
      modelApplied: Boolean(resolvedModel),
      resolvedModel,
      status: "ok" as const,
      thinkingOverride: undefined,
    };
  }

  const normalizedThinking = normalizeThinkLevel(thinkingCandidateRaw);
  if (!normalizedThinking) {
    const { provider, model } = splitModelRef(resolvedModel);
    const hint = formatThinkingLevels(provider, model);
    return {
      error: `Invalid thinking level "${thinkingCandidateRaw}". Use one of: ${hint}.`,
      resolvedModel,
      status: "error" as const,
    };
  }

  return {
    initialSessionPatch: {
      ...(resolvedModel ? { model: resolvedModel } : {}),
      thinkingLevel: normalizedThinking === "off" ? null : normalizedThinking,
    },
    modelApplied: Boolean(resolvedModel),
    resolvedModel,
    status: "ok" as const,
    thinkingOverride: normalizedThinking,
  };
}
