import {
  cancel,
  confirm as clackConfirm,
  select as clackSelect,
  text as clackText,
  isCancel,
} from "@clack/prompts";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  clearAuthProfileCooldown,
  listProfilesForProvider,
  loadAuthProfileStoreForRuntime,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { resolveDefaultAgentWorkspaceDir } from "../../agents/workspace.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { resolvePluginProviders } from "../../plugins/providers.runtime.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../../shared/string-coerce.js";
import { stylePromptHint, stylePromptMessage } from "../../terminal/prompt-style.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { validateAnthropicSetupToken } from "../auth-token.js";
import { isRemoteEnvironment } from "../oauth-env.js";
import { createVpsAwareOAuthHandlers } from "../oauth-flow.js";
import { openUrl } from "../onboard-helpers.js";
import {
  applyDefaultModel,
  applyProviderAuthConfigPatch,
  pickAuthMethod,
  resolveProviderMatch,
} from "../provider-auth-helpers.js";
import { loadValidConfigOrThrow, updateConfig } from "./shared.js";

function guardCancel<T>(value: T | symbol): T {
  if (typeof value === "symbol" || isCancel(value)) {
    cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

const confirm = async (params: Parameters<typeof clackConfirm>[0]) =>
  guardCancel(
    await clackConfirm({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const text = async (params: Parameters<typeof clackText>[0]) =>
  guardCancel(
    await clackText({
      ...params,
      message: stylePromptMessage(params.message),
    }),
  );
const select = async <T>(params: Parameters<typeof clackSelect<T>>[0]) =>
  guardCancel(
    await clackSelect({
      ...params,
      message: stylePromptMessage(params.message),
      options: params.options.map((opt) =>
        opt.hint === undefined ? opt : { ...opt, hint: stylePromptHint(opt.hint) },
      ),
    }),
  );

function resolveDefaultTokenProfileId(provider: string): string {
  return `${normalizeProviderId(provider)}:manual`;
}

interface ResolvedModelsAuthContext {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
}

function listProvidersWithAuthMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => provider.auth.length > 0);
}

function listTokenAuthMethods(provider: ProviderPlugin): ProviderAuthMethod[] {
  return provider.auth.filter((method) => method.kind === "token");
}

function listProvidersWithTokenMethods(providers: ProviderPlugin[]): ProviderPlugin[] {
  return providers.filter((provider) => listTokenAuthMethods(provider).length > 0);
}

async function resolveModelsAuthContext(params?: {
  requestedProvider?: string;
}): Promise<ResolvedModelsAuthContext> {
  const config = await loadValidConfigOrThrow();
  const defaultAgentId = resolveDefaultAgentId(config);
  const agentDir = resolveAgentDir(config, defaultAgentId);
  const workspaceDir =
    resolveAgentWorkspaceDir(config, defaultAgentId) ?? resolveDefaultAgentWorkspaceDir();
  const providers = resolvePluginProviders({
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
    config,
    mode: "setup",
    workspaceDir,
    ...(params?.requestedProvider?.trim()
      ? { activate: true, providerRefs: [params.requestedProvider] }
      : {}),
  });
  return {
    agentDir,
    config,
    providers,
    workspaceDir,
  };
}

function resolveRequestedProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const requested = rawProvider?.trim();
  if (!requested) {
    return null;
  }
  const matched = resolveProviderMatch(providers, requested);
  if (matched) {
    return matched;
  }
  const available = providers
    .map((provider) => provider.id)
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
  const availableText = available.length > 0 ? available.join(", ") : "(none)";
  throw new Error(
    `Unknown provider "${requested}". Loaded providers: ${availableText}. Verify plugins via \`${formatCliCommand("openclaw plugins list --json")}\`.`,
  );
}

function resolveTokenMethodOrThrow(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const tokenMethods = listTokenAuthMethods(provider);
  if (rawMethod?.trim()) {
    const matched = pickAuthMethod(provider, rawMethod);
    if (matched && matched.kind === "token") {
      return matched;
    }
    const available = tokenMethods.map((method) => method.id).join(", ") || "(none)";
    throw new Error(
      `Unknown token auth method "${rawMethod}" for provider "${provider.id}". Available token methods: ${available}.`,
    );
  }
  return null;
}

async function pickProviderAuthMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: ReturnType<typeof createClackPrompter>;
}) {
  const requestedMethod = pickAuthMethod(params.provider, params.requestedMethod);
  if (requestedMethod) {
    return requestedMethod;
  }
  if (params.provider.auth.length === 1) {
    return params.provider.auth[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Auth method for ${params.provider.label}`,
      options: params.provider.auth.map((method) => ({
        hint: method.hint,
        label: method.label,
        value: method.id,
      })),
    })
    .then((id) => params.provider.auth.find((method) => method.id === String(id)) ?? null);
}

async function pickProviderTokenMethod(params: {
  provider: ProviderPlugin;
  requestedMethod?: string;
  prompter: ReturnType<typeof createClackPrompter>;
}) {
  const explicitTokenMethod = resolveTokenMethodOrThrow(params.provider, params.requestedMethod);
  if (explicitTokenMethod) {
    return explicitTokenMethod;
  }
  const tokenMethods = listTokenAuthMethods(params.provider);
  if (tokenMethods.length === 0) {
    return null;
  }
  const setupTokenMethod = tokenMethods.find((method) => method.id === "setup-token");
  if (setupTokenMethod) {
    return setupTokenMethod;
  }
  if (tokenMethods.length === 1) {
    return tokenMethods[0] ?? null;
  }
  return await params.prompter
    .select({
      message: `Token method for ${params.provider.label}`,
      options: tokenMethods.map((method) => ({
        hint: method.hint,
        label: method.label,
        value: method.id,
      })),
    })
    .then((id) => tokenMethods.find((method) => method.id === String(id)) ?? null);
}

async function persistProviderAuthResult(params: {
  result: ProviderAuthResult;
  agentDir: string;
  runtime: RuntimeEnv;
  prompter: ReturnType<typeof createClackPrompter>;
  setDefault?: boolean;
}) {
  for (const profile of params.result.profiles) {
    upsertAuthProfile({
      agentDir: params.agentDir,
      credential: profile.credential,
      profileId: profile.profileId,
    });
  }

  await updateConfig((cfg) => {
    let next = cfg;
    if (params.result.configPatch) {
      next = applyProviderAuthConfigPatch(next, params.result.configPatch);
    }
    for (const profile of params.result.profiles) {
      next = applyAuthProfileConfig(next, {
        mode: credentialMode(profile.credential),
        profileId: profile.profileId,
        provider: profile.credential.provider,
      });
    }
    if (params.setDefault && params.result.defaultModel) {
      next = applyDefaultModel(next, params.result.defaultModel);
    }
    return next;
  });

  logConfigUpdated(params.runtime);
  for (const profile of params.result.profiles) {
    params.runtime.log(
      `Auth profile: ${profile.profileId} (${profile.credential.provider}/${credentialMode(profile.credential)})`,
    );
  }
  if (params.result.defaultModel) {
    params.runtime.log(
      params.setDefault
        ? `Default model set to ${params.result.defaultModel}`
        : `Default model available: ${params.result.defaultModel} (use --set-default to apply)`,
    );
  }
  if (params.result.notes && params.result.notes.length > 0) {
    await params.prompter.note(params.result.notes.join("\n"), "Provider notes");
  }
}

async function runProviderAuthMethod(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: ReturnType<typeof createClackPrompter>;
  setDefault?: boolean;
}) {
  await clearStaleProfileLockouts(params.provider.id, params.agentDir);

  const result = await params.method.run({
    agentDir: params.agentDir,
    allowSecretRefPrompt: false,
    config: params.config,
    env: process.env,
    isRemote: isRemoteEnvironment(),
    oauth: {
      createVpsAwareHandlers: (runtimeParams) => createVpsAwareOAuthHandlers(runtimeParams),
    },
    openUrl: async (url) => {
      await openUrl(url);
    },
    prompter: params.prompter,
    runtime: params.runtime,
    workspaceDir: params.workspaceDir,
  });

  await persistProviderAuthResult({
    agentDir: params.agentDir,
    prompter: params.prompter,
    result,
    runtime: params.runtime,
    setDefault: params.setDefault,
  });
}

export async function modelsAuthSetupTokenCommand(
  opts: { provider?: string; yes?: boolean },
  runtime: RuntimeEnv,
) {
  if (!process.stdin.isTTY) {
    throw new Error("setup-token requires an interactive TTY.");
  }

  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
    requestedProvider: opts.provider,
  });
  const tokenProviders = listProvidersWithTokenMethods(providers);
  if (tokenProviders.length === 0) {
    throw new Error(
      `No provider token-auth plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const provider =
    resolveRequestedProviderOrThrow(tokenProviders, opts.provider) ?? tokenProviders[0] ?? null;
  if (!provider) {
    throw new Error("No token-capable provider is available.");
  }

  if (!opts.yes) {
    const proceed = await confirm({
      initialValue: true,
      message: `Continue with ${provider.label} token auth?`,
    });
    if (!proceed) {
      return;
    }
  }

  const prompter = createClackPrompter();
  const method = await pickProviderTokenMethod({ prompter, provider });
  if (!method) {
    throw new Error(`Provider "${provider.id}" does not expose a token auth method.`);
  }

  await runProviderAuthMethod({
    agentDir,
    config,
    method,
    prompter,
    provider,
    runtime,
    workspaceDir,
  });
}

export async function modelsAuthPasteTokenCommand(
  opts: {
    provider?: string;
    profileId?: string;
    expiresIn?: string;
  },
  runtime: RuntimeEnv,
) {
  const { agentDir } = await resolveModelsAuthContext();
  const rawProvider = normalizeOptionalString(opts.provider);
  if (!rawProvider) {
    throw new Error("Missing --provider.");
  }
  const provider = normalizeProviderId(rawProvider);
  const profileId =
    normalizeOptionalString(opts.profileId) || resolveDefaultTokenProfileId(provider);

  const tokenInput = await text({
    message: `Paste token for ${provider}`,
    validate: (value) => {
      const trimmed = value?.trim();
      if (!trimmed) {
        return "Required";
      }
      if (provider === "anthropic") {
        return validateAnthropicSetupToken(trimmed.replaceAll(/\s+/g, ""));
      }
      return undefined;
    },
  });
  const token =
    provider === "anthropic"
      ? String(tokenInput ?? "")
          .replaceAll(/\s+/g, "")
          .trim()
      : (normalizeOptionalString(tokenInput) ?? "");

  const expires = normalizeStringifiedOptionalString(opts.expiresIn)
    ? Date.now() +
      parseDurationMs(normalizeStringifiedOptionalString(opts.expiresIn) ?? "", {
        defaultUnit: "d",
      })
    : undefined;

  upsertAuthProfile({
    agentDir,
    credential: {
      provider,
      token,
      type: "token",
      ...(expires ? { expires } : {}),
    },
    profileId,
  });

  await updateConfig((cfg) => applyAuthProfileConfig(cfg, { mode: "token", profileId, provider }));

  logConfigUpdated(runtime);
  runtime.log(`Auth profile: ${profileId} (${provider}/token)`);
  if (provider === "anthropic") {
    runtime.log("Anthropic setup-token auth is supported in OpenClaw.");
    runtime.log("OpenClaw prefers Claude CLI reuse when it is available on the host.");
    runtime.log("Anthropic staff told us this OpenClaw path is allowed again.");
  }
}

export async function modelsAuthAddCommand(_opts: Record<string, never>, runtime: RuntimeEnv) {
  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext();
  const tokenProviders = listProvidersWithTokenMethods(providers);

  const provider = await select({
    message: "Token provider",
    options: [
      ...tokenProviders.map((providerPlugin) => ({
        hint: providerPlugin.docsPath ? `Docs: ${providerPlugin.docsPath}` : undefined,
        label: providerPlugin.id,
        value: providerPlugin.id,
      })),
      { label: "custom (type provider id)", value: "custom" },
    ],
  });

  const providerId =
    provider === "custom"
      ? normalizeProviderId(
          String(
            await text({
              message: "Provider id",
              validate: (value) => (value?.trim() ? undefined : "Required"),
            }),
          ),
        )
      : provider;

  const providerPlugin =
    provider === "custom" ? null : resolveRequestedProviderOrThrow(tokenProviders, providerId);
  if (providerPlugin) {
    const tokenMethods = listTokenAuthMethods(providerPlugin);
    const methodId =
      tokenMethods.length > 0
        ? await select({
            message: "Token method",
            options: [
              ...tokenMethods.map((method) => ({
                hint: method.hint,
                label: method.label,
                value: method.id,
              })),
              { label: "paste token", value: "paste" },
            ],
          })
        : "paste";
    if (methodId !== "paste") {
      const prompter = createClackPrompter();
      const method = tokenMethods.find((candidate) => candidate.id === methodId);
      if (!method) {
        throw new Error(`Unknown token auth method "${String(methodId)}".`);
      }
      await runProviderAuthMethod({
        agentDir,
        config,
        method,
        prompter,
        provider: providerPlugin,
        runtime,
        workspaceDir,
      });
      return;
    }
  }

  const profileIdDefault = resolveDefaultTokenProfileId(providerId);
  const profileId = String(
    await text({
      initialValue: profileIdDefault,
      message: "Profile id",
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();

  const wantsExpiry = await confirm({
    initialValue: false,
    message: "Does this token expire?",
  });
  const expiresIn = wantsExpiry
    ? String(
        await text({
          initialValue: "365d",
          message: "Expires in (duration)",
          validate: (value) => {
            try {
              parseDurationMs(String(value ?? ""), { defaultUnit: "d" });
              return undefined;
            } catch {
              return "Invalid duration (e.g. 365d, 12h, 30m)";
            }
          },
        }),
      ).trim()
    : undefined;

  await modelsAuthPasteTokenCommand({ expiresIn, profileId, provider: providerId }, runtime);
}

interface LoginOptions {
  provider?: string;
  method?: string;
  setDefault?: boolean;
  yes?: boolean;
}

/**
 * Clear stale cooldown/disabled state for all profiles matching a provider.
 * When a user explicitly runs `models auth login`, they intend to fix auth —
 * stale `auth_permanent` / `billing` lockouts should not persist across
 * a deliberate re-authentication attempt.
 */
async function clearStaleProfileLockouts(provider: string, agentDir: string): Promise<void> {
  try {
    const store = loadAuthProfileStoreForRuntime(agentDir);
    const profileIds = listProfilesForProvider(store, provider);
    for (const profileId of profileIds) {
      await clearAuthProfileCooldown({ agentDir, profileId, store });
    }
  } catch {
    // Best-effort housekeeping — never block re-authentication.
  }
}

export function resolveRequestedLoginProviderOrThrow(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  return resolveRequestedProviderOrThrow(providers, rawProvider);
}

function credentialMode(credential: AuthProfileCredential): "api_key" | "oauth" | "token" {
  if (credential.type === "api_key") {
    return "api_key";
  }
  if (credential.type === "token") {
    return "token";
  }
  return "oauth";
}

function maybeLogOpenAICodexNativeSearchTip(runtime: RuntimeEnv, providerId: string) {
  if (providerId !== "openai-codex") {
    return;
  }
  runtime.log(
    "Tip: Codex-capable models can use native Codex web search. Enable it with openclaw configure --section web (recommended mode: cached). Docs: https://docs.openclaw.ai/tools/web",
  );
}
export async function modelsAuthLoginCommand(opts: LoginOptions, runtime: RuntimeEnv) {
  if (!process.stdin.isTTY) {
    throw new Error("models auth login requires an interactive TTY.");
  }

  const { config, agentDir, workspaceDir, providers } = await resolveModelsAuthContext({
    requestedProvider: opts.provider,
  });
  const prompter = createClackPrompter();
  const authProviders = listProvidersWithAuthMethods(providers);
  if (authProviders.length === 0) {
    throw new Error(
      `No provider plugins found. Install one via \`${formatCliCommand("openclaw plugins install")}\`.`,
    );
  }

  const requestedProvider = resolveRequestedLoginProviderOrThrow(authProviders, opts.provider);
  const selectedProvider =
    requestedProvider ??
    (await prompter
      .select({
        message: "Select a provider",
        options: authProviders.map((provider) => ({
          hint: provider.docsPath ? `Docs: ${provider.docsPath}` : undefined,
          label: provider.label,
          value: provider.id,
        })),
      })
      .then((id) => resolveProviderMatch(authProviders, String(id))));

  if (!selectedProvider) {
    throw new Error("Unknown provider. Use --provider <id> to pick a provider plugin.");
  }
  const chosenMethod = await pickProviderAuthMethod({
    prompter,
    provider: selectedProvider,
    requestedMethod: opts.method,
  });

  if (!chosenMethod) {
    throw new Error("Unknown auth method. Use --method <id> to select one.");
  }

  await runProviderAuthMethod({
    agentDir,
    config,
    method: chosenMethod,
    prompter,
    provider: selectedProvider,
    runtime,
    setDefault: opts.setDefault,
    workspaceDir,
  });
  maybeLogOpenAICodexNativeSearchTip(runtime, selectedProvider.id);
}
