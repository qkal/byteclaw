import {
  type GroupToolPolicyConfig,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

interface IMessageGroupContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}

export function resolveIMessageGroupRequireMention(params: IMessageGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
    groupId: params.groupId,
  });
}

export function resolveIMessageGroupToolPolicy(
  params: IMessageGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "imessage",
    groupId: params.groupId,
    senderE164: params.senderE164,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
  });
}
