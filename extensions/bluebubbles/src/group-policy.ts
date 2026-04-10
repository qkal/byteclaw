import {
  type GroupToolPolicyConfig,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

interface BlueBubblesGroupContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}

export function resolveBlueBubblesGroupRequireMention(params: BlueBubblesGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "bluebubbles",
    groupId: params.groupId,
  });
}

export function resolveBlueBubblesGroupToolPolicy(
  params: BlueBubblesGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "bluebubbles",
    groupId: params.groupId,
    senderE164: params.senderE164,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
  });
}
