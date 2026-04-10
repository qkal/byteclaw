import { type ZodType, z } from "zod";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getBundledChannelPlugin } from "./bundled.js";
import { getChannelPlugin } from "./registry.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";
import type { ChannelSetupInput } from "./types.core.js";

interface ChannelSectionBase {
  name?: string;
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
}

function channelHasAccounts(cfg: OpenClawConfig, channelKey: string): boolean {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[channelKey] as ChannelSectionBase | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  alwaysUseAccounts?: boolean;
}): boolean {
  if (params.alwaysUseAccounts) {
    return true;
  }
  if (params.accountId !== DEFAULT_ACCOUNT_ID) {
    return true;
  }
  return channelHasAccounts(params.cfg, params.channelKey);
}

export function applyAccountNameToChannelSection(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) {
    return params.cfg;
  }
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionBase) : undefined;
  const useAccounts = shouldStoreNameInAccounts({
    accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
    cfg: params.cfg,
    channelKey: params.channelKey,
  });
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const safeBase = base ?? {};
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...safeBase,
          name: trimmed,
        },
      },
    } as OpenClawConfig;
  }
  const baseAccounts: Record<string, Record<string, unknown>> = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...baseWithoutName,
        accounts: {
          ...baseAccounts,
          [accountId]: {
            ...existingAccount,
            name: trimmed,
          },
        },
      },
    },
  } as OpenClawConfig;
}

export function migrateBaseNameToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  alwaysUseAccounts?: boolean;
}): OpenClawConfig {
  if (params.alwaysUseAccounts) {
    return params.cfg;
  }
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const base = channels?.[params.channelKey] as ChannelSectionBase | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) {
    return params.cfg;
  }
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...rest,
        accounts,
      },
    },
  } as OpenClawConfig;
}

export function prepareScopedSetupConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  name?: string;
  alwaysUseAccounts?: boolean;
  migrateBaseName?: boolean;
}): OpenClawConfig {
  const namedConfig = applyAccountNameToChannelSection({
    accountId: params.accountId,
    alwaysUseAccounts: params.alwaysUseAccounts,
    cfg: params.cfg,
    channelKey: params.channelKey,
    name: params.name,
  });
  if (!params.migrateBaseName || normalizeAccountId(params.accountId) === DEFAULT_ACCOUNT_ID) {
    return namedConfig;
  }
  return migrateBaseNameToDefaultAccount({
    alwaysUseAccounts: params.alwaysUseAccounts,
    cfg: namedConfig,
    channelKey: params.channelKey,
  });
}

export function clearSetupPromotionRuntimeModuleCache(): void {}

export function applySetupAccountConfigPatch(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchScopedAccountConfig({
    accountId: params.accountId,
    cfg: params.cfg,
    channelKey: params.channelKey,
    patch: params.patch,
  });
}

export function createPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
  return {
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const next = prepareScopedSetupConfig({
        accountId,
        alwaysUseAccounts: params.alwaysUseAccounts,
        cfg,
        channelKey: params.channelKey,
        migrateBaseName: !params.alwaysUseAccounts,
        name: input.name,
      });
      const patch = params.buildPatch(input);
      return patchScopedAccountConfig({
        accountId,
        accountPatch: patch,
        cfg: next,
        channelKey: params.channelKey,
        ensureAccountEnabled: params.ensureAccountEnabled ?? true,
        ensureChannelEnabled: params.ensureChannelEnabled ?? !params.alwaysUseAccounts,
        patch,
        scopeDefaultToAccounts: params.alwaysUseAccounts,
      });
    },
    applyAccountName: ({ cfg, accountId, name }) =>
      prepareScopedSetupConfig({
        accountId,
        alwaysUseAccounts: params.alwaysUseAccounts,
        cfg,
        channelKey: params.channelKey,
        name,
      }),
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    validateInput: params.validateInput,
  };
}

export function createZodSetupInputValidator<T extends ChannelSetupInput>(params: {
  schema: ZodType<T>;
  validate?: (params: { cfg: OpenClawConfig; accountId: string; input: T }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]> {
  return (inputParams) => {
    const parsed = params.schema.safeParse(inputParams.input);
    if (!parsed.success) {
      return parsed.error.issues[0]?.message ?? "invalid input";
    }
    return (
      params.validate?.({
        ...inputParams,
        input: parsed.data,
      }) ?? null
    );
  };
}

const GenericSetupInputSchema = z
  .object({
    useEnv: z.boolean().optional(),
  })
  .passthrough() as ZodType<ChannelSetupInput>;

interface SetupInputPresenceRequirement {
  someOf: string[];
  message: string;
}

function hasPresentSetupValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return value !== undefined && value !== null;
}

export function createSetupInputPresenceValidator(params: {
  defaultAccountOnlyEnvError?: string;
  whenNotUseEnv?: SetupInputPresenceRequirement[];
  validate?: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    input: ChannelSetupInput;
  }) => string | null;
}): NonNullable<ChannelSetupAdapter["validateInput"]> {
  return createZodSetupInputValidator({
    schema: GenericSetupInputSchema,
    validate: (inputParams) => {
      if (
        params.defaultAccountOnlyEnvError &&
        inputParams.input.useEnv &&
        inputParams.accountId !== DEFAULT_ACCOUNT_ID
      ) {
        return params.defaultAccountOnlyEnvError;
      }
      if (!inputParams.input.useEnv) {
        const inputRecord = inputParams.input as Record<string, unknown>;
        for (const requirement of params.whenNotUseEnv ?? []) {
          if (requirement.someOf.some((key) => hasPresentSetupValue(inputRecord[key]))) {
            continue;
          }
          return requirement.message;
        }
      }
      return params.validate?.(inputParams) ?? null;
    },
  });
}

export function createEnvPatchedAccountSetupAdapter(params: {
  channelKey: string;
  alwaysUseAccounts?: boolean;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  defaultAccountOnlyEnvError: string;
  missingCredentialError: string;
  hasCredentials: (input: ChannelSetupInput) => boolean;
  validateInput?: ChannelSetupAdapter["validateInput"];
  buildPatch: (input: ChannelSetupInput) => Record<string, unknown>;
}): ChannelSetupAdapter {
  return createPatchedAccountSetupAdapter({
    alwaysUseAccounts: params.alwaysUseAccounts,
    buildPatch: params.buildPatch,
    channelKey: params.channelKey,
    ensureAccountEnabled: params.ensureAccountEnabled,
    ensureChannelEnabled: params.ensureChannelEnabled,
    validateInput: (inputParams) => {
      if (inputParams.input.useEnv && inputParams.accountId !== DEFAULT_ACCOUNT_ID) {
        return params.defaultAccountOnlyEnvError;
      }
      if (!inputParams.input.useEnv && !params.hasCredentials(inputParams.input)) {
        return params.missingCredentialError;
      }
      return params.validateInput?.(inputParams) ?? null;
    },
  });
}

export function patchScopedAccountConfig(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  accountId: string;
  patch: Record<string, unknown>;
  accountPatch?: Record<string, unknown>;
  ensureChannelEnabled?: boolean;
  ensureAccountEnabled?: boolean;
  scopeDefaultToAccounts?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = channels?.[params.channelKey];
  const base =
    typeof channelConfig === "object" && channelConfig
      ? (channelConfig as Record<string, unknown> & {
          accounts?: Record<string, Record<string, unknown>>;
        })
      : undefined;
  const ensureChannelEnabled = params.ensureChannelEnabled ?? true;
  const ensureAccountEnabled = params.ensureAccountEnabled ?? ensureChannelEnabled;
  const { patch } = params;
  const accountPatch = params.accountPatch ?? patch;
  if (accountId === DEFAULT_ACCOUNT_ID && !params.scopeDefaultToAccounts) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [params.channelKey]: {
          ...base,
          ...(ensureChannelEnabled ? { enabled: true } : {}),
          ...patch,
        },
      },
    } as OpenClawConfig;
  }

  const accounts = base?.accounts ?? {};
  const existingAccount = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...base,
        ...(ensureChannelEnabled ? { enabled: true } : {}),
        accounts: {
          ...accounts,
          [accountId]: {
            ...existingAccount,
            ...(ensureAccountEnabled
              ? {
                  enabled:
                    typeof existingAccount.enabled === "boolean" ? existingAccount.enabled : true,
                }
              : {}),
            ...accountPatch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

type ChannelSectionRecord = Record<string, unknown> & {
  accounts?: Record<string, Record<string, unknown>>;
};

const COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE = new Set([
  "name",
  "token",
  "tokenFile",
  "botToken",
  "appToken",
  "account",
  "signalNumber",
  "authDir",
  "cliPath",
  "dbPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "webhookPath",
  "webhookUrl",
  "webhookSecret",
  "service",
  "region",
  "homeserver",
  "userId",
  "accessToken",
  "password",
  "deviceName",
  "url",
  "code",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
]);

const BUNDLED_SINGLE_ACCOUNT_PROMOTION_FALLBACKS: Record<string, readonly string[]> = {
  // Some setup/migration paths run before the channel setup surface has been loaded.
  telegram: ["streaming"],
};

const BUNDLED_NAMED_ACCOUNT_PROMOTION_FALLBACKS: Record<string, readonly string[]> = {
  // Keep top-level Telegram policy fallback intact when only auth needs seeding.
  telegram: ["botToken", "tokenFile"],
};

interface ChannelSetupPromotionSurface {
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: ChannelSectionBase;
  }) => string | undefined;
}

function getChannelSetupPromotionSurface(channelKey: string): ChannelSetupPromotionSurface | null {
  const setup = getChannelPlugin(channelKey)?.setup ?? getBundledChannelPlugin(channelKey)?.setup;
  if (!setup || typeof setup !== "object") {
    return null;
  }
  return setup as ChannelSetupPromotionSurface;
}

export function shouldMoveSingleAccountChannelKey(params: {
  channelKey: string;
  key: string;
}): boolean {
  if (COMMON_SINGLE_ACCOUNT_KEYS_TO_MOVE.has(params.key)) {
    return true;
  }
  const contractKeys = getChannelSetupPromotionSurface(params.channelKey)?.singleAccountKeysToMove;
  if (contractKeys?.includes(params.key)) {
    return true;
  }
  const fallbackKeys = BUNDLED_SINGLE_ACCOUNT_PROMOTION_FALLBACKS[params.channelKey];
  if (fallbackKeys?.includes(params.key)) {
    return true;
  }
  return false;
}

export function resolveSingleAccountKeysToMove(params: {
  channelKey: string;
  channel: Record<string, unknown>;
}): string[] {
  const hasNamedAccounts =
    Object.keys((params.channel.accounts as Record<string, unknown>) ?? {}).filter(Boolean).length >
    0;
  const namedAccountPromotionKeys =
    getChannelSetupPromotionSurface(params.channelKey)?.namedAccountPromotionKeys ??
    BUNDLED_NAMED_ACCOUNT_PROMOTION_FALLBACKS[params.channelKey];
  return Object.entries(params.channel)
    .filter(([key, value]) => {
      if (key === "accounts" || key === "enabled" || value === undefined) {
        return false;
      }
      if (!shouldMoveSingleAccountChannelKey({ channelKey: params.channelKey, key })) {
        return false;
      }
      if (
        hasNamedAccounts &&
        namedAccountPromotionKeys &&
        !namedAccountPromotionKeys.includes(key)
      ) {
        return false;
      }
      return true;
    })
    .map(([key]) => key);
}

export function resolveSingleAccountPromotionTarget(params: {
  channelKey: string;
  channel: ChannelSectionBase;
}): string {
  const accounts = params.channel.accounts ?? {};
  const resolveExistingAccountId = (targetAccountId: string): string => {
    const normalizedTargetAccountId = normalizeAccountId(targetAccountId);
    const matchedAccountId = Object.keys(accounts).find(
      (accountId) => normalizeAccountId(accountId) === normalizedTargetAccountId,
    );
    return matchedAccountId ?? normalizedTargetAccountId;
  };
  const surface = getChannelSetupPromotionSurface(params.channelKey);
  const resolved = surface?.resolveSingleAccountPromotionTarget?.({
    channel: params.channel,
  });
  const normalizedResolved = normalizeOptionalString(resolved);
  if (normalizedResolved) {
    return resolveExistingAccountId(normalizedResolved);
  }
  return resolveExistingAccountId(DEFAULT_ACCOUNT_ID);
}

function cloneIfObject<T>(value: T): T {
  if (value && typeof value === "object") {
    return structuredClone(value);
  }
  return value;
}

function moveSingleAccountKeysIntoAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
  channel: ChannelSectionRecord;
  accounts: Record<string, Record<string, unknown>>;
  keysToMove: string[];
  targetAccountId: string;
  baseAccount?: Record<string, unknown>;
}): OpenClawConfig {
  const nextAccount: Record<string, unknown> = { ...params.baseAccount };
  for (const key of params.keysToMove) {
    nextAccount[key] = cloneIfObject(params.channel[key]);
  }
  const nextChannel: ChannelSectionRecord = { ...params.channel };
  for (const key of params.keysToMove) {
    delete nextChannel[key];
  }
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [params.channelKey]: {
        ...nextChannel,
        accounts: {
          ...params.accounts,
          [params.targetAccountId]: nextAccount,
        },
      },
    },
  } as OpenClawConfig;
}

function resolveExistingAccountKey(
  accounts: Record<string, Record<string, unknown>>,
  targetAccountId: string,
): string {
  for (const existingKey of Object.keys(accounts)) {
    if (normalizeAccountId(existingKey) === targetAccountId) {
      return existingKey;
    }
  }
  return targetAccountId;
}

// When promoting a single-account channel config to multi-account,
// Move top-level account settings into accounts.default so the original
// Account keeps working without duplicate account values at channel root.
export function moveSingleAccountChannelSectionToDefaultAccount(params: {
  cfg: OpenClawConfig;
  channelKey: string;
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const baseConfig = channels?.[params.channelKey];
  const base =
    typeof baseConfig === "object" && baseConfig ? (baseConfig as ChannelSectionRecord) : undefined;
  if (!base) {
    return params.cfg;
  }

  const accounts = base.accounts ?? {};
  if (Object.keys(accounts).length > 0) {
    const keysToMove = resolveSingleAccountKeysToMove({
      channel: base,
      channelKey: params.channelKey,
    });
    if (keysToMove.length === 0) {
      return params.cfg;
    }

    const targetAccountId = resolveSingleAccountPromotionTarget({
      channel: base,
      channelKey: params.channelKey,
    });
    const resolvedTargetAccountKey = resolveExistingAccountKey(accounts, targetAccountId);
    return moveSingleAccountKeysIntoAccount({
      accounts,
      baseAccount: accounts[resolvedTargetAccountKey],
      cfg: params.cfg,
      channel: base,
      channelKey: params.channelKey,
      keysToMove,
      targetAccountId: resolvedTargetAccountKey,
    });
  }
  const keysToMove = resolveSingleAccountKeysToMove({
    channel: base,
    channelKey: params.channelKey,
  });
  return moveSingleAccountKeysIntoAccount({
    accounts,
    cfg: params.cfg,
    channel: base,
    channelKey: params.channelKey,
    keysToMove,
    targetAccountId: DEFAULT_ACCOUNT_ID,
  });
}
