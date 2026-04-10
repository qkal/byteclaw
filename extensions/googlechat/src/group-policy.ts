import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

interface GoogleChatGroupContext {
  cfg: OpenClawConfig;
  accountId?: string | null;
  groupId?: string | null;
}

export function resolveGoogleChatGroupRequireMention(params: GoogleChatGroupContext): boolean {
  return resolveChannelGroupRequireMention({
    accountId: params.accountId,
    cfg: params.cfg,
    channel: "googlechat",
    groupId: params.groupId,
  });
}
