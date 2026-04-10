import { ensureAuthProfileStore, listProfilesForProvider } from "../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../agents/model-auth.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
} from "../agents/model-selection.js";
import { formatTokenK } from "../commands/models/shared.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { applyPrimaryModel } from "../plugins/provider-model-primary.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import type { ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

export { applyPrimaryModel } from "../plugins/provider-model-primary.js";

const KEEP_VALUE = "__keep__";
const MANUAL_VALUE = "__manual__";
const PROVIDER_FILTER_THRESHOLD = 30;

// Internal router models are valid defaults during auth/setup but not manual API targets.
const HIDDEN_ROUTER_MODELS = new Set(["openrouter/auto"]);

export interface PromptDefaultModelParams {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  allowKeep?: boolean;
  includeManual?: boolean;
  includeProviderPluginSetups?: boolean;
  ignoreAllowlist?: boolean;
  preferredProvider?: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeEnv;
  message?: string;
}

export interface PromptDefaultModelResult {
  model?: string;
  config?: OpenClawConfig;
}
export interface PromptModelAllowlistResult {
  models?: string[];
}

async function loadModelPickerRuntime() {
  return import("../commands/model-picker.runtime.js");
}

const loadResolvedModelPickerRuntime = createLazyRuntimeSurface(
  loadModelPickerRuntime,
  ({ modelPickerRuntime }) => modelPickerRuntime,
);

function hasAuthForProvider(
  provider: string,
  cfg: OpenClawConfig,
  store: ReturnType<typeof ensureAuthProfileStore>,
) {
  if (listProfilesForProvider(store, provider).length > 0) {
    return true;
  }
  if (resolveEnvApiKey(provider)) {
    return true;
  }
  if (hasUsableCustomProviderApiKey(cfg, provider)) {
    return true;
  }
  return false;
}

function createProviderAuthChecker(params: {
  cfg: OpenClawConfig;
  agentDir?: string;
}): (provider: string) => boolean {
  const authStore = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const authCache = new Map<string, boolean>();
  return (provider: string) => {
    const cached = authCache.get(provider);
    if (cached !== undefined) {
      return cached;
    }
    const value = hasAuthForProvider(provider, params.cfg, authStore);
    authCache.set(provider, value);
    return value;
  };
}

function resolveConfiguredModelRaw(cfg: OpenClawConfig): string {
  return resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model) ?? "";
}

function resolveConfiguredModelKeys(cfg: OpenClawConfig): string[] {
  const models = cfg.agents?.defaults?.models ?? {};
  return Object.keys(models)
    .map((key) => String(key ?? "").trim())
    .filter((key) => key.length > 0);
}

function normalizeModelKeys(values: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const value = String(raw ?? "").trim();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    next.push(value);
  }
  return next;
}

function resolveModelRouteHint(provider: string): string | undefined {
  const normalized = normalizeProviderId(provider);
  if (normalized === "openai") {
    return "API key route";
  }
  if (normalized === "openai-codex") {
    return "ChatGPT OAuth route";
  }
  return undefined;
}

function addModelSelectOption(params: {
  entry: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
  };
  options: WizardSelectOption[];
  seen: Set<string>;
  aliasIndex: ReturnType<typeof buildModelAliasIndex>;
  hasAuth: (provider: string) => boolean;
}) {
  const key = modelKey(params.entry.provider, params.entry.id);
  if (params.seen.has(key) || HIDDEN_ROUTER_MODELS.has(key)) {
    return;
  }
  const hints: string[] = [];
  if (params.entry.name && params.entry.name !== params.entry.id) {
    hints.push(params.entry.name);
  }
  if (params.entry.contextWindow) {
    hints.push(`ctx ${formatTokenK(params.entry.contextWindow)}`);
  }
  if (params.entry.reasoning) {
    hints.push("reasoning");
  }
  const aliases = params.aliasIndex.byKey.get(key);
  if (aliases?.length) {
    hints.push(`alias: ${aliases.join(", ")}`);
  }
  const routeHint = resolveModelRouteHint(params.entry.provider);
  if (routeHint) {
    hints.push(routeHint);
  }
  if (!params.hasAuth(params.entry.provider)) {
    hints.push("auth missing");
  }
  params.options.push({
    hint: hints.length > 0 ? hints.join(" · ") : undefined,
    label: key,
    value: key,
  });
  params.seen.add(key);
}

function createPreferredProviderMatcher(params: {
  preferredProvider: string;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): (entryProvider: string) => boolean {
  const normalizedPreferredProvider = normalizeProviderId(params.preferredProvider);
  const preferredOwnerPluginIds = resolveOwningPluginIdsForProvider({
    config: params.cfg,
    env: params.env,
    provider: normalizedPreferredProvider,
    workspaceDir: params.workspaceDir,
  });
  const preferredOwnerPluginIdSet = preferredOwnerPluginIds
    ? new Set(preferredOwnerPluginIds)
    : undefined;
  const entryProviderCache = new Map<string, boolean>();
  return (entryProvider: string) => {
    const normalizedEntryProvider = normalizeProviderId(entryProvider);
    if (normalizedEntryProvider === normalizedPreferredProvider) {
      return true;
    }
    const cached = entryProviderCache.get(normalizedEntryProvider);
    if (cached !== undefined) {
      return cached;
    }
    const value =
      Boolean(preferredOwnerPluginIdSet) &&
      Boolean(
        resolveOwningPluginIdsForProvider({
          config: params.cfg,
          env: params.env,
          provider: normalizedEntryProvider,
          workspaceDir: params.workspaceDir,
        })?.some((pluginId) => preferredOwnerPluginIdSet.has(pluginId)),
      );
    entryProviderCache.set(normalizedEntryProvider, value);
    return value;
  };
}

async function promptManualModel(params: {
  prompter: WizardPrompter;
  allowBlank: boolean;
  initialValue?: string;
}): Promise<PromptDefaultModelResult> {
  const modelInput = await params.prompter.text({
    initialValue: params.initialValue,
    message: params.allowBlank ? "Default model (blank to keep)" : "Default model",
    placeholder: "provider/model",
    validate: params.allowBlank
      ? undefined
      : (value) => (normalizeOptionalString(value) ? undefined : "Required"),
  });
  const model = String(modelInput ?? "").trim();
  if (!model) {
    return {};
  }
  return { model };
}

function buildModelProviderFilterOptions(
  models: { provider: string }[],
): { value: string; label: string; hint: string }[] {
  const providerIds = [...new Set(models.map((entry) => entry.provider))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  return providerIds.map((provider) => {
    const count = models.filter((entry) => entry.provider === provider).length;
    return {
      hint: `${count} model${count === 1 ? "" : "s"}`,
      label: provider,
      value: provider,
    };
  });
}

async function maybeFilterModelsByProvider(params: {
  models: {
    provider: string;
    id: string;
    name?: string;
    contextWindow?: number;
    reasoning?: boolean;
  }[];
  preferredProvider?: string;
  prompter: WizardPrompter;
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<typeof params.models> {
  const providerIds = [...new Set(params.models.map((entry) => entry.provider))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const hasPreferredProvider = Boolean(params.preferredProvider);
  const shouldPromptProvider =
    !hasPreferredProvider &&
    providerIds.length > 1 &&
    params.models.length > PROVIDER_FILTER_THRESHOLD;
  let next = params.models;
  const matchesPreferredProvider = params.preferredProvider
    ? createPreferredProviderMatcher({
        cfg: params.cfg,
        env: params.env,
        preferredProvider: params.preferredProvider,
        workspaceDir: params.workspaceDir,
      })
    : undefined;
  if (shouldPromptProvider) {
    const selection = await params.prompter.select({
      message: "Filter models by provider",
      options: [{ label: "All providers", value: "*" }, ...buildModelProviderFilterOptions(next)],
    });
    if (selection !== "*") {
      next = next.filter((entry) => entry.provider === selection);
    }
  }
  if (hasPreferredProvider && params.preferredProvider) {
    const filtered = next.filter((entry) => matchesPreferredProvider?.(entry.provider));
    if (filtered.length > 0) {
      next = filtered;
    }
  }
  return next;
}

async function resolveProviderPluginSetupOptions(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<WizardSelectOption[]> {
  const runtime = await loadResolvedModelPickerRuntime();
  const providerModelPickerOptions =
    "resolveProviderModelPickerContributions" in runtime &&
    typeof runtime.resolveProviderModelPickerContributions === "function"
      ? runtime
          .resolveProviderModelPickerContributions({
            config: params.cfg,
            env: params.env,
            workspaceDir: params.workspaceDir,
          })
          .map((contribution) => contribution.option)
      : runtime.resolveProviderModelPickerEntries({
          config: params.cfg,
          env: params.env,
          workspaceDir: params.workspaceDir,
        });
  return providerModelPickerOptions.map((entry) =>
    Object.assign(
      { value: entry.value, label: entry.label },
      entry.hint ? { hint: entry.hint } : {},
    ),
  );
}

async function maybeHandleProviderPluginSelection(params: {
  selection: string;
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtime?: RuntimeEnv;
}): Promise<PromptDefaultModelResult | null> {
  let pluginResolution: string | null = null;
  let pluginProviders: ProviderPlugin[] = [];
  if (params.selection.startsWith("provider-plugin:")) {
    pluginResolution = params.selection;
  } else if (!params.selection.includes("/")) {
    const { resolvePluginProviders } = await loadResolvedModelPickerRuntime();
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      env: params.env,
      mode: "setup",
      workspaceDir: params.workspaceDir,
    });
    pluginResolution = pluginProviders.some(
      (provider) => normalizeProviderId(provider.id) === normalizeProviderId(params.selection),
    )
      ? params.selection
      : null;
  }
  if (!pluginResolution) {
    return null;
  }
  if (!params.agentDir || !params.runtime) {
    await params.prompter.note(
      "Provider setup requires agent and runtime context.",
      "Provider setup unavailable",
    );
    return {};
  }
  const {
    resolvePluginProviders,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    runProviderPluginAuthMethod,
  } = await loadResolvedModelPickerRuntime();
  if (pluginProviders.length === 0) {
    pluginProviders = resolvePluginProviders({
      config: params.cfg,
      env: params.env,
      mode: "setup",
      workspaceDir: params.workspaceDir,
    });
  }
  const resolved = resolveProviderPluginChoice({
    choice: pluginResolution,
    providers: pluginProviders,
  });
  if (!resolved) {
    return {};
  }
  const applied = await runProviderPluginAuthMethod({
    agentDir: params.agentDir,
    config: params.cfg,
    method: resolved.method,
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
  });
  if (applied.defaultModel) {
    await runProviderModelSelectedHook({
      agentDir: params.agentDir,
      config: applied.config,
      env: params.env,
      model: applied.defaultModel,
      prompter: params.prompter,
      workspaceDir: params.workspaceDir,
    });
  }
  return { config: applied.config, model: applied.defaultModel };
}

export async function promptDefaultModel(
  params: PromptDefaultModelParams,
): Promise<PromptDefaultModelResult> {
  const cfg = params.config;
  const allowKeep = params.allowKeep ?? true;
  const includeManual = params.includeManual ?? true;
  const includeProviderPluginSetups = params.includeProviderPluginSetups ?? false;
  const ignoreAllowlist = params.ignoreAllowlist ?? false;
  const preferredProviderRaw = normalizeOptionalString(params.preferredProvider);
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const configuredRaw = resolveConfiguredModelRaw(cfg);
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const configuredKey = configuredRaw ? resolvedKey : "";

  const catalog = await loadModelCatalog({ config: cfg, useCache: false });
  if (catalog.length === 0) {
    return promptManualModel({
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
      prompter: params.prompter,
    });
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const models = ignoreAllowlist
    ? catalog
    : (() => {
        const { allowedCatalog } = buildAllowedModelSet({
          catalog,
          cfg,
          defaultProvider: DEFAULT_PROVIDER,
        });
        return allowedCatalog.length > 0 ? allowedCatalog : catalog;
      })();
  if (models.length === 0) {
    return promptManualModel({
      allowBlank: allowKeep,
      initialValue: configuredRaw || resolvedKey || undefined,
      prompter: params.prompter,
    });
  }

  const filteredModels = await maybeFilterModelsByProvider({
    cfg,
    env: params.env,
    models,
    preferredProvider,
    prompter: params.prompter,
    workspaceDir: params.workspaceDir,
  });
  const matchesPreferredProvider = preferredProvider
    ? createPreferredProviderMatcher({
        cfg,
        env: params.env,
        preferredProvider,
        workspaceDir: params.workspaceDir,
      })
    : undefined;
  const hasPreferredProvider = preferredProvider
    ? filteredModels.some((entry) => matchesPreferredProvider?.(entry.provider))
    : false;
  const hasAuth = createProviderAuthChecker({ agentDir: params.agentDir, cfg });

  const options: WizardSelectOption[] = [];
  if (allowKeep) {
    options.push({
      hint:
        configuredRaw && configuredRaw !== resolvedKey ? `resolves to ${resolvedKey}` : undefined,
      label: configuredRaw
        ? `Keep current (${configuredRaw})`
        : `Keep current (default: ${resolvedKey})`,
      value: KEEP_VALUE,
    });
  }
  if (includeManual) {
    options.push({ label: "Enter model manually", value: MANUAL_VALUE });
  }
  if (includeProviderPluginSetups && params.agentDir) {
    options.push(
      ...(await resolveProviderPluginSetupOptions({
        cfg,
        env: params.env,
        workspaceDir: params.workspaceDir,
      })),
    );
  }

  const seen = new Set<string>();
  for (const entry of filteredModels) {
    addModelSelectOption({ aliasIndex, entry, hasAuth, options, seen });
  }
  if (configuredKey && !seen.has(configuredKey)) {
    options.push({
      hint: "current (not in catalog)",
      label: configuredKey,
      value: configuredKey,
    });
  }

  let initialValue: string | undefined = allowKeep ? KEEP_VALUE : configuredKey || undefined;
  if (
    allowKeep &&
    hasPreferredProvider &&
    preferredProvider &&
    !matchesPreferredProvider?.(resolved.provider)
  ) {
    const firstModel = filteredModels[0];
    if (firstModel) {
      initialValue = modelKey(firstModel.provider, firstModel.id);
    }
  }

  const selection = await params.prompter.select({
    initialValue,
    message: params.message ?? "Default model",
    options,
  });
  if (selection === KEEP_VALUE) {
    return {};
  }
  if (selection === MANUAL_VALUE) {
    return promptManualModel({
      allowBlank: false,
      initialValue: configuredRaw || resolvedKey || undefined,
      prompter: params.prompter,
    });
  }

  const providerPluginResult = await maybeHandleProviderPluginSelection({
    agentDir: params.agentDir,
    cfg,
    env: params.env,
    prompter: params.prompter,
    runtime: params.runtime,
    selection: String(selection),
    workspaceDir: params.workspaceDir,
  });
  if (providerPluginResult) {
    return providerPluginResult;
  }

  const model = String(selection);
  const { runProviderModelSelectedHook } = await loadResolvedModelPickerRuntime();
  await runProviderModelSelectedHook({
    agentDir: params.agentDir,
    config: cfg,
    env: params.env,
    model,
    prompter: params.prompter,
    workspaceDir: params.workspaceDir,
  });
  return { model };
}

export async function promptModelAllowlist(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  message?: string;
  agentDir?: string;
  allowedKeys?: string[];
  initialSelections?: string[];
  preferredProvider?: string;
}): Promise<PromptModelAllowlistResult> {
  const cfg = params.config;
  const existingKeys = resolveConfiguredModelKeys(cfg);
  const allowedKeys = normalizeModelKeys(params.allowedKeys ?? []);
  const allowedKeySet = allowedKeys.length > 0 ? new Set(allowedKeys) : null;
  const preferredProviderRaw = normalizeOptionalString(params.preferredProvider);
  const preferredProvider = preferredProviderRaw
    ? normalizeProviderId(preferredProviderRaw)
    : undefined;
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  const initialSeeds = normalizeModelKeys([
    ...existingKeys,
    resolvedKey,
    ...(params.initialSelections ?? []),
  ]);
  const initialKeys = allowedKeySet
    ? initialSeeds.filter((key) => allowedKeySet.has(key))
    : initialSeeds;

  const catalog = await loadModelCatalog({ config: cfg, useCache: false });
  if (catalog.length === 0 && allowedKeys.length === 0) {
    const raw = await params.prompter.text({
      initialValue: existingKeys.join(", "),
      message:
        params.message ??
        "Allowlist models (comma-separated provider/model; blank to keep current)",
      placeholder: "provider/model, other-provider/model",
    });
    const parsed = String(raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    if (parsed.length === 0) {
      return {};
    }
    return { models: normalizeModelKeys(parsed) };
  }

  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const hasAuth = createProviderAuthChecker({ agentDir: params.agentDir, cfg });
  const matchesPreferredProvider = preferredProvider
    ? createPreferredProviderMatcher({
        cfg,
        preferredProvider,
      })
    : undefined;

  const options: WizardSelectOption[] = [];
  const seen = new Set<string>();
  const allowedCatalog = allowedKeySet
    ? catalog.filter((entry) => allowedKeySet.has(modelKey(entry.provider, entry.id)))
    : catalog;
  const filteredCatalog =
    preferredProvider && allowedCatalog.some((entry) => matchesPreferredProvider?.(entry.provider))
      ? allowedCatalog.filter((entry) => matchesPreferredProvider?.(entry.provider))
      : allowedCatalog;

  for (const entry of filteredCatalog) {
    addModelSelectOption({ aliasIndex, entry, hasAuth, options, seen });
  }

  const supplementalKeys = allowedKeySet ? allowedKeys : existingKeys;
  for (const key of supplementalKeys) {
    if (seen.has(key)) {
      continue;
    }
    options.push({
      hint: allowedKeySet ? "allowed (not in catalog)" : "configured (not in catalog)",
      label: key,
      value: key,
    });
    seen.add(key);
  }
  if (options.length === 0) {
    return {};
  }

  const selection = await params.prompter.multiselect({
    initialValues: initialKeys.length > 0 ? initialKeys : undefined,
    message: params.message ?? "Models in /model picker (multi-select)",
    options,
    searchable: true,
  });
  const selected = normalizeModelKeys(selection.map((value) => String(value)));
  if (selected.length > 0) {
    return { models: selected };
  }
  if (existingKeys.length === 0) {
    return { models: [] };
  }
  const confirmClear = await params.prompter.confirm({
    initialValue: false,
    message: "Clear the model allowlist? (shows all models)",
  });
  if (!confirmClear) {
    return {};
  }
  return { models: [] };
}

export function applyModelAllowlist(cfg: OpenClawConfig, models: string[]): OpenClawConfig {
  const defaults = cfg.agents?.defaults;
  const normalized = normalizeModelKeys(models);
  if (normalized.length === 0) {
    if (!defaults?.models) {
      return cfg;
    }
    const { models: _ignored, ...restDefaults } = defaults;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: restDefaults,
      },
    };
  }

  const existingModels = defaults?.models ?? {};
  const nextModels: Record<string, { alias?: string }> = {};
  for (const key of normalized) {
    nextModels[key] = existingModels[key] ?? {};
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        models: nextModels,
      },
    },
  };
}

export function applyModelFallbacksFromSelection(
  cfg: OpenClawConfig,
  selection: string[],
): OpenClawConfig {
  const normalized = normalizeModelKeys(selection);
  if (normalized.length <= 1) {
    return cfg;
  }

  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultModel: DEFAULT_MODEL,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const resolvedKey = modelKey(resolved.provider, resolved.model);
  if (!normalized.includes(resolvedKey)) {
    return cfg;
  }

  const defaults = cfg.agents?.defaults;
  const existingModel = defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? existingModel.primary
        : undefined;

  const fallbacks = normalized.filter((key) => key !== resolvedKey);
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        model: {
          ...(typeof existingModel === "object" ? existingModel : undefined),
          fallbacks,
          primary: existingPrimary ?? resolvedKey,
        },
      },
    },
  };
}
