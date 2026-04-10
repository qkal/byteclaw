import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { upsertChannelPairingRequest } from "openclaw/plugin-sdk/conversation-runtime";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk/security-runtime";
import { type SignalSender, isSignalSenderAllowed } from "../identity.js";

type SignalDmPolicy = "open" | "pairing" | "allowlist" | "disabled";
type SignalGroupPolicy = "open" | "allowlist" | "disabled";

export async function resolveSignalAccessState(params: {
  accountId: string;
  dmPolicy: SignalDmPolicy;
  groupPolicy: SignalGroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  sender: SignalSender;
}) {
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    accountId: params.accountId,
    dmPolicy: params.dmPolicy,
    provider: "signal",
  });
  const resolveAccessDecision = (isGroup: boolean) =>
    resolveDmGroupAccessWithLists({
      allowFrom: params.allowFrom,
      dmPolicy: params.dmPolicy,
      groupAllowFrom: params.groupAllowFrom,
      groupPolicy: params.groupPolicy,
      isGroup,
      isSenderAllowed: (allowEntries) => isSignalSenderAllowed(params.sender, allowEntries),
      storeAllowFrom,
    });
  const dmAccess = resolveAccessDecision(false);
  return {
    dmAccess,
    effectiveDmAllow: dmAccess.effectiveAllowFrom,
    effectiveGroupAllow: dmAccess.effectiveGroupAllowFrom,
    resolveAccessDecision,
  };
}

export async function handleSignalDirectMessageAccess(params: {
  dmPolicy: SignalDmPolicy;
  dmAccessDecision: "allow" | "block" | "pairing";
  senderId: string;
  senderIdLine: string;
  senderDisplay: string;
  senderName?: string;
  accountId: string;
  sendPairingReply: (text: string) => Promise<void>;
  log: (message: string) => void;
}): Promise<boolean> {
  if (params.dmAccessDecision === "allow") {
    return true;
  }
  if (params.dmAccessDecision === "block") {
    if (params.dmPolicy !== "disabled") {
      params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
    }
    return false;
  }
  if (params.dmPolicy === "pairing") {
    await createChannelPairingChallengeIssuer({
      channel: "signal",
      upsertPairingRequest: async ({ id, meta }) =>
        await upsertChannelPairingRequest({
          accountId: params.accountId,
          channel: "signal",
          id,
          meta,
        }),
    })({
      meta: { name: params.senderName },
      onCreated: () => {
        params.log(`signal pairing request sender=${params.senderId}`);
      },
      onReplyError: (err) => {
        params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
      },
      sendPairingReply: params.sendPairingReply,
      senderId: params.senderId,
      senderIdLine: params.senderIdLine,
    });
  }
  return false;
}
