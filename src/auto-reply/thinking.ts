import { normalizeProviderId } from "../agents/provider-id.js";
import {
  formatThinkingLevels as formatThinkingLevelsFallback,
  listThinkingLevelLabels as listThinkingLevelLabelsFallback,
  listThinkingLevels as listThinkingLevelsFallback,
  resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback,
} from "./thinking.shared.js";
import type { ThinkLevel, ThinkingCatalogEntry } from "./thinking.shared.js";
export {
  formatXHighModelHint,
  normalizeElevatedLevel,
  normalizeFastMode,
  normalizeNoticeLevel,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  normalizeUsageDisplay,
  normalizeVerboseLevel,
  resolveResponseUsageMode,
  resolveElevatedMode,
} from "./thinking.shared.js";
export type {
  ElevatedLevel,
  ElevatedMode,
  NoticeLevel,
  ReasoningLevel,
  ThinkLevel,
  ThinkingCatalogEntry,
  UsageDisplayLevel,
  VerboseLevel,
} from "./thinking.shared.js";
import {
  resolveProviderBinaryThinking,
  resolveProviderDefaultThinkingLevel,
  resolveProviderXHighThinking,
} from "../plugins/provider-thinking.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export function isBinaryThinkingProvider(provider?: string | null, model?: string | null): boolean {
  const providerRaw = normalizeOptionalString(provider);
  const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
  if (!normalizedProvider) {
    return false;
  }

  const pluginDecision = resolveProviderBinaryThinking({
    context: {
      modelId: normalizeOptionalString(model) ?? "",
      provider: normalizedProvider,
    },
    provider: normalizedProvider,
  });
  if (typeof pluginDecision === "boolean") {
    return pluginDecision;
  }
  return false;
}

export function supportsXHighThinking(provider?: string | null, model?: string | null): boolean {
  const modelKey = normalizeOptionalLowercaseString(model);
  if (!modelKey) {
    return false;
  }
  const providerRaw = normalizeOptionalString(provider);
  const providerKey = providerRaw ? normalizeProviderId(providerRaw) : "";
  if (providerKey) {
    const pluginDecision = resolveProviderXHighThinking({
      context: {
        modelId: modelKey,
        provider: providerKey,
      },
      provider: providerKey,
    });
    if (typeof pluginDecision === "boolean") {
      return pluginDecision;
    }
  }
  return false;
}

export function listThinkingLevels(provider?: string | null, model?: string | null): ThinkLevel[] {
  const levels = listThinkingLevelsFallback(provider, model);
  if (supportsXHighThinking(provider, model)) {
    levels.splice(-1, 0, "xhigh");
  }
  return levels;
}

export function listThinkingLevelLabels(provider?: string | null, model?: string | null): string[] {
  if (isBinaryThinkingProvider(provider, model)) {
    return ["off", "on"];
  }
  return listThinkingLevelLabelsFallback(provider, model);
}

export function formatThinkingLevels(
  provider?: string | null,
  model?: string | null,
  separator = ", ",
): string {
  return supportsXHighThinking(provider, model)
    ? listThinkingLevelLabels(provider, model).join(separator)
    : formatThinkingLevelsFallback(provider, model, separator);
}

export function resolveThinkingDefaultForModel(params: {
  provider: string;
  model: string;
  catalog?: ThinkingCatalogEntry[];
}): ThinkLevel {
  const normalizedProvider = normalizeProviderId(params.provider);
  const candidate = params.catalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const pluginDecision = resolveProviderDefaultThinkingLevel({
    context: {
      modelId: params.model,
      provider: normalizedProvider,
      reasoning: candidate?.reasoning,
    },
    provider: normalizedProvider,
  });
  if (pluginDecision) {
    return pluginDecision;
  }
  return resolveThinkingDefaultForModelFallback(params);
}
