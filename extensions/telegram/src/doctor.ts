import type {
  ChannelDoctorAdapter,
  ChannelDoctorEmptyAllowlistAccountContext,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { inspectTelegramAccount } from "./account-inspect.js";
import { listTelegramAccountIds, resolveTelegramAccount } from "./accounts.js";
import { isNumericTelegramUserId, normalizeTelegramAllowFromEntry } from "./allow-from.js";
import { lookupTelegramChatId } from "./api-fetch.js";
import {
  legacyConfigRules as TELEGRAM_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeTelegramCompatibilityConfig,
} from "./doctor-contract.js";

interface TelegramAllowFromUsernameHit { path: string; entry: string }
type DoctorAllowFromList = (string | number)[];
type DoctorAccountRecord = Record<string, unknown>;

interface TelegramAllowFromListRef {
  pathLabel: string;
  holder: Record<string, unknown>;
  key: "allowFrom" | "groupAllowFrom";
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeForLog(value: string): string {
  return value.replace(/\p{Cc}+/gu, " ").trim();
}

function hasAllowFromEntries(values?: DoctorAllowFromList): boolean {
  return Array.isArray(values) && values.some((entry) => normalizeOptionalString(String(entry)));
}

function collectTelegramAccountScopes(
  cfg: OpenClawConfig,
): { prefix: string; account: Record<string, unknown> }[] {
  const scopes: { prefix: string; account: Record<string, unknown> }[] = [];
  const telegram = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.telegram);
  if (!telegram) {
    return scopes;
  }
  scopes.push({ account: telegram, prefix: "channels.telegram" });
  const accounts = asObjectRecord(telegram.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const key of Object.keys(accounts)) {
    const account = asObjectRecord(accounts[key]);
    if (account) {
      scopes.push({ account, prefix: `channels.telegram.accounts.${key}` });
    }
  }
  return scopes;
}

function collectTelegramAllowFromLists(
  prefix: string,
  account: Record<string, unknown>,
): TelegramAllowFromListRef[] {
  const refs: TelegramAllowFromListRef[] = [
    { holder: account, key: "allowFrom", pathLabel: `${prefix}.allowFrom` },
    { holder: account, key: "groupAllowFrom", pathLabel: `${prefix}.groupAllowFrom` },
  ];
  const groups = asObjectRecord(account.groups);
  if (!groups) {
    return refs;
  }
  for (const groupId of Object.keys(groups)) {
    const group = asObjectRecord(groups[groupId]);
    if (!group) {
      continue;
    }
    refs.push({
      holder: group,
      key: "allowFrom",
      pathLabel: `${prefix}.groups.${groupId}.allowFrom`,
    });
    const topics = asObjectRecord(group.topics);
    if (!topics) {
      continue;
    }
    for (const topicId of Object.keys(topics)) {
      const topic = asObjectRecord(topics[topicId]);
      if (!topic) {
        continue;
      }
      refs.push({
        holder: topic,
        key: "allowFrom",
        pathLabel: `${prefix}.groups.${groupId}.topics.${topicId}.allowFrom`,
      });
    }
  }
  return refs;
}

export function scanTelegramAllowFromUsernameEntries(
  cfg: OpenClawConfig,
): TelegramAllowFromUsernameHit[] {
  const hits: TelegramAllowFromUsernameHit[] = [];
  const scanList = (pathLabel: string, list: unknown) => {
    if (!Array.isArray(list)) {
      return;
    }
    for (const entry of list) {
      const normalized = normalizeTelegramAllowFromEntry(entry);
      if (!normalized || normalized === "*" || isNumericTelegramUserId(normalized)) {
        continue;
      }
      hits.push({ entry: normalizeOptionalString(String(entry)) ?? "", path: pathLabel });
    }
  };

  for (const scope of collectTelegramAccountScopes(cfg)) {
    for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) {
      scanList(ref.pathLabel, ref.holder[ref.key]);
    }
  }
  return hits;
}

export function collectTelegramAllowFromUsernameWarnings(params: {
  hits: TelegramAllowFromUsernameHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const sampleEntry = sanitizeForLog(params.hits[0]?.entry ?? "@");
  return [
    `- Telegram allowFrom contains ${params.hits.length} non-numeric entries (e.g. ${sampleEntry}); Telegram authorization requires numeric sender IDs.`,
    `- Run "${params.doctorFixCommand}" to auto-resolve @username entries to numeric IDs (requires a Telegram bot token).`,
  ];
}

export async function maybeRepairTelegramAllowFromUsernames(cfg: OpenClawConfig): Promise<{
  config: OpenClawConfig;
  changes: string[];
}> {
  const hits = scanTelegramAllowFromUsernameEntries(cfg);
  if (hits.length === 0) {
    return { changes: [], config: cfg };
  }

  const { getChannelsCommandSecretTargetIds, resolveCommandSecretRefsViaGateway } =
    await import("openclaw/plugin-sdk/runtime-secret-resolution");

  const { resolvedConfig } = await resolveCommandSecretRefsViaGateway({
    commandName: "doctor --fix",
    config: cfg,
    mode: "read_only_status",
    targetIds: getChannelsCommandSecretTargetIds(),
  });

  const tokenResolutionWarnings: string[] = [];
  const resolverAccountIds: string[] = [];
  let sawConfiguredUnavailableToken = false;
  for (const accountId of listTelegramAccountIds(resolvedConfig)) {
    let inspected: ReturnType<typeof inspectTelegramAccount>;
    try {
      inspected = inspectTelegramAccount({ accountId, cfg: resolvedConfig });
    } catch (error) {
      tokenResolutionWarnings.push(
        `- Telegram account ${accountId}: failed to inspect bot token (${formatErrorMessage(error)}).`,
      );
      continue;
    }
    if (inspected.tokenStatus === "configured_unavailable") {
      sawConfiguredUnavailableToken = true;
      tokenResolutionWarnings.push(
        `- Telegram account ${accountId}: failed to inspect bot token (configured but unavailable in this command path).`,
      );
    }
    const token =
      inspected.tokenSource === "none" ? "" : (normalizeOptionalString(inspected.token) ?? "");
    if (token) {
      resolverAccountIds.push(accountId);
    }
  }

  if (resolverAccountIds.length === 0) {
    return {
      changes: [
        ...tokenResolutionWarnings,
        sawConfiguredUnavailableToken
          ? "- Telegram allowFrom contains @username entries, but configured Telegram bot credentials are unavailable in this command path; cannot auto-resolve."
          : "- Telegram allowFrom contains @username entries, but no Telegram bot token is available in this command path; cannot auto-resolve.",
      ],
      config: cfg,
    };
  }
  const resolveUserId = async (raw: string): Promise<string | null> => {
    const trimmed = normalizeOptionalString(raw) ?? "";
    if (!trimmed) {
      return null;
    }
    const normalized = normalizeTelegramAllowFromEntry(trimmed);
    if (!normalized || normalized === "*") {
      return null;
    }
    if (isNumericTelegramUserId(normalized) || /\s/.test(normalized)) {
      return isNumericTelegramUserId(normalized) ? normalized : null;
    }
    const username = normalized.startsWith("@") ? normalized : `@${normalized}`;
    for (const accountId of resolverAccountIds) {
      try {
        const account = resolveTelegramAccount({ accountId, cfg: resolvedConfig });
        const token = account.token.trim();
        if (!token) {
          continue;
        }
        const id = await lookupTelegramChatId({
          chatId: username,
          network: account.config.network,
          signal: undefined,
          token,
        });
        if (id) {
          return id;
        }
      } catch {
        // Ignore and try next account
      }
    }
    return null;
  };

  const next = structuredClone(cfg);
  const changes: string[] = [];

  const repairList = async (pathLabel: string, holder: Record<string, unknown>, key: string) => {
    const raw = holder[key];
    if (!Array.isArray(raw)) {
      return;
    }
    const out: DoctorAllowFromList = [];
    const replaced: { from: string; to: string }[] = [];
    for (const entry of raw) {
      const normalized = normalizeTelegramAllowFromEntry(entry);
      if (!normalized) {
        continue;
      }
      if (normalized === "*" || isNumericTelegramUserId(normalized)) {
        out.push(normalized);
        continue;
      }
      const resolved = await resolveUserId(String(entry));
      if (resolved) {
        out.push(resolved);
        replaced.push({ from: normalizeOptionalString(String(entry)) ?? "", to: resolved });
      } else {
        out.push(normalizeOptionalString(String(entry)) ?? "");
      }
    }
    const deduped: DoctorAllowFromList = [];
    const seen = new Set<string>();
    for (const entry of out) {
      const keyValue = normalizeOptionalString(String(entry)) ?? "";
      if (!keyValue || seen.has(keyValue)) {
        continue;
      }
      seen.add(keyValue);
      deduped.push(entry);
    }
    holder[key] = deduped;
    for (const replacement of replaced.slice(0, 5)) {
      changes.push(
        `- ${sanitizeForLog(pathLabel)}: resolved ${sanitizeForLog(replacement.from)} -> ${sanitizeForLog(replacement.to)}`,
      );
    }
    if (replaced.length > 5) {
      changes.push(
        `- ${sanitizeForLog(pathLabel)}: resolved ${replaced.length - 5} more @username entries`,
      );
    }
  };

  for (const scope of collectTelegramAccountScopes(next)) {
    for (const ref of collectTelegramAllowFromLists(scope.prefix, scope.account)) {
      await repairList(ref.pathLabel, ref.holder, ref.key);
    }
  }

  if (changes.length === 0) {
    return { changes: [], config: cfg };
  }
  return { changes, config: next };
}

function hasConfiguredGroups(account: DoctorAccountRecord, parent?: DoctorAccountRecord): boolean {
  const groups =
    (asObjectRecord(account.groups) as DoctorAccountRecord | null) ??
    (asObjectRecord(parent?.groups) as DoctorAccountRecord | null);
  return Boolean(groups) && Object.keys(groups ?? {}).length > 0;
}

export function collectTelegramGroupPolicyWarnings(params: {
  account: DoctorAccountRecord;
  prefix: string;
  effectiveAllowFrom?: DoctorAllowFromList;
  dmPolicy?: string;
  parent?: DoctorAccountRecord;
}): string[] {
  if (!hasConfiguredGroups(params.account, params.parent)) {
    const effectiveDmPolicy = params.dmPolicy ?? "pairing";
    const dmSetupLine =
      effectiveDmPolicy === "pairing"
        ? "DMs use pairing mode, so new senders must start a chat and be approved before regular messages are accepted."
        : effectiveDmPolicy === "allowlist"
          ? `DMs use allowlist mode, so only sender IDs in ${params.prefix}.allowFrom are accepted.`
          : effectiveDmPolicy === "open"
            ? "DMs are open."
            : "DMs are disabled.";
    return [
      `- ${params.prefix}: Telegram is in first-time setup mode. ${dmSetupLine} Group messages stay blocked until you add allowed chats under ${params.prefix}.groups (and optional sender IDs under ${params.prefix}.groupAllowFrom), or set ${params.prefix}.groupPolicy to "open" if you want broad group access.`,
    ];
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.groupAllowFrom as DoctorAllowFromList | undefined);
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const effectiveGroupAllowFrom = groupAllowFrom ?? params.effectiveAllowFrom;
  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return [];
  }

  return [
    `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set ${params.prefix}.groupPolicy to "open".`,
  ];
}

export function collectTelegramEmptyAllowlistExtraWarnings(
  params: ChannelDoctorEmptyAllowlistAccountContext,
): string[] {
  const account = params.account as DoctorAccountRecord;
  const parent = params.parent as DoctorAccountRecord | undefined;
  return params.channelName === "telegram" &&
    ((account.groupPolicy as string | undefined) ??
      (parent?.groupPolicy as string | undefined) ??
      undefined) === "allowlist"
    ? collectTelegramGroupPolicyWarnings({
        account,
        dmPolicy: params.dmPolicy,
        effectiveAllowFrom: params.effectiveAllowFrom as DoctorAllowFromList | undefined,
        parent,
        prefix: params.prefix,
      })
    : [];
}

export const telegramDoctor: ChannelDoctorAdapter = {
  collectEmptyAllowlistExtraWarnings: collectTelegramEmptyAllowlistExtraWarnings,
  collectPreviewWarnings: ({ cfg, doctorFixCommand }) =>
    collectTelegramAllowFromUsernameWarnings({
      doctorFixCommand,
      hits: scanTelegramAllowFromUsernameEntries(cfg),
    }),
  legacyConfigRules: TELEGRAM_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeTelegramCompatibilityConfig,
  repairConfig: async ({ cfg }) => await maybeRepairTelegramAllowFromUsernames(cfg),
  shouldSkipDefaultEmptyGroupAllowlistWarning: (params) => params.channelName === "telegram",
};
