import { resolveNormalizedAccountEntry } from "openclaw/plugin-sdk/account-core";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { type ChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { inspectTelegramAccount } from "./account-inspect.js";
import {
  type ResolvedTelegramAccount,
  listTelegramAccountIds,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";
import {
  buildTelegramCommandsListChannelData,
  buildTelegramModelBrowseChannelData,
  buildTelegramModelsListChannelData,
  buildTelegramModelsProviderChannelData,
} from "./command-ui.js";
import { TelegramChannelConfigSchema } from "./config-schema.js";
import { telegramDoctor } from "./doctor.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { namedAccountPromotionKeys, singleAccountKeysToMove } from "./setup-contract.js";

export const TELEGRAM_CHANNEL = "telegram" as const;

export function findTelegramTokenOwnerAccountId(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): string | null {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const tokenOwners = new Map<string, string>();
  for (const id of listTelegramAccountIds(params.cfg)) {
    const account = inspectTelegramAccount({ accountId: id, cfg: params.cfg });
    const token = (account.token ?? "").trim();
    if (!token) {
      continue;
    }
    const ownerAccountId = tokenOwners.get(token);
    if (!ownerAccountId) {
      tokenOwners.set(token, account.accountId);
      continue;
    }
    if (account.accountId === normalizedAccountId) {
      return ownerAccountId;
    }
  }
  return null;
}

export function formatDuplicateTelegramTokenReason(params: {
  accountId: string;
  ownerAccountId: string;
}): string {
  return (
    `Duplicate Telegram bot token: account "${params.accountId}" shares a token with ` +
    `account "${params.ownerAccountId}". Keep one owner account per bot token.`
  );
}

/**
 * Returns true when the runtime token resolver (`resolveTelegramToken`) would
 * block channel-level fallthrough for the given accountId.  This mirrors the
 * guard in `token.ts` so that status-check functions (`isConfigured`,
 * `unconfiguredReason`, `describeAccount`) stay consistent with the gateway
 * runtime behaviour.
 *
 * The guard fires when:
 *   1. The accountId is not the default account, AND
 *   2. The config has an explicit `accounts` section with entries, AND
 *   3. The accountId is not found in that `accounts` section.
 *
 * See: https://github.com/openclaw/openclaw/issues/53876
 */
function isBlockedByMultiBotGuard(cfg: OpenClawConfig, accountId: string): boolean {
  if (normalizeAccountId(accountId) === DEFAULT_ACCOUNT_ID) {
    return false;
  }
  const accounts = cfg.channels?.telegram?.accounts;
  const hasConfiguredAccounts =
    Boolean(accounts) &&
    typeof accounts === "object" &&
    !Array.isArray(accounts) &&
    Object.keys(accounts).length > 0;
  if (!hasConfiguredAccounts) {
    return false;
  }
  // Use resolveNormalizedAccountEntry (same as resolveTelegramToken in token.ts)
  // Instead of resolveAccountEntry to handle keys that require full normalization
  // (e.g. "Carey Notifications" → "carey-notifications").
  return !resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId);
}

export const telegramConfigAdapter = createScopedChannelConfigAdapter<ResolvedTelegramAccount>({
  clearBaseFields: ["botToken", "tokenFile", "name"],
  defaultAccountId: resolveDefaultTelegramAccountId,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: /^(telegram|tg):/i }),
  inspectAccount: adaptScopedAccountAccessor(inspectTelegramAccount),
  listAccountIds: listTelegramAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveTelegramAccount),
  resolveAllowFrom: (account: ResolvedTelegramAccount) => account.config.allowFrom,
  resolveDefaultTo: (account: ResolvedTelegramAccount) => account.config.defaultTo,
  sectionKey: TELEGRAM_CHANNEL,
});

export function createTelegramPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupWizard"]>;
  setup: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setup"]>;
}): Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "commands"
  | "doctor"
  | "reload"
  | "configSchema"
  | "config"
  | "setup"
  | "secrets"
> {
  const base = createChannelPluginBase({
    capabilities: {
      blockStreaming: true,
      chatTypes: ["direct", "group", "channel", "thread"],
      media: true,
      nativeCommands: true,
      polls: true,
      reactions: true,
      threads: true,
    },
    commands: {
      buildCommandsListChannelData: buildTelegramCommandsListChannelData,
      buildModelBrowseChannelData: buildTelegramModelBrowseChannelData,
      buildModelsListChannelData: buildTelegramModelsListChannelData,
      buildModelsProviderChannelData: buildTelegramModelsProviderChannelData,
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
    },
    config: {
      ...telegramConfigAdapter,
      describeAccount: (account, cfg) => {
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return {
            accountId: account.accountId,
            configured: false,
            enabled: account.enabled,
            name: account.name,
            tokenSource: "none" as const,
          };
        }
        const inspected = inspectTelegramAccount({ accountId: account.accountId, cfg });
        return {
          accountId: account.accountId,
          configured:
            !!inspected.token?.trim() &&
            !findTelegramTokenOwnerAccountId({ cfg, accountId: account.accountId }),
          enabled: account.enabled,
          name: account.name,
          tokenSource: inspected.tokenSource,
        };
      },
      hasConfiguredState: ({ env }) =>
        typeof env?.TELEGRAM_BOT_TOKEN === "string" && env.TELEGRAM_BOT_TOKEN.trim().length > 0,
      isConfigured: (account, cfg) => {
        // Use inspectTelegramAccount for a complete token resolution that includes
        // Channel-level fallback paths not available in resolveTelegramAccount.
        // This ensures binding-created accountIds that inherit the channel-level
        // Token are correctly detected as configured.
        // See: https://github.com/openclaw/openclaw/issues/53876
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return false;
        }
        const inspected = inspectTelegramAccount({ accountId: account.accountId, cfg });
        // Gate on actually available token, not just "configured" — the latter
        // Includes "configured_unavailable" (unreadable tokenFile, unresolved
        // SecretRef) which would pass here but fail at runtime.
        if (!inspected.token?.trim()) {
          return false;
        }
        return !findTelegramTokenOwnerAccountId({ accountId: account.accountId, cfg });
      },
      unconfiguredReason: (account, cfg) => {
        if (isBlockedByMultiBotGuard(cfg, account.accountId)) {
          return `not configured: unknown accountId "${account.accountId}" in multi-bot setup`;
        }
        const inspected = inspectTelegramAccount({ accountId: account.accountId, cfg });
        if (!inspected.token?.trim()) {
          if (inspected.tokenStatus === "configured_unavailable") {
            return `not configured: token ${inspected.tokenSource} is configured but unavailable`;
          }
          return "not configured";
        }
        const ownerAccountId = findTelegramTokenOwnerAccountId({
          accountId: account.accountId,
          cfg,
        });
        if (!ownerAccountId) {
          return "not configured";
        }
        return formatDuplicateTelegramTokenReason({
          accountId: account.accountId,
          ownerAccountId,
        });
      },
    },
    configSchema: TelegramChannelConfigSchema,
    doctor: telegramDoctor,
    id: TELEGRAM_CHANNEL,
    meta: {
      ...getChatChannelMeta(TELEGRAM_CHANNEL),
      quickstartAllowFrom: true,
    },
    reload: { configPrefixes: ["channels.telegram"] },
    setup: {
      ...params.setup,
      namedAccountPromotionKeys,
      singleAccountKeysToMove,
    },
    setupWizard: params.setupWizard,
  });
  return {
    ...base,
    secrets: {
      collectRuntimeConfigAssignments,
      secretTargetRegistryEntries,
    },
  } as Pick<
    ChannelPlugin<ResolvedTelegramAccount>,
    | "id"
    | "meta"
    | "setupWizard"
    | "capabilities"
    | "commands"
    | "doctor"
    | "reload"
    | "configSchema"
    | "config"
    | "setup"
    | "secrets"
  >;
}
