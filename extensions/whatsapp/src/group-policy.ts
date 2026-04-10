import {
  type GroupToolPolicyConfig,
  resolveChannelGroupRequireMention,
  resolveChannelGroupToolsPolicy,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

interface WhatsAppGroupContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}

export function resolveWhatsAppGroupRequireMention(params: WhatsAppGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: params.groupId,
  });
}

export function resolveWhatsAppGroupToolPolicy(
  params: WhatsAppGroupContext,
): GroupToolPolicyConfig | undefined {
  return resolveChannelGroupToolsPolicy({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "whatsapp",
    groupId: params.groupId,
    senderE164: params.senderE164,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
  });
}
