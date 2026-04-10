import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { confirm, select, text } from "@clack/prompts";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SecretProviderConfig, SecretRef, SecretRefSource } from "../config/types.secrets.js";
import { isSafeExecutableValue } from "../infra/exec-safety.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "../shared/string-coerce.js";
import { type SecretsApplyResult, runSecretsApply } from "./apply.js";
import { createSecretsConfigIO } from "./config-io.js";
import {
  type ConfigureCandidate,
  buildConfigureCandidatesForScope,
  buildSecretsConfigurePlan,
  collectConfigureProviderChanges,
  hasConfigurePlanChanges,
} from "./configure-plan.js";
import { getSkippedExecRefStaticError } from "./exec-resolution-policy.js";
import type { SecretsApplyPlan } from "./plan.js";
import { getProviderEnvVars } from "./provider-env-vars.js";
import {
  formatExecSecretRefIdValidationMessage,
  isValidExecSecretRefId,
  isValidSecretProviderAlias,
  resolveDefaultSecretProviderAlias,
} from "./ref-contract.js";
import { resolveSecretRefValue } from "./resolve.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { isRecord } from "./shared.js";

export interface SecretsConfigureResult {
  plan: SecretsApplyPlan;
  preflight: SecretsApplyResult;
}

const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePathValue(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseOptionalPositiveInt(value: string, max: number): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) {
    return undefined;
  }
  return parsed;
}

function getSecretProviders(config: OpenClawConfig): Record<string, SecretProviderConfig> {
  if (!isRecord(config.secrets?.providers)) {
    return {};
  }
  return config.secrets.providers;
}

function setSecretProvider(
  config: OpenClawConfig,
  providerAlias: string,
  providerConfig: SecretProviderConfig,
): void {
  config.secrets ??= {};
  if (!isRecord(config.secrets.providers)) {
    config.secrets.providers = {};
  }
  config.secrets.providers[providerAlias] = providerConfig;
}

function removeSecretProvider(config: OpenClawConfig, providerAlias: string): boolean {
  if (!isRecord(config.secrets?.providers)) {
    return false;
  }
  const { providers } = config.secrets;
  if (!Object.hasOwn(providers, providerAlias)) {
    return false;
  }
  delete providers[providerAlias];
  if (Object.keys(providers).length === 0) {
    delete config.secrets?.providers;
  }

  if (isRecord(config.secrets?.defaults)) {
    const { defaults } = config.secrets;
    if (defaults?.env === providerAlias) {
      delete defaults.env;
    }
    if (defaults?.file === providerAlias) {
      delete defaults.file;
    }
    if (defaults?.exec === providerAlias) {
      delete defaults.exec;
    }
    if (
      defaults &&
      defaults.env === undefined &&
      defaults.file === undefined &&
      defaults.exec === undefined
    ) {
      delete config.secrets?.defaults;
    }
  }
  return true;
}

function providerHint(provider: SecretProviderConfig): string {
  if (provider.source === "env") {
    return provider.allowlist?.length ? `env (${provider.allowlist.length} allowlisted)` : "env";
  }
  if (provider.source === "file") {
    return `file (${provider.mode ?? "json"})`;
  }
  return `exec (${provider.jsonOnly === false ? "json+text" : "json"})`;
}

function toSourceChoices(config: OpenClawConfig): { value: SecretRefSource; label: string }[] {
  const hasSource = (source: SecretRefSource) =>
    Object.values(config.secrets?.providers ?? {}).some((provider) => provider?.source === source);
  const choices: { value: SecretRefSource; label: string }[] = [
    {
      label: "env",
      value: "env",
    },
  ];
  if (hasSource("file")) {
    choices.push({ label: "file", value: "file" });
  }
  if (hasSource("exec")) {
    choices.push({ label: "exec", value: "exec" });
  }
  return choices;
}

function assertNoCancel<T>(value: T | symbol, message: string): T {
  if (typeof value === "symbol") {
    throw new Error(message);
  }
  return value;
}

const AUTH_PROFILE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function validateEnvNameCsv(value: string): string | undefined {
  const entries = parseCsv(value);
  for (const entry of entries) {
    if (!ENV_NAME_PATTERN.test(entry)) {
      return `Invalid env name: ${entry}`;
    }
  }
  return undefined;
}

async function promptEnvNameCsv(params: {
  message: string;
  initialValue: string;
}): Promise<string[]> {
  const raw = assertNoCancel(
    await text({
      initialValue: params.initialValue,
      message: params.message,
      validate: (value) => validateEnvNameCsv(String(value ?? "")),
    }),
    "Secrets configure cancelled.",
  );
  return parseCsv(String(raw ?? ""));
}

async function promptOptionalPositiveInt(params: {
  message: string;
  initialValue?: number;
  max: number;
}): Promise<number | undefined> {
  const raw = assertNoCancel(
    await text({
      initialValue: params.initialValue === undefined ? "" : String(params.initialValue),
      message: params.message,
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return undefined;
        }
        const parsed = parseOptionalPositiveInt(trimmed, params.max);
        if (parsed === undefined) {
          return `Must be an integer between 1 and ${params.max}`;
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );
  const parsed = parseOptionalPositiveInt(
    normalizeStringifiedOptionalString(raw) ?? "",
    params.max,
  );
  return parsed;
}

function configureCandidateKey(candidate: {
  configFile: "openclaw.json" | "auth-profiles.json";
  path: string;
  agentId?: string;
}): string {
  if (candidate.configFile === "auth-profiles.json") {
    return `auth-profiles:${normalizeOptionalString(candidate.agentId) ?? ""}:${candidate.path}`;
  }
  return `openclaw:${candidate.path}`;
}

function hasSourceChoice(
  sourceChoices: { value: SecretRefSource; label: string }[],
  source: SecretRefSource,
): boolean {
  return sourceChoices.some((entry) => entry.value === source);
}

function resolveCandidateProviderHint(candidate: ConfigureCandidate): string | undefined {
  return (
    normalizeOptionalLowercaseString(candidate.authProfileProvider) ??
    normalizeOptionalLowercaseString(candidate.providerId)
  );
}

function resolveSuggestedEnvSecretId(candidate: ConfigureCandidate): string | undefined {
  const hintedProvider = resolveCandidateProviderHint(candidate);
  if (!hintedProvider) {
    return undefined;
  }
  const envCandidates = getProviderEnvVars(hintedProvider);
  if (!Array.isArray(envCandidates) || envCandidates.length === 0) {
    return undefined;
  }
  return envCandidates[0];
}

function resolveConfigureAgentId(config: OpenClawConfig, explicitAgentId?: string): string {
  const knownAgentIds = new Set(listAgentIds(config));
  if (!explicitAgentId) {
    return resolveDefaultAgentId(config);
  }
  const normalized = normalizeAgentId(explicitAgentId);
  if (knownAgentIds.has(normalized)) {
    return normalized;
  }
  const known = [...knownAgentIds].toSorted().join(", ");
  throw new Error(
    `Unknown agent id "${explicitAgentId}". Known agents: ${known || "none configured"}.`,
  );
}

function loadAuthProfileStoreForConfigure(params: {
  config: OpenClawConfig;
  agentId: string;
}): AuthProfileStore {
  const agentDir = resolveAgentDir(params.config, params.agentId);
  return (
    loadPersistedAuthProfileStore(agentDir) ?? {
      profiles: {},
      version: AUTH_STORE_VERSION,
    }
  );
}

async function promptNewAuthProfileCandidate(agentId: string): Promise<ConfigureCandidate> {
  const profileId = assertNoCancel(
    await text({
      message: "Auth profile id",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!AUTH_PROFILE_ID_PATTERN.test(trimmed)) {
          return 'Use letters/numbers/":"/"_"/"-" only.';
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const credentialType = assertNoCancel(
    await select({
      message: "Auth profile credential type",
      options: [
        { label: "api_key (key/keyRef)", value: "api_key" },
        { label: "token (token/tokenRef)", value: "token" },
      ],
    }),
    "Secrets configure cancelled.",
  );

  const provider = assertNoCancel(
    await text({
      message: "Provider id",
      validate: (value) => (normalizeStringifiedOptionalString(value) ? undefined : "Required"),
    }),
    "Secrets configure cancelled.",
  );

  const profileIdTrimmed = normalizeStringifiedOptionalString(profileId) ?? "";
  const providerTrimmed = normalizeStringifiedOptionalString(provider) ?? "";
  if (credentialType === "token") {
    return {
      agentId,
      authProfileProvider: providerTrimmed,
      configFile: "auth-profiles.json",
      expectedResolvedValue: "string",
      label: `profiles.${profileIdTrimmed}.token (auth profile, agent ${agentId})`,
      path: `profiles.${profileIdTrimmed}.token`,
      pathSegments: ["profiles", profileIdTrimmed, "token"],
      type: "auth-profiles.token.token",
    };
  }
  return {
    agentId,
    authProfileProvider: providerTrimmed,
    configFile: "auth-profiles.json",
    expectedResolvedValue: "string",
    label: `profiles.${profileIdTrimmed}.key (auth profile, agent ${agentId})`,
    path: `profiles.${profileIdTrimmed}.key`,
    pathSegments: ["profiles", profileIdTrimmed, "key"],
    type: "auth-profiles.api_key.key",
  };
}

async function promptProviderAlias(params: { existingAliases: Set<string> }): Promise<string> {
  const alias = assertNoCancel(
    await text({
      initialValue: "default",
      message: "Provider alias",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isValidSecretProviderAlias(trimmed)) {
          return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
        }
        if (params.existingAliases.has(trimmed)) {
          return "Alias already exists";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );
  return normalizeStringifiedOptionalString(alias) ?? "";
}

async function promptProviderSource(initial?: SecretRefSource): Promise<SecretRefSource> {
  const source = assertNoCancel(
    await select({
      initialValue: initial,
      message: "Provider source",
      options: [
        { label: "env", value: "env" },
        { label: "file", value: "file" },
        { label: "exec", value: "exec" },
      ],
    }),
    "Secrets configure cancelled.",
  );
  return source as SecretRefSource;
}

async function promptEnvProvider(
  base?: Extract<SecretProviderConfig, { source: "env" }>,
): Promise<Extract<SecretProviderConfig, { source: "env" }>> {
  const allowlist = await promptEnvNameCsv({
    initialValue: base?.allowlist?.join(",") ?? "",
    message: "Env allowlist (comma-separated, blank for unrestricted)",
  });
  return {
    source: "env",
    ...(allowlist.length > 0 ? { allowlist } : {}),
  };
}

async function promptFileProvider(
  base?: Extract<SecretProviderConfig, { source: "file" }>,
): Promise<Extract<SecretProviderConfig, { source: "file" }>> {
  const filePath = assertNoCancel(
    await text({
      initialValue: base?.path ?? "",
      message: "File path (absolute)",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const mode = assertNoCancel(
    await select({
      initialValue: base?.mode ?? "json",
      message: "File mode",
      options: [
        { label: "json", value: "json" },
        { label: "singleValue", value: "singleValue" },
      ],
    }),
    "Secrets configure cancelled.",
  );

  const timeoutMs = await promptOptionalPositiveInt({
    initialValue: base?.timeoutMs,
    max: 120_000,
    message: "Timeout ms (blank for default)",
  });
  const maxBytes = await promptOptionalPositiveInt({
    initialValue: base?.maxBytes,
    max: 20 * 1024 * 1024,
    message: "Max bytes (blank for default)",
  });

  return {
    mode,
    path: normalizeStringifiedOptionalString(filePath) ?? "",
    source: "file",
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(maxBytes ? { maxBytes } : {}),
  };
}

async function parseArgsInput(rawValue: string): Promise<string[] | undefined> {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("args must be a JSON array of strings");
  }
  return parsed;
}

async function promptExecProvider(
  base?: Extract<SecretProviderConfig, { source: "exec" }>,
): Promise<Extract<SecretProviderConfig, { source: "exec" }>> {
  const command = assertNoCancel(
    await text({
      initialValue: base?.command ?? "",
      message: "Command path (absolute)",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return "Required";
        }
        if (!isAbsolutePathValue(trimmed)) {
          return "Must be an absolute path";
        }
        if (!isSafeExecutableValue(trimmed)) {
          return "Command value is not allowed";
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const argsRaw = assertNoCancel(
    await text({
      initialValue: JSON.stringify(base?.args ?? []),
      message: "Args JSON array (blank for none)",
      validate: (value) => {
        const trimmed = normalizeStringifiedOptionalString(value) ?? "";
        if (!trimmed) {
          return undefined;
        }
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
            return "Must be a JSON array of strings";
          }
          return undefined;
        } catch {
          return "Must be valid JSON";
        }
      },
    }),
    "Secrets configure cancelled.",
  );

  const timeoutMs = await promptOptionalPositiveInt({
    initialValue: base?.timeoutMs,
    max: 120_000,
    message: "Timeout ms (blank for default)",
  });

  const noOutputTimeoutMs = await promptOptionalPositiveInt({
    initialValue: base?.noOutputTimeoutMs,
    max: 120_000,
    message: "No-output timeout ms (blank for default)",
  });

  const maxOutputBytes = await promptOptionalPositiveInt({
    initialValue: base?.maxOutputBytes,
    max: 20 * 1024 * 1024,
    message: "Max output bytes (blank for default)",
  });

  const jsonOnly = assertNoCancel(
    await confirm({
      initialValue: base?.jsonOnly ?? true,
      message: "Require JSON-only response?",
    }),
    "Secrets configure cancelled.",
  );

  const passEnv = await promptEnvNameCsv({
    initialValue: base?.passEnv?.join(",") ?? "",
    message: "Pass-through env vars (comma-separated, blank for none)",
  });

  const trustedDirsRaw = assertNoCancel(
    await text({
      initialValue: base?.trustedDirs?.join(",") ?? "",
      message: "Trusted dirs (comma-separated absolute paths, blank for none)",
      validate: (value) => {
        const entries = parseCsv(String(value ?? ""));
        for (const entry of entries) {
          if (!isAbsolutePathValue(entry)) {
            return `Trusted dir must be absolute: ${entry}`;
          }
        }
        return undefined;
      },
    }),
    "Secrets configure cancelled.",
  );

  const allowInsecurePath = assertNoCancel(
    await confirm({
      initialValue: base?.allowInsecurePath ?? false,
      message: "Allow insecure command path checks?",
    }),
    "Secrets configure cancelled.",
  );
  const allowSymlinkCommand = assertNoCancel(
    await confirm({
      initialValue: base?.allowSymlinkCommand ?? false,
      message: "Allow symlink command path?",
    }),
    "Secrets configure cancelled.",
  );

  const args = await parseArgsInput(normalizeStringifiedOptionalString(argsRaw) ?? "");
  const trustedDirs = parseCsv(String(trustedDirsRaw ?? ""));

  return {
    command: normalizeStringifiedOptionalString(command) ?? "",
    source: "exec",
    ...(args && args.length > 0 ? { args } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(noOutputTimeoutMs ? { noOutputTimeoutMs } : {}),
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
    ...(jsonOnly ? { jsonOnly } : { jsonOnly: false }),
    ...(passEnv.length > 0 ? { passEnv } : {}),
    ...(trustedDirs.length > 0 ? { trustedDirs } : {}),
    ...(allowInsecurePath ? { allowInsecurePath: true } : {}),
    ...(allowSymlinkCommand ? { allowSymlinkCommand: true } : {}),
    ...(isRecord(base?.env) ? { env: base.env } : {}),
  };
}

async function promptProviderConfig(
  source: SecretRefSource,
  current?: SecretProviderConfig,
): Promise<SecretProviderConfig> {
  if (source === "env") {
    return await promptEnvProvider(current?.source === "env" ? current : undefined);
  }
  if (source === "file") {
    return await promptFileProvider(current?.source === "file" ? current : undefined);
  }
  return await promptExecProvider(current?.source === "exec" ? current : undefined);
}

async function configureProvidersInteractive(config: OpenClawConfig): Promise<void> {
  while (true) {
    const providers = getSecretProviders(config);
    const providerEntries = Object.entries(providers).toSorted(([left], [right]) =>
      left.localeCompare(right),
    );

    const actionOptions: { value: string; label: string; hint?: string }[] = [
      {
        hint: "Define a new env/file/exec provider",
        label: "Add provider",
        value: "add",
      },
    ];
    if (providerEntries.length > 0) {
      actionOptions.push({
        hint: "Update an existing provider",
        label: "Edit provider",
        value: "edit",
      });
      actionOptions.push({
        hint: "Delete a provider alias",
        label: "Remove provider",
        value: "remove",
      });
    }
    actionOptions.push({
      hint: "Move to credential mapping",
      label: "Continue",
      value: "continue",
    });

    const action = assertNoCancel(
      await select({
        message:
          providerEntries.length > 0
            ? "Configure secret providers"
            : "Configure secret providers (only env refs are available until file/exec providers are added)",
        options: actionOptions,
      }),
      "Secrets configure cancelled.",
    );

    if (action === "continue") {
      return;
    }

    if (action === "add") {
      const source = await promptProviderSource();
      const alias = await promptProviderAlias({
        existingAliases: new Set(providerEntries.map(([providerAlias]) => providerAlias)),
      });
      const providerConfig = await promptProviderConfig(source);
      setSecretProvider(config, alias, providerConfig);
      continue;
    }

    if (action === "edit") {
      const alias = assertNoCancel(
        await select({
          message: "Select provider to edit",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            hint: providerHint(providerConfig),
            label: providerAlias,
            value: providerAlias,
          })),
        }),
        "Secrets configure cancelled.",
      );
      const current = providers[alias];
      if (!current) {
        continue;
      }
      const source = await promptProviderSource(current.source);
      const nextProviderConfig = await promptProviderConfig(source, current);
      if (!isDeepStrictEqual(current, nextProviderConfig)) {
        setSecretProvider(config, alias, nextProviderConfig);
      }
      continue;
    }

    if (action === "remove") {
      const alias = assertNoCancel(
        await select({
          message: "Select provider to remove",
          options: providerEntries.map(([providerAlias, providerConfig]) => ({
            hint: providerHint(providerConfig),
            label: providerAlias,
            value: providerAlias,
          })),
        }),
        "Secrets configure cancelled.",
      );

      const shouldRemove = assertNoCancel(
        await confirm({
          initialValue: false,
          message: `Remove provider "${alias}"?`,
        }),
        "Secrets configure cancelled.",
      );
      if (shouldRemove) {
        removeSecretProvider(config, alias);
      }
    }
  }
}

export async function runSecretsConfigureInteractive(
  params: {
    env?: NodeJS.ProcessEnv;
    providersOnly?: boolean;
    skipProviderSetup?: boolean;
    agentId?: string;
    allowExecInPreflight?: boolean;
  } = {},
): Promise<SecretsConfigureResult> {
  if (!process.stdin.isTTY) {
    throw new Error("secrets configure requires an interactive TTY.");
  }
  if (params.providersOnly && params.skipProviderSetup) {
    throw new Error("Cannot combine --providers-only with --skip-provider-setup.");
  }

  const env = params.env ?? process.env;
  const allowExecInPreflight = Boolean(params.allowExecInPreflight);
  const io = createSecretsConfigIO({ env });
  const { snapshot } = await io.readConfigFileSnapshotForWrite();
  if (!snapshot.valid) {
    throw new Error("Cannot run interactive secrets configure because config is invalid.");
  }

  const stagedConfig = structuredClone(snapshot.config);
  if (!params.skipProviderSetup) {
    await configureProvidersInteractive(stagedConfig);
  }

  const providerChanges = collectConfigureProviderChanges({
    next: stagedConfig,
    original: snapshot.config,
  });

  const selectedByPath = new Map<string, ConfigureCandidate & { ref: SecretRef }>();
  if (!params.providersOnly) {
    const configureAgentId = resolveConfigureAgentId(snapshot.config, params.agentId);
    const authStore = loadAuthProfileStoreForConfigure({
      agentId: configureAgentId,
      config: snapshot.config,
    });
    const candidates = buildConfigureCandidatesForScope({
      authProfiles: {
        agentId: configureAgentId,
        store: authStore,
      },
      authoredOpenClawConfig: snapshot.resolved,
      config: stagedConfig,
    });
    if (candidates.length === 0) {
      throw new Error("No configurable secret-bearing fields found for this agent scope.");
    }

    const sourceChoices = toSourceChoices(stagedConfig);
    const hasDerivedCandidates = candidates.some((candidate) => candidate.isDerived === true);
    let showDerivedCandidates = false;

    while (true) {
      const visibleCandidates = showDerivedCandidates
        ? candidates
        : candidates.filter((candidate) => candidate.isDerived !== true);
      const options = visibleCandidates.map((candidate) => ({
        hint: [
          candidate.configFile === "auth-profiles.json" ? "auth-profiles.json" : "openclaw.json",
          candidate.isDerived === true ? "derived" : undefined,
        ]
          .filter(Boolean)
          .join(" | "),
        label: candidate.label,
        value: configureCandidateKey(candidate),
      }));
      options.push({
        hint: `Add a new auth-profiles target for agent ${configureAgentId}`,
        label: "Create auth profile mapping",
        value: "__create_auth_profile__",
      });
      if (hasDerivedCandidates) {
        options.push({
          hint: showDerivedCandidates
            ? "Show only fields authored directly in config"
            : "Include normalized/derived aliases",
          label: showDerivedCandidates ? "Hide derived targets" : "Show derived targets",
          value: "__toggle_derived__",
        });
      }
      if (selectedByPath.size > 0) {
        options.unshift({
          hint: "Finish and run preflight",
          label: "Done",
          value: "__done__",
        });
      }

      const selectedPath = assertNoCancel(
        await select({
          message: "Select credential field",
          options,
        }),
        "Secrets configure cancelled.",
      );

      if (selectedPath === "__done__") {
        break;
      }
      if (selectedPath === "__create_auth_profile__") {
        const createdCandidate = await promptNewAuthProfileCandidate(configureAgentId);
        const key = configureCandidateKey(createdCandidate);
        const existingIndex = candidates.findIndex((entry) => configureCandidateKey(entry) === key);
        if (existingIndex !== -1) {
          candidates[existingIndex] = createdCandidate;
        } else {
          candidates.push(createdCandidate);
        }
        continue;
      }
      if (selectedPath === "__toggle_derived__") {
        showDerivedCandidates = !showDerivedCandidates;
        continue;
      }

      const candidate = visibleCandidates.find(
        (entry) => configureCandidateKey(entry) === selectedPath,
      );
      if (!candidate) {
        throw new Error(`Unknown configure target: ${selectedPath}`);
      }
      const candidateKey = configureCandidateKey(candidate);
      const priorSelection = selectedByPath.get(candidateKey);
      const existingRef = priorSelection?.ref ?? candidate.existingRef;
      const sourceInitialValue =
        existingRef && hasSourceChoice(sourceChoices, existingRef.source)
          ? existingRef.source
          : undefined;

      const source = assertNoCancel(
        await select({
          initialValue: sourceInitialValue,
          message: "Secret source",
          options: sourceChoices,
        }),
        "Secrets configure cancelled.",
      ) as SecretRefSource;

      const defaultAlias = resolveDefaultSecretProviderAlias(stagedConfig, source, {
        preferFirstProviderForSource: true,
      });
      const providerInitialValue =
        existingRef?.source === source ? existingRef.provider : defaultAlias;
      const provider = assertNoCancel(
        await text({
          initialValue: providerInitialValue,
          message: "Provider alias",
          validate: (value) => {
            const trimmed = normalizeStringifiedOptionalString(value) ?? "";
            if (!trimmed) {
              return "Required";
            }
            if (!isValidSecretProviderAlias(trimmed)) {
              return "Must match /^[a-z][a-z0-9_-]{0,63}$/";
            }
            return undefined;
          },
        }),
        "Secrets configure cancelled.",
      );
      const providerAlias = normalizeStringifiedOptionalString(provider) ?? "";
      const suggestedIdFromExistingRef =
        existingRef?.source === source ? existingRef.id : undefined;
      let suggestedId = suggestedIdFromExistingRef;
      if (!suggestedId && source === "env") {
        suggestedId = resolveSuggestedEnvSecretId(candidate);
      }
      if (!suggestedId && source === "file") {
        const configuredProvider = stagedConfig.secrets?.providers?.[providerAlias];
        if (configuredProvider?.source === "file" && configuredProvider.mode === "singleValue") {
          suggestedId = "value";
        }
      }
      const id = assertNoCancel(
        await text({
          initialValue: suggestedId,
          message: "Secret id",
          validate: (value) => {
            const trimmed = normalizeStringifiedOptionalString(value) ?? "";
            if (!trimmed) {
              return "Required";
            }
            if (source === "exec" && !isValidExecSecretRefId(trimmed)) {
              return formatExecSecretRefIdValidationMessage();
            }
            return undefined;
          },
        }),
        "Secrets configure cancelled.",
      );
      const ref: SecretRef = {
        id: normalizeStringifiedOptionalString(id) ?? "",
        provider: providerAlias,
        source,
      };
      if (ref.source === "exec" && !allowExecInPreflight) {
        const staticError = getSkippedExecRefStaticError({
          config: stagedConfig,
          ref,
        });
        if (staticError) {
          throw new Error(staticError);
        }
      } else {
        const resolved = await resolveSecretRefValue(ref, {
          config: stagedConfig,
          env,
        });
        assertExpectedResolvedSecretValue({
          errorMessage:
            candidate.expectedResolvedValue === "string"
              ? `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a non-empty string.`
              : `Ref ${ref.source}:${ref.provider}:${ref.id} did not resolve to a supported value type.`,
          expected: candidate.expectedResolvedValue,
          value: resolved,
        });
      }

      const next = {
        ...candidate,
        ref,
      };
      selectedByPath.set(candidateKey, next);

      const addMore = assertNoCancel(
        await confirm({
          initialValue: true,
          message: "Configure another credential?",
        }),
        "Secrets configure cancelled.",
      );
      if (!addMore) {
        break;
      }
    }
  }

  if (!hasConfigurePlanChanges({ providerChanges, selectedTargets: selectedByPath })) {
    throw new Error("No secrets changes were selected.");
  }

  const plan = buildSecretsConfigurePlan({
    providerChanges,
    selectedTargets: selectedByPath,
  });

  const preflight = await runSecretsApply({
    allowExec: allowExecInPreflight,
    env,
    plan,
    write: false,
  });

  return { plan, preflight };
}
