import type { OpenClawConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";
import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  getModelRefStatus,
  loadModelCatalog,
  normalizeModelSelection,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveHooksGmailModel,
} from "./run.runtime.js";

interface CronSessionModelOverrides {
  modelOverride?: string;
  providerOverride?: string;
}

export interface ResolveCronModelSelectionParams {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  agentConfigOverride?: {
    model?: unknown;
    subagents?: {
      model?: unknown;
    };
  };
  sessionEntry: CronSessionModelOverrides;
  payload: CronJob["payload"];
  isGmailHook: boolean;
}

export type ResolveCronModelSelectionResult =
  | {
      ok: true;
      provider: string;
      model: string;
      warning?: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function resolveCronModelSelection(
  params: ResolveCronModelSelectionParams,
): Promise<ResolveCronModelSelectionResult> {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfgWithAgentDefaults,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
  });
  let {provider} = resolvedDefault;
  let {model} = resolvedDefault;

  let catalog: Awaited<ReturnType<typeof loadModelCatalog>> | undefined;
  const loadCatalogOnce = async () => {
    if (!catalog) {
      catalog = await loadModelCatalog({ config: params.cfgWithAgentDefaults });
    }
    return catalog;
  };

  const subagentModelRaw =
    normalizeModelSelection(params.agentConfigOverride?.subagents?.model) ??
    normalizeModelSelection(params.agentConfigOverride?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model);
  if (subagentModelRaw) {
    const resolvedSubagent = resolveAllowedModelRef({
      catalog: await loadCatalogOnce(),
      cfg: params.cfgWithAgentDefaults,
      defaultModel: resolvedDefault.model,
      defaultProvider: resolvedDefault.provider,
      raw: subagentModelRaw,
    });
    if (!("error" in resolvedSubagent)) {
      ({ provider } = resolvedSubagent.ref);
      ({ model } = resolvedSubagent.ref);
    }
  }

  let hooksGmailModelApplied = false;
  const hooksGmailModelRef = params.isGmailHook
    ? resolveHooksGmailModel({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
      })
    : null;
  if (hooksGmailModelRef) {
    const status = getModelRefStatus({
      catalog: await loadCatalogOnce(),
      cfg: params.cfg,
      defaultModel: resolvedDefault.model,
      defaultProvider: resolvedDefault.provider,
      ref: hooksGmailModelRef,
    });
    if (status.allowed) {
      ({ provider } = hooksGmailModelRef);
      ({ model } = hooksGmailModelRef);
      hooksGmailModelApplied = true;
    }
  }

  const modelOverrideRaw = params.payload.kind === "agentTurn" ? params.payload.model : undefined;
  const modelOverride = typeof modelOverrideRaw === "string" ? modelOverrideRaw.trim() : undefined;
  if (modelOverride !== undefined && modelOverride.length > 0) {
    const resolvedOverride = resolveAllowedModelRef({
      catalog: await loadCatalogOnce(),
      cfg: params.cfgWithAgentDefaults,
      defaultModel: resolvedDefault.model,
      defaultProvider: resolvedDefault.provider,
      raw: modelOverride,
    });
    if ("error" in resolvedOverride) {
      if (resolvedOverride.error.startsWith("model not allowed:")) {
        return {
          model,
          ok: true,
          provider,
          warning: `cron: payload.model '${modelOverride}' not allowed, falling back to agent defaults`,
        };
      }
      return { error: resolvedOverride.error, ok: false };
    }
    ({ provider } = resolvedOverride.ref);
    ({ model } = resolvedOverride.ref);
  }

  if (!modelOverride && !hooksGmailModelApplied) {
    const sessionModelOverride = params.sessionEntry.modelOverride?.trim();
    if (sessionModelOverride) {
      const sessionProviderOverride =
        params.sessionEntry.providerOverride?.trim() || resolvedDefault.provider;
      const resolvedSessionOverride = resolveAllowedModelRef({
        catalog: await loadCatalogOnce(),
        cfg: params.cfgWithAgentDefaults,
        defaultModel: resolvedDefault.model,
        defaultProvider: resolvedDefault.provider,
        raw: `${sessionProviderOverride}/${sessionModelOverride}`,
      });
      if (!("error" in resolvedSessionOverride)) {
        ({ provider } = resolvedSessionOverride.ref);
        ({ model } = resolvedSessionOverride.ref);
      }
    }
  }

  return { model, ok: true, provider };
}
