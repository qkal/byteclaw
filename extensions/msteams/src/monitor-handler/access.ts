import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_ACCOUNT_ID,
  type OpenClawConfig,
  createChannelPairingController,
  evaluateSenderGroupAccessForPolicy,
  isDangerousNameMatchingEnabled,
  readStoreAllowFromForDmPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
  resolveSenderScopedGroupPolicy,
} from "../../runtime-api.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import { resolveMSTeamsAllowlistMatch, resolveMSTeamsRouteConfig } from "../policy.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export type MSTeamsResolvedSenderAccess = Awaited<ReturnType<typeof resolveMSTeamsSenderAccess>>;

export async function resolveMSTeamsSenderAccess(params: {
  cfg: OpenClawConfig;
  activity: MSTeamsTurnContext["activity"];
}) {
  const { activity } = params;
  const msteamsCfg = params.cfg.channels?.msteams;
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "unknown");
  const convType = normalizeOptionalLowercaseString(activity.conversation?.conversationType);
  const isDirectMessage = convType === "personal" || (!convType && !activity.conversation?.isGroup);
  const senderId = activity.from?.aadObjectId ?? activity.from?.id ?? "unknown";
  const senderName = activity.from?.name ?? activity.from?.id ?? senderId;

  const core = getMSTeamsRuntime();
  const pairing = createChannelPairingController({
    accountId: DEFAULT_ACCOUNT_ID,
    channel: "msteams",
    core,
  });
  const dmPolicy = msteamsCfg?.dmPolicy ?? "pairing";
  const storedAllowFrom = await readStoreAllowFromForDmPolicy({
    accountId: pairing.accountId,
    dmPolicy,
    provider: "msteams",
    readStore: pairing.readStoreForDmPolicy,
  });
  const configuredDmAllowFrom = (msteamsCfg?.allowFrom ?? []).map((entry) => String(entry));
  const groupAllowFrom = msteamsCfg?.groupAllowFrom;
  const resolvedAllowFromLists = resolveEffectiveAllowFromLists({
    allowFrom: configuredDmAllowFrom,
    dmPolicy,
    groupAllowFrom,
    storeAllowFrom: storedAllowFrom,
  });
  const defaultGroupPolicy = resolveDefaultGroupPolicy(params.cfg);
  const groupPolicy =
    !isDirectMessage && msteamsCfg
      ? (msteamsCfg.groupPolicy ?? defaultGroupPolicy ?? "allowlist")
      : "disabled";
  const { effectiveGroupAllowFrom } = resolvedAllowFromLists;
  const allowNameMatching = isDangerousNameMatchingEnabled(msteamsCfg);
  const channelGate = resolveMSTeamsRouteConfig({
    allowNameMatching,
    cfg: msteamsCfg,
    channelName: activity.channelData?.channel?.name,
    conversationId,
    teamId: activity.channelData?.team?.id,
    teamName: activity.channelData?.team?.name,
  });

  // When a route-level (team/channel) allowlist is configured but the sender allowlist is
  // Empty, resolveSenderScopedGroupPolicy would otherwise downgrade the policy to "open",
  // Allowing any sender. To close this bypass (GHSA-g7cr-9h7q-4qxq), treat an empty sender
  // Allowlist as deny-all whenever the route allowlist is active.
  const senderGroupPolicy =
    channelGate.allowlistConfigured && effectiveGroupAllowFrom.length === 0
      ? groupPolicy
      : resolveSenderScopedGroupPolicy({
          groupAllowFrom: effectiveGroupAllowFrom,
          groupPolicy,
        });
  const access = resolveDmGroupAccessWithLists({
    allowFrom: configuredDmAllowFrom,
    dmPolicy,
    groupAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    groupPolicy: senderGroupPolicy,
    isGroup: !isDirectMessage,
    isSenderAllowed: (allowFrom) =>
      resolveMSTeamsAllowlistMatch({
        allowFrom,
        allowNameMatching,
        senderId,
        senderName,
      }).allowed,
    storeAllowFrom: storedAllowFrom,
  });
  const senderGroupAccess = evaluateSenderGroupAccessForPolicy({
    groupAllowFrom: effectiveGroupAllowFrom,
    groupPolicy,
    isSenderAllowed: (_senderId, allowFrom) =>
      resolveMSTeamsAllowlistMatch({
        allowFrom,
        allowNameMatching,
        senderId,
        senderName,
      }).allowed,
    senderId,
  });

  return {
    access,
    allowNameMatching,
    channelGate,
    configuredDmAllowFrom,
    conversationId,
    dmPolicy,
    effectiveDmAllowFrom: access.effectiveAllowFrom,
    effectiveGroupAllowFrom,
    groupPolicy,
    isDirectMessage,
    msteamsCfg,
    pairing,
    senderGroupAccess,
    senderId,
    senderName,
  };
}
