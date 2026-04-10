import { getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel.js";
import type { MsgContext } from "./templating.js";

export interface CommandAuthorization {
  providerId?: ChannelId;
  ownerList: string[];
  senderId?: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  from?: string;
  to?: string;
}

interface InferredProviderCandidate {
  providerId: ChannelId;
  hadResolutionError: boolean;
}

interface InferredProviderProbe {
  candidates: InferredProviderCandidate[];
  droppedResolutionError: boolean;
}

interface ProviderAllowFromResolution {
  allowFrom: (string | number)[];
  allowFromList: string[];
  hadResolutionError: boolean;
}

interface OwnerAuthorizationState {
  allowAll: boolean;
  ownerAllowAll: boolean;
  ownerCandidatesForCommands: string[];
  explicitOwners: string[];
  ownerList: string[];
}

function resolveProviderFromContext(
  ctx: MsgContext,
  cfg: OpenClawConfig,
): { providerId: ChannelId | undefined; hadResolutionError: boolean } {
  const explicitMessageChannels = [ctx.Surface, ctx.OriginatingChannel, ctx.Provider]
    .map((value) => normalizeMessageChannel(value))
    .filter((value): value is string => Boolean(value));
  const explicitMessageChannel = explicitMessageChannels.find(
    (value) => value !== INTERNAL_MESSAGE_CHANNEL,
  );
  if (!explicitMessageChannel && explicitMessageChannels.includes(INTERNAL_MESSAGE_CHANNEL)) {
    return { hadResolutionError: false, providerId: undefined };
  }
  const direct =
    normalizeAnyChannelId(explicitMessageChannel ?? undefined) ??
    (explicitMessageChannel as ChannelId | undefined) ??
    normalizeAnyChannelId(ctx.Provider) ??
    normalizeAnyChannelId(ctx.Surface) ??
    normalizeAnyChannelId(ctx.OriginatingChannel);
  if (direct) {
    return { hadResolutionError: false, providerId: direct };
  }
  const candidates = [ctx.From, ctx.To]
    .filter((value): value is string => Boolean(value?.trim()))
    .flatMap((value) => value.split(":").map((part) => part.trim()));
  for (const candidate of candidates) {
    const normalizedCandidateChannel = normalizeMessageChannel(candidate);
    if (normalizedCandidateChannel === INTERNAL_MESSAGE_CHANNEL) {
      return { hadResolutionError: false, providerId: undefined };
    }
    const normalized =
      normalizeAnyChannelId(normalizedCandidateChannel ?? undefined) ??
      (normalizedCandidateChannel as ChannelId | undefined) ??
      normalizeAnyChannelId(candidate);
    if (normalized) {
      return { hadResolutionError: false, providerId: normalized };
    }
  }
  const inferredProviders = probeInferredProviders(ctx, cfg);
  const inferred = inferredProviders.candidates;
  if (inferred.length === 1) {
    return {
      hadResolutionError: inferred[0].hadResolutionError,
      providerId: inferred[0].providerId,
    };
  }
  return {
    hadResolutionError:
      inferredProviders.droppedResolutionError ||
      inferred.some((entry) => entry.hadResolutionError),
    providerId: undefined,
  };
}

function probeInferredProviders(ctx: MsgContext, cfg: OpenClawConfig): InferredProviderProbe {
  let droppedResolutionError = false;
  const candidates = listChannelPlugins()
    .map((plugin) => {
      const resolvedAllowFrom = buildProviderAllowFromResolution({
        accountId: ctx.AccountId,
        cfg,
        plugin,
      });
      if (resolvedAllowFrom.allowFromList.length === 0) {
        if (resolvedAllowFrom.hadResolutionError) {
          droppedResolutionError = true;
        }
        return null;
      }
      return {
        hadResolutionError: resolvedAllowFrom.hadResolutionError,
        providerId: plugin.id,
      };
    })
    .filter((value): value is InferredProviderCandidate => Boolean(value));
  return {
    candidates,
    droppedResolutionError,
  };
}

function formatAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: (string | number)[];
}): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (plugin?.config?.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ accountId, allowFrom, cfg });
  }
  return normalizeStringEntries(allowFrom);
}

function normalizeAllowFromEntry(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  value: string;
}): string[] {
  const normalized = formatAllowFromList({
    accountId: params.accountId,
    allowFrom: [params.value],
    cfg: params.cfg,
    plugin: params.plugin,
  });
  return normalized.filter((entry) => entry.trim().length > 0);
}

function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

function hasWildcardAllowFrom(list: string[]): boolean {
  return list.some((entry) => isWildcardAllowFromEntry(entry));
}

function stripWildcardAllowFrom(list: string[]): string[] {
  return list.filter((entry) => !isWildcardAllowFromEntry(entry));
}

function resolveProviderAllowFrom(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
}): {
  allowFrom: (string | number)[];
  hadResolutionError: boolean;
} {
  const { plugin, cfg, accountId } = params;
  const providerId = plugin?.id;
  if (!plugin?.config?.resolveAllowFrom) {
    return {
      allowFrom: resolveFallbackAllowFrom({ accountId, cfg, providerId }),
      hadResolutionError: false,
    };
  }

  try {
    const allowFrom = plugin.config.resolveAllowFrom({ accountId, cfg });
    if (allowFrom == null) {
      return {
        allowFrom: [],
        hadResolutionError: false,
      };
    }
    if (!Array.isArray(allowFrom)) {
      console.warn(
        `[command-auth] resolveAllowFrom returned an invalid allowFrom for provider "${providerId}", falling back to config allowFrom: invalid_result`,
      );
      return {
        allowFrom: resolveFallbackAllowFrom({ accountId, cfg, providerId }),
        hadResolutionError: true,
      };
    }
    return {
      allowFrom,
      hadResolutionError: false,
    };
  } catch (error) {
    console.warn(
      `[command-auth] resolveAllowFrom threw for provider "${providerId}", falling back to config allowFrom: ${describeAllowFromResolutionError(error)}`,
    );
    return {
      allowFrom: resolveFallbackAllowFrom({ accountId, cfg, providerId }),
      hadResolutionError: true,
    };
  }
}

function buildProviderAllowFromResolution(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  forceFallbackResolutionError?: boolean;
}): ProviderAllowFromResolution {
  const providerId = params.providerId ?? params.plugin?.id;
  const resolvedAllowFrom = params.forceFallbackResolutionError
    ? {
        allowFrom: resolveFallbackAllowFrom({
          accountId: params.accountId,
          cfg: params.cfg,
          providerId,
        }),
        hadResolutionError: true,
      }
    : resolveProviderAllowFrom({
        accountId: params.accountId,
        cfg: params.cfg,
        plugin: params.plugin,
      });
  return {
    ...resolvedAllowFrom,
    allowFromList: formatAllowFromList({
      accountId: params.accountId,
      allowFrom: resolvedAllowFrom.allowFrom,
      cfg: params.cfg,
      plugin: params.plugin,
    }),
  };
}

function describeAllowFromResolutionError(err: unknown): string {
  if (err instanceof Error) {
    const name = normalizeOptionalString(err.name) ?? "";
    return name || "Error";
  }
  return "unknown_error";
}

function resolveOwnerAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  allowFrom?: (string | number)[];
}): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const entry of raw) {
    const trimmed = normalizeOptionalString(String(entry ?? "")) ?? "";
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex > 0) {
      const prefix = trimmed.slice(0, separatorIndex);
      const channel = normalizeAnyChannelId(prefix);
      if (channel) {
        if (params.providerId && channel !== params.providerId) {
          continue;
        }
        const remainder = trimmed.slice(separatorIndex + 1).trim();
        if (remainder) {
          filtered.push(remainder);
        }
        continue;
      }
    }
    filtered.push(trimmed);
  }
  return formatAllowFromList({
    accountId: params.accountId,
    allowFrom: filtered,
    cfg: params.cfg,
    plugin: params.plugin,
  });
}

/**
 * Resolves the commands.allowFrom list for a given provider.
 * Returns the provider-specific list if defined, otherwise the "*" global list.
 * Returns null if commands.allowFrom is not configured at all (fall back to channel allowFrom).
 */
function resolveCommandsAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
}): string[] | null {
  const { plugin, cfg, accountId, providerId } = params;
  const commandsAllowFrom = cfg.commands?.allowFrom;
  if (!commandsAllowFrom || typeof commandsAllowFrom !== "object") {
    return null; // Not configured, fall back to channel allowFrom
  }

  // Check provider-specific list first, then fall back to global "*"
  const providerKey = providerId ?? "";
  const providerList = commandsAllowFrom[providerKey];
  const globalList = commandsAllowFrom["*"];

  const rawList = Array.isArray(providerList) ? providerList : globalList;
  if (!Array.isArray(rawList)) {
    return null; // No applicable list found
  }

  return formatAllowFromList({
    accountId,
    allowFrom: rawList,
    cfg,
    plugin,
  });
}

function resolveOwnerCandidatesForCommands(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  to?: string;
  allowAll: boolean;
  allowFromList: string[];
}): string[] {
  if (params.allowAll) {
    return [];
  }
  const ownerCandidatesForCommands = stripWildcardAllowFrom(params.allowFromList);
  if (ownerCandidatesForCommands.length > 0 || !params.to) {
    return ownerCandidatesForCommands;
  }
  const normalizedTo = normalizeAllowFromEntry({
    accountId: params.accountId,
    cfg: params.cfg,
    plugin: params.plugin,
    value: params.to,
  });
  return normalizedTo.length > 0 ? [...ownerCandidatesForCommands, ...normalizedTo] : [];
}

function resolveOwnerAuthorizationState(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  to?: string;
  allowFromList: string[];
  hadResolutionError: boolean;
  configOwnerAllowFrom?: (string | number)[];
  contextOwnerAllowFrom?: (string | number)[];
}): OwnerAuthorizationState {
  const configOwnerAllowFromList = resolveOwnerAllowFromList({
    accountId: params.accountId,
    allowFrom: params.configOwnerAllowFrom,
    cfg: params.cfg,
    plugin: params.plugin,
    providerId: params.providerId,
  });
  const contextOwnerAllowFromList = resolveOwnerAllowFromList({
    accountId: params.accountId,
    allowFrom: params.contextOwnerAllowFrom,
    cfg: params.cfg,
    plugin: params.plugin,
    providerId: params.providerId,
  });
  const allowAll =
    !params.hadResolutionError &&
    (params.allowFromList.length === 0 || hasWildcardAllowFrom(params.allowFromList));
  const ownerCandidatesForCommands = resolveOwnerCandidatesForCommands({
    accountId: params.accountId,
    allowAll,
    allowFromList: params.allowFromList,
    cfg: params.cfg,
    plugin: params.plugin,
    to: params.to,
  });
  const ownerAllowAll = hasWildcardAllowFrom(configOwnerAllowFromList);
  const explicitOwners = stripWildcardAllowFrom(configOwnerAllowFromList);
  const explicitOverrides = stripWildcardAllowFrom(contextOwnerAllowFromList);
  const ownerList = [
    ...new Set(
      explicitOwners.length > 0
        ? explicitOwners
        : ownerAllowAll
          ? []
          : explicitOverrides.length > 0
            ? explicitOverrides
            : ownerCandidatesForCommands,
    ),
  ];
  return {
    allowAll,
    explicitOwners,
    ownerAllowAll,
    ownerCandidatesForCommands,
    ownerList,
  };
}

function resolveCommandSenderAuthorization(params: {
  commandAuthorized: boolean;
  isOwnerForCommands: boolean;
  senderCandidates: string[];
  commandsAllowFromList: string[] | null;
  providerResolutionError: boolean;
  commandsAllowFromConfigured: boolean;
}): boolean {
  if (
    params.commandsAllowFromList !== null ||
    (params.providerResolutionError && params.commandsAllowFromConfigured)
  ) {
    const { commandsAllowFromList } = params;
    const commandsAllowAll =
      !params.providerResolutionError &&
      Boolean(commandsAllowFromList && hasWildcardAllowFrom(commandsAllowFromList));
    const matchedCommandsAllowFrom = commandsAllowFromList?.length
      ? params.senderCandidates.find((candidate) => commandsAllowFromList.includes(candidate))
      : undefined;
    return (
      !params.providerResolutionError && (commandsAllowAll || Boolean(matchedCommandsAllowFrom))
    );
  }
  return params.commandAuthorized && params.isOwnerForCommands;
}

function isConversationLikeIdentity(value: string): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return false;
  }
  if (normalized.includes("@g.us")) {
    return true;
  }
  if (normalized.startsWith("chat_id:")) {
    return true;
  }
  return /(^|:)(channel|group|thread|topic|room|space|spaces):/.test(normalized);
}

function shouldUseFromAsSenderFallback(params: {
  from?: string | null;
  chatType?: string | null;
}): boolean {
  const from = normalizeOptionalString(params.from) ?? "";
  if (!from) {
    return false;
  }
  const chatType = normalizeLowercaseStringOrEmpty(params.chatType);
  if (chatType && chatType !== "direct") {
    return false;
  }
  return !isConversationLikeIdentity(from);
}

function resolveSenderCandidates(params: {
  plugin?: ChannelPlugin;
  providerId?: ChannelId;
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  senderE164?: string | null;
  from?: string | null;
  chatType?: string | null;
}): string[] {
  const { plugin, cfg, accountId } = params;
  const candidates: string[] = [];
  const pushCandidate = (value?: string | null) => {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (!trimmed) {
      return;
    }
    candidates.push(trimmed);
  };
  if (plugin?.commands?.preferSenderE164ForCommands) {
    pushCandidate(params.senderE164);
    pushCandidate(params.senderId);
  } else {
    pushCandidate(params.senderId);
    pushCandidate(params.senderE164);
  }
  if (
    candidates.length === 0 &&
    shouldUseFromAsSenderFallback({ chatType: params.chatType, from: params.from })
  ) {
    pushCandidate(params.from);
  }

  const normalized: string[] = [];
  for (const sender of candidates) {
    const entries = normalizeAllowFromEntry({ accountId, cfg, plugin, value: sender });
    for (const entry of entries) {
      if (!normalized.includes(entry)) {
        normalized.push(entry);
      }
    }
  }
  return normalized;
}

function resolveFallbackAllowFrom(params: {
  cfg: OpenClawConfig;
  providerId?: ChannelId;
  accountId?: string | null;
}): (string | number)[] {
  const providerId = normalizeOptionalString(params.providerId);
  if (!providerId) {
    return [];
  }
  const channels = params.cfg.channels as
    | Record<
        string,
        | {
            allowFrom?: (string | number)[];
            dm?: { allowFrom?: (string | number)[] };
            accounts?: Record<
              string,
              {
                allowFrom?: (string | number)[];
                dm?: { allowFrom?: (string | number)[] };
              }
            >;
          }
        | undefined
      >
    | undefined;
  const channelCfg = channels?.[providerId];
  const accountCfg =
    resolveFallbackAccountConfig(channelCfg?.accounts, params.accountId) ??
    resolveFallbackDefaultAccountConfig(channelCfg);
  const allowFrom =
    accountCfg?.allowFrom ??
    accountCfg?.dm?.allowFrom ??
    channelCfg?.allowFrom ??
    channelCfg?.dm?.allowFrom;
  return Array.isArray(allowFrom) ? allowFrom : [];
}

function resolveFallbackAccountConfig(
  accounts:
    | Record<
        string,
        | {
            allowFrom?: (string | number)[];
            dm?: { allowFrom?: (string | number)[] };
          }
        | undefined
      >
    | undefined,
  accountId?: string | null,
) {
  const normalizedAccountId = normalizeOptionalLowercaseString(accountId);
  if (!accounts || !normalizedAccountId) {
    return undefined;
  }
  const direct = accounts[normalizedAccountId];
  if (direct) {
    return direct;
  }
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeOptionalLowercaseString(key) === normalizedAccountId,
  );
  return matchKey ? accounts[matchKey] : undefined;
}

function resolveFallbackDefaultAccountConfig(
  channelCfg:
    | {
        allowFrom?: (string | number)[];
        dm?: { allowFrom?: (string | number)[] };
        defaultAccount?: string;
        accounts?: Record<
          string,
          | {
              allowFrom?: (string | number)[];
              dm?: { allowFrom?: (string | number)[] };
            }
          | undefined
        >;
      }
    | undefined,
) {
  const accounts = channelCfg?.accounts;
  if (!accounts) {
    return undefined;
  }
  const preferred =
    resolveFallbackAccountConfig(accounts, channelCfg?.defaultAccount) ??
    resolveFallbackAccountConfig(accounts, "default");
  if (preferred) {
    return preferred;
  }
  const definedAccounts = Object.values(accounts).filter(Boolean);
  return definedAccounts.length === 1 ? definedAccounts[0] : undefined;
}

export function resolveCommandAuthorization(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  commandAuthorized: boolean;
}): CommandAuthorization {
  const { ctx, cfg, commandAuthorized } = params;
  const { providerId, hadResolutionError: providerResolutionError } = resolveProviderFromContext(
    ctx,
    cfg,
  );
  const plugin = providerId ? getChannelPlugin(providerId) : undefined;
  const from = normalizeOptionalString(ctx.From) ?? "";
  const to = normalizeOptionalString(ctx.To) ?? "";
  const commandsAllowFromConfigured = Boolean(
    cfg.commands?.allowFrom && typeof cfg.commands.allowFrom === "object",
  );

  // Check if commands.allowFrom is configured (separate command authorization)
  const commandsAllowFromList = resolveCommandsAllowFromList({
    accountId: ctx.AccountId,
    cfg,
    plugin,
    providerId,
  });

  const resolvedAllowFrom = buildProviderAllowFromResolution({
    accountId: ctx.AccountId,
    cfg,
    forceFallbackResolutionError: providerResolutionError,
    plugin,
    providerId,
  });
  const ownerState = resolveOwnerAuthorizationState({
    accountId: ctx.AccountId,
    allowFromList: resolvedAllowFrom.allowFromList,
    cfg,
    configOwnerAllowFrom: cfg.commands?.ownerAllowFrom,
    contextOwnerAllowFrom: ctx.OwnerAllowFrom,
    hadResolutionError: resolvedAllowFrom.hadResolutionError,
    plugin,
    providerId,
    to,
  });

  const senderCandidates = resolveSenderCandidates({
    accountId: ctx.AccountId,
    cfg,
    chatType: ctx.ChatType,
    from,
    plugin,
    providerId,
    senderE164: ctx.SenderE164,
    senderId: ctx.SenderId,
  });
  const matchedSender = ownerState.ownerList.length
    ? senderCandidates.find((candidate) => ownerState.ownerList.includes(candidate))
    : undefined;
  const matchedCommandOwner = ownerState.ownerCandidatesForCommands.length
    ? senderCandidates.find((candidate) =>
        ownerState.ownerCandidatesForCommands.includes(candidate),
      )
    : undefined;
  const senderId = matchedSender ?? senderCandidates[0];

  const enforceOwner = Boolean(plugin?.commands?.enforceOwnerForCommands);
  const senderIsOwnerByIdentity = Boolean(matchedSender);
  const senderIsOwnerByScope =
    isInternalMessageChannel(ctx.Provider) &&
    Array.isArray(ctx.GatewayClientScopes) &&
    ctx.GatewayClientScopes.includes("operator.admin");
  const ownerAllowlistConfigured = ownerState.ownerAllowAll || ownerState.explicitOwners.length > 0;
  const senderIsOwner = ctx.ForceSenderIsOwnerFalse
    ? false
    : senderIsOwnerByIdentity || senderIsOwnerByScope || ownerState.ownerAllowAll;
  const requireOwner = enforceOwner || ownerAllowlistConfigured;
  const isOwnerForCommands = !requireOwner
    ? true
    : ownerState.ownerAllowAll
      ? true
      : ownerAllowlistConfigured
        ? senderIsOwner
        : ownerState.allowAll ||
          ownerState.ownerCandidatesForCommands.length === 0 ||
          Boolean(matchedCommandOwner);
  const isAuthorizedSender = resolveCommandSenderAuthorization({
    commandAuthorized,
    commandsAllowFromConfigured,
    commandsAllowFromList,
    isOwnerForCommands,
    providerResolutionError,
    senderCandidates,
  });

  return {
    from: from || undefined,
    isAuthorizedSender,
    ownerList: ownerState.ownerList,
    providerId,
    senderId: senderId || undefined,
    senderIsOwner,
    to: to || undefined,
  };
}
