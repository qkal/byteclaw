import {
  CLAUDE_CLI_PROFILE_ID,
  type OpenClawConfig,
  type ProviderAuthResult,
} from "openclaw/plugin-sdk/provider-auth";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  readClaudeCliCredentialsForSetup,
  readClaudeCliCredentialsForSetupNonInteractive,
} from "./cli-auth-seam.js";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
} from "./cli-shared.js";

type AgentDefaultsModel = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["model"];
type AgentDefaultsModels = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
type ClaudeCliCredential = NonNullable<ReturnType<typeof readClaudeCliCredentialsForSetup>>;

function toClaudeCliModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith("anthropic/")) {
    return null;
  }
  const modelId = trimmed.slice("anthropic/".length).trim();
  if (!normalizeLowercaseStringOrEmpty(modelId).startsWith("claude-")) {
    return null;
  }
  return `claude-cli/${modelId}`;
}

function rewriteModelSelection(model: AgentDefaultsModel): {
  value: AgentDefaultsModel;
  primary?: string;
  changed: boolean;
} {
  if (typeof model === "string") {
    const converted = toClaudeCliModelRef(model);
    return converted
      ? { changed: true, primary: converted, value: converted }
      : { changed: false, value: model };
  }
  if (!model || typeof model !== "object" || Array.isArray(model)) {
    return { changed: false, value: model };
  }

  const current = model as Record<string, unknown>;
  const next: Record<string, unknown> = { ...current };
  let changed = false;
  let primary: string | undefined;

  if (typeof current.primary === "string") {
    const converted = toClaudeCliModelRef(current.primary);
    if (converted) {
      next.primary = converted;
      primary = converted;
      changed = true;
    }
  }

  const currentFallbacks = current.fallbacks;
  if (Array.isArray(currentFallbacks)) {
    const nextFallbacks = currentFallbacks.map((entry) =>
      typeof entry === "string" ? (toClaudeCliModelRef(entry) ?? entry) : entry,
    );
    if (nextFallbacks.some((entry, index) => entry !== currentFallbacks[index])) {
      next.fallbacks = nextFallbacks;
      changed = true;
    }
  }

  return {
    value: changed ? next : model,
    ...(primary ? { primary } : {}),
    changed,
  };
}

function rewriteModelEntryMap(models: Record<string, unknown> | undefined): {
  value: Record<string, unknown> | undefined;
  migrated: string[];
} {
  if (!models) {
    return { migrated: [], value: models };
  }

  const next = { ...models };
  const migrated: string[] = [];

  for (const [rawKey, value] of Object.entries(models)) {
    const converted = toClaudeCliModelRef(rawKey);
    if (!converted) {
      continue;
    }
    if (!(converted in next)) {
      next[converted] = value;
    }
    delete next[rawKey];
    migrated.push(converted);
  }

  return {
    migrated,
    value: migrated.length > 0 ? next : models,
  };
}

function seedClaudeCliAllowlist(
  models: NonNullable<AgentDefaultsModels>,
): NonNullable<AgentDefaultsModels> {
  const next = { ...models };
  for (const ref of CLAUDE_CLI_DEFAULT_ALLOWLIST_REFS) {
    next[ref] = next[ref] ?? {};
  }
  return next;
}

export function hasClaudeCliAuth(options?: { allowKeychainPrompt?: boolean }): boolean {
  return Boolean(
    options?.allowKeychainPrompt === false
      ? readClaudeCliCredentialsForSetupNonInteractive()
      : readClaudeCliCredentialsForSetup(),
  );
}

function buildClaudeCliAuthProfiles(
  credential?: ClaudeCliCredential | null,
): ProviderAuthResult["profiles"] {
  if (!credential) {
    return [];
  }
  if (credential.type === "oauth") {
    return [
      {
        credential: {
          access: credential.access,
          expires: credential.expires,
          provider: CLAUDE_CLI_BACKEND_ID,
          refresh: credential.refresh,
          type: "oauth",
        },
        profileId: CLAUDE_CLI_PROFILE_ID,
      },
    ];
  }
  return [
    {
      credential: {
        expires: credential.expires,
        provider: CLAUDE_CLI_BACKEND_ID,
        token: credential.token,
        type: "token",
      },
      profileId: CLAUDE_CLI_PROFILE_ID,
    },
  ];
}

export function buildAnthropicCliMigrationResult(
  config: OpenClawConfig,
  credential?: ClaudeCliCredential | null,
): ProviderAuthResult {
  const defaults = config.agents?.defaults;
  const rewrittenModel = rewriteModelSelection(defaults?.model);
  const rewrittenModels = rewriteModelEntryMap(defaults?.models);
  const existingModels = (rewrittenModels.value ??
    defaults?.models ??
    {}) as NonNullable<AgentDefaultsModels>;
  const nextModels = seedClaudeCliAllowlist(existingModels);
  const defaultModel = rewrittenModel.primary ?? CLAUDE_CLI_DEFAULT_MODEL_REF;

  return {
    configPatch: {
      agents: {
        defaults: {
          ...(rewrittenModel.changed ? { model: rewrittenModel.value } : {}),
          models: nextModels,
        },
      },
    },
    defaultModel,
    notes: [
      "Claude CLI auth detected; switched Anthropic model selection to the local Claude CLI backend.",
      "Existing Anthropic auth profiles are kept for rollback.",
      ...(rewrittenModels.migrated.length > 0
        ? [`Migrated allowlist entries: ${rewrittenModels.migrated.join(", ")}.`]
        : []),
    ],
    profiles: buildClaudeCliAuthProfiles(credential),
  };
}
