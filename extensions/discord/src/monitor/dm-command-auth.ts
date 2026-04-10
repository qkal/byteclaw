import { resolveCommandAuthorizedFromAuthorizers } from "openclaw/plugin-sdk/command-auth-native";
import {
  type DmGroupAccessDecision,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { normalizeDiscordAllowList, resolveDiscordAllowListMatch } from "./allow-list.js";

const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];

export type DiscordDmPolicy = "open" | "pairing" | "allowlist" | "disabled";

export interface DiscordDmCommandAccess {
  decision: DmGroupAccessDecision;
  reason: string;
  commandAuthorized: boolean;
  allowMatch: ReturnType<typeof resolveDiscordAllowListMatch> | { allowed: false };
}

function resolveSenderAllowMatch(params: {
  allowEntries: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
}) {
  const allowList = normalizeDiscordAllowList(params.allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
  return allowList
    ? resolveDiscordAllowListMatch({
        allowList,
        allowNameMatching: params.allowNameMatching,
        candidate: params.sender,
      })
    : ({ allowed: false } as const);
}

function resolveDmPolicyCommandAuthorization(params: {
  dmPolicy: DiscordDmPolicy;
  decision: DmGroupAccessDecision;
  commandAuthorized: boolean;
}) {
  if (params.dmPolicy === "open" && params.decision === "allow") {
    return true;
  }
  return params.commandAuthorized;
}

export async function resolveDiscordDmCommandAccess(params: {
  accountId: string;
  dmPolicy: DiscordDmPolicy;
  configuredAllowFrom: string[];
  sender: { id: string; name?: string; tag?: string };
  allowNameMatching: boolean;
  useAccessGroups: boolean;
  readStoreAllowFrom?: () => Promise<string[]>;
}): Promise<DiscordDmCommandAccess> {
  const storeAllowFrom = params.readStoreAllowFrom
    ? await params.readStoreAllowFrom().catch(() => [])
    : await readStoreAllowFromForDmPolicy({
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
        provider: "discord",
      });

  const access = resolveDmGroupAccessWithLists({
    allowFrom: params.configuredAllowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFrom: [],
    isGroup: false,
    isSenderAllowed: (allowEntries) =>
      resolveSenderAllowMatch({
        allowEntries,
        allowNameMatching: params.allowNameMatching,
        sender: params.sender,
      }).allowed,
    storeAllowFrom,
  });

  const allowMatch = resolveSenderAllowMatch({
    allowEntries: access.effectiveAllowFrom,
    allowNameMatching: params.allowNameMatching,
    sender: params.sender,
  });

  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    authorizers: [
      {
        allowed: allowMatch.allowed,
        configured: access.effectiveAllowFrom.length > 0,
      },
    ],
    modeWhenAccessGroupsOff: "configured",
    useAccessGroups: params.useAccessGroups,
  });

  return {
    allowMatch,
    commandAuthorized: resolveDmPolicyCommandAuthorization({
      commandAuthorized,
      decision: access.decision,
      dmPolicy: params.dmPolicy,
    }),
    decision: access.decision,
    reason: access.reason,
  };
}
