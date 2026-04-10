import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { parseModelRef } from "../../agents/model-selection.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveConfiguredEntries } from "./list.configured.js";
import { formatErrorWithStack } from "./list.errors.js";
import {
  appendCatalogSupplementRows,
  appendConfiguredRows,
  appendDiscoveredRows,
  loadListModelRegistry,
} from "./list.rows.js";
import { printModelTable } from "./list.table.js";
import type { ModelRow } from "./list.types.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

export async function modelsListCommand(
  opts: {
    all?: boolean;
    local?: boolean;
    provider?: string;
    json?: boolean;
    plain?: boolean;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const { ensureAuthProfileStore, ensureOpenClawModelsJson } = await import("./list.runtime.js");
  const { sourceConfig, resolvedConfig: cfg } = await loadModelsConfigWithSource({
    commandName: "models list",
    runtime,
  });
  const authStore = ensureAuthProfileStore();
  const providerFilter = (() => {
    const raw = opts.provider?.trim();
    if (!raw) {
      return undefined;
    }
    const parsed = parseModelRef(`${raw}/_`, DEFAULT_PROVIDER);
    return parsed?.provider ?? normalizeLowercaseStringOrEmpty(raw);
  })();

  let modelRegistry: ModelRegistry | undefined;
  let discoveredKeys = new Set<string>();
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  try {
    // Keep command behavior explicit: sync models.json from the source config
    // Before building the read-only model registry view.
    await ensureOpenClawModelsJson(sourceConfig ?? cfg);
    const loaded = await loadListModelRegistry(cfg, { sourceConfig });
    modelRegistry = loaded.registry;
    ({ discoveredKeys } = loaded);
    ({ availableKeys } = loaded);
    ({ availabilityErrorMessage } = loaded);
  } catch (error) {
    runtime.error(`Model registry unavailable:\n${formatErrorWithStack(error)}`);
    process.exitCode = 1;
    return;
  }
  if (availabilityErrorMessage !== undefined) {
    runtime.error(
      `Model availability lookup failed; falling back to auth heuristics for discovered models: ${availabilityErrorMessage}`,
    );
  }
  const { entries } = resolveConfiguredEntries(cfg);
  const configuredByKey = new Map(entries.map((entry) => [entry.key, entry]));

  const rows: ModelRow[] = [];
  const rowContext = {
    authStore,
    availableKeys,
    cfg,
    configuredByKey,
    discoveredKeys,
    filter: {
      local: opts.local,
      provider: providerFilter,
    },
  };

  if (opts.all) {
    const seenKeys = appendDiscoveredRows({
      context: rowContext,
      models: modelRegistry?.getAll() ?? [],
      rows,
    });

    if (modelRegistry) {
      await appendCatalogSupplementRows({
        context: rowContext,
        modelRegistry,
        rows,
        seenKeys,
      });
    }
  } else {
    const registry = modelRegistry;
    if (!registry) {
      runtime.error("Model registry unavailable.");
      process.exitCode = 1;
      return;
    }
    appendConfiguredRows({
      context: rowContext,
      entries,
      modelRegistry: registry,
      rows,
    });
  }

  if (rows.length === 0) {
    runtime.log("No models found.");
    return;
  }

  printModelTable(rows, runtime, opts);
}
