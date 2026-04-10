import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { shouldSuppressBuiltInModel } from "../../agents/model-suppression.js";
import { normalizeProviderId } from "../../agents/provider-id.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadModelRegistry, toModelRow } from "./list.registry.js";
import { loadModelCatalog, resolveModelWithRegistry } from "./list.runtime.js";
import type { ConfiguredEntry, ModelRow } from "./list.types.js";
import { isLocalBaseUrl, modelKey } from "./shared.js";

type ConfiguredByKey = Map<string, ConfiguredEntry>;

interface RowFilter {
  provider?: string;
  local?: boolean;
}

interface RowBuilderContext {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  availableKeys?: Set<string>;
  configuredByKey: ConfiguredByKey;
  discoveredKeys: Set<string>;
  filter: RowFilter;
}

function matchesRowFilter(filter: RowFilter, model: { provider: string; baseUrl?: string }) {
  if (filter.provider && normalizeProviderId(model.provider) !== filter.provider) {
    return false;
  }
  if (filter.local && !isLocalBaseUrl(model.baseUrl ?? "")) {
    return false;
  }
  return true;
}

function buildRow(params: {
  model: Model<Api>;
  key: string;
  context: RowBuilderContext;
  allowProviderAvailabilityFallback?: boolean;
}): ModelRow {
  const configured = params.context.configuredByKey.get(params.key);
  return toModelRow({
    aliases: configured?.aliases ?? [],
    allowProviderAvailabilityFallback: params.allowProviderAvailabilityFallback ?? false,
    authStore: params.context.authStore,
    availableKeys: params.context.availableKeys,
    cfg: params.context.cfg,
    key: params.key,
    model: params.model,
    tags: configured ? [...configured.tags] : [],
  });
}

export async function loadListModelRegistry(
  cfg: OpenClawConfig,
  opts?: { sourceConfig?: OpenClawConfig },
) {
  const loaded = await loadModelRegistry(cfg, opts);
  return {
    ...loaded,
    discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id))),
  };
}

export function appendDiscoveredRows(params: {
  rows: ModelRow[];
  models: Model<Api>[];
  context: RowBuilderContext;
}): Set<string> {
  const seenKeys = new Set<string>();
  const sorted = [...params.models].toSorted((a, b) => {
    const providerCompare = a.provider.localeCompare(b.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    return a.id.localeCompare(b.id);
  });

  for (const model of sorted) {
    if (
      shouldSuppressBuiltInModel({
        baseUrl: model.baseUrl,
        config: params.context.cfg,
        id: model.id,
        provider: model.provider,
      })
    ) {
      continue;
    }
    if (!matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    params.rows.push(
      buildRow({
        context: params.context,
        key,
        model,
      }),
    );
    seenKeys.add(key);
  }

  return seenKeys;
}

export async function appendCatalogSupplementRows(params: {
  rows: ModelRow[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
  seenKeys: Set<string>;
}): Promise<void> {
  const catalog = await loadModelCatalog({ config: params.context.cfg });
  for (const entry of catalog) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const key = modelKey(entry.provider, entry.id);
    if (params.seenKeys.has(key)) {
      continue;
    }
    const model = resolveModelWithRegistry({
      cfg: params.context.cfg,
      modelId: entry.id,
      modelRegistry: params.modelRegistry,
      provider: entry.provider,
    });
    if (!model || !matchesRowFilter(params.context.filter, model)) {
      continue;
    }
    if (
      shouldSuppressBuiltInModel({
        baseUrl: model.baseUrl,
        config: params.context.cfg,
        id: model.id,
        provider: model.provider,
      })
    ) {
      continue;
    }
    params.rows.push(
      buildRow({
        allowProviderAvailabilityFallback: !params.context.discoveredKeys.has(key),
        context: params.context,
        key,
        model,
      }),
    );
    params.seenKeys.add(key);
  }
}

export function appendConfiguredRows(params: {
  rows: ModelRow[];
  entries: ConfiguredEntry[];
  modelRegistry: ModelRegistry;
  context: RowBuilderContext;
}) {
  for (const entry of params.entries) {
    if (
      params.context.filter.provider &&
      normalizeProviderId(entry.ref.provider) !== params.context.filter.provider
    ) {
      continue;
    }
    const model = resolveModelWithRegistry({
      cfg: params.context.cfg,
      modelId: entry.ref.model,
      modelRegistry: params.modelRegistry,
      provider: entry.ref.provider,
    });
    if (params.context.filter.local && model && !isLocalBaseUrl(model.baseUrl ?? "")) {
      continue;
    }
    if (params.context.filter.local && !model) {
      continue;
    }
    if (
      model &&
      shouldSuppressBuiltInModel({
        baseUrl: model.baseUrl,
        config: params.context.cfg,
        id: model.id,
        provider: model.provider,
      })
    ) {
      continue;
    }
    params.rows.push(
      toModelRow({
        aliases: entry.aliases,
        allowProviderAvailabilityFallback: model
          ? !params.context.discoveredKeys.has(modelKey(model.provider, model.id))
          : false,
        authStore: params.context.authStore,
        availableKeys: params.context.availableKeys,
        cfg: params.context.cfg,
        key: entry.key,
        model,
        tags: [...entry.tags],
      }),
    );
  }
}
