import { type ModelCatalogEntry, loadModelCatalog } from "../../agents/model-catalog.js";
import {
  type ModelAliasIndex,
  buildAllowedModelSet,
  modelKey,
  normalizeProviderId,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import { type ModelDirectiveSelection, resolveModelDirectiveSelection } from "./model-selection.js";

interface ResetModelResult {
  selection?: ModelDirectiveSelection;
  cleanedBody?: string;
}

function splitBody(body: string) {
  const tokens = body.split(/\s+/).filter(Boolean);
  return {
    first: tokens[0],
    rest: tokens.slice(2),
    second: tokens[1],
    tokens,
  };
}

function buildSelectionFromExplicit(params: {
  raw: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  allowedModelKeys: Set<string>;
}): ModelDirectiveSelection | undefined {
  const resolved = resolveModelRefFromString({
    aliasIndex: params.aliasIndex,
    defaultProvider: params.defaultProvider,
    raw: params.raw,
  });
  if (!resolved) {
    return undefined;
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (params.allowedModelKeys.size > 0 && !params.allowedModelKeys.has(key)) {
    return undefined;
  }
  const isDefault =
    resolved.ref.provider === params.defaultProvider && resolved.ref.model === params.defaultModel;
  return {
    isDefault,
    model: resolved.ref.model,
    provider: resolved.ref.provider,
    ...(resolved.alias ? { alias: resolved.alias } : undefined),
  };
}

function applySelectionToSession(params: {
  selection: ModelDirectiveSelection;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
}) {
  const { selection, sessionEntry, sessionStore, sessionKey, storePath } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return;
  }
  const { updated } = applyModelOverrideToSessionEntry({
    entry: sessionEntry,
    selection,
  });
  if (!updated) {
    return;
  }
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    }).catch(() => {
      // Ignore persistence errors; session still proceeds.
    });
  }
}

export async function applyResetModelOverride(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  resetTriggered: boolean;
  bodyStripped?: string;
  sessionCtx: TemplateContext;
  ctx: MsgContext;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  defaultProvider: string;
  defaultModel: string;
  aliasIndex: ModelAliasIndex;
  modelCatalog?: ModelCatalogEntry[];
}): Promise<ResetModelResult> {
  if (!params.resetTriggered) {
    return {};
  }
  const rawBody = normalizeOptionalString(params.bodyStripped);
  if (!rawBody) {
    return {};
  }

  const { tokens, first, second } = splitBody(rawBody);
  if (!first) {
    return {};
  }

  const catalog = params.modelCatalog ?? (await loadModelCatalog({ config: params.cfg }));
  const allowed = buildAllowedModelSet({
    agentId: params.agentId,
    catalog,
    cfg: params.cfg,
    defaultModel: params.defaultModel,
    defaultProvider: params.defaultProvider,
  });
  const allowedModelKeys = allowed.allowedKeys;
  if (allowedModelKeys.size === 0) {
    return {};
  }

  const providers = new Set<string>();
  for (const key of allowedModelKeys) {
    const slash = key.indexOf("/");
    if (slash <= 0) {
      continue;
    }
    providers.add(normalizeProviderId(key.slice(0, slash)));
  }

  const resolveSelection = (raw: string) =>
    resolveModelDirectiveSelection({
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
      defaultModel: params.defaultModel,
      defaultProvider: params.defaultProvider,
      raw,
    });

  let selection: ModelDirectiveSelection | undefined;
  let consumed = 0;

  if (providers.has(normalizeProviderId(first)) && second) {
    const composite = `${normalizeProviderId(first)}/${second}`;
    const resolved = resolveSelection(composite);
    if (resolved.selection) {
      ({ selection } = resolved);
      consumed = 2;
    }
  }

  if (!selection) {
    selection = buildSelectionFromExplicit({
      aliasIndex: params.aliasIndex,
      allowedModelKeys,
      defaultModel: params.defaultModel,
      defaultProvider: params.defaultProvider,
      raw: first,
    });
    if (selection) {
      consumed = 1;
    }
  }

  if (!selection) {
    const resolved = resolveSelection(first);
    const allowFuzzy = providers.has(normalizeProviderId(first)) || first.trim().length >= 6;
    if (allowFuzzy) {
      ({ selection } = resolved);
      if (selection) {
        consumed = 1;
      }
    }
  }

  if (!selection) {
    return {};
  }

  const cleanedBody = tokens.slice(consumed).join(" ").trim();
  params.sessionCtx.BodyStripped = cleanedBody;
  params.sessionCtx.BodyForCommands = cleanedBody;

  applySelectionToSession({
    selection,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
  });

  return { cleanedBody, selection };
}
