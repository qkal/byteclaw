import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { AgentElevatedAllowFromConfig, OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import type { MsgContext } from "../templating.js";
import {
  type AllowFromFormatter,
  type ExplicitElevatedAllowField,
  addFormattedTokens,
  buildMutableTokens,
  matchesFormattedTokens,
  matchesMutableTokens,
  parseExplicitElevatedAllowEntry,
  stripSenderPrefix,
} from "./elevated-allowlist-matcher.js";
export { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";

function resolveElevatedAllowList(
  allowFrom: AgentElevatedAllowFromConfig | undefined,
  provider: string,
  fallbackAllowFrom?: (string | number)[],
): (string | number)[] | undefined {
  if (!allowFrom) {
    return fallbackAllowFrom;
  }
  const value = allowFrom[provider];
  return Array.isArray(value) ? value : fallbackAllowFrom;
}

function resolveAllowFromFormatter(params: {
  cfg: OpenClawConfig;
  provider: string;
  accountId?: string;
}): AllowFromFormatter {
  const normalizedProvider = normalizeChannelId(params.provider);
  const formatAllowFrom = normalizedProvider
    ? getChannelPlugin(normalizedProvider)?.config?.formatAllowFrom
    : undefined;
  if (!formatAllowFrom) {
    return (values) => normalizeStringEntries(values);
  }
  return (values) =>
    formatAllowFrom({
      accountId: params.accountId,
      allowFrom: values,
      cfg: params.cfg,
    })
      .map((entry) => normalizeOptionalString(String(entry)) ?? "")
      .filter(Boolean);
}

function isApprovedElevatedSender(params: {
  provider: string;
  ctx: MsgContext;
  formatAllowFrom: AllowFromFormatter;
  allowFrom?: AgentElevatedAllowFromConfig;
  fallbackAllowFrom?: (string | number)[];
}): boolean {
  const rawAllow = resolveElevatedAllowList(
    params.allowFrom,
    params.provider,
    params.fallbackAllowFrom,
  );
  if (!rawAllow || rawAllow.length === 0) {
    return false;
  }

  const allowTokens = normalizeStringEntries(rawAllow);
  if (allowTokens.length === 0) {
    return false;
  }
  if (allowTokens.some((entry) => entry === "*")) {
    return true;
  }

  const senderIdTokens = new Set<string>();
  const senderFromTokens = new Set<string>();
  const senderE164Tokens = new Set<string>();
  const senderId = normalizeOptionalString(params.ctx.SenderId);
  const senderFrom = normalizeOptionalString(params.ctx.From);
  const senderE164 = normalizeOptionalString(params.ctx.SenderE164);

  if (senderId) {
    addFormattedTokens({
      formatAllowFrom: params.formatAllowFrom,
      tokens: senderIdTokens,
      values: [senderId, stripSenderPrefix(senderId)].filter((value): value is string =>
        Boolean(value),
      ),
    });
  }
  if (senderFrom) {
    addFormattedTokens({
      formatAllowFrom: params.formatAllowFrom,
      tokens: senderFromTokens,
      values: [senderFrom, stripSenderPrefix(senderFrom)].filter((value): value is string =>
        Boolean(value),
      ),
    });
  }
  if (senderE164) {
    addFormattedTokens({
      formatAllowFrom: params.formatAllowFrom,
      tokens: senderE164Tokens,
      values: [senderE164],
    });
  }
  const senderIdentityTokens = new Set<string>([
    ...senderIdTokens,
    ...senderFromTokens,
    ...senderE164Tokens,
  ]);

  const senderNameTokens = buildMutableTokens(params.ctx.SenderName);
  const senderUsernameTokens = buildMutableTokens(params.ctx.SenderUsername);
  const senderTagTokens = buildMutableTokens(params.ctx.SenderTag);

  const explicitFieldMatchers: Record<ExplicitElevatedAllowField, (value: string) => boolean> = {
    e164: (value) =>
      matchesFormattedTokens({
        formatAllowFrom: params.formatAllowFrom,
        tokens: senderE164Tokens,
        value,
      }),
    from: (value) =>
      matchesFormattedTokens({
        formatAllowFrom: params.formatAllowFrom,
        includeStripped: true,
        tokens: senderFromTokens,
        value,
      }),
    id: (value) =>
      matchesFormattedTokens({
        formatAllowFrom: params.formatAllowFrom,
        includeStripped: true,
        tokens: senderIdTokens,
        value,
      }),
    name: (value) => matchesMutableTokens(value, senderNameTokens),
    tag: (value) => matchesMutableTokens(value, senderTagTokens),
    username: (value) => matchesMutableTokens(value, senderUsernameTokens),
  };

  for (const entry of allowTokens) {
    const explicitEntry = parseExplicitElevatedAllowEntry(entry);
    if (!explicitEntry) {
      if (
        matchesFormattedTokens({
          formatAllowFrom: params.formatAllowFrom,
          includeStripped: true,
          tokens: senderIdentityTokens,
          value: entry,
        })
      ) {
        return true;
      }
      continue;
    }
    const matchesExplicitField = explicitFieldMatchers[explicitEntry.field];
    if (matchesExplicitField(explicitEntry.value)) {
      return true;
    }
  }

  return false;
}

export function resolveElevatedPermissions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  ctx: MsgContext;
  provider: string;
}): {
  enabled: boolean;
  allowed: boolean;
  failures: { gate: string; key: string }[];
} {
  const globalConfig = params.cfg.tools?.elevated;
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools?.elevated;
  const globalEnabled = globalConfig?.enabled !== false;
  const agentEnabled = agentConfig?.enabled !== false;
  const enabled = globalEnabled && agentEnabled;
  const failures: { gate: string; key: string }[] = [];
  if (!globalEnabled) {
    failures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!agentEnabled) {
    failures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  }
  if (!enabled) {
    return { allowed: false, enabled, failures };
  }
  if (!params.provider) {
    failures.push({ gate: "provider", key: "ctx.Provider" });
    return { allowed: false, enabled, failures };
  }

  const normalizedProvider = normalizeChannelId(params.provider);
  const fallbackAllowFrom = normalizedProvider
    ? getChannelPlugin(normalizedProvider)?.elevated?.allowFromFallback?.({
        accountId: params.ctx.AccountId,
        cfg: params.cfg,
      })
    : undefined;
  const formatAllowFrom = resolveAllowFromFormatter({
    accountId: params.ctx.AccountId,
    cfg: params.cfg,
    provider: params.provider,
  });
  const globalAllowed = isApprovedElevatedSender({
    allowFrom: globalConfig?.allowFrom,
    ctx: params.ctx,
    fallbackAllowFrom,
    formatAllowFrom,
    provider: params.provider,
  });
  if (!globalAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${params.provider}`,
    });
    return { allowed: false, enabled, failures };
  }

  const agentAllowed = agentConfig?.allowFrom
    ? isApprovedElevatedSender({
        allowFrom: agentConfig.allowFrom,
        ctx: params.ctx,
        fallbackAllowFrom,
        formatAllowFrom,
        provider: params.provider,
      })
    : true;
  if (!agentAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${params.provider}`,
    });
  }
  return { allowed: globalAllowed && agentAllowed, enabled, failures };
}
