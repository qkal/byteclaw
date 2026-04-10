import { resolveAuthStorePathForDisplay } from "../../agents/auth-profiles.js";
import {
  type ModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { shortenHomePath } from "../../utils.js";
import { resolveSelectedAndActiveModel } from "../model-runtime.js";
import type { ReplyPayload } from "../types.js";
import { resolveModelsCommandReply } from "./commands-models.js";
import {
  type ModelAuthDetailMode,
  formatAuthLabel,
  resolveAuthLabel,
} from "./directive-handling.auth.js";
import {
  type ModelPickerCatalogEntry,
  resolveProviderEndpointLabel,
} from "./directive-handling.model-picker.js";
export { resolveModelSelectionFromDirective } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

function pushUniqueCatalogEntry(params: {
  keys: Set<string>;
  out: ModelPickerCatalogEntry[];
  provider: string;
  id: string;
  name?: string;
  fallbackNameToId: boolean;
}) {
  const provider = normalizeProviderId(params.provider);
  const id = normalizeOptionalString(params.id) ?? "";
  if (!provider || !id) {
    return;
  }
  const key = modelKey(provider, id);
  if (params.keys.has(key)) {
    return;
  }
  params.keys.add(key);
  params.out.push({
    id,
    name: params.fallbackNameToId ? (params.name ?? id) : params.name,
    provider,
  });
}

function buildModelPickerCatalog(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: { provider: string; id?: string; name?: string }[];
}): ModelPickerCatalogEntry[] {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultModel: params.defaultModel,
    defaultProvider: params.defaultProvider,
  });

  const buildConfiguredCatalog = (): ModelPickerCatalogEntry[] => {
    const out: ModelPickerCatalogEntry[] = [];
    const keys = new Set<string>();

    const pushRef = (ref: { provider: string; model: string }, name?: string) => {
      pushUniqueCatalogEntry({
        fallbackNameToId: true,
        id: ref.model,
        keys,
        name,
        out,
        provider: ref.provider,
      });
    };

    const pushRaw = (raw?: string) => {
      const value = normalizeOptionalString(raw) ?? "";
      if (!value) {
        return;
      }
      const resolved = resolveModelRefFromString({
        aliasIndex: params.aliasIndex,
        defaultProvider: params.defaultProvider,
        raw: value,
      });
      if (!resolved) {
        return;
      }
      pushRef(resolved.ref);
    };

    pushRef(resolvedDefault);

    const modelConfig = params.cfg.agents?.defaults?.model;
    const modelFallbacks =
      modelConfig && typeof modelConfig === "object" ? (modelConfig.fallbacks ?? []) : [];
    for (const fallback of modelFallbacks) {
      pushRaw(String(fallback ?? ""));
    }

    const imageConfig = params.cfg.agents?.defaults?.imageModel;
    if (imageConfig && typeof imageConfig === "object") {
      pushRaw(imageConfig.primary);
      for (const fallback of imageConfig.fallbacks ?? []) {
        pushRaw(String(fallback ?? ""));
      }
    }

    for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
      pushRaw(raw);
    }

    return out;
  };

  const keys = new Set<string>();
  const out: ModelPickerCatalogEntry[] = [];

  const push = (entry: ModelPickerCatalogEntry) => {
    pushUniqueCatalogEntry({
      fallbackNameToId: false,
      id: String(entry.id ?? ""),
      keys,
      name: entry.name,
      out,
      provider: entry.provider,
    });
  };

  const hasAllowlist = Object.keys(params.cfg.agents?.defaults?.models ?? {}).length > 0;
  if (!hasAllowlist) {
    for (const entry of params.allowedModelCatalog) {
      push({
        id: entry.id ?? "",
        name: entry.name,
        provider: entry.provider,
      });
    }
    for (const entry of buildConfiguredCatalog()) {
      push(entry);
    }
    return out;
  }

  // Prefer catalog entries (when available), but always merge in config-only
  // Allowlist entries. This keeps custom providers/models visible in /model.
  for (const entry of params.allowedModelCatalog) {
    push({
      id: entry.id ?? "",
      name: entry.name,
      provider: entry.provider,
    });
  }

  // Merge any configured allowlist keys that the catalog doesn't know about.
  for (const raw of Object.keys(params.cfg.agents?.defaults?.models ?? {})) {
    const resolved = resolveModelRefFromString({
      aliasIndex: params.aliasIndex,
      defaultProvider: params.defaultProvider,
      raw: String(raw),
    });
    if (!resolved) {
      continue;
    }
    push({
      id: resolved.ref.model,
      name: resolved.ref.model,
      provider: resolved.ref.provider,
    });
  }

  // Ensure the configured default is always present (even when no allowlist).
  if (resolvedDefault.model) {
    push({
      id: resolvedDefault.model,
      name: resolvedDefault.model,
      provider: resolvedDefault.provider,
    });
  }

  return out;
}

export async function maybeHandleModelDirectiveInfo(params: {
  directives: InlineDirectives;
  cfg: OpenClawConfig;
  agentDir: string;
  activeAgentId: string;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelCatalog: { provider: string; id?: string; name?: string }[];
  resetModelOverride: boolean;
  surface?: string;
  sessionEntry?: Pick<SessionEntry, "modelProvider" | "model">;
}): Promise<ReplyPayload | undefined> {
  if (!params.directives.hasModelDirective) {
    return undefined;
  }

  const rawDirective = normalizeOptionalString(params.directives.rawModelDirective);
  const directive = rawDirective ? normalizeLowercaseStringOrEmpty(rawDirective) : undefined;
  const wantsStatus = directive === "status";
  const wantsSummary = !rawDirective;
  const wantsLegacyList = directive === "list";
  if (!wantsSummary && !wantsStatus && !wantsLegacyList) {
    return undefined;
  }

  if (params.directives.rawModelProfile) {
    return { text: "Auth profile override requires a model selection." };
  }

  const pickerCatalog = buildModelPickerCatalog({
    aliasIndex: params.aliasIndex,
    allowedModelCatalog: params.allowedModelCatalog,
    cfg: params.cfg,
    defaultModel: params.defaultModel,
    defaultProvider: params.defaultProvider,
  });

  if (wantsLegacyList) {
    const reply = await resolveModelsCommandReply({
      cfg: params.cfg,
      commandBodyNormalized: "/models",
    });
    return reply ?? { text: "No models available." };
  }

  if (wantsSummary) {
    const modelRefs = resolveSelectedAndActiveModel({
      selectedModel: params.model,
      selectedProvider: params.provider,
      sessionEntry: params.sessionEntry,
    });
    const current = modelRefs.selected.label;
    const activeRuntimeLine = modelRefs.activeDiffers
      ? `Active: ${modelRefs.active.label} (runtime)`
      : null;
    const commandPlugin = params.surface ? getChannelPlugin(params.surface) : null;
    const channelData = commandPlugin?.commands?.buildModelBrowseChannelData?.();
    if (channelData) {
      return {
        channelData,
        text: [
          `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
          activeRuntimeLine,
          "",
          "Tap below to browse models, or use:",
          "/model <provider/model> to switch",
          "/model status for details",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    return {
      text: [
        `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
        activeRuntimeLine,
        "",
        "Switch: /model <provider/model>",
        "Browse: /models (providers) or /models <provider> (models)",
        "More: /model status",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  const modelsPath = `${params.agentDir}/models.json`;
  const formatPath = (value: string) => shortenHomePath(value);
  const authMode: ModelAuthDetailMode = "verbose";
  if (pickerCatalog.length === 0) {
    return { text: "No models available." };
  }

  const authByProvider = new Map<string, string>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    if (authByProvider.has(provider)) {
      continue;
    }
    const auth = await resolveAuthLabel(
      provider,
      params.cfg,
      modelsPath,
      params.agentDir,
      authMode,
    );
    authByProvider.set(provider, formatAuthLabel(auth));
  }

  const modelRefs = resolveSelectedAndActiveModel({
    selectedModel: params.model,
    selectedProvider: params.provider,
    sessionEntry: params.sessionEntry,
  });
  const current = modelRefs.selected.label;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  const lines = [
    `Current: ${current}${modelRefs.activeDiffers ? " (selected)" : ""}`,
    modelRefs.activeDiffers ? `Active: ${modelRefs.active.label} (runtime)` : null,
    `Default: ${defaultLabel}`,
    `Agent: ${params.activeAgentId}`,
    `Auth file: ${formatPath(resolveAuthStorePathForDisplay(params.agentDir))}`,
  ].filter((line): line is string => Boolean(line));
  if (params.resetModelOverride) {
    lines.push(`(previous selection reset to default)`);
  }

  const byProvider = new Map<string, ModelPickerCatalogEntry[]>();
  for (const entry of pickerCatalog) {
    const provider = normalizeProviderId(entry.provider);
    const models = byProvider.get(provider);
    if (models) {
      models.push(entry);
      continue;
    }
    byProvider.set(provider, [entry]);
  }

  for (const provider of byProvider.keys()) {
    const models = byProvider.get(provider);
    if (!models) {
      continue;
    }
    const authLabel = authByProvider.get(provider) ?? "missing";
    const endpoint = resolveProviderEndpointLabel(provider, params.cfg);
    const endpointSuffix = endpoint.endpoint
      ? ` endpoint: ${endpoint.endpoint}`
      : " endpoint: default";
    const apiSuffix = endpoint.api ? ` api: ${endpoint.api}` : "";
    lines.push("");
    lines.push(`[${provider}]${endpointSuffix}${apiSuffix} auth: ${authLabel}`);
    for (const entry of models) {
      const label = `${provider}/${entry.id}`;
      const aliases = params.aliasIndex.byKey.get(label);
      const aliasSuffix = aliases && aliases.length > 0 ? ` (${aliases.join(", ")})` : "";
      lines.push(`  • ${label}${aliasSuffix}`);
    }
  }
  return { text: lines.join("\n") };
}
